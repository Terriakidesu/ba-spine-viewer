import type { CompositionKeyframe } from "@ba-spine/spine-runtime/spine/spineComposition";

export interface CompositionKeyframeLocation {
  trackId: string;
  key: CompositionKeyframe;
  /** Position on the composition ruler, including any section-instance offset. */
  globalTime: number;
  minimumGlobalTime: number;
  maximumGlobalTime: number;
}

export function snapCompositionTimeToFrame(time: number, frameRate: number): number {
  if (!Number.isFinite(time)) return 0;
  if (!Number.isFinite(frameRate) || frameRate <= 0) return time;
  return Math.round(time * frameRate) / frameRate;
}

/** Return the ruler delta that places one key on the requested frame offset. */
export function frameSnappedCompositionKeyDelta(globalTime: number, frameOffset: number, frameRate: number): number {
  if (!Number.isFinite(globalTime) || !Number.isFinite(frameOffset)) return 0;
  return snapCompositionTimeToFrame(globalTime + frameOffset / frameRate, frameRate) - globalTime;
}

/** Clamp one shared timeline delta so every selected key stays in its owning range. */
export function clampCompositionKeyDelta(keys: readonly CompositionKeyframeLocation[], delta: number): number {
  if (!keys.length || !Number.isFinite(delta)) return 0;
  const minimumDelta = Math.max(...keys.map((item) => item.minimumGlobalTime - item.globalTime));
  const maximumDelta = Math.min(...keys.map((item) => item.maximumGlobalTime - item.globalTime));
  if (minimumDelta > maximumDelta) return 0;
  return Math.min(maximumDelta, Math.max(minimumDelta, delta));
}

export function moveCompositionKeyLocations(
  keys: readonly CompositionKeyframeLocation[],
  delta: number,
): Array<{ trackId: string; key: CompositionKeyframe }> {
  return keys.map((item) => ({ trackId: item.trackId, key: { ...item.key, time: item.key.time + delta } }));
}
