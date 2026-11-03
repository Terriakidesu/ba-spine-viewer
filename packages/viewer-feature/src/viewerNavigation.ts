export const VIEWER_NAVIGATION_STORAGE_PREFIX = "ba-spine-viewer:navigation:v1:";
export const MAX_VIEWER_FAVORITES = 32;
export const MAX_VIEWER_RECENTS = 8;

export interface ViewerNavigationState {
  favorites: string[];
  recent: string[];
}

export const EMPTY_VIEWER_NAVIGATION: ViewerNavigationState = { favorites: [], recent: [] };

function uniqueDirectories(value: unknown, max: number, available?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > 256 || /[\u0000-\u001f\u007f]/.test(item)) continue;
    if (available && !available.has(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeViewerNavigation(value: unknown, available?: ReadonlySet<string>): ViewerNavigationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_VIEWER_NAVIGATION;
  const raw = value as { favorites?: unknown; recent?: unknown };
  return {
    favorites: uniqueDirectories(raw.favorites, MAX_VIEWER_FAVORITES, available),
    recent: uniqueDirectories(raw.recent, MAX_VIEWER_RECENTS, available),
  };
}

export function readViewerNavigation(storage: Pick<Storage, "getItem">, libraryIdentity: string): ViewerNavigationState {
  try {
    const raw = storage.getItem(`${VIEWER_NAVIGATION_STORAGE_PREFIX}${libraryIdentity}`);
    return raw ? normalizeViewerNavigation(JSON.parse(raw) as unknown) : EMPTY_VIEWER_NAVIGATION;
  } catch { return EMPTY_VIEWER_NAVIGATION; }
}

export function writeViewerNavigation(storage: Pick<Storage, "setItem">, libraryIdentity: string, state: ViewerNavigationState): void {
  storage.setItem(`${VIEWER_NAVIGATION_STORAGE_PREFIX}${libraryIdentity}`, JSON.stringify(normalizeViewerNavigation(state)));
}

export function toggleViewerFavorite(state: ViewerNavigationState, directory: string): ViewerNavigationState {
  const favorites = state.favorites.includes(directory)
    ? state.favorites.filter((item) => item !== directory)
    : [directory, ...state.favorites.filter((item) => item !== directory)].slice(0, MAX_VIEWER_FAVORITES);
  return { ...state, favorites };
}

export function recordRecentLobby(state: ViewerNavigationState, directory: string): ViewerNavigationState {
  if (!directory) return state;
  const recent = [directory, ...state.recent.filter((item) => item !== directory)].slice(0, MAX_VIEWER_RECENTS);
  if (recent.length === state.recent.length && recent.every((item, index) => item === state.recent[index])) return state;
  return { ...state, recent };
}

export function matchesLibrarySearch(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return fields.some((field) => typeof field === "string" && field.toLocaleLowerCase().includes(normalizedQuery));
}

export function nextViewerListIndex(length: number, currentIndex: number, key: string): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return Math.min(length - 1, Math.max(0, currentIndex) + 1);
  if (key === "ArrowUp") return Math.max(0, Math.min(length - 1, currentIndex) - 1);
  return currentIndex;
}
