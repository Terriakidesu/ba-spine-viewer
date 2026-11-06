import { expect, test } from "bun:test";
import { timelineFaceAnimation, timelineIdleAnimation, timelineTalkIdleStart, timelineTalkInProgress } from "./spineTimeline";

test("idle playback selects Idle_XX, never the opening or talk animation", () => {
  expect(timelineIdleAnimation({ idleAnimation: "Idle_01", animations: ["Start_Idle_01", "Idle_01", "Talk_01_M"] })).toBe("Idle_01");
  expect(timelineIdleAnimation({ idleAnimation: null, animations: ["Start_Idle_01", "Idle_02"] })).toBe("Idle_02");
  expect(timelineIdleAnimation({ idleAnimation: null, animations: ["Start_Idle_01"] })).toBe("");
});

test("a missing idle never falls through to the first interaction animation", () => {
  const metaWithoutIdle = { idleAnimation: null, introAnimation: null, animations: ["LookEnd_01_M", "Talk_01_M"] };
  expect(timelineIdleAnimation(metaWithoutIdle)).toBe("");
  expect(timelineLayerAnimation(layer({ animation: "" }), metaWithoutIdle, undefined, 0, "opening", "direct", 0)).toBe("");
  expect(timelineMainAnimation(layer({ animation: "" }), metaWithoutIdle, 0, "opening", "direct", 0, 0).animation).toBe("");
  expect(timelineLayerAnimation(layer({ animation: "LookEnd_01_M" }), metaWithoutIdle, undefined, 0, "opening", "direct", 0)).toBe("LookEnd_01_M");
});

test("a clip can inherit the layer face animation or explicitly disable it", () => {
  const configuredLayer = layer({ faceAnimation: "LookEnd_01_M" });
  expect(timelineFaceAnimation(configuredLayer)).toBe("LookEnd_01_M");
  expect(timelineFaceAnimation(configuredLayer, {})).toBe("LookEnd_01_M");
  expect(timelineFaceAnimation(configuredLayer, { faceAnimation: "" })).toBe("");
  expect(timelineFaceAnimation(configuredLayer, { faceAnimation: "LookEnd_01_A" })).toBe("LookEnd_01_A");
});
import { advanceSpineTimeline, normalizeSpineTimeline, timelineActiveAnimationClip, timelineActiveColorClip, timelineActiveSubtitleTexts, timelineAnimationNeedsIdleUnderlay, timelineAudioPlaybackDecision, timelineAudioPreloadsReady, timelineAuthoredCueEnd, timelineBlendModeCss, timelineColorClipOpacity, timelineForSequence, timelineLastDefinedCameraTrack, timelineLayerAnimation, timelineLayerPlaybackEnd, timelineLayerSampleTime, timelineMainAnimation, timelineOpeningDuration, timelinePlaybackDuration, timelineReferenceLayerId, timelineSceneHidesCharacter, timelineSequenceIds, timelineTalkSequenceIds, timelineVisualLayers, type SpineTimeline, type SpineTimelineLayer } from "./spineTimeline";

const character = { start: 1, animationOffset: 0.25, loop: false, role: "character" as const };

const meta = {
  animations: ["Idle", "Talk_01_M", "Intro", "Start_Idle", "Scene", "Start_Idle_2"],
  introAnimation: "Intro",
  idleAnimation: "Idle",
};

test("Aru's shortened talk layer does not truncate its body animation before the idle tail", () => {
  expect(timelineTalkIdleStart(layer({ start: 0, end: 15.1 }), 15.333)).toBe(15.333);
  expect(timelineTalkIdleStart(layer({ start: 0, end: 16 }), 15.333)).toBe(16);
});

test("authored talks remain in progress until the idle tail starts", () => {
  expect(timelineTalkInProgress("talk-1", "none")).toBe(true);
  expect(timelineTalkInProgress("talk-1", "persistent")).toBe(false);
  expect(timelineTalkInProgress("opening", "none")).toBe(false);
});

function layer(overrides: Partial<SpineTimelineLayer> = {}): SpineTimelineLayer {
  return {
    id: "layer",
    name: "Layer",
    role: "character",
    directory: "Layer_home",
    enabled: true,
    animation: "Idle",
    start: 0,
    end: 4,
    animationOffset: 0,
    loop: true,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    order: 1,
    ...overrides,
  };
}

test("opening character samples idle time after the intro, matching editor timing", () => {
  expect(timelineLayerSampleTime(character, 1.5, "opening", "direct", 2, 3)).toBe(0.5);
  expect(timelineLayerSampleTime(character, 4, "opening", "direct", 2, 3)).toBe(1.25);
});

test("talk and looping layers use their saved offsets and animation clocks", () => {
  expect(timelineLayerSampleTime({ ...character, loop: true }, 4, "talk-1", "direct", 0, 3)).toBeCloseTo(0.25);
  expect(timelineLayerSampleTime({ ...character, role: "scene", loop: false }, 4, "opening", "direct", 2, 3)).toBe(3);
});

test("sequence helpers preserve the active timeline and stored sequence copies", () => {
  const active: SpineTimeline = { sequenceId: "talk-1", openingMode: "direct", sceneDuration: 3, openingIdleDuration: 3, durationMode: "manual", duration: 4, loop: false, layers: [], subtitles: [], audio: [], language: "en" };
  const opening: SpineTimeline = { ...active, sequenceId: "opening", duration: 8 };
  const project = { timeline: active, sequences: { opening } };
  expect(timelineSequenceIds(project)).toEqual(["talk-1", "opening"]);
  expect(timelineForSequence(project, "talk-1")).toBe(active);
  expect(timelineForSequence(project, "opening")).toBe(opening);
});

test("authored talk sequences are ordered numerically for autoplay", () => {
  const project = {
    timeline: { sequenceId: "talk-10" } as SpineTimeline,
    sequences: { "talk-2": {} as SpineTimeline, "talk-1": {} as SpineTimeline, legacy: {} as SpineTimeline },
  };
  expect(timelineTalkSequenceIds(project)).toEqual(["talk-1", "talk-2", "talk-10"]);
});

test("automatic Talk duration trims stale saved tails and fits enabled endpoints", () => {
  const timeline: SpineTimeline = {
    sequenceId: "talk-1", openingMode: "direct", sceneDuration: 3, openingIdleDuration: 3,
    durationMode: "auto", duration: 19.14, loop: false,
    layers: [
      { ...layer({ role: "character", animation: "Talk_01_M", end: 16.26, loop: false }) },
      { ...layer({ id: "disabled-layer", role: "background", end: 19.14, enabled: false }) },
      { ...layer({ id: "clips", role: "overlay", end: 20, animationClips: [
        { id: "muted-clip", animation: "Old", start: 0, end: 20, animationOffset: 0, loop: false, enabled: false },
        { id: "enabled-clip", animation: "Overlay", start: 0, end: 8, animationOffset: 0, loop: false, enabled: true },
      ] }) },
    ],
    subtitles: [
      { id: "enabled-cue", start: 9, end: 12, enabled: true, text: { en: "Hello", ja: "", ko: "" } },
      { id: "disabled-cue", start: 15, end: 21, enabled: false, text: { en: "Disabled", ja: "", ko: "" } },
    ],
    audio: [
      { id: "enabled-audio", name: "voice.ogg", path: "voice.ogg", start: 9, end: 13, enabled: true, volume: 1 },
      { id: "disabled-audio", name: "unused.ogg", path: "unused.ogg", start: 15, end: 22, enabled: false, volume: 1 },
    ],
    language: "en",
  };
  expect(timelinePlaybackDuration(timeline, 0, undefined, 0.4)).toBeCloseTo(16.66);
});

test("manual Talk duration honors the explicit saved override", () => {
  const timeline: SpineTimeline = {
    sequenceId: "talk-1", openingMode: "direct", sceneDuration: 3, openingIdleDuration: 3,
    durationMode: "manual", duration: 4, loop: false,
    layers: [layer({ role: "character", end: 6, loop: false })],
    subtitles: [{ id: "late", start: 8, end: 11, enabled: true, text: { en: "Late", ja: "", ko: "" } }],
    audio: [], language: "en",
  };
  expect(timelinePlaybackDuration(timeline, 0, undefined, 0.4)).toBe(4.4);
});

test("saved subtitle and audio endpoints keep a composition alive", () => {
  const timeline: SpineTimeline = { sequenceId: "opening", openingMode: "direct", sceneDuration: 3, openingIdleDuration: 3, durationMode: "manual", duration: 4, loop: false, layers: [], subtitles: [{ id: "cue", start: 9, end: 11, enabled: true, text: { en: "Late", ja: "", ko: "" } }], audio: [{ id: "audio", name: "voice.ogg", path: "voice.ogg", start: 9, end: 12, enabled: true, volume: 1 }], language: "en" };
  expect(timelinePlaybackDuration(timeline)).toBe(12);
});

test("automatic openings trim stale blank time after their last layer", () => {
  const timeline: SpineTimeline = {
    sequenceId: "opening",
    openingMode: "scene-first",
    sceneDuration: 4.6,
    openingIdleDuration: 3,
    durationMode: "auto",
    duration: 19.266,
    loop: false,
    layers: [
      { ...layer({ role: "character", start: 4.6, end: 17.8, endMode: "manual" }) },
      { ...layer({ role: "scene", start: 0, end: 4.7, endMode: "manual" }) },
    ],
    subtitles: [{ id: "cue", start: 9, end: 12.9, enabled: true, text: { en: "Hello", ja: "", ko: "" } }],
    audio: [],
    language: "en",
  };
  expect(timelinePlaybackDuration(timeline, 16.267)).toBe(17.8);
});

test("shared timeline clock advances and completes the same way for editor and viewer", () => {
  expect(advanceSpineTimeline(1, 0.5, 2, 3, false)).toEqual({ time: 2, finished: false });
  expect(advanceSpineTimeline(2.75, 0.3, 1, 3, false)).toEqual({ time: 3, finished: true });
  expect(advanceSpineTimeline(2.75, 0.5, 1, 3, true)).toEqual({ time: 0.25, finished: false });
});

test("background layers follow the main animation by name and clock", () => {
  const background = layer({ role: "background", animation: "Fallback", followMainAnimation: true, directory: "Layer_bg" });
  expect(timelineLayerAnimation(background, meta, "talk_01_m", 2, "talk-1", "direct", 0)).toBe("Talk_01_M");
  expect(timelineMainAnimation(layer({ animation: "Talk_01_M" }), meta, 2, "talk-1", "direct", 0, 3)).toMatchObject({ animation: "Talk_01_M", time: 2, loop: false });
  const clipMain = layer({ animationClips: [
    { id: "main", animation: "Start_Idle_2", start: 2, end: 3, animationOffset: 0.1, loop: false },
  ] });
  const clipBackground = layer({ role: "background", directory: "Layer_bg", followMainAnimation: true, animationClips: [
    { id: "bg", animation: "Idle", start: 0, end: 4, animationOffset: 0, loop: true },
  ] });
  const mainState = timelineMainAnimation(clipMain, meta, 2.5, "opening", "direct", 0, 1);
  expect(timelineLayerAnimation(clipBackground, meta, mainState.animation, 2.5, "opening", "direct", 0)).toBe("Start_Idle_2");
  expect(mainState.time).toBeCloseTo(0.6);
});

test("opening intro and post-intro clocks are shared by the main layer", () => {
  const opening = timelineMainAnimation(layer({ animation: "Idle" }), meta, 1, "opening", "direct", 2, 3);
  expect(opening).toMatchObject({ animation: "Intro", time: 1, useIntro: true });
  const idle = timelineMainAnimation(layer({ animation: "Idle" }), meta, 3, "opening", "direct", 2, 3);
  expect(idle).toMatchObject({ animation: "Idle", time: 1, useIntro: false });
});

test("clip-based openings resolve a CH0184-style sequence and continue its final idle", () => {
  const clips = [
    { id: "start-idle", animation: "Start_Idle", start: 0, end: 1, animationOffset: 0, loop: false },
    { id: "scene", animation: "Scene", start: 1, end: 2, animationOffset: 0, loop: false },
    { id: "start-idle-2", animation: "Start_Idle_2", start: 2, end: 3, animationOffset: 0, loop: false },
    { id: "idle", animation: "Idle", start: 3, end: 4, animationOffset: 0, loop: true, continueAfterOpening: true },
  ];
  const main = layer({ animationClips: clips });
  expect([0.5, 1.5, 2.5, 3.5].map((time) => timelineLayerAnimation(main, meta, undefined, time, "opening", "direct", 0))).toEqual([
    "Start_Idle", "Scene", "Start_Idle_2", "Idle",
  ]);
  expect(timelineActiveAnimationClip(main, meta, 2.5, "opening", "direct", 0)?.id).toBe("start-idle-2");
  expect(timelineMainAnimation(main, meta, 3.5, "opening", "direct", 0, 2)).toMatchObject({ animation: "Idle", time: 0.5, loop: true });
  expect(timelineMainAnimation(main, meta, 5.5, "opening", "direct", 0, 2, true)).toMatchObject({ animation: "Idle", time: 0.5, loop: true });
  expect(timelinePlaybackDuration({ sequenceId: "opening", durationMode: "auto", duration: 9, layers: [main], subtitles: [], audio: [] })).toBe(4);
});

test("recording idle explicitly selects true Idle instead of an opening continuation", () => {
  const opening = layer({ animationClips: [
    { id: "opening", animation: "Start_Idle_2", start: 0, end: 3, animationOffset: 0, loop: true, continueAfterOpening: true },
  ] });

  expect(timelineLayerAnimation(opening, meta, undefined, 8, "opening", "direct", 0, true, true)).toBe("Idle");
  expect(timelineLayerAnimation(opening, meta, undefined, 8, "opening", "direct", 0, true)).toBe("Start_Idle_2");
});

test("legacy opening layers synthesize their previous intro-to-idle timing", () => {
  const oldLayer = layer({ start: 1, end: 5, animation: "Idle", animationOffset: 0.25, loop: true });
  expect(timelineLayerAnimation(oldLayer, meta, undefined, 2, "opening", "direct", 2)).toBe("Intro");
  expect(timelineLayerAnimation(oldLayer, meta, undefined, 3.5, "opening", "direct", 2)).toBe("Idle");
  expect(timelineActiveAnimationClip(oldLayer, meta, 3.5, "opening", "direct", 2)).toMatchObject({ start: 3, end: 5, animationOffset: 0.25, continueAfterOpening: true });
});

test("scene clips explicitly hide the character only while active", () => {
  const scene = layer({
    role: "scene",
    animationClips: [{ id: "scene", animation: "Scene", start: 1, end: 3, animationOffset: 0, loop: false, hideCharacter: true }],
  });
  expect(timelineSceneHidesCharacter({ layers: [scene] }, 2)).toBe(true);
  expect(timelineSceneHidesCharacter({ layers: [scene] }, 3)).toBe(false);
});

test("non-looping layer endpoints use the authored animation offset", () => {
  expect(timelineLayerPlaybackEnd(layer({ loop: false, animationOffset: 0.5 }), 3)).toBe(2.5);
  expect(timelineLayerPlaybackEnd(layer({ loop: true, end: 9 }), 3)).toBe(9);
});

test("a clip-only composition is blank at its exclusive animation endpoint by design", () => {
  const clip = { id: "finite", animation: "Talk_01_M", start: 0, end: 4, endMode: "auto" as const, animationOffset: 0, loop: false, enabled: true };
  const authored = layer({ animationClips: [clip], end: 4, loop: false });
  expect(timelineActiveAnimationClip(authored, meta, 3.999, "talk-1", "direct", 0)).toEqual(clip);
  expect(timelineActiveAnimationClip(authored, meta, 4, "talk-1", "direct", 0)).toBeNull();
  expect(timelinePlaybackDuration({ sequenceId: "talk-1", durationMode: "auto", duration: 9, layers: [authored], subtitles: [], audio: [] })).toBe(4);
});

test("subtitle fallback returns every simultaneous active cue", () => {
  const timeline: Pick<SpineTimeline, "subtitles" | "language"> = {
    language: "ja",
    subtitles: [
      { id: "one", start: 1, end: 3, enabled: true, text: { en: "One", ja: "", ko: "" } },
      { id: "two", start: 2, end: 4, enabled: true, text: { en: "Two", ja: "二", ko: "" } },
      { id: "off", start: 1, end: 4, enabled: false, text: { en: "Off", ja: "", ko: "" } },
    ],
  };
  expect(timelineActiveSubtitleTexts(timeline, 2)).toEqual(["One", "二"]);
});

test("legacy background layers opt into main animation following", () => {
  const normalized = normalizeSpineTimeline({ duration: 4, layers: [{ directory: "Scene_bg", role: "background" }] });
  expect(normalized?.layers[0]?.followMainAnimation).toBe(true);
  const explicit = normalizeSpineTimeline({ duration: 4, layers: [{ directory: "Scene_bg", role: "background", followMainAnimation: false }] });
  expect(explicit?.layers[0]?.followMainAnimation).toBe(false);
});

test("color clip fade envelopes and blend mapping are deterministic at boundaries", () => {
  const colorLayer = {
    id: "wash", name: "Wash", enabled: true, locked: false, opacity: 0.5, order: 1, blendMode: "additive" as const,
    clips: [{ id: "fade", name: "Fade", color: "#000000", start: 1, end: 5, opacity: 0.8, fadeIn: 1, fadeOut: 1, enabled: true }],
  };
  const clip = colorLayer.clips[0]!;
  expect(timelineActiveColorClip(colorLayer, 1)).toBe(clip);
  expect(timelineColorClipOpacity(colorLayer, clip, 1)).toBe(0);
  expect(timelineColorClipOpacity(colorLayer, clip, 1.5)).toBeCloseTo(0.2);
  expect(timelineColorClipOpacity(colorLayer, clip, 2)).toBeCloseTo(0.4);
  expect(timelineColorClipOpacity(colorLayer, clip, 4.5)).toBeCloseTo(0.2);
  expect(timelineActiveColorClip(colorLayer, 5)).toBe(clip);
  expect(timelineColorClipOpacity(colorLayer, clip, 5)).toBe(0);
  expect(timelineActiveColorClip(colorLayer, 5.01)).toBeNull();
  expect(timelineBlendModeCss("normal")).toBe("normal");
  expect(timelineBlendModeCss("multiply")).toBe("multiply");
  expect(timelineBlendModeCss("screen")).toBe("screen");
  expect(timelineBlendModeCss("additive")).toBe("plus-lighter");
});

test("legacy timeline normalization defaults color fields and removes same-track overlaps", () => {
  const normalized = normalizeSpineTimeline({
    duration: 4,
    layers: [{ directory: "Layer_home", role: "character" }],
    colorLayers: [{ id: "wash", clips: [
      { id: "one", start: 0, end: 2, fadeIn: 8, fadeOut: 8 },
      { id: "two", start: 1, end: 3, color: "not-a-color" },
    ] }],
  });
  expect(normalized?.colorLayers?.[0]).toMatchObject({ enabled: true, locked: false, opacity: 1, blendMode: "normal" });
  expect(normalized?.colorLayers?.[0]?.clips.map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 4]]);
  expect(normalized?.colorLayers?.[0]?.clips[0]).toMatchObject({ color: "#000000", fadeIn: 1, fadeOut: 1 });
  expect(timelineVisualLayers(normalized!).map(({ kind, layer }) => `${kind}:${layer.id}`)).toEqual(["spine:timeline-layer-1", "color:wash"]);
});

test("visual reordering never changes the original Spine reference camera layer", () => {
  const timeline = {
    layers: [
      layer({ id: "character", directory: "A_home", role: "character", order: 0 }),
      layer({ id: "background", directory: "A_bg", role: "background", order: 5 }),
    ],
  };
  expect(timelineVisualLayers(timeline).map(({ layer }) => layer.id)).toEqual(["character", "background"]);
  expect(timelineReferenceLayerId(timeline)).toBe("character");
  expect(timelineReferenceLayerId({ ...timeline, camera: { referenceLayerId: "background" } as SpineTimeline["camera"] })).toBe("background");
  expect(timelineReferenceLayerId({ ...timeline, camera: { referenceLayerId: "missing" } as SpineTimeline["camera"] })).toBe("character");
  const reordered = { layers: timeline.layers.map((layer) => layer.id === "character" ? { ...layer, order: 5 } : { ...layer, order: 0 }) };
  expect(timelineVisualLayers(reordered).map(({ layer }) => layer.id)).toEqual(["background", "character"]);
  expect(timelineReferenceLayerId(reordered)).toBe("character");
  expect(timelineReferenceLayerId({ layers: [{ ...timeline.layers[1]!, order: 5 }, { ...timeline.layers[0]!, role: "overlay", order: 0 }] })).toBe("background");
});

test("enabled color clip endpoints drive automatic opening duration, disabled clips do not", () => {
  const timeline = {
    sequenceId: "opening",
    durationMode: "auto" as const,
    duration: 12,
    layers: [],
    subtitles: [],
    audio: [],
    colorLayers: [{ id: "enabled", name: "Enabled", enabled: true, locked: false, opacity: 1, order: 0, blendMode: "normal" as const, clips: [{ id: "last", name: "Last", color: "#000000", start: 2, end: 7, opacity: 1, fadeIn: 0, fadeOut: 0, enabled: true }] }],
  };
  expect(timelineOpeningDuration(timeline, 0)).toBe(7);
  expect(timelinePlaybackDuration(timeline)).toBe(7);
  const hidden = { ...timeline, colorLayers: [{ ...timeline.colorLayers[0]!, enabled: false }] };
  expect(timelineOpeningDuration(hidden, 0)).toBe(1);
  expect(timelinePlaybackDuration(hidden)).toBe(1);
  const shortened = { ...timeline, colorLayers: [{ ...timeline.colorLayers[0]!, clips: [{ ...timeline.colorLayers[0]!.clips[0]!, end: 4 }] }] };
  expect(timelinePlaybackDuration(shortened)).toBe(4);
  const deleted = { ...timeline, colorLayers: [{ ...timeline.colorLayers[0]!, clips: [] }] };
  expect(timelinePlaybackDuration(deleted)).toBe(1);
  expect(timelinePlaybackDuration({ ...timeline, durationMode: "manual", duration: 4 })).toBe(4);
});

test("timeline audio playback only seeks when entering or rewinding", () => {
  expect(timelineAudioPlaybackDecision({ active: true, playing: true, currentTime: 2, previousTime: 1.9, started: true, ended: false })).toEqual({ seek: false, play: true, started: true });
  expect(timelineAudioPlaybackDecision({ active: true, playing: true, currentTime: 1, previousTime: 2, started: true, ended: true })).toEqual({ seek: true, play: true, started: true });
  expect(timelineAudioPlaybackDecision({ active: false, playing: true, currentTime: 3, previousTime: 2, started: true, ended: false })).toEqual({ seek: false, play: false, started: false });
});

test("timeline playback waits for enabled audio preloads but tolerates missing clips", () => {
  const clips = [
    { id: "ready", enabled: true },
    { id: "missing", enabled: true },
    { id: "disabled", enabled: false },
  ];
  expect(timelineAudioPreloadsReady(clips, { ready: "ready", missing: "missing", disabled: "loading" })).toBe(true);
  expect(timelineAudioPreloadsReady(clips, { ready: "loading", missing: "missing", disabled: "loading" })).toBe(false);
  expect(timelineAudioPreloadsReady([], {})).toBe(true);
});

test("talk animation underlay behavior is shared by both previews", () => {
  expect(timelineAnimationNeedsIdleUnderlay("Talk_01_M")).toBe(true);
  expect(timelineAnimationNeedsIdleUnderlay("Idle")).toBe(false);
});

test("timeline normalization preserves valid authored camera tracks and clips out-of-range keys", () => {
  const normalized = normalizeSpineTimeline({
    sequenceId: "opening",
    duration: 4,
    layers: [],
    camera: {
      enabled: true,
      aspectRatio: "4:3",
      constraint: { mode: "manual", boundId: "room" },
      safeBounds: [{ id: "room", name: "Room", x: -10, y: -20, width: 200, height: 160, enabled: true }],
      keyframes: [
        { id: "start", time: 0, centerX: 0, centerY: 0, frameHeight: 100, easing: "smooth" },
        { id: "end", time: 5, centerX: 10, centerY: 20, frameHeight: 150 },
      ],
    },
  });
  expect(normalized?.camera?.aspectRatio).toBe("4:3");
  expect(normalized?.camera?.constraint).toEqual({ mode: "manual", boundId: "room" });
  expect(normalized?.camera?.keyframes.map(({ id }) => id)).toEqual(["start"]);
});

test("camera history carries the latest enabled safe boundary into later sequences", () => {
  const opening = normalizeSpineTimeline({
    sequenceId: "opening",
    camera: {
      enabled: true,
      aspectRatio: "16:9",
      constraint: { mode: "manual", boundId: "opening-bound" },
      safeBounds: [{ id: "opening-bound", name: "Opening", x: -100, y: -200, width: 400, height: 600, enabled: true }],
      keyframes: [{ id: "opening-shot", time: 2, centerX: 0, centerY: 0, frameHeight: 200 }],
    },
  })!;
  const talkWithoutBounds = normalizeSpineTimeline({
    sequenceId: "talk-1",
    camera: {
      enabled: true,
      aspectRatio: "4:3",
      constraint: { mode: "automatic" },
      safeBounds: [],
      keyframes: [{ id: "talk-shot", time: 1, centerX: 10, centerY: 20, frameHeight: 180 }],
    },
  })!;

  expect(timelineLastDefinedCameraTrack([opening, talkWithoutBounds])).toMatchObject({
    sequenceId: "talk-1",
    track: {
      aspectRatio: "4:3",
      keyframes: [{ id: "talk-shot" }],
      safeBounds: [{ id: "opening-bound" }],
    },
  });
  expect(timelineLastDefinedCameraTrack([opening])?.track.safeBounds[0]?.id).toBe("opening-bound");
});

test("enabled audio and subtitle endpoints can extend a full-sequence Talk", () => {
  expect(timelineAuthoredCueEnd({
    audio: [
      { id: "voice", name: "voice", path: "voice.ogg", start: 1, end: 8, enabled: true, volume: 1 },
      { id: "disabled", name: "disabled", path: "disabled.ogg", start: 0, end: 20, enabled: false, volume: 1 },
    ],
    subtitles: [
      { id: "subtitle", start: 1, end: 9, enabled: true, text: { en: "Hello", ja: "", ko: "" } },
    ],
  })).toBe(9);
});
