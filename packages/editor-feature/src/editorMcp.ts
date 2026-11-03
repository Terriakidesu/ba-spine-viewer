import { STAGE_VIEW_MAX_SCALE, STAGE_VIEW_MIN_SCALE } from "./stageView";

export type EditorMcpBlendMode = "normal" | "multiply" | "screen" | "additive";
export type EditorMcpPreviewCaptureMode = "composition" | "viewport";

export interface EditorMcpPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorMcpPreviewSnapshot {
  view: { scale: number; x: number; y: number };
  stage: EditorMcpPreviewRect | null;
  composition: EditorMcpPreviewRect | null;
  renderers: Array<{
    id: string;
    visible: boolean;
    ready: boolean;
    contextLost: boolean;
    renderEnabled: boolean;
    canvasWidth: number;
    canvasHeight: number;
    animation: string;
    sampleTime: number | null;
  }>;
}

export interface EditorMcpTimelineSnapshot {
  sequenceId: string | null;
  currentTime: number;
  duration: number;
  availableSequences: Array<{ id: string; name: string }>;
  playing: boolean;
  speed: number;
  loop: boolean;
  selected: Array<{ kind: string; id: string }>;
  visualLayers: Array<{
    kind: "spine" | "color";
    id: string;
    name: string;
    order: number;
    enabled: boolean;
    locked: boolean;
    opacity: number;
    blendMode: EditorMcpBlendMode;
    directory?: string;
    clips?: Array<{
      id: string;
      name: string;
      color: string;
      start: number;
      end: number;
      opacity: number;
      fadeIn: number;
      fadeOut: number;
      enabled: boolean;
      active: boolean;
      effectiveOpacity: number;
    }>;
  }>;
  subtitles: Array<{ id: string; start: number; end: number; enabled: boolean; text: string }>;
  audio: Array<{ id: string; path: string; start: number; end: number; enabled: boolean }>;
  renderedLayers: Array<{
    id: string;
    kind: "spine" | "color";
    visible: boolean;
    opacity: number;
    blendMode: string;
    animation?: string;
    sampleTime?: number;
  }>;
  preview: EditorMcpPreviewSnapshot;
}

export interface EditorMcpState {
  snapshotRevision?: number;
  snapshotUpdatedAt?: string;
  snapshotAgeMs?: number;
  workspace: "interaction" | "timeline";
  assetRoot: string | null;
  assetSets: string[];
  directory: string | null;
  assetLoading: boolean;
  loadProgress: { stage: string; loaded: number; total: number };
  status: string;
  error: string | null;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  animations: string[];
  viewport: { width: number; height: number; devicePixelRatio: number };
  runtimeErrors: Array<{ time: string; message: string }>;
  timeline: EditorMcpTimelineSnapshot | null;
}

export type EditorMcpColorClipPreset = "solid" | "fade-from-black" | "fade-to-black" | "white-flash";

export type EditorMcpCommand =
  | { name: "open_asset_root"; rootPath: string }
  | { name: "select_asset_set"; directory: string }
  | { name: "set_workspace"; workspace: "interaction" | "timeline" }
  | { name: "select_sequence"; sequenceId: string }
  | { name: "seek"; seconds: number }
  | { name: "set_playback"; playing: boolean }
  | { name: "set_preview_view"; patch: { scale?: number; x?: number; y?: number } }
  | { name: "zoom_preview"; factor: number; cursor?: { x: number; y: number } }
  | { name: "pan_preview"; deltaX: number; deltaY: number }
  | { name: "reset_preview"; mode?: "pan" | "fit" }
  | { name: "select_visual"; kind: "spine-layer" | "color-layer" | "color-clip"; id: string }
  | { name: "update_spine_layer"; layerId: string; patch: { name?: string; enabled?: boolean; locked?: boolean; blendMode?: EditorMcpBlendMode; animation?: string; faceAnimation?: string; followMainAnimation?: boolean; start?: number; end?: number; endMode?: "auto" | "manual"; animationOffset?: number; loop?: boolean; x?: number; y?: number; scale?: number; opacity?: number } }
  | { name: "reorder_visual_layer"; layerId: string; targetLayerId: string }
  | { name: "add_color_layer"; nameHint?: string }
  | { name: "add_color_clip"; preset?: EditorMcpColorClipPreset; layerId?: string }
  | { name: "update_color_layer"; layerId: string; patch: { name?: string; enabled?: boolean; locked?: boolean; opacity?: number; blendMode?: EditorMcpBlendMode } }
  | { name: "update_color_clip"; clipId: string; patch: { name?: string; color?: string; start?: number; end?: number; opacity?: number; fadeIn?: number; fadeOut?: number; enabled?: boolean } }
  | { name: "save" }
  | { name: "capture_preview"; mode?: EditorMcpPreviewCaptureMode };

export interface EditorMcpTimelineBridge {
  snapshot: () => EditorMcpTimelineSnapshot | null;
  execute: (command: EditorMcpCommand) => Promise<unknown> | unknown;
}

export interface EditorMcpConnectionInfo {
  version: 1;
  pid: number;
  port: number;
  token: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`MCP command requires ${field}.`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function optionalNumber(value: unknown, field: string, min: number, max = Number.POSITIVE_INFINITY): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} must be a finite number between ${min} and ${max}.`);
  return value;
}

function validatePatch(value: unknown, allowed: readonly string[], required: string): Record<string, unknown> {
  if (!isRecord(value) || !onlyKeys(value, allowed) || Object.keys(value).length === 0) throw new Error(`${required} must contain only supported fields.`);
  return value;
}

/** Parse the untrusted JSON command crossing the localhost MCP/UI boundary. */
export function normalizeEditorMcpCommand(value: unknown): EditorMcpCommand {
  if (!isRecord(value) || typeof value.name !== "string") throw new Error("An editor MCP command name is required.");
  switch (value.name) {
    case "open_asset_root":
      if (!onlyKeys(value, ["name", "rootPath"])) throw new Error("Unexpected open_asset_root fields.");
      return { name: value.name, rootPath: stringField(value.rootPath, "rootPath") };
    case "select_asset_set":
      if (!onlyKeys(value, ["name", "directory"])) throw new Error("Unexpected select_asset_set fields.");
      return { name: value.name, directory: stringField(value.directory, "directory") };
    case "set_workspace":
      if (!onlyKeys(value, ["name", "workspace"]) || (value.workspace !== "interaction" && value.workspace !== "timeline")) throw new Error("workspace must be interaction or timeline.");
      return { name: value.name, workspace: value.workspace };
    case "select_sequence":
      if (!onlyKeys(value, ["name", "sequenceId"])) throw new Error("Unexpected select_sequence fields.");
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId") };
    case "seek": {
      if (!onlyKeys(value, ["name", "seconds"])) throw new Error("Unexpected seek fields.");
      const seconds = optionalNumber(value.seconds, "seconds", 0);
      if (seconds === undefined) throw new Error("MCP command requires seconds.");
      return { name: value.name, seconds };
    }
    case "set_playback":
      if (!onlyKeys(value, ["name", "playing"]) || typeof value.playing !== "boolean") throw new Error("playing must be a boolean.");
      return { name: value.name, playing: value.playing };
    case "set_preview_view": {
      if (!onlyKeys(value, ["name", "patch"])) throw new Error("Unexpected set_preview_view fields.");
      const patch = validatePatch(value.patch, ["scale", "x", "y"], "patch");
      if (patch.scale !== undefined) optionalNumber(patch.scale, "patch.scale", STAGE_VIEW_MIN_SCALE, STAGE_VIEW_MAX_SCALE);
      if (patch.x !== undefined) optionalNumber(patch.x, "patch.x", -100_000, 100_000);
      if (patch.y !== undefined) optionalNumber(patch.y, "patch.y", -100_000, 100_000);
      return { name: value.name, patch: patch as Extract<EditorMcpCommand, { name: "set_preview_view" }>['patch'] };
    }
    case "zoom_preview": {
      if (!onlyKeys(value, ["name", "factor", "cursor"])) throw new Error("Unexpected zoom_preview fields.");
      const factor = optionalNumber(value.factor, "factor", 0.01, 100);
      if (factor === undefined) throw new Error("MCP command requires factor.");
      let cursor: { x: number; y: number } | undefined;
      if (value.cursor !== undefined) {
        if (!isRecord(value.cursor) || !onlyKeys(value.cursor, ["x", "y"])) throw new Error("cursor must contain only x and y coordinates.");
        const x = optionalNumber(value.cursor.x, "cursor.x", -100_000, 100_000);
        const y = optionalNumber(value.cursor.y, "cursor.y", -100_000, 100_000);
        if (x === undefined || y === undefined) throw new Error("cursor requires finite x and y coordinates.");
        cursor = { x, y };
      }
      return { name: value.name, factor, ...(cursor ? { cursor } : {}) };
    }
    case "pan_preview": {
      if (!onlyKeys(value, ["name", "deltaX", "deltaY"])) throw new Error("Unexpected pan_preview fields.");
      const deltaX = optionalNumber(value.deltaX, "deltaX", -100_000, 100_000);
      const deltaY = optionalNumber(value.deltaY, "deltaY", -100_000, 100_000);
      if (deltaX === undefined || deltaY === undefined) throw new Error("pan_preview requires finite deltaX and deltaY values.");
      return { name: value.name, deltaX, deltaY };
    }
    case "reset_preview":
      if (!onlyKeys(value, ["name", "mode"]) || (value.mode !== undefined && value.mode !== "pan" && value.mode !== "fit")) throw new Error("mode must be pan or fit.");
      return { name: value.name, ...(value.mode === undefined ? {} : { mode: value.mode }) };
    case "select_visual":
      if (!onlyKeys(value, ["name", "kind", "id"]) || !["spine-layer", "color-layer", "color-clip"].includes(String(value.kind))) throw new Error("Unsupported visual selection.");
      return { name: value.name, kind: value.kind as "spine-layer" | "color-layer" | "color-clip", id: stringField(value.id, "id") };
    case "update_spine_layer": {
      if (!onlyKeys(value, ["name", "layerId", "patch"])) throw new Error("Unexpected update_spine_layer fields.");
      const patch = validatePatch(value.patch, ["name", "enabled", "locked", "blendMode", "animation", "faceAnimation", "followMainAnimation", "start", "end", "endMode", "animationOffset", "loop", "x", "y", "scale", "opacity"], "patch");
      if (patch.name !== undefined) stringField(patch.name, "patch.name");
      for (const field of ["enabled", "locked", "followMainAnimation", "loop"] as const) if (patch[field] !== undefined) optionalBoolean(patch[field], `patch.${field}`);
      if (patch.blendMode !== undefined && !["normal", "multiply", "screen", "additive"].includes(String(patch.blendMode))) throw new Error("Unsupported Spine layer blend mode.");
      if (patch.animation !== undefined && typeof patch.animation !== "string") throw new Error("patch.animation must be a string.");
      if (patch.faceAnimation !== undefined && typeof patch.faceAnimation !== "string") throw new Error("patch.faceAnimation must be a string.");
      if (patch.endMode !== undefined && patch.endMode !== "auto" && patch.endMode !== "manual") throw new Error("patch.endMode must be auto or manual.");
      if (patch.start !== undefined) optionalNumber(patch.start, "patch.start", 0);
      if (patch.end !== undefined) optionalNumber(patch.end, "patch.end", 0);
      if (patch.animationOffset !== undefined) optionalNumber(patch.animationOffset, "patch.animationOffset", 0);
      if (patch.x !== undefined) optionalNumber(patch.x, "patch.x", -100_000, 100_000);
      if (patch.y !== undefined) optionalNumber(patch.y, "patch.y", -100_000, 100_000);
      if (patch.scale !== undefined) optionalNumber(patch.scale, "patch.scale", 0.01, 1000);
      if (patch.opacity !== undefined) optionalNumber(patch.opacity, "patch.opacity", 0, 1);
      return { name: value.name, layerId: stringField(value.layerId, "layerId"), patch: patch as Extract<EditorMcpCommand, { name: "update_spine_layer" }>['patch'] };
    }
    case "reorder_visual_layer":
      if (!onlyKeys(value, ["name", "layerId", "targetLayerId"])) throw new Error("Unexpected reorder_visual_layer fields.");
      return { name: value.name, layerId: stringField(value.layerId, "layerId"), targetLayerId: stringField(value.targetLayerId, "targetLayerId") };
    case "add_color_layer":
      if (!onlyKeys(value, ["name", "nameHint"])) throw new Error("Unexpected add_color_layer fields.");
      return { name: value.name, ...(value.nameHint === undefined ? {} : { nameHint: stringField(value.nameHint, "nameHint") }) };
    case "add_color_clip":
      if (!onlyKeys(value, ["name", "preset", "layerId"])) throw new Error("Unexpected add_color_clip fields.");
      if (value.preset !== undefined && !["solid", "fade-from-black", "fade-to-black", "white-flash"].includes(String(value.preset))) throw new Error("Unsupported color clip preset.");
      return {
        name: value.name,
        ...(value.preset === undefined ? {} : { preset: value.preset as EditorMcpColorClipPreset }),
        ...(value.layerId === undefined ? {} : { layerId: stringField(value.layerId, "layerId") }),
      };
    case "update_color_layer": {
      if (!onlyKeys(value, ["name", "layerId", "patch"])) throw new Error("Unexpected update_color_layer fields.");
      const patch = validatePatch(value.patch, ["name", "enabled", "locked", "opacity", "blendMode"], "patch");
      if (patch.name !== undefined) stringField(patch.name, "patch.name");
      if (patch.enabled !== undefined) optionalBoolean(patch.enabled, "patch.enabled");
      if (patch.locked !== undefined) optionalBoolean(patch.locked, "patch.locked");
      if (patch.opacity !== undefined) optionalNumber(patch.opacity, "patch.opacity", 0, 1);
      if (patch.blendMode !== undefined && !["normal", "multiply", "screen", "additive"].includes(String(patch.blendMode))) throw new Error("Unsupported color layer blend mode.");
      return { name: value.name, layerId: stringField(value.layerId, "layerId"), patch: patch as Extract<EditorMcpCommand, { name: "update_color_layer" }>["patch"] };
    }
    case "update_color_clip": {
      if (!onlyKeys(value, ["name", "clipId", "patch"])) throw new Error("Unexpected update_color_clip fields.");
      const patch = validatePatch(value.patch, ["name", "color", "start", "end", "opacity", "fadeIn", "fadeOut", "enabled"], "patch");
      if (patch.name !== undefined) stringField(patch.name, "patch.name");
      if (patch.color !== undefined && (typeof patch.color !== "string" || !/^#[\da-f]{6}$/i.test(patch.color))) throw new Error("patch.color must be a six-digit hex color.");
      if (patch.start !== undefined) optionalNumber(patch.start, "patch.start", 0);
      if (patch.end !== undefined) optionalNumber(patch.end, "patch.end", 0);
      if (patch.opacity !== undefined) optionalNumber(patch.opacity, "patch.opacity", 0, 1);
      if (patch.fadeIn !== undefined) optionalNumber(patch.fadeIn, "patch.fadeIn", 0);
      if (patch.fadeOut !== undefined) optionalNumber(patch.fadeOut, "patch.fadeOut", 0);
      if (patch.enabled !== undefined) optionalBoolean(patch.enabled, "patch.enabled");
      return { name: value.name, clipId: stringField(value.clipId, "clipId"), patch: patch as Extract<EditorMcpCommand, { name: "update_color_clip" }>["patch"] };
    }
    case "save":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected save fields.");
      return { name: value.name };
    case "capture_preview":
      if (!onlyKeys(value, ["name", "mode"]) || (value.mode !== undefined && value.mode !== "composition" && value.mode !== "viewport")) throw new Error("mode must be composition or viewport.");
      return { name: value.name, ...(value.mode === undefined ? {} : { mode: value.mode }) };
    default:
      throw new Error(`Unsupported editor MCP command: ${value.name}`);
  }
}
