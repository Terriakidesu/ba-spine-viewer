import { EDITOR_SCHEMA_VERSION, projectStorageKey, type EditorProject } from "./editorModel";

const RECOVERY_PREFIX = `shittim-spine-editor:v${EDITOR_SCHEMA_VERSION}:`;
const MAX_PROJECT_RECOVERIES = 2;
const MAX_BACKUPS_PER_PROJECT = 2;
export const MAX_RECOVERY_SNAPSHOT_BYTES = 512 * 1024;

export interface RecoverySnapshot {
  project: unknown;
  savedAt: number;
}

export interface RecoveryRecord {
  current: RecoverySnapshot;
  backups: RecoverySnapshot[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeCurrent(raw: string | null): RecoverySnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isObject(parsed) && parsed.format === "ba-spine-recovery-v1" && "project" in parsed) {
      return { project: parsed.project, savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0 };
    }
    // Upgrade older versions that stored the project directly, but never apply them silently.
    if (isObject(parsed) && typeof parsed.assetDirectory === "string") return { project: parsed, savedAt: 0 };
  } catch { /* Invalid or truncated recovery data is not restorable. */ }
  return null;
}

function decodeBackups(raw: string | null): RecoverySnapshot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => isObject(item) && "project" in item
      ? [{ project: item.project, savedAt: typeof item.savedAt === "number" ? item.savedAt : 0 }]
      : []).slice(0, MAX_BACKUPS_PER_PROJECT);
  } catch { return []; }
}

export function readRecoveryRecord(storage: Pick<Storage, "getItem">, directory: string): RecoveryRecord | null {
  const current = decodeCurrent(storage.getItem(projectStorageKey(directory)));
  if (!current) return null;
  return { current, backups: decodeBackups(storage.getItem(`${projectStorageKey(directory)}:backups`)) };
}

export function readLegacyRecoveryRecord(storage: Pick<Storage, "getItem">, key: string): RecoveryRecord | null {
  const current = decodeCurrent(storage.getItem(key));
  return current ? { current, backups: [] } : null;
}

/** Store one current recovery plus two prior versions, across at most two asset sets. */
export function persistRecoverySnapshot(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">,
  project: EditorProject,
  savedAt = Date.now(),
): void {
  const projectText = JSON.stringify(project);
  const bytes = new TextEncoder().encode(projectText).byteLength;
  if (bytes > MAX_RECOVERY_SNAPSHOT_BYTES) throw new Error("The project is too large for a local recovery snapshot.");

  const key = projectStorageKey(project.assetDirectory);
  const prior = decodeCurrent(storage.getItem(key));
  const backups = decodeBackups(storage.getItem(`${key}:backups`));
  if (prior && JSON.stringify(prior.project) !== projectText) {
    backups.unshift(prior);
  }
  const uniqueBackups = backups.filter((item, index, list) =>
    list.findIndex((candidate) => JSON.stringify(candidate.project) === JSON.stringify(item.project)) === index,
  ).slice(0, MAX_BACKUPS_PER_PROJECT);
  storage.setItem(`${key}:backups`, JSON.stringify(uniqueBackups));
  storage.setItem(key, JSON.stringify({ format: "ba-spine-recovery-v1", savedAt, project }));

  const projectKeys: Array<{ key: string; savedAt: number }> = [];
  for (let index = 0; index < storage.length; index++) {
    const candidate = storage.key(index);
    if (!candidate?.startsWith(RECOVERY_PREFIX) || candidate.endsWith(":backups")) continue;
    const record = decodeCurrent(storage.getItem(candidate));
    if (record) projectKeys.push({ key: candidate, savedAt: record.savedAt });
  }
  projectKeys.sort((left, right) => right.savedAt - left.savedAt);
  for (const stale of projectKeys.slice(MAX_PROJECT_RECOVERIES)) {
    storage.removeItem(stale.key);
    storage.removeItem(`${stale.key}:backups`);
  }
}

export function validRecoveryProject(value: unknown, directory: string): value is EditorProject {
  return isObject(value) && value.assetDirectory === directory;
}
