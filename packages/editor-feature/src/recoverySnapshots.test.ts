import { describe, expect, test } from "bun:test";
import { createProject, EDITOR_SCHEMA_VERSION, projectStorageKey } from "./editorModel";
import { MAX_RECOVERY_SNAPSHOT_BYTES, persistRecoverySnapshot, readRecoveryRecord } from "./recoverySnapshots";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

describe("Editor local recovery snapshots", () => {
  test("keeps a current recovery and two prior snapshots for explicit restoration", () => {
    const storage = new MemoryStorage();
    const project = createProject("Airi_home", [], []);
    for (let index = 0; index < 5; index++) {
      project.name = `Snapshot ${index}`;
      persistRecoverySnapshot(storage, project, index + 1);
    }

    const record = readRecoveryRecord(storage, "Airi_home");
    expect(record?.current).toMatchObject({ savedAt: 5, project: { name: "Snapshot 4" } });
    expect(record?.backups.map((backup) => (backup.project as { name: string }).name)).toEqual(["Snapshot 3", "Snapshot 2"]);
    expect(projectStorageKey("Airi_home")).toContain(`v${EDITOR_SCHEMA_VERSION}`);
  });

  test("bounds recovery storage to two recent asset sets", () => {
    const storage = new MemoryStorage();
    for (const [index, directory] of ["Airi_home", "Hina_home", "Shiroko_home"].entries()) {
      persistRecoverySnapshot(storage, createProject(directory, [], []), index + 1);
    }
    expect(readRecoveryRecord(storage, "Airi_home")).toBeNull();
    expect(readRecoveryRecord(storage, "Hina_home")).not.toBeNull();
    expect(readRecoveryRecord(storage, "Shiroko_home")).not.toBeNull();
  });

  test("rejects oversized snapshots without writing them", () => {
    const storage = new MemoryStorage();
    const project = createProject("Airi_home", [], []);
    project.name = "x".repeat(MAX_RECOVERY_SNAPSHOT_BYTES + 1);
    expect(() => persistRecoverySnapshot(storage, project)).toThrow("too large");
    expect(readRecoveryRecord(storage, "Airi_home")).toBeNull();
  });
});
