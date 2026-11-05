import type { SpineCameraFrame, SpineCameraPose } from "./spineRuntime";

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
  visible?: boolean;
  locked?: boolean;
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
  /** Spine set whose stable world coordinates author this track's bounds and keys. */
  referenceLayerId?: string;
  safeBounds: SpineCameraSafeBound[];
  keyframes: SpineCameraKeyframe[];
}

export interface EvaluatedCameraFrame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface CameraCanvasPoint {
  x: number;
  y: number;
}

export type SpineCameraBoundResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

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

/** Change output ratio while retaining each authored shot's world-space width and center. */
export function changeSpineCameraAspectRatio(track: SpineCameraTrack, aspectRatio: SpineCameraAspectRatio): SpineCameraTrack {
  if (track.aspectRatio === aspectRatio) return track;
  const widthScale = cameraAspectValue(track.aspectRatio) / cameraAspectValue(aspectRatio);
  return {
    ...track,
    aspectRatio,
    keyframes: track.keyframes.map((keyframe) => ({
      ...keyframe,
      frameHeight: keyframe.frameHeight * widthScale,
    })),
  };
}

/** Convert a drag on the preview canvas into a fixed scene-space camera region. */
export function spineCameraBoundFromCanvasDrag(
  id: string,
  name: string,
  start: CameraCanvasPoint,
  end: CameraCanvasPoint,
  frame: Pick<EvaluatedCameraFrame, "centerX" | "centerY" | "height">,
  viewportWidth: number,
  viewportHeight: number,
  priority = 0,
  lockAspectRatio?: number,
): SpineCameraSafeBound | null {
  if (![start.x, start.y, end.x, end.y, frame.centerX, frame.centerY, frame.height, viewportWidth, viewportHeight].every(Number.isFinite)
    || frame.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  if (right <= left || bottom <= top) return null;
  const frameWidth = frame.height * viewportWidth / viewportHeight;
  const worldX = (x: number) => frame.centerX + (x / viewportWidth - 0.5) * frameWidth;
  const worldY = (y: number) => frame.centerY + (0.5 - y / viewportHeight) * frame.height;
  let worldLeft = worldX(left);
  let worldRight = worldX(right);
  let worldTop = worldY(top);
  let worldBottom = worldY(bottom);
  if (Number.isFinite(lockAspectRatio) && lockAspectRatio! > 0) {
    const anchorX = worldX(start.x);
    const anchorY = worldY(start.y);
    const signX = worldX(end.x) >= anchorX ? 1 : -1;
    const signY = worldY(end.y) >= anchorY ? 1 : -1;
    const width = Math.abs(worldRight - worldLeft);
    const height = Math.abs(worldTop - worldBottom);
    const lockedWidth = Math.min(width, height * lockAspectRatio!);
    const lockedHeight = lockedWidth / lockAspectRatio!;
    worldLeft = Math.min(anchorX, anchorX + signX * lockedWidth);
    worldRight = Math.max(anchorX, anchorX + signX * lockedWidth);
    worldBottom = Math.min(anchorY, anchorY + signY * lockedHeight);
    worldTop = Math.max(anchorY, anchorY + signY * lockedHeight);
  }
  return {
    id,
    name,
    x: Math.min(worldLeft, worldRight),
    y: Math.min(worldTop, worldBottom),
    width: Math.abs(worldRight - worldLeft),
    height: Math.abs(worldBottom - worldTop),
    enabled: true,
    priority,
  };
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
      visible: bound.visible !== false,
      locked: bound.locked === true,
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
    ...(typeof raw.referenceLayerId === "string" && raw.referenceLayerId.trim() ? { referenceLayerId: raw.referenceLayerId.trim() } : {}),
    safeBounds: bounds,
    keyframes: uniqueKeyframes,
  };
}

export interface SampledSpineCamera {
  centerX: number;
  centerY: number;
  frameHeight: number;
  /** Authored world-space width, retained when the requested output ratio changes. */
  frameWidth?: number;
  constraint: SpineCameraConstraint;
}

export function sampleSpineCameraTrack(track: SpineCameraTrack, time: number): SampledSpineCamera | null {
  if (!track.enabled || track.keyframes.length === 0 || !Number.isFinite(time)) return null;
  const sampledKey = (keyframe: SpineCameraKeyframe): SampledSpineCamera => ({
    centerX: keyframe.centerX,
    centerY: keyframe.centerY,
    frameHeight: keyframe.frameHeight,
    frameWidth: keyframe.frameHeight * cameraAspectValue(track.aspectRatio),
    constraint: keyframe.constraint ?? track.constraint,
  });
  const keys = track.keyframes;
  if (time <= keys[0]!.time) {
    return sampledKey(keys[0]!);
  }
  const last = keys.at(-1)!;
  if (time >= last.time) return sampledKey(last);
  const index = keys.findIndex((key, keyIndex) => keyIndex < keys.length - 1 && time >= key.time && time < keys[keyIndex + 1]!.time);
  const left = keys[Math.max(0, index)]!;
  const right = keys[Math.max(0, index) + 1]!;
  const span = Math.max(Number.EPSILON, right.time - left.time);
  let amount = Math.max(0, Math.min(1, (time - left.time) / span));
  if (left.easing === "hold") amount = 0;
  else if (left.easing === "smooth") amount = amount * amount * (3 - 2 * amount);
  const lerp = (start: number, end: number) => start + (end - start) * amount;
  const frameHeight = lerp(left.frameHeight, right.frameHeight);
  return {
    centerX: lerp(left.centerX, right.centerX),
    centerY: lerp(left.centerY, right.centerY),
    frameHeight,
    frameWidth: frameHeight * cameraAspectValue(track.aspectRatio),
    constraint: left.constraint ?? track.constraint,
  };
}

/** A full-artwork-fit frame previews bounds before the first authored shot exists. */
export function defaultSpineCameraSample(
  track: Pick<SpineCameraTrack, "aspectRatio" | "constraint">,
  frame: SpineCameraFrame | null,
): SampledSpineCamera | null {
  if (!frame || ![frame.centerX, frame.centerY, frame.height].every(Number.isFinite) || frame.height <= 0) return null;
  return {
    centerX: frame.centerX,
    centerY: frame.centerY,
    frameHeight: frame.height,
    frameWidth: frame.height * cameraAspectValue(track.aspectRatio),
    constraint: track.constraint,
  };
}

/** Shared Editor/Viewer sampling policy, including a stable full-artwork frame before the first shot. */
export function sampleSpineCameraTrackWithFallback(
  track: SpineCameraTrack,
  time: number,
  artworkFrame: SpineCameraFrame | null,
): SampledSpineCamera | null {
  return sampleSpineCameraTrack(track, time)
    ?? (track.enabled ? defaultSpineCameraSample(track, artworkFrame) : null);
}

/** Shared camera evaluation path for the editor preview and saved Viewer composition. */
export function evaluateSpineCameraTrack(
  track: SpineCameraTrack,
  time: number,
  viewportWidth: number,
  viewportHeight: number,
  artworkFrame: SpineCameraFrame | null,
  activeBoundId: string | null = null,
): SolvedSpineCamera | null {
  const sample = sampleSpineCameraTrackWithFallback(track, time, artworkFrame);
  return sample ? solveSpineCamera(sample, track, viewportWidth, viewportHeight, activeBoundId) : null;
}

/** Maximum output frame height that stays inside a world-space boundary. */
export function cameraFrameHeightForBound(bound: Pick<SpineCameraSafeBound, "width" | "height">, aspectRatio: SpineCameraAspectRatio): number {
  if (![bound.width, bound.height].every(Number.isFinite) || bound.width <= 0 || bound.height <= 0) return 0;
  return Math.min(bound.height, bound.width / cameraAspectValue(aspectRatio));
}

export function moveSpineCameraBound(bound: SpineCameraSafeBound, deltaX: number, deltaY: number): SpineCameraSafeBound {
  return { ...bound, x: bound.x + deltaX, y: bound.y + deltaY };
}

export function moveSpineCameraKeyframe(keyframe: SpineCameraKeyframe, deltaX: number, deltaY: number): SpineCameraKeyframe {
  return { ...keyframe, centerX: keyframe.centerX + deltaX, centerY: keyframe.centerY + deltaY };
}

export function cameraKeyframeTimeAvailable(
  keyframes: readonly SpineCameraKeyframe[],
  id: string,
  time: number,
  minimumGap = 0.001,
): boolean {
  return Number.isFinite(time) && Number.isFinite(minimumGap) && minimumGap >= 0
    && !keyframes.some((keyframe) => keyframe.id !== id && Math.abs(keyframe.time - time) < minimumGap);
}

export function retimeSpineCameraKeyframe(
  keyframe: SpineCameraKeyframe,
  requestedTime: number,
  duration: number,
): SpineCameraKeyframe | null {
  if (![requestedTime, duration].every(Number.isFinite) || duration < 0) return null;
  return { ...keyframe, time: Math.max(0, Math.min(duration, requestedTime)) };
}

/** Resize a shot around the opposite edge/corner while preserving the output ratio. */
export function resizeSpineCameraKeyframe(
  keyframe: SpineCameraKeyframe,
  handle: SpineCameraBoundResizeHandle,
  point: CameraCanvasPoint,
  aspectRatio: number,
  minimumHeight = 0.01,
  centered = false,
): SpineCameraKeyframe {
  if (![point.x, point.y, aspectRatio, minimumHeight].every(Number.isFinite) || aspectRatio <= 0) return keyframe;
  const minHeight = Math.max(Number.EPSILON, minimumHeight);
  if (centered) {
    const horizontal = handle.includes("e") || handle.includes("w");
    const vertical = handle.includes("n") || handle.includes("s");
    const widthHeight = horizontal ? Math.abs(point.x - keyframe.centerX) * 2 / aspectRatio : Number.POSITIVE_INFINITY;
    const verticalHeight = vertical ? Math.abs(point.y - keyframe.centerY) * 2 : Number.POSITIVE_INFINITY;
    return { ...keyframe, frameHeight: Math.max(minHeight, Math.min(widthHeight, verticalHeight)) };
  }
  const width = keyframe.frameHeight * aspectRatio;
  const left = keyframe.centerX - width / 2;
  const right = keyframe.centerX + width / 2;
  const bottom = keyframe.centerY - keyframe.frameHeight / 2;
  const top = keyframe.centerY + keyframe.frameHeight / 2;
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");
  const anchorX = handle.includes("e") ? left : handle.includes("w") ? right : keyframe.centerX;
  const anchorY = handle.includes("n") ? bottom : handle.includes("s") ? top : keyframe.centerY;
  const signX = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const signY = handle.includes("n") ? 1 : handle.includes("s") ? -1 : 0;
  let frameHeight = keyframe.frameHeight;
  if (horizontal && vertical) {
    frameHeight = Math.max(minHeight, Math.min(Math.abs(point.x - anchorX) / aspectRatio, Math.abs(point.y - anchorY)));
  } else if (horizontal) {
    frameHeight = Math.max(minHeight, Math.abs(point.x - anchorX) / aspectRatio);
  } else if (vertical) {
    frameHeight = Math.max(minHeight, Math.abs(point.y - anchorY));
  }
  const nextWidth = frameHeight * aspectRatio;
  return {
    ...keyframe,
    frameHeight,
    centerX: horizontal ? anchorX + signX * nextWidth / 2 : keyframe.centerX,
    centerY: vertical ? anchorY + signY * frameHeight / 2 : keyframe.centerY,
  };
}

export function resizeSpineCameraBound(
  bound: SpineCameraSafeBound,
  handle: SpineCameraBoundResizeHandle,
  point: CameraCanvasPoint,
  minimumSize = 0.01,
  lockAspectRatio?: number,
  centered = false,
): SpineCameraSafeBound {
  const min = Math.max(Number.EPSILON, Number.isFinite(minimumSize) ? minimumSize : 0.01);
  if (centered) {
    const centerX = bound.x + bound.width / 2;
    const centerY = bound.y + bound.height / 2;
    const horizontal = handle.includes("e") || handle.includes("w");
    const vertical = handle.includes("n") || handle.includes("s");
    let width = horizontal ? Math.max(min, Math.abs(point.x - centerX) * 2) : bound.width;
    let height = vertical ? Math.max(min, Math.abs(point.y - centerY) * 2) : bound.height;
    if (Number.isFinite(lockAspectRatio) && lockAspectRatio! > 0) {
      const aspect = lockAspectRatio!;
      if (horizontal && vertical) {
        if (width / height > aspect) width = height * aspect;
        else height = width / aspect;
      } else if (horizontal) height = width / aspect;
      else if (vertical) width = height * aspect;
    }
    return { ...bound, x: centerX - width / 2, y: centerY - height / 2, width, height };
  }
  let left = bound.x;
  let right = bound.x + bound.width;
  let bottom = bound.y;
  let top = bound.y + bound.height;
  if (handle.includes("w")) left = Math.min(point.x, right - min);
  if (handle.includes("e")) right = Math.max(point.x, left + min);
  if (handle.includes("n")) top = Math.max(point.y, bottom + min);
  if (handle.includes("s")) bottom = Math.min(point.y, top - min);
  if (Number.isFinite(lockAspectRatio) && lockAspectRatio! > 0) {
    const horizontal = handle.includes("e") || handle.includes("w");
    const vertical = handle.includes("n") || handle.includes("s");
    const aspect = lockAspectRatio!;
    if (horizontal && vertical) {
      const anchorX = handle.includes("e") ? bound.x : bound.x + bound.width;
      const anchorY = handle.includes("n") ? bound.y : bound.y + bound.height;
      const width = right - left;
      const height = top - bottom;
      const lockedWidth = Math.max(min, Math.min(width, height * aspect));
      const lockedHeight = Math.max(min, lockedWidth / aspect);
      left = handle.includes("e") ? anchorX : anchorX - lockedWidth;
      right = handle.includes("e") ? anchorX + lockedWidth : anchorX;
      bottom = handle.includes("n") ? anchorY : anchorY - lockedHeight;
      top = handle.includes("n") ? anchorY + lockedHeight : anchorY;
    } else if (horizontal) {
      const height = Math.max(min, (right - left) / aspect);
      const centerY = bound.y + bound.height / 2;
      bottom = centerY - height / 2;
      top = centerY + height / 2;
    } else if (vertical) {
      const width = Math.max(min, (top - bottom) * aspect);
      const centerX = bound.x + bound.width / 2;
      left = centerX - width / 2;
      right = centerX + width / 2;
    }
  }
  return { ...bound, x: left, y: bottom, width: right - left, height: top - bottom };
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
    || (sampled.frameWidth !== undefined && (!Number.isFinite(sampled.frameWidth) || sampled.frameWidth <= 0))
    || sampled.frameHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;
  const ratio = cameraAspectValue(track.aspectRatio);
  const requestedWidth = sampled.frameWidth ?? sampled.frameHeight * ratio;
  const requestedHeight = requestedWidth / ratio;
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
