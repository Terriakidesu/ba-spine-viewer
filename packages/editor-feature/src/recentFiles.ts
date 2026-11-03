export type RecentFileKind = "folder" | "project" | "subtitle" | "audio";

export interface RecentFile {
  kind: RecentFileKind;
  path: string;
  rootPath: string;
  label: string;
  directory?: string;
  lastOpened: number;
}

export const RECENT_FILES_KEY = "shittim-spine-editor:recent-files:v1";
export const RECENT_FILES_LIMIT = 12;

function isKind(value: unknown): value is RecentFileKind {
  return value === "folder" || value === "project" || value === "subtitle" || value === "audio";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recentKey(item: Pick<RecentFile, "kind" | "rootPath" | "path">): string {
  return `${item.kind}:${item.rootPath}:${item.path}`.toLocaleLowerCase();
}

export function normalizeRecentFiles(value: unknown, limit = RECENT_FILES_LIMIT): RecentFile[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, RecentFile>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Partial<RecentFile>;
    if (!isKind(raw.kind)) continue;
    const path = stringValue(raw.path);
    const rootPath = stringValue(raw.rootPath);
    const label = stringValue(raw.label) || path.split(/[\\/]/).pop() || rootPath.split(/[\\/]/).pop() || "Untitled";
    if (!rootPath) continue;
    const item: RecentFile = {
      kind: raw.kind,
      path: raw.kind === "folder" ? rootPath : path,
      rootPath,
      label,
      directory: stringValue(raw.directory) || undefined,
      lastOpened: Number.isFinite(raw.lastOpened) ? Number(raw.lastOpened) : 0,
    };
    const key = recentKey(item);
    const previous = unique.get(key);
    if (!previous || item.lastOpened >= previous.lastOpened) unique.set(key, item);
  }
  return [...unique.values()]
    .sort((a, b) => b.lastOpened - a.lastOpened || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limit));
}

export function rememberRecentFile(items: readonly RecentFile[], item: Omit<RecentFile, "lastOpened"> & { lastOpened?: number }, limit = RECENT_FILES_LIMIT): RecentFile[] {
  const next: RecentFile = { ...item, lastOpened: item.lastOpened ?? Date.now() };
  return normalizeRecentFiles([next, ...items], limit);
}

export function removeRecentFile(items: readonly RecentFile[], item: Pick<RecentFile, "kind" | "rootPath" | "path">): RecentFile[] {
  const key = recentKey(item);
  return items.filter((candidate) => recentKey(candidate) !== key);
}
