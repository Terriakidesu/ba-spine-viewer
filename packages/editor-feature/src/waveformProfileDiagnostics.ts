import type { AudioWaveformMeasurement, AudioWaveformStage } from "./AudioWaveform";

export interface WaveformProfileDistribution {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface EditorWaveformProfileSnapshot {
  enabled: true;
  recording: boolean;
  startedAt: string;
  durationMs: number;
  visibleAtStart: boolean;
  visibleThroughout: boolean;
  observedClips: number;
  waveformStageTimings: Record<AudioWaveformStage, WaveformProfileDistribution>;
  animationFrameGaps: WaveformProfileDistribution & {
    over16_67ms: number;
    over33_33ms: number;
  };
  mainThreadLongTasksMs: WaveformProfileDistribution;
}

const MAX_FRAME_SAMPLES = 12_000;
const MAX_LONG_TASK_SAMPLES = 512;
const MAX_STAGE_SAMPLES = 2_048;
const stages: AudioWaveformStage[] = ["context", "fetch", "read", "decode", "envelope", "close", "error"];

function distribution(samples: readonly number[]): WaveformProfileDistribution {
  if (samples.length === 0) return { samples: 0, medianMs: null, p95Ms: null, maxMs: null };
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    samples: sorted.length,
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  };
}

/** In-memory, bounded diagnostics for an explicitly started desktop Editor profile. */
export class WaveformProfileRecorder {
  readonly startedAt: string;
  readonly visibleAtStart: boolean;
  private readonly startedAtMs: number;
  private stoppedAtMs: number | null = null;
  private visibleThroughout = true;
  private readonly clips = new Set<string>();
  private readonly stageSamples = new Map<AudioWaveformStage, number[]>();
  private readonly frameGaps: number[] = [];
  private readonly longTasks: number[] = [];

  constructor(startedAtMs: number, startedAt: string, visibleAtStart: boolean) {
    this.startedAtMs = startedAtMs;
    this.startedAt = startedAt;
    this.visibleAtStart = visibleAtStart;
    this.visibleThroughout = visibleAtStart;
  }

  get recording(): boolean {
    return this.stoppedAtMs === null;
  }

  recordVisibility(visible: boolean): void {
    if (this.recording && !visible) this.visibleThroughout = false;
  }

  recordStage(clipId: string, measurement: AudioWaveformMeasurement): void {
    if (!this.recording) return;
    this.clips.add(clipId);
    const samples = this.stageSamples.get(measurement.stage) ?? [];
    if (samples.length < MAX_STAGE_SAMPLES) samples.push(measurement.durationMs);
    this.stageSamples.set(measurement.stage, samples);
  }

  recordFrameGap(durationMs: number): void {
    if (this.recording && Number.isFinite(durationMs) && durationMs >= 0 && this.frameGaps.length < MAX_FRAME_SAMPLES) {
      this.frameGaps.push(durationMs);
    }
  }

  recordLongTask(durationMs: number): void {
    if (this.recording && Number.isFinite(durationMs) && durationMs >= 0 && this.longTasks.length < MAX_LONG_TASK_SAMPLES) {
      this.longTasks.push(durationMs);
    }
  }

  stop(atMs: number): void {
    if (this.stoppedAtMs === null) this.stoppedAtMs = Math.max(this.startedAtMs, atMs);
  }

  snapshot(nowMs: number): EditorWaveformProfileSnapshot {
    const end = this.stoppedAtMs ?? nowMs;
    const stageTimings = Object.fromEntries(stages.map((stage) => [stage, distribution(this.stageSamples.get(stage) ?? [])])) as Record<AudioWaveformStage, WaveformProfileDistribution>;
    const frameStats = distribution(this.frameGaps);
    return {
      enabled: true,
      recording: this.recording,
      startedAt: this.startedAt,
      durationMs: Number(Math.max(0, end - this.startedAtMs).toFixed(3)),
      visibleAtStart: this.visibleAtStart,
      visibleThroughout: this.visibleThroughout,
      observedClips: this.clips.size,
      waveformStageTimings: stageTimings,
      animationFrameGaps: {
        ...frameStats,
        over16_67ms: this.frameGaps.filter((gap) => gap > 16.67).length,
        over33_33ms: this.frameGaps.filter((gap) => gap > 33.33).length,
      },
      mainThreadLongTasksMs: distribution(this.longTasks),
    };
  }
}
