import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { auditPortableSuiteDirectory } from "./releaseArtifactAudit";

const repositoryRoot = resolve(import.meta.dir, "..");
const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version?: unknown };
if (typeof packageManifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageManifest.version)) {
  throw new Error("The root package version must be a semantic version before portable packaging.");
}
const suiteVersion = packageManifest.version;

function outputDirectory(): string {
  const args = Bun.argv.slice(2);
  if (args.length === 0) return join(repositoryRoot, "release", "portable");
  if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: bun scripts/packagePortableSuite.ts [--output <directory>]");
  return resolve(args[1]!);
}

const outputRoot = outputDirectory();
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Portable suite packaging currently targets Windows x64 and must run on Windows x64.");
}
const repositoryData = resolve(repositoryRoot, "data");
const relativeToData = relative(repositoryData, outputRoot);
if (relativeToData === "" || (!relativeToData.startsWith(`..${sep}`) && relativeToData !== ".." && !isAbsolute(relativeToData))) {
  throw new Error("Portable package output must not be written inside repository data/.");
}

async function run(command: string, args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    ...(env ? { env: { ...process.env, ...env } } : {}),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with status ${exitCode}.`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "ba-spine-portable-suite-"));
const stage = join(temporaryRoot, "BA-Spine-Suite");
const editorExtract = join(temporaryRoot, "editor-extract");
const viewerExtract = join(temporaryRoot, "viewer-extract");
const verifyExtract = join(temporaryRoot, "zip-verification");
const outputArchive = join(outputRoot, `BA-Spine-Suite-${suiteVersion}-win-x64.zip`);
const checksumPath = `${outputArchive}.sha256`;

try {
  await run("bun", ["run", "build:viewer"], repositoryRoot);
  await run("bun", ["run", "build:editor"], repositoryRoot);

  const editorArchive = join(repositoryRoot, "apps", "editor", "desktop", "artifacts", "stable-win-x64-BASpineEditor.tar.zst");
  const viewerArchive = join(repositoryRoot, "apps", "viewer", "desktop", "artifacts", "stable-win-x64-BASpineViewer.tar.zst");
  await mkdir(editorExtract, { recursive: true });
  await mkdir(viewerExtract, { recursive: true });
  await run("tar", ["-xf", editorArchive, "-C", editorExtract], repositoryRoot);
  await run("tar", ["-xf", viewerArchive, "-C", viewerExtract], repositoryRoot);

  const editorBundle = join(editorExtract, "BASpineEditor");
  const viewerBundle = join(viewerExtract, "BASpineViewer");
  await mkdir(join(stage, "apps", "editor"), { recursive: true });
  await mkdir(join(stage, "apps", "viewer"), { recursive: true });
  await cp(editorBundle, join(stage, "apps", "editor", "BASpineEditor"), { recursive: true, errorOnExist: true });
  await cp(viewerBundle, join(stage, "apps", "viewer", "BASpineViewer"), { recursive: true, errorOnExist: true });
  await mkdir(join(stage, "data"), { recursive: true });
  await mkdir(join(stage, "licenses"), { recursive: true });

  const manifest = {
    schemaVersion: 1,
    suiteVersion,
    platform: "windows-x64",
    apps: {
      editor: "apps/editor/BASpineEditor/bin/launcher.exe",
      viewer: "apps/viewer/BASpineViewer/bin/launcher.exe",
    },
    dataDirectory: "data",
  } as const;
  await writeFile(join(stage, "suite.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(stage, "data", "README.txt"), [
    "Place your shared BA Spine asset library in this folder.",
    "The suite does not create, modify, or remove library files during startup or updates.",
    "Keep this folder when replacing the suite's apps during a manual update.",
    "",
  ].join("\r\n"), "utf8");
  await writeFile(join(stage, "README.txt"), [
    "BA Spine Suite - portable Windows x64 release",
    "",
    "Launch Editor.exe or Viewer.exe. Both applications use the adjacent data\\ folder when it contains a recognizable Spine library.",
    "If no library is found, choose one from the application. Preferences, caches, recovery data, and window state remain in your Windows user profile.",
    "",
    "Manual update: close both applications, extract the new ZIP elsewhere, then replace Editor.exe, Viewer.exe, suite.json, README.txt, licenses\\, and apps\\ as a coordinated set. Do not replace or delete the existing data\\ folder.",
    "The portable ZIP contains no authored asset library. Copy your own library into data\\ after extraction.",
    "",
    "On Windows x64, both apps enforce a native 760 x 560 logical-pixel resize minimum, scaled for the display DPI and reduced to the monitor work area on smaller screens.",
    "",
  ].join("\r\n"), "utf8");

  const electrobunLicense = join(repositoryRoot, "apps", "editor", "desktop", "node_modules", "electrobun", "LICENSE");
  await copyFile(electrobunLicense, join(stage, "licenses", "Electrobun-LICENSE.txt"));

  const launcherDirectory = join(repositoryRoot, "scripts", "portable-launcher");
  const goEnvironment = { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" };
  for (const app of ["editor", "viewer"] as const) {
    const rootName = app === "editor" ? "Editor.exe" : "Viewer.exe";
    await run("go", [
      "build",
      "-trimpath",
      "-ldflags", `-s -w -H=windowsgui -X main.app=${app}`,
      "-o", join(stage, rootName),
      ".",
    ], launcherDirectory, goEnvironment);
  }

  await mkdir(outputRoot, { recursive: true });
  const forbiddenPaths = [repositoryRoot, join(repositoryRoot, "data", "catalog.json")];
  const stageIssues = await auditPortableSuiteDirectory(stage, forbiddenPaths);
  if (stageIssues.length > 0) throw new Error(`Portable staging audit failed:\n${stageIssues.map((issue) => `- ${issue}`).join("\n")}`);

  await rm(outputArchive, { force: true });
  await rm(checksumPath, { force: true });
  // Avoid a leading "./" in ZIP entry names: Windows Explorer's compressed-folder
  // handler can open such archives but shows the root as empty.
  const archiveEntries = ["Editor.exe", "Viewer.exe", "README.txt", "suite.json", "apps", "data", "licenses"];
  await run("tar", ["-a", "-c", "-f", outputArchive, "-C", stage, ...archiveEntries], repositoryRoot);
  await mkdir(verifyExtract, { recursive: true });
  await run("tar", ["-xf", outputArchive, "-C", verifyExtract], repositoryRoot);
  const archiveIssues = await auditPortableSuiteDirectory(verifyExtract, forbiddenPaths);
  if (archiveIssues.length > 0) throw new Error(`Portable ZIP audit failed:\n${archiveIssues.map((issue) => `- ${issue}`).join("\n")}`);

  const digest = await sha256File(outputArchive);
  await writeFile(checksumPath, `${digest}  ${relative(outputRoot, outputArchive).replaceAll(sep, "/")}\n`, "utf8");
  console.log(`[portable-suite] created ${outputArchive}`);
  console.log(`[portable-suite] SHA-256 ${digest}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
