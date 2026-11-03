import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { ApplicationMenu, BrowserWindow, Screen, Utils } from "electrobun/main";
import { isPathWithinLibrary, resolveExistingLibraryPath } from "@ba-spine/desktop-host/pathPolicy";
import { createNodeLibraryReader } from "@ba-spine/desktop-host/nodeLibraryReader";
import { COMPANION_ACTIVATE_PATH, COMPANION_DRAFT_PATH, COMPANION_HANDOFF_PATH, COMPANION_HEALTH_PATH, CompanionAlreadyRunningError, CompanionInbox, CompanionUnavailableError, readBoundedBody, registerCompanionEndpoint, sendCompanionHandoff, type CompanionRegistration } from "@ba-spine/desktop-host/companion";
import { defaultCompanionLaunchPlan } from "@ba-spine/desktop-host/companionLaunch";
import { discoverSpineSets } from "@ba-spine/asset-library/catalog";
import { libraryIdentityForPath, MAX_SPINE_DRAFT_SNAPSHOT_BYTES, parseHandoffMessage, parseSpineDraftSnapshot } from "@ba-spine/platform-contracts/handoff";
import { isEditorIgnored, parseEditorIgnore, type EditorIgnoreRule } from "@ba-spine/spine-runtime/spine/editorIgnore";
import { EditorFileConflictError, saveEditorBatch, type EditorBatchFile } from "@ba-spine/desktop-host/transactionalSave";
import { SpineEditorMcpBridge } from "./mcpBridge";
import { defaultDesktopWindowFrame, readDesktopWindowState, restoreDesktopWindowState, startDesktopWindowStatePersistence, type WindowDisplay } from "@ba-spine/desktop-host/windowState";

let assetRoot: string | null = process.env.BA_SPINE_DATA ? resolve(process.env.BA_SPINE_DATA) : null;
if (assetRoot) {
  try { assetRoot = await realpath(assetRoot); }
  catch { assetRoot = null; }
}
const mcpBridge = new SpineEditorMcpBridge(process.env.BA_SPINE_EDITOR_MCP === "1" || Bun.argv.includes("--mcp"));
const companionChannel = process.env.BA_SPINE_APP_CHANNEL === "canary" ? "canary" : "stable";

function launchPlanFor(app: "viewer" | "editor") {
  return defaultCompanionLaunchPlan(app, {
    appDataRoot: Utils.paths.appData,
    channel: companionChannel,
    ...(process.env.BA_SPINE_WORKSPACE_ROOT ? { workspaceRoot: process.env.BA_SPINE_WORKSPACE_ROOT } : {}),
  });
}

let window: BrowserWindow | null = null;
const companionInbox = new CompanionInbox("editor", undefined, () => {
  const current = window;
  if (!current) return;
  if (current.isMinimized()) current.unminimize();
  current.show();
  current.activate();
});

const EDITOR_DIRECTORIES = new Set([".editor", ".shittim-spine-editor"]);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(value: unknown, status = 400): Response {
  return json({ error: value instanceof Error ? value.message : String(value) }, status);
}

function relativePath(full: string): string {
  return relative(resolve(assetRoot!), full).replaceAll(sep, "/");
}

function isEditorDataPath(path: string): boolean {
  return EDITOR_DIRECTORIES.has(path.split("/")[0]?.toLocaleLowerCase() ?? "");
}

async function ignoreRules(): Promise<EditorIgnoreRule[]> {
  if (!assetRoot) return [];
  try {
    return parseEditorIgnore(await readFile(join(assetRoot, ".editorignore"), "utf8"));
  } catch (value) {
    if (value && typeof value === "object" && "code" in value && (value as { code?: string }).code === "ENOENT") return [];
    throw value;
  }
}

function ignored(path: string, rules: readonly EditorIgnoreRule[], isDirectory = false): boolean {
  return !isEditorDataPath(path) && isEditorIgnored(path, rules, isDirectory);
}

async function catalog() {
  if (!assetRoot) throw new Error("Choose an asset root first.");
  return discoverSpineSets(createNodeLibraryReader(assetRoot), {
    includeRelated: false,
    manifestConcurrency: 12,
  });
}

async function useRoot(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  const entries = await readdir(root, { withFileTypes: true });
  if (!entries.some((entry) => entry.isDirectory() || /\.(?:atlas|skel)$/i.test(entry.name))) throw new Error("The recent folder is empty or is not an asset root.");
  assetRoot = root;
  return root;
}

async function setFiles(directory: string): Promise<string[]> {
  if (!assetRoot) throw new Error("Choose an asset root first.");
  const full = directory === "." ? await realpath(assetRoot) : await resolveExistingLibraryPath(assetRoot, directory);
  const rules = await ignoreRules();
  return (await readdir(full, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !ignored(relativePath(join(full, entry.name)), rules))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function contentType(path: string): string {
  switch (extname(path).toLocaleLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".atlas": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".ogg": return "audio/ogg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

async function api(request: Request, url: URL): Promise<Response> {
  try {
    if (url.pathname === "/__spine/open-root" && request.method === "POST") {
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot ?? Utils.paths.home,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      assetRoot = selected[0] ? await useRoot(selected[0]) : null;
      return json({ rootPath: assetRoot });
    }
    if (url.pathname === "/__spine/companion/pending" && request.method === "GET") return json({ messages: companionInbox.pending() });
    if (url.pathname === "/__spine/companion/ack" && request.method === "POST") {
      const body = await request.json() as { requestIds?: unknown };
      if (!Array.isArray(body.requestIds) || body.requestIds.length > 32 || body.requestIds.some((id) => typeof id !== "string")) {
        return errorResponse("A list of handoff request IDs is required.");
      }
      return json({ acknowledged: companionInbox.acknowledge(body.requestIds as string[]) });
    }
    if (url.pathname === "/__spine/companion/send" && request.method === "POST") {
      const message = parseHandoffMessage(await request.json() as unknown);
      if (message.targetApp !== "viewer") return errorResponse("The editor can only hand off to the viewer.");
      await sendCompanionHandoff(message, {
        autoLaunch: { resolvePlan: (targetApp) => launchPlanFor(targetApp) },
      });
      return json({ ok: true, requestId: message.requestId });
    }
    if (url.pathname === "/__spine/companion/draft-publish" && request.method === "POST") {
      let body: Awaited<ReturnType<typeof readBoundedBody>>;
      try { body = await readBoundedBody(request, MAX_SPINE_DRAFT_SNAPSHOT_BYTES); }
      catch { return errorResponse("Draft preview must be valid UTF-8 JSON.", 400); }
      if (body.tooLarge) return errorResponse("Draft preview exceeds the 8 MB safety limit.", 413);
      let raw: unknown;
      try { raw = JSON.parse(body.text) as unknown; }
      catch { return errorResponse("Draft preview must be valid JSON.", 400); }
      const snapshot = parseSpineDraftSnapshot(raw);
      if (!assetRoot) throw new Error("Choose an asset root before publishing a draft preview.");
      if (snapshot.project.assetDirectory !== snapshot.lobbyId || !Array.isArray(snapshot.project.interactions)) {
        return errorResponse("Draft project does not match its selected lobby.", 400);
      }
      const root = await realpath(assetRoot);
      if (snapshot.library.path !== root || snapshot.library.identity !== await libraryIdentityForPath(root)) {
        return errorResponse("Draft preview must match the Editor's currently selected library.", 409);
      }
      return json({ snapshot: companionInbox.publishDraft(snapshot) });
    }
    if (url.pathname === "/__spine/companion/draft-revoke" && request.method === "POST") {
      const body = await request.json() as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.sessionId)) return errorResponse("A valid draft session ID is required.");
      return json({ revoked: companionInbox.revokeDraft(body.sessionId) });
    }
    if (url.pathname === "/__spine/use-root" && request.method === "POST") {
      const body = await request.json() as { rootPath?: unknown };
      if (typeof body.rootPath !== "string" || !body.rootPath) return errorResponse("A recent asset root is required.");
      return json({ rootPath: await useRoot(body.rootPath) });
    }
    if (url.pathname === "/__spine/open-file" && request.method === "POST") {
      if (!assetRoot) throw new Error("Choose an asset root first.");
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot,
        allowedFileTypes: "json",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: false,
      });
      const absolute = selected[0];
      if (!absolute) return json({ path: null, content: null });
      const root = await realpath(resolve(assetRoot));
      const full = resolve(absolute);
      const actual = await realpath(full);
      if (!isPathWithinLibrary(root, actual)) throw new Error("Choose a file inside the selected asset root.");
      const path = relative(root, actual).replaceAll(sep, "/");
      if (ignored(path, await ignoreRules())) throw new Error("The selected file is excluded by .editorignore.");
      return json({ path, content: await readFile(actual, "utf8") });
    }
    if (url.pathname === "/__spine/open-project" && request.method === "POST") {
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot ?? Utils.paths.home,
        allowedFileTypes: "json",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: false,
      });
      const absolute = selected[0];
      if (!absolute) return json({ rootPath: null, path: null, content: null });
      const full = resolve(absolute);
      const projectDirectory = EDITOR_DIRECTORIES.has(basename(dirname(full)).toLocaleLowerCase()) ? dirname(dirname(full)) : dirname(full);
      assetRoot = await useRoot(projectDirectory);
      const actual = await realpath(full);
      if (!isPathWithinLibrary(assetRoot, actual)) throw new Error("The selected project file is outside its project folder.");
      return json({ rootPath: assetRoot, path: relative(assetRoot, actual).replaceAll(sep, "/"), content: await readFile(actual, "utf8") });
    }
    if (url.pathname === "/__spine/open-audio" && request.method === "POST") {
      if (!assetRoot) throw new Error("Choose an asset root first.");
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot,
        allowedFileTypes: "ogg,wav,mp3,m4a,flac,aac,opus",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: true,
      });
      const root = await realpath(resolve(assetRoot));
      const rules = await ignoreRules();
      const paths = await Promise.all(selected.map(async (absolute) => {
        const full = resolve(absolute);
        const actual = await realpath(full);
        if (!isPathWithinLibrary(root, actual)) throw new Error("Choose audio files inside the selected asset root.");
        return relative(root, actual).replaceAll(sep, "/");
      }));
      const acceptedPaths = paths.filter((path) => !ignored(path, rules));
      return json({ paths: acceptedPaths });
    }
    if (url.pathname === "/__spine/catalog") return json({ rootPath: assetRoot, sets: await catalog() });
    if (url.pathname === "/__spine/files") return json({ files: await setFiles(url.searchParams.get("directory") ?? ".") });
    if (url.pathname === "/__spine/file") {
      const path = (url.searchParams.get("path") ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
      let full: string;
      try {
        full = await resolveExistingLibraryPath(assetRoot!, path);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return errorResponse("File not found.", 404);
        throw error;
      }
      if (ignored(path, await ignoreRules())) return errorResponse("File excluded by .editorignore.", 404);
      if (!(await Bun.file(full).exists())) return errorResponse("File not found.", 404);
      return new Response(Bun.file(full), { headers: { "content-type": contentType(full) } });
    }
    if (url.pathname === "/__spine/save-batch" && request.method === "POST") {
      let body: Awaited<ReturnType<typeof readBoundedBody>>;
      try { body = await readBoundedBody(request, 48 * 1024 * 1024); }
      catch { return errorResponse("Editor save set must be valid UTF-8 JSON.", 400); }
      if (body.tooLarge) return errorResponse("Editor save set exceeds the 48 MB safety limit.", 413);
      let raw: unknown;
      try { raw = JSON.parse(body.text) as unknown; }
      catch { return errorResponse("Editor save set must be valid JSON.", 400); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return errorResponse("Editor save set must be an object.");
      const input = raw as { files?: unknown; overwriteVersions?: unknown };
      if (!Array.isArray(input.files) || input.files.some((file) => !file || typeof file !== "object" || Array.isArray(file))) {
        return errorResponse("Editor save set must contain a list of files.");
      }
      const files = input.files as Array<Record<string, unknown>>;
      if (files.some((file) => typeof file.path !== "string" || typeof file.content !== "string" || typeof file.expectedVersion !== "string")) {
        return errorResponse("Each Editor save entry requires a path, content, and baseline version.");
      }
      const overwriteVersions = input.overwriteVersions === undefined ? {} : input.overwriteVersions;
      if (!overwriteVersions || typeof overwriteVersions !== "object" || Array.isArray(overwriteVersions)
        || Object.entries(overwriteVersions).some(([path, version]) => typeof path !== "string" || typeof version !== "string")) {
        return errorResponse("Overwrite decisions must map file paths to the versions the user reviewed.");
      }
      try {
        if (!assetRoot) throw new Error("Choose an asset root before saving.");
        const result = await saveEditorBatch(assetRoot, files as unknown as EditorBatchFile[], overwriteVersions as Record<string, string>);
        return json({ ok: true, ...result });
      } catch (value) {
        if (value instanceof EditorFileConflictError) return json({ error: value.message, currentVersions: value.currentVersions }, 409);
        if (value && typeof value === "object" && "committedPaths" in value && "rollbackFailures" in value) {
          return json({
            error: value instanceof Error ? value.message : String(value),
            committedPaths: value.committedPaths,
            rollbackFailures: value.rollbackFailures,
          }, 500);
        }
        throw value;
      }
    }
    return errorResponse("Unknown desktop editor endpoint.", 404);
  } catch (value) {
    return errorResponse(value, value instanceof CompanionUnavailableError ? 503 : 500);
  }
}

const staticRoot = resolve(import.meta.dir, "../views/editor");
const apiToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === COMPANION_HANDOFF_PATH || url.pathname === COMPANION_HEALTH_PATH || url.pathname === COMPANION_ACTIVATE_PATH || url.pathname === COMPANION_DRAFT_PATH) return companionInbox.handle(request);
      if (url.pathname.startsWith("/__spine/mcp/")) return mcpBridge.handle(request, url);
      if (url.pathname.startsWith("/__spine/")) {
        if (request.headers.get("x-ba-spine-token") !== apiToken) return errorResponse("Unauthorized editor request.", 403);
        return api(request, url);
      }
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
      const full = resolve(staticRoot, requested);
      if (full !== staticRoot && !full.startsWith(`${staticRoot}${sep}`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(full);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      if (requested === "index.html") {
        const html = (await file.text()).replace("</head>", `<script>window.__BA_SPINE_HOST_TOKEN__=${JSON.stringify(apiToken)};</script></head>`);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response(file, { headers: { "content-type": contentType(full) } });
    },
  });
  console.log(`[ba-spine-editor] local server ${server.url} serving ${staticRoot}`);
} catch (value) {
  console.error("[ba-spine-editor] local server failed", value);
  throw value;
}

if (server.port === undefined) throw new Error("The editor host did not bind to a local port.");
let companionRegistration: CompanionRegistration;
try {
  companionRegistration = await registerCompanionEndpoint("editor", server.port, {
    token: companionInbox.token,
    launchPlan: launchPlanFor("editor"),
  });
} catch (error) {
  server.stop(true);
  if (error instanceof CompanionAlreadyRunningError) process.exit(0);
  throw error;
}
process.on("exit", () => companionRegistration.close());
const mcpConnectionFile = await mcpBridge.start(server.port);
if (mcpConnectionFile) {
  console.log(`[ba-spine-editor] MCP enabled; start its stdio server with bun run mcp (connection file ${mcpConnectionFile})`);
  process.on("exit", () => mcpBridge.cleanup());
}

const editorWindowStatePath = join(Utils.paths.appData, "BA Spine Suite", "Editor", "window-state.json");
function connectedDisplays(): WindowDisplay[] {
  try {
    const displays = Screen.getAllDisplays();
    return displays.length ? displays : [Screen.getPrimaryDisplay()];
  } catch {
    try { return [Screen.getPrimaryDisplay()]; } catch { return []; }
  }
}
const initialDisplays = connectedDisplays();
const editorMinimumWindowSize = { width: 760, height: 560 };
const restoredWindowState = restoreDesktopWindowState(await readDesktopWindowState(editorWindowStatePath), initialDisplays, editorMinimumWindowSize);
const defaultWindowFrame = defaultDesktopWindowFrame(initialDisplays, { width: 1440, height: 900 }, editorMinimumWindowSize);

let nativeWindow: BrowserWindow;
try {
  nativeWindow = new BrowserWindow({
    title: "BA Spine Editor",
    url: `http://${server.hostname}:${server.port}/`,
    frame: restoredWindowState?.frame ?? defaultWindowFrame ?? { width: 1440, height: 900 },
  });
  window = nativeWindow;
  if (restoredWindowState?.maximized) nativeWindow.maximize();
  console.log(`[ba-spine-editor] window ${window.id} opened`);
} catch (value) {
  console.error("[ba-spine-editor] native window failed", value);
  companionRegistration.close();
  server.stop();
  mcpBridge.cleanup();
  throw value;
}

startDesktopWindowStatePersistence(nativeWindow, editorWindowStatePath, connectedDisplays, (error) => console.warn("[ba-spine-editor] could not save window state", error));

ApplicationMenu.setApplicationMenu([
  {
    label: "Editor",
    submenu: [{ role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);

void window;
