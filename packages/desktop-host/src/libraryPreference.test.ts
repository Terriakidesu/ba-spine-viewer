import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeLibraryReader } from "./nodeLibraryReader";
import { initialLibraryPath, MAX_LAST_LIBRARY_PATH_BYTES, readLastLibraryPath, restoreLastLibraryPath, writeLastLibraryPath } from "./libraryPreference";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";
import { saveEditorBatch } from "./transactionalSave";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ba-spine-library-preference-"));
  temporaryDirectories.push(root);
  return root;
}

describe("last-library preference", () => {
  test("prefers explicit configuration, then remembered choice, then development default", () => {
    expect(initialLibraryPath("D:/configured", "D:/remembered", "D:/workspace/data")).toBe("D:/configured");
    expect(initialLibraryPath(undefined, "D:/remembered", "D:/workspace/data")).toBe("D:/remembered");
    expect(initialLibraryPath(undefined, null, "D:/workspace/data")).toBe("D:/workspace/data");
    expect(initialLibraryPath(undefined, null, null)).toBeNull();
  });

  test("remembers a library path with spaces and Unicode and updates it after relocation", async () => {
    const root = await temporaryRoot();
    const originalLibrary = join(root, "Spine library 日本語 & 星");
    const lobby = join(originalLibrary, "lobbies", "空の Airi✨");
    const preferencePath = join(root, "app data", "BA Spine Suite", "Viewer", "library.json");
    await mkdir(lobby, { recursive: true });
    await writeFile(join(lobby, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "空の Airi✨" }), "utf8");

    await writeLastLibraryPath(preferencePath, originalLibrary);
    expect(await readLastLibraryPath(preferencePath)).toBe(originalLibrary);
    expect(await restoreLastLibraryPath(preferencePath)).toBe(originalLibrary);
    expect(await createNodeLibraryReader(originalLibrary).readText("lobbies/空の Airi✨/manifest.json"))
      .toBe(JSON.stringify({ schemaVersion: 1, id: "空の Airi✨" }));
    const projectPath = "lobbies/空の Airi✨/sequences/開幕 opening.json";
    const project = JSON.stringify({ sequenceId: "opening", duration: 4 });
    await saveEditorBatch(originalLibrary, [{
      path: projectPath,
      content: project,
      expectedVersion: contentVersion(null),
    }]);
    expect(await readFile(join(originalLibrary, projectPath), "utf8")).toBe(project);

    const relocatedLibrary = join(root, "Moved library_移転版");
    await rename(originalLibrary, relocatedLibrary);
    expect(await readLastLibraryPath(preferencePath)).toBe(originalLibrary);
    expect(await restoreLastLibraryPath(preferencePath)).toBeNull();

    await writeLastLibraryPath(preferencePath, relocatedLibrary);
    expect(await restoreLastLibraryPath(preferencePath)).toBe(relocatedLibrary);
    expect(await createNodeLibraryReader(relocatedLibrary).readText(projectPath)).toBe(project);
  });

  test("ignores malformed, oversized, and relative preferences", async () => {
    const root = await temporaryRoot();
    const preferencePath = join(root, "library.json");
    await writeFile(preferencePath, "{invalid");
    expect(await readLastLibraryPath(preferencePath)).toBeNull();

    await writeFile(preferencePath, "x".repeat(MAX_LAST_LIBRARY_PATH_BYTES + 1));
    expect(await readLastLibraryPath(preferencePath)).toBeNull();
    await expect(writeLastLibraryPath(preferencePath, "relative/library")).rejects.toThrow();
  });

  test("keeps an unavailable removable-drive path saved until a replacement is selected", async () => {
    const root = await temporaryRoot();
    const preferencePath = join(root, "app data", "library.json");
    const removableLibrary = join(root, "removable library");
    await mkdir(removableLibrary);
    await writeLastLibraryPath(preferencePath, removableLibrary);
    await rm(removableLibrary, { recursive: true });

    expect(await restoreLastLibraryPath(preferencePath)).toBeNull();
    expect(await readLastLibraryPath(preferencePath)).toBe(removableLibrary);
  });
});
