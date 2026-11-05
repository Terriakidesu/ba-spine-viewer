import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEditorMcpCommand, type EditorMcpCommand, type EditorMcpConnectionInfo, type EditorMcpState } from "@ba-spine/editor-feature/editorMcp";

interface PendingCommand {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
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
      pending.resolve(errorResponse("The desktop editor closed before responding to the MCP command.", 503));
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

  private async receiveState(request: Request): Promise<Response> {
    try {
      const value = await request.json();
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
      const value = await request.json();
      if (!record(value) || typeof value.id !== "string") return errorResponse("A command id is required.");
      const pending = this.pending.get(value.id);
      if (!pending) return json({ ok: false, ignored: true });
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (typeof value.error === "string" && value.error) {
        const staleRevision = value.error.startsWith("MCP_STALE_DOCUMENT_REVISION:");
        pending.resolve(json({ error: value.error, ...(staleRevision ? { code: "stale_document_revision" } : {}) }, staleRevision ? 409 : 400));
      } else pending.resolve(json({ result: value.result ?? null }));
      return json({ ok: true });
    } catch (value) {
      return errorResponse(value);
    }
  }

  private async dispatchCommand(request: Request): Promise<Response> {
    try {
      const value = await request.json();
      if (!record(value) || !record(value.command) || typeof value.command.name !== "string") return errorResponse("A named editor command is required.");
      const command = normalizeEditorMcpCommand(value.command);
      const expectedDocumentRevision = value.expectedDocumentRevision;
      if (expectedDocumentRevision !== undefined && (typeof expectedDocumentRevision !== "number" || !Number.isSafeInteger(expectedDocumentRevision) || expectedDocumentRevision < 0)) return errorResponse("expectedDocumentRevision must be a non-negative safe integer.");
      if (command.name === "open_asset_root" && !isAbsolute(command.rootPath)) return errorResponse("Asset root paths must be absolute.");
      if (this.queue.length >= 32) return errorResponse("The editor command queue is full.", 429);
      if (!this.state || Date.now() - this.stateUpdatedAt >= 5000) return errorResponse("The editor UI is not connected yet.", 503);
      if (expectedDocumentRevision !== undefined && this.state.documentRevision !== expectedDocumentRevision) {
        return json({ error: `The project changed after this operation was prepared (expected revision ${expectedDocumentRevision}, current revision ${this.state.documentRevision ?? "unknown"}). Re-read editor_state and review the change.`, code: "stale_document_revision", expectedDocumentRevision, actualDocumentRevision: this.state.documentRevision ?? null }, 409);
      }

      const id = crypto.randomUUID();
      const expiresAt = Date.now() + this.commandTimeoutMs;
      return await new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          const pending = this.pending.get(id);
          const started = pending?.started === true;
          this.pending.delete(id);
          if (!started) this.removeQueuedCommand(id);
          resolve(errorResponse(started
            ? `The editor started “${command.name}” but did not return within ${Math.round(this.commandTimeoutMs / 1000)} seconds. Its outcome may be unknown; inspect editor_state before retrying.`
            : `The editor did not start “${command.name}” within ${Math.round(this.commandTimeoutMs / 1000)} seconds. The queued command was canceled and will not execute later.`, 504));
        }, this.commandTimeoutMs);
        this.pending.set(id, { resolve, timer, started: false });
        this.queue.push({ id, command, expiresAt, ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }) });
      });
    } catch (value) {
      return errorResponse(value);
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
