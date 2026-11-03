import { describe, expect, test } from "bun:test";
import { BlendMode, BoneData, Skeleton, SkeletonData, SlotData } from "@esotericsoftware/spine-core";
import { drawWithEffectsStrength } from "./spineEffects";

function scene() {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  data.bones.push(root);
  for (const mode of [BlendMode.Normal, BlendMode.Additive, BlendMode.Screen, BlendMode.Multiply]) {
    const slot = new SlotData(data.slots.length, String(mode), root);
    slot.blendMode = mode;
    data.slots.push(slot);
  }
  const skeleton = new Skeleton(data);
  skeleton.slots.forEach((slot) => { slot.color.a = 0.8; });
  return skeleton;
}

describe("light effect strength", () => {
  test("only attenuates additive/screen layers, then restores the animated pose", () => {
    const skeleton = scene();
    for (let frame = 0; frame < 3; frame += 1) {
      drawWithEffectsStrength(skeleton, 0.5, () => {
        expect(skeleton.slots.map((slot) => slot.color.a)).toEqual([0.8, 0.4, 0.4, 0.8]);
      });
      expect(skeleton.slots.map((slot) => slot.color.a)).toEqual([0.8, 0.8, 0.8, 0.8]);
    }
  });

  test("restores alpha after a render failure", () => {
    const skeleton = scene();
    expect(() => drawWithEffectsStrength(skeleton, 0, () => { throw new Error("draw failed"); })).toThrow("draw failed");
    expect(skeleton.slots.map((slot) => slot.color.a)).toEqual([0.8, 0.8, 0.8, 0.8]);
  });

  test("supports unmodified authored lighting and disabling light contributions", () => {
    const skeleton = scene();
    drawWithEffectsStrength(skeleton, 1, () => {
      expect(skeleton.slots.map((slot) => slot.color.a)).toEqual([0.8, 0.8, 0.8, 0.8]);
    });
    drawWithEffectsStrength(skeleton, 0, () => {
      expect(skeleton.slots.map((slot) => slot.color.a)).toEqual([0.8, 0, 0, 0.8]);
    });
  });
});
