import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { ApplicationMenu, BrowserWindow, Utils } from "electrobun/main";
import { normalizeLibraryRelativePath, resolveLibraryPath } from "@ba-spine/desktop-host/pathPolicy";
import { createNodeLibraryReader } from "@ba-spine/desktop-host/nodeLibraryReader";
import { COMPANION_ACTIVATE_PATH, COMPANION_HANDOFF_PATH, COMPANION_HEALTH_PATH, CompanionAlreadyRunningError, CompanionInbox, CompanionUnavailableError, registerCompanionEndpoint, sendCompanionHandoff, type CompanionRegistration } from "@ba-spine/desktop-host/companion";
import { discoverSpineSets } from "@ba-spine/asset-library/catalog";
import { parseHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import { isEditorIgnored, parseEditorIgnore, type EditorIgnoreRule } from "@ba-spine/spine-runtime/spine/editorIgnore";

let assetRoot: string | null = process.env.BA_SPINE_DATA ? resolve(process.env.BA_SPINE_DATA) : null;
if (assetRoot) {
  try { assetRoot = await realpath(assetRoot); }
  catch { assetRoot = null; }
}
const EDITOR_DIRECTORIES = new Set([".editor", ".shittim-spine-editor"]);
let window: BrowserWindow | null = null;
const companionInbox = new CompanionInbox("viewer", undefined, () => {
  const current = window;
  if (!current) return;
  if (current.isMinimized()) current.unminimize();
  current.show();
  current.activate();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(value: unknown, status = 400): Response {
  return json({ error: value instanceof Error ? value.message : String(value) }, status);
}

function safeRelativePath(value: string): string {
  return normalizeLibraryRelativePath(value);
}

async function rootPath(): Promise<string> {
  if (!assetRoot) throw new Error("Choose a Spine asset library first.");
  return realpath(assetRoot);
}

async function rootRelativePath(value: string): Promise<string> {
  const root = await rootPath();
  const full = resolveLibraryPath(root, value);
  const actual = await realpath(full);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Path is outside the selected asset library.");
  return actual;
}

async function ignoreRules(): Promise<EditorIgnoreRule[]> {
  const root = await rootPath();
  try {
    return parseEditorIgnore(await readFile(join(root, ".editorignore"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function ignored(path: string, rules: readonly EditorIgnoreRule[], isDirectory = false): boolean {
  const first = path.split("/")[0]?.toLocaleLowerCase() ?? "";
  return EDITOR_DIRECTORIES.has(first) || isEditorIgnored(path, rules, isDirectory);
}

async function catalog() {
  return discoverSpineSets(createNodeLibraryReader(await rootPath()), {
    includeRelated: true,
    manifestConcurrency: 12,
  });
}

function contentType(path: string): string {
  switch (extname(path).toLocaleLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".atlas": return "text/plain; charset=utf-8";
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
    if (url.pathname === "/__spine/root") return json({ rootPath: assetRoot });
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
      if (message.targetApp !== "editor") return errorResponse("The viewer can only hand off to the editor.");
      await sendCompanionHandoff(message);
      return json({ ok: true, requestId: message.requestId });
    }
    if (url.pathname === "/__spine/open-root" && request.method === "POST") {
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot ?? Utils.paths.home,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      assetRoot = selected[0] ? await realpath(selected[0]) : null;
      return json({ rootPath: assetRoot });
    }
    if (url.pathname === "/__spine/use-root" && request.method === "POST") {
      const body = await request.json() as { rootPath?: unknown };
      if (typeof body.rootPath !== "string" || !body.rootPath) return errorResponse("A library folder is required.");
      const selected = await realpath(body.rootPath);
      const stat = await Bun.file(join(selected, "catalog.json")).exists();
      if (!stat) {
        const entries = await readdir(selected, { withFileTypes: true });
        if (!entries.some((entry) => entry.isDirectory() || /\.(?:atlas|skel)$/i.test(entry.name))) return errorResponse("The selected folder does not look like a Spine asset library.");
      }
      assetRoot = selected;
      return json({ rootPath: assetRoot });
    }
    if (url.pathname === "/__spine/catalog") return json({ rootPath: await rootPath(), sets: await catalog() });
    if (url.pathname === "/__spine/files") {
      const directory = url.searchParams.get("directory") ?? ".";
      const root = await rootPath();
      const full = directory === "." ? root : await rootRelativePath(directory);
      const rules = await ignoreRules();
      const entries = await readdir(full, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && !ignored([directory, entry.name].filter((part) => part !== ".").join("/"), rules))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return json({ files });
    }
    if (url.pathname === "/__spine/file") {
      const path = safeRelativePath(url.searchParams.get("path") ?? "");
      if (ignored(path, await ignoreRules())) return errorResponse("File excluded by .editorignore.", 404);
      const full = await rootRelativePath(path);
      const file = Bun.file(full);
      if (!(await file.exists())) return errorResponse("File not found.", 404);
      return new Response(file, { headers: { "content-type": contentType(full), "cache-control": "no-store" } });
    }
    return errorResponse("Unknown viewer endpoint.", 404);
  } catch (error) {
    return errorResponse(error, error instanceof CompanionUnavailableError ? 503 : 400);
  }
}

const staticRoot = resolve(import.meta.dir, "../views/viewer");
const apiToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === COMPANION_HANDOFF_PATH || url.pathname === COMPANION_HEALTH_PATH || url.pathname === COMPANION_ACTIVATE_PATH) return companionInbox.handle(request);
    if (url.pathname.startsWith("/__spine/")) {
      if (request.headers.get("x-ba-spine-token") !== apiToken) return errorResponse("Unauthorized viewer request.", 403);
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

if (server.port === undefined) throw new Error("The viewer host did not bind to a local port.");
let companionRegistration: CompanionRegistration;
try {
  companionRegistration = await registerCompanionEndpoint("viewer", server.port, { token: companionInbox.token });
} catch (error) {
  server.stop(true);
  if (error instanceof CompanionAlreadyRunningError) process.exit(0);
  throw error;
}
process.on("exit", () => companionRegistration.close());

window = new BrowserWindow({
  title: "BA Spine Viewer",
  url: `http://${server.hostname}:${server.port}/`,
  frame: { width: 1440, height: 940 },
});

ApplicationMenu.setApplicationMenu([
  { label: "BA Spine Viewer", submenu: [{ role: "quit" }] },
  { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
]);

void window;
