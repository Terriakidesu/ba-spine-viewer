import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";
import { assertLibraryWritePath, isSupportedEditorWritePath, resolveLibraryPath } from "./pathPolicy";

export interface EditorBatchFile {
  path: string;
  content: string;
  expectedVersion: string;
}

export interface EditorBatchSaveResult {
  paths: string[];
  backupPath: string | null;
}

export class EditorFileConflictError extends Error {
  constructor(readonly currentVersions: Record<string, string>) {
    super(`External changes detected in: ${Object.keys(currentVersions).join(", ")}`);
    this.name = "EditorFileConflictError";
  }
}

export class PartialEditorBatchSaveError extends Error {
  constructor(message: string, readonly committedPaths: string[], readonly rollbackFailures: string[]) {
    super(message);
    this.name = "PartialEditorBatchSaveError";
  }
}

const MAX_FILES_PER_BATCH = 64;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_BACKUPS = 5;
const backupQueues = new Map<string, Promise<void>>();

interface ExistingFile {
  content: string | null;
  version: string;
}

async function currentFile(root: string, relativePath: string): Promise<{ fullPath: string; file: ExistingFile }> {
  if (!isSupportedEditorWritePath(relativePath)) throw new Error(`Editor write path is not supported: ${relativePath}`);
  const fullPath = resolveLibraryPath(root, relativePath);
  await assertLibraryWritePath(root, fullPath);
  try {
    const info = await lstat(fullPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to replace a non-regular editor file: ${relativePath}`);
    const content = await readFile(fullPath, "utf8");
    return { fullPath, file: { content, version: contentVersion(content) } };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { fullPath, file: { content: null, version: contentVersion(null) } };
    }
    throw error;
  }
}

function conflictsFor(files: readonly EditorBatchFile[], actual: ReadonlyMap<string, ExistingFile>, overwriteVersions: Readonly<Record<string, string>>): Record<string, string> {
  const conflicts: Record<string, string> = {};
  for (const item of files) {
    const version = actual.get(item.path)?.version ?? contentVersion(null);
    if (version !== item.expectedVersion && version !== overwriteVersions[item.path]) conflicts[item.path] = version;
  }
  return conflicts;
}

function queueForRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(root).toLocaleLowerCase();
  const previous = backupQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  backupQueues.set(key, gate);
  return previous.then(action).finally(() => {
    release();
    if (backupQueues.get(key) === gate) backupQueues.delete(key);
  });
}

async function atomicReplace(fullPath: string, content: string | null, root: string): Promise<void> {
  if (content === null) {
    await rm(fullPath, { force: true });
    return;
  }
  await assertLibraryWritePath(root, fullPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await assertLibraryWritePath(root, fullPath);
  const temporary = `${fullPath}.ba-spine-rollback-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, fullPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeBackup(root: string, files: readonly EditorBatchFile[], prior: ReadonlyMap<string, ExistingFile>): Promise<string | null> {
  const entries = files.flatMap((item) => {
    const content = prior.get(item.path)?.content;
    return content === null || content === undefined ? [] : [{ path: item.path, content }];
  });
  if (entries.length === 0) return null;
  const content = JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: entries }, null, 2) + "\n";
  if (new TextEncoder().encode(content).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Save backup exceeds the 16 MB safety limit; no files were changed.");
  }
  const backupsDirectory = resolveLibraryPath(root, ".editor/backups");
  const backupPath = `.editor/backups/save-${Date.now()}-${randomUUID()}.json`;
  const fullBackupPath = resolveLibraryPath(root, backupPath);
  await assertLibraryWritePath(root, fullBackupPath);
  await mkdir(backupsDirectory, { recursive: true });
  await assertLibraryWritePath(root, fullBackupPath);
  const temporary = `${fullBackupPath}.ba-spine-tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, fullBackupPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return backupPath;
}

async function pruneBackups(root: string): Promise<void> {
  const directory = resolveLibraryPath(root, ".editor/backups");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const backups = await Promise.all(entries
    .filter((item) => item.isFile() && /^save-[a-z0-9-]+\.json$/i.test(item.name))
    .map(async (item) => ({ path: join(directory, item.name), modified: (await stat(join(directory, item.name))).mtimeMs })));
  backups.sort((left, right) => right.modified - left.modified || right.path.localeCompare(left.path));
  await Promise.all(backups.slice(MAX_BACKUPS).map((item) => rm(item.path, { force: true })));
}

/** Optimistically validate, stage and atomically replace an Editor save set. */
export function saveEditorBatch(
  libraryRoot: string,
  files: readonly EditorBatchFile[],
  overwriteVersions: Readonly<Record<string, string>> = {},
  options: { beforeCommit?: (path: string, index: number) => void | Promise<void> } = {},
): Promise<EditorBatchSaveResult> {
  return queueForRoot(libraryRoot, async () => {
    if (files.length === 0 || files.length > MAX_FILES_PER_BATCH) throw new Error(`An Editor save must contain between 1 and ${MAX_FILES_PER_BATCH} files.`);
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const item of files) {
      if (!item || typeof item.path !== "string" || typeof item.content !== "string" || typeof item.expectedVersion !== "string") throw new Error("Editor save entries require a path, JSON content, and baseline version.");
      if (seen.has(item.path)) throw new Error(`Duplicate Editor save path: ${item.path}`);
      seen.add(item.path);
      if (!isSupportedEditorWritePath(item.path)) throw new Error(`Editor write path is not supported: ${item.path}`);
      const bytes = new TextEncoder().encode(item.content).byteLength;
      if (bytes > MAX_FILE_BYTES) throw new Error(`Editor file exceeds the 16 MB safety limit: ${item.path}`);
      totalBytes += bytes;
      try { JSON.parse(item.content); } catch { throw new Error(`Editor save is not valid JSON: ${item.path}`); }
    }
    if (totalBytes > 32 * 1024 * 1024) throw new Error("Editor save set exceeds the 32 MB safety limit.");

    const root = await realpath(resolve(libraryRoot));
    const resolved = await Promise.all(files.map(async (item) => [item.path, await currentFile(root, item.path)] as const));
    const actual = new Map(resolved.map(([path, result]) => [path, result.file]));
    const conflicts = conflictsFor(files, actual, overwriteVersions);
    if (Object.keys(conflicts).length > 0) throw new EditorFileConflictError(conflicts);

    const staged: Array<{ path: string; fullPath: string; temporary: string }> = [];
    const committed: EditorBatchFile[] = [];
    let backupPath: string | null = null;
    try {
      for (const item of files) {
        const fullPath = resolveLibraryPath(root, item.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await assertLibraryWritePath(root, fullPath);
        const temporary = `${fullPath}.ba-spine-tmp-${randomUUID()}`;
        await writeFile(temporary, item.content, { encoding: "utf8", flag: "wx" });
        staged.push({ path: item.path, fullPath, temporary });
      }

      // Catch changes made while output files were being staged, before replacing anything.
      const latest = await Promise.all(files.map(async (item) => [item.path, (await currentFile(root, item.path)).file] as const));
      const latestByPath = new Map(latest);
      const lateConflicts = conflictsFor(files, latestByPath, overwriteVersions);
      if (Object.keys(lateConflicts).length > 0) throw new EditorFileConflictError(lateConflicts);

      backupPath = await writeBackup(root, files, latestByPath);
      await pruneBackups(root);
      for (const [index, item] of files.entries()) {
        await options.beforeCommit?.(item.path, index);
        const stage = staged[index]!;
        const immediatelyBeforeCommit = await currentFile(root, item.path);
        if (immediatelyBeforeCommit.file.version !== latestByPath.get(item.path)?.version) {
          throw new EditorFileConflictError({ [item.path]: immediatelyBeforeCommit.file.version });
        }
        await assertLibraryWritePath(root, stage.fullPath);
        await rename(stage.temporary, stage.fullPath);
        committed.push(item);
      }
      return { paths: files.map((item) => item.path), backupPath };
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const item of [...committed].reverse()) {
        try {
          const before = actual.get(item.path)!;
          const current = await currentFile(root, item.path);
          if (current.file.version !== contentVersion(item.content)) {
            rollbackFailures.push(item.path);
            continue;
          }
          await atomicReplace(current.fullPath, before.content, root);
        } catch {
          rollbackFailures.push(item.path);
        }
      }
      await Promise.all(staged.map((item) => rm(item.temporary, { force: true }).catch(() => undefined)));
      if (committed.length > 0 || rollbackFailures.length > 0) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new PartialEditorBatchSaveError(
          `${reason} ${rollbackFailures.length ? `Rollback was incomplete for: ${rollbackFailures.join(", ")}.` : "Previously replaced files were rolled back."}`,
          committed.map((item) => item.path),
          rollbackFailures,
        );
      }
      throw error;
    }
  });
}
