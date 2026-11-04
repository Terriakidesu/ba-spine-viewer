import { describe, expect, test } from "bun:test";
import { HANDOFF_PROTOCOL_VERSION, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import {
  normalizeVoiceVolume,
  readViewerVoiceVolume,
  restoreViewerHandoffState,
  VIEWER_VOICE_VOLUME_KEY,
  writeViewerVoiceVolume,
  type ViewerReloadSnapshot,
} from "./handoffState";

const current: ViewerReloadSnapshot = {
  language: "ja",
  cameraMode: "fit",
  cameraPose: { x: 120, y: -45, zoom: 2.25 },
  voiceVolume: 0.35,
  playing: false,
  loop: false,
  speed: 1.5,
  playheadSeconds: 18.25,
  sequenceId: "talk-2",
  animation: "idle_loop",
};

const message: SpineHandoffMessage = {
  protocolVersion: HANDOFF_PROTOCOL_VERSION,
  requestId: "req_00000001",
  targetApp: "viewer",
  library: { identity: "sha256:library", path: "C:\\library" },
  lobbyId: "Airi_home",
  language: "en-US",
};

describe("Viewer saved-handoff state preservation", () => {
  test("preserves language, camera, voice volume, and paused playback on same-lobby reload", () => {
    expect(restoreViewerHandoffState(current, message, true)).toEqual({
      language: "ja",
      cameraMode: "fit",
      cameraPose: { x: 120, y: -45, zoom: 2.25 },
      voiceVolume: 0.35,
      playing: false,
      loop: false,
      speed: 1.5,
      sequenceId: "talk-2",
      playheadSeconds: 18.25,
      animation: "idle_loop",
    });
  });

  test("uses explicit handoff sequence/playhead while retaining presentation preferences", () => {
    expect(restoreViewerHandoffState(current, {
      ...message,
      sequenceId: "opening",
      playheadSeconds: 4,
    }, true)).toMatchObject({
      language: "ja",
      cameraMode: "fit",
      cameraPose: { x: 120, y: -45, zoom: 2.25 },
      voiceVolume: 0.35,
      playing: false,
      loop: false,
      speed: 1.5,
      sequenceId: "opening",
      playheadSeconds: 4,
    });
  });

  test("does not carry the previous lobby's animation or playhead to a different selection", () => {
    const restored = restoreViewerHandoffState(current, message, false);
    expect(restored).toMatchObject({
      language: "ja",
      cameraMode: "fit",
      voiceVolume: 0.35,
      playing: false,
      loop: false,
      speed: 1.5,
    });
    expect(restored.sequenceId).toBeUndefined();
    expect(restored.playheadSeconds).toBeUndefined();
    expect(restored.animation).toBeUndefined();
    expect(restored.cameraPose).toBeUndefined();
  });

  test("preserves the authored camera mode on same-selection reloads", () => {
    expect(restoreViewerHandoffState({ ...current, cameraMode: "authored" }, message, true).cameraMode).toBe("authored");
  });

  test("normalizes and persists voice volume without making storage mandatory", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readViewerVoiceVolume(storage)).toBe(1);
    writeViewerVoiceVolume(1.7, storage);
    expect(values.get(VIEWER_VOICE_VOLUME_KEY)).toBe("1");
    expect(readViewerVoiceVolume(storage)).toBe(1);
    expect(normalizeVoiceVolume(-0.2)).toBe(0);
    expect(normalizeVoiceVolume(Number.NaN)).toBe(1);
  });
});
