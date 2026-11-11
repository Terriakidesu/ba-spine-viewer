import { expect, test } from "bun:test";
import { BoneData, IkConstraintData, Skeleton, SkeletonData, Skin } from "@esotericsoftware/spine-core";
import {
  COMPOSITION_PROPERTY_REGISTRY,
  applySpineSkeletalOverrides,
  compositionEvaluationContextAt,
  compositionTargetKey,
  createEmptySpineComposition,
  defaultTalkSectionRoute,
  evaluateComposition,
  evaluateCompositionFrame,
  evaluateLayerTransforms,
  integrateCompositionRate,
  mapCompositionClipTime,
  runFixedStepPreroll,
  sampleCompositionTrack,
  validateComposition,
  type CompositionPropertyTrack,
  type SpineComposition,
} from "./spineComposition";
import { sampleSpineCameraTrack } from "./spineCameraMotion";
import { compositionCameraTrackAt } from "./spineCompositionTimeline";
import { compositionFrameToTimeline } from "./spineCompositionTimeline";

function composition(): SpineComposition {
  const value = createEmptySpineComposition("test", "Test", 10, 30);
  value.layers.push({
    id: "character",
    name: "A character",
    role: "character",
    order: 0,
    assetDirectory: "A_home",
    assetIdentity: "asset:A_home@revision-1",
    transformParentId: null,
    baseProperties: { "layer.position.x": 1, "layer.position.y": 2, "layer.rotation": 0, "layer.scale.x": 1, "layer.scale.y": 1, "layer.opacity": 1 },
    enabled: true,
    locked: false,
  });
  return value;
}

function track(overrides: Partial<CompositionPropertyTrack> & Pick<CompositionPropertyTrack, "property" | "target" | "keys">): CompositionPropertyTrack {
  return {
    id: "track",
    clock: { kind: "composition" },
    enabled: true,
    priority: 0,
    blendMode: "override",
    weight: 1,
    holdBefore: true,
    holdAfter: true,
    ...overrides,
  };
}

test("property registry covers first-release layer, camera, audio, bone, slot, and runtime constraint targets", () => {
  const ids = new Set(COMPOSITION_PROPERTY_REGISTRY.map((property) => property.id));
  expect(ids.has("animation.speed")).toBe(true);
  expect(ids.has("bone.shearY")).toBe(true);
  expect(ids.has("constraint.ik.mix")).toBe(true);
  expect(ids.has("constraint.transform.mixRotate")).toBe(true);
  expect(ids.has("constraint.path.spacing")).toBe(true);
  expect(ids.has("constraint.physics.gravity")).toBe(true);
  expect(ids.has("slot.attachment")).toBe(true);
  expect(COMPOSITION_PROPERTY_REGISTRY.find((item) => item.id === "camera.frameHeight")?.defaultValue).toBeGreaterThan(0);
  expect(COMPOSITION_PROPERTY_REGISTRY.find((item) => item.id === "constraint.ik.bendDirection")?.defaultValue).toBe(1);
  expect(COMPOSITION_PROPERTY_REGISTRY.find((item) => item.id === "slot.attachment")?.interpolations).toEqual(["step"]);
});

test("property sampler is random-access, uses half-open interpolation intervals, and resolves duplicate times by stable ID", () => {
  const linear = track({
    property: "layer.position.x",
    target: { kind: "layer", layerId: "character" },
    keys: [
      { id: "left", time: 0, value: 0, interpolation: "linear" },
      { id: "right", time: 2, value: 10, interpolation: "linear" },
    ],
  });
  expect(sampleCompositionTrack(linear, 1)).toBe(5);
  expect(sampleCompositionTrack(linear, 2)).toBe(10);
  expect(sampleCompositionTrack(linear, -1)).toBe(0);

  const step = track({ ...linear, keys: [
    { id: "a", time: 0, value: "Idle", interpolation: "step" },
    { id: "b", time: 1, value: "Talk", interpolation: "step" },
  ] });
  expect(sampleCompositionTrack(step, 0.999)).toBe("Idle");
  expect(sampleCompositionTrack(step, 1)).toBe("Talk");

  const duplicate = track({ ...linear, keys: [
    { id: "a", time: 1, value: 3, interpolation: "step" },
    { id: "z", time: 1, value: 9, interpolation: "step" },
  ] });
  expect(sampleCompositionTrack(duplicate, 1)).toBe(9);
});

test("rotation interpolation defaults to shortest path but permits intentional multi-turn values", () => {
  const keys = [
    { id: "a", time: 0, value: 350, interpolation: "linear" as const },
    { id: "b", time: 1, value: 10, interpolation: "linear" as const },
  ];
  const shortest = track({ property: "bone.rotation", target: { kind: "bone", layerId: "character", path: "root/head", assetIdentity: "asset:A_home@revision-1" }, keys });
  expect(sampleCompositionTrack(shortest, 0.5)).toBeCloseTo(360);
  expect(sampleCompositionTrack({ ...shortest, rotationMode: "continuous" }, 0.5)).toBeCloseTo(180);
});

test("cubic Bézier keys can shape a curve and discrete properties reject non-step curves", () => {
  const curved = track({
    property: "layer.position.x",
    target: { kind: "layer", layerId: "character" },
    keys: [
      { id: "a", time: 0, value: 0, interpolation: "bezier", outTangent: { time: 0.2, value: 0.05 } },
      { id: "b", time: 1, value: 10, interpolation: "linear", inTangent: { time: 0.2, value: 0.95 } },
    ],
  });
  expect(sampleCompositionTrack(curved, 0.5)).toBeGreaterThan(4);
  expect(sampleCompositionTrack(curved, 0.5)).toBeLessThan(6);
});

test("positive speed automation integrates piecewise-linear rates exactly and rejects unsupported reverse or Bézier rates", () => {
  const speed = track({
    property: "animation.speed",
    target: { kind: "clip", clipId: "clip" },
    baseValue: 1,
    keys: [
      { id: "a", time: 0, value: 1, interpolation: "linear" },
      { id: "b", time: 2, value: 3, interpolation: "linear" },
    ],
  });
  expect(integrateCompositionRate(speed, 0, 2)).toBeCloseTo(4);
  expect(integrateCompositionRate(speed, 0.5, 1.5)).toBeCloseTo(2);
  expect(integrateCompositionRate({ ...speed, keys: [{ ...speed.keys[0]!, value: -1 }] }, 0, 1)).toBeNull();
  expect(integrateCompositionRate({ ...speed, keys: [{ ...speed.keys[0]!, interpolation: "bezier" }] }, 0, 1)).toBeNull();
});

test("clip mapping has half-open activity, deterministic loop seams, and disabled reverse mapping", () => {
  const mapping = { clipStart: 2, clipEnd: 5, sourceStart: 1, sourceEnd: 3, speed: 1, loop: true };
  expect(mapCompositionClipTime(mapping, 2)).toBe(1);
  expect(mapCompositionClipTime(mapping, 4)).toBe(1);
  expect(mapCompositionClipTime(mapping, 5)).toBeNull();
  expect(mapCompositionClipTime({ ...mapping, speed: -1 }, 3)).toBeNull();
});

test("composition evaluation shares section, clip, and audio/subtitle activity and integrates speed automation", () => {
  const value = composition();
  value.sections.push({ id: "talk-1", name: "Talk 1", start: 2, end: 5, route: defaultTalkSectionRoute("idle") });
  value.sections.push({ id: "idle", name: "Idle", start: 0, end: 10, route: { ...defaultTalkSectionRoute("idle"), role: "idle", returnToSectionId: null } });
  value.animationClips.push({
    id: "talk-clip", layerId: "character", animation: "Talk_01_M", clock: { kind: "composition" }, sourceClock: { kind: "clip-source" }, start: 2, end: 5,
    sourceStart: 0, sourceEnd: 10, sourceOriginTime: 0, sourceOffset: 0, speed: 1, loop: false, endBehavior: "clear", blendIn: 0.2, blendOut: 0.2, mixingMode: "replace", weight: 1, priority: 0, enabled: true,
  });
  value.propertyTracks.push(track({
    id: "rate", property: "animation.speed", target: { kind: "clip", clipId: "talk-clip" },
    keys: [
      { id: "rate-start", time: 2, value: 1, interpolation: "linear" },
      { id: "rate-end", time: 4, value: 3, interpolation: "linear" },
    ],
  }));
  value.audio.push({ id: "voice", name: "voice.ogg", path: "voice.ogg", start: 2.5, end: 4, sourceOffset: 0, volume: 1, enabled: true });
  value.subtitles.push({ id: "cue", start: 3, end: 4, enabled: true, text: { en: "Hello", ja: "", ko: "" } });
  const sampled = evaluateComposition(value, { compositionTime: 3 });
  expect(sampled.activeSectionIds).toEqual(["talk-1", "idle"]);
  expect(sampled.activeAnimationClips[0]).toMatchObject({ clip: { animation: "Talk_01_M" }, sourceTime: 1.5 });
  expect(sampled.activeAudio.map((clip) => clip.id)).toEqual(["voice"]);
  expect(sampled.activeSubtitles.map((cue) => cue.id)).toEqual(["cue"]);
  expect(evaluateComposition(value, { compositionTime: 4 }).activeAudio).toHaveLength(0);
});

test("canonical linear contexts map section-instance clocks from section-local time", () => {
  const value = composition();
  value.sections.push({ id: "talk", name: "Talk", start: 2, end: 5 });
  value.propertyTracks.push(track({
    id: "talk-property",
    property: "layer.position.x",
    target: { kind: "layer", layerId: "character" },
    clock: { kind: "section-instance", sectionId: "talk" },
    keys: [
      { id: "start", time: 0, value: 10, interpolation: "linear" },
      { id: "end", time: 3, value: 16, interpolation: "linear" },
    ],
  }));

  const middle = compositionEvaluationContextAt(value, 3.5, 9);
  expect(middle).toMatchObject({ compositionTime: 3.5, transportTime: 9, sectionInstanceTimes: { talk: 1.5 } });
  expect(evaluateComposition(value, middle).properties.get(compositionTargetKey({ kind: "layer", layerId: "character" }, "layer.position.x"))).toBe(13);
  expect(compositionEvaluationContextAt(value, 5).sectionInstanceTimes).toEqual({});
});

test("camera property tracks override the sampled camera frame without mutating authored keys", () => {
  const value = composition();
  value.camera = {
    enabled: true,
    aspectRatio: "16:9",
    constraint: { mode: "automatic" },
    safeBounds: [],
    keyframes: [
      { id: "camera-a", time: 0, centerX: 0, centerY: 0, frameHeight: 10, easing: "linear" },
      { id: "camera-b", time: 10, centerX: 100, centerY: 20, frameHeight: 30, easing: "linear" },
    ],
  };
  value.propertyTracks.push(track({
    id: "camera-x",
    target: { kind: "camera" },
    property: "camera.centerX",
    keys: [{ id: "center", time: 0, value: 50, interpolation: "step" }],
  }));
  const frame = evaluateCompositionFrame(value, compositionEvaluationContextAt(value, 5));
  const evaluatedTrack = compositionCameraTrackAt(value, frame, 5)!;
  expect(sampleSpineCameraTrack(evaluatedTrack, 5)).toMatchObject({ centerX: 50, centerY: 10, frameHeight: 20 });
  expect(value.camera.keyframes).toHaveLength(2);

  value.sections.push({ id: "talk", name: "Talk", start: 0, end: 10 });
  value.propertyTracks[0] = {
    ...value.propertyTracks[0]!,
    clock: { kind: "section-instance", sectionId: "talk" },
    keys: [{ id: "center", time: 0, value: 200, interpolation: "step" }],
  };
  const blendedFrame = evaluateCompositionFrame(value, {
    compositionTime: 5,
    activeSectionId: "talk",
    activeSectionChannels: ["camera"],
    activeSectionWeight: 0.5,
    sectionInstanceTimes: { talk: 5 },
  });
  const blendedTrack = compositionCameraTrackAt(value, blendedFrame, 5)!;
  expect(sampleSpineCameraTrack(blendedTrack, 5)?.centerX).toBeCloseTo(125);
});

test("the renderer timeline adapter maps section-local audio and subtitles onto the live instance clock", () => {
  const value = composition();
  value.sections.push({ id: "talk", name: "Talk", start: 2, end: 5, route: defaultTalkSectionRoute("idle") });
  value.audio.push({ id: "voice", name: "Voice", path: "voice.ogg", start: 0.5, end: 1.5, sourceOffset: 0, volume: 1, enabled: true, sectionId: "talk" });
  value.subtitles.push({ id: "cue", start: 0.5, end: 1.5, enabled: true, text: { en: "Hello", ja: "こんにちは", ko: "안녕" }, sectionId: "talk" });
  value.propertyTracks.push(track({
    id: "voice-gain",
    target: { kind: "audio", audioId: "voice" },
    property: "audio.volume",
    clock: { kind: "section-instance", sectionId: "talk" },
    keys: [
      { id: "quiet", time: 0, value: 0.2, interpolation: "linear" },
      { id: "loud", time: 2, value: 0.8, interpolation: "linear" },
    ],
  }));

  const frame = evaluateCompositionFrame(value, {
    ...compositionEvaluationContextAt(value, 20),
    activeSectionId: "talk",
    activeSectionChannels: defaultTalkSectionRoute("idle").ownedChannels,
    sectionInstanceTimes: { talk: 1 },
  });
  const timeline = compositionFrameToTimeline(value, frame, 20, "en", { talk: 17 }, "talk");
  expect(timeline.audio[0]).toMatchObject({ start: 17.5, end: 18.5, enabled: true, volume: 0.5 });
  expect(timeline.subtitles[0]).toMatchObject({ start: 17.5, end: 18.5, enabled: true, text: { en: "Hello" } });

  const unownedFrame = evaluateCompositionFrame(value, {
    compositionTime: 20,
    activeSectionId: "talk",
    activeSectionChannels: ["body"],
    sectionInstanceTimes: { talk: 1 },
  });
  const unownedTimeline = compositionFrameToTimeline(value, unownedFrame, 20, "en", { talk: 17 }, "talk");
  expect(unownedTimeline.audio[0]?.enabled).toBe(false);
  expect(unownedTimeline.subtitles[0]?.enabled).toBe(false);
});

test("interactive section instances overlay continuous tracks, honor ownership, and use route blend weight", () => {
  const value = composition();
  value.sections.push({ id: "talk", name: "Talk", start: 4, end: 8, route: defaultTalkSectionRoute("idle") });
  expect(value.sections[0]?.route?.ownedChannels).not.toContain("scene");
  value.sections.push({ id: "idle", name: "Idle", start: 0, end: 10, route: { ...defaultTalkSectionRoute("idle"), role: "idle", returnToSectionId: null } });
  value.layers.push({ ...value.layers[0]!, id: "background", name: "Background", role: "background", assetDirectory: "B_home", assetIdentity: "asset:B_home@revision-1" });
  value.animationClips = [
    {
      id: "persistent", layerId: "character", animation: "Persistent", clock: { kind: "composition" }, sourceClock: { kind: "clip-source" },
      start: 0, end: 10, sourceStart: 0, sourceEnd: 10, sourceOriginTime: 0, sourceOffset: 0, speed: 1, loop: true,
      endBehavior: "clear", blendIn: 0, blendOut: 0, mixingMode: "replace", weight: 1, priority: 0, enabled: true,
    },
    {
      id: "talk-instance", layerId: "character", animation: "Talk", clock: { kind: "section-instance", sectionId: "talk" }, sourceClock: { kind: "clip-source" },
      start: 0, end: 4, sourceStart: 0, sourceEnd: 4, sourceOriginTime: 0, sourceOffset: 0, speed: 1, loop: false,
      endBehavior: "clear", blendIn: 0, blendOut: 0, mixingMode: "replace", weight: 1, priority: 2, enabled: true,
    },
    {
      id: "other-instance", layerId: "character", animation: "Other", clock: { kind: "section-instance", sectionId: "other" }, sourceClock: { kind: "clip-source" },
      start: 0, end: 4, sourceStart: 0, sourceEnd: 4, sourceOriginTime: 0, sourceOffset: 0, speed: 1, loop: false,
      endBehavior: "clear", blendIn: 0, blendOut: 0, mixingMode: "replace", weight: 1, priority: 3, enabled: true,
    },
    {
      id: "background-instance", layerId: "background", animation: "BackgroundTalk", clock: { kind: "section-instance", sectionId: "talk" }, sourceClock: { kind: "clip-source" },
      start: 0, end: 4, sourceStart: 0, sourceEnd: 4, sourceOriginTime: 0, sourceOffset: 0, speed: 1, loop: false,
      endBehavior: "clear", blendIn: 0, blendOut: 0, mixingMode: "replace", weight: 1, priority: 4, enabled: true,
    },
  ];
  value.propertyTracks.push(track({
    id: "talk-bone", property: "bone.x", target: { kind: "bone", layerId: "character", path: "root/hand", assetIdentity: "asset:A_home@revision-1" },
    clock: { kind: "section-instance", sectionId: "talk" }, keys: [{ id: "talk-bone-key", time: 0, value: 10, interpolation: "linear" }],
  }));
  value.audio.push({ id: "talk-audio", name: "Talk", path: "talk.ogg", start: 0.5, end: 2, sourceOffset: 0, volume: 1, enabled: true, sectionId: "talk" });
  value.subtitles.push({ id: "talk-caption", start: 0.5, end: 2, enabled: true, text: { en: "Talk", ja: "", ko: "" }, sectionId: "talk" });

  const sampled = evaluateComposition(value, {
    compositionTime: 7,
    transportTime: 7,
    activeSectionId: "talk",
    activeSectionChannels: defaultTalkSectionRoute("idle").ownedChannels,
    activeSectionWeight: 0.5,
    sectionInstanceTimes: { talk: 1 },
  });
  expect(sampled.activeAnimationClips.map(({ clip }) => clip.id)).toEqual(["persistent", "talk-instance"]);
  expect(sampled.activeAnimationClips.find(({ clip }) => clip.id === "talk-instance")?.weight).toBe(0.5);
  expect(sampled.propertyContributions.find(({ trackId }) => trackId === "talk-bone")?.weight).toBe(0.5);
  expect(sampled.activeAudio.map(({ id }) => id)).toEqual(["talk-audio"]);
  expect(sampled.activeSubtitles.map(({ id }) => id)).toEqual(["talk-caption"]);

  const withoutAudio = evaluateComposition(value, {
    compositionTime: 7,
    activeSectionId: "talk",
    activeSectionChannels: ["body"],
    sectionInstanceTimes: { talk: 1 },
  });
  expect(withoutAudio.activeAudio).toHaveLength(0);
  expect(withoutAudio.activeSubtitles).toHaveLength(0);
  const sceneOwned = evaluateComposition(value, {
    compositionTime: 7,
    activeSectionId: "talk",
    activeSectionChannels: [...defaultTalkSectionRoute("idle").ownedChannels, "scene"],
    sectionInstanceTimes: { talk: 1 },
  });
  expect(sceneOwned.activeAnimationClips.map(({ clip }) => clip.id)).toContain("background-instance");
});

test("animation-name binding does not copy source clip time, speed, or looping", () => {
  const value = composition();
  value.layers.push({
    ...value.layers[0]!,
    id: "background",
    role: "background",
    transformParentId: "character",
    animationBinding: { sourceLayerId: "character", fallback: "authored-animation" },
  });
  const shared = { sourceStart: 0, sourceEnd: 10, sourceOriginTime: 0, sourceOffset: 0, loop: false, endBehavior: "clear" as const, blendIn: 0, blendOut: 0, mixingMode: "replace" as const, weight: 1, priority: 0, enabled: true };
  value.animationClips = [
    { ...shared, id: "main", layerId: "character", animation: "Talk", clock: { kind: "composition" }, sourceClock: { kind: "clip-source" }, start: 1, end: 9, speed: 2 },
    { ...shared, id: "follower", layerId: "background", animation: "Fallback", clock: { kind: "composition" }, sourceClock: { kind: "clip-source" }, start: 2, end: 8, speed: 1 },
  ];
  const sampled = evaluateComposition(value, { compositionTime: 4 });
  const main = sampled.activeAnimationClips.find(({ clip }) => clip.layerId === "character")!;
  const follower = sampled.activeAnimationClips.find(({ clip }) => clip.layerId === "background")!;
  expect(main.clip.animation).toBe("Talk");
  expect(follower.clip.animation).toBe("Talk");
  expect(main.sourceTime).toBe(6);
  expect(follower.sourceTime).toBe(2);
});

test("property conflicts resolve in stable priority and ID order, independently of input array order", () => {
  const value = composition();
  const base = { property: "layer.position.x", target: { kind: "layer" as const, layerId: "character" }, keys: [{ id: "key", time: 1, value: 0, interpolation: "linear" as const }] };
  value.propertyTracks = [
    track({ ...base, id: "later", priority: 2, weight: 1, keys: [{ id: "k2", time: 0, value: 20, interpolation: "linear" }] }),
    track({ ...base, id: "earlier", priority: 1, weight: 0.5, keys: [{ id: "k1", time: 0, value: 10, interpolation: "linear" }] }),
  ];
  const key = compositionTargetKey({ kind: "layer", layerId: "character" }, "layer.position.x");
  expect(evaluateComposition(value, { compositionTime: 0 }).properties.get(key)).toBe(20);
  value.propertyTracks.reverse();
  expect(evaluateComposition(value, { compositionTime: 0 }).properties.get(key)).toBe(20);
});

test("layer transforms inherit explicitly and validator reports parent cycles", () => {
  const value = composition();
  value.layers.push({ ...value.layers[0]!, id: "overlay", name: "Overlay", role: "overlay", transformParentId: "character", baseProperties: { "layer.position.x": 3, "layer.position.y": 4, "layer.rotation": 0, "layer.scale.x": 0.5, "layer.scale.y": 0.5, "layer.opacity": 0.5 } });
  const transforms = evaluateLayerTransforms(value, evaluateComposition(value, { compositionTime: 0 }));
  expect(transforms.get("overlay")).toMatchObject({ x: 4, y: 6, scaleX: 0.5, opacity: 0.5 });
  value.layers[0] = { ...value.layers[0]!, transformParentId: "overlay" };
  expect(validateComposition(value).some((diagnostic) => diagnostic.code === "parent-cycle")).toBe(true);
});

test("renderer frame adapter shares evaluated transforms, active clips, visibility, and skeletal overrides", () => {
  const value = composition();
  value.animationClips.push({
    id: "idle-clip",
    layerId: "character",
    animation: "Idle_01",
    clock: { kind: "composition" },
    sourceClock: { kind: "clip-source" },
    start: 0,
    end: 5,
    sourceStart: 0,
    sourceEnd: 3,
    sourceOriginTime: 0,
    sourceOffset: 0,
    speed: 1,
    loop: true,
    endBehavior: "clear",
    blendIn: 0,
    blendOut: 0,
    mixingMode: "replace",
    weight: 1,
    priority: 0,
    enabled: true,
  });
  value.propertyTracks.push(track({
    id: "hide-character",
    target: { kind: "layer", layerId: "character" },
    property: "layer.visible",
    keys: [{ id: "hidden", time: 1, value: false, interpolation: "step" }],
  }));
  value.propertyTracks.push(track({
    id: "head-offset",
    target: { kind: "bone", layerId: "character", path: "root/head", assetIdentity: "asset:A_home@revision-1" },
    property: "bone.x",
    keys: [{ id: "head-x", time: 0, value: 4, interpolation: "linear" }],
  }));

  const frame = evaluateCompositionFrame(value, { compositionTime: 2 });
  expect(frame.layers[0]?.visible).toBe(false);
  expect(frame.layers[0]?.transform).toMatchObject({ x: 1, y: 2, scaleX: 1, opacity: 0 });
  expect(frame.layers[0]?.animationClips.map(({ clip, sourceTime }) => [clip.animation, sourceTime])).toEqual([["Idle_01", 2]]);
  expect(frame.layers[0]?.skeletalOverrides).toMatchObject([{ property: "bone.x", value: 4 }]);
});

test("validation preserves warnings for unresolved targets and rejects invalid numeric values", () => {
  const value = composition();
  value.propertyTracks.push(track({
    property: "bone.x",
    target: { kind: "bone", layerId: "character", path: "root/head", assetIdentity: "asset:A_home@revision-1" },
    keys: [{ id: "bad", time: 1, value: Number.NaN, interpolation: "linear" }],
  }));
  const diagnostics = validateComposition(value);
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("unresolved-skeleton-target");
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("key-value");
});

test("bone and IK overrides modify the evaluated skeleton only, not source setup data", () => {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  root.x = 2;
  const head = new BoneData(1, "head", root);
  head.x = 3;
  const targetBone = new BoneData(2, "target", root);
  data.bones.push(root, head, targetBone);
  data.skins.push(new Skin("Alt"));
  const ikData = new IkConstraintData("head-ik");
  ikData.bones.push(head);
  ikData.target = targetBone;
  ikData.mix = 0.25;
  data.ikConstraints.push(ikData);
  const skeleton = new Skeleton(data);
  const diagnostics = applySpineSkeletalOverrides(skeleton, "character", "asset:A_home@revision-1", [
    { target: { kind: "bone", layerId: "character", path: "root/head", assetIdentity: "asset:A_home@revision-1" }, property: "bone.x", value: 11, mode: "override", weight: 0.5 },
    { target: { kind: "constraint", layerId: "character", type: "ik", name: "head-ik", assetIdentity: "asset:A_home@revision-1" }, property: "constraint.ik.mix", value: 1, mode: "override", weight: 0.5 },
    { target: { kind: "layer", layerId: "character" }, property: "skeleton.skin", value: "Alt", mode: "override", weight: 1 },
  ]);
  expect(diagnostics).toEqual([]);
  expect(skeleton.findBone("head")?.x).toBe(7);
  expect(skeleton.ikConstraints[0]?.mix).toBeCloseTo(0.625);
  expect(skeleton.skin?.name).toBe("Alt");
  expect(head.x).toBe(3);
  expect(ikData.mix).toBe(0.25);
});

test("fixed-step physics preroll resets and samples deterministic integer multiples plus a final remainder", () => {
  const calls: Array<[number, number, boolean]> = [];
  let resets = 0;
  const result = runFixedStepPreroll(0.25, { stepSeconds: 0.1, maxSteps: 10 }, () => { resets += 1; }, (time, delta, final) => calls.push([time, delta, final]));
  expect(resets).toBe(1);
  expect(result).toEqual({ steps: 3, sampledTime: 0.25 });
  expect(calls).toEqual([[0, 0, false], [0.1, 0.1, false], [0.2, 0.1, false], [0.25, 0.04999999999999999, true]]);
  expect(runFixedStepPreroll(1, { stepSeconds: 0.01, maxSteps: 2 }, () => {}, () => {})).toBeNull();
});
