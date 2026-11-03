import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { auditPackagedDirectory, auditReleaseArtifacts } from "./releaseArtifactAudit";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function writeWindowsLauncher(packageRoot: string, app: "viewer" | "editor", bytes: Uint8Array = Buffer.from("MZ\u0000\u0000")): Promise<void> {
  const bundleDirectory = app === "viewer" ? "BASpineViewer" : "BASpineEditor";
  const launcher = join(packageRoot, bundleDirectory, "bin", "launcher.exe");
  await mkdir(join(packageRoot, bundleDirectory, "bin"), { recursive: true });
  await writeFile(launcher, bytes);
}

function tarEntry(name: string, content: string, type = "0"): Buffer {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

async function writeTarZstd(path: string, entries: Array<{ name: string; content?: string; type?: string }>): Promise<void> {
  const archive = Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.content ?? "", entry.type ?? "0")),
    Buffer.alloc(1024),
  ]);
  await writeFile(path, zstdCompressSync(archive));
}

function paxPathRecord(path: string): string {
  const payload = `path=${path}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const nextLength = Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(payload);
    if (nextLength === length) return `${length} ${payload}`;
    length = nextLength;
  }
}

describe("release artifact audit", () => {
  test("accepts a package without library data or workspace markers", async () => {
    const root = await temporaryRoot("ba-spine-release-clean-");
    await mkdir(join(root, "Resources", "app"), { recursive: true });
    await writeFile(join(root, "Resources", "app", "index.js"), "console.log('standalone');");
    await writeTarZstd(join(root, "Resources", "app.tar.zst"), [
      { name: "Resources/app/", type: "5" },
      { name: "Resources/app/index.js", content: "console.log('standalone');" },
    ]);
    expect(await auditPackagedDirectory(root, ["C:\\Source Workspace"])).toEqual([]);
  });

  test("finds data directories and workspace paths in binary files across chunk boundaries", async () => {
    const root = await temporaryRoot("ba-spine-release-invalid-");
    await mkdir(join(root, "Resources", "app", "data"), { recursive: true });
    const binaryPath = join(root, "Resources", "app", "core.bin");
    const content = Buffer.concat([
      Buffer.alloc(64 * 1024 - 5, 0x78),
      Buffer.from("C:\\Source Workspace\\assets\\catalog.json", "utf8"),
    ]);
    await writeFile(binaryPath, content);
    const issues = await auditPackagedDirectory(root, ["C:\\Source Workspace"]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("Resources/app/data"),
      expect.stringContaining("C:\\Source Workspace"),
    ]));
  });

  test("inspects compressed TAR contents without extracting them", async () => {
    const root = await temporaryRoot("ba-spine-release-archive-");
    const archivePath = join(root, "Resources", "app.tar.zst");
    await mkdir(join(root, "Resources"), { recursive: true });
    await writeTarZstd(archivePath, [
      { name: "BASpineViewer/", type: "5" },
      { name: "BASpineViewer/Resources/app/data/", type: "5" },
      { name: "BASpineViewer/Resources/app/main.js", content: "// source C:\\Source Workspace\\packages\\viewer" },
      { name: "BASpineViewer/Resources/app/link", type: "2" },
    ]);

    const issues = await auditPackagedDirectory(root, ["C:\\Source Workspace"]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('compressed TAR contains forbidden asset-library data directory "BASpineViewer/Resources/app/data/"'),
      expect.stringContaining('compressed TAR contains forbidden marker "C:\\Source Workspace"'),
      expect.stringContaining('compressed TAR contains an unexpected link entry "BASpineViewer/Resources/app/link"'),
    ]));
  });

  test("honors PAX and GNU long-path metadata when checking archive directories", async () => {
    const root = await temporaryRoot("ba-spine-release-long-path-archive-");
    const archivePath = join(root, "Resources", "long-paths.tar.zst");
    await mkdir(join(root, "Resources"), { recursive: true });
    const paxDirectory = `BASpineViewer/${"nested-folder/".repeat(10)}data/日本語/`;
    const gnuDirectory = `BASpineEditor/${"long-folder/".repeat(10)}data/`;
    await writeTarZstd(archivePath, [
      { name: "PaxHeaders/entry", type: "x", content: paxPathRecord(paxDirectory) },
      { name: "short-pax-name/", type: "5" },
      { name: "././@LongLink", type: "L", content: `${gnuDirectory}\0` },
      { name: "short-gnu-name/", type: "5" },
    ]);

    const issues = await auditPackagedDirectory(root);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining(`compressed TAR contains forbidden asset-library data directory "${paxDirectory}"`),
      expect.stringContaining(`compressed TAR contains forbidden asset-library data directory "${gnuDirectory}"`),
    ]));
  });

  test("fails closed when a compressed TAR cannot be inspected", async () => {
    const root = await temporaryRoot("ba-spine-release-corrupt-archive-");
    const archivePath = join(root, "Resources", "broken.tar.zst");
    await mkdir(join(root, "Resources"), { recursive: true });
    await writeFile(archivePath, "not a zstandard archive");
    const issues = await auditPackagedDirectory(root);
    expect(issues).toEqual([expect.stringContaining("compressed TAR could not be safely inspected")]);
  });

  test("requires stable packages for both apps and scans optional build logs", async () => {
    const root = await temporaryRoot("ba-spine-release-layout-");
    const viewer = join(root, "apps", "viewer", "desktop", "build", "stable-win-x64");
    const editor = join(root, "apps", "editor", "desktop", "build", "stable-win-x64");
    await mkdir(viewer, { recursive: true });
    await mkdir(editor, { recursive: true });
    await writeWindowsLauncher(viewer, "viewer");
    await writeWindowsLauncher(editor, "editor");
    const log = join(root, "build.log");
    await writeFile(log, "Bundled data/catalog.json and data\\catalog.json");
    const issues = await auditReleaseArtifacts(root, ["C:\\Old Workspace"], [log]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("build log contains forbidden marker");
  });

  test("rejects missing or malformed Windows app launchers", async () => {
    const root = await temporaryRoot("ba-spine-release-launcher-");
    const viewer = join(root, "apps", "viewer", "desktop", "build", "stable-win-x64");
    const editor = join(root, "apps", "editor", "desktop", "build", "stable-win-x64");
    await mkdir(viewer, { recursive: true });
    await mkdir(editor, { recursive: true });
    await writeWindowsLauncher(viewer, "viewer", Buffer.from("not a PE"));

    const issues = await auditReleaseArtifacts(root);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("packaged launcher does not have a valid Windows PE signature"),
      expect.stringContaining("packaged Windows launcher is missing"),
    ]));
  });
});
