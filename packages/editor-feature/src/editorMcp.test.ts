import { describe, expect, test } from "bun:test";
import { assertMcpTimelineLocksPreserved, classifyEditorMcpError, createEditorMcpErrorEnvelope, createEditorMcpResultEnvelope, EDITOR_MCP_OPERATION_REGISTRY, EDITOR_MCP_REVISION_REQUIRED_COMMANDS, editorDocumentFingerprint, editorDocumentSaveState, editorMcpErrorMessage, normalizeEditorMcpCommand } from "./editorMcp";
import { createProject } from "./editorModel";
import { switchSequence } from "./sequenceModel";

describe("editor MCP command validation", () => {
  test("shares typed operation policy, revision requirements, and stable result/error envelopes", () => {
    const getProject = EDITOR_MCP_OPERATION_REGISTRY.get_project;
    const deleteInteraction = EDITOR_MCP_OPERATION_REGISTRY.delete_interaction;
    expect(getProject.inputSchema({ name: "get_project" })).toEqual({ name: "get_project" });
    expect(() => getProject.inputSchema({ name: "get_project", extra: true })).toThrow();
    expect(getProject).toMatchObject({ mutation: "none", revisionRequired: false, domain: "project", workspace: "any", handler: "editor", resultShape: "EditorMcpResultEnvelope<unknown>" });
    expect(deleteInteraction).toMatchObject({ mutation: "authored", revisionRequired: true, domain: "interaction" });
    expect(EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has(deleteInteraction.name)).toBe(true);

    const identity = { hostPid: 123, assetRoot: "D:/assets", directory: "Aru_home", projectName: "Aru" };
    expect(createEditorMcpResultEnvelope({
      requestId: "request-1",
      projectIdentityBefore: identity,
      projectIdentityAfter: identity,
      documentRevisionBefore: 4,
      documentRevisionAfter: 5,
      result: { interactionId: "interaction-1", created: true },
      affectedEntityIds: ["interaction-1", "interaction-1"],
      createdEntityIds: ["interaction-1"],
      warnings: ["normalized"],
      normalization: { changed: true },
      saveState: "dirty",
    })).toEqual({
      envelopeVersion: 1,
      ok: true,
      requestId: "request-1",
      projectIdentity: { before: identity, after: identity },
      documentRevisions: { before: 4, after: 5 },
      result: { interactionId: "interaction-1", created: true },
      affectedEntityIds: ["interaction-1"],
      createdEntityIds: ["interaction-1"],
      warnings: ["normalized"],
      normalization: { changed: true },
      saveState: "dirty",
    });
    expect(classifyEditorMcpError({ code: "stale_document_revision", message: "Stale", details: { expected: 4 } })).toEqual({ code: "stale_document_revision", message: "Stale", details: { expected: 4 } });
    expect(editorMcpErrorMessage({ error: { code: "asset_root_unavailable", message: "Root unavailable" } })).toBe('{"error":{"code":"asset_root_unavailable","message":"Root unavailable"}}');
    expect(editorMcpErrorMessage({ message: "Readable host error" })).toBe("Readable host error");
    expect(classifyEditorMcpError(new Error("Camera evaluation requires the Camera workspace."))).toMatchObject({ code: "renderer_unavailable" });
    expect(classifyEditorMcpError(new Error("Audio asset discovery is unavailable from this source."))).toMatchObject({ code: "unsupported_capability" });
    expect(classifyEditorMcpError(new Error("The editor UI is not connected yet."))).toMatchObject({ code: "bridge_unavailable" });
    expect(createEditorMcpErrorEnvelope({ error: classifyEditorMcpError(new Error("The Spine layer is locked.")), requestId: "request-2", projectIdentityBefore: identity, documentRevisionBefore: 5 })).toMatchObject({
      envelopeVersion: 1,
      ok: false,
      requestId: "request-2",
      documentRevisions: { before: 5, after: 5 },
      error: { code: "locked_entity", message: "The Spine layer is locked." },
    });
  });

  test("accepts project inspection commands without allowing extra fields", () => {
    expect(normalizeEditorMcpCommand({ name: "get_project" })).toEqual({ name: "get_project" });
    expect(() => normalizeEditorMcpCommand({ name: "get_project", project: true })).toThrow();
    expect(normalizeEditorMcpCommand({ name: "undo" })).toEqual({ name: "undo" });
    expect(normalizeEditorMcpCommand({ name: "redo" })).toEqual({ name: "redo" });
    expect(() => normalizeEditorMcpCommand({ name: "undo", revision: 4 })).toThrow();
  });

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

  test("validates interaction, region, Look-follow, and behavior commands", () => {
    expect(normalizeEditorMcpCommand({ name: "update_interaction", interactionId: "pat", patch: { trigger: "hold", returnDuration: 0.5 } })).toEqual({
      name: "update_interaction", interactionId: "pat", patch: { trigger: "hold", returnDuration: 0.5 },
    });
    expect(normalizeEditorMcpCommand({ name: "update_region", interactionId: "pat", regionId: "head", patch: { anchorBone: null, radiusX: 64 } })).toEqual({
      name: "update_region", interactionId: "pat", regionId: "head", patch: { anchorBone: null, radiusX: 64 },
    });
    expect(normalizeEditorMcpCommand({ name: "update_look_follow", patch: { rangeX: null, enabled: false, rotationEnabled: true, rotationAxis: "y", rotationMin: -40, rotationMax: 25 } })).toEqual({
      name: "update_look_follow", patch: { rangeX: null, enabled: false, rotationEnabled: true, rotationAxis: "y", rotationMin: -40, rotationMax: 25 },
    });

    const machine = {
      id: "custom", name: "Custom", enabled: true, priority: 0, exclusiveGroup: null, resourceClaims: [],
      activation: { kind: "event", trigger: "press", regions: [], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "manual" },
      initialStateId: "idle", cancelPolicy: "reset", sourceLegacyInteractionId: null,
      states: [{ id: "idle", name: "Idle", actions: [], exitActions: [], cancelActions: [], resourceClaims: [] }],
      transitions: [],
    } as const;
    expect(normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [machine] })).toMatchObject({ name: "replace_behavior_machines", machines: [{ id: "custom" }] });
    const pointerAction = { type: "pointer-follow", targetBonePath: null, allowX: true, allowY: true, rangeX: null, rangeY: null, smoothing: 14, rotationEnabled: true, rotationAxis: "y", rotationMin: -30, rotationMax: 20 } as const;
    const pointerMachine = { ...machine, states: [{ ...machine.states[0]!, actions: [pointerAction] }] };
    expect(normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [pointerMachine] })).toMatchObject({
      machines: [{ states: [{ actions: [expect.objectContaining({ rotationEnabled: true, rotationAxis: "y", rotationMin: -30, rotationMax: 20 })] }] }],
    });
    const legacyPointerAction = (({ rotationEnabled: _enabled, rotationAxis: _axis, rotationMin: _min, rotationMax: _max, ...action }) => action)(pointerAction);
    expect(normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [{ ...pointerMachine, states: [{ ...pointerMachine.states[0]!, actions: [legacyPointerAction] }] }] })).toMatchObject({
      machines: [{ states: [{ actions: [expect.objectContaining({ rotationEnabled: false, rotationAxis: "x", rotationMin: -15, rotationMax: 15 })] }] }],
    });
    expect(normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [machine], graphLayouts: { custom: { mode: "manual", statePositions: { idle: { x: 24, y: -18 } } } } })).toMatchObject({ graphLayouts: { custom: { mode: "manual", statePositions: { idle: { x: 24, y: -18 } } } } });
    expect(() => normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [machine], graphLayouts: { stale: { mode: "manual", statePositions: {} } } })).toThrow(/unknown behavior machine/);
    expect(() => normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [machine], graphLayouts: { custom: { mode: "manual", statePositions: { missing: { x: 0, y: 0 } } } } })).toThrow(/unknown state/);
    expect(() => normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [machine], graphLayouts: { custom: { mode: "manual", statePositions: { idle: { x: 100_001, y: 0 } } } } })).toThrow(/within ±100000/);
    expect(() => normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [{ ...machine, script: "unsafe" }] })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_behavior_machines", machines: [{ ...machine, states: [{ ...machine.states[0], actions: [{ type: "execute", source: "unsafe" }] }] }] })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_interaction", interactionId: "pat", patch: { returnDuration: 50 } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_region", interactionId: "pat", regionId: "head", patch: { shape: "triangle" } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_look_follow", patch: { rotationMin: 5 } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_look_follow", patch: { rotationAxis: "z" } })).toThrow();
  });

  test("validates sequence, camera, project-setting, and audio authoring commands", () => {
    expect(normalizeEditorMcpCommand({ name: "create_talk_sequence" })).toEqual({ name: "create_talk_sequence" });
    expect(normalizeEditorMcpCommand({ name: "reorder_sequences", sequenceIds: ["opening", "talk-1"] })).toEqual({ name: "reorder_sequences", sequenceIds: ["opening", "talk-1"] });
    expect(() => normalizeEditorMcpCommand({ name: "reorder_sequences", sequenceIds: ["talk-1", "opening"] })).toThrow();
    expect(normalizeEditorMcpCommand({ name: "update_project_settings", patch: { effectsStrength: 0.75, entrySequence: null } })).toEqual({ name: "update_project_settings", patch: { effectsStrength: 0.75, entrySequence: null } });

    const project = createProject("Aru_home", ["Idle"], []);
    const sequence = { ...project.timeline, sequenceId: "opening" };
    expect(normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence })).toMatchObject({ name: "replace_sequence", sequenceId: "opening", sequence: { sequenceId: "opening" } });
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, audio: [{ id: "audio", path: "../../outside.ogg" }] } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, snap: undefined } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, layers: sequence.layers.map(({ animationOffset: _offset, ...layer }) => layer) } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, selectedColorLayerId: "missing-color-layer" } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, camera: null } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "replace_sequence", sequenceId: "opening", sequence: { ...sequence, camera: { enabled: true, aspectRatio: "16:9", constraint: { mode: "automatic" }, referenceLayerId: "missing-layer", safeBounds: [], keyframes: [] } } })).toThrow();

    const camera = { enabled: true, aspectRatio: "16:9", constraint: { mode: "automatic" }, safeBounds: [], keyframes: [] } as const;
    expect(normalizeEditorMcpCommand({ name: "update_camera_track", sequenceId: "opening", camera })).toMatchObject({ name: "update_camera_track", sequenceId: "opening", camera: { aspectRatio: "16:9" } });
    expect(normalizeEditorMcpCommand({ name: "evaluate_camera_track", sequenceId: "opening", seconds: 2.5 })).toEqual({ name: "evaluate_camera_track", sequenceId: "opening", seconds: 2.5 });
    expect(normalizeEditorMcpCommand({ name: "frame_camera_item", kind: "bound", id: "bound-1" })).toEqual({ name: "frame_camera_item", kind: "bound", id: "bound-1" });
    expect(() => normalizeEditorMcpCommand({ name: "evaluate_camera_track", sequenceId: "opening", seconds: -1 })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "frame_camera_item", kind: "viewport", id: "bound-1" })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_camera_track", sequenceId: "opening", camera: { ...camera, extra: true } })).toThrow();

    const audio = { id: "audio-1", name: "voice.ogg", path: "audios/voice.ogg", start: 0, end: 2, enabled: true, volume: 0.8, subtitleId: null };
    expect(normalizeEditorMcpCommand({ name: "add_audio_clip", sequenceId: "opening", audio })).toMatchObject({ name: "add_audio_clip", audio: { id: "audio-1", path: "audios/voice.ogg" } });
    expect(normalizeEditorMcpCommand({ name: "duplicate_audio_clip", sequenceId: "opening", audioId: "audio-1" })).toEqual({ name: "duplicate_audio_clip", sequenceId: "opening", audioId: "audio-1" });
    expect(EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has("duplicate_audio_clip")).toBe(true);
    expect(normalizeEditorMcpCommand({ name: "link_audio_subtitle", sequenceId: "opening", audioId: "audio-1", subtitleId: null })).toEqual({ name: "link_audio_subtitle", sequenceId: "opening", audioId: "audio-1", subtitleId: null });
    expect(() => normalizeEditorMcpCommand({ name: "add_audio_clip", sequenceId: "opening", audio: { ...audio, path: "C:/outside.ogg" } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_audio_clip", sequenceId: "opening", audioId: "audio-1", patch: { volume: 2 } })).toThrow();
  });

  test("validates runtime preview and behavior test commands", () => {
    expect(normalizeEditorMcpCommand({ name: "preview_interaction_phase", interactionId: "pat", phase: "follow" })).toEqual({ name: "preview_interaction_phase", interactionId: "pat", phase: "follow" });
    expect(normalizeEditorMcpCommand({ name: "start_interaction_test", interactionId: "pat", regionId: "head" })).toEqual({ name: "start_interaction_test", interactionId: "pat", regionId: "head" });
    expect(normalizeEditorMcpCommand({ name: "move_interaction_test", worldX: -15, worldY: 40 })).toEqual({ name: "move_interaction_test", worldX: -15, worldY: 40 });
    expect(normalizeEditorMcpCommand({ name: "test_look_follow", enabled: true })).toEqual({ name: "test_look_follow", enabled: true });
    expect(normalizeEditorMcpCommand({ name: "inject_behavior_event", machineId: "machine-1", event: "pointer-press", regionId: null })).toEqual({ name: "inject_behavior_event", machineId: "machine-1", event: "pointer-press", regionId: null });
    expect(normalizeEditorMcpCommand({ name: "cancel_behavior_test" })).toEqual({ name: "cancel_behavior_test" });
    expect(() => normalizeEditorMcpCommand({ name: "move_interaction_test", worldX: Number.NaN, worldY: 0 })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "inject_behavior_event", machineId: "machine-1", event: "execute-script" })).toThrow();
  });

  test("validates safe project lifecycle and reviewed change-set commands", () => {
    expect(normalizeEditorMcpCommand({ name: "open_project_file", path: "projects/current.json" })).toEqual({ name: "open_project_file", path: "projects/current.json" });
    expect(() => normalizeEditorMcpCommand({ name: "open_project_file", path: "../../outside.json" })).toThrow();
    expect(normalizeEditorMcpCommand({ name: "inspect_recovery" })).toEqual({ name: "inspect_recovery" });
    expect(normalizeEditorMcpCommand({ name: "restore_recovery", candidate: "backup", backupIndex: 2 })).toEqual({ name: "restore_recovery", candidate: "backup", backupIndex: 2 });
    expect(() => normalizeEditorMcpCommand({ name: "restore_recovery", candidate: "latest", backupIndex: 0 })).toThrow();

    const operations = [
      { name: "update_interaction", interactionId: "pat", patch: { enabled: false } },
      { name: "update_project_settings", patch: { effectsStrength: 0.75 } },
    ];
    expect(normalizeEditorMcpCommand({ name: "preview_change_set", operations })).toMatchObject({ name: "preview_change_set", operations });
    expect(normalizeEditorMcpCommand({ name: "apply_change_set", changeSetId: "change-set-1" })).toEqual({ name: "apply_change_set", changeSetId: "change-set-1" });
    expect(() => normalizeEditorMcpCommand({ name: "preview_change_set", operations: [{ name: "save" }] })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "preview_change_set", operations: [{ name: "update_interaction", interactionId: "pat", patch: { enabled: "false" } }] })).toThrow();
  });

  test("validates explicit bulk timeline operations and marks them revision-required", () => {
    const items: Array<{ kind: "layer" | "color-layer" | "animation" | "color" | "cue" | "audio"; id: string }> = [{ kind: "layer", id: "layer-1" }, { kind: "audio", id: "audio-1" }];
    expect(normalizeEditorMcpCommand({ name: "set_timeline_items_enabled", items, enabled: false })).toEqual({ name: "set_timeline_items_enabled", items, enabled: false });
    expect(normalizeEditorMcpCommand({ name: "delete_timeline_items", items })).toEqual({ name: "delete_timeline_items", items });
    expect(() => normalizeEditorMcpCommand({ name: "delete_timeline_items", items: [{ kind: "unknown", id: "x" }] })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "delete_timeline_items", items: [{ kind: "audio", id: "x" }, { kind: "audio", id: "x" }] })).toThrow();
    expect(EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has("set_timeline_items_enabled")).toBe(true);
    expect(EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has("delete_timeline_items")).toBe(true);
  });

  test("full sequence edits cannot bypass locked layers, camera bounds, or the main character", () => {
    const before = createProject("Aru_home", ["Idle"], []).timeline;
    before.layers[0]!.locked = true;
    before.colorLayers = [{ id: "color-1", name: "Locked colors", enabled: true, locked: true, opacity: 1, order: 3, blendMode: "normal", clips: [] }];
    before.camera = {
      enabled: true,
      aspectRatio: "16:9",
      constraint: { mode: "manual", boundId: "bound-1" },
      safeBounds: [{ id: "bound-1", name: "Locked bound", x: 0, y: 0, width: 100, height: 100, enabled: true, locked: true }],
      keyframes: [],
    };

    const selectionOnly = structuredClone(before);
    selectionOnly.layers[0]!.enabled = false;
    selectionOnly.colorLayers[0]!.enabled = false;
    expect(() => assertMcpTimelineLocksPreserved(before, selectionOnly)).not.toThrow();

    const movedLockedLayer = structuredClone(before);
    movedLockedLayer.layers[0]!.x += 1;
    expect(() => assertMcpTimelineLocksPreserved(before, movedLockedLayer)).toThrow(/locked Spine layer/);

    const changedLockedBound = structuredClone(before);
    changedLockedBound.camera!.safeBounds[0]!.x += 1;
    expect(() => assertMcpTimelineLocksPreserved(before, changedLockedBound)).toThrow(/locked camera bound/);

    const removedCharacter = structuredClone(before);
    removedCharacter.layers = removedCharacter.layers.filter((layer) => layer.role !== "character");
    expect(() => assertMcpTimelineLocksPreserved(before, removedCharacter)).toThrow(/main character layer/);
  });

  test("validates clip editing and revision-safe subtitle import commands", () => {
    expect(normalizeEditorMcpCommand({ name: "add_animation_clip", layerId: "character", animation: "Talk_01_M", start: 2, faceAnimation: null })).toEqual({
      name: "add_animation_clip", layerId: "character", animation: "Talk_01_M", start: 2, faceAnimation: null,
    });
    expect(normalizeEditorMcpCommand({ name: "update_animation_clip", clipId: "clip-1", patch: { faceAnimation: "", end: 4 } })).toEqual({
      name: "update_animation_clip", clipId: "clip-1", patch: { faceAnimation: "", end: 4 },
    });
    expect(normalizeEditorMcpCommand({ name: "move_animation_clip", clipId: "clip-1", start: 5, ripple: false })).toEqual({
      name: "move_animation_clip", clipId: "clip-1", start: 5, ripple: false,
    });
    expect(normalizeEditorMcpCommand({ name: "update_subtitle_cue", cueId: "cue-1", patch: { text: { ja: "こんにちは" } } })).toEqual({
      name: "update_subtitle_cue", cueId: "cue-1", patch: { text: { ja: "こんにちは" } },
    });
    expect(normalizeEditorMcpCommand({ name: "preview_subtitle_import", path: "lobbies/Aru_home/subtitles.json", policy: "merge-missing-translations" })).toEqual({
      name: "preview_subtitle_import", path: "lobbies/Aru_home/subtitles.json", policy: "merge-missing-translations",
    });
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
    expect(() => normalizeEditorMcpCommand({ name: "move_animation_clip", clipId: "clip-1", start: 2 })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "add_animation_clip", layerId: "character", animation: "Talk_01_M", start: 2, end: 2 })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "update_subtitle_cue", cueId: "cue-1", patch: { text: { en: 2 } } })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "preview_subtitle_import", path: "../../outside.json", policy: "replace-imported-cues" })).toThrow();
    expect(() => normalizeEditorMcpCommand({ name: "preview_subtitle_import", path: "C:/outside.json", policy: "replace-imported-cues" })).toThrow();
  });

  test("document fingerprints ignore selection and return to the saved state after undo", () => {
    const original = createProject("Aru_home", ["Idle"], []);
    const savedFingerprint = editorDocumentFingerprint(original);
    const selected = structuredClone(original);
    selected.selectedInteractionId = "other-interaction";
    selected.selectedRegionId = "other-region";
    selected.selectedBonePath = "root/head";
    selected.timeline.selectedLayerId = "layer-2";
    selected.timeline.selectedCueId = "cue-2";
    expect(editorDocumentFingerprint(selected)).toBe(editorDocumentFingerprint(original));
    expect(editorDocumentSaveState(selected, savedFingerprint)).toBe("saved");

    const edited = structuredClone(selected);
    edited.timeline.duration += 1;
    expect(editorDocumentFingerprint(edited)).not.toBe(savedFingerprint);
    expect(editorDocumentSaveState(edited, savedFingerprint)).toBe("dirty");
    const undone = structuredClone(original);
    expect(editorDocumentSaveState(undone, savedFingerprint)).toBe("saved");
  });

  test("document revision fingerprints are stable when selecting a cached sequence", () => {
    const project = createProject("Aru_home", ["Idle"], []);
    project.timeline.sequenceId = "opening";
    const talk = structuredClone(project.timeline);
    talk.sequenceId = "talk-1";
    talk.duration = 8;
    talk.layersInitialized = true;
    talk.layers = talk.layers.map((layer) => ({ ...layer, loop: false }));
    project.sequences = { "talk-1": talk };
    const selected = switchSequence(project, "talk-1", ["Idle"], []);
    expect(editorDocumentFingerprint(selected)).toBe(editorDocumentFingerprint(project));
  });
});
