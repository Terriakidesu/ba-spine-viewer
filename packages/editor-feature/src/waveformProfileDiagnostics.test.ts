import { describe, expect, test } from "bun:test";
import { WaveformProfileRecorder } from "./waveformProfileDiagnostics";

describe("WaveformProfileRecorder", () => {
  test("summarizes in-memory stage, frame, and long-task samples", () => {
    const recorder = new WaveformProfileRecorder(100, "2026-11-04T00:00:00.000Z", true);
    recorder.recordStage("clip-a", { stage: "envelope", durationMs: 0.5 });
    recorder.recordStage("clip-b", { stage: "envelope", durationMs: 1.5 });
    recorder.recordStage("clip-a", { stage: "decode", durationMs: 32 });
    recorder.recordFrameGap(16.67);
    recorder.recordFrameGap(33.34);
    recorder.recordLongTask(59);

    const snapshot = recorder.snapshot(250);
    expect(snapshot.recording).toBe(true);
    expect(snapshot.durationMs).toBe(150);
    expect(snapshot.visibleAtStart).toBe(true);
    expect(snapshot.visibleThroughout).toBe(true);
    expect(snapshot.observedClips).toBe(2);
    expect(snapshot.waveformStageTimings.envelope).toEqual({ samples: 2, medianMs: 0.5, p95Ms: 1.5, maxMs: 1.5 });
    expect(snapshot.waveformStageTimings.decode).toEqual({ samples: 1, medianMs: 32, p95Ms: 32, maxMs: 32 });
    expect(snapshot.animationFrameGaps.over16_67ms).toBe(1);
    expect(snapshot.animationFrameGaps.over33_33ms).toBe(1);
    expect(snapshot.mainThreadLongTasksMs.maxMs).toBe(59);
  });

  test("stops sampling and reports hidden-window captures", () => {
    const recorder = new WaveformProfileRecorder(10, "2026-11-04T00:00:00.000Z", false);
    recorder.recordVisibility(true);
    recorder.recordVisibility(false);
    recorder.recordFrameGap(20);
    recorder.stop(30);
    recorder.recordFrameGap(100);
    recorder.recordStage("clip-a", { stage: "envelope", durationMs: 1 });

    const snapshot = recorder.snapshot(200);
    expect(snapshot.recording).toBe(false);
    expect(snapshot.durationMs).toBe(20);
    expect(snapshot.visibleAtStart).toBe(false);
    expect(snapshot.visibleThroughout).toBe(false);
    expect(snapshot.animationFrameGaps.samples).toBe(1);
    expect(snapshot.waveformStageTimings.envelope.samples).toBe(0);
  });
});
