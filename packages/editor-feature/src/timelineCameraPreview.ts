import type { SpineCameraFrame } from "@ba-spine/spine-runtime/spine/spineRuntime";

/** Use the authored output frame, falling back to a shared reference-artwork fit. */
export function timelinePreviewCameraFrame(
  cameraEnabled: boolean,
  authoredFrame: SpineCameraFrame | null,
  referenceArtworkFrame: SpineCameraFrame | null,
): SpineCameraFrame | null {
  return (cameraEnabled ? authoredFrame : null) ?? referenceArtworkFrame;
}
