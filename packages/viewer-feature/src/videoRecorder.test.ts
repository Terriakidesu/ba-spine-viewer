import { describe, expect, test } from "bun:test";
import { createCompositionArrangementRecordingPlan, createFullSequenceRecordingPlan, createUnifiedCompositionRecordingPlan, createVideoRecordingPlan, detectSupportedVideoFormats, normalizeVideoRecordingQuality, readVideoRecordingQuality, VIDEO_RECORDING_QUALITY_STORAGE_KEY, VIDEO_RECORDING_SUBTITLE_SELECTOR, videoFilenameStem, videoFrameTargetCount, videoRecordingAudioSchedule, videoRecordingCompositionGainAutomation, videoRecordingCompositionScheduleAudioSpans, videoRecordingCompositionScheduleSubtitleSpans, videoRecordingCompositionSubtitleSpans, videoRecordingDimensions, videoRecordingFrameCount, videoRecordingGlobalTime, videoRecordingProgress, videoRecordingResolutionScale, videoRecordingSegmentAt, videoRecordingSegmentStart, videoRecordingSubtitleSpans, videoRecordingTimelineOffsets, writeVideoRecordingQuality } from "./videoRecorder";
import { compositionEvaluationContextAt, createEmptySpineComposition, evaluateCompositionFrame } from "@ba-spine/spine-runtime/spine/spineComposition";
import { compositionCameraTrackAt, compositionFrameToTimeline } from "@ba-spine/spine-runtime/spine/spineCompositionTimeline";
import { evaluateSpineCameraTrack, sampleSpineCameraTrack } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import { compositionScheduleSampleAt } from "@ba-spine/spine-runtime/spine/spineCompositionSchedule";

describe("Viewer video quality preference", () => {
  test("defaults safely and persists a validated quality preset", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(readVideoRecordingQuality(storage)).toBe("balanced");
    expect(normalizeVideoRecordingQuality("unknown")).toBe("balanced");
    writeVideoRecordingQuality("high", storage);
    expect(values.get(VIDEO_RECORDING_QUALITY_STORAGE_KEY)).toBe("high");
    expect(readVideoRecordingQuality(storage)).toBe("high");
    writeVideoRecordingQuality("unknown", storage);
    expect(readVideoRecordingQuality(storage)).toBe("balanced");
  });
});

describe("Viewer video recording plans", () => {
  test("captures dialogue and behavior subtitles in exported frames", () => {
    expect(VIDEO_RECORDING_SUBTITLE_SELECTOR).toContain(".spine-dialogue");
    expect(VIDEO_RECORDING_SUBTITLE_SELECTOR).toContain(".spine-behavior-subtitle");
  });

  test("counts the opening once and stops at the requested idle-loop boundary", () => {
    const plan = createVideoRecordingPlan("opening-idle", 5.5, 2, 3);
    expect(plan.totalDuration).toBe(11.5);
    expect(videoRecordingProgress(plan, 5.49)).toMatchObject({ phase: "opening", idleLoopsCompleted: 0, finished: false });
    expect(videoRecordingProgress(plan, 9.5)).toMatchObject({ phase: "idle", idleLoopsCompleted: 2, finished: false });
    expect(videoRecordingProgress(plan, 11.5)).toMatchObject({ phase: "idle", idleLoopsCompleted: 3, fraction: 1, finished: true });
  });

  test("idle-only mode does not include opening time and clamps loop counts", () => {
    const plan = createVideoRecordingPlan("idle-only", 7, 1.25, 99);
    expect(plan).toEqual({ mode: "idle-only", openingDuration: 7, idleDuration: 1.25, idleLoops: 20, totalDuration: 25 });
    expect(videoRecordingProgress(plan, 2.5)).toMatchObject({ phase: "idle", idleLoopsCompleted: 2, total: 25 });
  });

  test("full-sequence plans Talks in the authored order", () => {
    const plan = createFullSequenceRecordingPlan({
      openingDuration: 4,
      idleDuration: 3,
      openingSequenceId: "opening",
      idleSequenceId: "opening",
      includeOpening: true,
      initialIdleLoops: 1,
      betweenTalkIdleSeconds: 0.5,
      finalIdleLoops: 1,
      talks: [
        { sequenceId: "talk-10", duration: 10 },
        { sequenceId: "talk-2", duration: 9 },
        { sequenceId: "talk-1", duration: 8 },
      ],
      selectedTalkSequenceIds: ["talk-1", "talk-2", "talk-10"],
    });
    expect(plan.totalDuration).toBe(38);
    expect(plan.segments?.map(({ kind, sequenceId }) => [kind, sequenceId])).toEqual([
      ["opening", "opening"],
      ["initial-idle", "opening"],
      ["talk", "talk-10"],
      ["between-idle", "opening"],
      ["talk", "talk-2"],
      ["between-idle", "opening"],
      ["talk", "talk-1"],
      ["final-idle", "opening"],
    ]);
    expect(videoRecordingSegmentAt(plan, 7.25)).toMatchObject({ index: 2, segment: { kind: "talk", sequenceId: "talk-10" }, elapsed: 0.25 });
    expect(videoRecordingProgress(plan, 36)).toMatchObject({ phase: "final-idle", segmentElapsed: 1, finished: false });
    expect(videoRecordingSegmentStart(plan, 2)).toBe(7);
    expect(videoRecordingGlobalTime(plan, 2, 0.25)).toBe(7.25);
    expect(videoRecordingGlobalTime(plan, 3, 0)).toBe(17);
    expect(videoRecordingGlobalTime(plan, 2, 8)).toBe(15);
  });

  test("uses the canonical composition duration instead of rebuilding a legacy arrangement", () => {
    const plan = createUnifiedCompositionRecordingPlan(12.5);
    expect(plan).toEqual({
      mode: "full-sequence",
      openingDuration: 12.5,
      idleDuration: 0.01,
      idleLoops: 1,
      totalDuration: 12.5,
      segments: [{ kind: "composition", sequenceId: "__unified-composition__", duration: 12.5 }],
      compositionSchedule: {
        duration: 12.5,
        frameRate: 30,
        persistentTimeMapping: "continuous-output",
        segments: [{ id: "composition", kind: "composition", start: 0, duration: 12.5, sectionTimeStart: 0, sourceTimeStart: 0 }],
      },
    });
    expect(videoRecordingSegmentAt(plan, 8)).toMatchObject({ index: 0, segment: { kind: "composition" }, elapsed: 8 });
  });

  test("canonical Viewer export plan preserves Timeline and Camera sample parity", () => {
    const composition = createEmptySpineComposition("export-parity", "Export parity", 4, 30);
    composition.layers.push({
      id: "character", name: "Character", role: "character", order: 0, assetDirectory: "character", assetIdentity: "asset:character",
      transformParentId: null, baseProperties: { "layer.position.x": 0 }, enabled: true, locked: false,
    });
    composition.propertyTracks.push({
      id: "character-x", target: { kind: "layer", layerId: "character" }, property: "layer.position.x", clock: { kind: "composition" },
      enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
      keys: [{ id: "character-start", time: 0, value: 0, interpolation: "linear" }, { id: "character-end", time: 4, value: 40, interpolation: "linear" }],
    }, {
      id: "camera-x", target: { kind: "camera" }, property: "camera.centerX", clock: { kind: "composition" },
      enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
      keys: [{ id: "camera-offset-start", time: 0, value: 5, interpolation: "linear" }, { id: "camera-offset-end", time: 4, value: 25, interpolation: "linear" }],
    });
    composition.camera = {
      enabled: true,
      aspectRatio: "16:9",
      constraint: { mode: "none" },
      safeBounds: [],
      keyframes: [
        { id: "camera-start", time: 0, centerX: 0, centerY: 10, frameHeight: 12, easing: "linear" },
        { id: "camera-end", time: 4, centerX: 40, centerY: 30, frameHeight: 20, easing: "linear" },
      ],
    };

    const plan = createUnifiedCompositionRecordingPlan(composition.duration, composition.frameRate);
    const schedule = plan.compositionSchedule!;
    for (const time of [0, 1 / composition.frameRate, 1.125, 2.75, composition.duration]) {
      const direct = evaluateCompositionFrame(composition, compositionEvaluationContextAt(composition, time, time));
      const exportSample = compositionScheduleSampleAt(composition, schedule, time)!;
      const scheduled = evaluateCompositionFrame(composition, exportSample.context);
      const directTimeline = compositionFrameToTimeline(composition, direct, time, "en");
      const scheduledTimeline = compositionFrameToTimeline(
        composition,
        scheduled,
        time,
        "en",
        exportSample.sectionInstanceStartTimes,
        exportSample.segment.sectionId,
        exportSample.globalTimeOffset,
      );
      expect(scheduledTimeline).toEqual(directTimeline);

      const directCamera = compositionCameraTrackAt(composition, direct, direct.evaluation.time);
      const scheduledCamera = compositionCameraTrackAt(composition, scheduled, scheduled.evaluation.time);
      expect(scheduledCamera).not.toBeNull();
      expect(evaluateSpineCameraTrack(scheduledCamera!, time, 1920, 1080, null)).toEqual(
        evaluateSpineCameraTrack(directCamera!, time, 1920, 1080, null),
      );
    }
  });

  test("arrangement export keeps section-local camera keys on the shared output schedule", () => {
    const composition = createEmptySpineComposition("arrangement-camera", "Arrangement camera", 10, 30);
    composition.sections.push({ id: "shot", name: "Shot", start: 5, end: 7 });
    composition.camera = {
      enabled: true,
      aspectRatio: "16:9",
      constraint: { mode: "none" },
      safeBounds: [],
      keyframes: [
        { id: "camera-start", time: 0, centerX: 0, centerY: 0, frameHeight: 10, easing: "linear" },
        { id: "camera-end", time: 10, centerX: 10, centerY: 10, frameHeight: 20, easing: "linear" },
      ],
    };
    composition.propertyTracks.push({
      id: "shot-camera-x", target: { kind: "camera" }, property: "camera.centerX", clock: { kind: "section-instance", sectionId: "shot" },
      enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
      keys: [{ id: "shot-start", time: 0, value: 10, interpolation: "linear" }, { id: "shot-end", time: 2, value: 30, interpolation: "linear" }],
    });
    const plan = createCompositionArrangementRecordingPlan(composition, {
      sectionIds: ["shot"], idleSectionId: null, initialIdleLoops: 0, finalIdleLoops: 0,
    });
    const sample = compositionScheduleSampleAt(composition, plan.compositionSchedule!, 0.75)!;
    expect(sample).toMatchObject({
      outputTime: 0.75,
      sourceTime: 5.75,
      sectionLocalTime: 0.75,
      sectionInstanceStartTimes: { shot: 0 },
    });
    const frame = evaluateCompositionFrame(composition, sample.context);
    const cameraTrack = compositionCameraTrackAt(composition, frame, frame.evaluation.time);
    expect(cameraTrack).not.toBeNull();
    expect(sampleSpineCameraTrack(cameraTrack!, frame.evaluation.time)?.centerX).toBeCloseTo(17.5);
    expect(evaluateSpineCameraTrack(cameraTrack!, frame.evaluation.time, 1920, 1080, null)?.frame.centerX).toBeCloseTo(17.5);
  });

  test("composition arrangement plans are shared schedules with section instances and idle gaps", () => {
    const composition = createEmptySpineComposition("canonical", "Canonical", 10, 30);
    composition.sections = [
      { id: "idle", name: "Idle", start: 0, end: 2, route: { role: "idle", returnToSectionId: null, ownedChannels: [], duplicateTrigger: "ignore", interruption: "replace", blendIn: 0, blendOut: 0, cameraReturn: "persistent" } },
      { id: "talk", name: "Talk", start: 3, end: 5, route: { role: "talk", returnToSectionId: "idle", ownedChannels: ["body", "audio", "subtitles"], duplicateTrigger: "ignore", interruption: "replace", blendIn: 0, blendOut: 0, cameraReturn: "blend" } },
      { id: "scene", name: "Scene", start: 7, end: 8 },
    ];
    composition.audio = [
      { id: "global", name: "Global", path: "global.wav", start: 3.5, end: 4.5, sourceOffset: 1, volume: 0.8, enabled: true },
      { id: "voice", name: "Voice", path: "voice.wav", start: 0.5, end: 1.5, sourceOffset: 0, volume: 1, enabled: true, sectionId: "talk" },
    ];
    composition.subtitles = [
      { id: "global-cue", start: 3.5, end: 4.5, enabled: true, text: { en: "Global", ja: "全体", ko: "전체" } },
      { id: "talk-cue", start: 0.5, end: 1.5, enabled: true, text: { en: "Talk", ja: "会話", ko: "대화" }, sectionId: "talk" },
    ];
    composition.propertyTracks = [{
      id: "voice-gain", target: { kind: "audio", audioId: "voice" }, property: "audio.volume", clock: { kind: "section-instance", sectionId: "talk" },
      enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: true, holdAfter: true,
      keys: [{ id: "quiet", time: 0, value: 0.2, interpolation: "linear" }, { id: "loud", time: 2, value: 0.8, interpolation: "linear" }],
    }];
    const plan = createCompositionArrangementRecordingPlan(composition, {
      sectionIds: ["talk", "scene"], idleSectionId: "idle", initialIdleLoops: 1, betweenSectionIdleSeconds: 0.5, finalIdleLoops: 0,
    });
    expect(plan.totalDuration).toBe(5.5);
    expect(plan.segments?.map((segment) => [segment.kind, segment.sectionId, segment.duration])).toEqual([
      ["initial-idle", "idle", 2],
      ["composition-section", "talk", 2],
      ["between-idle", "idle", 0.5],
      ["composition-section", "scene", 1],
    ]);
    const schedule = plan.compositionSchedule!;
    const audioSpans = videoRecordingCompositionScheduleAudioSpans(composition, schedule, 2);
    expect(audioSpans.map(({ clip, start, end, sourceOffset }) => [clip.id, start, end, sourceOffset])).toEqual([
      ["global", 2.5, 3.5, 1],
      ["voice", 2.5, 3.5, 0],
    ]);
    expect(audioSpans[1]?.gainAutomation?.map((point) => point.time)).toEqual([0, 1]);
    expect(audioSpans[1]?.gainAutomation?.[0]?.volume).toBeCloseTo(0.35);
    expect(audioSpans[1]?.gainAutomation?.[1]?.volume).toBeCloseTo(0.65);
    expect(videoRecordingCompositionScheduleSubtitleSpans(composition, schedule, "en")).toMatchObject([
      { text: "Global", start: 2.5, end: 3.5 },
      { text: "Talk", start: 2.5, end: 3.5 },
    ]);
  });

  test("global cues in unfilled arrangement gaps follow the output-time evaluator clock", () => {
    const composition = createEmptySpineComposition("gap-cues", "Gap cues", 8, 30);
    composition.sections = [
      { id: "first", name: "First", start: 0, end: 1 },
      { id: "second", name: "Second", start: 4, end: 5 },
    ];
    composition.audio = [{ id: "global", name: "Global", path: "global.wav", start: 1.1, end: 1.4, sourceOffset: 0, volume: 1, enabled: true }];
    composition.subtitles = [{ id: "global-cue", start: 1.1, end: 1.4, enabled: true, text: { en: "Gap", ja: "", ko: "" } }];
    const plan = createCompositionArrangementRecordingPlan(composition, {
      sectionIds: ["first", "second"], idleSectionId: null, initialIdleLoops: 0, betweenSectionIdleSeconds: 0.5, finalIdleLoops: 0,
    });

    expect(videoRecordingCompositionScheduleAudioSpans(composition, plan.compositionSchedule!, 30).map(({ start, end }) => [start, end])).toEqual([[1.1, 1.4]]);
    expect(videoRecordingCompositionScheduleSubtitleSpans(composition, plan.compositionSchedule!, "en")).toMatchObject([
      { text: "Gap", start: 1.1, end: 1.4 },
    ]);
  });

  test("arrangement cues respect each section route's audio and subtitle ownership", () => {
    const composition = createEmptySpineComposition("owned-cues", "Owned cues", 4, 30);
    composition.sections = [{
      id: "visual-only", name: "Visual only", start: 1, end: 3,
      route: { role: "talk", returnToSectionId: null, ownedChannels: ["body"], duplicateTrigger: "ignore", interruption: "replace", blendIn: 0, blendOut: 0, cameraReturn: "persistent" },
    }];
    composition.audio = [{ id: "voice", name: "Voice", path: "voice.wav", start: 0.25, end: 0.75, sourceOffset: 0, volume: 1, enabled: true, sectionId: "visual-only" }];
    composition.subtitles = [{ id: "cue", start: 0.25, end: 0.75, enabled: true, text: { en: "Hidden", ja: "", ko: "" }, sectionId: "visual-only" }];
    const plan = createCompositionArrangementRecordingPlan(composition, {
      sectionIds: ["visual-only"], idleSectionId: null, initialIdleLoops: 0, finalIdleLoops: 0,
    });

    expect(videoRecordingCompositionScheduleAudioSpans(composition, plan.compositionSchedule!, 30)).toEqual([]);
    expect(videoRecordingCompositionScheduleSubtitleSpans(composition, plan.compositionSchedule!, "en")).toEqual([]);
  });

  test("maps Opening and Talk cue timelines onto one clock without replaying idle cues", () => {
    const opening = { sequenceId: "opening" } as never;
    const talk = { sequenceId: "talk-1" } as never;
    const plan = createFullSequenceRecordingPlan({
      openingDuration: 4,
      idleDuration: 2,
      openingSequenceId: "opening",
      idleSequenceId: "opening",
      includeOpening: true,
      initialIdleLoops: 1,
      betweenTalkIdleSeconds: 1,
      finalIdleLoops: 1,
      talks: [{ sequenceId: "talk-1", duration: 3 }, { sequenceId: "talk-2", duration: 2 }],
      selectedTalkSequenceIds: ["talk-1", "talk-2"],
    });
    const offsets = videoRecordingTimelineOffsets(plan, {
      timeline: opening,
      sequences: { "talk-1": talk, "talk-2": { sequenceId: "talk-2" } as never },
    });
    expect(offsets.map(({ timeline, start }) => [timeline.sequenceId, start])).toEqual([
      ["opening", 0],
      ["talk-1", 6],
      ["talk-2", 10],
    ]);
  });

  test("maps enabled subtitles from selected Opening and Talk segments and stacks overlaps", () => {
    const opening = {
      sequenceId: "opening",
      language: "en",
      subtitles: [
        { id: "opening-cue", start: 0.25, end: 1.25, enabled: true, text: { en: "Opening", ja: "", ko: "" } },
        { id: "disabled-cue", start: 1, end: 2, enabled: false, text: { en: "Hidden", ja: "", ko: "" } },
      ],
    } as never;
    const talk1 = {
      sequenceId: "talk-1",
      language: "ja",
      subtitles: [
        { id: "talk-a", start: 0.5, end: 2, enabled: true, text: { en: "First talk", ja: "", ko: "" } },
        { id: "talk-b", start: 1, end: 2.5, enabled: true, text: { en: "Overlapping talk", ja: "", ko: "" } },
        { id: "talk-tail", start: 2.8, end: 9, enabled: true, text: { en: "Clipped talk", ja: "", ko: "" } },
      ],
    } as never;
    const plan = createFullSequenceRecordingPlan({
      openingDuration: 4,
      idleDuration: 2,
      openingSequenceId: "opening",
      idleSequenceId: "opening",
      includeOpening: true,
      initialIdleLoops: 1,
      betweenTalkIdleSeconds: 0.5,
      finalIdleLoops: 1,
      talks: [{ sequenceId: "talk-1", duration: 3 }, { sequenceId: "talk-2", duration: 4 }],
      selectedTalkSequenceIds: ["talk-1"],
    });

    const spans = videoRecordingSubtitleSpans(plan, {
      timeline: opening,
      sequences: { "talk-1": talk1, "talk-2": { sequenceId: "talk-2", language: "en", subtitles: [{ id: "unselected", start: 0, end: 1, enabled: true, text: { en: "Unselected", ja: "", ko: "" } }] } as never },
    });

    expect(spans).toMatchObject([
      { text: "Opening", start: 0.25, end: 1.25, row: 0 },
      { text: "First talk", start: 6.5, end: 8, row: 0 },
      { text: "Overlapping talk", start: 7, end: 8.5, row: 1 },
      { text: "Clipped talk", start: 8.8, end: 9, row: 0 },
    ]);
  });

  test("full-sequence omits unavailable opening, filters unselected Talks, and enforces a settled final idle", () => {
    const plan = createFullSequenceRecordingPlan({
      openingDuration: 5,
      idleDuration: 0.4,
      openingSequenceId: null,
      idleSequenceId: "talk-1",
      includeOpening: true,
      initialIdleLoops: 1,
      betweenTalkIdleSeconds: 0.5,
      finalIdleLoops: 1,
      talks: [{ sequenceId: "talk-1", duration: 3 }, { sequenceId: "talk-2", duration: 4 }],
      selectedTalkSequenceIds: ["talk-1"],
    });
    expect(plan.segments?.map(({ kind }) => kind)).toEqual(["initial-idle", "talk", "final-idle"]);
    expect(plan.segments?.at(-1)?.duration).toBe(1);
    expect(plan.totalDuration).toBe(4.4);
  });

  test("advertises only encoder MIME types reported by the WebView", () => {
    const formats = detectSupportedVideoFormats({
      isTypeSupported: (mimeType) => mimeType === "video/mp4;codecs=avc1.42E01E",
    });
    expect(formats).toEqual([{ format: "mp4", mimeType: "video/mp4;codecs=avc1.42E01E" }]);
    expect(detectSupportedVideoFormats(null)).toEqual([]);
  });

  test("uses even-sized dimensions for supported aspect ratios", () => {
    expect(videoRecordingDimensions(1080, "16:9")).toEqual({ width: 1920, height: 1080 });
    expect(videoRecordingDimensions(1440, "16:9")).toEqual({ width: 2560, height: 1440 });
    expect(videoRecordingDimensions(2160, "16:9")).toEqual({ width: 3840, height: 2160 });
    expect(videoRecordingDimensions(1080, "4:3")).toEqual({ width: 1440, height: 1080 });
    expect(videoRecordingDimensions(720, "4:3")).toEqual({ width: 960, height: 720 });
  });

  test("scales Spine backing pixels to export density after device pixel ratio", () => {
    expect(videoRecordingResolutionScale(960, 540, 3840, 2160, 2)).toBe(2);
    expect(videoRecordingResolutionScale(960, 540, 1920, 1080, 2)).toBe(1);
    expect(videoRecordingResolutionScale(960, 540, 1280, 720, 1)).toBeCloseTo(4 / 3);
    expect(videoRecordingResolutionScale(0, 540, 3840, 2160, 1)).toBe(1);
  });

  test("keeps FFmpeg frame output on an exact fixed-rate frame count", () => {
    expect(videoFrameTargetCount(0, 30, 300)).toBe(1);
    expect(videoFrameTargetCount(0.1, 30, 300)).toBe(4);
    expect(videoFrameTargetCount(1, 60, 60)).toBe(60);
    expect(videoFrameTargetCount(Number.NaN, 30, 300)).toBe(0);
    expect(videoFrameTargetCount(10, 30, 30)).toBe(30);
    expect(videoRecordingFrameCount(1, 30)).toBe(30);
    expect(videoRecordingFrameCount(1.001, 30)).toBe(31);
    expect(videoRecordingFrameCount(Number.NaN, 30)).toBe(0);
  });

  test("keeps authored audio timestamps and clips segments at the video endpoint", () => {
    expect(videoRecordingAudioSchedule(2.25, 8, 0.65, 5)).toEqual({ start: 2.25, duration: 2.75, volume: 0.65, sourceOffset: 0 });
    expect(videoRecordingAudioSchedule(-1, 2, 1.5, 4)).toEqual({ start: 0, duration: 2, volume: 1, sourceOffset: 1 });
    expect(videoRecordingAudioSchedule(0.5, 2.5, 0.8, 4, 3)).toEqual({ start: 0.5, duration: 2, volume: 0.8, sourceOffset: 3 });
    expect(videoRecordingAudioSchedule(5, 6, 1, 5)).toBeNull();
  });

  test("clips gain automation to the scheduled source span and rejects malformed curves", () => {
    const curve = [{ time: 0, volume: 0.2 }, { time: 1, volume: 0.8 }, { time: 2, volume: 0.5 }];
    expect(videoRecordingAudioSchedule(1, 4, 1, 3, 2, curve)).toEqual({
      start: 1,
      duration: 2,
      volume: 1,
      sourceOffset: 2,
      gainAutomation: curve,
    });
    expect(videoRecordingAudioSchedule(1, 4, 1, 3, 2, [{ time: 0, volume: 1 }, { time: 3, volume: 0 }])).toBeNull();
    expect(videoRecordingAudioSchedule(1, 4, 1, 3, 2, [{ time: 0, volume: 1 }, { time: 2, volume: 0 }, { time: 1, volume: 0 }])).toBeNull();
  });

  test("samples canonical audio-volume automation on exact frame times and simplifies linear curves", () => {
    const composition = createEmptySpineComposition("canonical", "Canonical", 2, 2);
    composition.audio = [{ id: "music", name: "Music", path: "music.wav", start: 0, end: 2, sourceOffset: 0, volume: 0.5, enabled: true }];
    composition.propertyTracks = [{
      id: "music-gain",
      target: { kind: "audio", audioId: "music" },
      property: "audio.volume",
      clock: { kind: "composition" },
      enabled: true,
      priority: 0,
      blendMode: "override",
      weight: 1,
      holdBefore: true,
      holdAfter: true,
      keys: [
        { id: "gain-start", time: 0, value: 0.2, interpolation: "linear" },
        { id: "gain-end", time: 2, value: 0.8, interpolation: "linear" },
      ],
    }];

    expect(videoRecordingCompositionGainAutomation(composition, "music", 0, 2, 2, 0.5)).toEqual([
      { time: 0, volume: 0.2 },
      { time: 2, volume: 0.8 },
    ]);
    expect(videoRecordingCompositionGainAutomation(composition, "missing", 0, 2, 2, 0.5)).toBeUndefined();
  });

  test("samples section-instance audio gain tracks against the authored section clock", () => {
    const composition = createEmptySpineComposition("canonical", "Canonical", 4, 2);
    composition.sections = [{ id: "talk", name: "Talk", start: 2, end: 4 }];
    composition.audio = [{ id: "voice", name: "Voice", path: "voice.wav", start: 0, end: 2, sourceOffset: 0, volume: 1, enabled: true, sectionId: "talk" }];
    composition.propertyTracks = [{
      id: "voice-gain",
      target: { kind: "audio", audioId: "voice" },
      property: "audio.volume",
      clock: { kind: "section-instance", sectionId: "talk" },
      enabled: true,
      priority: 0,
      blendMode: "override",
      weight: 1,
      holdBefore: true,
      holdAfter: true,
      keys: [
        { id: "quiet", time: 0, value: 0.25, interpolation: "linear" },
        { id: "loud", time: 2, value: 0.75, interpolation: "linear" },
      ],
    }];
    expect(videoRecordingCompositionGainAutomation(composition, "voice", 2, 4, 2, 1)).toEqual([
      { time: 0, volume: 0.25 },
      { time: 2, volume: 0.75 },
    ]);
  });

  test("maps canonical subtitle cues into the authored range and stacks overlaps", () => {
    const composition = createEmptySpineComposition("canonical", "Canonical", 6);
    composition.sections = [{ id: "talk", name: "Talk", start: 2, end: 5 }];
    composition.subtitles = [
      { id: "first", start: 0.5, end: 2, enabled: true, text: { en: "First", ja: "最初", ko: "첫 번째" } },
      { id: "second", start: 1, end: 3, enabled: true, text: { en: "Second", ja: "二番目", ko: "두 번째" } },
      { id: "tail", start: 3.5, end: 5, enabled: true, text: { en: "Tail", ja: "末尾", ko: "끝" } },
      { id: "disabled", start: 0, end: 1, enabled: false, text: { en: "Hidden", ja: "", ko: "" } },
      { id: "talk-local", start: 0.25, end: 1, enabled: true, text: { en: "Talk", ja: "話", ko: "대화" }, sectionId: "talk" },
    ];
    expect(videoRecordingCompositionSubtitleSpans(composition, "ja")).toEqual([
      { id: "canonical:first", text: "最初", start: 0.5, end: 2, row: 0 },
      { id: "canonical:second", text: "二番目", start: 1, end: 3, row: 1 },
      { id: "canonical:talk-local", text: "話", start: 2.25, end: 3, row: 0 },
      { id: "canonical:tail", text: "末尾", start: 3.5, end: 5, row: 0 },
    ]);
  });

  test("keeps a final Talk audio tail on the global export clock", () => {
    const plan = createFullSequenceRecordingPlan({
      openingDuration: 0,
      idleDuration: 1,
      idleSequenceId: "opening",
      includeOpening: false,
      initialIdleLoops: 1,
      betweenTalkIdleSeconds: 0,
      finalIdleLoops: 1,
      talks: [{ sequenceId: "talk-1", duration: 7 }],
      selectedTalkSequenceIds: ["talk-1"],
    });
    const talkOffset = videoRecordingTimelineOffsets(plan, {
      timeline: { sequenceId: "opening" } as never,
      sequences: { "talk-1": { sequenceId: "talk-1" } as never },
    })[0]?.start ?? 0;

    expect(talkOffset).toBe(1);
    expect(videoRecordingAudioSchedule(talkOffset + 5, talkOffset + 7, 1, plan.totalDuration)).toEqual({
      start: 6,
      duration: 2,
      volume: 1,
      sourceOffset: 0,
    });
  });

  test("sanitizes generated export names without touching the chosen folder", () => {
    expect(videoFilenameStem("../Alice: lobby? ")).toBe("..-Alice- lobby-");
    expect(videoFilenameStem("... ")).toBe("spine-recording");
  });
});
