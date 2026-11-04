import { useEffect, useRef, useState } from "react";
import { audioEnvelopePeaks } from "./audioEnvelope";

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
    if (!url) return;
    let live = true;
    const profiling = typeof onProfileRef.current === "function";
    const now = () => profiling ? performance.now() : 0;
    const startedAt = now();
    const measure = (stage: AudioWaveformStage, started: number) => {
      if (!profiling) return;
      onProfileRef.current?.({ stage, durationMs: performance.now() - started });
    };
    const contextStarted = now();
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      measure("error", startedAt);
      return () => { live = false; };
    }
    measure("context", contextStarted);

    const fetchStarted = now();
    void fetch(url)
      .then((response) => {
        measure("fetch", fetchStarted);
        const readStarted = now();
        return response.arrayBuffer().then((bytes) => {
          measure("read", readStarted);
          return bytes;
        });
      })
      .then((bytes) => {
        const decodeStarted = now();
        return context.decodeAudioData(bytes).then((buffer) => {
          measure("decode", decodeStarted);
          if (!live) return;
          onDurationRef.current?.(buffer.duration);
          const envelopeStarted = now();
          const nextPeaks = audioEnvelopePeaks(buffer.getChannelData(0));
          measure("envelope", envelopeStarted);
          setPeaks(nextPeaks);
        });
      })
      .catch(() => { if (profiling) measure("error", startedAt); })
      .finally(() => {
        if (!profiling) {
          void context.close();
          return;
        }
        const closeStarted = performance.now();
        void context.close()
          .then(() => measure("close", closeStarted))
          .catch(() => measure("close", closeStarted));
      });
    return () => { live = false; };
  }, [url]);

  return <svg className="timeline-waveform" viewBox="0 0 160 30" preserveAspectRatio="none" aria-label="Audio waveform">{peaks.map((peak, index) => <line key={index} x1={index} x2={index} y1={15 - peak * 14} y2={15 + peak * 14} stroke="#a6ffdb" strokeWidth="0.7" />)}</svg>;
}
