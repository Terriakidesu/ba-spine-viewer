export const HANDOFF_PROTOCOL_VERSION = 1 as const;

export type HandoffTargetApp = "viewer" | "editor";

export interface SpineHandoffMessage {
  protocolVersion: typeof HANDOFF_PROTOCOL_VERSION;
  requestId: string;
  targetApp: HandoffTargetApp;
  library: {
    identity: string;
    path: string;
  };
  lobbyId: string;
  sequenceId?: string;
  language?: string;
  playheadSeconds?: number;
  draft?: {
    sessionId: string;
  };
}

export class HandoffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffValidationError";
  }
}

/** Stable opaque ID for a library path without putting long paths in the ID field. */
export async function libraryIdentityForPath(path: string): Promise<string> {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HandoffValidationError(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new HandoffValidationError(`${label} has an unsupported field: ${unexpected}.`);
}

function text(value: unknown, label: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HandoffValidationError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  if (pattern && !pattern.test(value)) throw new HandoffValidationError(`${label} has an invalid format.`);
  return value;
}

function absoluteLibraryPath(value: unknown): string {
  const path = text(value, "library.path", 32_768);
  if (!(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/.test(path))) {
    throw new HandoffValidationError("library.path must be an absolute filesystem path.");
  }
  return path;
}

function projectId(value: unknown, label: string): string {
  const id = text(value, label, 128, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (id === "." || id === "..") throw new HandoffValidationError(`${label} is invalid.`);
  return id;
}

/** Parse and strictly validate a local Viewer/Editor handoff payload. */
export function parseHandoffMessage(value: unknown): SpineHandoffMessage {
  const input = record(value, "Handoff message");
  exactKeys(input, [
    "protocolVersion", "requestId", "targetApp", "library", "lobbyId", "sequenceId", "language", "playheadSeconds", "draft",
  ], "Handoff message");

  if (input.protocolVersion !== HANDOFF_PROTOCOL_VERSION) {
    throw new HandoffValidationError(`Unsupported handoff protocol version: ${String(input.protocolVersion)}.`);
  }
  const requestId = text(input.requestId, "requestId", 128, /^[A-Za-z0-9_-]{8,128}$/);
  if (input.targetApp !== "viewer" && input.targetApp !== "editor") {
    throw new HandoffValidationError("targetApp must be viewer or editor.");
  }

  const rawLibrary = record(input.library, "library");
  exactKeys(rawLibrary, ["identity", "path"], "library");
  const library = {
    identity: text(rawLibrary.identity, "library.identity", 256),
    path: absoluteLibraryPath(rawLibrary.path),
  };
  const lobbyId = projectId(input.lobbyId, "lobbyId");
  const sequenceId = input.sequenceId === undefined ? undefined : projectId(input.sequenceId, "sequenceId");
  const language = input.language === undefined
    ? undefined
    : text(input.language, "language", 35, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

  let playheadSeconds: number | undefined;
  if (input.playheadSeconds !== undefined) {
    if (typeof input.playheadSeconds !== "number" || !Number.isFinite(input.playheadSeconds) || input.playheadSeconds < 0 || input.playheadSeconds > 604_800) {
      throw new HandoffValidationError("playheadSeconds must be a finite value between 0 and 604800.");
    }
    playheadSeconds = input.playheadSeconds;
  }

  let draft: SpineHandoffMessage["draft"];
  if (input.draft !== undefined) {
    const rawDraft = record(input.draft, "draft");
    exactKeys(rawDraft, ["sessionId"], "draft");
    draft = { sessionId: text(rawDraft.sessionId, "draft.sessionId", 128, /^[A-Za-z0-9_-]{8,128}$/) };
  }

  return {
    protocolVersion: HANDOFF_PROTOCOL_VERSION,
    requestId,
    targetApp: input.targetApp,
    library,
    lobbyId,
    ...(sequenceId ? { sequenceId } : {}),
    ...(language ? { language } : {}),
    ...(playheadSeconds !== undefined ? { playheadSeconds } : {}),
    ...(draft ? { draft } : {}),
  };
}
