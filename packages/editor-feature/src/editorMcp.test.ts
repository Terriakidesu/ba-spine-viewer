import { describe, expect, test } from "bun:test";
import { normalizeEditorMcpCommand } from "./editorMcp";

describe("editor MCP command validation", () => {
  test("accepts supported timeline and color edits", () => {
    expect(normalizeEditorMcpCommand({ name: "seek", seconds: 2.5 })).toEqual({ name: "seek", seconds: 2.5 });
    expect(normalizeEditorMcpCommand({ name: "update_color_layer", layerId: "color-1", patch: { blendMode: "additive", opacity: 0.4 } })).toEqual({
      name: "update_color_layer",
      layerId: "color-1",
      patch: { blendMode: "additive", opacity: 0.4 },
    });
    expect(normalizeEditorMcpCommand({ name: "set_preview_view", patch: { scale: 1.5, x: -20 } })).toEqual({ name: "set_preview_view", patch: { scale: 1.5, x: -20 } });
    expect(normalizeEditorMcpCommand({ name: "set_preview_view", patch: { scale: 12 } })).toEqual({ name: "set_preview_view", patch: { scale: 12 } });
    expect(normalizeEditorMcpCommand({ name: "zoom_preview", factor: 1.25, cursor: { x: 400, y: 200 } })).toEqual({ name: "zoom_preview", factor: 1.25, cursor: { x: 400, y: 200 } });
    expect(normalizeEditorMcpCommand({ name: "pan_preview", deltaX: 12, deltaY: -9 })).toEqual({ name: "pan_preview", deltaX: 12, deltaY: -9 });
    expect(normalizeEditorMcpCommand({ name: "reset_preview", mode: "pan" })).toEqual({ name: "reset_preview", mode: "pan" });
    expect(normalizeEditorMcpCommand({ name: "set_workspace", workspace: "camera" })).toEqual({ name: "set_workspace", workspace: "camera" });
    expect(normalizeEditorMcpCommand({ name: "update_spine_layer", layerId: "spine-1", patch: { enabled: false, blendMode: "screen", opacity: 0.75 } })).toEqual({
      name: "update_spine_layer",
      layerId: "spine-1",
      patch: { enabled: false, blendMode: "screen", opacity: 0.75 },
    });
    expect(normalizeEditorMcpCommand({ name: "capture_preview", mode: "viewport" })).toEqual({ name: "capture_preview", mode: "viewport" });
    expect(normalizeEditorMcpCommand({ name: "start_waveform_profile" })).toEqual({ name: "start_waveform_profile" });
    expect(normalizeEditorMcpCommand({ name: "stop_waveform_profile" })).toEqual({ name: "stop_waveform_profile" });
  });

  test("rejects unsupported fields, malformed values, and unknown commands", () => {
    expect(() => normalizeEditorMcpCommand({ name: "seek", seconds: -1 })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "seek", seconds: 1, script: "alert(1)" })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_color_clip", clipId: "clip-1", patch: { color: "red" } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "set_preview_view", patch: {} })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "set_preview_view", patch: { scale: 21 } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "zoom_preview", factor: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "pan_preview", deltaX: 1, deltaY: Number.NaN })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_spine_layer", layerId: "spine-1", patch: { opacity: 1.5 } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_spine_layer", layerId: "spine-1", patch: { scale: 0 } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "capture_preview", mode: "desktop" })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "execute_javascript", source: "alert(1)" })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "start_waveform_profile", source: "alert(1)" })).toThrow();
  });
});
