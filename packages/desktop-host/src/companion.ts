import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHandoffMessage, type HandoffTargetApp, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";

export const COMPANION_HANDOFF_PATH = "/__spine/companion/handoff";
export const COMPANION_HEALTH_PATH = "/__spine/companion/health";
const COMPANION_PROTOCOL_VERSION = 1;
const DEFAULT_REGISTRY_DIRECTORY = join(tmpdir(), "ba-spine-suite-companions");
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_PENDING_MESSAGES = 32;
const MAX_SEEN_REQUEST_IDS = 256;

interface CompanionEndpointRecord {
  protocolVersion: number;
  app: HandoffTargetApp;
  port: number;
  token: string;
  pid: number;
}

export class CompanionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionUnavailableError";
  }
}

function tokenValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Fa-f0-9-]{32,128}$/.test(value);
}

function randomToken(): string {
  return `${randomUUID()}${randomUUID()}`;
}

function endpointPath(directory: string, app: HandoffTargetApp): string {
  return join(directory, `${app}.json`);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function sameToken(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authorizationToken(request: Request): string | null {
  const match = /^Bearer ([A-Fa-f0-9-]{32,128})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

async function readBoundedBody(request: Request): Promise<{ text: string; tooLarge: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MESSAGE_BYTES) {
        await reader.cancel();
        return { text: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), tooLarge: false };
}

function parseEndpoint(value: unknown, expectedApp: HandoffTargetApp): CompanionEndpointRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanionUnavailableError("Companion registration is invalid.");
  const raw = value as Partial<CompanionEndpointRecord>;
  if (raw.protocolVersion !== COMPANION_PROTOCOL_VERSION
    || raw.app !== expectedApp
    || !Number.isInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65_535
    || !tokenValue(raw.token)
    || !Number.isInteger(raw.pid) || Number(raw.pid) < 1) {
    throw new CompanionUnavailableError("Companion registration is invalid or uses an unsupported version.");
  }
  return raw as CompanionEndpointRecord;
}

function descriptorIsLive(record: CompanionEndpointRecord, directory: string): boolean {
  try {
    const current = JSON.parse(readFileSync(endpointPath(directory, record.app), "utf8")) as Partial<CompanionEndpointRecord>;
    return current.protocolVersion === record.protocolVersion && current.pid === record.pid && current.token === record.token;
  } catch {
    return false;
  }
}

export interface CompanionRegistration {
  readonly token: string;
  close(): void;
}

/** Publish one app's loopback endpoint for the current process session. */
export async function registerCompanionEndpoint(
  app: HandoffTargetApp,
  port: number,
  options: { directory?: string; token?: string } = {},
): Promise<CompanionRegistration> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Companion port must be a valid TCP port.");
  const directory = options.directory ?? DEFAULT_REGISTRY_DIRECTORY;
  const token = options.token ?? randomToken();
  if (!tokenValue(token)) throw new Error("Companion session token has an invalid format.");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const destination = endpointPath(directory, app);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const record: CompanionEndpointRecord = { protocolVersion: COMPANION_PROTOCOL_VERSION, app, port, token, pid: process.pid };
  try {
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return {
    token,
    close() {
      if (!descriptorIsLive(record, directory)) return;
      try { unlinkSync(destination); }
      catch { /* A missing descriptor is already clean. */ }
    },
  };
}

/** Authenticated inbox for one target app. Request IDs are deduplicated per session. */
export class CompanionInbox {
  readonly token: string;
  private readonly messages: SpineHandoffMessage[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly app: HandoffTargetApp, token = randomToken()) {
    if (!tokenValue(token)) throw new Error("Companion session token has an invalid format.");
    this.token = token;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === COMPANION_HEALTH_PATH && request.method === "GET") {
      if (!sameToken(authorizationToken(request), this.token)) return json({ error: "Unauthorized companion request." }, 403);
      return json({ protocolVersion: COMPANION_PROTOCOL_VERSION, app: this.app, pid: process.pid });
    }
    if (url.pathname !== COMPANION_HANDOFF_PATH || request.method !== "POST") return json({ error: "Unknown companion endpoint." }, 404);
    if (!sameToken(authorizationToken(request), this.token)) return json({ error: "Unauthorized companion request." }, 403);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_MESSAGE_BYTES) return json({ error: "Handoff message exceeds the size limit." }, 413);
    let raw: string;
    try {
      const body = await readBoundedBody(request);
      if (body.tooLarge) return json({ error: "Handoff message exceeds the size limit." }, 413);
      raw = body.text;
    } catch {
      return json({ error: "Handoff message must be valid UTF-8." }, 400);
    }

    let message: SpineHandoffMessage;
    try {
      message = parseHandoffMessage(JSON.parse(raw) as unknown);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid handoff message." }, 400);
    }
    if (message.targetApp !== this.app) return json({ error: `This handoff targets ${message.targetApp}, not ${this.app}.` }, 409);
    if (this.seen.has(message.requestId)) return json({ ok: true, duplicate: true, requestId: message.requestId }, 202);
    if (this.messages.length >= MAX_PENDING_MESSAGES) return json({ error: "The companion inbox is full; retry after the app processes pending requests." }, 429);

    this.seen.add(message.requestId);
    this.messages.push(message);
    if (this.seen.size > MAX_SEEN_REQUEST_IDS) this.seen.delete(this.seen.values().next().value!);
    return json({ ok: true, requestId: message.requestId }, 202);
  }

  pending(): SpineHandoffMessage[] {
    return [...this.messages];
  }

  acknowledge(requestIds: readonly string[]): number {
    const acknowledged = new Set(requestIds);
    const before = this.messages.length;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (acknowledged.has(this.messages[index]!.requestId)) this.messages.splice(index, 1);
    }
    return before - this.messages.length;
  }
}

/** Send only to the fixed loopback address recorded for the target app. */
export async function sendCompanionHandoff(
  value: unknown,
  options: { directory?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const message = parseHandoffMessage(value);
  const directory = options.directory ?? DEFAULT_REGISTRY_DIRECTORY;
  let raw: string;
  try {
    raw = await readFile(endpointPath(directory, message.targetApp), "utf8");
  } catch {
    throw new CompanionUnavailableError(`BA Spine ${message.targetApp} is not currently registered on this device.`);
  }

  let endpoint: CompanionEndpointRecord;
  try { endpoint = parseEndpoint(JSON.parse(raw) as unknown, message.targetApp); }
  catch (error) { throw error instanceof CompanionUnavailableError ? error : new CompanionUnavailableError("Companion registration could not be read."); }

  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`http://127.0.0.1:${endpoint.port}${COMPANION_HANDOFF_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_500),
    });
  } catch {
    throw new CompanionUnavailableError(`BA Spine ${message.targetApp} could not be reached over loopback.`);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new CompanionUnavailableError(typeof body.error === "string" ? body.error : `BA Spine ${message.targetApp} rejected the handoff (${response.status}).`);
  }
}
