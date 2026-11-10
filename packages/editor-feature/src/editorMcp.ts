import { STAGE_VIEW_MAX_SCALE, STAGE_VIEW_MIN_SCALE } from "./stageView";
import type { EditorWaveformProfileSnapshot } from "./waveformProfileDiagnostics";
import type { EditorAudioClip, EditorInteraction, EditorProject, EditorRegion, EditorTimeline } from "./editorModel";
import type { SpineLookFollowSettings } from "@ba-spine/spine-runtime/spine/spineInteraction";
import type { SpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { normalizeSpineBehaviorMachines, type SpineBehaviorEvent } from "@ba-spine/spine-runtime/spine/spineBehavior";
import type { SpineBehaviorDebugMachine } from "@ba-spine/spine-runtime/spine/spineBehaviorRuntime";
import { normalizeSpineCameraTrack, type SpineCameraTrack } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import type { BehaviorGraphLayouts } from "./behaviorGraph";
import { normalizeBehaviorGraphLayouts } from "./behaviorGraph";
import type { InteractionPreviewDebug } from "./preview";

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
  audio: Array<{ id: string; path: string; start: number; end: number; enabled: boolean; decodedDuration?: number }>;
  /** Full authored data for the active sequence; playback-only state remains separate. */
  sequence: EditorTimeline;
  animationInfo: Array<{
    layerId: string;
    directory: string;
    animations: Array<{ name: string; duration: number | null }>;
  }>;
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
  /** Advances only when the authored project document changes, not on playback heartbeats. */
  documentRevision: number;
  snapshotUpdatedAt?: string;
  snapshotAgeMs?: number;
  workspace: "interaction" | "timeline" | "camera";
  assetRoot: string | null;
  assetSets: string[];
  directory: string | null;
  projectName?: string | null;
  assetLoading: boolean;
  loadProgress: { stage: string; loaded: number; total: number };
  status: string;
  error: string | null;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  animations: string[];
  viewport: { width: number; height: number; devicePixelRatio: number };
  runtimeErrors: Array<{ time: string; message: string }>;
  timeline: EditorMcpTimelineSnapshot | null;
  waveformProfilingAvailable?: boolean;
  behaviorRuntime?: {
    debug: SpineBehaviorDebugMachine[];
    feedback: string[];
    interaction: InteractionPreviewDebug;
    interactionTesting: boolean;
    lookFollowTesting: boolean;
  };
  waveformProfile?: EditorWaveformProfileSnapshot | null;
}

export type EditorMcpColorClipPreset = "solid" | "fade-from-black" | "fade-to-black" | "white-flash";

export type EditorMcpInteractionPatch = Partial<Omit<EditorInteraction, "id" | "regions">>;
export type EditorMcpRegionPatch = Partial<Omit<EditorRegion, "id">>;
export type EditorMcpProjectSettingsPatch = Partial<Pick<EditorProject, "name" | "entrySequence" | "talkMixDuration" | "effectsStrength">>;
export type EditorMcpAudioPatch = Partial<Pick<EditorAudioClip, "name" | "path" | "start" | "end" | "enabled" | "volume" | "autoEnd">>;

/** Stable fingerprint for authored project data; UI selection is intentionally excluded. */
export function editorDocumentFingerprint(project: EditorProject): string {
  const authored = structuredClone(project);
  authored.selectedInteractionId = null;
  authored.selectedRegionId = null;
  authored.selectedBonePath = null;
  const clearTimelineSelection = (timeline: EditorTimeline) => {
    timeline.selectedLayerId = null;
    timeline.selectedCueId = null;
    timeline.selectedColorLayerId = null;
    timeline.selectedColorClipId = null;
  };
  clearTimelineSelection(authored.timeline);
  for (const timeline of Object.values(authored.sequences ?? {})) clearTimelineSelection(timeline);
  const activeSequenceId = authored.timeline.sequenceId ?? "legacy";
  const sequences = { ...(authored.sequences ?? {}), [activeSequenceId]: authored.timeline };
  const { timeline: _activeTimeline, ...projectSettings } = authored;
  return JSON.stringify({ ...projectSettings, sequences: Object.fromEntries(Object.entries(sequences).sort(([left], [right]) => left.localeCompare(right))) });
}

export function editorDocumentSaveState(project: EditorProject, savedFingerprint: string): "saved" | "dirty" {
  return editorDocumentFingerprint(project) === savedFingerprint ? "saved" : "dirty";
}

export type EditorMcpCommand =
  | { name: "get_project" }
  | { name: "validate_project" }
  | { name: "preview_change_set"; operations: EditorMcpCommand[] }
  | { name: "apply_change_set"; changeSetId: string }
  | { name: "inspect_recovery" }
  | { name: "restore_recovery"; candidate: "latest" | "backup"; backupIndex?: number }
  | { name: "open_project_file"; path: string }
  | { name: "undo" }
  | { name: "redo" }
  | { name: "add_interaction" }
  | { name: "update_interaction"; interactionId: string; patch: EditorMcpInteractionPatch }
  | { name: "duplicate_interaction"; interactionId: string }
  | { name: "delete_interaction"; interactionId: string }
  | { name: "select_interaction"; interactionId: string }
  | { name: "add_region"; interactionId: string; anchorBonePath?: string | null }
  | { name: "update_region"; interactionId: string; regionId: string; patch: EditorMcpRegionPatch }
  | { name: "duplicate_region"; interactionId: string; regionId: string }
  | { name: "delete_region"; interactionId: string; regionId: string }
  | { name: "select_region"; interactionId: string; regionId: string }
  | { name: "update_look_follow"; patch: Partial<SpineLookFollowSettings> }
  | { name: "replace_behavior_machines"; machines: SpineBehaviorMachine[]; graphLayouts?: BehaviorGraphLayouts }
  | { name: "create_talk_sequence" }
  | { name: "delete_sequence"; sequenceId: string }
  | { name: "reorder_sequences"; sequenceIds: string[] }
  | { name: "replace_sequence"; sequenceId: string; sequence: EditorTimeline }
  | { name: "update_camera_track"; sequenceId: string; camera: SpineCameraTrack | null }
  | { name: "evaluate_camera_track"; sequenceId: string; seconds: number }
  | { name: "frame_camera_item"; kind: "shot" | "bound"; id: string }
  | { name: "update_project_settings"; patch: EditorMcpProjectSettingsPatch }
  | { name: "add_audio_clip"; sequenceId: string; audio: EditorAudioClip }
  | { name: "duplicate_audio_clip"; sequenceId: string; audioId: string }
  | { name: "update_audio_clip"; sequenceId: string; audioId: string; patch: EditorMcpAudioPatch }
  | { name: "delete_audio_clip"; sequenceId: string; audioId: string }
  | { name: "link_audio_subtitle"; sequenceId: string; audioId: string; subtitleId: string | null }
  | { name: "list_audio_assets" }
  | { name: "match_audio_length"; audioId: string }
  | { name: "preview_audio_clip"; audioId: string }
  | { name: "stop_audio_preview" }
  | { name: "create_spine_layer"; directory: string }
  | { name: "delete_spine_layer"; layerId: string }
  | { name: "duplicate_animation_clip"; clipId: string }
  | { name: "duplicate_color_clip"; clipId: string }
  | { name: "delete_color_clip"; clipId: string }
  | { name: "delete_color_layer"; layerId: string }
  | { name: "duplicate_subtitle_cue"; cueId: string }
  | { name: "select_subtitle_cue"; cueId: string }
  | { name: "split_subtitle_cue"; cueId: string; at: number }
  | { name: "set_timeline_items_enabled"; items: Array<{ kind: "layer" | "color-layer" | "animation" | "color" | "cue" | "audio"; id: string }>; enabled: boolean }
  | { name: "delete_timeline_items"; items: Array<{ kind: "layer" | "color-layer" | "animation" | "color" | "cue" | "audio"; id: string }> }
  | { name: "preview_interaction_phase"; interactionId: string; phase: "start" | "follow" | "end" }
  | { name: "start_interaction_test"; interactionId: string; regionId?: string }
  | { name: "move_interaction_test"; worldX: number; worldY: number }
  | { name: "release_interaction_test" }
  | { name: "cancel_interaction_test" }
  | { name: "test_look_follow"; enabled: boolean }
  | { name: "inject_behavior_event"; machineId: string; event: SpineBehaviorEvent; regionId?: string | null }
  | { name: "cancel_behavior_test" }
  | { name: "open_asset_root"; rootPath: string }
  | { name: "select_asset_set"; directory: string }
  | { name: "set_workspace"; workspace: "interaction" | "timeline" | "camera" }
  | { name: "select_sequence"; sequenceId: string }
  | { name: "seek"; seconds: number }
  | { name: "set_playback"; playing: boolean }
  | { name: "set_preview_view"; patch: { scale?: number; x?: number; y?: number } }
  | { name: "zoom_preview"; factor: number; cursor?: { x: number; y: number } }
  | { name: "pan_preview"; deltaX: number; deltaY: number }
  | { name: "reset_preview"; mode?: "pan" | "fit" }
  | { name: "select_visual"; kind: "spine-layer" | "color-layer" | "color-clip"; id: string }
  | { name: "update_spine_layer"; layerId: string; patch: { name?: string; enabled?: boolean; locked?: boolean; blendMode?: EditorMcpBlendMode; animation?: string; faceAnimation?: string; followMainAnimation?: boolean; start?: number; end?: number; endMode?: "auto" | "manual"; animationOffset?: number; loop?: boolean; x?: number; y?: number; scale?: number; opacity?: number } }
  | { name: "add_animation_clip"; layerId: string; animation: string; start: number; end?: number; loop?: boolean; faceAnimation?: string | null; continueAfterOpening?: boolean }
  | { name: "update_animation_clip"; clipId: string; patch: { animation?: string; faceAnimation?: string | null; start?: number; end?: number; endMode?: "auto" | "manual"; animationOffset?: number; loop?: boolean; enabled?: boolean; continueAfterOpening?: boolean; hideCharacter?: boolean } }
  | { name: "move_animation_clip"; clipId: string; start: number; ripple: boolean }
  | { name: "delete_animation_clip"; clipId: string; ripple: boolean }
  | { name: "add_subtitle_cue"; start: number; end: number; text: Partial<Record<"en" | "ja" | "ko", string>> }
  | { name: "update_subtitle_cue"; cueId: string; patch: { start?: number; end?: number; enabled?: boolean; text?: Partial<Record<"en" | "ja" | "ko", string>> } }
  | { name: "delete_subtitle_cue"; cueId: string }
  | { name: "preview_subtitle_import"; path: string; policy: "replace-imported-cues" | "merge-missing-translations" | "update-text-only" }
  | { name: "apply_subtitle_import"; changeSetId: string }
  | { name: "reorder_visual_layer"; layerId: string; targetLayerId: string }
  | { name: "add_color_layer"; nameHint?: string }
  | { name: "add_color_clip"; preset?: EditorMcpColorClipPreset; layerId?: string }
  | { name: "update_color_layer"; layerId: string; patch: { name?: string; enabled?: boolean; locked?: boolean; opacity?: number; blendMode?: EditorMcpBlendMode } }
  | { name: "update_color_clip"; clipId: string; patch: { name?: string; color?: string; start?: number; end?: number; opacity?: number; fadeIn?: number; fadeOut?: number; enabled?: boolean } }
  | { name: "save" }
  | { name: "capture_preview"; mode?: EditorMcpPreviewCaptureMode }
  | { name: "start_waveform_profile" }
  | { name: "stop_waveform_profile" };

export type EditorMcpCommandName = EditorMcpCommand["name"];
export type EditorMcpMutationCategory = "none" | "authored" | "temporary" | "lifecycle" | "filesystem" | "review";
export type EditorMcpWorkspaceRequirement = "any" | "timeline-mounted" | "camera-workspace" | "interaction-renderer" | "waveform-profiling-build";
export type EditorMcpHandler = "editor" | "editor-or-timeline" | "timeline-renderer";

export interface EditorMcpProjectIdentity {
  hostPid: number | null;
  assetRoot: string | null;
  directory: string | null;
  projectName: string | null;
}

export interface EditorMcpResultEnvelope<T> {
  envelopeVersion: 1;
  ok: true;
  requestId: string;
  projectIdentity: { before: EditorMcpProjectIdentity; after: EditorMcpProjectIdentity };
  documentRevisions: { before: number | null; after: number | null };
  result: T;
  affectedEntityIds: string[];
  createdEntityIds: string[];
  warnings: string[];
  normalization: unknown | null;
  saveState: string | null;
}

export type EditorMcpErrorCode =
  | "stale_document_revision"
  | "invalid_reference"
  | "locked_entity"
  | "renderer_unavailable"
  | "external_conflict"
  | "unsupported_capability"
  | "invalid_command"
  | "revision_required"
  | "command_timeout"
  | "bridge_unavailable"
  | "editor_command_failed";

export interface EditorMcpErrorEnvelope {
  envelopeVersion: 1;
  ok: false;
  requestId: string | null;
  projectIdentity: { before: EditorMcpProjectIdentity; after: EditorMcpProjectIdentity };
  documentRevisions: { before: number | null; after: number | null };
  error: { code: EditorMcpErrorCode; message: string; details?: unknown };
  saveState: string | null;
}

export function createEditorMcpResultEnvelope<T>(input: {
  requestId: string;
  projectIdentityBefore: EditorMcpProjectIdentity;
  projectIdentityAfter: EditorMcpProjectIdentity;
  documentRevisionBefore: number | null;
  documentRevisionAfter: number | null;
  result: T;
  affectedEntityIds?: string[];
  createdEntityIds?: string[];
  warnings?: string[];
  normalization?: unknown;
  saveState?: string | null;
}): EditorMcpResultEnvelope<T> {
  return {
    envelopeVersion: 1,
    ok: true,
    requestId: input.requestId,
    projectIdentity: { before: input.projectIdentityBefore, after: input.projectIdentityAfter },
    documentRevisions: { before: input.documentRevisionBefore, after: input.documentRevisionAfter },
    result: input.result,
    affectedEntityIds: [...new Set(input.affectedEntityIds ?? [])],
    createdEntityIds: [...new Set(input.createdEntityIds ?? [])],
    warnings: [...(input.warnings ?? [])],
    normalization: input.normalization ?? null,
    saveState: input.saveState ?? null,
  };
}

export function createEditorMcpErrorEnvelope(input: {
  requestId?: string | null;
  projectIdentityBefore?: EditorMcpProjectIdentity;
  projectIdentityAfter?: EditorMcpProjectIdentity;
  documentRevisionBefore?: number | null;
  documentRevisionAfter?: number | null;
  error: { code: EditorMcpErrorCode; message: string; details?: unknown };
  saveState?: string | null;
}): EditorMcpErrorEnvelope {
  const emptyIdentity: EditorMcpProjectIdentity = { hostPid: null, assetRoot: null, directory: null, projectName: null };
  return {
    envelopeVersion: 1,
    ok: false,
    requestId: input.requestId ?? null,
    projectIdentity: { before: input.projectIdentityBefore ?? emptyIdentity, after: input.projectIdentityAfter ?? input.projectIdentityBefore ?? emptyIdentity },
    documentRevisions: { before: input.documentRevisionBefore ?? null, after: input.documentRevisionAfter ?? input.documentRevisionBefore ?? null },
    error: input.error,
    saveState: input.saveState ?? null,
  };
}

export function editorMcpErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    try {
      const serialized = JSON.stringify(value);
      if (serialized) return serialized;
    } catch { /* Fall through for cyclic or otherwise non-serializable host errors. */ }
  }
  return String(value);
}

export function classifyEditorMcpError(value: unknown): { code: EditorMcpErrorCode; message: string; details?: unknown } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const message = editorMcpErrorMessage(value);
  const explicitCode = record?.code;
  const supportedCodes: EditorMcpErrorCode[] = ["stale_document_revision", "invalid_reference", "locked_entity", "renderer_unavailable", "external_conflict", "unsupported_capability", "invalid_command", "revision_required", "command_timeout", "bridge_unavailable", "editor_command_failed"];
  if (typeof explicitCode === "string" && supportedCodes.includes(explicitCode as EditorMcpErrorCode)) return { code: explicitCode as EditorMcpErrorCode, message, ...(record?.details === undefined ? {} : { details: record.details }) };
  const normalized = message.toLocaleLowerCase();
  const code: EditorMcpErrorCode = normalized.includes("stale") && normalized.includes("revision") ? "stale_document_revision"
    : normalized.includes("locked") ? "locked_entity"
      : normalized.includes("not found") || normalized.includes("reference") ? "invalid_reference"
        : normalized.includes("conflict") || normalized.includes("external changes") ? "external_conflict"
          : normalized.includes("timeout") || normalized.includes("did not start") || normalized.includes("outcome may be unknown") ? "command_timeout"
            : normalized.includes("no running editor") || normalized.includes("not connected") || normalized.includes("desktop editor closed") || normalized.includes("bridge unavailable") || normalized.includes("unauthorized") ? "bridge_unavailable"
              : normalized.includes("renderer") || normalized.includes("not mounted") || normalized.includes("not ready") || normalized.includes("workspace") && (normalized.includes("requires") || normalized.includes("not active")) ? "renderer_unavailable"
                : normalized.includes("unsupported") || normalized.includes("unavailable") || normalized.includes("not enabled in this editor build") ? "unsupported_capability"
                  : normalized.includes("expecteddocumentrevision is required") ? "revision_required"
                    : normalized.includes("must be") || normalized.includes("unexpected") || normalized.includes("requires") || normalized.includes("invalid") ? "invalid_command"
                      : "editor_command_failed";
  return { code, message, ...(record?.details === undefined ? {} : { details: record.details }) };
}

export interface EditorMcpOperationDefinition<K extends EditorMcpCommandName = EditorMcpCommandName> {
  name: K;
  toolName: string;
  description: string;
  mutation: EditorMcpMutationCategory;
  revisionRequired: boolean;
  domain: "project" | "interaction" | "behavior" | "timeline" | "audio" | "subtitles" | "camera" | "diagnostics";
  workspace: EditorMcpWorkspaceRequirement;
  handler: EditorMcpHandler;
  resultShape: "EditorMcpResultEnvelope<unknown>";
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: false };
  inputSchema: (value: unknown) => Extract<EditorMcpCommand, { name: K }>;
}

const COMMAND_MUTATION_GROUPS = {
  none: ["get_project", "validate_project", "inspect_recovery", "list_audio_assets", "evaluate_camera_track"],
  authored: [
    "apply_change_set", "undo", "redo", "add_interaction", "update_interaction", "duplicate_interaction", "delete_interaction", "add_region", "update_region", "duplicate_region", "delete_region", "update_look_follow", "replace_behavior_machines",
    "create_talk_sequence", "delete_sequence", "reorder_sequences", "replace_sequence", "update_camera_track", "update_project_settings", "add_audio_clip", "duplicate_audio_clip", "update_audio_clip", "delete_audio_clip", "link_audio_subtitle", "match_audio_length",
    "create_spine_layer", "delete_spine_layer", "duplicate_animation_clip", "duplicate_color_clip", "delete_color_clip", "delete_color_layer", "duplicate_subtitle_cue", "split_subtitle_cue", "set_timeline_items_enabled", "delete_timeline_items",
    "update_spine_layer", "add_animation_clip", "update_animation_clip", "move_animation_clip", "delete_animation_clip", "add_subtitle_cue", "update_subtitle_cue", "delete_subtitle_cue", "apply_subtitle_import", "reorder_visual_layer", "add_color_layer", "add_color_clip", "update_color_layer", "update_color_clip",
  ],
  temporary: [
    "select_interaction", "select_region", "preview_interaction_phase", "start_interaction_test", "move_interaction_test", "release_interaction_test", "cancel_interaction_test", "test_look_follow", "inject_behavior_event", "cancel_behavior_test",
    "frame_camera_item", "preview_audio_clip", "stop_audio_preview", "set_workspace", "select_sequence", "seek", "set_playback", "set_preview_view", "zoom_preview", "pan_preview", "reset_preview", "select_visual", "select_subtitle_cue", "preview_subtitle_import", "capture_preview", "start_waveform_profile", "stop_waveform_profile",
  ],
  lifecycle: ["restore_recovery", "open_project_file", "open_asset_root", "select_asset_set"],
  filesystem: ["save"],
  review: ["preview_change_set"],
} as const satisfies Record<EditorMcpMutationCategory, readonly EditorMcpCommandName[]>;

const MCP_TOOL_NAME_BY_COMMAND = {
  get_project: "editor_get_project", validate_project: "editor_validate", preview_change_set: "editor_preview_change_set", apply_change_set: "editor_apply_change_set",
  inspect_recovery: "editor_inspect_recovery", restore_recovery: "editor_restore_recovery", open_project_file: "editor_open_project_file", undo: "editor_undo", redo: "editor_redo",
  add_interaction: "editor_add_interaction", update_interaction: "editor_update_interaction", duplicate_interaction: "editor_duplicate_interaction", delete_interaction: "editor_delete_interaction", select_interaction: "editor_select_interaction",
  add_region: "editor_add_region", update_region: "editor_update_region", duplicate_region: "editor_duplicate_region", delete_region: "editor_delete_region", select_region: "editor_select_region", update_look_follow: "editor_update_look_follow",
  replace_behavior_machines: "editor_replace_behavior_machines", create_talk_sequence: "editor_create_talk_sequence", delete_sequence: "editor_delete_sequence", reorder_sequences: "editor_reorder_sequences", replace_sequence: "editor_replace_sequence",
  update_camera_track: "editor_update_camera_track", evaluate_camera_track: "editor_evaluate_camera_track", frame_camera_item: "editor_frame_camera_item", update_project_settings: "editor_update_project_settings",
  add_audio_clip: "editor_add_audio_clip", duplicate_audio_clip: "editor_duplicate_audio_clip", update_audio_clip: "editor_update_audio_clip", delete_audio_clip: "editor_delete_audio_clip", link_audio_subtitle: "editor_link_audio_subtitle", list_audio_assets: "editor_list_audio_assets", match_audio_length: "editor_match_audio_length", preview_audio_clip: "editor_preview_audio_clip", stop_audio_preview: "editor_stop_audio_preview",
  create_spine_layer: "editor_create_spine_layer", delete_spine_layer: "editor_delete_spine_layer", duplicate_animation_clip: "editor_duplicate_animation_clip", duplicate_color_clip: "editor_duplicate_color_clip", delete_color_clip: "editor_delete_color_clip", delete_color_layer: "editor_delete_color_layer", duplicate_subtitle_cue: "editor_duplicate_subtitle_cue", select_subtitle_cue: "editor_select_subtitle_cue", split_subtitle_cue: "editor_split_subtitle_cue", set_timeline_items_enabled: "editor_set_timeline_items_enabled", delete_timeline_items: "editor_delete_timeline_items",
  preview_interaction_phase: "editor_preview_interaction_phase", start_interaction_test: "editor_start_interaction_test", move_interaction_test: "editor_move_interaction_test", release_interaction_test: "editor_release_interaction_test", cancel_interaction_test: "editor_cancel_interaction_test", test_look_follow: "editor_test_look_follow", inject_behavior_event: "editor_inject_behavior_event", cancel_behavior_test: "editor_cancel_behavior_test",
  open_asset_root: "editor_open_asset_root", select_asset_set: "editor_select_asset_set", set_workspace: "editor_set_workspace", select_sequence: "editor_select_sequence", seek: "editor_seek", set_playback: "editor_set_playback", set_preview_view: "editor_set_preview_view", zoom_preview: "editor_zoom_preview", pan_preview: "editor_pan_preview", reset_preview: "editor_reset_preview", select_visual: "editor_select_visual_layer", update_spine_layer: "editor_update_spine_layer", add_animation_clip: "editor_add_animation_clip", update_animation_clip: "editor_update_animation_clip", move_animation_clip: "editor_move_animation_clip", delete_animation_clip: "editor_delete_animation_clip", add_subtitle_cue: "editor_add_subtitle_cue", update_subtitle_cue: "editor_update_subtitle_cue", delete_subtitle_cue: "editor_delete_subtitle_cue", preview_subtitle_import: "editor_preview_subtitle_import", apply_subtitle_import: "editor_apply_subtitle_import", reorder_visual_layer: "editor_reorder_visual_layer", add_color_layer: "editor_add_color_layer", add_color_clip: "editor_add_color_clip", update_color_layer: "editor_update_color_layer", update_color_clip: "editor_update_color_clip", save: "editor_save", capture_preview: "editor_capture_preview", start_waveform_profile: "editor_start_waveform_profile", stop_waveform_profile: "editor_stop_waveform_profile",
} satisfies Record<EditorMcpCommandName, string>;

const WORKSPACE_REQUIREMENTS: Partial<Record<EditorMcpCommandName, EditorMcpWorkspaceRequirement>> = {
  evaluate_camera_track: "camera-workspace", frame_camera_item: "camera-workspace",
  match_audio_length: "timeline-mounted", preview_audio_clip: "timeline-mounted", stop_audio_preview: "timeline-mounted",
  preview_subtitle_import: "timeline-mounted", apply_subtitle_import: "timeline-mounted", seek: "timeline-mounted", set_playback: "timeline-mounted",
  set_preview_view: "timeline-mounted", zoom_preview: "timeline-mounted", pan_preview: "timeline-mounted", reset_preview: "timeline-mounted", capture_preview: "timeline-mounted",
  preview_interaction_phase: "interaction-renderer", start_interaction_test: "interaction-renderer", move_interaction_test: "interaction-renderer", release_interaction_test: "interaction-renderer", cancel_interaction_test: "interaction-renderer", test_look_follow: "interaction-renderer", inject_behavior_event: "interaction-renderer", cancel_behavior_test: "interaction-renderer",
  start_waveform_profile: "waveform-profiling-build", stop_waveform_profile: "waveform-profiling-build",
};

function commandDomain(name: EditorMcpCommandName): EditorMcpOperationDefinition["domain"] {
  if (/interaction|region|look_follow/.test(name)) return "interaction";
  if (/behavior/.test(name)) return "behavior";
  if (/camera/.test(name)) return "camera";
  if (/audio/.test(name)) return "audio";
  if (/subtitle|cue/.test(name)) return "subtitles";
  if (/timeline|sequence|animation|spine_layer|visual|color|playback|seek|preview_view|preview$/.test(name)) return "timeline";
  if (/validate|analyze|waveform|profile/.test(name)) return "diagnostics";
  return "project";
}

function commandHandler(name: EditorMcpCommandName): EditorMcpHandler {
  if (["evaluate_camera_track", "frame_camera_item", "match_audio_length", "preview_audio_clip", "stop_audio_preview", "preview_subtitle_import", "apply_subtitle_import", "seek", "set_playback", "set_preview_view", "zoom_preview", "pan_preview", "reset_preview", "capture_preview"].includes(name)) return "timeline-renderer";
  if (["select_visual", "update_spine_layer", "create_spine_layer", "delete_spine_layer", "duplicate_animation_clip", "duplicate_color_clip", "delete_color_clip", "delete_color_layer", "duplicate_subtitle_cue", "select_subtitle_cue", "split_subtitle_cue", "set_timeline_items_enabled", "delete_timeline_items", "add_animation_clip", "update_animation_clip", "move_animation_clip", "delete_animation_clip", "add_subtitle_cue", "update_subtitle_cue", "delete_subtitle_cue", "reorder_visual_layer", "add_color_layer", "add_color_clip", "update_color_layer", "update_color_clip"].includes(name)) return "editor-or-timeline";
  return "editor";
}

const commandNamesByMutation = new Map<EditorMcpCommandName, EditorMcpMutationCategory>();
for (const [mutation, names] of Object.entries(COMMAND_MUTATION_GROUPS) as Array<[EditorMcpMutationCategory, readonly EditorMcpCommandName[]]>) {
  for (const name of names) {
    if (commandNamesByMutation.has(name)) throw new Error(`MCP command ${name} appears in more than one mutation category.`);
    commandNamesByMutation.set(name, mutation);
  }
}

type UnclassifiedEditorMcpCommand = Exclude<EditorMcpCommandName, (typeof COMMAND_MUTATION_GROUPS)[keyof typeof COMMAND_MUTATION_GROUPS][number]>;
export type EditorMcpRegistryClassificationIsExhaustive = UnclassifiedEditorMcpCommand extends never ? true : never;
const registryClassificationIsExhaustive: EditorMcpRegistryClassificationIsExhaustive = true;
void registryClassificationIsExhaustive;

function validateRegisteredCommand<K extends EditorMcpCommandName>(name: K, value: unknown): Extract<EditorMcpCommand, { name: K }> {
  const command = normalizeEditorMcpCommand(value);
  if (command.name !== name) throw new Error(`Expected ${name}, received ${command.name}.`);
  return command as Extract<EditorMcpCommand, { name: K }>;
}

export const EDITOR_MCP_OPERATION_REGISTRY = Object.fromEntries(
  (Object.keys(MCP_TOOL_NAME_BY_COMMAND) as EditorMcpCommandName[]).map((name) => {
    const mutation = commandNamesByMutation.get(name);
    if (!mutation) throw new Error(`MCP command ${name} has no mutation policy.`);
    const humanName = name.replaceAll("_", " ");
    return [name, {
      name,
      toolName: MCP_TOOL_NAME_BY_COMMAND[name],
      description: `Typed ${humanName} operation. Payloads are validated by the native Editor command parser.`,
      mutation,
      revisionRequired: ["authored", "lifecycle", "filesystem", "review"].includes(mutation) || name === "select_sequence",
      domain: commandDomain(name),
      workspace: WORKSPACE_REQUIREMENTS[name] ?? "any",
      handler: commandHandler(name),
      resultShape: "EditorMcpResultEnvelope<unknown>",
      annotations: {
        readOnlyHint: mutation === "none",
        idempotentHint: mutation === "none",
        destructiveHint: /^(delete_|restore_recovery|open_project_file|open_asset_root|select_asset_set)/.test(name),
        openWorldHint: false,
      },
      inputSchema: (value: unknown) => validateRegisteredCommand(name, value),
    }];
  }),
) as { [K in EditorMcpCommandName]: EditorMcpOperationDefinition<K> };

/** Commands that require a caller-reviewed revision; derived from the shared operation registry. */
export const EDITOR_MCP_REVISION_REQUIRED_COMMANDS: ReadonlySet<EditorMcpCommandName> = new Set(
  Object.values(EDITOR_MCP_OPERATION_REGISTRY).filter((operation) => operation.revisionRequired).map((operation) => operation.name),
);

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

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
  };
  return JSON.stringify(sort(value));
}

/** Prevent full-snapshot MCP edits from bypassing protections enforced by the UI controls. */
export function assertMcpTimelineLocksPreserved(before: EditorTimeline, after: EditorTimeline): void {
  const character = before.layers.find((layer) => layer.role === "character");
  if (character && !after.layers.some((layer) => layer.id === character.id && layer.role === "character")) {
    throw new Error("A full sequence replacement cannot remove or replace the main character layer.");
  }

  const assertLayerPreserved = <T extends Record<string, unknown>>(
    previous: T,
    next: T | undefined,
    ignoredFields: readonly string[],
    label: string,
  ) => {
    if (!next) throw new Error(`The locked ${label} cannot be removed by a full sequence replacement.`);
    const comparable = (item: T) => Object.fromEntries(Object.entries(item).filter(([key]) => !ignoredFields.includes(key)));
    if (stableJson(comparable(previous)) !== stableJson(comparable(next))) throw new Error(`The locked ${label} cannot be modified by a full sequence replacement.`);
  };

  for (const layer of before.layers) {
    if (layer.locked) assertLayerPreserved(layer as unknown as Record<string, unknown>, after.layers.find((item) => item.id === layer.id) as unknown as Record<string, unknown> | undefined, ["enabled", "locked"], `Spine layer ${layer.id}`);
  }
  for (const layer of before.colorLayers) {
    if (layer.locked) assertLayerPreserved(layer as unknown as Record<string, unknown>, after.colorLayers.find((item) => item.id === layer.id) as unknown as Record<string, unknown> | undefined, ["enabled", "locked"], `color layer ${layer.id}`);
  }
  for (const bound of before.camera?.safeBounds ?? []) {
    if (bound.locked) assertLayerPreserved(bound as unknown as Record<string, unknown>, after.camera?.safeBounds.find((item) => item.id === bound.id) as unknown as Record<string, unknown> | undefined, ["locked"], `camera bound ${bound.id}`);
  }
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

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function optionalNullableText(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null.`);
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

function behaviorString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
}

function behaviorBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
}

function behaviorNumber(value: unknown, field: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} must be a finite number between ${min} and ${max}.`);
}

function behaviorStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings.`);
}

function behaviorScalar(value: unknown, field: string): void {
  if (!(typeof value === "string" || typeof value === "boolean" || value === null || typeof value === "number" && Number.isFinite(value))) throw new Error(`${field} must be a finite string, number, boolean, or null.`);
}

function validateBehaviorMachineCollection(value: unknown): SpineBehaviorMachine[] {
  if (!Array.isArray(value)) throw new Error("machines must be an array.");
  const unique = new Set<string>();
  const normalized = normalizeSpineBehaviorMachines(value);
  const stateIdsByMachine = new Map<string, Set<string>>();
  if (normalized.length !== value.length) throw new Error("Every behavior machine must be a valid supported machine.");
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !onlyKeys(raw, ["id", "name", "enabled", "priority", "exclusiveGroup", "resourceClaims", "activation", "initialStateId", "cancelPolicy", "states", "transitions", "sourceLegacyInteractionId"])) throw new Error(`machines[${index}] contains unsupported fields or is not an object.`);
    if (typeof raw.id !== "string" || !raw.id.trim() || unique.has(raw.id)) throw new Error(`machines[${index}].id must be unique and non-empty.`);
    unique.add(raw.id);
    behaviorString(raw.name, `machines[${index}].name`);
    behaviorBoolean(raw.enabled, `machines[${index}].enabled`);
    behaviorNumber(raw.priority, `machines[${index}].priority`, -1000, 1000);
    if (raw.exclusiveGroup !== null) behaviorString(raw.exclusiveGroup, `machines[${index}].exclusiveGroup`);
    behaviorStringArray(raw.resourceClaims, `machines[${index}].resourceClaims`);
    if (raw.cancelPolicy !== "reset" && raw.cancelPolicy !== "run-exit") throw new Error(`machines[${index}].cancelPolicy is unsupported.`);
    if (raw.sourceLegacyInteractionId !== null) behaviorString(raw.sourceLegacyInteractionId, `machines[${index}].sourceLegacyInteractionId`);
    if (!Array.isArray(raw.states) || raw.states.length === 0 || !Array.isArray(raw.transitions) || !isRecord(raw.activation)) throw new Error(`machines[${index}] requires activation, at least one state, and a transitions array.`);
    if (!onlyKeys(raw.activation, ["kind", "trigger", "regions", "holdDelay", "dragThreshold", "timerSeconds", "event"])) throw new Error(`machines[${index}].activation contains unsupported fields.`);
    if (!["pointer-region", "pointer-canvas", "timer", "event"].includes(String(raw.activation.kind)) || !["press", "hold", "drag"].includes(String(raw.activation.trigger))) throw new Error(`machines[${index}].activation kind or trigger is unsupported.`);
    if (!["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"].includes(String(raw.activation.event))) throw new Error(`machines[${index}].activation event is unsupported.`);
    behaviorNumber(raw.activation.holdDelay, `machines[${index}].activation.holdDelay`, 0, 3600);
    behaviorNumber(raw.activation.dragThreshold, `machines[${index}].activation.dragThreshold`, 0, 1_000_000);
    behaviorNumber(raw.activation.timerSeconds, `machines[${index}].activation.timerSeconds`, 0, 3600);
    if (!Array.isArray(raw.activation.regions)) throw new Error(`machines[${index}].activation.regions must be an array.`);
    const regionIds = new Set<string>();
    for (const [regionIndex, rawRegion] of raw.activation.regions.entries()) {
      if (!isRecord(rawRegion) || !onlyKeys(rawRegion, ["id", "name", "enabled", "shape", "anchorBone", "offsetX", "offsetY", "radiusX", "radiusY", "rotation"])) throw new Error(`machines[${index}].activation.regions[${regionIndex}] contains unsupported fields.`);
      behaviorString(rawRegion.id, `machines[${index}].activation.regions[${regionIndex}].id`);
      if (regionIds.has(rawRegion.id)) throw new Error(`machines[${index}].activation.regions contains duplicate ID ${rawRegion.id}.`);
      regionIds.add(rawRegion.id);
      behaviorString(rawRegion.name, `machines[${index}].activation.regions[${regionIndex}].name`);
      behaviorBoolean(rawRegion.enabled, `machines[${index}].activation.regions[${regionIndex}].enabled`);
      if (rawRegion.shape !== "ellipse" && rawRegion.shape !== "rectangle") throw new Error(`machines[${index}].activation.regions[${regionIndex}].shape is unsupported.`);
      if (rawRegion.anchorBone !== null) behaviorString(rawRegion.anchorBone, `machines[${index}].activation.regions[${regionIndex}].anchorBone`);
      behaviorNumber(rawRegion.offsetX, `machines[${index}].activation.regions[${regionIndex}].offsetX`, -1_000_000, 1_000_000);
      behaviorNumber(rawRegion.offsetY, `machines[${index}].activation.regions[${regionIndex}].offsetY`, -1_000_000, 1_000_000);
      behaviorNumber(rawRegion.radiusX, `machines[${index}].activation.regions[${regionIndex}].radiusX`, 0, 1_000_000);
      behaviorNumber(rawRegion.radiusY, `machines[${index}].activation.regions[${regionIndex}].radiusY`, 0, 1_000_000);
      behaviorNumber(rawRegion.rotation, `machines[${index}].activation.regions[${regionIndex}].rotation`, -360_000, 360_000);
    }
    const machine = normalized[index]!;
    if (machine.states.length !== raw.states.length || machine.transitions.length !== raw.transitions.length) throw new Error(`machines[${index}] contains an invalid state, transition, or reference.`);
    if (machine.activation.regions.length !== raw.activation.regions.length) throw new Error(`machines[${index}].activation contains an invalid region.`);
    behaviorString(raw.initialStateId, `machines[${index}].initialStateId`);
    if (!machine.states.some((state) => state.id === raw.initialStateId)) throw new Error(`machines[${index}].initialStateId must reference one of its states.`);
    const stateIds = new Set<string>();
    stateIdsByMachine.set(raw.id, stateIds);
    for (const [stateIndex, rawState] of raw.states.entries()) {
      if (!isRecord(rawState) || !onlyKeys(rawState, ["id", "name", "actions", "exitActions", "cancelActions", "resourceClaims"])) throw new Error(`machines[${index}].states[${stateIndex}] contains unsupported fields.`);
      behaviorString(rawState.id, `machines[${index}].states[${stateIndex}].id`);
      if (stateIds.has(rawState.id)) throw new Error(`machines[${index}].states contains duplicate ID ${rawState.id}.`);
      stateIds.add(rawState.id);
      behaviorString(rawState.name, `machines[${index}].states[${stateIndex}].name`);
      behaviorStringArray(rawState.resourceClaims, `machines[${index}].states[${stateIndex}].resourceClaims`);
      for (const phase of ["actions", "exitActions", "cancelActions"] as const) {
        if (!Array.isArray(rawState[phase])) throw new Error(`machines[${index}].states[${stateIndex}].${phase} must be an array.`);
        const normalizedActions = machine.states[stateIndex]![phase];
        if (normalizedActions.length !== rawState[phase].length) throw new Error(`machines[${index}].states[${stateIndex}].${phase} contains an unsupported action.`);
        for (const [actionIndex, rawAction] of rawState[phase].entries()) {
          if (!isRecord(rawAction) || typeof rawAction.type !== "string") throw new Error(`machines[${index}].states[${stateIndex}].${phase}[${actionIndex}] must be a typed action.`);
          const actionFields: Record<string, string[]> = {
            "play-animation": ["type", "mainAnimation", "faceAnimation", "bodyTrack", "faceTrack", "loop", "mixDuration", "fallbackProfile"],
            "pointer-follow": ["type", "targetBonePath", "allowX", "allowY", "rangeX", "rangeY", "smoothing"],
            "drag-bone": ["type", "targetBonePath", "sensitivity", "limitX", "limitY", "allowX", "allowY", "smoothing", "returnDuration"],
            "rotate-bone": ["type", "targetBonePath", "axis", "minimum", "maximum", "returnDuration"],
            "play-audio": ["type", "audioId", "volume", "loop"], "show-subtitle": ["type", "cueId"],
            "set-variable": ["type", "name", "value"], wait: ["type", "seconds"], "restore-resource": ["type", "resource"],
          };
          const allowed = actionFields[rawAction.type];
          if (!allowed || !onlyKeys(rawAction, allowed)) throw new Error(`machines[${index}].states[${stateIndex}].${phase}[${actionIndex}] is unsupported or contains unknown fields.`);
          const fieldPath = `machines[${index}].states[${stateIndex}].${phase}[${actionIndex}]`;
          const stringOrNull = (field: string) => { if (rawAction[field] !== null) behaviorString(rawAction[field], `${fieldPath}.${field}`, true); };
          const nullableString = (field: string) => { if (rawAction[field] !== null) behaviorString(rawAction[field], `${fieldPath}.${field}`); };
          switch (rawAction.type) {
            case "play-animation":
              stringOrNull("mainAnimation"); stringOrNull("faceAnimation");
              behaviorNumber(rawAction.bodyTrack, `${fieldPath}.bodyTrack`, 1, 32); behaviorNumber(rawAction.faceTrack, `${fieldPath}.faceTrack`, 1, 32);
              behaviorBoolean(rawAction.loop, `${fieldPath}.loop`); behaviorNumber(rawAction.mixDuration, `${fieldPath}.mixDuration`, 0, 2);
              if (rawAction.fallbackProfile !== undefined && rawAction.fallbackProfile !== "look-start" && rawAction.fallbackProfile !== "look-end") throw new Error(`${fieldPath}.fallbackProfile is unsupported.`);
              break;
            case "pointer-follow":
              nullableString("targetBonePath"); behaviorBoolean(rawAction.allowX, `${fieldPath}.allowX`); behaviorBoolean(rawAction.allowY, `${fieldPath}.allowY`);
              for (const field of ["rangeX", "rangeY"]) if (rawAction[field] !== null) behaviorNumber(rawAction[field], `${fieldPath}.${field}`, 0, 512);
              behaviorNumber(rawAction.smoothing, `${fieldPath}.smoothing`, 0.1, 60); break;
            case "drag-bone":
              nullableString("targetBonePath"); behaviorNumber(rawAction.sensitivity, `${fieldPath}.sensitivity`, 0, 10);
              behaviorNumber(rawAction.limitX, `${fieldPath}.limitX`, 0); behaviorNumber(rawAction.limitY, `${fieldPath}.limitY`, 0);
              behaviorBoolean(rawAction.allowX, `${fieldPath}.allowX`); behaviorBoolean(rawAction.allowY, `${fieldPath}.allowY`);
              behaviorNumber(rawAction.smoothing, `${fieldPath}.smoothing`, 0.1, 60); behaviorNumber(rawAction.returnDuration, `${fieldPath}.returnDuration`, 0.05, 10); break;
            case "rotate-bone":
              nullableString("targetBonePath"); if (rawAction.axis !== "x" && rawAction.axis !== "y") throw new Error(`${fieldPath}.axis is unsupported.`);
              behaviorNumber(rawAction.minimum, `${fieldPath}.minimum`, -360, 0); behaviorNumber(rawAction.maximum, `${fieldPath}.maximum`, 0, 360);
              behaviorNumber(rawAction.returnDuration, `${fieldPath}.returnDuration`, 0.05, 10); break;
            case "play-audio":
              behaviorString(rawAction.audioId, `${fieldPath}.audioId`); behaviorNumber(rawAction.volume, `${fieldPath}.volume`, 0, 1); behaviorBoolean(rawAction.loop, `${fieldPath}.loop`); break;
            case "show-subtitle": behaviorString(rawAction.cueId, `${fieldPath}.cueId`); break;
            case "set-variable": behaviorString(rawAction.name, `${fieldPath}.name`); behaviorScalar(rawAction.value, `${fieldPath}.value`); break;
            case "wait": behaviorNumber(rawAction.seconds, `${fieldPath}.seconds`, 0, 3600); break;
            case "restore-resource": behaviorString(rawAction.resource, `${fieldPath}.resource`); break;
          }
        }
      }
    }
    const transitionIds = new Set<string>();
    for (const [transitionIndex, rawTransition] of raw.transitions.entries()) {
      if (!isRecord(rawTransition) || !onlyKeys(rawTransition, ["id", "fromStateId", "toStateId", "event", "conditions", "afterSeconds", "priority", "blendDuration", "interruptPolicy"])) throw new Error(`machines[${index}].transitions[${transitionIndex}] contains unsupported fields.`);
      behaviorString(rawTransition.id, `machines[${index}].transitions[${transitionIndex}].id`);
      if (transitionIds.has(rawTransition.id)) throw new Error(`machines[${index}].transitions contains duplicate ID ${rawTransition.id}.`);
      transitionIds.add(rawTransition.id);
      behaviorString(rawTransition.fromStateId, `machines[${index}].transitions[${transitionIndex}].fromStateId`);
      behaviorString(rawTransition.toStateId, `machines[${index}].transitions[${transitionIndex}].toStateId`);
      if (!stateIds.has(rawTransition.fromStateId) || !stateIds.has(rawTransition.toStateId)) throw new Error(`machines[${index}].transitions[${transitionIndex}] references an unknown local state.`);
      if (!["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"].includes(String(rawTransition.event))) throw new Error(`machines[${index}].transitions[${transitionIndex}].event is unsupported.`);
      behaviorNumber(rawTransition.afterSeconds, `machines[${index}].transitions[${transitionIndex}].afterSeconds`, 0, 3600);
      behaviorNumber(rawTransition.priority, `machines[${index}].transitions[${transitionIndex}].priority`, -1000, 1000);
      behaviorNumber(rawTransition.blendDuration, `machines[${index}].transitions[${transitionIndex}].blendDuration`, 0, 2);
      if (!["allow", "deny", "queue"].includes(String(rawTransition.interruptPolicy))) throw new Error(`machines[${index}].transitions[${transitionIndex}].interruptPolicy is unsupported.`);
      if (!Array.isArray(rawTransition.conditions) || machine.transitions[transitionIndex]!.conditions.length !== rawTransition.conditions.length) throw new Error(`machines[${index}].transitions[${transitionIndex}] contains an unsupported condition.`);
      for (const [conditionIndex, rawCondition] of rawTransition.conditions.entries()) {
        if (!isRecord(rawCondition) || typeof rawCondition.type !== "string") throw new Error(`machines[${index}].transitions[${transitionIndex}].conditions[${conditionIndex}] must be typed.`);
        const conditionFields: Record<string, string[]> = {
          "pointer-held": ["type", "value"], "region-hit": ["type", "regionIds"], "held-for": ["type", "seconds"],
          "drag-distance": ["type", "minimum"], variable: ["type", "name", "operator", "value"], "machine-state": ["type", "machineId", "stateId"],
        };
        const allowed = conditionFields[rawCondition.type];
        if (!allowed || !onlyKeys(rawCondition, allowed)) throw new Error(`machines[${index}].transitions[${transitionIndex}].conditions[${conditionIndex}] is unsupported or contains unknown fields.`);
        const fieldPath = `machines[${index}].transitions[${transitionIndex}].conditions[${conditionIndex}]`;
        switch (rawCondition.type) {
          case "pointer-held": behaviorBoolean(rawCondition.value, `${fieldPath}.value`); break;
          case "region-hit": behaviorStringArray(rawCondition.regionIds, `${fieldPath}.regionIds`); break;
          case "held-for": behaviorNumber(rawCondition.seconds, `${fieldPath}.seconds`, 0, 3600); break;
          case "drag-distance": behaviorNumber(rawCondition.minimum, `${fieldPath}.minimum`, 0); break;
          case "variable":
            behaviorString(rawCondition.name, `${fieldPath}.name`);
            if (!["equals", "not-equals", "greater-than", "less-than"].includes(String(rawCondition.operator))) throw new Error(`${fieldPath}.operator is unsupported.`);
            behaviorScalar(rawCondition.value, `${fieldPath}.value`); break;
          case "machine-state": behaviorString(rawCondition.machineId, `${fieldPath}.machineId`); behaviorString(rawCondition.stateId, `${fieldPath}.stateId`); break;
        }
      }
    }
  }
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !Array.isArray(raw.transitions)) continue;
    for (const [transitionIndex, transition] of raw.transitions.entries()) {
      if (!isRecord(transition) || !Array.isArray(transition.conditions)) continue;
      for (const [conditionIndex, condition] of transition.conditions.entries()) {
        if (!isRecord(condition) || condition.type !== "machine-state") continue;
        const targetStates = typeof condition.machineId === "string" ? stateIdsByMachine.get(condition.machineId) : undefined;
        if (!targetStates?.has(String(condition.stateId))) throw new Error(`machines[${index}].transitions[${transitionIndex}].conditions[${conditionIndex}] references an unknown machine or state.`);
      }
    }
  }
  return normalized;
}

function validateBehaviorGraphLayoutCollection(value: unknown, machines: readonly SpineBehaviorMachine[]): BehaviorGraphLayouts {
  if (!isRecord(value)) throw new Error("graphLayouts must be an object keyed by behavior machine ID.");
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  for (const [machineId, rawLayout] of Object.entries(value)) {
    const machine = machineById.get(machineId);
    if (!machine) throw new Error(`graphLayouts references unknown behavior machine ${machineId}.`);
    if (!isRecord(rawLayout) || !onlyKeys(rawLayout, ["mode", "statePositions"])) throw new Error(`graphLayouts.${machineId} must contain only mode and statePositions.`);
    if (rawLayout.mode !== "auto" && rawLayout.mode !== "manual") throw new Error(`graphLayouts.${machineId}.mode must be auto or manual.`);
    if (!isRecord(rawLayout.statePositions)) throw new Error(`graphLayouts.${machineId}.statePositions must be an object.`);
    const stateIds = new Set(machine.states.map((state) => state.id));
    for (const [stateId, rawPoint] of Object.entries(rawLayout.statePositions)) {
      if (!stateIds.has(stateId)) throw new Error(`graphLayouts.${machineId} references unknown state ${stateId}.`);
      if (!isRecord(rawPoint) || !onlyKeys(rawPoint, ["x", "y"])) throw new Error(`graphLayouts.${machineId}.statePositions.${stateId} must contain only x and y.`);
      for (const coordinate of ["x", "y"] as const) {
        const number = rawPoint[coordinate];
        if (typeof number !== "number" || !Number.isFinite(number) || number < -100_000 || number > 100_000) throw new Error(`graphLayouts.${machineId}.statePositions.${stateId}.${coordinate} must be finite and within ±100000.`);
      }
    }
  }
  return normalizeBehaviorGraphLayouts(value, machines);
}

function validateSubtitleText(value: unknown, field: string): Partial<Record<"en" | "ja" | "ko", string>> {
  if (!isRecord(value) || !onlyKeys(value, ["en", "ja", "ko"])) throw new Error(`${field} must contain only en, ja, and ko strings.`);
  for (const language of ["en", "ja", "ko"] as const) {
    if (value[language] !== undefined && typeof value[language] !== "string") throw new Error(`${field}.${language} must be a string.`);
  }
  return value as Partial<Record<"en" | "ja" | "ko", string>>;
}

function safeRelativePath(value: unknown, field: string): string {
  const path = stringField(value, field).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some((part) => part === "..")) {
    throw new Error(`${field} must be a relative path contained in the current asset root.`);
  }
  return path;
}

function validateEditorCameraTrack(value: unknown, layerIds?: ReadonlySet<string>): SpineCameraTrack {
  if (!isRecord(value) || !onlyKeys(value, ["enabled", "aspectRatio", "constraint", "referenceLayerId", "safeBounds", "keyframes"])) throw new Error("camera must be a complete supported camera track.");
  if (typeof value.enabled !== "boolean" || value.aspectRatio !== "16:9" && value.aspectRatio !== "4:3") throw new Error("camera enabled or aspectRatio is invalid.");
  if (!Array.isArray(value.safeBounds) || !Array.isArray(value.keyframes)) throw new Error("camera safeBounds and keyframes must be arrays.");
  if (value.referenceLayerId !== undefined && (typeof value.referenceLayerId !== "string" || !value.referenceLayerId.trim())) throw new Error("camera.referenceLayerId must be a non-empty Spine layer ID.");
  if (typeof value.referenceLayerId === "string" && layerIds && !layerIds.has(value.referenceLayerId)) throw new Error(`camera.referenceLayerId references missing Spine layer ${value.referenceLayerId}.`);

  const boundIds = new Set<string>();
  for (const [index, rawBound] of value.safeBounds.entries()) {
    const field = `camera.safeBounds[${index}]`;
    if (!isRecord(rawBound) || !onlyKeys(rawBound, ["id", "name", "x", "y", "width", "height", "enabled", "visible", "locked", "priority"])) throw new Error(`${field} is invalid or contains unsupported fields.`);
    const id = stringField(rawBound.id, `${field}.id`);
    if (boundIds.has(id)) throw new Error(`${field}.id duplicates safe bound ${id}.`);
    boundIds.add(id);
    if (typeof rawBound.name !== "string" || !rawBound.name.trim()) throw new Error(`${field}.name must be a non-empty string.`);
    for (const name of ["x", "y"] as const) if (typeof rawBound[name] !== "number" || !Number.isFinite(rawBound[name])) throw new Error(`${field}.${name} must be finite.`);
    for (const name of ["width", "height"] as const) if (typeof rawBound[name] !== "number" || !Number.isFinite(rawBound[name]) || rawBound[name] <= 0) throw new Error(`${field}.${name} must be finite and positive.`);
    if (typeof rawBound.enabled !== "boolean") throw new Error(`${field}.enabled must be a boolean.`);
    for (const name of ["visible", "locked"] as const) if (rawBound[name] !== undefined && typeof rawBound[name] !== "boolean") throw new Error(`${field}.${name} must be a boolean.`);
    if (rawBound.priority !== undefined && (typeof rawBound.priority !== "number" || !Number.isFinite(rawBound.priority))) throw new Error(`${field}.priority must be finite.`);
  }

  const validateConstraint = (constraint: unknown, field: string) => {
    if (!isRecord(constraint) || typeof constraint.mode !== "string") throw new Error(`${field} must be a camera constraint.`);
    if (constraint.mode === "manual") {
      if (!onlyKeys(constraint, ["mode", "boundId"])) throw new Error(`${field} contains unsupported fields.`);
      const boundId = stringField(constraint.boundId, `${field}.boundId`);
      if (!boundIds.has(boundId)) throw new Error(`${field} references missing safe bound ${boundId}.`);
    } else if ((constraint.mode === "automatic" || constraint.mode === "none") && !onlyKeys(constraint, ["mode"])) {
      throw new Error(`${field} contains unsupported fields.`);
    } else if (constraint.mode !== "automatic" && constraint.mode !== "none") {
      throw new Error(`${field}.mode is unsupported.`);
    }
  };
  validateConstraint(value.constraint, "camera.constraint");

  const keyframeIds = new Set<string>();
  for (const [index, rawKeyframe] of value.keyframes.entries()) {
    const field = `camera.keyframes[${index}]`;
    if (!isRecord(rawKeyframe) || !onlyKeys(rawKeyframe, ["id", "time", "centerX", "centerY", "frameHeight", "easing", "constraint"])) throw new Error(`${field} is invalid or contains unsupported fields.`);
    const id = stringField(rawKeyframe.id, `${field}.id`);
    if (keyframeIds.has(id)) throw new Error(`${field}.id duplicates keyframe ${id}.`);
    keyframeIds.add(id);
    for (const name of ["time", "centerX", "centerY", "frameHeight"] as const) if (typeof rawKeyframe[name] !== "number" || !Number.isFinite(rawKeyframe[name])) throw new Error(`${field}.${name} must be finite.`);
    if ((rawKeyframe.time as number) < 0 || (rawKeyframe.frameHeight as number) <= 0) throw new Error(`${field}.time must be non-negative and frameHeight must be positive.`);
    if (rawKeyframe.easing !== undefined && rawKeyframe.easing !== "linear" && rawKeyframe.easing !== "smooth" && rawKeyframe.easing !== "hold") throw new Error(`${field}.easing is unsupported.`);
    if (rawKeyframe.constraint !== undefined) validateConstraint(rawKeyframe.constraint, `${field}.constraint`);
  }
  return value as unknown as SpineCameraTrack;
}

function validateEditorTimelineSnapshot(sequence: Record<string, unknown>, sequenceId: string): EditorTimeline {
  const allowed = ["sequenceId", "subtitlePath", "openingMode", "sceneDuration", "openingIdleDuration", "durationMode", "layersInitialized", "duration", "loop", "assetPaths", "layers", "colorLayers", "subtitles", "audio", "selectedLayerId", "selectedCueId", "selectedColorLayerId", "selectedColorClipId", "language", "snap", "camera"];
  if (!onlyKeys(sequence, allowed)) throw new Error("sequence contains unsupported fields.");
  if (sequence.sequenceId !== undefined && sequence.sequenceId !== sequenceId) throw new Error("sequence.sequenceId must match sequenceId.");
  for (const field of ["layers", "colorLayers", "subtitles", "audio"] as const) if (!Array.isArray(sequence[field])) throw new Error(`sequence.${field} must be an array.`);
  if (typeof sequence.layersInitialized !== "boolean" || typeof sequence.duration !== "number" || !Number.isFinite(sequence.duration) || sequence.duration <= 0 || typeof sequence.loop !== "boolean") throw new Error("sequence requires valid layersInitialized, duration, and loop fields.");
  if (sequence.openingMode !== undefined && !["scene-first", "direct", "skip"].includes(String(sequence.openingMode))) throw new Error("sequence.openingMode is unsupported.");
  if (sequence.durationMode !== undefined && sequence.durationMode !== "auto" && sequence.durationMode !== "manual") throw new Error("sequence.durationMode is unsupported.");
  for (const field of ["sceneDuration", "openingIdleDuration"] as const) if (sequence[field] !== undefined) optionalNumber(sequence[field], `sequence.${field}`, 0);
  if (optionalNumber(sequence.snap, "sequence.snap", 0) === undefined) throw new Error("sequence.snap is required.");
  if (sequence.subtitlePath !== undefined) safeRelativePath(sequence.subtitlePath, "sequence.subtitlePath");
  if (sequence.language !== "en" && sequence.language !== "ja" && sequence.language !== "ko") throw new Error("sequence.language is unsupported.");
  const selections = ["selectedLayerId", "selectedCueId", "selectedColorLayerId", "selectedColorClipId"] as const;
  for (const field of selections) if (!(field in sequence) || sequence[field] !== null && typeof sequence[field] !== "string") throw new Error(`sequence.${field} must be a string or null.`);
  if (sequence.assetPaths !== undefined) {
    if (!isRecord(sequence.assetPaths)) throw new Error("sequence.assetPaths must be an object.");
    for (const [key, path] of Object.entries(sequence.assetPaths)) {
      stringField(key, "sequence.assetPaths key");
      safeRelativePath(path, `sequence.assetPaths.${key}`);
    }
  }

  const ids = new Set<string>();
  const uniqueId = (value: unknown, field: string) => {
    const id = stringField(value, field);
    if (ids.has(id)) throw new Error(`${field} duplicates an ID already used in this sequence: ${id}.`);
    ids.add(id);
    return id;
  };
  const stringValue = (value: unknown, field: string, allowEmpty = false) => {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  };
  const booleanValue = (value: unknown, field: string) => {
    if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  };
  const numericValue = (value: unknown, field: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} must be a finite number between ${min} and ${max}.`);
    return value;
  };
  const layerIds = new Set<string>();
  const colorLayerIds = new Set<string>();
  const colorClipIds = new Set<string>();
  for (const [layerIndex, rawLayer] of (sequence.layers as unknown[]).entries()) {
    const field = `sequence.layers[${layerIndex}]`;
    if (!isRecord(rawLayer) || !onlyKeys(rawLayer, ["id", "name", "role", "directory", "enabled", "locked", "blendMode", "animation", "faceAnimation", "animationClips", "followMainAnimation", "start", "end", "endMode", "animationOffset", "loop", "x", "y", "scale", "opacity", "order"])) throw new Error(`${field} is invalid or contains unsupported fields.`);
    const layerId = uniqueId(rawLayer.id, `${field}.id`);
    layerIds.add(layerId);
    stringValue(rawLayer.name, `${field}.name`, true); stringValue(rawLayer.directory, `${field}.directory`); stringValue(rawLayer.animation, `${field}.animation`, true);
    if (!["character", "scene", "background", "overlay"].includes(String(rawLayer.role))) throw new Error(`${field}.role is unsupported.`);
    booleanValue(rawLayer.enabled, `${field}.enabled`); booleanValue(rawLayer.loop, `${field}.loop`);
    if (rawLayer.locked !== undefined) booleanValue(rawLayer.locked, `${field}.locked`);
    if (rawLayer.followMainAnimation !== undefined) booleanValue(rawLayer.followMainAnimation, `${field}.followMainAnimation`);
    if (rawLayer.faceAnimation !== undefined) stringValue(rawLayer.faceAnimation, `${field}.faceAnimation`, true);
    if (rawLayer.endMode !== undefined && rawLayer.endMode !== "auto" && rawLayer.endMode !== "manual") throw new Error(`${field}.endMode is unsupported.`);
    if (rawLayer.blendMode !== undefined && !["normal", "multiply", "screen", "additive"].includes(String(rawLayer.blendMode))) throw new Error(`${field}.blendMode is unsupported.`);
    for (const name of ["start", "end"] as const) numericValue(rawLayer[name], `${field}.${name}`, 0);
    if ((rawLayer.end as number) < (rawLayer.start as number) + 0.01) throw new Error(`${field}.end must be at least 0.01 seconds after start.`);
    numericValue(rawLayer.animationOffset, `${field}.animationOffset`, 0); numericValue(rawLayer.x, `${field}.x`); numericValue(rawLayer.y, `${field}.y`);
    numericValue(rawLayer.scale, `${field}.scale`, 0.01); numericValue(rawLayer.opacity, `${field}.opacity`, 0, 1); numericValue(rawLayer.order, `${field}.order`);
    if (rawLayer.animationClips !== undefined) {
      if (!Array.isArray(rawLayer.animationClips)) throw new Error(`${field}.animationClips must be an array.`);
      for (const [clipIndex, rawClip] of rawLayer.animationClips.entries()) {
        const clipField = `${field}.animationClips[${clipIndex}]`;
        if (!isRecord(rawClip) || !onlyKeys(rawClip, ["id", "animation", "faceAnimation", "start", "end", "endMode", "animationOffset", "loop", "enabled", "continueAfterOpening", "hideCharacter"])) throw new Error(`${clipField} is invalid or contains unsupported fields.`);
        uniqueId(rawClip.id, `${clipField}.id`); stringValue(rawClip.animation, `${clipField}.animation`, true);
        if (rawClip.faceAnimation !== undefined) stringValue(rawClip.faceAnimation, `${clipField}.faceAnimation`, true);
        numericValue(rawClip.start, `${clipField}.start`, 0); numericValue(rawClip.end, `${clipField}.end`, 0);
        if ((rawClip.end as number) < (rawClip.start as number) + 0.01) throw new Error(`${clipField}.end must be at least 0.01 seconds after start.`);
        numericValue(rawClip.animationOffset, `${clipField}.animationOffset`, 0); booleanValue(rawClip.loop, `${clipField}.loop`);
        if (rawClip.endMode !== undefined && rawClip.endMode !== "auto" && rawClip.endMode !== "manual") throw new Error(`${clipField}.endMode is unsupported.`);
        for (const option of ["enabled", "continueAfterOpening", "hideCharacter"] as const) if (rawClip[option] !== undefined) booleanValue(rawClip[option], `${clipField}.${option}`);
      }
    }
  }
  for (const [layerIndex, rawLayer] of (sequence.colorLayers as unknown[]).entries()) {
    const field = `sequence.colorLayers[${layerIndex}]`;
    if (!isRecord(rawLayer) || !onlyKeys(rawLayer, ["id", "name", "enabled", "locked", "opacity", "order", "blendMode", "clips"]) || !Array.isArray(rawLayer.clips)) throw new Error(`${field} is invalid or contains unsupported fields.`);
    const colorLayerId = uniqueId(rawLayer.id, `${field}.id`); colorLayerIds.add(colorLayerId); stringValue(rawLayer.name, `${field}.name`, true);
    booleanValue(rawLayer.enabled, `${field}.enabled`); booleanValue(rawLayer.locked, `${field}.locked`);
    numericValue(rawLayer.opacity, `${field}.opacity`, 0, 1); numericValue(rawLayer.order, `${field}.order`);
    if (!["normal", "multiply", "screen", "additive"].includes(String(rawLayer.blendMode))) throw new Error(`${field}.blendMode is unsupported.`);
    for (const [clipIndex, rawClip] of rawLayer.clips.entries()) {
      const clipField = `${field}.clips[${clipIndex}]`;
      if (!isRecord(rawClip) || !onlyKeys(rawClip, ["id", "name", "color", "start", "end", "opacity", "fadeIn", "fadeOut", "enabled"])) throw new Error(`${clipField} is invalid or contains unsupported fields.`);
      const colorClipId = uniqueId(rawClip.id, `${clipField}.id`); colorClipIds.add(colorClipId); stringValue(rawClip.name, `${clipField}.name`, true);
      if (typeof rawClip.color !== "string" || !/^#[\da-f]{6}$/i.test(rawClip.color)) throw new Error(`${clipField}.color must be a six-digit hex color.`);
      numericValue(rawClip.start, `${clipField}.start`, 0); numericValue(rawClip.end, `${clipField}.end`, 0);
      if ((rawClip.end as number) < (rawClip.start as number) + 0.01) throw new Error(`${clipField}.end must be at least 0.01 seconds after start.`);
      numericValue(rawClip.opacity, `${clipField}.opacity`, 0, 1); numericValue(rawClip.fadeIn, `${clipField}.fadeIn`, 0); numericValue(rawClip.fadeOut, `${clipField}.fadeOut`, 0);
      booleanValue(rawClip.enabled, `${clipField}.enabled`);
    }
  }
  const cueIds = new Set<string>();
  for (const [cueIndex, rawCue] of (sequence.subtitles as unknown[]).entries()) {
    const field = `sequence.subtitles[${cueIndex}]`;
    if (!isRecord(rawCue) || !onlyKeys(rawCue, ["lineId", "id", "start", "end", "enabled", "text"]) || !isRecord(rawCue.text) || !onlyKeys(rawCue.text, ["en", "ja", "ko"])) throw new Error(`${field} is invalid or contains unsupported fields.`);
    const id = uniqueId(rawCue.id, `${field}.id`); cueIds.add(id);
    if (rawCue.lineId !== undefined) stringValue(rawCue.lineId, `${field}.lineId`, true);
    numericValue(rawCue.start, `${field}.start`, 0); numericValue(rawCue.end, `${field}.end`, 0);
    if ((rawCue.end as number) < (rawCue.start as number) + 0.01) throw new Error(`${field}.end must be at least 0.01 seconds after start.`);
    booleanValue(rawCue.enabled, `${field}.enabled`);
    for (const language of ["en", "ja", "ko"] as const) stringValue(rawCue.text[language], `${field}.text.${language}`, true);
  }
  for (const [audioIndex, rawAudio] of (sequence.audio as unknown[]).entries()) {
    const field = `sequence.audio[${audioIndex}]`;
    if (!isRecord(rawAudio) || !onlyKeys(rawAudio, ["autoEnd", "lineId", "subtitleId", "id", "name", "path", "start", "end", "enabled", "volume"])) throw new Error(`${field} is invalid or contains unsupported fields.`);
    uniqueId(rawAudio.id, `${field}.id`); stringValue(rawAudio.name, `${field}.name`, true); safeRelativePath(rawAudio.path, `${field}.path`);
    numericValue(rawAudio.start, `${field}.start`, 0); numericValue(rawAudio.end, `${field}.end`, 0);
    if ((rawAudio.end as number) < (rawAudio.start as number) + 0.01) throw new Error(`${field}.end must be at least 0.01 seconds after start.`);
    numericValue(rawAudio.volume, `${field}.volume`, 0, 1); booleanValue(rawAudio.enabled, `${field}.enabled`);
    if (rawAudio.autoEnd !== undefined) booleanValue(rawAudio.autoEnd, `${field}.autoEnd`);
    if (rawAudio.lineId !== undefined) stringValue(rawAudio.lineId, `${field}.lineId`, true);
    if (rawAudio.subtitleId !== undefined && rawAudio.subtitleId !== null) stringValue(rawAudio.subtitleId, `${field}.subtitleId`);
    if (typeof rawAudio.subtitleId === "string" && !cueIds.has(rawAudio.subtitleId)) throw new Error(`${field}.subtitleId references a missing cue.`);
  }
  const selectedLayer = sequence.selectedLayerId;
  if (typeof selectedLayer === "string" && !layerIds.has(selectedLayer)) throw new Error("sequence.selectedLayerId references a missing Spine layer.");
  const selectedCue = sequence.selectedCueId;
  if (typeof selectedCue === "string" && !cueIds.has(selectedCue)) throw new Error("sequence.selectedCueId references a missing subtitle cue.");
  const selectedColorLayer = sequence.selectedColorLayerId;
  if (typeof selectedColorLayer === "string" && !colorLayerIds.has(selectedColorLayer)) throw new Error("sequence.selectedColorLayerId references a missing color layer.");
  const selectedColorClip = sequence.selectedColorClipId;
  if (typeof selectedColorClip === "string" && !colorClipIds.has(selectedColorClip)) throw new Error("sequence.selectedColorClipId references a missing color clip.");
  if (sequence.camera !== undefined && sequence.camera !== null) {
    validateEditorCameraTrack(sequence.camera, layerIds);
  } else if (sequence.camera === null) {
    throw new Error("sequence.camera must be omitted or contain a complete camera track, not null.");
  }
  return { ...sequence, sequenceId } as unknown as EditorTimeline;
}

/** Parse the untrusted JSON command crossing the localhost MCP/UI boundary. */
export function normalizeEditorMcpCommand(value: unknown): EditorMcpCommand {
  if (!isRecord(value) || typeof value.name !== "string") throw new Error("An editor MCP command name is required.");
  switch (value.name) {
    case "get_project":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected get_project fields.");
      return { name: value.name };
    case "validate_project":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected validate_project fields.");
      return { name: value.name };
    case "preview_change_set": {
      if (!onlyKeys(value, ["name", "operations"]) || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 50) throw new Error("preview_change_set requires between 1 and 50 typed operations.");
      const allowed = new Set([
        "add_interaction", "update_interaction", "duplicate_interaction", "delete_interaction", "add_region", "update_region", "duplicate_region", "delete_region",
        "update_look_follow", "replace_behavior_machines", "create_talk_sequence", "delete_sequence", "reorder_sequences", "replace_sequence", "update_camera_track", "update_project_settings",
      ]);
      const operations = value.operations.map((operation, index) => {
        if (!isRecord(operation) || typeof operation.name !== "string" || !allowed.has(operation.name)) throw new Error(`operations[${index}] is not an allowed authored-document operation.`);
        return normalizeEditorMcpCommand(operation);
      });
      return { name: value.name, operations };
    }
    case "apply_change_set":
      if (!onlyKeys(value, ["name", "changeSetId"])) throw new Error("Unexpected apply_change_set fields.");
      return { name: value.name, changeSetId: stringField(value.changeSetId, "changeSetId") };
    case "inspect_recovery":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected inspect_recovery fields.");
      return { name: value.name };
    case "restore_recovery":
      if (!onlyKeys(value, ["name", "candidate", "backupIndex"]) || !["latest", "backup"].includes(String(value.candidate))) throw new Error("restore_recovery requires latest or backup candidate.");
      if (value.candidate === "latest" && value.backupIndex !== undefined) throw new Error("backupIndex is only valid for a backup candidate.");
      if (value.candidate === "backup" && (!Number.isInteger(value.backupIndex) || (value.backupIndex as number) < 0 || (value.backupIndex as number) > 19)) throw new Error("backupIndex must be an integer from 0 through 19.");
      return { name: value.name, candidate: value.candidate as "latest" | "backup", ...(value.backupIndex === undefined ? {} : { backupIndex: value.backupIndex as number }) };
    case "open_project_file":
      if (!onlyKeys(value, ["name", "path"])) throw new Error("Unexpected open_project_file fields.");
      return { name: value.name, path: safeRelativePath(value.path, "path") };
    case "undo":
    case "redo":
      if (!onlyKeys(value, ["name"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name };
    case "add_interaction":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected add_interaction fields.");
      return { name: value.name };
    case "update_interaction": {
      if (!onlyKeys(value, ["name", "interactionId", "patch"])) throw new Error("Unexpected update_interaction fields.");
      const patch = validatePatch(value.patch, ["name", "color", "enabled", "trigger", "startAnimation", "followAnimation", "endAnimation", "faceStartAnimation", "faceFollowAnimation", "faceEndAnimation", "followTargetBone", "sensitivity", "limitX", "limitY", "smoothing", "returnDuration", "returnEasing", "startMixDuration", "followMixDuration", "releaseMixDuration", "allowX", "allowY", "rotationEnabled", "rotationAxis", "rotationMin", "rotationMax"], "patch");
      for (const field of ["name", "color", "startAnimation", "followAnimation", "endAnimation", "faceStartAnimation", "faceFollowAnimation", "faceEndAnimation"] as const) if (patch[field] !== undefined) optionalText(patch[field], `patch.${field}`);
      if (patch.followTargetBone !== undefined) optionalNullableText(patch.followTargetBone, "patch.followTargetBone");
      if (patch.trigger !== undefined && !["press", "hold", "drag"].includes(String(patch.trigger))) throw new Error("patch.trigger must be press, hold, or drag.");
      if (patch.returnEasing !== undefined && !["linear", "ease-out", "ease-in-out"].includes(String(patch.returnEasing))) throw new Error("patch.returnEasing is unsupported.");
      if (patch.rotationAxis !== undefined && patch.rotationAxis !== "x" && patch.rotationAxis !== "y") throw new Error("patch.rotationAxis must be x or y.");
      for (const field of ["enabled", "allowX", "allowY", "rotationEnabled"] as const) if (patch[field] !== undefined) optionalBoolean(patch[field], `patch.${field}`);
      const numberBounds: Record<string, [number, number]> = {
        sensitivity: [0, 2], limitX: [0, 10_000], limitY: [0, 10_000], smoothing: [0.1, 60], returnDuration: [0.05, 2],
        startMixDuration: [0, 2], followMixDuration: [0, 2], releaseMixDuration: [0, 2], rotationMin: [-180, 0], rotationMax: [0, 180],
      };
      for (const [field, [min, max]] of Object.entries(numberBounds)) if (patch[field] !== undefined) optionalNumber(patch[field], `patch.${field}`, min, max);
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), patch: patch as EditorMcpInteractionPatch };
    }
    case "duplicate_interaction":
    case "delete_interaction":
    case "select_interaction":
      if (!onlyKeys(value, ["name", "interactionId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId") };
    case "add_region":
      if (!onlyKeys(value, ["name", "interactionId", "anchorBonePath"])) throw new Error("Unexpected add_region fields.");
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), ...(value.anchorBonePath === undefined ? {} : { anchorBonePath: optionalNullableText(value.anchorBonePath, "anchorBonePath") }) };
    case "update_region": {
      if (!onlyKeys(value, ["name", "interactionId", "regionId", "patch"])) throw new Error("Unexpected update_region fields.");
      const patch = validatePatch(value.patch, ["name", "enabled", "shape", "anchorBone", "offsetX", "offsetY", "radiusX", "radiusY", "rotation", "placement"], "patch");
      if (patch.name !== undefined) optionalText(patch.name, "patch.name");
      if (patch.enabled !== undefined) optionalBoolean(patch.enabled, "patch.enabled");
      if (patch.shape !== undefined && patch.shape !== "ellipse" && patch.shape !== "rectangle") throw new Error("patch.shape must be ellipse or rectangle.");
      if (patch.anchorBone !== undefined) optionalNullableText(patch.anchorBone, "patch.anchorBone");
      if (patch.placement !== undefined && !["head-v1", "cheek-v1", "needs-head", "manual"].includes(String(patch.placement))) throw new Error("patch.placement is unsupported.");
      for (const field of ["offsetX", "offsetY"] as const) if (patch[field] !== undefined) optionalNumber(patch[field], `patch.${field}`, -1_000_000, 1_000_000);
      for (const field of ["radiusX", "radiusY"] as const) if (patch[field] !== undefined) optionalNumber(patch[field], `patch.${field}`, 0, 1_000_000);
      if (patch.rotation !== undefined) optionalNumber(patch.rotation, "patch.rotation", -360_000, 360_000);
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), regionId: stringField(value.regionId, "regionId"), patch: patch as EditorMcpRegionPatch };
    }
    case "duplicate_region":
    case "delete_region":
    case "select_region":
      if (!onlyKeys(value, ["name", "interactionId", "regionId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), regionId: stringField(value.regionId, "regionId") };
    case "update_look_follow": {
      if (!onlyKeys(value, ["name", "patch"])) throw new Error("Unexpected update_look_follow fields.");
      const patch = validatePatch(value.patch, ["enabled", "targetBonePath", "delay", "rangeX", "rangeY", "smoothing", "allowX", "allowY", "startAnimation", "faceStartAnimation", "endAnimation", "faceEndAnimation"], "patch");
      for (const field of ["enabled", "allowX", "allowY"] as const) if (patch[field] !== undefined) optionalBoolean(patch[field], `patch.${field}`);
      if (patch.targetBonePath !== undefined) optionalNullableText(patch.targetBonePath, "patch.targetBonePath");
      for (const field of ["startAnimation", "faceStartAnimation", "endAnimation", "faceEndAnimation"] as const) if (patch[field] !== undefined) optionalText(patch[field], `patch.${field}`);
      if (patch.delay !== undefined) optionalNumber(patch.delay, "patch.delay", 0, 10);
      if (patch.smoothing !== undefined) optionalNumber(patch.smoothing, "patch.smoothing", 0.1, 60);
      for (const field of ["rangeX", "rangeY"] as const) if (patch[field] !== undefined && patch[field] !== null) optionalNumber(patch[field], `patch.${field}`, 0, 512);
      return { name: value.name, patch: patch as Partial<SpineLookFollowSettings> };
    }
    case "replace_behavior_machines": {
      if (!onlyKeys(value, ["name", "machines", "graphLayouts"])) throw new Error("Unexpected replace_behavior_machines fields.");
      const machines = validateBehaviorMachineCollection(value.machines);
      const graphLayouts = value.graphLayouts === undefined ? undefined : validateBehaviorGraphLayoutCollection(value.graphLayouts, machines);
      return { name: value.name, machines, ...(graphLayouts ? { graphLayouts } : {}) };
    }
    case "create_talk_sequence":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected create_talk_sequence fields.");
      return { name: value.name };
    case "delete_sequence":
      if (!onlyKeys(value, ["name", "sequenceId"])) throw new Error("Unexpected delete_sequence fields.");
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId") };
    case "reorder_sequences": {
      if (!onlyKeys(value, ["name", "sequenceIds"]) || !Array.isArray(value.sequenceIds) || value.sequenceIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("sequenceIds must be an array of non-empty sequence IDs.");
      if (value.sequenceIds[0] !== "opening" || new Set(value.sequenceIds).size !== value.sequenceIds.length) throw new Error("sequenceIds must be unique and keep Opening first.");
      return { name: value.name, sequenceIds: value.sequenceIds as string[] };
    }
    case "replace_sequence": {
      if (!onlyKeys(value, ["name", "sequenceId", "sequence"]) || !isRecord(value.sequence)) throw new Error("replace_sequence requires a sequenceId and a full sequence object.");
      const sequenceId = stringField(value.sequenceId, "sequenceId");
      const sequence = validateEditorTimelineSnapshot(value.sequence, sequenceId);
      return { name: value.name, sequenceId, sequence };
    }
    case "update_camera_track": {
      if (!onlyKeys(value, ["name", "sequenceId", "camera"])) throw new Error("Unexpected update_camera_track fields.");
      const sequenceId = stringField(value.sequenceId, "sequenceId");
      if (value.camera === null) return { name: value.name, sequenceId, camera: null };
      const validated = validateEditorCameraTrack(value.camera);
      const camera = normalizeSpineCameraTrack(validated);
      if (!camera) throw new Error("camera must be a valid camera track or null.");
      if (camera.safeBounds.length !== validated.safeBounds.length || camera.keyframes.length !== validated.keyframes.length) throw new Error("camera contains duplicate safe bounds/keyframes or invalid keyframe times.");
      return { name: value.name, sequenceId, camera };
    }
    case "evaluate_camera_track": {
      if (!onlyKeys(value, ["name", "sequenceId", "seconds"])) throw new Error("Unexpected evaluate_camera_track fields.");
      const seconds = optionalNumber(value.seconds, "seconds", 0, 1_000_000);
      if (seconds === undefined) throw new Error("evaluate_camera_track requires a finite time in seconds.");
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId"), seconds };
    }
    case "frame_camera_item":
      if (!onlyKeys(value, ["name", "kind", "id"]) || value.kind !== "shot" && value.kind !== "bound") throw new Error("frame_camera_item requires a shot or bound ID.");
      return { name: value.name, kind: value.kind, id: stringField(value.id, "id") };
    case "update_project_settings": {
      if (!onlyKeys(value, ["name", "patch"])) throw new Error("Unexpected update_project_settings fields.");
      const patch = validatePatch(value.patch, ["name", "entrySequence", "talkMixDuration", "effectsStrength"], "patch");
      if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) throw new Error("patch.name must be a non-empty string.");
      if (patch.entrySequence !== undefined && patch.entrySequence !== null && (typeof patch.entrySequence !== "string" || !patch.entrySequence.trim())) throw new Error("patch.entrySequence must be a non-empty sequence ID or null.");
      if (patch.talkMixDuration !== undefined) optionalNumber(patch.talkMixDuration, "patch.talkMixDuration", 0, 2);
      if (patch.effectsStrength !== undefined) optionalNumber(patch.effectsStrength, "patch.effectsStrength", 0, 1);
      return { name: value.name, patch: patch as EditorMcpProjectSettingsPatch };
    }
    case "add_audio_clip": {
      if (!onlyKeys(value, ["name", "sequenceId", "audio"]) || !isRecord(value.audio)) throw new Error("add_audio_clip requires an audio clip object and sequence ID.");
      const audio = value.audio;
      if (!onlyKeys(audio, ["autoEnd", "lineId", "subtitleId", "id", "name", "path", "start", "end", "enabled", "volume"])) throw new Error("audio contains unsupported fields.");
      const start = optionalNumber(audio.start, "audio.start", 0);
      const end = optionalNumber(audio.end, "audio.end", 0);
      const volume = optionalNumber(audio.volume, "audio.volume", 0, 1);
      if (start === undefined || end === undefined || end < start + 0.01 || volume === undefined || typeof audio.enabled !== "boolean") throw new Error("audio requires valid timing, volume, and enabled values.");
      if (audio.autoEnd !== undefined) optionalBoolean(audio.autoEnd, "audio.autoEnd");
      if (audio.lineId !== undefined) optionalText(audio.lineId, "audio.lineId");
      if (audio.subtitleId !== undefined) optionalNullableText(audio.subtitleId, "audio.subtitleId");
      return {
        name: value.name,
        sequenceId: stringField(value.sequenceId, "sequenceId"),
        audio: {
          id: stringField(audio.id, "audio.id"), name: stringField(audio.name, "audio.name"), path: safeRelativePath(audio.path, "audio.path"),
          start, end, enabled: audio.enabled, volume,
          ...(audio.autoEnd === undefined ? {} : { autoEnd: audio.autoEnd as boolean }),
          ...(audio.lineId === undefined ? {} : { lineId: audio.lineId as string }),
          ...(audio.subtitleId === undefined ? {} : { subtitleId: audio.subtitleId as string | null }),
        },
      };
    }
    case "duplicate_audio_clip":
    case "update_audio_clip": {
      if (value.name === "duplicate_audio_clip") {
        if (!onlyKeys(value, ["name", "sequenceId", "audioId"])) throw new Error("Unexpected duplicate_audio_clip fields.");
        return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId"), audioId: stringField(value.audioId, "audioId") };
      }
      if (!onlyKeys(value, ["name", "sequenceId", "audioId", "patch"])) throw new Error("Unexpected update_audio_clip fields.");
      const patch = validatePatch(value.patch, ["name", "path", "start", "end", "enabled", "volume", "autoEnd"], "patch");
      if (patch.name !== undefined) stringField(patch.name, "patch.name");
      if (patch.path !== undefined) patch.path = safeRelativePath(patch.path, "patch.path");
      if (patch.start !== undefined) optionalNumber(patch.start, "patch.start", 0);
      if (patch.end !== undefined) optionalNumber(patch.end, "patch.end", 0);
      if (patch.enabled !== undefined) optionalBoolean(patch.enabled, "patch.enabled");
      if (patch.autoEnd !== undefined) optionalBoolean(patch.autoEnd, "patch.autoEnd");
      if (patch.volume !== undefined) optionalNumber(patch.volume, "patch.volume", 0, 1);
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId"), audioId: stringField(value.audioId, "audioId"), patch: patch as EditorMcpAudioPatch };
    }
    case "delete_audio_clip":
      if (!onlyKeys(value, ["name", "sequenceId", "audioId"])) throw new Error("Unexpected delete_audio_clip fields.");
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId"), audioId: stringField(value.audioId, "audioId") };
    case "link_audio_subtitle":
      if (!onlyKeys(value, ["name", "sequenceId", "audioId", "subtitleId"])) throw new Error("Unexpected link_audio_subtitle fields.");
      if (value.subtitleId !== null && typeof value.subtitleId !== "string") throw new Error("subtitleId must be a cue ID or null.");
      return { name: value.name, sequenceId: stringField(value.sequenceId, "sequenceId"), audioId: stringField(value.audioId, "audioId"), subtitleId: value.subtitleId as string | null };
    case "list_audio_assets":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected list_audio_assets fields.");
      return { name: value.name };
    case "match_audio_length":
    case "preview_audio_clip":
      if (!onlyKeys(value, ["name", "audioId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, audioId: stringField(value.audioId, "audioId") };
    case "stop_audio_preview":
      if (!onlyKeys(value, ["name"])) throw new Error("Unexpected stop_audio_preview fields.");
      return { name: value.name };
    case "create_spine_layer":
      if (!onlyKeys(value, ["name", "directory"])) throw new Error("Unexpected create_spine_layer fields.");
      return { name: value.name, directory: stringField(value.directory, "directory") };
    case "delete_spine_layer":
    case "delete_color_layer":
      if (!onlyKeys(value, ["name", "layerId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, layerId: stringField(value.layerId, "layerId") };
    case "duplicate_animation_clip":
    case "duplicate_color_clip":
    case "delete_color_clip":
      if (!onlyKeys(value, ["name", "clipId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, clipId: stringField(value.clipId, "clipId") };
    case "duplicate_subtitle_cue":
    case "select_subtitle_cue":
      if (!onlyKeys(value, ["name", "cueId"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name, cueId: stringField(value.cueId, "cueId") };
    case "split_subtitle_cue": {
      if (!onlyKeys(value, ["name", "cueId", "at"])) throw new Error("Unexpected split_subtitle_cue fields.");
      const at = optionalNumber(value.at, "at", 0);
      if (at === undefined) throw new Error("split_subtitle_cue requires a finite split time.");
      return { name: value.name, cueId: stringField(value.cueId, "cueId"), at };
    }
    case "set_timeline_items_enabled":
    case "delete_timeline_items": {
      const allowedFields = value.name === "set_timeline_items_enabled" ? ["name", "items", "enabled"] : ["name", "items"];
      if (!onlyKeys(value, allowedFields) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) throw new Error(`${value.name} requires between 1 and 100 explicit timeline item references.`);
      if (value.name === "set_timeline_items_enabled" && typeof value.enabled !== "boolean") throw new Error("enabled must be a boolean.");
      const kinds = ["layer", "color-layer", "animation", "color", "cue", "audio"];
      const seen = new Set<string>();
      const items = value.items.map((item, index) => {
        if (!isRecord(item) || !onlyKeys(item, ["kind", "id"]) || !kinds.includes(String(item.kind))) throw new Error(`items[${index}] must contain a supported kind and ID.`);
        const id = stringField(item.id, `items[${index}].id`);
        const key = `${item.kind}:${id}`;
        if (seen.has(key)) throw new Error(`items contains duplicate reference ${key}.`);
        seen.add(key);
        return { kind: item.kind as "layer" | "color-layer" | "animation" | "color" | "cue" | "audio", id };
      });
      return value.name === "set_timeline_items_enabled"
        ? { name: value.name, items, enabled: value.enabled as boolean }
        : { name: value.name, items };
    }
    case "preview_interaction_phase":
      if (!onlyKeys(value, ["name", "interactionId", "phase"]) || !["start", "follow", "end"].includes(String(value.phase))) throw new Error("preview_interaction_phase requires a supported phase and interaction ID.");
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), phase: value.phase as "start" | "follow" | "end" };
    case "start_interaction_test":
      if (!onlyKeys(value, ["name", "interactionId", "regionId"])) throw new Error("Unexpected start_interaction_test fields.");
      return { name: value.name, interactionId: stringField(value.interactionId, "interactionId"), ...(value.regionId === undefined ? {} : { regionId: stringField(value.regionId, "regionId") }) };
    case "move_interaction_test": {
      if (!onlyKeys(value, ["name", "worldX", "worldY"])) throw new Error("Unexpected move_interaction_test fields.");
      const worldX = optionalNumber(value.worldX, "worldX", -1_000_000, 1_000_000);
      const worldY = optionalNumber(value.worldY, "worldY", -1_000_000, 1_000_000);
      if (worldX === undefined || worldY === undefined) throw new Error("move_interaction_test requires finite world-space coordinates.");
      return { name: value.name, worldX, worldY };
    }
    case "release_interaction_test":
    case "cancel_interaction_test":
    case "cancel_behavior_test":
      if (!onlyKeys(value, ["name"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name };
    case "test_look_follow":
      if (!onlyKeys(value, ["name", "enabled"]) || typeof value.enabled !== "boolean") throw new Error("test_look_follow requires enabled.");
      return { name: value.name, enabled: value.enabled };
    case "inject_behavior_event":
      if (!onlyKeys(value, ["name", "machineId", "event", "regionId"]) || !["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"].includes(String(value.event))) throw new Error("inject_behavior_event requires a supported behavior event.");
      if (value.regionId !== undefined && value.regionId !== null && typeof value.regionId !== "string") throw new Error("regionId must be a string or null.");
      return { name: value.name, machineId: stringField(value.machineId, "machineId"), event: value.event as SpineBehaviorEvent, ...(value.regionId === undefined ? {} : { regionId: value.regionId as string | null }) };
    case "open_asset_root":
      if (!onlyKeys(value, ["name", "rootPath"])) throw new Error("Unexpected open_asset_root fields.");
      return { name: value.name, rootPath: stringField(value.rootPath, "rootPath") };
    case "select_asset_set":
      if (!onlyKeys(value, ["name", "directory"])) throw new Error("Unexpected select_asset_set fields.");
      return { name: value.name, directory: stringField(value.directory, "directory") };
    case "set_workspace":
      if (!onlyKeys(value, ["name", "workspace"]) || (value.workspace !== "interaction" && value.workspace !== "timeline" && value.workspace !== "camera")) throw new Error("workspace must be interaction, timeline, or camera.");
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
    case "add_animation_clip": {
      if (!onlyKeys(value, ["name", "layerId", "animation", "start", "end", "loop", "faceAnimation", "continueAfterOpening"])) throw new Error("Unexpected add_animation_clip fields.");
      const start = optionalNumber(value.start, "start", 0);
      if (start === undefined) throw new Error("MCP command requires start.");
      const end = optionalNumber(value.end, "end", 0);
      if (end !== undefined && end < start + 0.01) throw new Error("end must be at least 0.01 seconds after start.");
      if (value.faceAnimation !== undefined && value.faceAnimation !== null && typeof value.faceAnimation !== "string") throw new Error("faceAnimation must be an animation name, null (inherit), or an empty string (None).");
      return {
        name: value.name,
        layerId: stringField(value.layerId, "layerId"),
        animation: stringField(value.animation, "animation"),
        start,
        ...(end === undefined ? {} : { end }),
        ...(value.loop === undefined ? {} : { loop: optionalBoolean(value.loop, "loop") }),
        ...(value.faceAnimation === undefined ? {} : { faceAnimation: value.faceAnimation as string | null }),
        ...(value.continueAfterOpening === undefined ? {} : { continueAfterOpening: optionalBoolean(value.continueAfterOpening, "continueAfterOpening") }),
      };
    }
    case "update_animation_clip": {
      if (!onlyKeys(value, ["name", "clipId", "patch"])) throw new Error("Unexpected update_animation_clip fields.");
      const patch = validatePatch(value.patch, ["animation", "faceAnimation", "start", "end", "endMode", "animationOffset", "loop", "enabled", "continueAfterOpening", "hideCharacter"], "patch");
      if (patch.animation !== undefined) stringField(patch.animation, "patch.animation");
      if (patch.faceAnimation !== undefined && patch.faceAnimation !== null && typeof patch.faceAnimation !== "string") throw new Error("patch.faceAnimation must be an animation name, null (inherit), or an empty string (None).");
      for (const field of ["start", "end", "animationOffset"] as const) if (patch[field] !== undefined) optionalNumber(patch[field], `patch.${field}`, 0);
      if (patch.endMode !== undefined && patch.endMode !== "auto" && patch.endMode !== "manual") throw new Error("patch.endMode must be auto or manual.");
      for (const field of ["loop", "enabled", "continueAfterOpening", "hideCharacter"] as const) if (patch[field] !== undefined) optionalBoolean(patch[field], `patch.${field}`);
      return { name: value.name, clipId: stringField(value.clipId, "clipId"), patch: patch as Extract<EditorMcpCommand, { name: "update_animation_clip" }>['patch'] };
    }
    case "move_animation_clip": {
      if (!onlyKeys(value, ["name", "clipId", "start", "ripple"])) throw new Error("Unexpected move_animation_clip fields.");
      const start = optionalNumber(value.start, "start", 0);
      if (start === undefined || typeof value.ripple !== "boolean") throw new Error("move_animation_clip requires a non-negative start and an explicit ripple boolean.");
      return { name: value.name, clipId: stringField(value.clipId, "clipId"), start, ripple: value.ripple };
    }
    case "delete_animation_clip":
      if (!onlyKeys(value, ["name", "clipId", "ripple"]) || typeof value.ripple !== "boolean") throw new Error("delete_animation_clip requires a clipId and an explicit ripple boolean.");
      return { name: value.name, clipId: stringField(value.clipId, "clipId"), ripple: value.ripple };
    case "add_subtitle_cue": {
      if (!onlyKeys(value, ["name", "start", "end", "text"])) throw new Error("Unexpected add_subtitle_cue fields.");
      const start = optionalNumber(value.start, "start", 0);
      const end = optionalNumber(value.end, "end", 0);
      if (start === undefined || end === undefined || end < start + 0.01) throw new Error("Subtitle cue end must be at least 0.01 seconds after start.");
      return { name: value.name, start, end, text: validateSubtitleText(value.text, "text") };
    }
    case "update_subtitle_cue": {
      if (!onlyKeys(value, ["name", "cueId", "patch"])) throw new Error("Unexpected update_subtitle_cue fields.");
      const patch = validatePatch(value.patch, ["start", "end", "enabled", "text"], "patch");
      if (patch.start !== undefined) optionalNumber(patch.start, "patch.start", 0);
      if (patch.end !== undefined) optionalNumber(patch.end, "patch.end", 0);
      if (patch.enabled !== undefined) optionalBoolean(patch.enabled, "patch.enabled");
      if (patch.text !== undefined) patch.text = validateSubtitleText(patch.text, "patch.text");
      return { name: value.name, cueId: stringField(value.cueId, "cueId"), patch: patch as Extract<EditorMcpCommand, { name: "update_subtitle_cue" }>['patch'] };
    }
    case "delete_subtitle_cue":
      if (!onlyKeys(value, ["name", "cueId"])) throw new Error("Unexpected delete_subtitle_cue fields.");
      return { name: value.name, cueId: stringField(value.cueId, "cueId") };
    case "preview_subtitle_import":
      if (!onlyKeys(value, ["name", "path", "policy"]) || !["replace-imported-cues", "merge-missing-translations", "update-text-only"].includes(String(value.policy))) throw new Error("Unsupported subtitle import policy.");
      return { name: value.name, path: safeRelativePath(value.path, "path"), policy: value.policy as Extract<EditorMcpCommand, { name: "preview_subtitle_import" }>['policy'] };
    case "apply_subtitle_import":
      if (!onlyKeys(value, ["name", "changeSetId"])) throw new Error("Unexpected apply_subtitle_import fields.");
      return { name: value.name, changeSetId: stringField(value.changeSetId, "changeSetId") };
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
    case "start_waveform_profile":
    case "stop_waveform_profile":
      if (!onlyKeys(value, ["name"])) throw new Error(`Unexpected ${value.name} fields.`);
      return { name: value.name };
    default:
      throw new Error(`Unsupported editor MCP command: ${value.name}`);
  }
}
