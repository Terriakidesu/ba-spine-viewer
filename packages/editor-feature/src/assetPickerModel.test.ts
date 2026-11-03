import { describe, expect, test } from "bun:test";
import { assetSetPreferencesKey, buildAssetPickerEntries, filterAndSortAssetPickerEntries, groupAssetPickerEntries, initialPickerIndex, movePickerIndex, normalizeAssetSetPreferences, rememberAssetSet, toggleAssetFavorite } from "./assetPickerModel";

describe("asset picker keyboard navigation", () => {
  test("starts on the selected option or first result", () => {
    expect(initialPickerIndex(2, 4)).toBe(2);
    expect(initialPickerIndex(-1, 4)).toBe(0);
    expect(initialPickerIndex(0, 0)).toBe(-1);
  });

  test("arrow navigation stays inside the result list", () => {
    expect(movePickerIndex(0, -1, 3)).toBe(0);
    expect(movePickerIndex(0, 1, 3)).toBe(1);
    expect(movePickerIndex(2, 1, 3)).toBe(2);
    expect(movePickerIndex(0, 1, 0)).toBe(-1);
  });
});

describe("asset picker catalog organization", () => {
  const directories = ["Seia_scene", "CH0295_home", "Seia_background", "CH0070_home"];
  const entries = buildAssetPickerEntries(directories, {
    CH0070_home: { label: "Seia (CH0070)", group: "Seia", kind: "character", role: "Striker" },
    CH0295_home: { label: "Seia Swimsuit (CH0295)", group: "Seia", kind: "character", role: "Striker" },
    Seia_scene: { label: "Seia Scene", group: "Seia", kind: "scene", role: "Scene" },
    Seia_background: { label: "Seia Background", group: "Seia", kind: "background", role: "Background" },
  });

  test("groups variants and related local scene/background sets by friendly family", () => {
    const sorted = filterAndSortAssetPickerEntries(entries, "", "all", { favorites: [], recent: [] });
    const groups = groupAssetPickerEntries(sorted);
    expect(groups.map((group) => group.label)).toEqual([
      "Characters · Seia", "Scenes · Seia", "Backgrounds · Seia",
    ]);
    expect(groups.find((group) => group.label === "Characters · Seia")?.entries.map((entry) => entry.directory)).toEqual([
      "CH0070_home", "CH0295_home",
    ]);
  });

  test("keeps all-results ordering stable and ranks exact friendly-name matches first", () => {
    const sorted = filterAndSortAssetPickerEntries(entries, "", "all", { favorites: [], recent: [] });
    expect(sorted.map((entry) => entry.directory)).toEqual(["CH0070_home", "CH0295_home", "Seia_scene", "Seia_background"]);
    expect(filterAndSortAssetPickerEntries(entries, "Seia Swimsuit (CH0295)", "all", { favorites: [], recent: [] }).map((entry) => entry.directory)).toEqual(["CH0295_home"]);
  });

  test("favorites and recent filters retain user order and safely normalize stored data", () => {
    const preferences = normalizeAssetSetPreferences({ favorites: ["Seia_scene", "Seia_scene", "missing"], recent: ["Seia_background", "CH0295_home", "CH0295_home"] });
    expect(preferences).toEqual({ favorites: ["Seia_scene", "missing"], recent: ["Seia_background", "CH0295_home"] });
    expect(filterAndSortAssetPickerEntries(entries, "", "favorites", preferences).map((entry) => entry.directory)).toEqual(["Seia_scene"]);
    expect(filterAndSortAssetPickerEntries(entries, "", "recent", preferences).map((entry) => entry.directory)).toEqual(["Seia_background", "CH0295_home"]);
    expect(toggleAssetFavorite(preferences.favorites, "CH0070_home")).toEqual(["CH0070_home", "Seia_scene", "missing"]);
    expect(rememberAssetSet(preferences.recent, "CH0295_home")).toEqual(["CH0295_home", "Seia_background"]);
    expect(assetSetPreferencesKey("C:/asset root")).not.toBe(assetSetPreferencesKey("D:/asset root"));
  });
});
