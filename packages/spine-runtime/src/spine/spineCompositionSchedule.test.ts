import { expect, test } from "bun:test";
import { compositionEvaluationContextAt, compositionTargetKey, createEmptySpineComposition, defaultTalkSectionRoute, evaluateComposition, evaluateCompositionFrame } from "./spineComposition";
import { compositionCameraTrackAt, compositionFrameToTimeline } from "./spineCompositionTimeline";
import { sampleSpineCameraTrack } from "./spineCameraMotion";
import { compositionScheduleSampleAt, createCanonicalCompositionSchedule, createCompositionArrangementSchedule } from "./spineCompositionSchedule";

function fixture() {
  const composition = createEmptySpineComposition("schedule-test", "Schedule test", 12, 30);
  composition.layers.push({
    id: "character", name: "Character", role: "character", order: 0, assetDirectory: "character", assetIdentity: "asset:character",
    transformParentId: null, baseProperties: { "layer.position.x": 0 }, enabled: true, locked: false,
  }, {
    id: "background", name: "Background", role: "background", order: -1, assetDirectory: "background", assetIdentity: "asset:background",
    transformParentId: null, baseProperties: { "layer.position.x": 0 }, enabled: true, locked: false,
  });
  composition.sections.push(
    { id: "idle", name: "Idle", start: 0, end: 2, route: { ...defaultTalkSectionRoute("idle"), role: "idle", returnToSectionId: null } },
    { id: "talk-a", name: "Talk A", start: 3, end: 5, route: defaultTalkSectionRoute("idle") },
    { id: "talk-b", name: "Talk B", start: 8, end: 10, route: defaultTalkSectionRoute("idle") },
  );
  composition.propertyTracks.push({
    id: "character-local", target: { kind: "layer", layerId: "character" }, property: "layer.position.x", clock: { kind: "section-instance", sectionId: "talk-a" },
    enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
    keys: [{ id: "start", time: 0, value: 10, interpolation: "linear" }, { id: "end", time: 2, value: 20, interpolation: "linear" }],
  }, {
    id: "background-global", target: { kind: "layer", layerId: "background" }, property: "layer.position.x", clock: { kind: "composition" },
    enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
    keys: [{ id: "start", time: 0, value: 0, interpolation: "linear" }, { id: "end", time: 12, value: 12, interpolation: "linear" }],
  });
  composition.camera = {
    enabled: true,
    aspectRatio: "16:9",
    constraint: { mode: "automatic" },
    safeBounds: [],
    keyframes: [
      { id: "camera-start", time: 0, centerX: 0, centerY: 0, frameHeight: 10, easing: "linear" },
      { id: "camera-end", time: 12, centerX: 120, centerY: 24, frameHeight: 34, easing: "linear" },
    ],
  };
  composition.propertyTracks.push({
    id: "camera-center-x", target: { kind: "camera" }, property: "camera.centerX", clock: { kind: "composition" },
    enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
    keys: [{ id: "camera-offset", time: 0, value: 8, interpolation: "step" }],
  });
  return composition;
}

test("canonical composition schedule is one exact authored-range segment", () => {
  expect(createCanonicalCompositionSchedule(4.25, 60)).toEqual({
    frameRate: 60,
    duration: 4.25,
    persistentTimeMapping: "continuous-output",
    segments: [{ id: "composition", kind: "composition", start: 0, duration: 4.25, sectionTimeStart: 0, sourceTimeStart: 0 }],
  });
});

test("arrangement schedule composes section instances, repeated idle loops, and explicit gaps", () => {
  const composition = fixture();
  const schedule = createCompositionArrangementSchedule(composition, {
    sectionIds: ["talk-b", "talk-a"],
    idleSectionId: "idle",
    initialIdleLoops: 1,
    betweenSectionIdleSeconds: 2.5,
    finalIdleLoops: 0,
    persistentTimeMapping: "continuous-output",
  });
  expect(schedule.segments.map(({ kind, sectionId, start, duration, sourceTimeStart }) => [kind, sectionId, start, duration, sourceTimeStart])).toEqual([
    ["initial-idle", "idle", 0, 2, 0],
    ["section", "talk-b", 2, 2, 8],
    ["between-idle", "idle", 4, 2, 0],
    ["between-idle", "idle", 6, 0.5, 0],
    ["section", "talk-a", 6.5, 2, 3],
  ]);
  expect(schedule.duration).toBe(8.5);
  expect(compositionScheduleSampleAt(composition, schedule, 3)).toMatchObject({
    outputTime: 3,
    sourceTime: 9,
    sectionLocalTime: 1,
    sectionInstanceStartTimes: { "talk-b": 2 },
    globalTimeOffset: -6,
    context: { compositionTime: 9, transportTime: 3, persistentTime: 3, sectionInstanceTimes: { "talk-b": 1 }, activeSectionId: "talk-b" },
  });
});

test("arrangement contexts keep section-local content while persistent backgrounds follow selected time mapping", () => {
  const composition = fixture();
  const continuous = createCompositionArrangementSchedule(composition, {
    sectionIds: ["talk-a"], idleSectionId: null, initialIdleLoops: 0, finalIdleLoops: 0, persistentTimeMapping: "continuous-output",
  });
  const continuousSample = compositionScheduleSampleAt(composition, continuous, 1)!;
  const continuousEvaluation = evaluateComposition(composition, continuousSample.context);
  expect(continuousEvaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: "character" }, "layer.position.x"))).toBe(15);
  expect(continuousEvaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: "background" }, "layer.position.x"))).toBe(1);

  const authored = createCompositionArrangementSchedule(composition, {
    sectionIds: ["talk-a"], idleSectionId: null, initialIdleLoops: 0, finalIdleLoops: 0, persistentTimeMapping: "original-authored-time",
  });
  const authoredSample = compositionScheduleSampleAt(composition, authored, 1)!;
  const authoredEvaluation = evaluateComposition(composition, authoredSample.context);
  expect(authoredEvaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: "character" }, "layer.position.x"))).toBe(15);
  expect(authoredEvaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: "background" }, "layer.position.x"))).toBe(4);
});

test("unfilled arrangement gaps evaluate global composition clocks on output time", () => {
  const composition = fixture();
  const schedule = createCompositionArrangementSchedule(composition, {
    sectionIds: ["talk-a", "talk-b"], idleSectionId: null, initialIdleLoops: 0, betweenSectionIdleSeconds: 0.5, finalIdleLoops: 0,
  });
  const sample = compositionScheduleSampleAt(composition, schedule, 2.25)!;
  expect(sample.segment.kind).toBe("gap");
  expect(sample.segment.sourceTimeStart).toBeNull();
  expect(sample).toMatchObject({ outputTime: 2.25, sourceTime: 2.25, context: { compositionTime: 2.25, transportTime: 2.25, persistentTime: 2.25 } });
});

test("invalid arrangement section references and empty schedules fail before rendering", () => {
  const composition = fixture();
  expect(() => createCompositionArrangementSchedule(composition, { sectionIds: ["missing"] })).toThrow("missing section");
  expect(() => createCompositionArrangementSchedule(composition, { sectionIds: ["talk-a", "talk-a"] })).toThrow("repeats section");
  expect(() => createCompositionArrangementSchedule(composition, { sectionIds: [], idleSectionId: null })).toThrow("at least one");
});

test("canonical schedule frames preserve evaluator and Viewer timeline parity at exact sample times", () => {
  const composition = fixture();
  const schedule = createCanonicalCompositionSchedule(composition.duration, composition.frameRate);
  for (const time of [0, 1 / composition.frameRate, 3.5, 8.25, composition.duration]) {
    const direct = evaluateCompositionFrame(composition, compositionEvaluationContextAt(composition, time, time));
    const scheduledSample = compositionScheduleSampleAt(composition, schedule, time)!;
    const scheduled = evaluateCompositionFrame(composition, scheduledSample.context);
    expect(scheduled.layers.map(({ layer, transform, animationClips }) => [layer.id, transform, animationClips])).toEqual(
      direct.layers.map(({ layer, transform, animationClips }) => [layer.id, transform, animationClips]),
    );
    const directCamera = compositionCameraTrackAt(composition, direct, direct.evaluation.time);
    const scheduledCamera = compositionCameraTrackAt(composition, scheduled, scheduled.evaluation.time);
    expect(directCamera).not.toBeNull();
    expect(sampleSpineCameraTrack(scheduledCamera!, time)).toEqual(sampleSpineCameraTrack(directCamera!, time));
    expect(compositionFrameToTimeline(composition, scheduled, time, "en", scheduledSample.sectionInstanceStartTimes, undefined, scheduledSample.globalTimeOffset))
      .toEqual(compositionFrameToTimeline(composition, direct, time, "en"));
  }
});

test("dense schedule fixture evaluates fixed output samples without timing drift", () => {
  const composition = createEmptySpineComposition("dense-schedule", "Dense schedule", 3, 30);
  for (let layerIndex = 0; layerIndex < 32; layerIndex += 1) {
    const layerId = `layer-${layerIndex}`;
    composition.layers.push({
      id: layerId, name: layerId, role: "background", order: layerIndex, assetDirectory: layerId, assetIdentity: `asset:${layerId}`,
      transformParentId: null, baseProperties: { "layer.position.x": 0 }, enabled: true, locked: false,
    });
    for (let trackIndex = 0; trackIndex < 8; trackIndex += 1) {
      composition.propertyTracks.push({
        id: `${layerId}-track-${trackIndex}`, target: { kind: "layer", layerId }, property: "layer.position.x", clock: { kind: "composition" },
        enabled: true, priority: trackIndex, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
        keys: Array.from({ length: 8 }, (_, keyIndex) => ({
          id: `${layerId}-${trackIndex}-key-${keyIndex}`,
          time: keyIndex * 3 / 7,
          value: layerIndex + trackIndex + keyIndex,
          interpolation: "linear" as const,
        })),
      });
    }
  }
  const schedule = createCanonicalCompositionSchedule(composition.duration, composition.frameRate);
  const started = performance.now();
  let sampledFrames = 0;
  for (let frameIndex = 0; frameIndex < 90; frameIndex += 1) {
    const time = frameIndex / composition.frameRate;
    const sample = compositionScheduleSampleAt(composition, schedule, time);
    expect(sample).not.toBeNull();
    const evaluated = evaluateComposition(composition, sample!.context);
    expect(evaluated.propertyContributions.length).toBe(256);
    sampledFrames += 1;
  }
  expect(sampledFrames).toBe(90);
  expect(performance.now() - started).toBeLessThan(15_000);
});
