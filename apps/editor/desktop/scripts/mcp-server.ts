import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mcpConnectionFiles, removeMcpConnectionFile } from "../src/bun/mcpBridge";
import type { EditorMcpCommand, EditorMcpConnectionInfo, EditorMcpState } from "@ba-spine/editor-feature/editorMcp";

interface HostConnection extends EditorMcpConnectionInfo {
  baseUrl: string;
  connectionFile: string;
  uiConnected: boolean;
  modified: number;
}

let activeConnection: HostConnection | null = null;
const subtitleImportRevisions = new Map<string, number>();

class HostUnavailableError extends Error {}

function optionValue(name: string): string | null {
  const args = Bun.argv.slice(2);
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1] ?? null;
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function parseConnection(value: unknown): EditorMcpConnectionInfo | null {
  if (!value || typeof value !== "object") return null;
  const info = value as Partial<EditorMcpConnectionInfo>;
  if (info.version !== 1 || !Number.isInteger(info.port) || !info.port || typeof info.pid !== "number" || typeof info.token !== "string") return null;
  return info as EditorMcpConnectionInfo;
}

async function readConnection(path: string): Promise<EditorMcpConnectionInfo | null> {
  try { return parseConnection(JSON.parse(await readFile(path, "utf8")) as unknown); }
  catch { return null; }
}

async function discoverHosts(): Promise<HostConnection[]> {
  const explicitFile = process.env.BA_SPINE_EDITOR_MCP_FILE ?? optionValue("--connection-file");
  const files = explicitFile ? [resolve(explicitFile)] : await mcpConnectionFiles();
  const candidates = await Promise.all(files.map(async (file) => ({
    file,
    info: await readConnection(file),
    modified: await stat(file).then((value) => value.mtimeMs).catch(() => 0),
  })));
  candidates.sort((a, b) => b.modified - a.modified);
  const hosts = await Promise.all(candidates.map(async (candidate): Promise<HostConnection | null> => {
    if (!candidate.info) return null;
    const baseUrl = `http://127.0.0.1:${candidate.info.port}`;
    try {
      const response = await fetch(`${baseUrl}/__spine/mcp/health`, {
        headers: { authorization: `Bearer ${candidate.info.token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return null;
      const health = await response.json() as { uiConnected?: unknown };
      return {
        ...candidate.info,
        baseUrl,
        connectionFile: candidate.file,
        uiConnected: health.uiConnected === true,
        modified: candidate.modified,
      };
    } catch {
      if (!explicitFile) await removeMcpConnectionFile(candidate.file);
      return null;
    }
  }));
  return hosts.filter((host): host is HostConnection => host !== null);
}

async function requestHost<T>(connection: HostConnection, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(35_000),
    });
  } catch (value) {
    throw new HostUnavailableError(`Could not reach editor PID ${connection.pid} on port ${connection.port}: ${value instanceof Error ? value.message : String(value)}`);
  }
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; result?: T; state?: T };
  if (!response.ok) {
    const error = new Error(payload.error ?? `Editor MCP request failed (${response.status}).`);
    if (payload.code) Object.assign(error, { code: payload.code });
    throw error;
  }
  return ("state" in payload ? payload.state : "result" in payload ? payload.result : payload) as T;
}

async function hostRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let connection = activeConnection;
  if (!connection) {
    const hosts = await discoverHosts();
    if (!hosts.length) throw new Error("No running editor with MCP enabled was found. Start it with `bun run dev:editor -- --mcp` first.");
    if (hosts.length > 1) throw new Error("More than one Editor is running. Call editor_list_hosts, then editor_select_host with the intended PID and port before issuing commands.");
    connection = hosts[0]!;
    activeConnection = connection;
  }
  try {
    return await requestHost<T>(connection, path, init);
  } catch (value) {
    if (!(value instanceof HostUnavailableError)) throw value;
    throw new Error(`${value instanceof Error ? value.message : String(value)} The selected Editor was not changed. Call editor_list_hosts and explicitly select another host if intended.`);
  }
}

const documentMutationCommands = new Set<EditorMcpCommand["name"]>([
  "select_sequence", "update_spine_layer", "add_animation_clip", "update_animation_clip", "move_animation_clip", "delete_animation_clip",
  "add_subtitle_cue", "update_subtitle_cue", "delete_subtitle_cue", "apply_subtitle_import", "reorder_visual_layer", "add_color_layer",
  "add_color_clip", "update_color_layer", "update_color_clip", "save",
]);

async function sendCommand<T = unknown>(command: EditorMcpCommand, expectedDocumentRevision?: number): Promise<T> {
  const expected = expectedDocumentRevision ?? (documentMutationCommands.has(command.name) ? (await editorState()).documentRevision : undefined);
  return hostRequest<T>("/__spine/mcp/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, ...(expected === undefined ? {} : { expectedDocumentRevision: expected }) }),
  });
}

async function editorState(): Promise<EditorMcpState> {
  return hostRequest<EditorMcpState>("/__spine/mcp/state");
}

function sequenceAnimationClips(state: EditorMcpState) {
  const sequence = state.timeline?.sequence;
  if (!sequence) return [];
  return sequence.layers.flatMap((layer) => {
    const clips = Array.isArray(layer.animationClips)
      ? layer.animationClips
      : layer.animation ? [{ id: layer.id, animation: layer.animation, start: layer.start, end: layer.end, endMode: layer.endMode, animationOffset: layer.animationOffset, loop: layer.loop, faceAnimation: layer.faceAnimation }] : [];
    return clips.map((clip) => ({ layer, clip }));
  });
}

function analyzeSequenceTiming(state: EditorMcpState) {
  const sequence = state.timeline?.sequence;
  if (!sequence) throw new Error("The active timeline sequence is not available.");
  const durationByLayer = new Map((state.timeline?.animationInfo ?? []).map((layer) => [layer.layerId, new Map(layer.animations.map((animation) => [animation.name, animation.duration]))]));
  return sequenceAnimationClips(state).map(({ layer, clip }) => {
    const duration = durationByLayer.get(layer.id)?.get(clip.animation) ?? null;
    const offset = Math.max(0, clip.animationOffset ?? 0);
    const expectedEnd = duration !== null && duration > 0 ? clip.start + Math.max(0.01, duration - offset) : null;
    const manualTrim = clip.endMode === "manual";
    const intentionalIdleLoop = Boolean(clip.loop) && (/idle/i.test(clip.animation) || clip.continueAfterOpening === true);
    const faceMode = Object.prototype.hasOwnProperty.call(clip, "faceAnimation")
      ? clip.faceAnimation === "" ? "none" : clip.faceAnimation ? `animation:${clip.faceAnimation}` : "inherit-layer-default"
      : layer.faceAnimation === "" ? "layer-default:none" : layer.faceAnimation ? `inherit:${layer.faceAnimation}` : "inherit-layer-default";
    return {
      layerId: layer.id,
      clipId: clip.id,
      animation: clip.animation,
      start: clip.start,
      authoredEnd: clip.end,
      effectivePlaybackEnd: manualTrim || clip.loop || expectedEnd === null ? clip.end : expectedEnd,
      expectedAutoEnd: expectedEnd,
      endpointDelta: expectedEnd === null ? null : Number((clip.end - expectedEnd).toFixed(4)),
      animationDuration: duration,
      animationOffset: offset,
      loop: Boolean(clip.loop),
      intentionalIdleLoop,
      manualTrim,
      endMode: manualTrim ? "manual" : "auto",
      secondaryAnimation: faceMode,
      enabled: clip.enabled !== false && layer.enabled,
    };
  });
}

function validateActiveSequence(state: EditorMcpState) {
  const sequence = state.timeline?.sequence;
  if (!sequence) throw new Error("The active timeline sequence is not available.");
  const timing = analyzeSequenceTiming(state);
  const byLayer = new Map((state.timeline?.animationInfo ?? []).map((layer) => [layer.layerId, new Set(layer.animations.map((animation) => animation.name))]));
  const findings: Array<Record<string, unknown>> = [];
  for (const { layer, clip } of sequenceAnimationClips(state)) {
    const knownAnimations = byLayer.get(layer.id);
    if (knownAnimations?.size && !knownAnimations.has(clip.animation)) findings.push({
      code: "missing_animation", severity: "error", asset: state.directory, sequence: sequence.sequenceId ?? "legacy", entityId: clip.id,
      evidence: { layerId: layer.id, animation: clip.animation }, suggestedFix: "Choose an animation present in this layer's Spine skeleton.", confidence: "high",
    });
    const analysis = timing.find((item) => item.clipId === clip.id);
    if (analysis?.expectedAutoEnd !== null && analysis?.expectedAutoEnd !== undefined && !analysis.manualTrim && !clip.loop && Math.abs(analysis.endpointDelta ?? 0) > 0.05) findings.push({
      code: "auto_endpoint_mismatch", severity: "warning", asset: state.directory, sequence: sequence.sequenceId ?? "legacy", entityId: clip.id,
      evidence: { animation: clip.animation, authoredEnd: clip.end, expectedAutoEnd: analysis.expectedAutoEnd, delta: analysis.endpointDelta }, suggestedFix: "Fit this automatic clip end to its decoded Spine animation duration; keep manual trims unchanged.", confidence: "high",
    });
    if (clip.loop && !analysis?.intentionalIdleLoop) findings.push({
      code: "motion_loop", severity: "warning", asset: state.directory, sequence: sequence.sequenceId ?? "legacy", entityId: clip.id,
      evidence: { animation: clip.animation, loop: clip.loop }, suggestedFix: "Review whether this non-idle motion should loop; change only if repetition is unintended.", confidence: "medium",
    });
    if (sequence.sequenceId === "opening" && clip.animation && clip.faceAnimation === undefined && Boolean(layer.faceAnimation)) findings.push({
      code: "opening_secondary_inherited", severity: "warning", asset: state.directory, sequence: sequence.sequenceId, entityId: clip.id,
      evidence: { layerId: layer.id, layerDefault: layer.faceAnimation }, suggestedFix: "Set this opening clip's secondary animation to None or choose an explicit animation. Talk clips are not affected.", confidence: "high",
    });
  }
  for (const cue of sequence.subtitles) {
    const missing = (["en", "ja", "ko"] as const).filter((language) => !cue.text[language]?.trim());
    if (missing.length) findings.push({
      code: "subtitle_translation_missing", severity: "info", asset: state.directory, sequence: sequence.sequenceId ?? "legacy", entityId: cue.id,
      evidence: { missingLanguages: missing, start: cue.start, end: cue.end }, suggestedFix: "Import an existing translation or author the missing language; do not invent text.", confidence: "high",
    });
  }
  const seen = new Set<string>();
  for (const cue of sequence.subtitles) {
    const key = `${cue.start.toFixed(3)}\u0000${cue.text.en}\u0000${cue.text.ja}\u0000${cue.text.ko}`;
    if (seen.has(key)) findings.push({
      code: "duplicate_subtitle_cue", severity: "warning", asset: state.directory, sequence: sequence.sequenceId ?? "legacy", entityId: cue.id,
      evidence: { start: cue.start, text: cue.text }, suggestedFix: "Review duplicate cues and remove only confirmed duplicates.", confidence: "medium",
    });
    seen.add(key);
  }
  return findings;
}

async function waitForPreviewView(view: { scale: number; x: number; y: number }, description: string) {
  const state = await waitForState((value) => {
    const actual = value.timeline?.preview.view;
    return Boolean(actual && Math.abs(actual.scale - view.scale) < 0.001 && Math.abs(actual.x - view.x) < 0.01 && Math.abs(actual.y - view.y) < 0.01);
  }, description);
  if (!state.timeline) throw new Error("The timeline preview state is unavailable.");
  return state.timeline.preview;
}

async function waitForState(predicate: (state: EditorMcpState) => boolean, description: string, timeoutMs = 30_000): Promise<EditorMcpState> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const state = await editorState();
      if (predicate(state)) return state;
    } catch (value) {
      lastError = value instanceof Error ? value.message : String(value);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last state error: ${lastError}` : ""}`);
}

function result(value: unknown) {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

function failed(value: unknown) {
  const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : undefined;
  return {
    content: [{ type: "text" as const, text: value instanceof Error ? value.message : String(value) }],
    ...(code ? { structuredContent: { code, message: value instanceof Error ? value.message : String(value) } } : {}),
    isError: true,
  };
}

const server = new McpServer({ name: "ba-spine-editor", version: "0.2.0" }, {
  instructions: "Use the Editor as a safe project assistant. Read editor_state and editor_get_sequence first; documentRevision is stable across playback snapshots. Preview subtitle imports before applying them, then verify with editor_get_sequence or editor_capture_preview. Authored changes stay in memory until editor_save; MCP saves reject external file conflicts and verify written content.",
});

server.registerTool("editor_list_hosts", {
  title: "List editor hosts",
  description: "List running local desktop editor MCP hosts without exposing their bearer tokens. Shows which host is currently selected and whether its UI is connected.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const hosts = await discoverHosts();
    return result(hosts.map(({ pid, port, createdAt, uiConnected }) => ({ pid, port, createdAt, uiConnected, selected: activeConnection?.pid === pid && activeConnection.port === port })));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_select_host", {
  title: "Select editor host",
  description: "Select one running local editor by PID and port so subsequent state reads and commands target that instance.",
  inputSchema: z.object({ pid: z.number().int().positive(), port: z.number().int().positive() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ pid, port }) => {
  try {
    const host = (await discoverHosts()).find((candidate) => candidate.pid === pid && candidate.port === port);
    if (!host) throw new Error(`No running editor MCP host was found for PID ${pid} on port ${port}. Refresh editor_list_hosts and try again.`);
    activeConnection = host;
    return result({ pid, port, uiConnected: host.uiConnected, selected: true });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_state", {
  title: "Read editor state",
  description: "Read current workspace/assets, fresh snapshot age, available sequences, save state, playhead, layer order and styles, preview pan/zoom and bounds, and per-Spine-renderer readiness/WebGL diagnostics.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return result(await editorState()); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_capabilities", {
  title: "Editor MCP capabilities",
  description: "List supported inspection, clip, subtitle, preview, and safe-save operations and the current project revision.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({
      protocolVersion: 1,
      editor: "ba-spine-editor",
      documentRevision: state.documentRevision,
      snapshotRevision: state.snapshotRevision ?? null,
      operations: {
        inspection: ["editor_state", "editor_get_project", "editor_list_assets", "editor_get_sequence", "editor_get_animation_info", "editor_analyze_timing", "editor_validate"],
        animationClips: ["editor_add_animation_clip", "editor_update_animation_clip", "editor_move_animation_clip", "editor_delete_animation_clip"],
        subtitles: ["editor_add_subtitle_cue", "editor_update_subtitle_cue", "editor_delete_subtitle_cue", "editor_preview_subtitle_import", "editor_apply_subtitle_import"],
        verification: ["editor_capture_preview", "editor_save"],
      },
      savePolicy: "explicit-save; external file changes are conflicts; written paths are read back and verified",
    });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_get_project", {
  title: "Inspect current project",
  description: "Return project identity, asset root, active workspace/sequence, save state, and stable document revision.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({ assetRoot: state.assetRoot, directory: state.directory, workspace: state.workspace, saveState: state.saveState, status: state.status, error: state.error, documentRevision: state.documentRevision, snapshotRevision: state.snapshotRevision ?? null, sequenceId: state.timeline?.sequenceId ?? null, sequenceCount: state.timeline?.availableSequences.length ?? 0 });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_list_assets", {
  title: "Search loaded asset sets",
  description: "Search or page through asset sets from the currently loaded asset root without returning the entire catalog.",
  inputSchema: z.object({ query: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ query, offset = 0, limit = 50 }) => {
  try {
    const state = await editorState();
    const normalized = query?.trim().toLocaleLowerCase() ?? "";
    const matches = state.assetSets.filter((name) => !normalized || name.toLocaleLowerCase().includes(normalized));
    return result({ assetRoot: state.assetRoot, currentDirectory: state.directory, offset, limit, total: matches.length, assets: matches.slice(offset, offset + limit) });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_get_sequence", {
  title: "Inspect active timeline sequence",
  description: "Return full active-sequence settings, animation clips, all subtitle translations, audio links, color layers, and animation metadata. Use editor_select_sequence first to change sequence.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    if (!state.timeline?.sequence) throw new Error("The timeline sequence is not available; open the timeline workspace first.");
    return result({ documentRevision: state.documentRevision, sequence: state.timeline.sequence, animationInfo: state.timeline.animationInfo });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_get_animation_info", {
  title: "Inspect Spine animation metadata",
  description: "List animation names and decoded durations for every loaded Spine layer in the active sequence. A null duration means the layer has not reported that animation's duration yet.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({ documentRevision: state.documentRevision, animationInfo: state.timeline?.animationInfo ?? [], availableSequences: state.timeline?.availableSequences ?? [] });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_analyze_timing", {
  title: "Analyze sequence timing",
  description: "Compare authored and decoded animation endpoints while distinguishing automatic timing, manual trims, and intentional idle continuation loops.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    const sequence = state.timeline?.sequence;
    if (!sequence) throw new Error("The active timeline sequence is not available.");
    return result({ documentRevision: state.documentRevision, sequenceId: sequence.sequenceId ?? "legacy", sequenceDuration: sequence.duration, clips: analyzeSequenceTiming(state) });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_validate", {
  title: "Validate active sequence",
  description: "Report bounded validation findings for missing animations, automatic endpoint mismatches, non-idle Talk loops, opening-only inherited secondary animation, duplicate cues, and missing translations. Does not edit files.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    const findings = validateActiveSequence(state);
    return result({ documentRevision: state.documentRevision, asset: state.directory, sequenceId: state.timeline?.sequenceId ?? null, count: findings.length, findings });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_start_waveform_profile", {
  title: "Start Editor waveform profile",
  description: "Start bounded in-memory waveform stage, animation-frame, and long-task diagnostics. Available only in a development Editor explicitly built with --profile-waveforms. No project files are written and measurements stay on the authenticated loopback MCP state.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "start_waveform_profile" })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_stop_waveform_profile", {
  title: "Stop Editor waveform profile",
  description: "Stop the active in-memory waveform profile and return its current measurements through Editor MCP state. Does not save project files.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "stop_waveform_profile" })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_open_asset_root", {
  title: "Open asset root",
  description: "Load a local Spine asset root by its absolute path. Refuses to switch away from an unsaved project. Does not write to the root.",
  inputSchema: z.object({ rootPath: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ rootPath }) => {
  try {
    await sendCommand({ name: "open_asset_root", rootPath });
    const wanted = rootPath.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
    const state = await waitForState((value) => value.assetRoot?.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase() === wanted && !value.assetLoading, "asset root loading");
    return result(state);
  } catch (value) { return failed(value); }
});

server.registerTool("editor_select_asset_set", {
  title: "Select asset set",
  description: "Switch to a Spine set in the currently loaded root. Refuses if the current project has unsaved changes.",
  inputSchema: z.object({ directory: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ directory }) => {
  try {
    await sendCommand({ name: "select_asset_set", directory });
    return result(await waitForState((state) => state.directory === directory && !state.assetLoading, `asset set ${directory} loading`));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_set_workspace", {
  title: "Change editor workspace",
  description: "Show the interaction editor or timeline workspace for the loaded asset.",
  inputSchema: z.object({ workspace: z.enum(["interaction", "timeline", "camera"]) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ workspace }) => {
  try {
    await sendCommand({ name: "set_workspace", workspace });
    return result(await waitForState((state) => state.workspace === workspace, `${workspace} workspace`));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_select_sequence", {
  title: "Select timeline sequence",
  description: "Select an available sequence in the timeline. This changes the active sequence in editor memory but does not save files.",
  inputSchema: z.object({ sequenceId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "select_sequence", sequenceId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_seek", {
  title: "Seek timeline",
  description: "Pause and seek the timeline playhead to an absolute time in seconds. Values are clamped to the active sequence duration.",
  inputSchema: z.object({ seconds: z.number().finite().min(0) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ seconds }) => {
  try { return result(await sendCommand({ name: "seek", seconds })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_set_playback", {
  title: "Control playback",
  description: "Start or pause timeline playback without changing saved project files.",
  inputSchema: z.object({ playing: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ playing }) => {
  try { return result(await sendCommand({ name: "set_playback", playing })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_set_preview_view", {
  title: "Set preview pan and zoom",
  description: "Set preview zoom (0.5–3) and/or pan in CSS pixels. This changes editor viewport state only and does not dirty or save the project.",
  inputSchema: z.object({
    scale: z.number().finite().min(0.5).max(3).optional(),
    x: z.number().finite().min(-100_000).max(100_000).optional(),
    y: z.number().finite().min(-100_000).max(100_000).optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one of scale, x, or y."),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (patch) => {
  try {
    const response = await sendCommand<{ view: { scale: number; x: number; y: number } }>({ name: "set_preview_view", patch });
    return result(await waitForPreviewView(response.view, "preview view update"));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_zoom_preview", {
  title: "Zoom timeline preview",
  description: "Zoom by a positive factor around the supplied stage-local cursor point, or around the stage center when omitted. Uses the same cursor-anchored behavior as the UI wheel and clamps to 0.5–3. Does not dirty the project.",
  inputSchema: z.object({
    factor: z.number().finite().min(0.01).max(100),
    cursor: z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }).strict().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ factor, cursor }) => {
  try {
    const response = await sendCommand<{ view: { scale: number; x: number; y: number } }>({ name: "zoom_preview", factor, ...(cursor ? { cursor } : {}) });
    return result(await waitForPreviewView(response.view, "preview zoom"));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_pan_preview", {
  title: "Pan timeline preview",
  description: "Pan the timeline preview by CSS-pixel deltas. This changes editor viewport state only and does not dirty or save the project.",
  inputSchema: z.object({ deltaX: z.number().finite().min(-100_000).max(100_000), deltaY: z.number().finite().min(-100_000).max(100_000) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ deltaX, deltaY }) => {
  try {
    const response = await sendCommand<{ view: { scale: number; x: number; y: number } }>({ name: "pan_preview", deltaX, deltaY });
    return result(await waitForPreviewView(response.view, "preview pan"));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_reset_preview", {
  title: "Reset preview view",
  description: "Reset pan only, or fit the preview to its default scale and centered position. Does not dirty the project.",
  inputSchema: z.object({ mode: z.enum(["pan", "fit"]).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ mode }) => {
  try {
    const response = await sendCommand<{ view: { scale: number; x: number; y: number } }>({ name: "reset_preview", ...(mode ? { mode } : {}) });
    return result(await waitForPreviewView(response.view, "preview reset"));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_select_visual_layer", {
  title: "Select visual layer or clip",
  description: "Select a Spine layer, color layer, or color clip by its id so its inspector and rendered preview can be examined.",
  inputSchema: z.object({ kind: z.enum(["spine-layer", "color-layer", "color-clip"]), id: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ kind, id }) => {
  try { return result(await sendCommand({ name: "select_visual", kind, id })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_update_spine_layer", {
  title: "Update Spine layer",
  description: "Edit a Spine layer's visibility, lock, opacity, blend mode, timing, animation, and transform using the timeline inspector rules. Locked layers only allow visibility or lock changes. Project changes stay in memory until editor_save is explicitly called.",
  inputSchema: z.object({
    layerId: z.string().min(1),
    patch: z.object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      locked: z.boolean().optional(),
      blendMode: z.enum(["normal", "multiply", "screen", "additive"]).optional(),
      animation: z.string().optional(),
      faceAnimation: z.string().optional(),
      followMainAnimation: z.boolean().optional(),
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      endMode: z.enum(["auto", "manual"]).optional(),
      animationOffset: z.number().finite().min(0).optional(),
      loop: z.boolean().optional(),
      x: z.number().finite().min(-100_000).max(100_000).optional(),
      y: z.number().finite().min(-100_000).max(100_000).optional(),
      scale: z.number().finite().min(0.01).max(1000).optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
    }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one layer field."),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_spine_layer", layerId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_animation_clip", {
  title: "Add animation clip",
  description: "Add an animation clip to an unlocked Spine layer at an explicit time. end may be omitted to use decoded Spine duration; faceAnimation null means inherit, an empty string means None, and a name selects an explicit secondary animation.",
  inputSchema: z.object({
    layerId: z.string().min(1),
    animation: z.string().min(1),
    start: z.number().finite().min(0),
    end: z.number().finite().min(0).optional(),
    loop: z.boolean().optional(),
    faceAnimation: z.union([z.string(), z.null()]).optional(),
    continueAfterOpening: z.boolean().optional(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, animation, start, end, loop, faceAnimation, continueAfterOpening, expectedDocumentRevision }) => {
  try {
    return result(await sendCommand({ name: "add_animation_clip", layerId, animation, start, ...(end === undefined ? {} : { end }), ...(loop === undefined ? {} : { loop }), ...(faceAnimation === undefined ? {} : { faceAnimation }), ...(continueAfterOpening === undefined ? {} : { continueAfterOpening }) }, expectedDocumentRevision));
  } catch (value) { return failed(value); }
});

server.registerTool("editor_update_animation_clip", {
  title: "Update animation clip",
  description: "Edit one clip's animation, timing, loop, offset, visibility, continuation, or secondary animation. end changes default to a manual trim; faceAnimation null means inherit and an empty string means None.",
  inputSchema: z.object({
    clipId: z.string().min(1),
    patch: z.object({
      animation: z.string().min(1).optional(),
      faceAnimation: z.union([z.string(), z.null()]).optional(),
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      endMode: z.enum(["auto", "manual"]).optional(),
      animationOffset: z.number().finite().min(0).optional(),
      loop: z.boolean().optional(),
      enabled: z.boolean().optional(),
      continueAfterOpening: z.boolean().optional(),
      hideCharacter: z.boolean().optional(),
    }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one clip field."),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_animation_clip", clipId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_move_animation_clip", {
  title: "Move animation clip",
  description: "Move one clip to an absolute start time. Choose ripple true to shift following clips or false to preserve their positions.",
  inputSchema: z.object({ clipId: z.string().min(1), start: z.number().finite().min(0), ripple: z.boolean(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, start, ripple, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "move_animation_clip", clipId, start, ripple }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_delete_animation_clip", {
  title: "Delete animation clip",
  description: "Delete one clip. Choose ripple true to close the gap and shift later clips, or false to leave the gap.",
  inputSchema: z.object({ clipId: z.string().min(1), ripple: z.boolean(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ clipId, ripple, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_animation_clip", clipId, ripple }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_subtitle_cue", {
  title: "Add translated subtitle cue",
  description: "Add one subtitle cue with explicit timing and any available en/ja/ko translations. Missing language text remains blank; MCP does not generate translations.",
  inputSchema: z.object({ start: z.number().finite().min(0), end: z.number().finite().min(0), text: z.object({ en: z.string().optional(), ja: z.string().optional(), ko: z.string().optional() }).strict(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ start, end, text, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "add_subtitle_cue", start, end, text }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_update_subtitle_cue", {
  title: "Update subtitle cue",
  description: "Update cue timing, enabled state, or selected language text without changing audio clips or explicit audio/subtitle links.",
  inputSchema: z.object({ cueId: z.string().min(1), patch: z.object({ start: z.number().finite().min(0).optional(), end: z.number().finite().min(0).optional(), enabled: z.boolean().optional(), text: z.object({ en: z.string().optional(), ja: z.string().optional(), ko: z.string().optional() }).strict().optional() }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one cue field."), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ cueId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_subtitle_cue", cueId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_delete_subtitle_cue", {
  title: "Delete subtitle cue",
  description: "Delete one subtitle cue while preserving audio clips; explicit links to the removed cue are cleared by the Editor.",
  inputSchema: z.object({ cueId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ cueId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_subtitle_cue", cueId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_preview_subtitle_import", {
  title: "Preview subtitle translation import",
  description: "Read a subtitle JSON file relative to the current asset root and preview changes to the active sequence only. Choose an explicit policy; audio and source subtitle files are not modified.",
  inputSchema: z.object({ path: z.string().min(1), policy: z.enum(["replace-imported-cues", "merge-missing-translations", "update-text-only"]) }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ path, policy }) => {
  try {
    const state = await editorState();
    const preview = await sendCommand<Record<string, unknown>>({ name: "preview_subtitle_import", path, policy }, state.documentRevision);
    const changeSetId = preview.changeSetId;
    if (typeof changeSetId !== "string") throw new Error("The Editor did not return a subtitle change-set id.");
    subtitleImportRevisions.set(changeSetId, state.documentRevision);
    while (subtitleImportRevisions.size > 20) subtitleImportRevisions.delete(subtitleImportRevisions.keys().next().value!);
    return result({ ...preview, baseDocumentRevision: state.documentRevision });
  } catch (value) { return failed(value); }
});

server.registerTool("editor_apply_subtitle_import", {
  title: "Apply reviewed subtitle import",
  description: "Apply a previously previewed subtitle change set only if the project is still at its reviewed document revision. This is one undoable edit and leaves audio unchanged.",
  inputSchema: z.object({ changeSetId: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ changeSetId }) => {
  try {
    const expectedDocumentRevision = subtitleImportRevisions.get(changeSetId);
    if (expectedDocumentRevision === undefined) throw new Error("Subtitle preview was not found or has expired. Preview the import again.");
    const applied = await sendCommand({ name: "apply_subtitle_import", changeSetId }, expectedDocumentRevision);
    subtitleImportRevisions.delete(changeSetId);
    return result(applied);
  } catch (value) { return failed(value); }
});

server.registerTool("editor_reorder_visual_layer", {
  title: "Reorder visual layer",
  description: "Move a Spine or color visual layer to the position of another visual layer. Locked layers are respected.",
  inputSchema: z.object({ layerId: z.string().min(1), targetLayerId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, targetLayerId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "reorder_visual_layer", layerId, targetLayerId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_color_layer", {
  title: "Add color layer",
  description: "Add a new editable color layer to the opening sequence. This changes editor memory only until saved.",
  inputSchema: z.object({ name: z.string().optional(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ name, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "add_color_layer", ...(name ? { nameHint: name } : {}) }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_color_clip", {
  title: "Add color clip",
  description: "Add a color clip preset at the playhead, optionally on a specified unlocked color layer.",
  inputSchema: z.object({
    preset: z.enum(["solid", "fade-from-black", "fade-to-black", "white-flash"]).optional(),
    layerId: z.string().optional(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ preset, layerId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "add_color_clip", ...(preset ? { preset } : {}), ...(layerId ? { layerId } : {}) }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_update_color_layer", {
  title: "Update color layer",
  description: "Edit a color layer's name, visibility, lock state, opacity, or whole-layer blend mode. The editor enforces layer locks.",
  inputSchema: z.object({
    layerId: z.string().min(1),
    patch: z.object({
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      locked: z.boolean().optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      blendMode: z.enum(["normal", "multiply", "screen", "additive"]).optional(),
    }).strict(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_color_layer", layerId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_update_color_clip", {
  title: "Update color clip",
  description: "Edit a color clip's color, timing, opacity, fades, name, or enabled state. Overlapping clips on a color track are normalized by the editor.",
  inputSchema: z.object({
    clipId: z.string().min(1),
    patch: z.object({
      name: z.string().optional(),
      color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      fadeIn: z.number().finite().min(0).optional(),
      fadeOut: z.number().finite().min(0).optional(),
      enabled: z.boolean().optional(),
    }).strict(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_color_clip", clipId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_save", {
  title: "Save editor project",
  description: "Explicitly save the current project and linked subtitle files. Refuses external file conflicts and verifies each written file. Inspect editor_state first and optionally pass its documentRevision to avoid saving a newer draft than reviewed.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "save" }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_capture_preview", {
  title: "Capture timeline preview",
  description: "Capture the active composition or visible stage viewport (including pan, zoom, clipping, and subtitle overlay) as PNG. Waits for visible Spine renderers and rejects context-lost or empty Spine frames; solid-color-only compositions remain valid.",
  inputSchema: z.object({ mode: z.enum(["composition", "viewport"]).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ mode }) => {
  try {
    const capture = await sendCommand<{ imageDataUrl: string; sequenceId: string | null; currentTime: number; mode: string; width: number; height: number; preview: unknown } & Record<string, unknown>>({ name: "capture_preview", ...(mode ? { mode } : {}) });
    const match = capture.imageDataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error("The editor did not return a PNG preview.");
    return {
      content: [
        { type: "image" as const, data: match[1]!, mimeType: "image/png" as const },
        { type: "text" as const, text: JSON.stringify({ sequenceId: capture.sequenceId, currentTime: capture.currentTime, mode: capture.mode, width: capture.width, height: capture.height, preview: capture.preview }, null, 2) },
      ],
      structuredContent: { sequenceId: capture.sequenceId, currentTime: capture.currentTime, mode: capture.mode, width: capture.width, height: capture.height, preview: capture.preview },
    };
  } catch (value) { return failed(value); }
});

await server.connect(new StdioServerTransport());
