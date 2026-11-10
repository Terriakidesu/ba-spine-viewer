import { useEffect, useRef, useState } from "react";
import { audioEnvelopePeaks } from "./audioEnvelope";
import { createResourceQueue } from "@ba-spine/spine-runtime/spine/resourceQueue";

const queueWaveformDecode = createResourceQueue(2);

export type AudioWaveformStage = "context" | "fetch" | "read" | "decode" | "envelope" | "close" | "error";

export interface AudioWaveformMeasurement {
  stage: AudioWaveformStage;
  durationMs: number;
}

export function AudioWaveform({
  url,
  onDuration,
  onProfile,
}: {
  url?: string;
  onDuration?: (duration: number) => void;
  /** Optional in-memory diagnostics; wired only into explicit development profiling builds. */
  onProfile?: (measurement: AudioWaveformMeasurement) => void;
}) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const onDurationRef = useRef(onDuration);
  const onProfileRef = useRef(onProfile);
  onDurationRef.current = onDuration;
  onProfileRef.current = onProfile;

  useEffect(() => {
    setPeaks([]);
    if (!url) return;
    const controller = new AbortController();
    const { signal } = controller;
    const profiling = typeof onProfileRef.current === "function";
    const now = () => profiling ? performance.now() : 0;
    const startedAt = now();
    const measure = (stage: AudioWaveformStage, started: number) => {
      if (!profiling) return;
      onProfileRef.current?.({ stage, durationMs: performance.now() - started });
    };
    void queueWaveformDecode(async () => {
      signal.throwIfAborted();
      const contextStarted = now();
      const context = new AudioContext();
      measure("context", contextStarted);
      try {
        const fetchStarted = now();
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error("Could not load waveform audio.");
        measure("fetch", fetchStarted);
        const readStarted = now();
        const bytes = await response.arrayBuffer();
        measure("read", readStarted);
        signal.throwIfAborted();
        const decodeStarted = now();
        const buffer = await context.decodeAudioData(bytes);
        measure("decode", decodeStarted);
        signal.throwIfAborted();
        onDurationRef.current?.(buffer.duration);
        const envelopeStarted = now();
        const nextPeaks = audioEnvelopePeaks(buffer.getChannelData(0));
        measure("envelope", envelopeStarted);
        setPeaks(nextPeaks);
      } finally {
        const closeStarted = now();
        await context.close();
        measure("close", closeStarted);
      }
    }, signal).catch(() => { if (profiling && !signal.aborted) measure("error", startedAt); });
    return () => { controller.abort(); };
  }, [url]);

  return <svg className="timeline-waveform" viewBox="0 0 160 30" preserveAspectRatio="none" aria-label="Audio waveform">{peaks.map((peak, index) => <line key={index} x1={index} x2={index} y1={15 - peak * 14} y2={15 + peak * 14} stroke="#a6ffdb" strokeWidth="0.7" />)}</svg>;
}
