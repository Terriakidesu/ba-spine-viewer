import { describe, expect, test } from "bun:test";
import { Animation, AnimationState, AnimationStateData, BoneData, Physics, Skeleton, SkeletonData, TransformConstraintData } from "@esotericsoftware/spine-core";
import { blankInteraction } from "./editorModel";
import { InteractionPreview } from "./preview";
import { SpineRenderer } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { beforeInteractionMotion, beginInteractionMotion, createInteractionMotionState } from "@ba-spine/spine-runtime/spine/spineInteractionMotion";

function fixture() {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  data.bones.push(root, new BoneData(1, "target", root));
  for (const name of ["idle", "start", "follow", "end", "face"]) data.animations.push(new Animation(name, [], 0.2));
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, "idle", true);
  const item = { ...blankInteraction([], [], 0), startAnimation: "start", followAnimation: "follow", endAnimation: "end", faceStartAnimation: "face", followTargetBone: "root/target" };
  const preview = new InteractionPreview();
  const step = (delta: number) => {
    preview.beforeUpdate(); state.update(delta); state.apply(skeleton); skeleton.updateWorldTransform(Physics.pose); preview.update(delta, skeleton, state);
  };
  return { preview, item, state, skeleton, step };
}

describe("Authored interaction preview", () => {
  test("pinching pulls only the grabbed cheek with the pointer, not the shared face target", () => {
    const rigs = [["L_chin_rot", "R_chin_rot"], ["L_Chin_Root", "R_Chin_Root"], ["Chin_L_Root", "Chin_R_Root"], ["cheek_01", "cheek_02"]] as const;
    for (const { leftName, rightName, side } of rigs.flatMap(([leftName, rightName]) => ["L", "R"].map((side) => ({ leftName, rightName, side })))) {
      const data = new SkeletonData();
      const root = new BoneData(0, "root", null);
      const touch = new BoneData(1, "Touch_Point", root);
      const left = new BoneData(2, leftName!, root);
      const right = new BoneData(3, rightName!, root);
      left.x = -100; right.x = 100;
      data.bones.push(root, touch, left, right);
      for (const bone of [left, right]) {
        const constraint = new TransformConstraintData(bone.name);
        constraint.bones.push(bone);
        constraint.target = touch;
        constraint.mixX = constraint.mixY = 0.2;
        data.transformConstraints.push(constraint);
      }
      data.animations.push(new Animation("Pinch_01_M", [], 0.2));
      const skeleton = new Skeleton(data);
      const state = new AnimationState(new AnimationStateData(data));
      const item = { ...blankInteraction([], [], 0), startAnimation: "Pinch_01_M", followAnimation: "Pinch_01_M", followTargetBone: "root/Touch_Point" };
      const preview = new InteractionPreview();
      const step = (dt: number) => {
        preview.beforeUpdate(); state.update(dt); state.apply(skeleton); skeleton.updateWorldTransform(Physics.pose); preview.update(dt, skeleton, state);
      };
      skeleton.updateWorldTransform(Physics.pose);
      const grabbed = skeleton.findBone((side === "L" ? leftName : rightName)!)!;
      const other = skeleton.findBone((side === "L" ? rightName : leftName)!)!;
      const start = { x: grabbed.worldX, y: grabbed.worldY, otherX: other.worldX };
      preview.press(item, "legacy cheek area", start.x, start.y);
      step(0); step(0.25);
      const outward = side === "L" ? -1 : 1;
      preview.move(start.x + outward * 20, start.y + 5);
      for (let i = 0; i < 120; i++) step(1 / 60);
      expect(preview.interaction?.followTargetBone).toBe(`root/${grabbed.data.name}`);
      expect(grabbed.worldX - start.x).toBeCloseTo(outward * 20, 2);
      expect(grabbed.worldY - start.y).toBeCloseTo(5, 2);
      expect(other.worldX).toBeCloseTo(start.otherX, 5);
      expect(skeleton.findBone("Touch_Point")!.x).toBe(0);
      preview.move(start.x + outward * 100000, start.y + 100000);
      for (let i = 0; i < 120; i++) step(1 / 60);
      expect(Math.hypot((grabbed.worldX - start.x) / 90, (grabbed.worldY - start.y) / 65)).toBeLessThanOrEqual(1.00001);
      preview.move(start.x - outward * 100000, start.y);
      for (let i = 0; i < 120; i++) step(1 / 60);
      expect(grabbed.worldX).toBeCloseTo(start.x, 2);
      expect(grabbed.worldY).toBeCloseTo(start.y, 2);
      preview.release(); step(0.01); step(0.4);
      expect(grabbed.worldX).toBeCloseTo(start.x, 5);
      expect(skeleton.transformConstraints.every((constraint) => constraint.mixX === 0.2 && constraint.mixY === 0.2)).toBe(true);
      expect(item.followTargetBone).toBe("root/Touch_Point");
      expect(item.sensitivity).toBe(0.25);
    }
  });

  test("runs press, held loop and release with a simultaneous face track over idle", () => {
    const { preview, item, state, step } = fixture();
    preview.press(item, "head", 0, 0); step(0);
    expect(preview.phase).toBe("starting");
    expect(state.getCurrent(1)?.animation?.name).toBe("start");
    expect(state.getCurrent(2)?.animation?.name).toBe("face");
    expect(state.getCurrent(0)?.animation?.name).toBe("idle");
    preview.move(30, 0);
    step(0.05);
    expect(preview.phase).toBe("starting");
    expect(preview.debug.offsetX).toBeGreaterThan(0);
    step(0.2);
    expect(preview.phase).toBe("holding");
    expect(state.getCurrent(1)?.loop).toBe(true);
    expect(state.getCurrent(1)?.animation?.name).toBe("follow");
    const beforeRelease = preview.debug.offsetX;
    preview.release(); step(0.01); step(0.05);
    expect(preview.phase).toBe("releasing");
    expect(state.getCurrent(1)?.animation?.name).toBe("end");
    expect(preview.debug.returning).toBe(true);
    expect(preview.debug.offsetX).toBeLessThan(beforeRelease);
    expect(preview.debug.offsetX).toBeGreaterThan(0);
    step(0.4);
    expect(preview.phase).toBe("idle");
    expect(preview.debug.offsetX).toBe(0);
    expect(state.getCurrent(1)).toBeNull();
  });

  test("Editor test and Viewer playback apply identical authored follow motion", () => {
    const editor = fixture();
    const viewerData = new SkeletonData();
    const viewerRoot = new BoneData(0, "root", null);
    const viewerTarget = new BoneData(1, "target", viewerRoot);
    viewerData.bones.push(viewerRoot, viewerTarget);
    for (const name of ["idle", "start", "follow", "end"]) viewerData.animations.push(new Animation(name, [], 0.2));
    const viewerSkeleton = new Skeleton(viewerData);
    const viewerState = new AnimationState(new AnimationStateData(viewerData));
    viewerState.setAnimation(0, "idle", true);
    const viewerMotion = createInteractionMotionState();
    const pointerOrigin = { x: 0, y: 0 };
    let pointer = { x: 0, y: 0 };
    const viewer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { skeleton: viewerSkeleton, touchTarget: null },
      interactionState: "touchStart",
      pointerWorld: () => pointer,
      interactionMotionState: viewerMotion,
    }) as any;
    beginInteractionMotion(viewerMotion, editor.item, "touch", pointerOrigin);
    editor.preview.press(editor.item, "head", pointerOrigin.x, pointerOrigin.y);

    for (const delta of [0, 1 / 60, 1 / 30, 0.08, 0.1]) {
      editor.preview.beforeUpdate();
      editor.state.update(delta);
      editor.state.apply(editor.skeleton);
      editor.skeleton.updateWorldTransform(Physics.pose);
      editor.preview.update(delta, editor.skeleton, editor.state);

      beforeInteractionMotion(viewerMotion);
      viewerState.update(delta);
      viewerState.apply(viewerSkeleton);
      viewerSkeleton.updateWorldTransform(Physics.pose);
      viewer.applyTouchFollow(delta);
      expect(viewerMotion.offset.x).toBeCloseTo(editor.preview.debug.offsetX, 8);
      expect(viewerMotion.offset.y).toBeCloseTo(editor.preview.debug.offsetY, 8);
      expect(viewerSkeleton.findBone("target")!.x).toBeCloseTo(editor.skeleton.findBone("target")!.x, 8);
      expect(viewerSkeleton.findBone("target")!.y).toBeCloseTo(editor.skeleton.findBone("target")!.y, 8);
      pointer = { x: 35, y: 14 };
      editor.preview.move(pointer.x, pointer.y);
    }
  });

  test("early release, missing phases, press triggers and cancellation cannot leave a held track", () => {
    for (const trigger of ["hold", "press", "drag"] as const) {
      const { preview, item, state, step } = fixture();
      preview.press({ ...item, trigger, followAnimation: "missing", endAnimation: "" }, "head", 0, 0);
      preview.release(); step(0); step(0.25); step(0.25); step(0.2);
      expect(preview.phase).toBe("idle");
      expect(state.getCurrent(1)).toBeNull();
    }
  });

  test("pointer exit drops the follow pose without ending the held interaction", () => {
    const { preview, item, skeleton, step } = fixture();
    preview.press(item, "head", 0, 0);
    step(0);
    preview.move(40, 0);
    step(0.25);
    const offset = preview.debug.offsetX;
    expect(offset).toBeGreaterThan(0);
    expect(skeleton.findBone("target")!.x).toBeCloseTo(offset, 3);

    preview.leave();
    step(0.1);
    expect(preview.debug.held).toBe(true);
    expect(preview.debug.offsetX).toBeCloseTo(offset, 8);
    expect(skeleton.findBone("target")!.x).toBeCloseTo(0, 8);

    preview.move(20, 0);
    step(0.1);
    expect(skeleton.findBone("target")!.x).toBeGreaterThan(0);
    preview.release();
    step(0.01);
    step(0.5);
    expect(preview.phase).toBe("idle");
    expect(skeleton.findBone("target")!.x).toBeCloseTo(0, 8);
  });

  test("smoothly returns the follow target even when no End animation is assigned", () => {
    const { preview, item, skeleton, step } = fixture();
    preview.press({ ...item, endAnimation: "", returnDuration: 0.4, returnEasing: "linear" }, "head", 0, 0);
    step(0);
    preview.move(40, 0);
    step(0.25);
    const target = skeleton.findBone("target")!;
    const beforeRelease = target.x;
    expect(preview.phase).toBe("holding");
    expect(beforeRelease).toBeGreaterThan(0);

    preview.release();
    step(0.1);
    expect(preview.phase).toBe("releasing");
    expect(target.x).toBeCloseTo(beforeRelease, 4);
    step(0.1);
    expect(target.x).toBeGreaterThan(0);
    expect(target.x).toBeLessThan(beforeRelease);
    step(0.3);
    expect(preview.phase).toBe("idle");
    expect(target.x).toBe(0);
  });

  test("movement is bounded, smoothed and does not accumulate in an unkeyed target", () => {
    const { preview, item, skeleton, step } = fixture();
    preview.press(item, "head", 0, 0); step(0); step(0.25);
    preview.move(100000, 100000); step(1 / 60);
    const target = skeleton.findBone("target")!;
    const firstX = target.x;
    expect(firstX).toBeGreaterThan(0);
    expect(firstX).toBeLessThan(item.limitX);
    for (let i = 0; i < 120; i++) step(1 / 60);
    expect(Math.hypot(target.x / item.limitX, target.y / item.limitY)).toBeLessThanOrEqual(1.00001);
    preview.release(); step(0.01); step(0.4);
    expect(target.x).toBe(0);
    expect(target.y).toBe(0);
  });

  test("press trigger plays once without entering the held loop", () => {
    const { preview, item, step } = fixture();
    preview.press({ ...item, trigger: "press" }, "head", 0, 0); step(0); step(0.25);
    expect(preview.phase).toBe("releasing");
    step(0.4);
    expect(preview.phase).toBe("idle");
  });

  test("drag trigger waits for movement and a click alone does not start it", () => {
    const { preview, item, state, step } = fixture();
    preview.press({ ...item, trigger: "drag" }, "head", 0, 0); step(0.1);
    expect(preview.phase).toBe("idle");
    expect(state.getCurrent(1)).toBeNull();
    preview.move(20, 0); step(0.01);
    expect(preview.phase).toBe("starting");
    preview.reset(state);
    preview.press({ ...item, trigger: "drag" }, "head", 0, 0); preview.release(); step(0.1);
    expect(preview.phase).toBe("idle");
    expect(preview.interaction).toBeNull();
  });

  test("exposes phase, track, target, and movement state for the editor debugger", () => {
    const { preview, item, step } = fixture();
    preview.press({ ...item, name: "Debugger test", trigger: "hold" }, "head", 0, 0);
    step(0);
    expect(preview.debug).toMatchObject({
      phase: "starting",
      interactionName: "Debugger test",
      regionName: "head",
      trigger: "hold",
      bodyAnimation: "start",
      faceAnimation: "face",
      held: true,
      targetBonePath: "root/target",
    });
    preview.move(20, 5);
    step(0.25);
    expect(preview.debug.phase).toBe("holding");
    expect(preview.debug.bodyAnimation).toBe("follow");
    expect(preview.debug.offsetX).not.toBe(0);
    preview.release();
  });
});
