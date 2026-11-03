import { describe, expect, test } from "bun:test";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { buildBoneTreeRows, rankBoneMatches } from "./boneTree";
import { bonePathsForFilter, initialCollapsedBonePaths } from "./boneNavigatorModel";

function bone(path: string, name: string, parentPath: string | null, active = true): SpineEditorBone {
  return { path, name, parentPath, active } as SpineEditorBone;
}

const rig = [
  bone("root", "root", null),
  bone("root/A", "A", "root"),
  bone("root/B", "B", "root"),
  bone("root/A/A1", "A1", "root/A"),
  bone("root/A/A2", "needle", "root/A"),
  bone("root/B/B1", "B1", "root/B"),
];

describe("Spine bone hierarchy", () => {
  test("depth-first orders subtrees and builds sibling branch continuations", () => {
    const rows = buildBoneTreeRows(rig, new Set(), "");
    expect(rows.map((row) => [row.bone.name, row.depth])).toEqual([
      ["root", 0], ["A", 1], ["A1", 2], ["needle", 2], ["B", 1], ["B1", 2],
    ]);
    expect(rows.find((row) => row.bone.name === "A")?.isLastSibling).toBe(false);
    expect(rows.find((row) => row.bone.name === "B")?.isLastSibling).toBe(true);
    expect(rows.find((row) => row.bone.name === "A1")?.ancestorContinues).toEqual([false, true]);
    expect(rows.find((row) => row.bone.name === "needle")?.isLastSibling).toBe(true);
  });

  test("keeps deep ancestry instead of flattening it at a visual depth cap", () => {
    const deepRig = Array.from({ length: 9 }, (_, depth) => {
      const path = Array.from({ length: depth + 1 }, (_, index) => `Bone${index}`).join("/");
      return bone(path, `Bone${depth}`, depth === 0 ? null : path.slice(0, path.lastIndexOf("/")));
    });
    const rows = buildBoneTreeRows(deepRig, new Set(), "");
    expect(rows.at(-1)?.depth).toBe(8);
    expect(rows.at(-1)?.ancestorContinues).toHaveLength(8);
  });

  test("collapse hides descendants, while search reveals matching branches and ancestors", () => {
    const collapsed = buildBoneTreeRows(rig, new Set(["root/A"]), "");
    expect(collapsed.map((row) => row.bone.name)).toEqual(["root", "A", "B", "B1"]);

    const searched = buildBoneTreeRows(rig, new Set(["root"]), "needle");
    expect(searched.map((row) => row.bone.name)).toEqual(["root", "A", "needle"]);
    expect(searched.map((row) => row.matches)).toEqual([false, false, true]);
  });

  test("starts with a collapsed hierarchy and supports pinned reveal without clearing search", () => {
    const collapsed = buildBoneTreeRows(rig, initialCollapsedBonePaths(rig), "");
    expect(collapsed.map((row) => row.bone.name)).toEqual(["root", "A", "B"]);

    const revealed = buildBoneTreeRows(rig, new Set(["root", "root/B"]), "needle", false, new Set(["root", "root/A", "root/A/A2"]), "root/B/B1");
    expect(revealed.map((row) => row.bone.name)).toEqual(["root", "A", "needle", "B", "B1"]);
    expect(revealed.filter((row) => row.matches).map((row) => row.bone.name)).toEqual(["needle"]);
  });

  test("limits the tree to task-relevant paths while retaining branch context", () => {
    const targets = bonePathsForFilter(rig, "interaction-targets", ["root/B/B1"], null);
    const targetRows = buildBoneTreeRows(rig, new Set(), "", false, targets);
    expect(targetRows.map((row) => row.bone.name)).toEqual(["root", "B", "B1"]);

    const branch = bonePathsForFilter(rig, "selected-branch", [], "root/A");
    const branchRows = buildBoneTreeRows(rig, new Set(), "", false, branch);
    expect(branchRows.map((row) => row.bone.name)).toEqual(["root", "A", "A1", "needle"]);
  });

  test("retains inactive ancestors as context when inactive bones are hidden", () => {
    const rows = buildBoneTreeRows([
      bone("root", "root", null, false),
      bone("root/active", "active", "root", true),
    ], new Set(), "");
    expect(rows.map((row) => [row.bone.name, row.contextOnly])).toEqual([["root", true], ["active", false]]);
  });
});

describe("Spine bone search ranking", () => {
  test("prioritizes exact and name matches over path-only matches", () => {
    const bones = [
      bone("root/Hand", "Hand", "root"),
      bone("root/Hand Follow", "Hand Follow", "root"),
      bone("root/Right Hand", "Right Hand", "root"),
      bone("root/arm/Finger", "Finger", "root/arm"),
    ];
    expect(rankBoneMatches(bones, "hand").map((item) => item.name)).toEqual(["Hand", "Hand Follow", "Right Hand"]);
    expect(rankBoneMatches(bones, "arm").map((item) => item.name)).toEqual(["Finger"]);
  });
});
