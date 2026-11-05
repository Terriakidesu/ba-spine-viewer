import { describe, expect, test } from "bun:test";
import { createVideoRecordingPlan, detectSupportedVideoFormats, videoFilenameStem, videoFrameTargetCount, videoRecordingDimensions, videoRecordingProgress } from "./videoRecorder";

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

  test("advertises only encoder MIME types reported by the WebView", () => {
    const formats = detectSupportedVideoFormats({
      isTypeSupported: (mimeType) => mimeType === "video/mp4;codecs=avc1.42E01E",
    });
    expect(formats).toEqual([{ format: "mp4", mimeType: "video/mp4;codecs=avc1.42E01E" }]);
    expect(detectSupportedVideoFormats(null)).toEqual([]);
  });

  test("uses even-sized dimensions for the chosen aspect ratio", () => {
    expect(videoRecordingDimensions(1080, "16:9")).toEqual({ width: 1920, height: 1080 });
    expect(videoRecordingDimensions(720, "4:3")).toEqual({ width: 960, height: 720 });
    expect(videoRecordingDimensions(1080, "1:1")).toEqual({ width: 1080, height: 1080 });
  });

  test("keeps FFmpeg frame output on an exact fixed-rate frame count", () => {
    expect(videoFrameTargetCount(0, 30, 300)).toBe(1);
    expect(videoFrameTargetCount(0.1, 30, 300)).toBe(4);
    expect(videoFrameTargetCount(1, 60, 60)).toBe(60);
    expect(videoFrameTargetCount(Number.NaN, 30, 300)).toBe(0);
    expect(videoFrameTargetCount(10, 30, 30)).toBe(30);
  });

  test("sanitizes generated export names without touching the chosen folder", () => {
    expect(videoFilenameStem("../Alice: lobby? ")).toBe("..-Alice- lobby-");
    expect(videoFilenameStem("... ")).toBe("spine-recording");
  });
});
