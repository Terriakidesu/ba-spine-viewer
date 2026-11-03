import { describe, expect, test } from "bun:test";
import { BoneData, MeshAttachment, Physics, RegionAttachment, Skeleton, SkeletonData, SlotData } from "@esotericsoftware/spine-core";
import { createProject, normalizeProject, projectStorageKey } from "./editorModel";
import { detectHeadRegion, HEAD_REPAIR_BACKUP, isLegacyPatRegion, repairPatRegions, repairSavedHeadRegions, undoSavedHeadRepair } from "./headRegion";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";

function rig(weighted = false) {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  const head = new BoneData(1, "Head_Rot", root);
  head.x = 500; head.y = 1000;
  const controller = new BoneData(2, "Touch_Point", root);
  controller.y = -500;
  data.bones.push(root, head, controller);
  data.slots.push(new SlotData(0, "facebase_01", weighted ? root : head));
  const skeleton = new Skeleton(data);
  if (weighted) {
    const attachment = new MeshAttachment("face_01", "face_01");
    attachment.worldVerticesLength = 8;
    attachment.bones = [1, 1, 1, 1, 1, 1, 1, 1];
    attachment.vertices = [-100, 0, 1, 100, 0, 1, 100, 200, 1, -100, 200, 1];
    skeleton.slots[0]!.setAttachment(attachment);
  } else {
    const attachment = new RegionAttachment("facebase_01", "facebase_01");
    attachment.offset = [-100, 0, 100, 0, 100, 200, -100, 200];
    skeleton.slots[0]!.setAttachment(attachment);
  }
  skeleton.updateWorldTransform(Physics.pose);
  return skeleton;
}

function legacy() {
  return createProject("test", ["Idle_01", "Pat_01_M", "PatEnd_01_M"], [{ path: "root/Touch_Point", name: "Touch_Point" } as SpineEditorBone]);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
}

describe("Automatic head regions", () => {
  test("uses visible head artwork, never the remote Touch_Point", () => {
    const head = detectHeadRegion(rig())!;
    expect(head.anchorBone).toBe("root/Head_Rot");
    expect(head.offsetX).toBeCloseTo(0);
    expect(head.offsetY).toBeCloseTo(170);
    expect(head.radiusX).toBeCloseTo(100);
    expect(head.radiusY).toBeCloseTo(66);
  });

  test("weighted face meshes find their head through vertex influences, not slot ancestry", () => {
    expect(detectHeadRegion(rig(true))?.anchorBone).toBe("root/Head_Rot");
  });

  test("handles mirrored/rotated/scaled anchors and rejects invisible or singular heads", () => {
    const skeleton = rig();
    const bone = skeleton.bones[1]!;
    bone.scaleX = -2; bone.scaleY = 2; bone.rotation = 90;
    skeleton.updateWorldTransform(Physics.pose);
    const head = detectHeadRegion(skeleton)!;
    const cx = bone.worldX + bone.a * head.offsetX + bone.b * head.offsetY;
    const cy = bone.worldY + bone.c * head.offsetX + bone.d * head.offsetY;
    expect(cx).toBeCloseTo(300);
    expect(cy).toBeCloseTo(1140);
    skeleton.slots[0]!.color.a = 0;
    expect(detectHeadRegion(skeleton)).toBeNull();
    skeleton.slots[0]!.color.a = 1;
    bone.scaleX = 0;
    skeleton.updateWorldTransform(Physics.pose);
    expect(detectHeadRegion(skeleton)).toBeNull();
  });

  test("repairs legacy defaults once, keeping ids, animation phases and movement targets", () => {
    const project = legacy();
    const result = repairPatRegions(project, detectHeadRegion(rig()));
    const before = project.interactions[0]!, after = result.project.interactions[0]!;
    expect(result.repaired).toBe(1);
    expect(after.regions[0]?.anchorBone).toBe("root/Head_Rot");
    expect(after.regions[0]?.id).toBe(before.regions[0]?.id);
    expect(after.startAnimation).toBe(before.startAnimation);
    expect(after.followTargetBone).toBe("root/Touch_Point");
    expect(repairPatRegions(result.project, detectHeadRegion(rig())).repaired).toBe(0);
    expect(normalizeProject(JSON.parse(JSON.stringify(result.project)), "test")?.interactions[0]?.regions[0]?.placement).toBe("head-v1");
  });

  test("custom moved, resized, renamed, rebound, disabled and explicitly manual regions are preserved", () => {
    for (const patch of [{ offsetX: 1 }, { radiusY: 91 }, { name: "My area" }, { anchorBone: "root/Head_Rot" }, { enabled: false }, { placement: "manual" as const }]) {
      const project = legacy();
      Object.assign(project.interactions[0]!.regions[0]!, patch);
      expect(isLegacyPatRegion(project, project.interactions[0]!.regions[0]!)).toBe(false);
      expect(repairPatRegions(project, detectHeadRegion(rig())).repaired).toBe(0);
    }
  });

  test("uncertain defaults are disabled and flagged instead of placed on the torso", () => {
    const result = repairPatRegions(legacy(), null);
    expect(result.unresolved).toBe(1);
    expect(result.project.interactions[0]?.regions[0]?.enabled).toBe(false);
    expect(result.project.interactions[0]?.regions[0]?.placement).toBe("needs-head");
    expect(repairPatRegions(result.project, detectHeadRegion(rig())).repaired).toBe(1);
  });

  test("batch skips unsaved/custom projects without reading assets and supports cancellation", async () => {
    const storage = memoryStorage();
    const project = legacy();
    project.interactions[0]!.regions[0]!.offsetX = 20;
    storage.setItem(projectStorageKey("test"), JSON.stringify(project));
    let loaded = 0;
    const source = { getSetFiles: async () => { loaded++; return new Map<string, File>(); } };
    const result = await repairSavedHeadRegions(source, ["test", "unopened"], new AbortController().signal, () => {}, storage);
    expect(loaded).toBe(0);
    expect(result.kept).toBe(1);
    const abort = new AbortController(); abort.abort();
    expect((await repairSavedHeadRegions(source, ["test"], abort.signal, () => {}, storage)).cancelled).toBe(true);
  });

  test("bulk undo restores only unchanged repairs, preserving subsequent user edits", () => {
    const storage = memoryStorage();
    storage.setItem("one", "fixed"); storage.setItem("two", "user edited");
    storage.setItem(HEAD_REPAIR_BACKUP, JSON.stringify([{ key: "one", before: "original", after: "fixed" }, { key: "two", before: "original two", after: "fixed two" }]));
    expect(undoSavedHeadRepair(storage)).toEqual({ restored: 1, kept: 1 });
    expect(storage.getItem("one")).toBe("original");
    expect(storage.getItem("two")).toBe("user edited");
  });
});
