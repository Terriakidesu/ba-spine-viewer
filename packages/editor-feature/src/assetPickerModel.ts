import type { AssetSetKind, CharacterDirectoryInfo } from "./characterCatalog";

export type AssetPickerView = "all" | "favorites" | "recent";

export interface AssetSetPreferences {
  favorites: string[];
  recent: string[];
}

export interface AssetPickerEntry {
  directory: string;
  label: string;
  group: string;
  groupKey: string;
  kind: AssetSetKind;
  role: string;
}

const EMPTY_PREFERENCES: AssetSetPreferences = { favorites: [], recent: [] };

function inferredKind(directory: string): AssetSetKind {
  const normalized = directory.toLocaleLowerCase();
  if (/(^|[_ .-])(scene|cutscene)([_ .-]|$)/.test(normalized)) return "scene";
  if (/(^|[_ .-])(background|backdrop|bg)([_ .-]|$)/.test(normalized)) return "background";
  if (/(^|[_ .-])(home|lobby)([_ .-]|$)/.test(normalized)) return "character";
  return "other";
}

function fallbackGroup(directory: string, kind: AssetSetKind): string {
  const stem = directory.replace(/(?:[_ .-](?:home|lobby|scene|cutscene|background|backdrop|bg))$/i, "").replace(/[_ .-]+/g, " ").trim();
  return stem || (kind === "other" ? "Other assets" : kind === "character" ? "Characters" : kind === "scene" ? "Scenes" : "Backgrounds");
}

export function buildAssetPickerEntries(
  directories: readonly string[],
  directoryInfo: Readonly<Record<string, CharacterDirectoryInfo>> = {},
): AssetPickerEntry[] {
  return directories.map((directory) => {
    const info = directoryInfo[directory];
    const kind = info?.kind ?? inferredKind(directory);
    const group = info?.group || fallbackGroup(directory, kind);
    const category = kind === "character" ? "Characters" : kind === "scene" ? "Scenes" : kind === "background" ? "Backgrounds" : "Other assets";
    return {
      directory,
      label: info?.label ?? directory,
      group,
      groupKey: `${category}\u0000${group.toLocaleLowerCase()}`,
      kind,
      role: info?.role ?? (kind === "character" ? "Character" : kind === "scene" ? "Scene" : kind === "background" ? "Background" : "Other"),
    };
  });
}

export function assetSetPreferencesKey(assetRoot: string): string {
  return `shittim-spine-editor:asset-picker:v1:${encodeURIComponent(assetRoot)}`;
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((path): path is string => {
    if (typeof path !== "string" || !path.trim() || seen.has(path)) return false;
    seen.add(path);
    return true;
  }).slice(0, 100);
}

export function normalizeAssetSetPreferences(value: unknown): AssetSetPreferences {
  if (!value || typeof value !== "object") return { ...EMPTY_PREFERENCES };
  const raw = value as Partial<AssetSetPreferences>;
  return { favorites: normalizePaths(raw.favorites), recent: normalizePaths(raw.recent).slice(0, 12) };
}

export function toggleAssetFavorite(favorites: readonly string[], directory: string): string[] {
  return favorites.includes(directory)
    ? favorites.filter((item) => item !== directory)
    : [directory, ...favorites.filter((item) => item !== directory)].slice(0, 100);
}

export function rememberAssetSet(recent: readonly string[], directory: string): string[] {
  return [directory, ...recent.filter((item) => item !== directory)].slice(0, 12);
}

function matchRank(entry: AssetPickerEntry, query: string, searchText: string): number {
  if (!query) return 0;
  const normalizedQuery = query.toLocaleLowerCase();
  const fields = [entry.label, entry.directory, entry.group, entry.role, searchText].map((item) => item.toLocaleLowerCase());
  if (fields.some((field) => field === normalizedQuery)) return 0;
  if (fields.some((field) => field.startsWith(normalizedQuery))) return 1;
  if (fields.some((field) => field.includes(normalizedQuery))) return 2;
  return Number.POSITIVE_INFINITY;
}

export function filterAndSortAssetPickerEntries(
  entries: readonly AssetPickerEntry[],
  query: string,
  view: AssetPickerView,
  preferences: AssetSetPreferences,
  searchText: Readonly<Record<string, string>> = {},
): AssetPickerEntry[] {
  const normalizedQuery = query.trim();
  const favorites = new Set(preferences.favorites);
  const recentOrder = new Map(preferences.recent.map((directory, index) => [directory, index]));
  const favoriteOrder = new Map(preferences.favorites.map((directory, index) => [directory, index]));
  const kindOrder: Record<AssetSetKind, number> = { character: 0, scene: 1, background: 2, other: 3 };
  return entries
    .filter((entry) => view === "all" || (view === "favorites" ? favorites.has(entry.directory) : recentOrder.has(entry.directory)))
    .map((entry) => ({ entry, rank: matchRank(entry, normalizedQuery, searchText[entry.directory] ?? "") }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => {
      if (view === "recent") return (recentOrder.get(left.entry.directory) ?? Infinity) - (recentOrder.get(right.entry.directory) ?? Infinity) || left.entry.directory.localeCompare(right.entry.directory);
      if (view === "favorites") return (favoriteOrder.get(left.entry.directory) ?? Infinity) - (favoriteOrder.get(right.entry.directory) ?? Infinity) || left.entry.directory.localeCompare(right.entry.directory);
      return left.rank - right.rank
        || kindOrder[left.entry.kind] - kindOrder[right.entry.kind]
        || left.entry.group.localeCompare(right.entry.group)
        || left.entry.label.localeCompare(right.entry.label)
        || left.entry.directory.localeCompare(right.entry.directory);
    })
    .map(({ entry }) => entry);
}

export function groupAssetPickerEntries(entries: readonly AssetPickerEntry[]): Array<{ key: string; label: string; entries: AssetPickerEntry[] }> {
  const groups = new Map<string, { key: string; label: string; entries: AssetPickerEntry[] }>();
  for (const entry of entries) {
    const category = entry.kind === "character" ? "Characters" : entry.kind === "scene" ? "Scenes" : entry.kind === "background" ? "Backgrounds" : "Other assets";
    let group = groups.get(entry.groupKey);
    if (!group) {
      group = { key: entry.groupKey, label: `${category} · ${entry.group}`, entries: [] };
      groups.set(entry.groupKey, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

export function movePickerIndex(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, index + direction));
}

export function initialPickerIndex(selectedIndex: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, selectedIndex >= 0 ? selectedIndex : 0));
}
