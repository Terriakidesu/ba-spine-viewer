import { describe, expect, test } from "bun:test";
import { Animation, AnimationState, AnimationStateData, BoneData, Event, EventData, EventTimeline, Skeleton, SkeletonData, TranslateTimeline } from "@esotericsoftware/spine-core";
import { defaultSpineAnimation, findIdleAnimation, findIntroAnimation, INTRO_ANIMATION, SpineRenderer, talkEventTimes } from "./spineRuntime";
import { normalizeSpineInteractionProject } from "./spineInteraction";

test("authored talks sample both moving body and face while preserving interaction tracks", () => {
  const data = new SkeletonData();
  data.bones.push(new BoneData(0, "root", null), new BoneData(1, "face", null));
  const body = new TranslateTimeline(2, 0, 0);
  body.setFrame(0, 0, 0, 0);
  body.setFrame(1, 2, 20, 0);
  const face = new TranslateTimeline(2, 0, 1);
  face.setFrame(0, 0, 0, 0);
  face.setFrame(1, 2, 0, 40);
  data.animations.push(new Animation("Idle_01", [], 3), new Animation("Talk_01_M", [body], 2), new Animation("Talk_01_A", [face], 2));
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
    bundle: { skeleton, state, meta: { idleAnimation: "Idle_01", introAnimation: null } },
    restoreInteractionPose: () => {},
    motionState: () => ({ target: null }),
  }) as SpineRenderer;
  renderer.sampleEditorAnimation("Talk_01_M", "Talk_01_A", 0.5, false, true, true);
  expect(skeleton.bones[0]!.x).toBeCloseTo(5);
  expect(skeleton.bones[1]!.y).toBeCloseTo(10);
  expect(state.getCurrent(0)?.animation?.name).toBe("Idle_01");
  expect(state.getCurrent(9)?.animation?.name).toBe("Talk_01_M");
  expect(state.getCurrent(10)?.animation?.name).toBe("Talk_01_A");
  renderer.sampleEditorAnimation("Talk_01_M", "Talk_01_A", 0.5, false, true, true, 0.5, 0.25, 2.5);
  expect(state.getCurrent(0)?.trackTime).toBe(2.5);
  expect(state.getCurrent(9)?.trackTime).toBe(0.5);
  renderer.sampleEditorAnimation("Talk_01_M", "Talk_01_A", 0.5, false, true, true, 0.5, 0.25);
  expect(state.getCurrent(0)?.alpha).toBe(1);
  expect(state.getCurrent(9)?.alpha).toBe(0.5);
  expect(state.getCurrent(10)?.alpha).toBe(0.25);
  renderer.sampleEditorAnimation("Talk_01_M", "Talk_01_A", 1.5, false, true, true);
  expect(skeleton.bones[0]!.x).toBeCloseTo(15);
  expect(skeleton.bones[1]!.y).toBeCloseTo(30);
  expect(state.getCurrent(10)?.animation?.name).toBe("Talk_01_A");
  renderer.sampleEditorAnimation("Idle_01", "", 0, true, false, true);
  expect(state.getCurrent(7)).toBeNull();
  expect(state.getCurrent(8)).toBeNull();
  expect(state.getCurrent(9)).toBeNull();
  expect(state.getCurrent(10)).toBeNull();
  expect(state.getCurrent(2)).toBeNull();
});

test("an authored Talk transition keeps the underlying idle clock running", () => {
  const data = new SkeletonData();
  data.bones.push(new BoneData(0, "root", null));
  data.animations.push(
    new Animation("Idle_01", [], 3),
    new Animation("Talk_01_M", [], 2),
    new Animation("Talk_02_M", [], 2),
  );
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
    bundle: { skeleton, state, meta: { idleAnimation: "Idle_01", introAnimation: null } },
    restoreInteractionPose: () => {},
    motionState: () => ({ target: null }),
  }) as SpineRenderer;

  renderer.sampleEditorAnimation("Talk_01_M", "", 1.9, false, true, true, 1, 1, 2.5);
  expect(state.getCurrent(0)?.trackTime).toBeCloseTo(2.5);
  expect(state.getCurrent(9)?.animation?.name).toBe("Talk_01_M");
  renderer.sampleEditorAnimation("Talk_02_M", "", 0, false, true, true, 0, 0, 2.6);

  expect(state.getCurrent(0)?.trackTime).toBeCloseTo(2.6);
  expect(state.getCurrent(9)?.animation?.name).toBe("Talk_02_M");
  expect(state.getCurrent(9)?.alpha).toBe(0);
});

test("auto-play starts the next Talk by crossfading from the finished Talk tracks", () => {
  const data = new SkeletonData();
  data.bones.push(new BoneData(0, "root", null));
  data.animations.push(
    new Animation("Talk_01_M", [], 2),
    new Animation("Talk_01_A", [], 2),
    new Animation("Talk_02_M", [], 2),
    new Animation("Talk_02_A", [], 2),
  );
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(5, "Talk_01_M", false);
  state.setAnimation(6, "Talk_01_A", false);
  const skeleton = new Skeleton(data);
  state.apply(skeleton);
  const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
    interactionMode: "interaction",
    interactionReady: true,
    bundle: {
      skeleton,
      state,
      project: { talkMixDuration: 0.4 },
      interaction: { talks: [
        { main: "Talk_01_M", face: "Talk_01_A" },
        { main: "Talk_02_M", face: "Talk_02_A" },
      ] },
    },
    interactionState: "talk",
    interactionTrackName: "Talk_01_M",
    talkIndex: 1,
    activeTalkIndex: 0,
    talkEventIndex: 0,
    talkAudioPending: false,
    talkFadeQueued: true,
    callbacks: { onTalk: () => true },
    eyeFollowHold: 0,
    resetInteractionTargets: () => undefined,
  }) as SpineRenderer;

  renderer.triggerTalk("Talk_02_M");

  const main = state.getCurrent(5)!;
  const face = state.getCurrent(6)!;
  expect(main.animation?.name).toBe("Talk_02_M");
  expect(main.mixDuration).toBe(0.4);
  expect(main.mixingFrom?.animation?.name).toBe("Talk_01_M");
  expect(face.animation?.name).toBe("Talk_02_A");
  expect(face.mixingFrom?.animation?.name).toBe("Talk_01_A");
  expect(renderer.isTalkActive()).toBe(true);
});

function playback(selection: string) {
  const data = new SkeletonData();
  data.bones.push(new BoneData(0, "root", null));
  data.animations.push(new Animation("Start_Idle_01", [], 2), new Animation("Idle_01", [], 4));
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, "Idle_01", true).trackTime = 3;
  const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
    playing: false,
    loop: true,
    animationSelection: selection,
    bundle: {
      state,
      skeleton: new Skeleton(data),
      meta: { introAnimation: "Start_Idle_01", idleAnimation: "Idle_01" },
    },
  }) as SpineRenderer;
  return { renderer, state };
}

function lookPlayback(endAnimation: string | null = "LookEnd_01_M") {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  data.bones.push(root, new BoneData(1, "Touch_Eye_Key", root));
  data.animations.push(new Animation("Look_01_M", [], 1));
  if (endAnimation) data.animations.push(new Animation(endAnimation, [], 0.4));
  const animatedIdleTarget = new TranslateTimeline(2, 0, 1);
  animatedIdleTarget.setFrame(0, 0, 20, 0);
  animatedIdleTarget.setFrame(1, 1, 20, 0);
  data.animations.push(new Animation("Animated_Idle", [animatedIdleTarget], 1));
  const skeleton = new Skeleton(data);
  const rootBone = skeleton.bones[0]!;
  const eyeBone = skeleton.bones[1]!;
  eyeBone.x = 80;
  const eyeTarget = { bone: eyeBone, baseX: 0, baseY: 0, rangeX: 100, rangeY: 100 };
  const state = new AnimationState(new AnimationStateData(data));
  const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
    interactionMode: "interaction",
    interactionState: "look",
    interactionTrackName: "Look_01_M",
    interactionFollowWorld: { x: 80, y: 0 },
    interactionFollowLocal: { x: 80, y: 0 },
    eyeFollowHold: 1,
    bundle: {
      skeleton,
      state,
      eyeTarget,
      touchTarget: null,
      lookFollow: { enabled: true, smoothing: 10, allowX: true, allowY: true },
      interaction: {
        look: endAnimation ? {
          start: { main: "Look_01_M", face: null },
          end: { main: endAnimation, face: null },
        } : null,
      },
    },
  }) as SpineRenderer;
  return { renderer, state, skeleton, rootBone, eyeBone };
}

describe("Spine restart playback", () => {
  test("recognizes the alternate Konoka idle name", () => {
    expect(findIntroAnimation(["Dummy", "Start_Idle_01", "Idle"])).toBe("Start_Idle_01");
    expect(findIdleAnimation(["Dummy", "Start_Idle_01", "Idle"])).toBe("Idle");
  });

  test("prefers the normal idle when a set also has idle variants", () => {
    expect(findIntroAnimation(["Start_Idle_1", "Idle_01", "Idle_01_R"])).toBe("Start_Idle_1");
    expect(findIdleAnimation(["Start_Idle_1", "Idle_01", "Idle_01_R"])).toBe("Idle_01");
    expect(findIntroAnimation(["Dev/Dev_Start_Idle_01", "Idle_01"])).toBeNull();
  });

  test("never promotes LookEnd or other interaction clips to the default idle", () => {
    const animations = ["LookEnd_01_M", "Talk_01_M", "Pat_01"];
    expect(findIdleAnimation(animations)).toBeNull();
    expect(defaultSpineAnimation(animations)).toBe("");
    expect(defaultSpineAnimation(["Start_Idle_01", "LookEnd_01_M", "Idle_02"])).toBe(INTRO_ANIMATION);
    expect(findIdleAnimation(["Idle_LookEnd_01", "Idle_01_M"])).toBe("Idle_01_M");
  });

  test("look release preserves the gaze target and eases it home through LookEnd", () => {
    const { renderer, state, eyeBone } = lookPlayback();
    const runtime = renderer as any;

    runtime.endLook();
    expect(runtime.interactionState).toBe("lookRelease");
    expect(state.getCurrent(1)?.animation?.name).toBe("LookEnd_01_M");
    expect(eyeBone.x).toBe(80);

    runtime.finishInteractionState();
    expect(runtime.interactionState).toBe("lookRelease");
    runtime.resetEyeFollowTargetForAnimation(runtime.bundle);
    runtime.applyEyeFollow(0.05, null);
    expect(eyeBone.x).toBeGreaterThan(0);
    expect(eyeBone.x).toBeLessThan(80);

    state.getCurrent(1)!.trackTime = state.getCurrent(1)!.animation!.duration;
    runtime.finishInteractionState();
    expect(runtime.interactionState).toBe("lookRelease");
    for (let index = 0; index < 120; index++) {
      runtime.resetEyeFollowTargetForAnimation(runtime.bundle);
      runtime.applyEyeFollow(1 / 60, null);
    }
    expect(eyeBone.x).toBeCloseTo(0);
    runtime.finishInteractionState();
    expect(runtime.interactionState).toBe("idle");
  });

  test("look without an end clip still returns smoothly before becoming idle", () => {
    const { renderer, eyeBone } = lookPlayback(null);
    const runtime = renderer as any;

    runtime.endLook();
    expect(runtime.interactionState).toBe("lookRelease");
    expect(runtime.interactionTrackName).toBeNull();
    expect(eyeBone.x).toBe(80);
    runtime.finishInteractionState();
    expect(runtime.interactionState).toBe("lookRelease");

    for (let index = 0; index < 120; index++) {
      runtime.resetEyeFollowTargetForAnimation(runtime.bundle);
      runtime.applyEyeFollow(1 / 60, null);
    }
    runtime.finishInteractionState();
    expect(eyeBone.x).toBeCloseTo(0);
    expect(runtime.interactionState).toBe("idle");
  });

  test("look release eases its offset over the animated pose and accepts another trigger", () => {
    const { renderer, state, skeleton, rootBone, eyeBone } = lookPlayback();
    const runtime = renderer as any;

    state.setAnimation(0, "Animated_Idle", true);
    runtime.resetEyeFollowTargetForAnimation(runtime.bundle);
    state.apply(skeleton);
    skeleton.updateWorldTransform(0 as never);
    runtime.applyEyeFollow(1 / 60, { x: 80, y: 0, z: 0 });
    expect(eyeBone.x).toBeCloseTo(80);
    expect(runtime.interactionFollowLocal.x).toBeCloseTo(60);

    runtime.endLook();
    state.getCurrent(1)!.trackTime = state.getCurrent(1)!.animation!.duration;
    for (let index = 0; index < 120; index++) {
      rootBone.x = index * 2;
      rootBone.rotation = index * 0.5;
      state.update(1 / 60);
      runtime.resetEyeFollowTargetForAnimation(runtime.bundle);
      state.apply(skeleton);
      skeleton.updateWorldTransform(0 as never);
      runtime.applyEyeFollow(1 / 60, null);
      runtime.finishInteractionState();
      if (runtime.interactionState === "idle") break;
    }

    const finalReleaseX = eyeBone.x;
    expect(Math.abs(finalReleaseX - 20)).toBeLessThanOrEqual(0.01);
    expect(runtime.interactionState).toBe("idle");
    expect(runtime.isInteractionBusy()).toBe(false);

    state.update(1 / 60);
    state.apply(skeleton);
    skeleton.updateWorldTransform(0 as never);
    expect(Math.abs(eyeBone.x - finalReleaseX)).toBeLessThanOrEqual(0.01);

    runtime.beginLook();
    expect(runtime.interactionState).toBe("look");
    expect(runtime.isInteractionBusy()).toBe(true);
  });

  test("restarts the intro after the queued idle has already begun", () => {
    const { renderer, state } = playback(INTRO_ANIMATION);
    renderer.restartPlayback();
    const entry = state.getCurrent(0)!;
    expect(entry.animation?.name).toBe("Start_Idle_01");
    expect(entry.trackTime).toBe(0);
    expect(entry.loop).toBe(false);
    expect(entry.next?.animation?.name).toBe("Idle_01");
    expect(entry.next?.loop).toBe(true);
  });

  test("restarts an unchanged standalone selection instead of ignoring it", () => {
    const { renderer, state } = playback("Idle_01");
    renderer.restartPlayback();
    expect(state.getCurrent(0)?.animation?.name).toBe("Idle_01");
    expect(state.getCurrent(0)?.trackTime).toBe(0);
    expect(state.getCurrent(0)?.next).toBeNull();
  });

  test("keeps a talk interaction active until chained audio reports completion", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("Talk_01_M", [], 1));
    const state = new AnimationState(new AnimationStateData(data));
    const entry = state.setAnimation(5, "Talk_01_M", false);
    entry.trackTime = 1;
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { state, skeleton: new Skeleton(data) },
      interactionState: "talk",
      interactionTrackName: "Talk_01_M",
      talkAudioPending: true,
      talkFadeQueued: false,
    }) as any;

    renderer.finishInteractionState();
    expect(renderer.interactionState).toBe("talk");
    renderer.setTalkAudioPending(false);
    expect(renderer.interactionState).toBe("talk");
    state.update(0.1);
    state.apply(renderer.bundle.skeleton);
    renderer.finishInteractionState();
    expect(renderer.interactionState).toBe("talk");
    state.update(0.1);
    state.apply(renderer.bundle.skeleton);
    renderer.finishInteractionState();
    expect(renderer.interactionState).toBe("talk");
    state.update(0.1);
    state.apply(renderer.bundle.skeleton);
    renderer.finishInteractionState();
    expect(renderer.interactionState).toBe("idle");
    expect(renderer.talkAudioPending).toBe(false);
  });

  test("reports a talk as active until its animation state finishes", () => {
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), { interactionState: "talk" }) as any;
    expect(renderer.isTalkActive()).toBe(true);
    renderer.interactionState = "idle";
    expect(renderer.isTalkActive()).toBe(false);
  });

  test("does not queue the talk fade while audio is active", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("Talk_01_M", [], 1));
    const state = new AnimationState(new AnimationStateData(data));
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: {
        state,
        skeleton: new Skeleton(data),
        interaction: { talks: [{ main: "Talk_01_M", face: null }] },
      },
      callbacks: { onTalk: () => true },
      interactionMode: "interaction",
      interactionState: "idle",
      interactionReady: true,
      talkIndex: 0,
    }) as any;

    renderer.triggerTalk();
    expect(renderer.interactionState).toBe("talk");
    expect(renderer.talkAudioPending).toBe(true);
    expect(renderer.talkFadeQueued).toBe(false);
    expect(state.getCurrent(5)?.next).toBeNull();
  });

  test("extracts only authored Talk event markers in timeline order", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    const timeline = new EventTimeline(3);
    timeline.setFrame(0, new Event(1.2, new EventData("Other")));
    timeline.setFrame(1, new Event(3.4, new EventData("Talk")));
    timeline.setFrame(2, new Event(2.1, new EventData("talk")));
    const animation = new Animation("Talk_01_M", [timeline], 4);
    expect(talkEventTimes(animation)).toEqual([2.1, 3.4]);
  });

  test("uses Talk markers paired with the requested Sound clip and falls back to Sound markers", () => {
    const paired = new EventTimeline(4);
    paired.setFrame(0, new Event(0.2, new EventData("Sound/CH0001_MemorialLobby_0_1")));
    paired.setFrame(1, new Event(0.2, new EventData("Talk")));
    paired.setFrame(2, new Event(1.2, new EventData("Sound/CH0001_MemorialLobby_3")));
    paired.setFrame(3, new Event(1.2, new EventData("Talk")));
    expect(talkEventTimes(new Animation("Talk_03_M", [paired], 2), 3)).toEqual([1.2]);

    const soundOnly = new EventTimeline(2);
    soundOnly.setFrame(0, new Event(0.4, new EventData("Sound/CH0002_MemorialLobby_1_1")));
    soundOnly.setFrame(1, new Event(1.4, new EventData("Sound/CH0002_MemorialLobby_1_2")));
    expect(talkEventTimes(new Animation("Talk_01_M", [soundOnly], 2), 1)).toEqual([0.4, 1.4]);
  });

  test("deduplicates adjacent-frame Talk markers for one clip", () => {
    const timeline = new EventTimeline(3);
    timeline.setFrame(0, new Event(1, new EventData("Talk")));
    timeline.setFrame(1, new Event(2, new EventData("Talk")));
    timeline.setFrame(2, new Event(2.033, new EventData("Talk")));
    expect(talkEventTimes(new Animation("Talk_04_M", [timeline], 3))).toEqual([1, 2]);
  });

  test("starts voice clips when the Talk events reach the mouth timeline", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    const timeline = new EventTimeline(2);
    timeline.setFrame(0, new Event(0.5, new EventData("Talk")));
    timeline.setFrame(1, new Event(1.1, new EventData("Talk")));
    data.animations.push(new Animation("Talk_01_M", [timeline], 1.5));
    const state = new AnimationState(new AnimationStateData(data));
    const skeleton = new Skeleton(data);
    const clips: number[] = [];
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: {
        state,
        skeleton,
        interaction: { talks: [{ main: "Talk_01_M", face: null }] },
      },
      callbacks: {
        onTalk: () => true,
        onTalkClip: (_index: number, clipIndex: number) => clips.push(clipIndex),
      },
      interactionMode: "interaction",
      interactionState: "idle",
      interactionReady: true,
      talkIndex: 0,
    }) as any;

    renderer.triggerTalk();
    expect(clips).toEqual([]);
    state.update(0.49);
    state.apply(skeleton);
    expect(clips).toEqual([]);
    state.update(0.02);
    state.apply(skeleton);
    expect(clips).toEqual([0]);
    state.update(0.6);
    state.apply(skeleton);
    expect(clips).toEqual([0, 1]);
  });

  test("starts the intro voice from MemorialLobby_0 markers", () => {
    const timeline = new EventTimeline(1);
    timeline.setFrame(0, new Event(0.4, new EventData("Sound/CH0001_MemorialLobby_0")));
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("Start_Idle_01", [timeline], 1), new Animation("Idle_01", [], 2));
    const state = new AnimationState(new AnimationStateData(data));
    state.setAnimation(0, "Start_Idle_01", false);
    const skeleton = new Skeleton(data);
    const clips: number[] = [];
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { state, skeleton, meta: { introAnimation: "Start_Idle_01", idleAnimation: "Idle_01" } },
      callbacks: { onIntro: () => true, onIntroClip: (clipIndex: number) => clips.push(clipIndex) },
      introAudioEntry: null,
      introEventIndex: 0,
    }) as any;

    renderer.startIntroAudio();
    state.update(0.39);
    state.apply(skeleton);
    expect(clips).toEqual([]);
    state.update(0.02);
    state.apply(skeleton);
    expect(clips).toEqual([0]);
  });

test("Talk requests cannot interrupt an active talk", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("Talk_01_M", [], 1), new Animation("Talk_02_M", [], 1));
    const state = new AnimationState(new AnimationStateData(data));
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { state, skeleton: new Skeleton(data), interaction: { talks: [{ main: "Talk_01_M", face: null }, { main: "Talk_02_M", face: null }] } },
      callbacks: { onTalk: () => false },
      interactionMode: "interaction",
      interactionState: "talk",
      interactionTrackName: "Talk_01_M",
      interactionReady: true,
      talkIndex: 1,
      activeTalkIndex: 0,
      talkAudioPending: true,
      talkFadeQueued: false,
    }) as any;
    state.setAnimation(5, "Talk_01_M", false);

    renderer.triggerTalk();
    renderer.triggerTalk("Talk_02_M");

    expect(state.getCurrent(5)?.animation?.name).toBe("Talk_01_M");
    expect(renderer.interactionState).toBe("talk");
    expect(renderer.activeTalkIndex).toBe(0);
    expect(renderer.talkIndex).toBe(1);
  });

  test("timeline sequence changes cancel overlays and opening/Talk sequences take input precedence", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(
      new Animation("Idle_01", [], 2),
      new Animation("Start_Idle_01", [], 1),
      new Animation("Talk_01_M", [], 1),
      new Animation("Pat_01_M", [], 1),
    );
    const skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { state, skeleton, meta: { introAnimation: "Start_Idle_01", idleAnimation: "Idle_01" } },
      interactionMode: "interaction",
      interactionState: "pat",
      interactionTrackName: "Pat_01_M",
      interactionReady: true,
      interactionPointerHeld: true,
      interactionPointerId: 7,
      interactionPressedTarget: { kind: "pat" },
      activeGestureInteractionId: "pat-id",
    }) as any;
    state.setAnimation(3, "Pat_01_M", true);

    renderer.sampleEditorAnimation("Start_Idle_01", "", 0, false, false, true, 1, 1, 0, "opening");
    expect(renderer.interactionState).toBe("idle");
    expect(renderer.interactionReady).toBe(false);
    expect(renderer.interactionPointerHeld).toBe(false);
    expect(state.getCurrent(3)).toBeNull();
    renderer.interactionPointerHeld = true;
    renderer.interactionPressedTarget = { kind: "pat" };
    renderer.beginPressedGesture();
    expect(renderer.interactionState).toBe("idle");

    renderer.sampleEditorAnimation("Idle_01", "", 0, true, false, true, 1, 1, 0, "opening");
    expect(renderer.interactionReady).toBe(true);

    state.setAnimation(3, "Pat_01_M", true);
    renderer.interactionState = "pat";
    renderer.interactionPointerHeld = true;
    renderer.sampleEditorAnimation("Talk_01_M", "", 0, false, false, true, 1, 1, 0, "talk-1");
    expect(renderer.interactionState).toBe("idle");
    expect(renderer.interactionPointerHeld).toBe(false);
    expect(state.getCurrent(3)).toBeNull();
    renderer.interactionPointerHeld = true;
    renderer.interactionPressedTarget = { kind: "pat" };
    renderer.beginPressedGesture();
    expect(renderer.interactionState).toBe("idle");
    expect(renderer.isInteractionBusy()).toBe(false);
  });

  test("pointer exit releases a captured interaction so later presses are not blocked", () => {
    const released: string[] = [];
    const captured = Object.assign(Object.create(SpineRenderer.prototype), {
      interactionMode: "interaction",
      interactionPointerId: 4,
      interactionPointerHeld: true,
      interactionPointer: { x: 20, y: 30 },
      interactionPressedBehaviorRegionId: "head",
      pointerInside: true,
      eyeFollowHold: 0.5,
      interactionReady: false,
      canvas: {
        hasPointerCapture: () => true,
        releasePointerCapture: (pointerId: number) => released.push(`capture-release:${pointerId}`),
        setPointerCapture: (pointerId: number) => released.push(`capture-set:${pointerId}`),
      },
      dispatchBehaviorEvent: (event: string) => released.push(event),
      endGesture: () => released.push("gesture"),
      endLook: () => released.push("look"),
    }) as any;
    captured.handlePointerLeave({ pointerId: 4 });
    expect(captured.pointerInside).toBe(false);
    expect(captured.interactionPointer).toBeNull();
    expect(captured.interactionPointerHeld).toBe(false);
    expect(captured.interactionPointerId).toBeNull();
    expect(released).toEqual(["pointer-leave", "gesture", "look", "capture-release:4"]);

    captured.handlePointerDown({ button: 0, pointerId: 5 });
    expect(captured.interactionPointerHeld).toBe(true);
    expect(captured.interactionPointerId).toBe(5);

    const canceled = Object.assign(Object.create(SpineRenderer.prototype), {
      interactionMode: "interaction",
      interactionPointerId: 4,
      interactionPointerHeld: true,
      interactionPointer: { x: 20, y: 30 },
      pointerInside: true,
      canvas: {
        getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
        hasPointerCapture: () => true,
        releasePointerCapture: () => released.push("capture"),
      },
      endGesture: () => released.push("gesture"),
      endLook: () => released.push("look"),
    }) as any;
    canceled.handlePointerUp({ pointerId: 9, clientX: 50, clientY: 50 });
    expect(canceled.interactionPointerHeld).toBe(true);
    canceled.handlePointerUp({ pointerId: 4, clientX: 150, clientY: 50 });
    expect(canceled.interactionPointerHeld).toBe(false);
    expect(canceled.pointerInside).toBe(false);
    expect(released.slice(-3)).toEqual(["gesture", "look", "capture"]);
  });

  test("lost pointer capture cancels the held interaction so later presses are not blocked", () => {
    const events: string[] = [];
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      interactionMode: "interaction",
      interactionPointerId: 12,
      interactionPointerHeld: true,
      interactionPointer: { x: 20, y: 30 },
      interactionPressedBehaviorRegionId: "head",
      behaviorPointerHeldSeconds: 1,
      pointerInside: true,
      canvas: { hasPointerCapture: () => false },
      dispatchBehaviorEvent: (event: string) => events.push(event),
      endGesture: () => events.push("gesture-end"),
      endLook: () => events.push("look-end"),
    }) as any;

    renderer.handleLostPointerCapture({ pointerId: 12 });
    expect(renderer.interactionPointerHeld).toBe(false);
    expect(renderer.interactionPointerId).toBeNull();
    expect(renderer.interactionPointer).toBeNull();
    expect(renderer.pointerInside).toBe(false);
    expect(events).toEqual(["pointer-cancel", "gesture-end", "look-end"]);

    renderer.handlePointerUp({ pointerId: 12, clientX: 30, clientY: 30 });
    expect(events).toHaveLength(3);
  });

  test("window blur cancels a held interaction and clears the camera drag", () => {
    const events: string[] = [];
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      interactionMode: "interaction",
      interactionPointerId: 8,
      interactionPointerHeld: true,
      interactionPointer: { x: 20, y: 30 },
      pointerInside: true,
      dragging: true,
      canvas: { hasPointerCapture: () => false },
      dispatchBehaviorEvent: (event: string) => events.push(event),
      endGesture: () => events.push("gesture-end"),
      endLook: () => events.push("look-end"),
    }) as any;

    renderer.handleWindowBlur();
    expect(renderer.interactionPointerHeld).toBe(false);
    expect(renderer.interactionPointerId).toBeNull();
    expect(renderer.pointerInside).toBe(false);
    expect(renderer.dragging).toBe(false);
    expect(events).toEqual(["pointer-cancel", "gesture-end", "look-end"]);
  });

  test("ignores a second pointer while one interaction gesture is held", () => {
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      interactionMode: "interaction",
      interactionPointerHeld: true,
      interactionPointerId: 2,
    }) as any;
    renderer.handlePointerDown({ button: 0, pointerId: 3 });
    expect(renderer.interactionPointerId).toBe(2);
    expect(renderer.interactionPointerHeld).toBe(true);
  });

  test("switches a loaded lobby from intro to idle when skip intro is enabled", () => {
    const { renderer, state } = playback(INTRO_ANIMATION);
    Object.assign(renderer, { skipIntro: false, interactionMode: "free" });
    renderer.setSkipIntro(true);
    expect(state.getCurrent(0)?.animation?.name).toBe("Idle_01");
    expect((renderer as any).animationSelection).toBe("Idle_01");
  });

  test("limits touch-target deformation when the pointer is far outside the rig", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const touchPoint = new BoneData(1, "Touch_Point", root);
    data.bones.push(root, touchPoint);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(0 as never);
    const target = skeleton.findBone("Touch_Point")!;
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { skeleton, touchTarget: { bone: target, baseX: 0, baseY: 0, rangeX: 100, rangeY: 50 } },
      pointerWorld: () => ({ x: 1000, y: -1000 }),
      touchPointerOrigin: { x: 0, y: 0 },
      interactionFollowWorld: null,
    }) as any;
    renderer.applyTouchFollow(1);
    expect(target.x).toBeGreaterThan(0);
    expect(target.y).toBeLessThan(0);
    expect(Math.hypot(target.x / 100, target.y / 50)).toBeLessThanOrEqual(1);
    expect(target.x).toBeCloseTo(100 / Math.sqrt(5), 1);
    expect(target.y).toBeCloseTo(-100 / Math.sqrt(5), 1);
  });

  test("eases touch-target movement toward the clamp instead of jumping there", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const touchPoint = new BoneData(1, "Touch_Point", root);
    data.bones.push(root, touchPoint);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(0 as never);
    const target = skeleton.findBone("Touch_Point")!;
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { skeleton, touchTarget: { bone: target, baseX: 0, baseY: 0, rangeX: 100, rangeY: 50 } },
      pointerWorld: () => ({ x: 1000, y: -1000 }),
      touchPointerOrigin: { x: 0, y: 0 },
      interactionFollowWorld: null,
    }) as any;
    renderer.applyTouchFollow(1 / 60);
    const firstX = target.x;
    renderer.applyTouchFollow(1 / 60);
    expect(firstX).toBeGreaterThan(0);
    expect(firstX).toBeLessThan(100);
    expect(target.x).toBeGreaterThan(firstX);
    expect(target.x).toBeLessThan(100);
  });

  test("a stationary press preserves the pose and only relative dragging deforms it", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    root.scaleX = 2;
    root.scaleY = 2;
    const point = new BoneData(1, "Touch_Point", root);
    point.x = 20;
    point.y = 30;
    data.bones.push(root, point);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(0 as never);
    const target = skeleton.findBone("Touch_Point")!;
    const pointer = { x: 1000, y: -1000 };
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: { skeleton, touchTarget: { bone: target, baseX: 20, baseY: 30, rangeX: 90, rangeY: 65 } },
      pointerWorld: () => pointer,
    }) as any;
    renderer.applyTouchFollow(1);
    expect(target.x).toBeCloseTo(20, 4);
    expect(target.y).toBeCloseTo(30, 4);
    pointer.x += 80;
    renderer.applyTouchFollow(1);
    // 80 world units * 25% sensitivity / 2x parent scale = 10 local units.
    expect(target.x).toBeCloseTo(30, 1);
    expect(target.y).toBeCloseTo(30, 4);
    root.x = 500;
    skeleton.bones[0]!.x = root.x;
    skeleton.updateWorldTransform(0 as never);
    renderer.restoreInteractionPose();
    renderer.applyTouchFollow(1);
    expect(target.x).toBeCloseTo(30, 1);
  });

  test("plays the selected authored touch interaction through start, follow, and release", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(
      new Animation("Touch_01_M", [], 0.5),
      new Animation("Touch_02_M", [], 1),
      new Animation("TouchEnd_01_M", [], 0.25),
      new Animation("Touch2_01_M", [], 0.5),
      new Animation("Touch2_02_M", [], 1),
      new Animation("Touch2End_01_M", [], 0.25),
      new Animation("Touch2_01_A", [], 0.5),
      new Animation("Touch2_02_A", [], 1),
      new Animation("Touch2End_01_A", [], 0.25),
    );
    const skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    state.setAnimation(3, "Touch2_01_M", false);
    state.setAnimation(4, "Touch2_01_A", false);
    state.update(0.5);
    state.apply(skeleton);
    const animations = data.animations.map((animation) => animation.name);
    const project = normalizeSpineInteractionProject({
      schemaVersion: 1,
      assetDirectory: "Airi_home",
      interactions: [
        { id: "touch-first", name: "Touch first", startAnimation: "Touch_01_M", followAnimation: "Touch_02_M", endAnimation: "TouchEnd_01_M", regions: [] },
        { id: "touch-second", name: "Touch second", startAnimation: "Touch2_01_M", followAnimation: "Touch2_02_M", endAnimation: "Touch2End_01_M", faceStartAnimation: "Touch2_01_A", faceFollowAnimation: "Touch2_02_A", faceEndAnimation: "Touch2End_01_A", regions: [] },
      ],
    });
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      bundle: {
        state,
        skeleton,
        meta: { animations },
        project,
        interaction: {
          touch: {
            start: { main: "Touch_01_M", face: null },
            follow: { main: "Touch_02_M", face: null },
            release: { main: "TouchEnd_01_M", face: null },
          },
        },
      },
      interactionState: "touchStart",
      interactionTrackName: "Touch2_01_M",
      interactionPointerHeld: true,
      interactionPressedTarget: { kind: "touch", interactionId: "touch-second" },
      activeGestureInteractionId: "touch-second",
      interactionFollowWorld: null,
    }) as any;

    renderer.finishInteractionState();
    expect(state.getCurrent(3)?.animation?.name).toBe("Touch2_02_M");
    expect(state.getCurrent(4)?.animation?.name).toBe("Touch2_02_A");
    expect(state.getCurrent(3)?.loop).toBe(true);

    renderer.interactionPointerHeld = false;
    renderer.interactionPressedTarget = null;
    renderer.endGesture();
    expect(state.getCurrent(3)?.animation?.name).toBe("Touch2End_01_M");
    expect(state.getCurrent(4)?.animation?.name).toBe("Touch2End_01_A");

    state.update(0.25);
    state.apply(skeleton);
    renderer.finishInteractionState();
    expect(renderer.interactionState).toBe("idle");
  });
});
