import { cameraAspectValue, isCameraAspectRatio, type SpineCameraAspectRatio } from "@ba-spine/spine-runtime/spine/spineCameraMotion";

export type ViewerAspectRatio = SpineCameraAspectRatio;
export const DEFAULT_VIEWER_ASPECT_RATIO: ViewerAspectRatio = "16:9";
export const VIEWER_ASPECT_RATIO_KEY = "ba-spine-viewer:aspect-ratio:v1";

export function normalizeViewerAspectRatio(value: unknown): ViewerAspectRatio {
  return isCameraAspectRatio(value) ? value : DEFAULT_VIEWER_ASPECT_RATIO;
}

export function readViewerAspectRatio(storage?: Pick<Storage, "getItem"> | null): ViewerAspectRatio {
  try {
    const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
    return normalizeViewerAspectRatio(target?.getItem(VIEWER_ASPECT_RATIO_KEY));
  } catch {
    return DEFAULT_VIEWER_ASPECT_RATIO;
  }
}

export function hasLegacyViewerAspectRatio(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
    return target?.getItem(VIEWER_ASPECT_RATIO_KEY) === "1:1";
  } catch {
    return false;
  }
}

export function writeViewerAspectRatio(value: ViewerAspectRatio, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
    target?.setItem(VIEWER_ASPECT_RATIO_KEY, normalizeViewerAspectRatio(value));
  } catch {
    // A preference failure must not affect playback.
  }
}

export interface AspectRatioBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitAspectRatioBox(containerWidth: number, containerHeight: number, ratio: ViewerAspectRatio): AspectRatioBox {
  if (![containerWidth, containerHeight].every(Number.isFinite) || containerWidth <= 0 || containerHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const aspect = cameraAspectValue(ratio);
  const width = Math.min(containerWidth, containerHeight * aspect);
  const height = width / aspect;
  return {
    x: Math.round((containerWidth - width) / 2),
    y: Math.round((containerHeight - height) / 2),
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}
