import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseHandoffMessage, parseSpineDraftSnapshot, type HandoffTargetApp, type SpineDraftSnapshot, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import { launchCompanionProcess, parseCompanionLaunchPlan, type CompanionLaunchPlan } from "./companionLaunch";

export const COMPANION_HANDOFF_PATH = "/__spine/companion/handoff";
export const COMPANION_HEALTH_PATH = "/__spine/companion/health";
export const COMPANION_ACTIVATE_PATH = "/__spine/companion/activate";
export const COMPANION_DRAFT_PATH = "/__spine/companion/draft";
const COMPANION_PROTOCOL_VERSION = 1;
function appDataRoot(): string {
  switch (process.platform) {
    case "win32": return process.env.LOCALAPPDATA || join(process.env.USERPROFILE || homedir(), "AppData", "Local");
    case "darwin": return join(homedir(), "Library", "Application Support");
    default: {
      const configured = process.env.XDG_DATA_HOME;
      return configured && isAbsolute(configured) && resolve(configured) !== "/"
        ? resolve(configured)
        : join(homedir(), ".local", "share");
    }
  }
}

export const DEFAULT_COMPANION_REGISTRY_DIRECTORY = join(appDataRoot(), "BA Spine Suite", "companions");
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

interface CompanionLeaseRecord {
  protocolVersion: number;
  app: HandoffTargetApp;
  token: string;
  pid: number;
}

export class CompanionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionUnavailableError";
  }
}

export class CompanionAlreadyRunningError extends Error {
  constructor(app: HandoffTargetApp) {
    super(`BA Spine ${app} is already running; the existing instance was asked to activate.`);
    this.name = "CompanionAlreadyRunningError";
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

function leasePath(directory: string, app: HandoffTargetApp): string {
  return join(directory, `${app}.lock`);
}

function launchPlanPath(directory: string, app: HandoffTargetApp): string {
  return join(directory, `${app}.launch.json`);
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

export async function readBoundedBody(request: Request, maxBytes = MAX_MESSAGE_BYTES): Promise<{ text: string; tooLarge: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
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

function parseLease(value: unknown, expectedApp: HandoffTargetApp): CompanionLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Companion instance lock is invalid.");
  const raw = value as Partial<CompanionLeaseRecord>;
  if (raw.protocolVersion !== COMPANION_PROTOCOL_VERSION
    || raw.app !== expectedApp
    || !tokenValue(raw.token)
    || !Number.isInteger(raw.pid) || Number(raw.pid) < 1) {
    throw new Error("Companion instance lock is invalid or uses an unsupported version.");
  }
  return raw as CompanionLeaseRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function activateEndpoint(record: CompanionEndpointRecord): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${COMPANION_ACTIVATE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${record.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return;
  } catch {
    // Activation is best effort; duplicate-instance policy still prevents a second window.
  }
}

async function activateRegisteredInstance(app: HandoffTargetApp, directory: string, lease: CompanionLeaseRecord): Promise<void> {
  try {
    const raw = await readFile(endpointPath(directory, app), "utf8");
    const endpoint = parseEndpoint(JSON.parse(raw) as unknown, app);
    if (endpoint.pid === lease.pid && endpoint.token === lease.token) await activateEndpoint(endpoint);
  } catch {
    // The primary may still be starting and has not published its endpoint yet.
  }
}

async function acquireInstanceLease(directory: string, app: HandoffTargetApp, lease: CompanionLeaseRecord): Promise<void> {
  const path = leasePath(directory, app);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }

    let current: CompanionLeaseRecord;
    try {
      current = parseLease(JSON.parse(await readFile(path, "utf8")) as unknown, app);
    } catch {
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs).catch(() => Number.POSITIVE_INFINITY);
      if (age < 10_000) throw new CompanionAlreadyRunningError(app);
      await unlink(path).catch(() => undefined);
      continue;
    }

    if (processIsAlive(current.pid)) {
      await activateRegisteredInstance(app, directory, current);
      throw new CompanionAlreadyRunningError(app);
    }

    try {
      const rawEndpoint = await readFile(endpointPath(directory, app), "utf8");
      const endpoint = parseEndpoint(JSON.parse(rawEndpoint) as unknown, app);
      if (endpoint.pid === current.pid && endpoint.token === current.token) await unlink(endpointPath(directory, app));
    } catch {
      // A dead process may have crashed before publishing an endpoint.
    }

    try {
      const latest = parseLease(JSON.parse(await readFile(path, "utf8")) as unknown, app);
      if (latest.pid === current.pid && latest.token === current.token) await unlink(path);
    } catch {
      // The lock disappeared while checking it; retry the exclusive create.
    }
  }
  throw new CompanionAlreadyRunningError(app);
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

export interface CompanionAutoLaunchOptions {
  resolvePlan(targetApp: HandoffTargetApp): unknown | Promise<unknown>;
  launch?: (targetApp: HandoffTargetApp, plan: CompanionLaunchPlan) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface StoredLaunchPlan {
  protocolVersion: number;
  app: HandoffTargetApp;
  plan: CompanionLaunchPlan;
}

/** Save a validated, shell-free plan so a companion can start this app later. */
export async function writeCompanionLaunchPlan(
  app: HandoffTargetApp,
  value: unknown,
  directory = DEFAULT_COMPANION_REGISTRY_DIRECTORY,
): Promise<void> {
  const plan = parseCompanionLaunchPlan(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = launchPlanPath(directory, app);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const record: StoredLaunchPlan = { protocolVersion: COMPANION_PROTOCOL_VERSION, app, plan };
  try {
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Read only a versioned plan that passes the same safe spawn validation. */
export async function readCompanionLaunchPlan(
  app: HandoffTargetApp,
  directory = DEFAULT_COMPANION_REGISTRY_DIRECTORY,
): Promise<CompanionLaunchPlan | null> {
  try {
    const record = JSON.parse(await readFile(launchPlanPath(directory, app), "utf8")) as Partial<StoredLaunchPlan>;
    if (record.protocolVersion !== COMPANION_PROTOCOL_VERSION || record.app !== app) return null;
    return parseCompanionLaunchPlan(record.plan);
  } catch {
    return null;
  }
}

/** Publish one app's loopback endpoint for the current process session. */
export async function registerCompanionEndpoint(
  app: HandoffTargetApp,
  port: number,
  options: { directory?: string; token?: string; launchPlan?: unknown } = {},
): Promise<CompanionRegistration> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Companion port must be a valid TCP port.");
  const directory = options.directory ?? DEFAULT_COMPANION_REGISTRY_DIRECTORY;
  const token = options.token ?? randomToken();
  if (!tokenValue(token)) throw new Error("Companion session token has an invalid format.");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const destination = endpointPath(directory, app);
  const leaseFile = leasePath(directory, app);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const record: CompanionEndpointRecord = { protocolVersion: COMPANION_PROTOCOL_VERSION, app, port, token, pid: process.pid };
  const lease: CompanionLeaseRecord = { protocolVersion: COMPANION_PROTOCOL_VERSION, app, token, pid: process.pid };
  await acquireInstanceLease(directory, app, lease);
  try {
    if (options.launchPlan !== undefined) await writeCompanionLaunchPlan(app, options.launchPlan, directory);
    try {
      const existing = parseEndpoint(JSON.parse(await readFile(destination, "utf8")) as unknown, app);
      if (processIsAlive(existing.pid)) {
        await activateEndpoint(existing);
        throw new CompanionAlreadyRunningError(app);
      }
      await unlink(destination).catch(() => undefined);
    } catch (error) {
      if (error instanceof CompanionAlreadyRunningError) throw error;
      // No endpoint or an invalid/stale record: the exclusive lease now owns startup.
    }
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    try {
      const currentLease = parseLease(JSON.parse(readFileSync(leaseFile, "utf8")) as unknown, app);
      if (currentLease.token === token) unlinkSync(leaseFile);
    } catch { /* A missing or replaced lock is already clean. */ }
    throw error;
  }

  return {
    token,
    close() {
      if (descriptorIsLive(record, directory)) {
        try { unlinkSync(destination); }
        catch { /* A missing descriptor is already clean. */ }
      }
      try {
        const currentLease = parseLease(JSON.parse(readFileSync(leaseFile, "utf8")) as unknown, app);
        if (currentLease.token === token) unlinkSync(leaseFile);
      } catch { /* A missing or replaced lock is already clean. */ }
    },
  };
}

/** Authenticated inbox for one target app. Request IDs are deduplicated per session. */
export class CompanionInbox {
  readonly token: string;
  private readonly messages: SpineHandoffMessage[] = [];
  private readonly seen = new Set<string>();
  private draftSnapshot: SpineDraftSnapshot | null = null;

  constructor(readonly app: HandoffTargetApp, token = randomToken(), private readonly onActivate?: () => void) {
    if (!tokenValue(token)) throw new Error("Companion session token has an invalid format.");
    this.token = token;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === COMPANION_DRAFT_PATH && request.method === "GET") {
      if (!sameToken(authorizationToken(request), this.token)) return json({ error: "Unauthorized companion request." }, 403);
      if (this.app !== "editor") return json({ error: "Draft preview is available only from BA Spine Editor." }, 404);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId) || this.draftSnapshot?.sessionId !== sessionId) {
        return json({ error: "Draft preview session is unavailable or stale." }, 404);
      }
      return json(this.draftSnapshot);
    }
    if (url.pathname === COMPANION_ACTIVATE_PATH && request.method === "POST") {
      if (!sameToken(authorizationToken(request), this.token)) return json({ error: "Unauthorized companion request." }, 403);
      try { this.onActivate?.(); }
      catch { return json({ error: "The companion window could not be activated." }, 500); }
      return json({ ok: true, app: this.app });
    }
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
    if (this.seen.has(message.requestId)) {
      try { this.onActivate?.(); } catch { /* Handoff delivery succeeds even if focus activation fails. */ }
      return json({ ok: true, duplicate: true, requestId: message.requestId }, 202);
    }
    if (this.messages.length >= MAX_PENDING_MESSAGES) return json({ error: "The companion inbox is full; retry after the app processes pending requests." }, 429);

    this.seen.add(message.requestId);
    this.messages.push(message);
    if (this.seen.size > MAX_SEEN_REQUEST_IDS) this.seen.delete(this.seen.values().next().value!);
    try { this.onActivate?.(); } catch { /* Handoff delivery succeeds even if focus activation fails. */ }
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

  /** Keep one bounded, volatile unsaved project snapshot in the Editor process only. */
  publishDraft(value: unknown): SpineDraftSnapshot {
    if (this.app !== "editor") throw new Error("Only the Editor can publish an unsaved draft.");
    const snapshot = parseSpineDraftSnapshot(value);
    const current = this.draftSnapshot;
    if (current && current.sessionId === snapshot.sessionId) {
      if (current.library.identity !== snapshot.library.identity
        || current.library.path !== snapshot.library.path
        || current.lobbyId !== snapshot.lobbyId) {
        throw new Error("A draft session cannot change its library or lobby.");
      }
      if (snapshot.revision <= current.revision) return current;
    }
    this.draftSnapshot = snapshot;
    return snapshot;
  }

  revokeDraft(sessionId: string): boolean {
    if (this.draftSnapshot?.sessionId !== sessionId) return false;
    this.draftSnapshot = null;
    return true;
  }
}

/** Read a volatile draft from the authenticated Editor loopback endpoint; never launch an absent Editor. */
export async function readCompanionDraftSnapshot(
  sessionId: string,
  options: { directory?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SpineDraftSnapshot | null> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error("Draft session ID is invalid.");
  const directory = options.directory ?? DEFAULT_COMPANION_REGISTRY_DIRECTORY;
  let rawEndpoint: string;
  try { rawEndpoint = await readFile(endpointPath(directory, "editor"), "utf8"); }
  catch { return null; }
  let endpoint: CompanionEndpointRecord;
  try { endpoint = parseEndpoint(JSON.parse(rawEndpoint) as unknown, "editor"); }
  catch { return null; }
  if (!processIsAlive(endpoint.pid)) return null;
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`http://127.0.0.1:${endpoint.port}${COMPANION_DRAFT_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
    });
  } catch {
    throw new CompanionUnavailableError("BA Spine Editor could not be reached for its draft preview.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new CompanionUnavailableError(`BA Spine Editor rejected the draft preview (${response.status}).`);
  try {
    const snapshot = parseSpineDraftSnapshot(await response.json() as unknown);
    return snapshot.sessionId === sessionId ? snapshot : null;
  } catch {
    throw new CompanionUnavailableError("BA Spine Editor returned an invalid draft preview.");
  }
}

/** Send only to the fixed loopback address recorded for the target app. */
export async function sendCompanionHandoff(
  value: unknown,
  options: { directory?: string; fetch?: typeof fetch; timeoutMs?: number; autoLaunch?: CompanionAutoLaunchOptions } = {},
): Promise<void> {
  const message = parseHandoffMessage(value);
  const directory = options.directory ?? DEFAULT_COMPANION_REGISTRY_DIRECTORY;
  const fetcher = options.fetch ?? fetch;

  const readEndpoint = async (): Promise<CompanionEndpointRecord | null> => {
    let raw: string;
    try { raw = await readFile(endpointPath(directory, message.targetApp), "utf8"); }
    catch { return null; }
    let endpoint: CompanionEndpointRecord;
    try { endpoint = parseEndpoint(JSON.parse(raw) as unknown, message.targetApp); }
    catch { return null; }
    return processIsAlive(endpoint.pid) ? endpoint : null;
  };

  const launchAndWait = async (): Promise<CompanionEndpointRecord> => {
    if (!options.autoLaunch) throw new CompanionUnavailableError(`BA Spine ${message.targetApp} is not currently registered on this device.`);
    const plan = await readCompanionLaunchPlan(message.targetApp, directory) ?? parseCompanionLaunchPlan(
      await options.autoLaunch.resolvePlan(message.targetApp),
    );
    try {
      if (options.autoLaunch.launch) await options.autoLaunch.launch(message.targetApp, plan);
      else await launchCompanionProcess(plan);
    } catch {
      throw new CompanionUnavailableError(`BA Spine ${message.targetApp} could not be started from its registered launch plan.`);
    }

    const requestedTimeout = options.autoLaunch.timeoutMs ?? 12_000;
    const requestedPollInterval = options.autoLaunch.pollIntervalMs ?? 150;
    const timeoutMs = Math.min(60_000, Math.max(0, Number.isFinite(requestedTimeout) ? requestedTimeout : 12_000));
    const pollIntervalMs = Math.min(1_000, Math.max(10, Number.isFinite(requestedPollInterval) ? requestedPollInterval : 150));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const endpoint = await readEndpoint();
      if (endpoint) return endpoint;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
    throw new CompanionUnavailableError(`BA Spine ${message.targetApp} started but did not register in time.`);
  };

  let endpoint = await readEndpoint();
  endpoint ??= await launchAndWait();

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
