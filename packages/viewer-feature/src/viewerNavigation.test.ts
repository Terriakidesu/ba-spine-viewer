import { describe, expect, test } from "bun:test";
import {
  EMPTY_VIEWER_NAVIGATION,
  MAX_VIEWER_RECENTS,
  MAX_VIEWER_FAVORITES,
  VIEWER_NAVIGATION_STORAGE_PREFIX,
  matchesLibrarySearch,
  nextViewerListIndex,
  normalizeViewerNavigation,
  readViewerNavigation,
  recordRecentLobby,
  toggleViewerFavorite,
  writeViewerNavigation,
  type ViewerNavigationState,
} from "./viewerNavigation";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

describe("Viewer library navigation preferences", () => {
  test("persists favorites and recents under a per-library identity", () => {
    const storage = new MemoryStorage();
    const state: ViewerNavigationState = { favorites: ["Airi_home", "Hina_home"], recent: ["Hina_home", "Airi_home"] };
    writeViewerNavigation(storage, "sha256:fixture-library", state);

    expect(readViewerNavigation(storage, "sha256:fixture-library")).toEqual(state);
    expect(readViewerNavigation(storage, "sha256:other-library")).toEqual(EMPTY_VIEWER_NAVIGATION);
    expect(storage.getItem(`${VIEWER_NAVIGATION_STORAGE_PREFIX}sha256:fixture-library`)).not.toBeNull();
  });

  test("normalizes stale, duplicated, malformed, and over-limit lobby lists", () => {
    const available = new Set(["Airi_home", "Hina_home", "Mika_home"]);
    const result = normalizeViewerNavigation({
      favorites: ["Airi_home", "Airi_home", "Missing_lobby", 5, "Hina_home"],
      recent: Array.from({ length: MAX_VIEWER_RECENTS + 2 }, (_, index) => index === 0 ? "Mika_home" : `Old_${index}`),
    }, available);
    expect(result).toEqual({ favorites: ["Airi_home", "Hina_home"], recent: ["Mika_home"] });
  });

  test("toggles favorites and moves recently opened lobbies to the front", () => {
    const initial: ViewerNavigationState = { favorites: ["Airi_home"], recent: ["Hina_home", "Airi_home"] };
    const favorited = toggleViewerFavorite(initial, "Mika_home");
    expect(favorited.favorites).toEqual(["Mika_home", "Airi_home"]);
    expect(toggleViewerFavorite(favorited, "Airi_home").favorites).toEqual(["Mika_home"]);
    expect(recordRecentLobby(initial, "Airi_home").recent).toEqual(["Airi_home", "Hina_home"]);
    expect(recordRecentLobby(initial, "Mika_home").recent[0]).toBe("Mika_home");
  });

  test("keeps favorites and recent lobbies bounded", () => {
    let state: ViewerNavigationState = { favorites: [], recent: [] };
    for (let index = 0; index < MAX_VIEWER_FAVORITES + 3; index++) state = toggleViewerFavorite(state, `Lobby_${index}`);
    for (let index = 0; index < MAX_VIEWER_RECENTS + 3; index++) state = recordRecentLobby(state, `Lobby_${index}`);
    expect(state.favorites).toHaveLength(MAX_VIEWER_FAVORITES);
    expect(state.favorites[0]).toBe(`Lobby_${MAX_VIEWER_FAVORITES + 2}`);
    expect(state.recent).toHaveLength(MAX_VIEWER_RECENTS);
    expect(state.recent[0]).toBe(`Lobby_${MAX_VIEWER_RECENTS + 2}`);
  });

  test("search matches character, variant, lobby directory, and asset identifiers", () => {
    const fields = ["Airi", "Summer", "Airi_summer", "asset-42", "dev_airi_summer"];
    for (const query of ["airi", "SUMMER", "airi_summer", "ASSET-42", "dev_airi"]) {
      expect(matchesLibrarySearch(query, fields)).toBe(true);
    }
    expect(matchesLibrarySearch("nonexistent", fields)).toBe(false);
    expect(matchesLibrarySearch("  ", fields)).toBe(true);
  });

  test("moves keyboard selection with arrows and Home/End without leaving the list", () => {
    expect(nextViewerListIndex(4, 1, "ArrowDown")).toBe(2);
    expect(nextViewerListIndex(4, 0, "ArrowUp")).toBe(0);
    expect(nextViewerListIndex(4, 2, "Home")).toBe(0);
    expect(nextViewerListIndex(4, 0, "End")).toBe(3);
    expect(nextViewerListIndex(0, 0, "ArrowDown")).toBe(-1);
    expect(nextViewerListIndex(4, 1, "Escape")).toBe(1);
  });
});
