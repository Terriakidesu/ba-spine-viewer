import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEditorMcpCommand, type EditorMcpCommand, type EditorMcpConnectionInfo, type EditorMcpState } from "@ba-spine/editor-feature/editorMcp";

interface PendingCommand {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedCommand {
  id: string;
  command: EditorMcpCommand;
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
  private readonly token: string;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queue: QueuedCommand[] = [];
  private readonly connectionDirectory = join(tmpdir(), "ba-spine-editor-mcp");
  private connectionFile: string | null = null;
  private state: EditorMcpState | null = null;
  private stateUpdatedAt = 0;
  private stateRevision = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
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
  }

  async handle(request: Request, url: URL): Promise<Response> {
    if (!url.pathname.startsWith("/__spine/mcp/")) return errorResponse("Unknown MCP endpoint.", 404);
    if (!this.enabled) return errorResponse("MCP is disabled. Launch the editor with --mcp.", 404);

    if (url.pathname.startsWith("/__spine/mcp/ui-") && !this.trustedUiRequest(request, url)) return errorResponse("Cross-origin editor bridge request rejected.", 403);
    if (url.pathname === "/__spine/mcp/ui-enabled" && request.method === "GET") return json({ enabled: true });
    if (url.pathname === "/__spine/mcp/ui-state" && request.method === "POST") return this.receiveState(request);
    if (url.pathname === "/__spine/mcp/ui-command" && request.method === "GET") return json(this.queue.shift() ?? null);
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
      if (typeof value.error === "string" && value.error) pending.resolve(errorResponse(value.error, 400));
      else pending.resolve(json({ result: value.result ?? null }));
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
      if (command.name === "open_asset_root" && !isAbsolute(command.rootPath)) return errorResponse("Asset root paths must be absolute.");
      if (this.queue.length >= 32) return errorResponse("The editor command queue is full.", 429);
      if (!this.state || Date.now() - this.stateUpdatedAt >= 5000) return errorResponse("The editor UI is not connected yet.", 503);

      const id = crypto.randomUUID();
      return await new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(errorResponse(`The editor did not complete “${command.name}” within 30 seconds.`, 504));
        }, 30_000);
        this.pending.set(id, { resolve, timer });
        this.queue.push({ id, command });
      });
    } catch (value) {
      return errorResponse(value);
    }
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
