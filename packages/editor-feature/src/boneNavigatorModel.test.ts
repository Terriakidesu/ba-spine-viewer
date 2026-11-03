import { describe, expect, test } from "bun:test";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { bonePathsForFilter, boneTargetPreferencesKey, initialCollapsedBonePaths, normalizeBoneTargetPreferences, parentBonePaths, rememberBoneTarget, toggleBoneFavorite } from "./boneNavigatorModel";

function bone(path: string, parentPath: string | null): SpineEditorBone {
  return { path, name: path.split("/").pop()!, parentPath, active: true } as SpineEditorBone;
}

const rig = [
  bone("root", null),
  bone("root/arm", "root"),
  bone("root/arm/hand", "root/arm"),
  bone("root/arm/finger", "root/arm/hand"),
  bone("root/leg", "root"),
];

describe("bone navigator filters and targets", () => {
  test("shows only configured targets with their ancestor context", () => {
    expect([...bonePathsForFilter(rig, "interaction-targets", ["root/arm/hand", "missing"], null)!].sort()).toEqual([
      "root", "root/arm", "root/arm/hand",
    ]);
    expect([...bonePathsForFilter(rig, "interaction-targets", [], null)!]).toEqual([]);
    expect(bonePathsForFilter(rig, "all", [], null)).toBeNull();
  });

  test("selected branch includes the selection, its descendants, and ancestors only", () => {
    expect([...bonePathsForFilter(rig, "selected-branch", [], "root/arm/hand")!].sort()).toEqual([
      "root", "root/arm", "root/arm/finger", "root/arm/hand",
    ]);
    expect([...bonePathsForFilter(rig, "selected-branch", [], "unknown")!]).toEqual([]);
  });

  test("finds branch parents for the collapsed-by-default hierarchy", () => {
    expect(parentBonePaths(rig)).toEqual(new Set(["root", "root/arm", "root/arm/hand"]));
    expect(initialCollapsedBonePaths(rig)).toEqual(new Set(["root/arm", "root/arm/hand"]));
  });
});

describe("local bone target preferences", () => {
  test("normalizes unique favorites and a bounded recent list", () => {
    expect(normalizeBoneTargetPreferences({
      favorites: ["root/hand", "root/hand", "root/arm"],
      recent: Array.from({ length: 10 }, (_, index) => `bone-${index}`),
    })).toEqual({
      favorites: ["root/hand", "root/arm"],
      recent: ["bone-0", "bone-1", "bone-2", "bone-3", "bone-4", "bone-5", "bone-6", "bone-7"],
    });
  });

  test("toggles favorites and moves a visited target to the front", () => {
    expect(toggleBoneFavorite(["root/arm"], "root/hand")).toEqual(["root/hand", "root/arm"]);
    expect(toggleBoneFavorite(["root/hand", "root/arm"], "root/hand")).toEqual(["root/arm"]);
    expect(rememberBoneTarget(["root/arm", "root/hand"], "root/arm")).toEqual(["root/arm", "root/hand"]);
    expect(rememberBoneTarget([], "root/hand", 2)).toEqual(["root/hand"]);
  });

  test("scopes preferences to the local asset root and set", () => {
    expect(boneTargetPreferencesKey("C:/assets", "Aru_home")).not.toBe(boneTargetPreferencesKey("D:/assets", "Aru_home"));
    expect(boneTargetPreferencesKey("C:/assets", "Aru_home")).not.toBe(boneTargetPreferencesKey("C:/assets", "Ako_home"));
  });
});
