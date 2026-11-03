import { describe, expect, test } from "bun:test";
import { BoneData, Physics, Skeleton, SkeletonData } from "@esotericsoftware/spine-core";
import { applyInteractionMotion, applyInteractionMotionReturn, beforeInteractionMotion, beginInteractionMotion, beginInteractionMotionReturn, createInteractionMotionState, interactionMotionReturnComplete, interactionMotionReturnProgress } from "./spineInteractionMotion";

describe("Spine interaction motion", () => {
  test("limits headpat movement against the first child bone local Y axis", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const target = new BoneData(1, "Touch_Point", root);
    const next = new BoneData(2, "Touch_Point_Key", target);
    next.rotation = 90;
    data.bones.push(root, target, next);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(Physics.pose);
    const targetBone = skeleton.findBone("Touch_Point")!;
    const nextBone = skeleton.findBone("Touch_Point_Key")!;
    const state = createInteractionMotionState();
    beginInteractionMotion(state, {
      startAnimation: "",
      followTargetBone: "root/Touch_Point",
      sensitivity: 1,
      limitX: 1000,
      limitY: 10,
      smoothing: 1000,
    }, "pat", { x: 0, y: 0 });

    applyInteractionMotion(state, skeleton, { x: 100, y: 0 }, 1);

    expect(targetBone.x).toBeCloseTo(10, 2);
    expect(targetBone.y).toBeCloseTo(0, 2);
    expect(nextBone.worldX).toBeCloseTo(10, 2);
  });

  test("locks local translation axes and rotates within authored limits", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const target = new BoneData(1, "target", root);
    target.rotation = 20;
    data.bones.push(root, target);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(Physics.pose);
    const targetBone = skeleton.findBone("target")!;
    const state = createInteractionMotionState();
    beginInteractionMotion(state, {
      startAnimation: "",
      followTargetBone: "root/target",
      sensitivity: 1,
      limitX: 100,
      limitY: 100,
      smoothing: 1000,
      allowX: true,
      allowY: false,
      rotationEnabled: true,
      rotationAxis: "x",
      rotationMin: -10,
      rotationMax: 30,
    }, "touch", { x: 0, y: 0 });

    applyInteractionMotion(state, skeleton, { x: 50, y: 50 }, 1);

    expect(targetBone.x).toBeCloseTo(50, 2);
    expect(targetBone.y).toBeCloseTo(0, 2);
    expect(targetBone.rotation).toBeCloseTo(35, 2);
    expect(state.rotation).toBeCloseTo(15, 2);
  });

  test("eases translation and rotation back to each frame's animated pose on release", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const target = new BoneData(1, "target", root);
    target.x = 10;
    target.rotation = 5;
    data.bones.push(root, target);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(Physics.pose);
    const targetBone = skeleton.findBone("target")!;
    const state = createInteractionMotionState();
    beginInteractionMotion(state, {
      startAnimation: "start",
      followTargetBone: "root/target",
      sensitivity: 1,
      limitX: 100,
      limitY: 100,
      smoothing: 1000,
      returnDuration: 0.4,
      returnEasing: "ease-out",
      rotationEnabled: true,
      rotationAxis: "x",
      rotationMin: -20,
      rotationMax: 20,
    }, "touch", { x: 0, y: 0 });

    applyInteractionMotion(state, skeleton, { x: 50, y: 0 }, 1);
    expect(targetBone.x).toBeCloseTo(60, 3);
    expect(targetBone.rotation).toBeCloseTo(15, 3);
    beginInteractionMotionReturn(state);

    beforeInteractionMotion(state);
    targetBone.x = 30;
    targetBone.rotation = 20;
    skeleton.updateWorldTransform(Physics.pose);
    applyInteractionMotionReturn(state, skeleton, 0.1);
    expect(interactionMotionReturnProgress(state)).toBeCloseTo(0.25);
    expect(state.offset.x).toBeCloseTo(28.125, 2);
    expect(targetBone.x).toBeCloseTo(58.125, 2);
    expect(targetBone.rotation).toBeCloseTo(25.625, 2);
    expect(interactionMotionReturnComplete(state)).toBe(false);

    beforeInteractionMotion(state);
    targetBone.x = 40;
    targetBone.rotation = 25;
    skeleton.updateWorldTransform(Physics.pose);
    expect(applyInteractionMotionReturn(state, skeleton, 0.3)).toBe(true);
    expect(interactionMotionReturnComplete(state)).toBe(true);
    expect(state.offset).toEqual({ x: 0, y: 0 });
    expect(state.rotation).toBe(0);
    expect(targetBone.x).toBeCloseTo(40, 3);
    expect(targetBone.rotation).toBeCloseTo(25, 3);
  });
});
