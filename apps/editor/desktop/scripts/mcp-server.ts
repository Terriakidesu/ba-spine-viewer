import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mcpConnectionFiles, removeMcpConnectionFile } from "../src/bun/mcpBridge";
import { classifyEditorMcpError, createEditorMcpErrorEnvelope, createEditorMcpResultEnvelope, editorMcpErrorMessage, EDITOR_MCP_OPERATION_REGISTRY, EDITOR_MCP_REVISION_REQUIRED_COMMANDS, type EditorMcpCommand, type EditorMcpConnectionInfo, type EditorMcpErrorEnvelope, type EditorMcpProjectIdentity, type EditorMcpResultEnvelope, type EditorMcpState } from "@ba-spine/editor-feature/editorMcp";

interface HostConnection extends EditorMcpConnectionInfo {
  baseUrl: string;
  connectionFile: string;
  uiConnected: boolean;
  modified: number;
}

let activeConnection: HostConnection | null = null;
let lastKnownEditorState: EditorMcpState | null = null;
const subtitleImportRevisions = new Map<string, number>();
const registeredToolNames: string[] = [];
const idempotentRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

function trackToolName(name: string): string {
  registeredToolNames.push(name);
  return name;
}

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
    throw new HostUnavailableError(`Could not reach editor PID ${connection.pid} on port ${connection.port}: ${editorMcpErrorMessage(value)}`);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const errorValue = payload.error;
    const message = errorValue && typeof errorValue === "object" && "message" in errorValue && typeof errorValue.message === "string"
      ? errorValue.message
      : typeof payload.message === "string" ? payload.message : typeof errorValue === "string" ? errorValue : `Editor MCP request failed (${response.status}).`;
    const error = new Error(message);
    const code = errorValue && typeof errorValue === "object" && "code" in errorValue ? errorValue.code : payload.code;
    if (typeof code === "string") Object.assign(error, { code });
    if (payload.envelopeVersion === 1) Object.assign(error, { envelope: payload });
    throw error;
  }
  if (payload.envelopeVersion === 1) return payload as T;
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
    lastKnownEditorState = null;
  }
  try {
    return await requestHost<T>(connection, path, init);
  } catch (value) {
    if (!(value instanceof HostUnavailableError)) throw value;
    throw new Error(`${editorMcpErrorMessage(value)} The selected Editor was not changed. Call editor_list_hosts and explicitly select another host if intended.`);
  }
}

async function sendCommand<T = unknown>(command: EditorMcpCommand, expectedDocumentRevision?: number, idempotencyKey?: string): Promise<T> {
  if (idempotencyKey !== undefined) {
    const normalizedKey = idempotencyKey.trim();
    if (!normalizedKey || normalizedKey.length > 128) throw new Error("idempotencyKey must contain 1 to 128 characters.");
    if (!activeConnection) await editorState();
    const scopeState = await editorState();
    const scopedKey = `${activeConnection?.connectionFile ?? `${activeConnection?.pid ?? "unknown"}:${activeConnection?.port ?? "unknown"}`}:${scopeState.assetRoot ?? "no-root"}:${scopeState.directory ?? "no-set"}:${scopeState.projectName ?? "no-project"}:${normalizedKey}`;
    const fingerprint = JSON.stringify({ command, expectedDocumentRevision: expectedDocumentRevision ?? null });
    const existing = idempotentRequests.get(scopedKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("The idempotencyKey was already used for a different command or document revision on this Editor host.");
      return existing.promise as Promise<T>;
    }
    const pending = dispatchCommand<T>(command, expectedDocumentRevision);
    idempotentRequests.set(scopedKey, { fingerprint, promise: pending });
    while (idempotentRequests.size > 200) idempotentRequests.delete(idempotentRequests.keys().next().value!);
    return pending;
  }
  return dispatchCommand<T>(command, expectedDocumentRevision);
}

async function dispatchCommand<T>(command: EditorMcpCommand, expectedDocumentRevision?: number): Promise<T> {
  const expected = expectedDocumentRevision ?? (EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has(command.name) ? (await editorState()).documentRevision : undefined);
  return hostRequest<T>("/__spine/mcp/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, ...(expected === undefined ? {} : { expectedDocumentRevision: expected }) }),
  });
}

async function editorState(): Promise<EditorMcpState> {
  const state = await hostRequest<EditorMcpState>("/__spine/mcp/state");
  lastKnownEditorState = state;
  return state;
}

async function editorProjectDocument() {
  const state = await editorState();
  const document = await sendCommand<{
    project: import("@ba-spine/editor-feature/editorModel").EditorProject;
    assetRoot: string | null;
    directory: string;
    workspace: string;
    saveState: string;
    undoAvailable: boolean;
    redoAvailable: boolean;
    documentRevision: number;
  }>({ name: "get_project" }, state.documentRevision);
  return document;
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
      lastError = editorMcpErrorMessage(value);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last state error: ${lastError}` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function projectIdentity(state: EditorMcpState | null): EditorMcpProjectIdentity {
  return {
    hostPid: activeConnection?.pid ?? null,
    assetRoot: state?.assetRoot ?? null,
    directory: state?.directory ?? null,
    projectName: state?.projectName ?? null,
  };
}

function flattenEnvelope<T>(envelope: EditorMcpResultEnvelope<T>): Record<string, unknown> {
  const legacyFields = isRecord(envelope.result) ? envelope.result : { value: envelope.result };
  return { ...legacyFields, ...envelope };
}

function result(value: unknown) {
  let envelope: EditorMcpResultEnvelope<unknown>;
  if (isRecord(value) && value.envelopeVersion === 1 && value.ok === true) envelope = value as unknown as EditorMcpResultEnvelope<unknown>;
  else {
    const state = lastKnownEditorState;
    const identity = projectIdentity(state);
    const documentRevision = state?.documentRevision ?? null;
    envelope = createEditorMcpResultEnvelope({
      requestId: crypto.randomUUID(),
      projectIdentityBefore: identity,
      projectIdentityAfter: identity,
      documentRevisionBefore: documentRevision,
      documentRevisionAfter: documentRevision,
      result: value,
      saveState: state?.saveState ?? null,
    });
  }
  const structured = flattenEnvelope(envelope);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function failed(value: unknown) {
  const classified = classifyEditorMcpError(value);
  const message = classified.message;
  const attached = isRecord(value) && isRecord(value.envelope) && value.envelope.envelopeVersion === 1 && value.envelope.ok === false
    ? value.envelope as unknown as EditorMcpErrorEnvelope
    : null;
  const state = lastKnownEditorState;
  const identity = projectIdentity(state);
  const errorEnvelope = attached ?? createEditorMcpErrorEnvelope({
    requestId: null,
    projectIdentityBefore: identity,
    projectIdentityAfter: identity,
    documentRevisionBefore: state?.documentRevision ?? null,
    documentRevisionAfter: state?.documentRevision ?? null,
    error: classified,
    saveState: state?.saveState ?? null,
  });
  const structured = { ...errorEnvelope, message, code: errorEnvelope.error.code };
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: structured,
    isError: true,
  };
}

const server = new McpServer({ name: "ba-spine-editor", version: "0.3.0" }, {
  instructions: "Use the Editor as a safe project assistant. Read editor_capabilities and editor_state first; documentRevision is stable across playback snapshots. Use editor_get_project_document for workspace-independent authored data and editor_evaluate_composition for deterministic composition sampling at an explicit time. Typed project, interaction, behavior, sequence, camera-track, composition-migration, and timeline-content edits work across workspaces. Legacy composition migration requires an explicit output schedule and persistent-background time mapping; preview its report/diff before applying the reviewed change set. Migration preserves source sequences and remains in memory until explicitly saved. Playhead/viewport controls, audio preview/duration decoding, subtitle-import preview/apply, and rendered captures require the Timeline workspace to be mounted; call editor_set_workspace first and check availability.timelineWorkspaceMounted. Camera evaluation and framing require the Camera workspace; check availability.cameraWorkspaceMounted. Preview subtitle imports before applying them, then verify with editor_get_sequence or editor_capture_preview. Authored changes stay in memory until editor_save; MCP saves reject external file conflicts and verify written content.",
});

const behaviorScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const behaviorRegionSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), enabled: z.boolean(), shape: z.enum(["ellipse", "rectangle"]), anchorBone: z.string().nullable(),
  offsetX: z.number().finite(), offsetY: z.number().finite(), radiusX: z.number().finite().min(0), radiusY: z.number().finite().min(0), rotation: z.number().finite(),
}).strict();
const behaviorActivationSchema = z.object({
  kind: z.enum(["pointer-region", "pointer-canvas", "timer", "event"]), trigger: z.enum(["press", "hold", "drag"]), regions: z.array(behaviorRegionSchema),
  holdDelay: z.number().finite().min(0).max(10), dragThreshold: z.number().finite().min(0), timerSeconds: z.number().finite().min(0),
  event: z.enum(["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"]),
}).strict();
const behaviorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("play-animation"), mainAnimation: z.string().nullable(), faceAnimation: z.string().nullable(), bodyTrack: z.number().int().min(1).max(32), faceTrack: z.number().int().min(1).max(32), loop: z.boolean(), mixDuration: z.number().finite().min(0).max(2), fallbackProfile: z.enum(["look-start", "look-end"]).optional() }).strict(),
  z.object({ type: z.literal("pointer-follow"), targetBonePath: z.string().nullable(), allowX: z.boolean(), allowY: z.boolean(), rangeX: z.number().finite().min(0).max(512).nullable(), rangeY: z.number().finite().min(0).max(512).nullable(), smoothing: z.number().finite().min(0.1).max(60), rotationEnabled: z.boolean().default(false), rotationAxis: z.enum(["x", "y"]).default("x"), rotationMin: z.number().finite().min(-180).max(0).default(-15), rotationMax: z.number().finite().min(0).max(180).default(15) }).strict(),
  z.object({ type: z.literal("drag-bone"), targetBonePath: z.string().nullable(), sensitivity: z.number().finite().min(0).max(10), limitX: z.number().finite().min(0), limitY: z.number().finite().min(0), allowX: z.boolean(), allowY: z.boolean(), smoothing: z.number().finite().min(0.1).max(60), returnDuration: z.number().finite().min(0.05).max(10) }).strict(),
  z.object({ type: z.literal("rotate-bone"), targetBonePath: z.string().nullable(), axis: z.enum(["x", "y"]), minimum: z.number().finite().min(-360).max(0), maximum: z.number().finite().min(0).max(360), returnDuration: z.number().finite().min(0.05).max(10) }).strict(),
  z.object({ type: z.literal("play-audio"), audioId: z.string(), volume: z.number().finite().min(0).max(1), loop: z.boolean() }).strict(),
  z.object({ type: z.literal("show-subtitle"), cueId: z.string() }).strict(),
  z.object({ type: z.literal("set-variable"), name: z.string().min(1), value: behaviorScalarSchema }).strict(),
  z.object({ type: z.literal("wait"), seconds: z.number().finite().min(0).max(3600) }).strict(),
  z.object({ type: z.literal("restore-resource"), resource: z.string() }).strict(),
]);
const behaviorConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pointer-held"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("region-hit"), regionIds: z.array(z.string().min(1)) }).strict(),
  z.object({ type: z.literal("held-for"), seconds: z.number().finite().min(0).max(3600) }).strict(),
  z.object({ type: z.literal("drag-distance"), minimum: z.number().finite().min(0) }).strict(),
  z.object({ type: z.literal("variable"), name: z.string().min(1), operator: z.enum(["equals", "not-equals", "greater-than", "less-than"]), value: behaviorScalarSchema }).strict(),
  z.object({ type: z.literal("machine-state"), machineId: z.string().min(1), stateId: z.string().min(1) }).strict(),
]);
const behaviorStateSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), actions: z.array(behaviorActionSchema), exitActions: z.array(behaviorActionSchema), cancelActions: z.array(behaviorActionSchema), resourceClaims: z.array(z.string()),
}).strict();
const behaviorTransitionSchema = z.object({
  id: z.string().min(1), fromStateId: z.string().min(1), toStateId: z.string().min(1),
  event: z.enum(["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"]),
  conditions: z.array(behaviorConditionSchema), afterSeconds: z.number().finite().min(0).max(3600), priority: z.number().int().min(-1000).max(1000),
  blendDuration: z.number().finite().min(0).max(2), interruptPolicy: z.enum(["allow", "deny", "queue"]),
}).strict();
const behaviorMachineSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), enabled: z.boolean(), priority: z.number().int().min(-1000).max(1000), exclusiveGroup: z.string().nullable(), resourceClaims: z.array(z.string()),
  activation: behaviorActivationSchema, initialStateId: z.string().min(1), cancelPolicy: z.enum(["reset", "run-exit"]), states: z.array(behaviorStateSchema).min(1),
  transitions: z.array(behaviorTransitionSchema), sourceLegacyInteractionId: z.string().nullable(),
}).strict();
const behaviorGraphLayoutSchema = z.object({
  mode: z.enum(["auto", "manual"]), statePositions: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }).strict()),
}).strict();
const cameraConstraintSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z.object({ mode: z.literal("manual"), boundId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);
const cameraTrackSchema = z.object({
  enabled: z.boolean(), aspectRatio: z.enum(["16:9", "4:3"]), constraint: cameraConstraintSchema, referenceLayerId: z.string().optional(),
  safeBounds: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive(), enabled: z.boolean(), visible: z.boolean().optional(), locked: z.boolean().optional(), priority: z.number().finite().optional() }).strict()),
  keyframes: z.array(z.object({ id: z.string().min(1), time: z.number().finite().min(0), centerX: z.number().finite(), centerY: z.number().finite(), frameHeight: z.number().finite().positive(), easing: z.enum(["linear", "smooth", "hold"]).optional(), constraint: cameraConstraintSchema.optional() }).strict()),
}).strict();
const animationClipSchema = z.object({
  id: z.string().min(1), animation: z.string(), faceAnimation: z.string().optional(), start: z.number().finite().min(0), end: z.number().finite().min(0),
  endMode: z.enum(["auto", "manual"]).optional(), animationOffset: z.number().finite().min(0), loop: z.boolean(), enabled: z.boolean().optional(),
  continueAfterOpening: z.boolean().optional(), hideCharacter: z.boolean().optional(),
}).strict();
const timelineLayerSchema = z.object({
  id: z.string().min(1), name: z.string(), role: z.enum(["character", "scene", "background", "overlay"]), directory: z.string(), enabled: z.boolean(), locked: z.boolean().optional(),
  blendMode: z.enum(["normal", "multiply", "screen", "additive"]).optional(), animation: z.string(), faceAnimation: z.string().optional(), animationClips: z.array(animationClipSchema).optional(),
  followMainAnimation: z.boolean().optional(), start: z.number().finite().min(0), end: z.number().finite().min(0), endMode: z.enum(["auto", "manual"]).optional(),
  animationOffset: z.number().finite().min(0), loop: z.boolean(), x: z.number().finite(), y: z.number().finite(), scale: z.number().finite().positive(), opacity: z.number().finite().min(0).max(1), order: z.number().finite(),
}).strict();
const colorLayerSchema = z.object({
  id: z.string().min(1), name: z.string(), enabled: z.boolean(), locked: z.boolean(), opacity: z.number().finite().min(0).max(1), order: z.number().finite(), blendMode: z.enum(["normal", "multiply", "screen", "additive"]),
  clips: z.array(z.object({ id: z.string().min(1), name: z.string(), color: z.string().regex(/^#[\da-f]{6}$/i), start: z.number().finite().min(0), end: z.number().finite().min(0), opacity: z.number().finite().min(0).max(1), fadeIn: z.number().finite().min(0), fadeOut: z.number().finite().min(0), enabled: z.boolean() }).strict()),
}).strict();
const subtitleCueSchema = z.object({
  lineId: z.string().optional(), id: z.string().min(1), start: z.number().finite().min(0), end: z.number().finite().min(0), enabled: z.boolean(),
  text: z.object({ en: z.string(), ja: z.string(), ko: z.string() }).strict(),
}).strict();
const audioClipSchema = z.object({
  autoEnd: z.boolean().optional(), lineId: z.string().optional(), subtitleId: z.string().nullable().optional(), id: z.string().min(1), name: z.string(), path: z.string().min(1),
  start: z.number().finite().min(0), end: z.number().finite().min(0), enabled: z.boolean(), volume: z.number().finite().min(0).max(1),
}).strict();
const audioPatchSchema = z.object({
  name: z.string().min(1).optional(), path: z.string().min(1).optional(), start: z.number().finite().min(0).optional(), end: z.number().finite().min(0).optional(),
  enabled: z.boolean().optional(), volume: z.number().finite().min(0).max(1).optional(), autoEnd: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one audio field.");
const editorTimelineSchema = z.object({
  sequenceId: z.string().optional(), subtitlePath: z.string().optional(), openingMode: z.enum(["scene-first", "direct", "skip"]).optional(), sceneDuration: z.number().finite().min(0).optional(),
  openingIdleDuration: z.number().finite().min(0).optional(), durationMode: z.enum(["auto", "manual"]).optional(), layersInitialized: z.boolean(), duration: z.number().finite().positive(), loop: z.boolean(),
  assetPaths: z.record(z.string(), z.string()).optional(), layers: z.array(timelineLayerSchema), colorLayers: z.array(colorLayerSchema), subtitles: z.array(subtitleCueSchema), audio: z.array(audioClipSchema),
  selectedLayerId: z.string().nullable(), selectedCueId: z.string().nullable(), selectedColorLayerId: z.string().nullable(), selectedColorClipId: z.string().nullable(),
  language: z.enum(["en", "ja", "ko"]), snap: z.number().finite().min(0), camera: cameraTrackSchema.optional(),
}).strict();

server.registerTool(trackToolName("editor_list_hosts"), {
  title: "List editor hosts",
  description: "List running local desktop editor MCP hosts without exposing their bearer tokens. Shows which host is currently selected and whether its UI is connected.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const hosts = await discoverHosts();
    return result(hosts.map(({ pid, port, createdAt, uiConnected }) => ({ pid, port, createdAt, uiConnected, selected: activeConnection?.pid === pid && activeConnection.port === port })));
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_select_host"), {
  title: "Select editor host",
  description: "Select one running local editor by PID and port so subsequent state reads and commands target that instance.",
  inputSchema: z.object({ pid: z.number().int().positive(), port: z.number().int().positive() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ pid, port }) => {
  try {
    const host = (await discoverHosts()).find((candidate) => candidate.pid === pid && candidate.port === port);
    if (!host) throw new Error(`No running editor MCP host was found for PID ${pid} on port ${port}. Refresh editor_list_hosts and try again.`);
    activeConnection = host;
    lastKnownEditorState = null;
    return result({ pid, port, uiConnected: host.uiConnected, selected: true });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_state"), {
  title: "Read editor state",
  description: "Read current workspace/assets, fresh snapshot age, available sequences, save state, playhead, layer order and styles, preview pan/zoom and bounds, and per-Spine-renderer readiness/WebGL diagnostics.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return result(await editorState()); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_capabilities"), {
  title: "Editor MCP capabilities",
  description: "List every registered Editor MCP tool, protocol details, availability, and safe-save policy.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({
      protocolVersion: 1,
      editor: "ba-spine-editor",
      documentRevision: state.documentRevision,
      snapshotRevision: state.snapshotRevision ?? null,
      tools: [...registeredToolNames],
      operations: {
        inspection: registeredToolNames.filter((name) => /^(editor_state|editor_capabilities|editor_get_|editor_list_|editor_analyze_|editor_validate)/.test(name)),
        project: registeredToolNames.filter((name) => /project|undo|redo|asset_root|asset_set/.test(name)),
        interactions: registeredToolNames.filter((name) => /interaction|region|look_follow/.test(name)),
        behaviors: registeredToolNames.filter((name) => /behavior/.test(name)),
        timeline: registeredToolNames.filter((name) => /sequence|animation|spine_layer|visual_layer|timeline_items|color|preview|seek|playback/.test(name)),
        audio: registeredToolNames.filter((name) => /audio/.test(name)),
        subtitles: registeredToolNames.filter((name) => /subtitle/.test(name)),
        camera: registeredToolNames.filter((name) => /camera/.test(name)),
        persistence: registeredToolNames.filter((name) => /save|recovery|project/.test(name)),
        diagnostics: registeredToolNames.filter((name) => /validate|analyze|profile/.test(name)),
      },
      operationRegistry: Object.values(EDITOR_MCP_OPERATION_REGISTRY).map(({ name, toolName, description, mutation, revisionRequired, domain, workspace, handler, resultShape, annotations }) => ({ name, toolName, description, mutation, revisionRequired, domain, workspace, handler, resultShape, annotations })),
      resultContract: { envelopeVersion: 1, success: "EditorMcpResultEnvelope", errorCodes: ["stale_document_revision", "invalid_reference", "locked_entity", "renderer_unavailable", "external_conflict", "unsupported_capability", "invalid_command", "revision_required", "command_timeout", "bridge_unavailable", "editor_command_failed"] },
      availability: { editorRunning: true, uiConnected: true, activeWorkspace: state.workspace, timelineWorkspaceMounted: state.timeline !== null, cameraWorkspaceMounted: state.workspace === "camera" && state.timeline !== null, assetLoaded: state.directory !== null, waveformProfilingBuild: state.waveformProfilingAvailable === true },
      savePolicy: "explicit-save; external file changes are conflicts; written paths are read back and verified",
    });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_project"), {
  title: "Inspect current project",
  description: "Return project identity, asset root, active workspace/sequence, save state, and stable document revision.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({ assetRoot: state.assetRoot, directory: state.directory, workspace: state.workspace, saveState: state.saveState, status: state.status, error: state.error, documentRevision: state.documentRevision, snapshotRevision: state.snapshotRevision ?? null, sequenceId: state.timeline?.sequenceId ?? null, sequenceCount: state.timeline?.availableSequences.length ?? 0 });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_evaluate_composition"), {
  title: "Evaluate unified composition",
  description: "Sample the shared deterministic composition evaluator at an explicit time. Returns active sections, property values, layer transforms, animation source times, cues, and diagnostics without mounting a preview workspace or changing authored data.",
  inputSchema: z.object({ seconds: z.number().finite().min(0).max(1_000_000) }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ seconds }) => {
  try {
    const state = await editorState();
    return result(await sendCommand({ name: "evaluate_composition", seconds }, state.documentRevision));
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_project_document"), {
  title: "Inspect full authored project",
  description: "Return the complete authored Editor project, including settings, interactions, behavior machines, graph layouts, sequences, audio, subtitles, and camera tracks. This is a read-only snapshot at one document revision.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return result(await editorProjectDocument()); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_inspect_recovery"), {
  title: "Inspect recovery snapshots",
  description: "List in-memory metadata for the current asset set's latest and previous recovery snapshots without restoring or overwriting anything.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "inspect_recovery" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_restore_recovery"), {
  title: "Restore recovery snapshot",
  description: "Explicitly restore the latest or a numbered previous recovery snapshot as an unsaved draft. Requires the current document revision; saving remains explicit.",
  inputSchema: z.object({ candidate: z.enum(["latest", "backup"]), backupIndex: z.number().int().min(0).max(19).optional(), expectedDocumentRevision: z.number().int().nonnegative() }).strict().refine((value) => value.candidate === "backup" ? value.backupIndex !== undefined : value.backupIndex === undefined, "backupIndex must be supplied only for backup candidates."),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ candidate, backupIndex, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "restore_recovery", candidate, ...(backupIndex === undefined ? {} : { backupIndex }) }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_skeleton"), {
  title: "Inspect loaded skeleton",
  description: "Return loaded animation names, bone paths/parent hierarchy, constraints, lengths, and current activation state without screen-coordinate details.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    const snapshot = await sendCommand<{ animations: string[]; skeleton: { bones: Array<{ path: string; name: string; parentPath: string | null; length: number; rotation: number; active: boolean }>; constraints: unknown[] } | null }>({ name: "get_project" }, state.documentRevision);
    if (!snapshot.skeleton) throw new Error("The loaded Spine skeleton has not published a frame yet.");
    return result({ documentRevision: state.documentRevision, animations: snapshot.animations, ...snapshot.skeleton });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_behavior_runtime"), {
  title: "Inspect behavior runtime",
  description: "Read behavior machine states, action feedback, interaction preview diagnostics, and active interaction/Look-follow test flags from the latest Editor snapshot.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({ documentRevision: state.documentRevision, behaviorRuntime: state.behaviorRuntime ?? null });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_interactions"), {
  title: "Inspect interactions and Look-follow",
  description: "Return friendly interactions, regions, Look-follow settings, and current selection from the authored project without changing workspace or selection.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const document = await editorProjectDocument();
    return result({ documentRevision: document.documentRevision, interactions: document.project.interactions, lookFollow: document.project.lookFollow, selectedInteractionId: document.project.selectedInteractionId, selectedRegionId: document.project.selectedRegionId });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_behaviors"), {
  title: "Inspect behavior machines",
  description: "Return canonical behavior machines, editor-only graph layouts, and legacy-friendly interaction projections at one document revision.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const document = await editorProjectDocument();
    return result({ documentRevision: document.documentRevision, machines: document.project.behaviorMachines ?? [], graphLayouts: document.project.behaviorGraphLayouts, interactions: document.project.interactions, lookFollow: document.project.lookFollow });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_camera_tracks"), {
  title: "Inspect camera tracks",
  description: "Return camera tracks from all authored sequences without changing the active sequence or workspace.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const document = await editorProjectDocument();
    const sequences = document.project.sequences ?? {};
    const tracks = Object.entries(sequences).flatMap(([sequenceId, sequence]) => sequence.camera ? [{ sequenceId, camera: sequence.camera }] : []);
    if (document.project.timeline.camera && !tracks.some((item) => item.sequenceId === (document.project.timeline.sequenceId ?? "opening"))) {
      tracks.push({ sequenceId: document.project.timeline.sequenceId ?? "opening", camera: document.project.timeline.camera });
    }
    return result({ documentRevision: document.documentRevision, tracks });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_undo"), {
  title: "Undo project edit",
  description: "Undo the most recent authored project edit. Requires the reviewed document revision and adds the inverse to project history.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "undo" }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_redo"), {
  title: "Redo project edit",
  description: "Redo the most recently undone authored project edit. Requires the reviewed document revision.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "redo" }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

const interactionPatchSchema = z.object({
  name: z.string().optional(), color: z.string().optional(), enabled: z.boolean().optional(), trigger: z.enum(["press", "hold", "drag"]).optional(),
  startAnimation: z.string().optional(), followAnimation: z.string().optional(), endAnimation: z.string().optional(),
  faceStartAnimation: z.string().optional(), faceFollowAnimation: z.string().optional(), faceEndAnimation: z.string().optional(), followTargetBone: z.string().nullable().optional(),
  sensitivity: z.number().finite().min(0).max(2).optional(), limitX: z.number().finite().min(0).max(10_000).optional(), limitY: z.number().finite().min(0).max(10_000).optional(),
  smoothing: z.number().finite().min(0.1).max(60).optional(), returnDuration: z.number().finite().min(0.05).max(2).optional(), returnEasing: z.enum(["linear", "ease-out", "ease-in-out"]).optional(),
  startMixDuration: z.number().finite().min(0).max(2).optional(), followMixDuration: z.number().finite().min(0).max(2).optional(), releaseMixDuration: z.number().finite().min(0).max(2).optional(),
  allowX: z.boolean().optional(), allowY: z.boolean().optional(), rotationEnabled: z.boolean().optional(), rotationAxis: z.enum(["x", "y"]).optional(),
  rotationMin: z.number().finite().min(-180).max(0).optional(), rotationMax: z.number().finite().min(0).max(180).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one interaction field.");
const regionPatchSchema = z.object({
  name: z.string().optional(), enabled: z.boolean().optional(), shape: z.enum(["ellipse", "rectangle"]).optional(), anchorBone: z.string().nullable().optional(),
  offsetX: z.number().finite().min(-1_000_000).max(1_000_000).optional(), offsetY: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  radiusX: z.number().finite().min(0).max(1_000_000).optional(), radiusY: z.number().finite().min(0).max(1_000_000).optional(),
  rotation: z.number().finite().min(-360_000).max(360_000).optional(), placement: z.enum(["head-v1", "cheek-v1", "needs-head", "manual"]).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one region field.");
const lookFollowPatchSchema = z.object({
  enabled: z.boolean().optional(), targetBonePath: z.string().nullable().optional(), delay: z.number().finite().min(0).max(10).optional(),
  rangeX: z.number().finite().min(0).max(512).nullable().optional(), rangeY: z.number().finite().min(0).max(512).nullable().optional(),
  smoothing: z.number().finite().min(0.1).max(60).optional(), allowX: z.boolean().optional(), allowY: z.boolean().optional(),
  rotationEnabled: z.boolean().optional(), rotationAxis: z.enum(["x", "y"]).optional(), rotationMin: z.number().finite().min(-180).max(0).optional(), rotationMax: z.number().finite().min(0).max(180).optional(),
  startAnimation: z.string().optional(), faceStartAnimation: z.string().optional(), endAnimation: z.string().optional(), faceEndAnimation: z.string().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one Look-follow field.");
const timelineItemRefSchema = z.object({ kind: z.enum(["layer", "color-layer", "animation", "color", "cue", "audio"]), id: z.string().min(1) }).strict();
const reviewedChangeOperationSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("add_interaction") }).strict(),
  z.object({ name: z.literal("update_interaction"), interactionId: z.string().min(1), patch: interactionPatchSchema }).strict(),
  z.object({ name: z.literal("duplicate_interaction"), interactionId: z.string().min(1) }).strict(),
  z.object({ name: z.literal("delete_interaction"), interactionId: z.string().min(1) }).strict(),
  z.object({ name: z.literal("add_region"), interactionId: z.string().min(1), anchorBonePath: z.string().nullable().optional() }).strict(),
  z.object({ name: z.literal("update_region"), interactionId: z.string().min(1), regionId: z.string().min(1), patch: regionPatchSchema }).strict(),
  z.object({ name: z.literal("duplicate_region"), interactionId: z.string().min(1), regionId: z.string().min(1) }).strict(),
  z.object({ name: z.literal("delete_region"), interactionId: z.string().min(1), regionId: z.string().min(1) }).strict(),
  z.object({ name: z.literal("update_look_follow"), patch: lookFollowPatchSchema }).strict(),
  z.object({ name: z.literal("replace_behavior_machines"), machines: z.array(behaviorMachineSchema), graphLayouts: z.record(z.string(), behaviorGraphLayoutSchema).optional() }).strict(),
  z.object({ name: z.literal("create_talk_sequence") }).strict(),
  z.object({
    name: z.literal("migrate_legacy_composition"),
    schedule: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["opening", "idle", "initial-idle", "between-idle", "final-idle", "talk", "section", "gap"]),
      sequenceId: z.string().nullable(),
      start: z.number().finite().min(0).max(1_000_000),
      duration: z.number().finite().positive().max(1_000_000),
      sourceStart: z.number().finite().min(0).max(1_000_000),
    }).strict()).min(1).max(500),
    frameRate: z.number().finite().min(1).max(240),
    persistentTimeMapping: z.enum(["continuous-output", "original-authored-time"]),
    persistentBackgrounds: z.boolean().optional(),
  }).strict(),
  z.object({ name: z.literal("delete_sequence"), sequenceId: z.string().min(1) }).strict(),
  z.object({ name: z.literal("reorder_sequences"), sequenceIds: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ name: z.literal("replace_sequence"), sequenceId: z.string().min(1), sequence: editorTimelineSchema }).strict(),
  z.object({ name: z.literal("update_camera_track"), sequenceId: z.string().min(1), camera: cameraTrackSchema.nullable() }).strict(),
  z.object({ name: z.literal("update_project_settings"), patch: z.object({ name: z.string().min(1).optional(), entrySequence: z.string().min(1).nullable().optional(), talkMixDuration: z.number().finite().min(0).max(2).optional(), effectsStrength: z.number().finite().min(0).max(1).optional() }).strict() }).strict(),
]);

server.registerTool(trackToolName("editor_preview_change_set"), {
  title: "Review atomic project changes",
  description: "Validate 1–50 typed authored-document operations against a draft, then return a bounded before/after diff and warnings with a 60-second single-host/project/revision token. Supported operations are interaction/region edits, Look-follow, behavior replacement, project settings, sequence create/delete/reorder/replacement, and camera replacement. Audio, saves, runtime effects, and workspace changes are excluded.",
  inputSchema: z.object({ operations: z.array(reviewedChangeOperationSchema).min(1).max(50), expectedDocumentRevision: z.number().int().nonnegative() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ operations, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "preview_change_set", operations: operations as EditorMcpCommand[] }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_apply_change_set"), {
  title: "Apply reviewed project changes",
  description: "Apply a reviewed change-set token as one undoable project edit only if the same Editor host, asset set, and document revision are still active. Explicitly save afterward if desired.",
  inputSchema: z.object({ changeSetId: z.string().uuid(), expectedDocumentRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ changeSetId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "apply_change_set", changeSetId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_interaction"), {
  title: "Add interaction",
  description: "Create a friendly interaction with default animation phases and an initial region. The edit is undoable and stays in memory until explicitly saved.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_interaction" }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_interaction"), {
  title: "Update interaction",
  description: "Edit an interaction's identity, trigger, animation phases, bone following, movement, rotation, and mix/return settings by ID.",
  inputSchema: z.object({ interactionId: z.string().min(1), patch: interactionPatchSchema, expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_interaction", interactionId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_duplicate_interaction"), {
  title: "Duplicate interaction",
  description: "Duplicate an interaction and its regions with fresh IDs; select the copy. Compatible legacy behavior projections are synchronized by the Editor.",
  inputSchema: z.object({ interactionId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_interaction", interactionId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_interaction"), {
  title: "Delete interaction",
  description: "Delete one interaction and its regions by ID. Any compatibility-generated behavior is removed by the normal project synchronization rules.",
  inputSchema: z.object({ interactionId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ interactionId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_interaction", interactionId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_select_interaction"), {
  title: "Select interaction",
  description: "Select an interaction in the Editor without dirtying authored project data.",
  inputSchema: z.object({ interactionId: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId }) => {
  try { return result(await sendCommand({ name: "select_interaction", interactionId })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_region"), {
  title: "Add interaction region",
  description: "Add a hit region to an interaction, optionally anchored to a loaded bone path. Selects the new region.",
  inputSchema: z.object({ interactionId: z.string().min(1), anchorBonePath: z.string().nullable().optional(), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, anchorBonePath, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_region", interactionId, ...(anchorBonePath === undefined ? {} : { anchorBonePath }) }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_region"), {
  title: "Update interaction region",
  description: "Edit region shape, geometry, bone anchor, enabled state, and placement metadata by interaction and region IDs.",
  inputSchema: z.object({ interactionId: z.string().min(1), regionId: z.string().min(1), patch: regionPatchSchema, expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, regionId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_region", interactionId, regionId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_duplicate_region"), {
  title: "Duplicate interaction region",
  description: "Duplicate a region with a fresh ID and a small position offset; selects the copy.",
  inputSchema: z.object({ interactionId: z.string().min(1), regionId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, regionId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_region", interactionId, regionId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_region"), {
  title: "Delete interaction region",
  description: "Delete a hit region by ID. Compatibility-generated behavior references are synchronized by the Editor.",
  inputSchema: z.object({ interactionId: z.string().min(1), regionId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ interactionId, regionId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_region", interactionId, regionId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_select_region"), {
  title: "Select interaction region",
  description: "Select a region in the Editor without dirtying authored project data.",
  inputSchema: z.object({ interactionId: z.string().min(1), regionId: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, regionId }) => {
  try { return result(await sendCommand({ name: "select_region", interactionId, regionId })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_look_follow"), {
  title: "Update Look-follow settings",
  description: "Edit Look-follow enablement, target bone, axes, ranges, local rotation limits, smoothing, delay, and phase animations. Authored behavior settings remain canonical and synchronized.",
  inputSchema: z.object({ patch: lookFollowPatchSchema, expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_look_follow", patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_preview_interaction_phase"), {
  title: "Preview interaction phase",
  description: "Preview the selected interaction's start, follow, or end animation pair through the Editor renderer without changing authored data.",
  inputSchema: z.object({ interactionId: z.string().min(1), phase: z.enum(["start", "follow", "end"]) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, phase }) => {
  try { return result(await sendCommand({ name: "preview_interaction_phase", interactionId, phase })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_start_interaction_test"), {
  title: "Start interaction test",
  description: "Start the Editor's real interaction preview for an interaction and optional enabled region. Coordinates for subsequent moves are Spine world-space units; no project files are changed.",
  inputSchema: z.object({ interactionId: z.string().min(1), regionId: z.string().min(1).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ interactionId, regionId }) => {
  try { return result(await sendCommand({ name: "start_interaction_test", interactionId, ...(regionId ? { regionId } : {}) })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_move_interaction_test"), {
  title: "Move interaction test pointer",
  description: "Move the active interaction test pointer to explicit Spine world-space coordinates.",
  inputSchema: z.object({ worldX: z.number().finite().min(-1_000_000).max(1_000_000), worldY: z.number().finite().min(-1_000_000).max(1_000_000) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ worldX, worldY }) => {
  try { return result(await sendCommand({ name: "move_interaction_test", worldX, worldY })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_release_interaction_test"), {
  title: "Release interaction test",
  description: "Release the active interaction preview pointer through the same runtime path as the UI.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "release_interaction_test" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_cancel_interaction_test"), {
  title: "Cancel interaction test",
  description: "Cancel and reset the active interaction preview test without changing project data.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "cancel_interaction_test" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_test_look_follow"), {
  title: "Test Look-follow",
  description: "Start or stop the Editor's real Look-follow pointer test. Requires the Look-follow setting and a loaded skeleton for start.",
  inputSchema: z.object({ enabled: z.boolean() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ enabled }) => {
  try { return result(await sendCommand({ name: "test_look_follow", enabled })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_inject_behavior_event"), {
  title: "Inject behavior event",
  description: "Inject a supported event into an authored behavior machine through the Editor runtime test harness. Optionally specify an activation region.",
  inputSchema: z.object({ machineId: z.string().min(1), event: z.enum(["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"]), regionId: z.string().min(1).nullable().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ machineId, event, regionId }) => {
  try { return result(await sendCommand({ name: "inject_behavior_event", machineId, event, ...(regionId === undefined ? {} : { regionId }) })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_cancel_behavior_test"), {
  title: "Cancel behavior test",
  description: "Cancel the active behavior-runtime test and restore the Editor's runtime test state.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "cancel_behavior_test" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_replace_behavior_machines"), {
  title: "Replace behavior machines",
  description: "Replace the complete canonical behavior-machine collection and optionally its graph layout map as one undoable edit. Read editor_get_behaviors first; submit complete typed machine/state/action/transition data and the reviewed document revision. Friendly compatibility projections are synchronized by the Editor.",
  inputSchema: z.object({ machines: z.array(behaviorMachineSchema), graphLayouts: z.record(z.string(), behaviorGraphLayoutSchema).optional(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ machines, graphLayouts, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "replace_behavior_machines", machines, ...(graphLayouts ? { graphLayouts } : {}) }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_project_settings"), {
  title: "Update project settings",
  description: "Edit project name, entry sequence, Talk mix duration, and effects strength as one undoable patch.",
  inputSchema: z.object({ patch: z.object({ name: z.string().min(1).optional(), entrySequence: z.string().min(1).nullable().optional(), talkMixDuration: z.number().finite().min(0).max(2).optional(), effectsStrength: z.number().finite().min(0).max(1).optional() }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one project setting."), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_project_settings", patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_create_talk_sequence"), {
  title: "Create Talk sequence",
  description: "Create the next non-recycled Talk sequence ID, initialize its timeline from available animations/layers, and select it without changing the active workspace.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "create_talk_sequence" }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_migrate_legacy_composition"), {
  title: "Preview legacy timeline migration",
  description: "Preview an explicit conversion of legacy Opening/Talk sequences into a versioned unified composition. Supply the full output schedule and persistent-background time mapping. The returned assumptions, diagnostics, and before/after diff are not applied until editor_apply_change_set is called; legacy sequences remain preserved.",
  inputSchema: z.object({
    schedule: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["opening", "idle", "initial-idle", "between-idle", "final-idle", "talk", "section", "gap"]),
      sequenceId: z.string().nullable(),
      start: z.number().finite().min(0).max(1_000_000),
      duration: z.number().finite().positive().max(1_000_000),
      sourceStart: z.number().finite().min(0).max(1_000_000),
    }).strict()).min(1).max(500),
    frameRate: z.number().finite().min(1).max(240),
    persistentTimeMapping: z.enum(["continuous-output", "original-authored-time"]),
    persistentBackgrounds: z.boolean().optional(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ schedule, frameRate, persistentTimeMapping, persistentBackgrounds, expectedDocumentRevision, idempotencyKey }) => {
  try {
    return result(await sendCommand({
      name: "preview_change_set",
      operations: [{ name: "migrate_legacy_composition", schedule, frameRate, persistentTimeMapping, ...(persistentBackgrounds === undefined ? {} : { persistentBackgrounds }) }],
    }, expectedDocumentRevision, idempotencyKey));
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_sequence"), {
  title: "Delete timeline sequence",
  description: "Delete a non-Opening sequence by ID. The Editor retains the deletion tombstone, repairs entry-sequence references, and selects a valid fallback if needed.",
  inputSchema: z.object({ sequenceId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ sequenceId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_sequence", sequenceId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_reorder_sequences"), {
  title: "Reorder timeline sequences",
  description: "Set the complete available sequence order. Opening must remain first; every other sequence must appear exactly once.",
  inputSchema: z.object({ sequenceIds: z.array(z.string().min(1)).min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceIds, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "reorder_sequences", sequenceIds }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_replace_sequence"), {
  title: "Replace authored sequence data",
  description: "Replace one existing sequence's full authored timeline by ID, including Spine/color layers and clips, subtitles, audio links, and camera data. Read editor_get_sequence or editor_get_project_document first; all audio paths must be relative to the asset root. The replacement is one undoable edit and does not change workspace.",
  inputSchema: z.object({ sequenceId: z.string().min(1), sequence: editorTimelineSchema, expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, sequence, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "replace_sequence", sequenceId, sequence }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_camera_track"), {
  title: "Update sequence camera track",
  description: "Replace or clear a sequence's complete camera track by sequence ID, including aspect ratio, constraints, safe bounds, and keyframes. This is one undoable edit and works independently of the active workspace.",
  inputSchema: z.object({ sequenceId: z.string().min(1), camera: cameraTrackSchema.nullable(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, camera, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_camera_track", sequenceId, camera }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_evaluate_camera_track"), {
  title: "Evaluate camera output",
  description: "Evaluate the active sequence's authored camera at an explicit time using the same camera solver as the Editor preview. Requires that sequence to be active in the Camera workspace; does not change authored data.",
  inputSchema: z.object({ sequenceId: z.string().min(1), seconds: z.number().finite().min(0).max(1_000_000) }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ sequenceId, seconds }) => {
  try { return result(await sendCommand({ name: "evaluate_camera_track", sequenceId, seconds })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_frame_camera_item"), {
  title: "Frame camera shot or bound",
  description: "Temporarily pan/zoom the Camera workspace to an explicit camera-shot or safe-bound ID and select it without changing authored project data.",
  inputSchema: z.object({ kind: z.enum(["shot", "bound"]), id: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ kind, id }) => {
  try { return result(await sendCommand({ name: "frame_camera_item", kind, id })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_audio_clip"), {
  title: "Add audio clip",
  description: "Add a root-relative existing audio file to any authored sequence by ID with explicit timing and volume. The Editor verifies the asset exists, and a valid optional subtitle link is made one-to-one.",
  inputSchema: z.object({ sequenceId: z.string().min(1), audio: audioClipSchema, expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, audio, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_audio_clip", sequenceId, audio }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_duplicate_audio_clip"), {
  title: "Duplicate audio clip",
  description: "Duplicate an audio clip in its sequence immediately after the source, preserving source, volume, enabled state, and endpoint policy while clearing subtitle linkage to preserve one-to-one links.",
  inputSchema: z.object({ sequenceId: z.string().min(1), audioId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, audioId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_audio_clip", sequenceId, audioId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_list_audio_assets"), {
  title: "Search audio assets",
  description: "Search and page through supported audio files under the current asset root. Symlinks, ignored paths, and files outside the root are excluded; the scan is capped at 10,000 assets.",
  inputSchema: z.object({ query: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ query, offset = 0, limit = 50 }) => {
  try {
    const catalog = await sendCommand<{ assets: Array<{ path: string; sizeBytes: number; modifiedAt: string }>; truncated: boolean }>({ name: "list_audio_assets" });
    const normalized = query?.trim().toLocaleLowerCase() ?? "";
    const matches = catalog.assets.filter((asset) => !normalized || asset.path.toLocaleLowerCase().includes(normalized));
    return result({ offset, limit, total: matches.length, truncated: catalog.truncated, assets: matches.slice(offset, offset + limit) });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_audio_clip"), {
  title: "Update audio clip",
  description: "Edit an audio clip's root-relative source path, name, timing, enabled state, volume, or automatic-end policy by sequence and clip IDs.",
  inputSchema: z.object({ sequenceId: z.string().min(1), audioId: z.string().min(1), patch: audioPatchSchema, expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, audioId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_audio_clip", sequenceId, audioId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_audio_clip"), {
  title: "Delete audio clip",
  description: "Delete an audio clip by sequence and clip IDs without changing subtitle cues.",
  inputSchema: z.object({ sequenceId: z.string().min(1), audioId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ sequenceId, audioId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_audio_clip", sequenceId, audioId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_link_audio_subtitle"), {
  title: "Link audio to subtitle",
  description: "Set or clear an explicit audio/subtitle link in one sequence. The Editor enforces one-to-one cue links and null disables legacy line-ID inference.",
  inputSchema: z.object({ sequenceId: z.string().min(1), audioId: z.string().min(1), subtitleId: z.string().min(1).nullable(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, audioId, subtitleId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "link_audio_subtitle", sequenceId, audioId, subtitleId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_match_audio_length"), {
  title: "Match audio clip length",
  description: "Fit an audio clip and its linked subtitle to the decoded source duration. Requires the clip's sequence to be mounted in Timeline/Camera so the Editor has decoded audio metadata.",
  inputSchema: z.object({ audioId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ audioId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "match_audio_length", audioId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_preview_audio_clip"), {
  title: "Preview audio clip",
  description: "Seek to and play one audio clip until its authored end. Requires its sequence to be active in the mounted timeline; this changes playback only.",
  inputSchema: z.object({ audioId: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ audioId }) => {
  try { return result(await sendCommand({ name: "preview_audio_clip", audioId })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_stop_audio_preview"), {
  title: "Stop audio preview",
  description: "Stop timeline playback and pause all mounted audio elements without changing authored project data.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "stop_audio_preview" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_list_assets"), {
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

server.registerTool(trackToolName("editor_get_sequence"), {
  title: "Inspect active timeline sequence",
  description: "Return full sequence settings, animation clips, all subtitle translations, audio links, color layers, and camera data. Optionally select a sequence ID; reads do not change the active sequence or workspace.",
  inputSchema: z.object({ sequenceId: z.string().min(1).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ sequenceId }) => {
  try {
    const state = await editorState();
    const document = await sendCommand<{ project: import("@ba-spine/editor-feature/editorModel").EditorProject }>({ name: "get_project" }, state.documentRevision);
    const activeId = document.project.timeline.sequenceId ?? "legacy";
    const id = sequenceId ?? activeId;
    const sequence = id === activeId ? document.project.timeline : document.project.sequences?.[id];
    if (!sequence) throw new Error(`Sequence data is not authored or available: ${id}`);
    return result({ documentRevision: state.documentRevision, sequenceId: id, sequence, animationInfo: state.timeline?.animationInfo ?? [], decodedAudioInfo: id === activeId ? state.timeline?.audio ?? [] : [], availableSequences: state.timeline?.availableSequences ?? Object.keys(document.project.sequences ?? {}).map((availableId) => ({ id: availableId, name: availableId })) });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_list_sequences"), {
  title: "List authored sequences",
  description: "List and page through all authored sequences, their duration and content counts, plus active-sequence identity. Works outside the Timeline workspace.",
  inputSchema: z.object({ query: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ query, offset = 0, limit = 50 }) => {
  try {
    const document = await editorProjectDocument();
    const activeId = document.project.timeline.sequenceId ?? "legacy";
    const byId = new Map(Object.entries(document.project.sequences ?? {}).map(([id, sequence]) => [id, sequence]));
    byId.set(activeId, document.project.timeline);
    const normalized = query?.trim().toLocaleLowerCase() ?? "";
    const all = [...byId.entries()].filter(([id]) => !normalized || id.toLocaleLowerCase().includes(normalized)).sort(([left], [right]) => left === "opening" ? -1 : right === "opening" ? 1 : left.localeCompare(right, undefined, { numeric: true }));
    return result({ documentRevision: document.documentRevision, activeSequenceId: activeId, offset, limit, total: all.length, sequences: all.slice(offset, offset + limit).map(([id, sequence]) => ({ id, name: id === "opening" ? "Opening" : id.replace(/^talk-(\d+)$/i, "Talk $1"), duration: sequence.duration, durationMode: sequence.durationMode ?? "manual", layerCount: sequence.layers.length, colorLayerCount: sequence.colorLayers.length, subtitleCount: sequence.subtitles.length, audioClipCount: sequence.audio.length, hasCamera: Boolean(sequence.camera) })) });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_get_animation_info"), {
  title: "Inspect Spine animation metadata",
  description: "List animation names and decoded durations for every loaded Spine layer in the active sequence. A null duration means the layer has not reported that animation's duration yet.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const state = await editorState();
    return result({ documentRevision: state.documentRevision, animationInfo: state.timeline?.animationInfo ?? [], availableSequences: state.timeline?.availableSequences ?? [] });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_analyze_timing"), {
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

server.registerTool(trackToolName("editor_validate"), {
  title: "Validate project or active sequence",
  description: "Report bounded active-sequence timing/subtitle findings or whole-project references covering sequences, layers, interactions, behavior graphs, cameras, subtitles, audio links, and root-contained audio assets. Does not edit files.",
  inputSchema: z.object({ scope: z.enum(["active-sequence", "project"]).optional() }).strict(),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ scope = "active-sequence" }) => {
  try {
    const state = await editorState();
    if (scope === "project") return result(await sendCommand({ name: "validate_project" }, state.documentRevision));
    const findings = validateActiveSequence(state);
    return result({ scope, documentRevision: state.documentRevision, asset: state.directory, sequenceId: state.timeline?.sequenceId ?? null, count: findings.length, findings });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_start_waveform_profile"), {
  title: "Start Editor waveform profile",
  description: "Start bounded in-memory waveform stage, animation-frame, and long-task diagnostics. Available only in a development Editor explicitly built with --profile-waveforms. No project files are written and measurements stay on the authenticated loopback MCP state.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "start_waveform_profile" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_stop_waveform_profile"), {
  title: "Stop Editor waveform profile",
  description: "Stop the active in-memory waveform profile and return its current measurements through Editor MCP state. Does not save project files.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async () => {
  try { return result(await sendCommand({ name: "stop_waveform_profile" })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_open_asset_root"), {
  title: "Open asset root",
  description: "Load a local Spine asset root by its absolute path. Refuses to switch away from an unsaved project. Does not write to the root.",
  inputSchema: z.object({ rootPath: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ rootPath, expectedDocumentRevision }) => {
  try {
    await sendCommand({ name: "open_asset_root", rootPath }, expectedDocumentRevision);
    const wanted = rootPath.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
    const state = await waitForState((value) => value.assetRoot?.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase() === wanted && !value.assetLoading, "asset root loading");
    return result(state);
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_select_asset_set"), {
  title: "Select asset set",
  description: "Switch to a Spine set in the currently loaded root and wait for its Editor project to initialize. Restores the active workspace; refuses if the current project has unsaved changes.",
  inputSchema: z.object({ directory: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ directory, expectedDocumentRevision }) => {
  try {
    const previousWorkspace = (await editorState()).workspace;
    await sendCommand({ name: "select_asset_set", directory }, expectedDocumentRevision);
    return result(await waitForState((state) => state.directory === directory
      && state.projectName !== null
      && !state.assetLoading
      && (previousWorkspace !== "timeline" || state.timeline !== null), `asset set ${directory} loading`));
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_open_project_file"), {
  title: "Open project file",
  description: "Open a compatible project JSON file using a root-relative path inside the current asset root. Refuses when the project is dirty, saving, errored, or has unresolved recovery data; it never discards unsaved work implicitly.",
  inputSchema: z.object({ path: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ path, expectedDocumentRevision }) => {
  try {
    const opened = await sendCommand<{ directory: string; projectName: string }>({ name: "open_project_file", path }, expectedDocumentRevision);
    const state = await waitForState((value) => !value.assetLoading && value.directory === opened.directory, `project ${opened.directory} loading`);
    const document = await editorProjectDocument();
    return result({ ...state, projectName: document.project.name, openedPath: path });
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_set_workspace"), {
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

server.registerTool(trackToolName("editor_select_sequence"), {
  title: "Select timeline sequence",
  description: "Select an available sequence in the timeline. This changes the active sequence in editor memory but does not save files.",
  inputSchema: z.object({ sequenceId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "select_sequence", sequenceId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_seek"), {
  title: "Seek timeline",
  description: "Pause and seek the timeline playhead to an absolute time in seconds. Values are clamped to the active sequence duration.",
  inputSchema: z.object({ seconds: z.number().finite().min(0) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ seconds }) => {
  try { return result(await sendCommand({ name: "seek", seconds })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_set_playback"), {
  title: "Control playback",
  description: "Start or pause timeline playback without changing saved project files.",
  inputSchema: z.object({ playing: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ playing }) => {
  try { return result(await sendCommand({ name: "set_playback", playing })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_set_preview_view"), {
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

server.registerTool(trackToolName("editor_zoom_preview"), {
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

server.registerTool(trackToolName("editor_pan_preview"), {
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

server.registerTool(trackToolName("editor_reset_preview"), {
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

server.registerTool(trackToolName("editor_select_visual_layer"), {
  title: "Select visual layer or clip",
  description: "Select a Spine layer, color layer, or color clip by its id so its inspector and rendered preview can be examined.",
  inputSchema: z.object({ kind: z.enum(["spine-layer", "color-layer", "color-clip"]), id: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ kind, id }) => {
  try { return result(await sendCommand({ name: "select_visual", kind, id })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_spine_layer"), {
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

server.registerTool(trackToolName("editor_create_spine_layer"), {
  title: "Add Spine layer",
  description: "Add a discovered Spine asset set as a new visual layer in the active sequence. Layer creation is based on the existing sequence role/order rules.",
  inputSchema: z.object({ directory: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ directory, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "create_spine_layer", directory }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_spine_layer"), {
  title: "Delete Spine layer",
  description: "Delete a non-character, unlocked Spine layer by ID from the active sequence.",
  inputSchema: z.object({ layerId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ layerId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_spine_layer", layerId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_animation_clip"), {
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
    idempotencyKey: z.string().min(1).max(128).optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, animation, start, end, loop, faceAnimation, continueAfterOpening, expectedDocumentRevision, idempotencyKey }) => {
  try {
    return result(await sendCommand({ name: "add_animation_clip", layerId, animation, start, ...(end === undefined ? {} : { end }), ...(loop === undefined ? {} : { loop }), ...(faceAnimation === undefined ? {} : { faceAnimation }), ...(continueAfterOpening === undefined ? {} : { continueAfterOpening }) }, expectedDocumentRevision, idempotencyKey));
  } catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_animation_clip"), {
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

server.registerTool(trackToolName("editor_duplicate_animation_clip"), {
  title: "Duplicate animation clip",
  description: "Duplicate an unlocked animation clip using the timeline's ripple insertion rules and select the new clip.",
  inputSchema: z.object({ clipId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_animation_clip", clipId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_move_animation_clip"), {
  title: "Move animation clip",
  description: "Move one clip to an absolute start time. Choose ripple true to shift following clips or false to preserve their positions.",
  inputSchema: z.object({ clipId: z.string().min(1), start: z.number().finite().min(0), ripple: z.boolean(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, start, ripple, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "move_animation_clip", clipId, start, ripple }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_animation_clip"), {
  title: "Delete animation clip",
  description: "Delete one clip. Choose ripple true to close the gap and shift later clips, or false to leave the gap.",
  inputSchema: z.object({ clipId: z.string().min(1), ripple: z.boolean(), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ clipId, ripple, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_animation_clip", clipId, ripple }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_subtitle_cue"), {
  title: "Add translated subtitle cue",
  description: "Add one subtitle cue with explicit timing and any available en/ja/ko translations. Missing language text remains blank; MCP does not generate translations.",
  inputSchema: z.object({ start: z.number().finite().min(0), end: z.number().finite().min(0), text: z.object({ en: z.string().optional(), ja: z.string().optional(), ko: z.string().optional() }).strict(), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ start, end, text, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_subtitle_cue", start, end, text }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_subtitle_cue"), {
  title: "Update subtitle cue",
  description: "Update cue timing, enabled state, or selected language text without changing audio clips or explicit audio/subtitle links.",
  inputSchema: z.object({ cueId: z.string().min(1), patch: z.object({ start: z.number().finite().min(0).optional(), end: z.number().finite().min(0).optional(), enabled: z.boolean().optional(), text: z.object({ en: z.string().optional(), ja: z.string().optional(), ko: z.string().optional() }).strict().optional() }).strict().refine((patch) => Object.keys(patch).length > 0, "Set at least one cue field."), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ cueId, patch, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "update_subtitle_cue", cueId, patch }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_subtitle_cue"), {
  title: "Delete subtitle cue",
  description: "Delete one subtitle cue while preserving audio clips; explicit links to the removed cue are cleared by the Editor.",
  inputSchema: z.object({ cueId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ cueId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_subtitle_cue", cueId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_duplicate_subtitle_cue"), {
  title: "Duplicate subtitle cue",
  description: "Duplicate a subtitle cue immediately after its current end with all language text copied, then select the copy.",
  inputSchema: z.object({ cueId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ cueId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_subtitle_cue", cueId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_select_subtitle_cue"), {
  title: "Select subtitle cue",
  description: "Select and focus one cue by ID without dirtying project data.",
  inputSchema: z.object({ cueId: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ cueId }) => {
  try { return result(await sendCommand({ name: "select_subtitle_cue", cueId })); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_split_subtitle_cue"), {
  title: "Split subtitle cue",
  description: "Split one subtitle cue at a strict interior time into two cues with the same translations. Audio links remain attached to the original cue.",
  inputSchema: z.object({ cueId: z.string().min(1), at: z.number().finite().min(0), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ cueId, at, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "split_subtitle_cue", cueId, at }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_preview_subtitle_import"), {
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

server.registerTool(trackToolName("editor_apply_subtitle_import"), {
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

server.registerTool(trackToolName("editor_reorder_visual_layer"), {
  title: "Reorder visual layer",
  description: "Move a Spine or color visual layer to the position of another visual layer. Locked layers are respected.",
  inputSchema: z.object({ layerId: z.string().min(1), targetLayerId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, targetLayerId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "reorder_visual_layer", layerId, targetLayerId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_color_layer"), {
  title: "Add color layer",
  description: "Add a new editable color layer to the opening sequence. This changes editor memory only until saved.",
  inputSchema: z.object({ name: z.string().optional(), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ name, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_color_layer", ...(name ? { nameHint: name } : {}) }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_add_color_clip"), {
  title: "Add color clip",
  description: "Add a color clip preset at the playhead, optionally on a specified unlocked color layer.",
  inputSchema: z.object({
    preset: z.enum(["solid", "fade-from-black", "fade-to-black", "white-flash"]).optional(),
    layerId: z.string().optional(),
    expectedDocumentRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ preset, layerId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "add_color_clip", ...(preset ? { preset } : {}), ...(layerId ? { layerId } : {}) }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_update_color_layer"), {
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

server.registerTool(trackToolName("editor_update_color_clip"), {
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

server.registerTool(trackToolName("editor_duplicate_color_clip"), {
  title: "Duplicate color clip",
  description: "Duplicate an unlocked color clip using existing timeline placement rules and select the copy.",
  inputSchema: z.object({ clipId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "duplicate_color_clip", clipId }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_color_clip"), {
  title: "Delete color clip",
  description: "Delete one color clip by ID from its unlocked color layer.",
  inputSchema: z.object({ clipId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ clipId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_color_clip", clipId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_color_layer"), {
  title: "Delete color layer",
  description: "Delete an unlocked color layer and its clips by layer ID.",
  inputSchema: z.object({ layerId: z.string().min(1), expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ layerId, expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "delete_color_layer", layerId }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_set_timeline_items_enabled"), {
  title: "Bulk enable or disable timeline items",
  description: "Enable or disable up to 100 explicit layer, clip, cue, or audio IDs in the active sequence. Locked visual layers/clips are left unchanged; edits work regardless of workspace and are undoable.",
  inputSchema: z.object({ items: z.array(timelineItemRefSchema).min(1).max(100), enabled: z.boolean(), expectedDocumentRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ items, enabled, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "set_timeline_items_enabled", items, enabled }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_delete_timeline_items"), {
  title: "Bulk delete timeline items",
  description: "Delete up to 100 explicit IDs in the active sequence. The character layer and locked visual items are protected; animation clips ripple by their authored lengths, and deleting a cue clears explicit audio links. Edits work regardless of workspace and are undoable.",
  inputSchema: z.object({ items: z.array(timelineItemRefSchema).min(1).max(100), expectedDocumentRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128).optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ items, expectedDocumentRevision, idempotencyKey }) => {
  try { return result(await sendCommand({ name: "delete_timeline_items", items }, expectedDocumentRevision, idempotencyKey)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_save"), {
  title: "Save editor project",
  description: "Explicitly save the current project and linked subtitle files. Refuses external file conflicts and verifies each written file. Inspect editor_state first and optionally pass its documentRevision to avoid saving a newer draft than reviewed.",
  inputSchema: z.object({ expectedDocumentRevision: z.number().int().nonnegative().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ expectedDocumentRevision }) => {
  try { return result(await sendCommand({ name: "save" }, expectedDocumentRevision)); }
  catch (value) { return failed(value); }
});

server.registerTool(trackToolName("editor_capture_preview"), {
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
