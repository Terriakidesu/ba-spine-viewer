import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { auditPortableSuiteDirectory } from "./releaseArtifactAudit";

const repositoryRoot = resolve(import.meta.dir, "..");
const outputRoot = resolve(Bun.argv[2] ?? join(repositoryRoot, "release", "portable"));
const entries = await readdir(outputRoot, { withFileTypes: true });
const archives = entries
  .filter((entry) => entry.isFile() && /^BA-Spine-Suite-\d+\.\d+\.\d+(?:-[\w.-]+)?-win-x64\.zip$/.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left));
if (!archives.length) throw new Error(`No portable suite ZIP was found in ${outputRoot}.`);
const archive = join(outputRoot, archives[0]!);
const checksumPath = `${archive}.sha256`;
const checksum = (await readFile(checksumPath, "utf8")).trim();
const expected = /^([a-f0-9]{64})  (.+)$/.exec(checksum);
if (!expected || expected[2] !== archives[0]) throw new Error("Portable suite checksum file is invalid.");
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== expected[1]) throw new Error("Portable suite ZIP does not match its SHA-256 checksum.");

const temporaryRoot = await mkdtemp(join(tmpdir(), "ba-spine-portable-audit-"));
try {
  const listing = Bun.spawn(["tar", "-tf", archive], { stdout: "pipe", stderr: "pipe" });
  const [listingText, listingErrors, listingExit] = await Promise.all([
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
    listing.exited,
  ]);
  if (listingExit !== 0) throw new Error(`Portable ZIP could not be listed: ${listingErrors.trim()}`);
  for (const entry of listingText.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..") || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`Portable ZIP contains an unsafe path: ${entry}`);
    }
  }

  const extract = Bun.spawn(["tar", "-xf", archive, "-C", temporaryRoot], { stdout: "inherit", stderr: "inherit" });
  if (await extract.exited !== 0) throw new Error("Portable suite ZIP extraction failed.");
  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version?: unknown };
  const manifest = JSON.parse(await readFile(join(temporaryRoot, "suite.json"), "utf8")) as { suiteVersion?: unknown };
  if (manifest.suiteVersion !== packageManifest.version) throw new Error("Portable suite version is incompatible with the current source version.");
  const forbiddenPaths = [repositoryRoot, join(repositoryRoot, "data", "catalog.json")];
  const issues = await auditPortableSuiteDirectory(temporaryRoot, forbiddenPaths);
  if (issues.length) {
    for (const issue of issues) console.error(`[portable-audit] ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`[portable-audit] ${archives[0]} passed manifest, bundle, asset-separation, and path audits.`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
