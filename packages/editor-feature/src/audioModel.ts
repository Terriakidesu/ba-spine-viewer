import { timelineAudioPlaybackDecision, type SpineTimelineAudioPlaybackDecision } from "@ba-spine/spine-runtime/spine/spineTimeline";

export interface DecodedAudioTiming {
  end: number;
}

/** Replace an audio clip's guessed end with the real decoded duration. */
export function decodedAudioTiming(start: number, decodedDuration: number): DecodedAudioTiming | null {
  if (!Number.isFinite(start) || !Number.isFinite(decodedDuration) || decodedDuration <= 0) return null;
  const safeStart = Math.max(0, start);
  const end = Math.max(safeStart + 0.01, safeStart + decodedDuration);
  return { end };
}

/** Keep an authored audio end inside the source file's available duration. */
export function clampAudioEnd(start: number, requestedEnd: number, decodedDuration: number): number {
  const minimumEnd = start + 0.01;
  if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) return Math.max(minimumEnd, requestedEnd);
  return Math.min(start + Math.max(0.01, decodedDuration), Math.max(minimumEnd, requestedEnd));
}

/** Keep an authored audio start from exposing more source than the file contains. */
export function clampAudioStart(end: number, requestedStart: number, decodedDuration: number): number {
  const maximumStart = end - 0.01;
  if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) return Math.min(maximumStart, Math.max(0, requestedStart));
  return Math.min(maximumStart, Math.max(0, end - Math.max(0.01, decodedDuration), requestedStart));
}

export type AudioPlaybackDecision = SpineTimelineAudioPlaybackDecision;

/**
 * An HTMLAudioElement stays ended until it is explicitly rewound. Do not call
 * play() on every playhead frame while a long subtitle cue remains active.
 */
export function audioPlaybackDecision(input: {
  active: boolean;
  playing: boolean;
  currentTime: number;
  previousTime: number | undefined;
  started: boolean;
  ended: boolean;
}): AudioPlaybackDecision {
  return timelineAudioPlaybackDecision(input);
}
