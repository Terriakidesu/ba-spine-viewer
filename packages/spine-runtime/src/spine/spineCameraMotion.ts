import type { SpineCameraPose } from "./spineRuntime";

export type SpineCameraAspectRatio = "16:9" | "4:3" | "1:1";
export type SpineCameraConstraint =
  | { mode: "automatic" }
  | { mode: "manual"; boundId: string }
  | { mode: "none" };

export interface SpineCameraSafeBound {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  priority?: number;
}

export interface SpineCameraKeyframe {
  id: string;
  time: number;
  centerX: number;
  centerY: number;
  frameHeight: number;
  easing?: "linear" | "smooth" | "hold";
  constraint?: SpineCameraConstraint;
}

export interface SpineCameraTrack {
  enabled: boolean;
  aspectRatio: SpineCameraAspectRatio;
  constraint: SpineCameraConstraint;
  safeBounds: SpineCameraSafeBound[];
  keyframes: SpineCameraKeyframe[];
}

export interface EvaluatedCameraFrame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface SolvedSpineCamera {
  pose: SpineCameraPose;
  frame: EvaluatedCameraFrame;
  activeBoundId: string | null;
  constrained: boolean;
  diagnostic: "no-bounds" | "invalid-manual-bound" | null;
}

const ASPECTS: Record<SpineCameraAspectRatio, number> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
};

export function cameraAspectValue(value: SpineCameraAspectRatio): number {
  return ASPECTS[value];
}

export function isCameraAspectRatio(value: unknown): value is SpineCameraAspectRatio {
  return value === "16:9" || value === "4:3" || value === "1:1";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeConstraint(value: unknown, fallback: SpineCameraConstraint): SpineCameraConstraint {
  if (!value || typeof value !== "object") return fallback;
  const constraint = value as Partial<SpineCameraConstraint>;
  if (constraint.mode === "none") return { mode: "none" };
  if (constraint.mode === "manual" && typeof constraint.boundId === "string" && constraint.boundId.trim()) {
    return { mode: "manual", boundId: constraint.boundId.trim() };
  }
  if (constraint.mode === "automatic") return { mode: "automatic" };
  return fallback;
}

export function normalizeCameraConstraint(value: unknown): SpineCameraConstraint {
  return normalizeConstraint(value, { mode: "automatic" });
}

export function normalizeSpineCameraTrack(value: unknown, duration = Number.POSITIVE_INFINITY): SpineCameraTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<SpineCameraTrack>;
  const aspectRatio = isCameraAspectRatio(raw.aspectRatio) ? raw.aspectRatio : "16:9";
  const constraint = normalizeCameraConstraint(raw.constraint);
  const bounds: SpineCameraSafeBound[] = [];
  const boundIds = new Set<string>();
  for (const item of Array.isArray(raw.safeBounds) ? raw.safeBounds : []) {
    if (!item || typeof item !== "object") continue;
    const bound = item as Partial<SpineCameraSafeBound>;
    const id = typeof bound.id === "string" ? bound.id.trim() : "";
    const x = finite(bound.x, Number.NaN);
    const y = finite(bound.y, Number.NaN);
    const width = finite(bound.width, Number.NaN);
    const height = finite(bound.height, Number.NaN);
    if (!id || boundIds.has(id) || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    boundIds.add(id);
    bounds.push({
      id,
      name: typeof bound.name === "string" && bound.name.trim() ? bound.name.trim() : `Safe bound ${bounds.length + 1}`,
      x,
      y,
      width,
      height,
      enabled: bound.enabled !== false,
      ...(typeof bound.priority === "number" && Number.isFinite(bound.priority) ? { priority: bound.priority } : {}),
    });
  }

  const keyframes: SpineCameraKeyframe[] = [];
  const keyframeIds = new Set<string>();
  for (const item of Array.isArray(raw.keyframes) ? raw.keyframes : []) {
    if (!item || typeof item !== "object") continue;
    const keyframe = item as Partial<SpineCameraKeyframe>;
    const id = typeof keyframe.id === "string" ? keyframe.id.trim() : "";
    const time = finite(keyframe.time, Number.NaN);
    const centerX = finite(keyframe.centerX, Number.NaN);
    const centerY = finite(keyframe.centerY, Number.NaN);
    const frameHeight = finite(keyframe.frameHeight, Number.NaN);
    if (!id || keyframeIds.has(id) || ![time, centerX, centerY, frameHeight].every(Number.isFinite) || time < 0 || time > duration || frameHeight <= 0) continue;
    keyframeIds.add(id);
    const easing = keyframe.easing === "smooth" || keyframe.easing === "hold" ? keyframe.easing : "linear";
    keyframes.push({
      id,
      time,
      centerX,
      centerY,
      frameHeight,
      easing,
      ...(keyframe.constraint ? { constraint: normalizeConstraint(keyframe.constraint, constraint) } : {}),
    });
  }
  keyframes.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
  const uniqueKeyframes = keyframes.filter((keyframe, index) => index === 0 || keyframe.time > keyframes[index - 1]!.time + 1e-6);
  return {
    enabled: raw.enabled !== false,
    aspectRatio,
    constraint,
    safeBounds: bounds,
    keyframes: uniqueKeyframes,
  };
}

export interface SampledSpineCamera {
  centerX: number;
  centerY: number;
  frameHeight: number;
  constraint: SpineCameraConstraint;
}

export function sampleSpineCameraTrack(track: SpineCameraTrack, time: number): SampledSpineCamera | null {
  if (!track.enabled || track.keyframes.length === 0 || !Number.isFinite(time)) return null;
  const keys = track.keyframes;
  if (time <= keys[0]!.time) {
    const first = keys[0]!;
    return { centerX: first.centerX, centerY: first.centerY, frameHeight: first.frameHeight, constraint: first.constraint ?? track.constraint };
  }
  const last = keys.at(-1)!;
  if (time >= last.time) return { centerX: last.centerX, centerY: last.centerY, frameHeight: last.frameHeight, constraint: last.constraint ?? track.constraint };
  const index = keys.findIndex((key, keyIndex) => keyIndex < keys.length - 1 && time >= key.time && time <= keys[keyIndex + 1]!.time);
  const left = keys[Math.max(0, index)]!;
  const right = keys[Math.max(0, index) + 1]!;
  const span = Math.max(Number.EPSILON, right.time - left.time);
  let amount = Math.max(0, Math.min(1, (time - left.time) / span));
  if (left.easing === "hold") amount = 0;
  else if (left.easing === "smooth") amount = amount * amount * (3 - 2 * amount);
  const lerp = (start: number, end: number) => start + (end - start) * amount;
  return {
    centerX: lerp(left.centerX, right.centerX),
    centerY: lerp(left.centerY, right.centerY),
    frameHeight: lerp(left.frameHeight, right.frameHeight),
    constraint: left.constraint ?? track.constraint,
  };
}

function containsCenter(bound: SpineCameraSafeBound, x: number, y: number): boolean {
  return x >= bound.x && x <= bound.x + bound.width && y >= bound.y && y <= bound.y + bound.height;
}

function distanceToBound(bound: SpineCameraSafeBound, x: number, y: number): number {
  const dx = Math.max(bound.x - x, 0, x - (bound.x + bound.width));
  const dy = Math.max(bound.y - y, 0, y - (bound.y + bound.height));
  return Math.hypot(dx, dy);
}

function automaticBound(bounds: readonly SpineCameraSafeBound[], x: number, y: number, currentBoundId: string | null): SpineCameraSafeBound | null {
  const enabled = bounds.map((bound, index) => ({ bound, index })).filter(({ bound }) => bound.enabled);
  if (enabled.length === 0) return null;
  const containing = enabled.filter(({ bound }) => containsCenter(bound, x, y));
  const current = containing.find(({ bound }) => bound.id === currentBoundId);
  if (current) return current.bound;
  const priority = (bound: SpineCameraSafeBound) => bound.priority ?? Number.POSITIVE_INFINITY;
  const ordered = (items: typeof enabled) => items.sort((a, b) => priority(a.bound) - priority(b.bound) || a.index - b.index);
  if (containing.length) return ordered(containing)[0]!.bound;
  return enabled.sort((a, b) => distanceToBound(a.bound, x, y) - distanceToBound(b.bound, x, y)
    || priority(a.bound) - priority(b.bound)
    || a.index - b.index)[0]!.bound;
}

export function solveSpineCamera(
  sampled: SampledSpineCamera,
  track: Pick<SpineCameraTrack, "aspectRatio" | "safeBounds">,
  viewportWidth: number,
  viewportHeight: number,
  currentBoundId: string | null = null,
): SolvedSpineCamera | null {
  if (![sampled.centerX, sampled.centerY, sampled.frameHeight, viewportWidth, viewportHeight].every(Number.isFinite)
    || sampled.frameHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;
  const ratio = cameraAspectValue(track.aspectRatio);
  const requestedHeight = sampled.frameHeight;
  const requestedWidth = requestedHeight * ratio;
  const frame: EvaluatedCameraFrame = { centerX: sampled.centerX, centerY: sampled.centerY, width: requestedWidth, height: requestedHeight };
  if (sampled.constraint.mode === "none") {
    return { pose: { x: frame.centerX, y: frame.centerY, zoom: frame.height / viewportHeight }, frame, activeBoundId: null, constrained: false, diagnostic: null };
  }

  const enabledBounds = track.safeBounds.filter((bound) => bound.enabled);
  if (enabledBounds.length === 0) {
    return {
      pose: { x: frame.centerX, y: frame.centerY, zoom: frame.height / viewportHeight },
      frame,
      activeBoundId: null,
      constrained: false,
      diagnostic: "no-bounds",
    };
  }
  const manualBoundId = sampled.constraint.mode === "manual" ? sampled.constraint.boundId : null;
  let selected = manualBoundId !== null
    ? enabledBounds.find((bound) => bound.id === manualBoundId) ?? null
    : automaticBound(enabledBounds, frame.centerX, frame.centerY, currentBoundId);
  const invalidManual = manualBoundId !== null && !selected;
  if (!selected && invalidManual) selected = automaticBound(enabledBounds, frame.centerX, frame.centerY, currentBoundId);
  if (!selected) return null;

  const maxHeight = Math.min(selected.height, selected.width / ratio);
  frame.height = Math.min(frame.height, maxHeight);
  frame.width = frame.height * ratio;
  const minX = selected.x + frame.width / 2;
  const maxX = selected.x + selected.width - frame.width / 2;
  const minY = selected.y + frame.height / 2;
  const maxY = selected.y + selected.height - frame.height / 2;
  frame.centerX = Math.min(maxX, Math.max(minX, frame.centerX));
  frame.centerY = Math.min(maxY, Math.max(minY, frame.centerY));
  return {
    pose: { x: frame.centerX, y: frame.centerY, zoom: frame.height / viewportHeight },
    frame,
    activeBoundId: selected.id,
    constrained: frame.height !== requestedHeight || frame.centerX !== sampled.centerX || frame.centerY !== sampled.centerY,
    diagnostic: invalidManual ? "invalid-manual-bound" : null,
  };
}

export function cameraPoseForViewport(frame: Pick<EvaluatedCameraFrame, "centerX" | "centerY" | "height">, viewportHeight: number): SpineCameraPose | null {
  if (![frame.centerX, frame.centerY, frame.height, viewportHeight].every(Number.isFinite) || frame.height <= 0 || viewportHeight <= 0) return null;
  return { x: frame.centerX, y: frame.centerY, zoom: frame.height / viewportHeight };
}
