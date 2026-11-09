import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readBoundedBody } from "@ba-spine/desktop-host/companion";
import { classifyEditorMcpError, createEditorMcpErrorEnvelope, createEditorMcpResultEnvelope, EDITOR_MCP_OPERATION_REGISTRY, type EditorMcpCommand, type EditorMcpCommandName, type EditorMcpConnectionInfo, type EditorMcpErrorCode, type EditorMcpProjectIdentity, type EditorMcpState } from "@ba-spine/editor-feature/editorMcp";

const MAX_STATE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_RESULT_BYTES = 1024 * 1024;

interface PendingCommand {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  command: EditorMcpCommand;
  identityBefore: EditorMcpProjectIdentity;
  documentRevisionBefore: number | null;
}

interface QueuedCommand {
  id: string;
  command: EditorMcpCommand;
  expiresAt: number;
  expectedDocumentRevision?: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(value: unknown, status = 400): Response {
  return json({ error: value instanceof Error ? value.message : String(value) }, status);
}

function projectIdentity(state: EditorMcpState | null, hostPid: number): EditorMcpProjectIdentity {
  return {
    hostPid,
    assetRoot: state?.assetRoot ?? null,
    directory: state?.directory ?? null,
    projectName: state?.projectName ?? null,
  };
}

function collectEntityIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (!record(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if ((key === "id" || /Id$/.test(key)) && typeof child === "string" && child) ids.push(child);
      else if (/Ids$/.test(key) && Array.isArray(child)) ids.push(...child.filter((entry): entry is string => typeof entry === "string" && Boolean(entry)));
      else visit(child);
    }
  };
  visit(value);
  return [...new Set(ids)];
}

function successResponse(envelope: ReturnType<typeof createEditorMcpResultEnvelope>): Response {
  const legacyFields = record(envelope.result) ? envelope.result : { value: envelope.result };
  return json({ ...legacyFields, ...envelope });
}

function statusForMcpError(code: EditorMcpErrorCode): number {
  switch (code) {
    case "stale_document_revision":
    case "external_conflict": return 409;
    case "renderer_unavailable":
    case "bridge_unavailable": return 503;
    case "unsupported_capability": return 501;
    case "command_timeout": return 504;
    default: return 400;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export class SpineEditorMcpBridge {
  readonly enabled: boolean;
  private readonly commandTimeoutMs: number;
  private readonly token: string;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queue: QueuedCommand[] = [];
  private readonly connectionDirectory = join(tmpdir(), "ba-spine-editor-mcp");
  private connectionFile: string | null = null;
  private state: EditorMcpState | null = null;
  private stateUpdatedAt = 0;
  private stateRevision = 0;

  constructor(enabled: boolean, options: { commandTimeoutMs?: number } = {}) {
    this.enabled = enabled;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.token = randomBytes(32).toString("base64url");
  }

  async start(port: number): Promise<string | null> {
    if (!this.enabled) return null;
    await mkdir(this.connectionDirectory, { recursive: true, mode: 0o700 });
    const info: EditorMcpConnectionInfo = {
      version: 1,
      pid: process.pid,
      port,
      token: this.token,
      createdAt: new Date().toISOString(),
    };
    this.connectionFile = join(this.connectionDirectory, `${process.pid}-${crypto.randomUUID()}.json`);
    await writeFile(this.connectionFile, `${JSON.stringify(info)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return this.connectionFile;
  }

  cleanup(): void {
    if (!this.connectionFile) return;
    try { unlinkSync(this.connectionFile); } catch { /* The app may be shutting down after its temp directory was removed. */ }
    this.connectionFile = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.commandErrorResponse("The desktop editor closed before responding to the MCP command.", { requestId: id, status: 503, identityBefore: pending.identityBefore, documentRevisionBefore: pending.documentRevisionBefore }));
      this.pending.delete(id);
    }
    this.queue.length = 0;
  }

  async handle(request: Request, url: URL): Promise<Response> {
    if (!url.pathname.startsWith("/__spine/mcp/")) return errorResponse("Unknown MCP endpoint.", 404);
    if (!this.enabled) return errorResponse("MCP is disabled. Launch the editor with --mcp.", 404);

    if (url.pathname.startsWith("/__spine/mcp/ui-") && !this.trustedUiRequest(request, url)) return errorResponse("Cross-origin editor bridge request rejected.", 403);
    if (url.pathname === "/__spine/mcp/ui-enabled" && request.method === "GET") return json({ enabled: true });
    if (url.pathname === "/__spine/mcp/ui-state" && request.method === "POST") return this.receiveState(request);
    if (url.pathname === "/__spine/mcp/ui-command" && request.method === "GET") return json(this.nextCommand());
    if (url.pathname === "/__spine/mcp/ui-result" && request.method === "POST") return this.receiveResult(request);

    if (!this.authorized(request)) return errorResponse("Unauthorized MCP request.", 401);
    if (url.pathname === "/__spine/mcp/health" && request.method === "GET") {
      return json({ ok: true, uiConnected: Date.now() - this.stateUpdatedAt < 5000, pid: process.pid });
    }
    if (url.pathname === "/__spine/mcp/state" && request.method === "GET") {
      if (!this.state || Date.now() - this.stateUpdatedAt >= 5000) return errorResponse("The editor UI has not published a current state snapshot.", 503);
      const age = Date.now() - this.stateUpdatedAt;
      return json({
        state: {
          ...this.state,
          snapshotRevision: this.stateRevision,
          snapshotUpdatedAt: new Date(this.stateUpdatedAt).toISOString(),
          snapshotAgeMs: age,
        },
        updatedAt: new Date(this.stateUpdatedAt).toISOString(),
        revision: this.stateRevision,
        ageMs: age,
      });
    }
    if (url.pathname === "/__spine/mcp/command" && request.method === "POST") return this.dispatchCommand(request);
    return errorResponse("Unknown MCP endpoint.", 404);
  }

  private authorized(request: Request): boolean {
    const header = request.headers.get("authorization") ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBytes = Buffer.from(this.token);
    const suppliedBytes = Buffer.from(supplied);
    return expectedBytes.byteLength === suppliedBytes.byteLength && timingSafeEqual(expectedBytes, suppliedBytes);
  }

  private trustedUiRequest(request: Request, url: URL): boolean {
    const origin = request.headers.get("origin");
    return !origin || origin === url.origin;
  }

  private commandErrorResponse(
    value: unknown,
    options: { requestId?: string | null; status?: number; identityBefore?: EditorMcpProjectIdentity; documentRevisionBefore?: number | null } = {},
  ): Response {
    const classified = classifyEditorMcpError(value);
    const envelope = createEditorMcpErrorEnvelope({
      requestId: options.requestId,
      projectIdentityBefore: options.identityBefore ?? projectIdentity(this.state, process.pid),
      projectIdentityAfter: projectIdentity(this.state, process.pid),
      documentRevisionBefore: options.documentRevisionBefore ?? this.state?.documentRevision ?? null,
      documentRevisionAfter: this.state?.documentRevision ?? null,
      error: classified,
      saveState: this.state?.saveState ?? null,
    });
    return json({ ...envelope, message: classified.message, code: classified.code }, options.status ?? statusForMcpError(classified.code));
  }

  private async receiveState(request: Request): Promise<Response> {
    try {
      const body = await readBoundedBody(request, MAX_STATE_BODY_BYTES);
      if (body.tooLarge) return errorResponse("Editor state snapshot exceeds the 2 MiB limit.", 413);
      const value = JSON.parse(body.text) as unknown;
      if (!record(value) || typeof value.workspace !== "string") return errorResponse("Invalid editor state snapshot.");
      this.state = value as unknown as EditorMcpState;
      this.stateUpdatedAt = Date.now();
      this.stateRevision += 1;
      return json({ ok: true });
    } catch (value) {
      return errorResponse(value);
    }
  }

  private async receiveResult(request: Request): Promise<Response> {
    try {
      const body = await readBoundedBody(request, MAX_RESULT_BODY_BYTES);
      if (body.tooLarge) {
        const id = request.headers.get("x-ba-spine-command-id");
        const pending = id ? this.pending.get(id) : undefined;
        if (pending && id) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(this.commandErrorResponse("Editor command result exceeded the 1 MiB response limit.", { requestId: id, status: 502, identityBefore: pending.identityBefore, documentRevisionBefore: pending.documentRevisionBefore }));
        }
        return errorResponse("Editor command result exceeds the 2 MiB transport limit.", 413);
      }
      const value = JSON.parse(body.text) as unknown;
      if (!record(value) || typeof value.id !== "string") return errorResponse("A command id is required.");
      const pending = this.pending.get(value.id);
      if (!pending) return json({ ok: false, ignored: true });
      const resultBytes = Buffer.byteLength(JSON.stringify(value.result ?? null), "utf8");
      if (resultBytes > MAX_COMMAND_RESULT_BYTES) {
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        pending.resolve(this.commandErrorResponse("Editor command result exceeded the 1 MiB response limit.", { requestId: value.id, status: 502, identityBefore: pending.identityBefore, documentRevisionBefore: pending.documentRevisionBefore }));
        return errorResponse("Editor command result exceeds the 1 MiB response limit.", 413);
      }
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (typeof value.error === "string" && value.error) {
        const classified = classifyEditorMcpError(value.error);
        pending.resolve(this.commandErrorResponse(classified, { requestId: value.id, status: statusForMcpError(classified.code), identityBefore: pending.identityBefore, documentRevisionBefore: pending.documentRevisionBefore }));
      } else {
        const rawResult = value.result ?? null;
        const resultRecord = record(rawResult) ? rawResult : {};
        const resultIds = collectEntityIds(rawResult);
        const createdFieldsByCommand: Partial<Record<EditorMcpCommandName, string[]>> = {
          add_interaction: ["interactionId", "regionIds"], duplicate_interaction: ["interactionId"], add_region: ["regionId"], duplicate_region: ["regionId"],
          create_talk_sequence: ["sequenceId"], add_audio_clip: ["audioId"], duplicate_audio_clip: ["audioId"], create_spine_layer: ["layerId"],
          add_animation_clip: ["clipId"], duplicate_animation_clip: ["clipId"], add_subtitle_cue: ["cueId"], duplicate_subtitle_cue: ["cueId"], split_subtitle_cue: ["secondCueId"],
          add_color_layer: ["layerId"], add_color_clip: ["clipId"], duplicate_color_clip: ["clipId"],
        };
        const createdEntityIds = (createdFieldsByCommand[pending.command.name] ?? []).flatMap((field) => {
          const fieldValue = resultRecord[field];
          return typeof fieldValue === "string" ? [fieldValue] : Array.isArray(fieldValue) ? fieldValue.filter((item): item is string => typeof item === "string") : [];
        });
        const warnings = Array.isArray(resultRecord.warnings) ? resultRecord.warnings.filter((item): item is string => typeof item === "string") : [];
        const envelope = createEditorMcpResultEnvelope({
          requestId: value.id,
          projectIdentityBefore: pending.identityBefore,
          projectIdentityAfter: projectIdentity(this.state, process.pid),
          documentRevisionBefore: pending.documentRevisionBefore,
          documentRevisionAfter: this.state?.documentRevision ?? null,
          result: rawResult,
          affectedEntityIds: [...collectEntityIds(pending.command), ...resultIds],
          createdEntityIds,
          warnings,
          normalization: resultRecord.normalization ?? null,
          saveState: this.state?.saveState ?? null,
        });
        pending.resolve(successResponse(envelope));
      }
      return json({ ok: true });
    } catch (value) {
      return errorResponse(value);
    }
  }

  private async dispatchCommand(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let identityBefore = projectIdentity(this.state, process.pid);
    let documentRevisionBefore = this.state?.documentRevision ?? null;
    try {
      const body = await readBoundedBody(request, MAX_COMMAND_BODY_BYTES);
      if (body.tooLarge) return this.commandErrorResponse("MCP command exceeds the 2 MiB request limit.", { requestId, status: 413, identityBefore, documentRevisionBefore });
      const value = JSON.parse(body.text) as unknown;
      if (!record(value) || !record(value.command) || typeof value.command.name !== "string") return this.commandErrorResponse("A named editor command is required.", { requestId, identityBefore, documentRevisionBefore });
      const operation = EDITOR_MCP_OPERATION_REGISTRY[value.command.name as EditorMcpCommandName];
      if (!operation) return this.commandErrorResponse(`Unsupported Editor MCP command: ${value.command.name}.`, { requestId, identityBefore, documentRevisionBefore });
      const command = operation.inputSchema(value.command);
      const expectedDocumentRevision = value.expectedDocumentRevision;
      if (expectedDocumentRevision !== undefined && (typeof expectedDocumentRevision !== "number" || !Number.isSafeInteger(expectedDocumentRevision) || expectedDocumentRevision < 0)) return this.commandErrorResponse("expectedDocumentRevision must be a non-negative safe integer.", { requestId, identityBefore, documentRevisionBefore });
      if (operation.revisionRequired && expectedDocumentRevision === undefined) return this.commandErrorResponse("expectedDocumentRevision is required for this authored project operation.", { requestId, identityBefore, documentRevisionBefore });
      if (command.name === "open_asset_root" && !isAbsolute(command.rootPath)) return this.commandErrorResponse("Asset root paths must be absolute.", { requestId, identityBefore, documentRevisionBefore });
      if (this.queue.length >= 32) return this.commandErrorResponse("The editor command queue is full.", { requestId, status: 429, identityBefore, documentRevisionBefore });
      if (!this.state || Date.now() - this.stateUpdatedAt >= 5000) return this.commandErrorResponse("The editor UI is not connected yet.", { requestId, status: 503, identityBefore, documentRevisionBefore });
      identityBefore = projectIdentity(this.state, process.pid);
      documentRevisionBefore = this.state.documentRevision ?? null;
      if (expectedDocumentRevision !== undefined && this.state.documentRevision !== expectedDocumentRevision) {
        return this.commandErrorResponse({ code: "stale_document_revision", message: `The project changed after this operation was prepared (expected revision ${expectedDocumentRevision}, current revision ${this.state.documentRevision ?? "unknown"}). Re-read editor_state and review the change.`, details: { expectedDocumentRevision, actualDocumentRevision: this.state.documentRevision ?? null } }, { requestId, status: 409, identityBefore, documentRevisionBefore });
      }

      const id = requestId;
      const expiresAt = Date.now() + this.commandTimeoutMs;
      return await new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          const pending = this.pending.get(id);
          const started = pending?.started === true;
          this.pending.delete(id);
          if (!started) this.removeQueuedCommand(id);
          resolve(this.commandErrorResponse(started
            ? `The editor started “${command.name}” but did not return within ${Math.round(this.commandTimeoutMs / 1000)} seconds. Its outcome may be unknown; inspect editor_state before retrying.`
            : `The editor did not start “${command.name}” within ${Math.round(this.commandTimeoutMs / 1000)} seconds. The queued command was canceled and will not execute later.`, { requestId: id, status: 504, identityBefore, documentRevisionBefore }));
        }, this.commandTimeoutMs);
        this.pending.set(id, { resolve, timer, started: false, command, identityBefore, documentRevisionBefore });
        this.queue.push({ id, command, expiresAt, ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }) });
      });
    } catch (value) {
      return this.commandErrorResponse(value, { requestId, identityBefore, documentRevisionBefore });
    }
  }

  private removeQueuedCommand(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private nextCommand(): QueuedCommand | null {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const pending = this.pending.get(item.id);
      if (!pending || item.expiresAt <= Date.now()) continue;
      pending.started = true;
      return item;
    }
    return null;
  }
}

export function mcpConnectionDirectory(): string {
  return join(tmpdir(), "ba-spine-editor-mcp");
}

export async function mcpConnectionFiles(): Promise<string[]> {
  try {
    const entries = await readdir(mcpConnectionDirectory(), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(mcpConnectionDirectory(), entry.name));
  } catch {
    return [];
  }
}

export async function removeMcpConnectionFile(path: string): Promise<void> {
  try { await unlink(path); } catch { /* Stale connection files are optional discovery metadata. */ }
}
