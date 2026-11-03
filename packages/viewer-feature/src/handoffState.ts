import type { SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import type { SpineCameraMode, SpineCameraPose } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { Language } from "./i18n/types";

export interface ViewerReloadSnapshot {
  language: Language;
  cameraMode: SpineCameraMode;
  cameraPose: SpineCameraPose | null;
  voiceVolume: number;
  playing: boolean;
  loop: boolean;
  speed: number;
  playheadSeconds: number;
  sequenceId: string;
  animation: string;
}

export interface ViewerHandoffRestoreState {
  language: Language;
  cameraMode: SpineCameraMode;
  cameraPose?: SpineCameraPose;
  voiceVolume: number;
  playing: boolean;
  loop: boolean;
  speed: number;
  sequenceId?: string;
  playheadSeconds?: number;
  animation?: string;
}

/** Preserve Viewer presentation on a saved-file handoff; explicit playback context wins. */
export function restoreViewerHandoffState(
  current: ViewerReloadSnapshot,
  message: SpineHandoffMessage,
  sameSelection: boolean,
): ViewerHandoffRestoreState {
  const requestedTime = message.playheadSeconds
    ?? (sameSelection && Number.isFinite(current.playheadSeconds) && current.playheadSeconds >= 0
      ? current.playheadSeconds
      : undefined);
  return {
    // The Viewer owns its display language; an Editor handoff must not change it.
    language: current.language,
    cameraMode: current.cameraMode,
    ...(sameSelection && current.cameraPose
      && Number.isFinite(current.cameraPose.x)
      && Number.isFinite(current.cameraPose.y)
      && Number.isFinite(current.cameraPose.zoom)
      && current.cameraPose.zoom > 0
      ? { cameraPose: { ...current.cameraPose } }
      : {}),
    voiceVolume: Number.isFinite(current.voiceVolume) ? Math.max(0, Math.min(1, current.voiceVolume)) : 1,
    playing: current.playing,
    loop: current.loop,
    speed: Number.isFinite(current.speed) ? Math.max(0.1, Math.min(3, current.speed)) : 1,
    ...(message.sequenceId ? { sequenceId: message.sequenceId } : sameSelection && current.sequenceId ? { sequenceId: current.sequenceId } : {}),
    ...(requestedTime !== undefined ? { playheadSeconds: requestedTime } : {}),
    ...(sameSelection && current.animation ? { animation: current.animation } : {}),
  };
}

export const VIEWER_VOICE_VOLUME_KEY = "ba-spine-viewer-voice-volume";

export function normalizeVoiceVolume(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

export function readViewerVoiceVolume(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage)
      : storage;
    if (!target) return 1;
    const stored = target.getItem(VIEWER_VOICE_VOLUME_KEY);
    if (stored === null) return 1;
    const value = Number(stored);
    return Number.isFinite(value) ? normalizeVoiceVolume(value) : 1;
  } catch {
    return 1;
  }
}

export function writeViewerVoiceVolume(value: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage)
      : storage;
    target?.setItem(VIEWER_VOICE_VOLUME_KEY, String(normalizeVoiceVolume(value)));
  } catch {
    // Preferences are optional; a storage restriction must not interrupt playback.
  }
}
