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
  const payload = await response.json().catch(() => ({})) as { error?: string; result?: T; state?: T };
  if (!response.ok) throw new Error(payload.error ?? `Editor MCP request failed (${response.status}).`);
  return ("state" in payload ? payload.state : "result" in payload ? payload.result : payload) as T;
}

async function hostRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let connection = activeConnection;
  if (!connection) {
    connection = (await discoverHosts())[0] ?? null;
    if (!connection) throw new Error("No running editor with MCP enabled was found. Start it with `bun run editor:desktop -- --mcp` first.");
    activeConnection = connection;
  }
  try {
    return await requestHost<T>(connection, path, init);
  } catch (value) {
    if (!(value instanceof HostUnavailableError)) throw value;
    activeConnection = null;
    // A state read is safe to retry after rediscovery. Never replay a command
    // POST after a transport failure; it may have reached the old host.
    const safeToRetry = (init?.method ?? "GET").toUpperCase() === "GET";
    if (!safeToRetry) throw value;
    const replacement = (await discoverHosts()).find((host) => host.pid !== connection.pid || host.port !== connection.port);
    if (!replacement) throw value;
    activeConnection = replacement;
    return requestHost<T>(replacement, path, init);
  }
}

function sendCommand<T = unknown>(command: EditorMcpCommand): Promise<T> {
  return hostRequest<T>("/__spine/mcp/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
}

async function editorState(): Promise<EditorMcpState> {
  return hostRequest<EditorMcpState>("/__spine/mcp/state");
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
  return {
    content: [{ type: "text" as const, text: value instanceof Error ? value.message : String(value) }],
    isError: true,
  };
}

const server = new McpServer({ name: "ba-spine-editor", version: "0.1.0" }, {
  instructions: "Debug the running private Spine editor. Inspect state first and use the preview capture to verify rendering. MCP does not write project or subtitle files unless editor_save is explicitly called; the editor's existing browser recovery storage remains active.",
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
  inputSchema: z.object({ workspace: z.enum(["interaction", "timeline"]) }),
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
  inputSchema: z.object({ sequenceId: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ sequenceId }) => {
  try { return result(await sendCommand({ name: "select_sequence", sequenceId })); }
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
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, patch }) => {
  try { return result(await sendCommand({ name: "update_spine_layer", layerId, patch })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_reorder_visual_layer", {
  title: "Reorder visual layer",
  description: "Move a Spine or color visual layer to the position of another visual layer. Locked layers are respected.",
  inputSchema: z.object({ layerId: z.string().min(1), targetLayerId: z.string().min(1) }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, targetLayerId }) => {
  try { return result(await sendCommand({ name: "reorder_visual_layer", layerId, targetLayerId })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_color_layer", {
  title: "Add color layer",
  description: "Add a new editable color layer to the opening sequence. This changes editor memory only until saved.",
  inputSchema: z.object({ name: z.string().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ name }) => {
  try { return result(await sendCommand({ name: "add_color_layer", ...(name ? { nameHint: name } : {}) })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_add_color_clip", {
  title: "Add color clip",
  description: "Add a color clip preset at the playhead, optionally on a specified unlocked color layer.",
  inputSchema: z.object({
    preset: z.enum(["solid", "fade-from-black", "fade-to-black", "white-flash"]).optional(),
    layerId: z.string().optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ preset, layerId }) => {
  try { return result(await sendCommand({ name: "add_color_clip", ...(preset ? { preset } : {}), ...(layerId ? { layerId } : {}) })); }
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
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ layerId, patch }) => {
  try { return result(await sendCommand({ name: "update_color_layer", layerId, patch })); }
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
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ clipId, patch }) => {
  try { return result(await sendCommand({ name: "update_color_clip", clipId, patch })); }
  catch (value) { return failed(value); }
});

server.registerTool("editor_save", {
  title: "Save editor project",
  description: "Explicitly save the current interaction/timeline project and linked subtitle files into the selected asset root. This writes user data; inspect editor_state first.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async () => {
  try { return result(await sendCommand({ name: "save" })); }
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
