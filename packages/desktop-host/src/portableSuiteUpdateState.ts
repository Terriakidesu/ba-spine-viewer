import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UPDATE_STATE_DIRECTORY = join("BA Spine Suite", "Editor", "suite-update-state");
const MAX_STATE_BYTES = 1024;

interface EditorUpdateStateRecord {
  schemaVersion: 1;
  pid: number;
  dirty: boolean;
}

function stateDirectory(appDataRoot: string): string {
  return join(appDataRoot, UPDATE_STATE_DIRECTORY);
}

function statePath(appDataRoot: string, pid: number): string {
  return join(stateDirectory(appDataRoot), `${pid}.json`);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export async function writeEditorSuiteUpdateState(appDataRoot: string, pid: number, dirty: boolean): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Editor update state requires a valid process ID.");
  const directory = stateDirectory(appDataRoot);
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Editor update state directory is not a regular directory.");
  const path = statePath(appDataRoot, pid);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Editor update state path is not a regular file.");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const record: EditorUpdateStateRecord = { schemaVersion: 1, pid, dirty };
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Treat a live Editor dirty marker as authoritative, and ignore markers from exited processes. */
export async function hasLiveEditorSuiteUpdateChanges(appDataRoot: string): Promise<boolean> {
  const directory = stateDirectory(appDataRoot);
  let entries;
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("Editor save state could not be verified. Close Editor only after saving your work, then retry.");
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry.name)) continue;
    const pid = Number(entry.name.slice(0, -".json".length));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const path = statePath(appDataRoot, pid);
    const info = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      throw new Error("Editor save state could not be verified. Close Editor only after saving your work, then retry.");
    }
    let record: Partial<EditorUpdateStateRecord>;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as Partial<EditorUpdateStateRecord>;
    } catch {
      throw new Error("Editor save state could not be verified. Close Editor only after saving your work, then retry.");
    }
    if (record.schemaVersion !== 1 || record.pid !== pid || typeof record.dirty !== "boolean") {
      throw new Error("Editor save state could not be verified. Close Editor only after saving your work, then retry.");
    }
    if (processIsRunning(pid)) {
      if (record.dirty) return true;
    } else {
      await rm(path, { force: true });
    }
  }
  return false;
}

export async function clearEditorSuiteUpdateState(appDataRoot: string, pid: number): Promise<void> {
  const path = statePath(appDataRoot, pid);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) return;
    const record = JSON.parse(await readFile(path, "utf8")) as Partial<EditorUpdateStateRecord>;
    if (record.schemaVersion === 1 && record.pid === pid) await rm(path, { force: true });
  } catch {
    // Exit cleanup is best-effort; stale state is ignored once its Editor process is gone.
  }
}
