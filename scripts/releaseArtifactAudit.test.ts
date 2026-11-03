import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("release artifact audit", () => {
  test("accepts a package without library data or workspace markers", async () => {
    const root = await temporaryRoot("ba-spine-release-clean-");
    await mkdir(join(root, "Resources", "app"), { recursive: true });
    await writeFile(join(root, "Resources", "app", "index.js"), "console.log('standalone');");
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

  test("requires stable packages for both apps and scans optional build logs", async () => {
    const root = await temporaryRoot("ba-spine-release-layout-");
    const viewer = join(root, "apps", "viewer", "desktop", "build", "stable-test");
    const editor = join(root, "apps", "editor", "desktop", "build", "stable-test");
    await mkdir(viewer, { recursive: true });
    await mkdir(editor, { recursive: true });
    const log = join(root, "build.log");
    await writeFile(log, "Bundled data/catalog.json and data\\catalog.json");
    const issues = await auditReleaseArtifacts(root, ["C:\\Old Workspace"], [log]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("build log contains forbidden marker");
  });
});
