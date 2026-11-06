import { describe, expect, test } from "bun:test";
import { createFullSequenceRecordingPlan, createVideoRecordingPlan, detectSupportedVideoFormats, normalizeVideoRecordingQuality, readVideoRecordingQuality, VIDEO_RECORDING_QUALITY_STORAGE_KEY, videoFilenameStem, videoFrameTargetCount, videoRecordingAudioSchedule, videoRecordingDimensions, videoRecordingFrameCount, videoRecordingGlobalTime, videoRecordingProgress, videoRecordingResolutionScale, videoRecordingSegmentAt, videoRecordingSegmentStart, videoRecordingTimelineOffsets, writeVideoRecordingQuality } from "./videoRecorder";

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

  test("uses even-sized dimensions for the chosen aspect ratio", () => {
    expect(videoRecordingDimensions(1080, "16:9")).toEqual({ width: 1920, height: 1080 });
    expect(videoRecordingDimensions(1440, "16:9")).toEqual({ width: 2560, height: 1440 });
    expect(videoRecordingDimensions(2160, "16:9")).toEqual({ width: 3840, height: 2160 });
    expect(videoRecordingDimensions(720, "4:3")).toEqual({ width: 960, height: 720 });
    expect(videoRecordingDimensions(1080, "1:1")).toEqual({ width: 1080, height: 1080 });
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
    expect(videoRecordingAudioSchedule(2.25, 8, 0.65, 5)).toEqual({ start: 2.25, duration: 2.75, volume: 0.65 });
    expect(videoRecordingAudioSchedule(-1, 2, 1.5, 4)).toEqual({ start: 0, duration: 2, volume: 1 });
    expect(videoRecordingAudioSchedule(5, 6, 1, 5)).toBeNull();
  });

  test("sanitizes generated export names without touching the chosen folder", () => {
    expect(videoFilenameStem("../Alice: lobby? ")).toBe("..-Alice- lobby-");
    expect(videoFilenameStem("... ")).toBe("spine-recording");
  });
});
