import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";
import { EditorFileConflictError, PartialEditorBatchSaveError, saveEditorBatch, type EditorBatchFile } from "./transactionalSave";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ba-spine-save-fixture-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("conflict-safe Editor batch persistence", () => {
  test("detects external edits before changing any target", async () => withFixture(async (root) => {
    const path = ".editor/Airi_home.spine-project.json";
    const otherPath = "lobbies/Airi_home/sequences/opening.json";
    const otherOriginal = JSON.stringify({ sequence: "original" });
    await mkdir(join(root, ".editor"), { recursive: true });
    await mkdir(join(root, "lobbies", "Airi_home", "sequences"), { recursive: true });
    await writeFile(join(root, path), JSON.stringify({ title: "external" }));
    await writeFile(join(root, otherPath), otherOriginal);
    const writes: EditorBatchFile[] = [
      { path, content: JSON.stringify({ title: "editor" }), expectedVersion: contentVersion(JSON.stringify({ title: "original" })) },
      { path: otherPath, content: JSON.stringify({ sequence: "editor" }), expectedVersion: contentVersion(otherOriginal) },
    ];

    let conflict: EditorFileConflictError | null = null;
    try { await saveEditorBatch(root, writes); }
    catch (error) { if (error instanceof EditorFileConflictError) conflict = error; else throw error; }

    expect(conflict).not.toBeNull();
    expect(conflict?.currentVersions[path]).toBe(contentVersion(JSON.stringify({ title: "external" })));
    expect(await readFile(join(root, path), "utf8")).toBe(JSON.stringify({ title: "external" }));
    expect(await readFile(join(root, otherPath), "utf8")).toBe(otherOriginal);
  }));

  test("serializes concurrent Editor saves against the same baseline", async () => withFixture(async (root) => {
    const path = ".editor/Airi_home.spine-project.json";
    const original = JSON.stringify({ revision: 0 });
    await mkdir(join(root, ".editor"), { recursive: true });
    await writeFile(join(root, path), original);
    const first = saveEditorBatch(root, [{ path, content: JSON.stringify({ revision: 1 }), expectedVersion: contentVersion(original) }]);
    const second = saveEditorBatch(root, [{ path, content: JSON.stringify({ revision: 2 }), expectedVersion: contentVersion(original) }]);
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof EditorFileConflictError)).toHaveLength(1);
    expect([JSON.stringify({ revision: 1 }), JSON.stringify({ revision: 2 })]).toContain(await readFile(join(root, path), "utf8"));
  }));

  test("rechecks immediately before replacement to catch edits during staging", async () => withFixture(async (root) => {
    const path = ".editor/Airi_home.spine-project.json";
    const original = JSON.stringify({ value: "original" });
    const external = JSON.stringify({ value: "raced-edit" });
    await mkdir(join(root, ".editor"), { recursive: true });
    await writeFile(join(root, path), original);
    let conflict: EditorFileConflictError | null = null;
    try {
      await saveEditorBatch(root, [{ path, content: JSON.stringify({ value: "editor" }), expectedVersion: contentVersion(original) }], {}, {
        beforeCommit: async () => { await writeFile(join(root, path), external); },
      });
    } catch (error) { if (error instanceof EditorFileConflictError) conflict = error; else throw error; }

    expect(conflict?.currentVersions[path]).toBe(contentVersion(external));
    expect(await readFile(join(root, path), "utf8")).toBe(external);
  }));

  test("overwrites only the reviewed version and stores a bounded pre-save backup", async () => withFixture(async (root) => {
    const path = ".editor/Airi_home.spine-project.json";
    const external = JSON.stringify({ title: "external" });
    await mkdir(join(root, ".editor"), { recursive: true });
    await writeFile(join(root, path), external);
    const writes: EditorBatchFile[] = [{ path, content: JSON.stringify({ title: "editor" }), expectedVersion: contentVersion(null) }];
    let currentVersions: Record<string, string> = {};
    try { await saveEditorBatch(root, writes); }
    catch (error) {
      if (!(error instanceof EditorFileConflictError)) throw error;
      currentVersions = error.currentVersions;
    }
    await saveEditorBatch(root, writes, currentVersions);

    expect(await readFile(join(root, path), "utf8")).toBe(JSON.stringify({ title: "editor" }));
    const backups = await readdir(join(root, ".editor", "backups"));
    expect(backups).toHaveLength(1);
    const backup = JSON.parse(await readFile(join(root, ".editor", "backups", backups[0]!), "utf8")) as { files: Array<{ path: string; content: string }> };
    expect(backup.files).toEqual([{ path, content: external }]);

    let version = contentVersion(JSON.stringify({ title: "editor" }));
    for (let index = 0; index < 6; index++) {
      const content = JSON.stringify({ title: `editor-${index}` });
      await saveEditorBatch(root, [{ path, content, expectedVersion: version }]);
      version = contentVersion(content);
    }
    expect((await readdir(join(root, ".editor", "backups"))).filter((item) => item.endsWith(".json"))).toHaveLength(5);
  }));

  test("rolls back already-replaced files when a later commit fails", async () => withFixture(async (root) => {
    const firstPath = ".editor/Airi_home.spine-project.json";
    const secondPath = "lobbies/Airi_home/sequences/opening.json";
    const first = JSON.stringify({ value: "first-old" });
    const second = JSON.stringify({ value: "second-old" });
    await mkdir(join(root, ".editor"), { recursive: true });
    await mkdir(join(root, "lobbies", "Airi_home", "sequences"), { recursive: true });
    await writeFile(join(root, firstPath), first);
    await writeFile(join(root, secondPath), second);
    const writes: EditorBatchFile[] = [
      { path: firstPath, content: JSON.stringify({ value: "first-new" }), expectedVersion: contentVersion(first) },
      { path: secondPath, content: JSON.stringify({ value: "second-new" }), expectedVersion: contentVersion(second) },
    ];

    let failure: PartialEditorBatchSaveError | null = null;
    try {
      await saveEditorBatch(root, writes, {}, { beforeCommit: (_path, index) => { if (index === 1) throw new Error("fixture commit fault"); } });
    } catch (error) {
      if (error instanceof PartialEditorBatchSaveError) failure = error;
      else throw error;
    }

    expect(failure?.committedPaths).toEqual([firstPath]);
    expect(failure?.rollbackFailures).toEqual([]);
    expect(await readFile(join(root, firstPath), "utf8")).toBe(first);
    expect(await readFile(join(root, secondPath), "utf8")).toBe(second);
  }));
});
