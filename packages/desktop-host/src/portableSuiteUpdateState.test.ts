import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEditorSuiteUpdateState,
  hasLiveEditorSuiteUpdateChanges,
  writeEditorSuiteUpdateState,
} from "./portableSuiteUpdateState";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryAppData(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "suite-update-state-"));
  roots.push(path);
  return path;
}

describe("portable suite Editor save state", () => {
  test("blocks suite updates while a live Editor process has unsaved changes", async () => {
    const appData = await temporaryAppData();
    await writeEditorSuiteUpdateState(appData, process.pid, true);
    expect(await hasLiveEditorSuiteUpdateChanges(appData)).toBe(true);
  });

  test("allows updates when Editor is clean and clears only its own state", async () => {
    const appData = await temporaryAppData();
    await writeEditorSuiteUpdateState(appData, process.pid, true);
    await writeEditorSuiteUpdateState(appData, process.pid, false);
    expect(await hasLiveEditorSuiteUpdateChanges(appData)).toBe(false);
    await clearEditorSuiteUpdateState(appData, process.pid + 1);
    expect(await hasLiveEditorSuiteUpdateChanges(appData)).toBe(false);
    await clearEditorSuiteUpdateState(appData, process.pid);
    expect(await hasLiveEditorSuiteUpdateChanges(appData)).toBe(false);
  });

  test("fails closed when the shared Editor state cannot be trusted", async () => {
    const appData = await temporaryAppData();
    const statePath = join(appData, "BA Spine Suite", "Editor", "suite-update-state", `${process.pid}.json`);
    await writeEditorSuiteUpdateState(appData, process.pid, false);
    await writeFile(statePath, "not-json");
    await expect(hasLiveEditorSuiteUpdateChanges(appData)).rejects.toThrow("could not be verified");
  });
});
