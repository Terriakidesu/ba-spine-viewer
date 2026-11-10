import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApplicationMenu, BrowserWindow, Screen, Utils } from "electrobun/main";
import { normalizeLibraryRelativePath, resolveLibraryPath } from "@ba-spine/desktop-host/pathPolicy";
import { createNodeLibraryReader } from "@ba-spine/desktop-host/nodeLibraryReader";
import { COMPANION_ACTIVATE_PATH, COMPANION_HANDOFF_PATH, COMPANION_HEALTH_PATH, CompanionAlreadyRunningError, CompanionInbox, CompanionUnavailableError, readCompanionDraftSnapshot, registerCompanionEndpoint, sendCompanionHandoff, type CompanionRegistration } from "@ba-spine/desktop-host/companion";
import { defaultCompanionLaunchPlan } from "@ba-spine/desktop-host/companionLaunch";
import { discoverSpineSets } from "@ba-spine/asset-library/catalog";
import type { SpineSet } from "@ba-spine/asset-library/catalog";
import { parseHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import { isEditorIgnored, parseEditorIgnore, type EditorIgnoreRule } from "@ba-spine/spine-runtime/spine/editorIgnore";
import { manifestReferenceCandidates, normalizeSpineManifest } from "@ba-spine/spine-runtime/spine/spineManifest";
import { MAX_VIEWER_THUMBNAIL_BYTES, ViewerThumbnailCache } from "@ba-spine/desktop-host/viewerThumbnailCache";
import { createDebouncedAction } from "@ba-spine/desktop-host/debouncedAction";
import { defaultDesktopWindowFrame, enforceDesktopWindowMinimum, readDesktopWindowState, restoreDesktopWindowState, startDesktopWindowStatePersistence, type WindowDisplay } from "@ba-spine/desktop-host/windowState";
import { restoreLastLibraryPath, writeLastLibraryPath } from "@ba-spine/desktop-host/libraryPreference";
import { discoverPortableSuite, firstRecognizableLibraryPath } from "@ba-spine/desktop-host/portableSuite";
import { installWindowsNativeWindowMinimum } from "@ba-spine/desktop-host/windowsWindowMinimum";
import { onceDesktopHostShutdown } from "@ba-spine/desktop-host/desktopShutdown";
import { saveVideoWithoutOverwrite } from "@ba-spine/desktop-host/videoExport";
import { FfmpegVideoRecorder } from "@ba-spine/desktop-host/ffmpegVideoRecorder";
import { downloadPortableSuiteUpdate, getPortableSuiteUpdateStatus, getStagedPortableSuiteUpdate, hasPortableSuiteUpdater, isNewerPortableSuiteVersion } from "@ba-spine/desktop-host/portableSuiteUpdate";
import { hasLiveEditorSuiteUpdateChanges } from "@ba-spine/desktop-host/portableSuiteUpdateState";

const suiteUpdateRoamingRoot = process.env.APPDATA && isAbsolute(process.env.APPDATA)
  ? process.env.APPDATA
  : join(Utils.paths.home, "AppData", "Roaming");
const viewerLibraryPreferencePath = join(Utils.paths.appData, "BA Spine Suite", "Viewer", "library.json");
const portableSuite = process.env.BA_SPINE_SUITE_ROOT
  ? await discoverPortableSuite(process.env.BA_SPINE_SUITE_ROOT).catch((error) => {
    console.warn("[ba-spine-viewer] ignoring invalid portable suite metadata", error);
    return null;
  })
  : null;
const rememberedLibraryPath = await restoreLastLibraryPath(viewerLibraryPreferencePath);
const initialPath = await firstRecognizableLibraryPath([
  process.env.BA_SPINE_DATA,
  rememberedLibraryPath,
  portableSuite?.dataPath,
]);
let assetRoot: string | null = initialPath ? resolve(initialPath) : null;
const EDITOR_DIRECTORIES = new Set([".editor", ".shittim-spine-editor"]);
const companionChannel = process.env.BA_SPINE_APP_CHANNEL === "canary" ? "canary" : "stable";
const viewerThumbnailCache = new ViewerThumbnailCache(join(Utils.paths.appData, "BA Spine Suite", "Viewer", "thumbnails"));
let catalogCache: { rootPath: string; promise: Promise<SpineSet[]> } | null = null;
let libraryWatcher: FSWatcher | null = null;
let libraryWatcherRoot: string | null = null;
let libraryWatcherAvailable = false;
let libraryChangeRevision = 0;
let libraryChangeDebouncer: ReturnType<typeof createDebouncedAction> | null = null;
const pendingLibraryPaths = new Set<string | null>();
const MAX_VIEWER_VIDEO_BYTES = 1_073_741_824;
let videoSaveDirectory: string | null = null;
let lastVideoExportDirectory: string | null = null;
const ffmpegExecutableCandidates = [
  resolve(import.meta.dir, "../views/ffmpeg/ffmpeg.exe"),
  resolve(import.meta.dir, "../../build/ffmpeg/ffmpeg.exe"),
];
const ffmpegVideoRecorder = new FfmpegVideoRecorder(
  ffmpegExecutableCandidates.find((candidate) => existsSync(candidate)) ?? ffmpegExecutableCandidates[0]!,
  () => videoSaveDirectory,
);

function launchPlanFor(app: "viewer" | "editor") {
  return defaultCompanionLaunchPlan(app, {
    appDataRoot: Utils.paths.appData,
    channel: companionChannel,
    ...(portableSuite ? { suiteRoot: portableSuite.root } : {}),
    ...(process.env.BA_SPINE_WORKSPACE_ROOT ? { workspaceRoot: process.env.BA_SPINE_WORKSPACE_ROOT } : {}),
  });
}
let window: BrowserWindow | null = null;
let viewerMenuFullscreen: boolean | null = null;

function syncViewerApplicationMenu(fullScreen: boolean) {
  if (viewerMenuFullscreen === fullScreen) return;
  viewerMenuFullscreen = fullScreen;
  ApplicationMenu.setApplicationMenu(fullScreen ? [] : [
    { label: "BA Spine Viewer", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
  ]);
}

function openDirectoryInFileManager(directory: string): Promise<void> {
  const executable = process.platform === "win32" ? "explorer.exe"
    : process.platform === "darwin" ? "open"
      : process.platform === "linux" ? "xdg-open"
        : null;
  if (!executable) return Promise.reject(new Error("Opening export folders is not supported on this platform."));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [directory], { detached: true, stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

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

async function selectLibraryRoot(path: string): Promise<string> {
  const selected = await realpath(resolve(path));
  if (!(await stat(selected)).isDirectory()) throw new Error("The selected path is not a folder.");
  const hasCatalog = await Bun.file(join(selected, "catalog.json")).exists();
  if (!hasCatalog) {
    const entries = await readdir(selected, { withFileTypes: true });
    if (!entries.some((entry) => entry.isDirectory() || /\.(?:atlas|skel)$/i.test(entry.name))) {
      throw new Error("The selected folder does not look like a Spine asset library.");
    }
  }
  assetRoot = selected;
  catalogCache = null;
  try { await writeLastLibraryPath(viewerLibraryPreferencePath, selected); }
  catch (error) { console.warn("[ba-spine-viewer] could not remember the selected library", error); }
  return selected;
}

async function rootRelativePath(value: string): Promise<string> {
  const root = await rootPath();
  const full = resolveLibraryPath(root, value);
  const actual = await realpath(full);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Path is outside the selected asset library.");
  return actual;
}

async function requestedRootPath(url: URL): Promise<string> {
  const requested = url.searchParams.get("rootPath");
  if (!requested) throw new Error("The Viewer request is missing its selected library identity.");
  const selected = await realpath(resolve(requested));
  if (selected !== await rootPath()) throw new Error("The selected library changed; reload the Viewer library before retrying.");
  return selected;
}

async function ignoreRulesFor(root: string): Promise<EditorIgnoreRule[]> {
  try {
    return parseEditorIgnore(await readFile(join(root, ".editorignore"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function ignoreRules(): Promise<EditorIgnoreRule[]> {
  return ignoreRulesFor(await rootPath());
}

function ignored(path: string, rules: readonly EditorIgnoreRule[], isDirectory = false): boolean {
  const first = path.split("/")[0]?.toLocaleLowerCase() ?? "";
  return EDITOR_DIRECTORIES.has(first) || isEditorIgnored(path, rules, isDirectory);
}

function closeLibraryWatcher() {
  libraryChangeDebouncer?.cancel();
  libraryChangeDebouncer = null;
  pendingLibraryPaths.clear();
  libraryWatcher?.close();
  libraryWatcher = null;
  libraryWatcherRoot = null;
  libraryWatcherAvailable = false;
}

function queueLibraryChange(root: string, filename: string | null) {
  if (libraryWatcherRoot !== root) return;
  pendingLibraryPaths.add(filename?.replaceAll("\\", "/") ?? null);
  libraryChangeDebouncer?.schedule();
}

function createLibraryChangeDebouncer(root: string) {
  return createDebouncedAction(300, () => {
    const changedPaths = [...pendingLibraryPaths];
    pendingLibraryPaths.clear();
    void ignoreRulesFor(root).then((rules) => {
      if (libraryWatcherRoot !== root) return;
      const relevant = changedPaths.some((path) => path === null || path === ".editorignore" || !ignored(path, rules));
      if (!relevant) return;
      catalogCache = null;
      libraryChangeRevision++;
    }).catch(() => {
      if (libraryWatcherRoot !== root) return;
      catalogCache = null;
      libraryChangeRevision++;
    });
  });
}

async function ensureLibraryWatcher(root: string): Promise<void> {
  if (libraryWatcherRoot === root) return;
  closeLibraryWatcher();
  libraryWatcherRoot = root;
  libraryChangeRevision = 0;
  libraryChangeDebouncer = createLibraryChangeDebouncer(root);
  try {
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      queueLibraryChange(root, filename === null ? null : filename.toString());
    });
    libraryWatcher = watcher;
    libraryWatcherAvailable = true;
    watcher.on("error", () => {
      if (libraryWatcher !== watcher) return;
      watcher.close();
      libraryWatcher = null;
      libraryWatcherAvailable = false;
      libraryChangeDebouncer?.cancel();
      libraryChangeDebouncer = null;
      pendingLibraryPaths.clear();
    });
  } catch {
    libraryChangeDebouncer?.cancel();
    libraryChangeDebouncer = null;
    libraryWatcher = null;
    libraryWatcherAvailable = false;
  }
}

async function catalog() {
  const root = await rootPath();
  if (catalogCache?.rootPath === root) return catalogCache.promise;
  const promise = discoverSpineSets(createNodeLibraryReader(root), {
    includeRelated: true,
    manifestConcurrency: 12,
  });
  catalogCache = { rootPath: root, promise };
  try { return await promise; }
  catch (error) {
    if (catalogCache?.promise === promise) catalogCache = null;
    throw error;
  }
}

const THUMBNAIL_SOURCE_FILE = /\.(?:atlas|skel|png|webp|jpe?g)$/i;

async function thumbnailSourcePaths(directory: string, libraryRoot: string): Promise<string[]> {
  if (await rootPath() !== libraryRoot) throw new Error("The selected library changed; retry thumbnail generation.");
  const discovered = await catalog();
  const set = discovered.find((item) => item.directory === directory);
  if (!set) throw new Error(`Spine directory not found: ${directory}`);
  const indexedPaths = (set.files ?? []).filter((path) => THUMBNAIL_SOURCE_FILE.test(path));
  if (indexedPaths.length > 0) return [...new Set(indexedPaths)].sort();

  if (/manifest\.json$/i.test(set.path)) {
    try {
      const full = await rootRelativePath(set.path);
      const raw = JSON.parse(await readFile(full, "utf8")) as unknown;
      const manifest = normalizeSpineManifest(raw, directory);
      const assets = manifest?.assets[directory];
      if (manifest && assets) {
        const record = { manifest, path: set.path };
        const references = [assets.atlas, ...assets.skeletons, ...assets.pages, ...assets.files];
        return [...new Set(references.flatMap((reference) => manifestReferenceCandidates(record, reference).slice(0, 1)))]
          .filter((path) => THUMBNAIL_SOURCE_FILE.test(path)).sort();
      }
    } catch {
      // Fall through to legacy folder discovery if a manifest cannot describe the set.
    }
  }

  const folder = set.path === "." ? libraryRoot : await rootRelativePath(set.path);
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && THUMBNAIL_SOURCE_FILE.test(entry.name))
    .map((entry) => [set.path === "." ? "" : set.path, entry.name].filter(Boolean).join("/"))
    .sort();
}

async function thumbnailFingerprint(directory: string, libraryRoot: string): Promise<string> {
  const rules = await ignoreRules();
  const paths = (await thumbnailSourcePaths(directory, libraryRoot)).filter((path) => !ignored(path, rules));
  const parts = await Promise.all(paths.map(async (path) => {
    const fullPath = await rootRelativePath(path);
    const info = await stat(fullPath);
    return `${path}\0${info.size}\0${info.mtimeMs}`;
  }));
  if (parts.length === 0) throw new Error(`No Spine source files were found for ${directory}.`);
  return `sha256:${createHash("sha256").update(parts.sort().join("\n")).digest("hex")}`;
}

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`Request body exceeds the ${maxBytes} byte safety limit.`);
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
  return bytes;
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
    if (url.pathname === "/__spine/suite-update/status" && request.method === "GET") {
      if (!portableSuite) return json({ supported: false, suiteVersion: null, status: "unsupported", version: null });
      const supported = await hasPortableSuiteUpdater(portableSuite.root);
      const version = url.searchParams.get("version");
      const update = supported && version
        ? await getPortableSuiteUpdateStatus(portableSuite.root, version)
        : { status: supported ? "idle" : "unsupported", version: null };
      const editorHasUnsavedChanges = await hasLiveEditorSuiteUpdateChanges(suiteUpdateRoamingRoot);
      return json({ supported, suiteVersion: portableSuite.manifest.suiteVersion, editorHasUnsavedChanges, ...update });
    }
    if (url.pathname === "/__spine/suite-update/download" && request.method === "POST") {
      if (!portableSuite || !await hasPortableSuiteUpdater(portableSuite.root)) return errorResponse("Automatic updates are available only in an installed portable suite.", 404);
      const body = await request.json() as { version?: unknown };
      if (typeof body.version !== "string" || !isNewerPortableSuiteVersion(body.version, portableSuite.manifest.suiteVersion)) {
        return errorResponse("The requested suite update version is invalid or not newer than this installation.");
      }
      return json(await downloadPortableSuiteUpdate(portableSuite.root, body.version));
    }
    if (url.pathname === "/__spine/suite-update/install" && request.method === "POST") {
      if (!portableSuite) return errorResponse("Automatic updates are available only in an installed portable suite.", 404);
      if (await hasLiveEditorSuiteUpdateChanges(suiteUpdateRoamingRoot)) return errorResponse("Save or discard the open Editor's changes before installing a suite update.", 409);
      const body = await request.json() as { version?: unknown };
      if (typeof body.version !== "string" || !isNewerPortableSuiteVersion(body.version, portableSuite.manifest.suiteVersion)) {
        return errorResponse("The requested suite update version is invalid or not newer than this installation.");
      }
      const updaterPath = join(portableSuite.root, "SuiteUpdater.exe");
      if (!await hasPortableSuiteUpdater(portableSuite.root)) return errorResponse("The suite updater is missing or invalid. Install the latest portable suite manually.", 409);
      const staged = await getStagedPortableSuiteUpdate(portableSuite.root, body.version);
      await startSuiteUpdater(updaterPath, portableSuite.root, staged.archivePath, staged.sha256, staged.version, "viewer");
      setTimeout(() => process.exit(0), 250);
      return json({ status: "installing", version: staged.version });
    }
    if (url.pathname === "/__spine/root") return json({ rootPath: assetRoot });
    if (url.pathname === "/__spine/window/fullscreen" && request.method === "GET") {
      return json({ fullScreen: window?.isFullScreen() ?? false });
    }
    if (url.pathname === "/__spine/window/fullscreen" && request.method === "POST") {
      const body = await request.json() as { fullScreen?: unknown };
      if (typeof body.fullScreen !== "boolean") return errorResponse("A fullscreen state is required.");
      const nativeWindow = window;
      if (!nativeWindow) return errorResponse("The Viewer window is unavailable.", 503);
      nativeWindow.setFullScreen(body.fullScreen);
      syncViewerApplicationMenu(body.fullScreen);
      return json({ fullScreen: body.fullScreen });
    }
    if (url.pathname === "/__spine/video/location" && request.method === "POST") {
      const selected = await Utils.openFileDialog({
        startingFolder: videoSaveDirectory ?? Utils.paths.home,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      if (!selected[0]) {
        videoSaveDirectory = null;
        return json({ directoryName: null });
      }
      const selectedPath = await realpath(resolve(selected[0]));
      if (!(await stat(selectedPath)).isDirectory()) return errorResponse("Choose a folder for the video export.");
      videoSaveDirectory = selectedPath;
      return json({ directoryName: basename(selectedPath) });
    }
    if (url.pathname === "/__spine/video/save" && request.method === "POST") {
      if (!videoSaveDirectory) return errorResponse("Choose a video export folder before recording.");
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
      if (contentType !== "video/webm" && contentType !== "video/mp4") return errorResponse("Only WebM and MP4 video exports are supported.");
      const bytes = await readBoundedBytes(request, MAX_VIEWER_VIDEO_BYTES);
      if (!bytes) return errorResponse("The video export is empty.");
      let requestedName = request.headers.get("x-ba-spine-video-name") ?? "spine-recording";
      try { requestedName = decodeURIComponent(requestedName); } catch { return errorResponse("The video filename is invalid."); }
      const expectedExtension = contentType === "video/webm" ? ".webm" : ".mp4";
      const withoutExtension = requestedName.replace(/\.[^.]*$/, "") || "spine-recording";
      const savedAs = await saveVideoWithoutOverwrite(videoSaveDirectory, `${withoutExtension}${expectedExtension}`, bytes);
      lastVideoExportDirectory = videoSaveDirectory;
      videoSaveDirectory = null;
      return json({ fileName: savedAs });
    }
    if (url.pathname === "/__spine/video/open-folder" && request.method === "POST") {
      const directory = lastVideoExportDirectory;
      if (!directory) return errorResponse("The last video export folder is unavailable.");
      const directoryInfo = await stat(directory).catch(() => null);
      if (!directoryInfo?.isDirectory()) return errorResponse("The last video export folder is unavailable.");
      await openDirectoryInFileManager(directory);
      return json({ opened: true });
    }
    if (url.pathname === "/__spine/video/ffmpeg/support" && request.method === "GET") {
      return json(await ffmpegVideoRecorder.support());
    }
    if (url.pathname === "/__spine/video/ffmpeg/start" && request.method === "POST") {
      if (!videoSaveDirectory) return errorResponse("Choose a video export folder before recording.");
      const selectedExportDirectory = videoSaveDirectory;
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.filename !== "string" || typeof body.width !== "number" || typeof body.height !== "number"
        || typeof body.frameRate !== "number" || (body.format !== "webm" && body.format !== "mp4")) {
        return errorResponse("The FFmpeg recording settings are invalid.");
      }
      if (body.quality !== undefined && body.quality !== "high" && body.quality !== "balanced" && body.quality !== "compact") {
        return errorResponse("The FFmpeg recording quality is invalid.");
      }
      const sessionId = await ffmpegVideoRecorder.start({
        filename: body.filename,
        width: body.width,
        height: body.height,
        frameRate: body.frameRate as 30 | 60,
        format: body.format,
        quality: body.quality as "high" | "balanced" | "compact" | undefined,
      }, selectedExportDirectory);
      if (videoSaveDirectory === selectedExportDirectory) videoSaveDirectory = null;
      return json({ sessionId });
    }
    if (url.pathname === "/__spine/video/ffmpeg/audio" && request.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
      if (contentType && contentType !== "application/octet-stream" && !contentType.startsWith("audio/")) {
        return errorResponse("The Viewer audio track is invalid.");
      }
      const bytes = await readBoundedBytes(request, 256 * 1024 * 1024);
      if (!bytes) return errorResponse("The Viewer audio track is empty.");
      await ffmpegVideoRecorder.addAudioTrack(sessionId, {
        start: Number(request.headers.get("x-ba-spine-audio-start")),
        duration: Number(request.headers.get("x-ba-spine-audio-duration")),
        volume: Number(request.headers.get("x-ba-spine-audio-volume")),
        extension: request.headers.get("x-ba-spine-audio-extension") ?? "",
        bytes,
      });
      return json({ added: true });
    }
    if (url.pathname === "/__spine/video/ffmpeg/status" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const status = ffmpegVideoRecorder.status(sessionId);
      return status ? json(status) : errorResponse("The Viewer FFmpeg recording session is unavailable.", 404);
    }
    if (url.pathname === "/__spine/video/ffmpeg/finish" && request.method === "POST") {
      const sessionId = request.headers.get("x-ba-spine-video-session") ?? "";
      const frameCount = Number(request.headers.get("x-ba-spine-video-frames"));
      const { exportDirectory, ...result } = await ffmpegVideoRecorder.finish(sessionId, frameCount);
      lastVideoExportDirectory = exportDirectory;
      return json(result);
    }
    if (url.pathname === "/__spine/video/ffmpeg/cancel" && request.method === "POST") {
      const body = await request.json() as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || !body.sessionId) return errorResponse("The FFmpeg recording session is invalid.");
      await ffmpegVideoRecorder.cancel(body.sessionId);
      return json({ canceled: true });
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
      if (message.targetApp !== "editor") return errorResponse("The viewer can only hand off to the editor.");
      await sendCompanionHandoff(message, {
        autoLaunch: { resolvePlan: (targetApp) => launchPlanFor(targetApp), ...(portableSuite ? { preferResolvedPlan: true } : {}) },
      });
      return json({ ok: true, requestId: message.requestId });
    }
    if (url.pathname === "/__spine/companion/draft-read" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const snapshot = await readCompanionDraftSnapshot(sessionId);
      return json({ snapshot });
    }
    if (url.pathname === "/__spine/open-root" && request.method === "POST") {
      const selected = await Utils.openFileDialog({
        startingFolder: assetRoot ?? Utils.paths.home,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      if (selected[0]) await selectLibraryRoot(selected[0]);
      return json({ rootPath: assetRoot });
    }
    if (url.pathname === "/__spine/use-root" && request.method === "POST") {
      const body = await request.json() as { rootPath?: unknown };
      if (typeof body.rootPath !== "string" || !body.rootPath) return errorResponse("A library folder is required.");
      await selectLibraryRoot(body.rootPath);
      return json({ rootPath: assetRoot });
    }
    if (url.pathname === "/__spine/catalog") {
      await requestedRootPath(url);
      return json({ rootPath: await rootPath(), sets: await catalog() });
    }
    if (url.pathname === "/__spine/changes" && request.method === "GET") {
      const root = await requestedRootPath(url);
      await ensureLibraryWatcher(root);
      return json({ revision: libraryChangeRevision, watching: libraryWatcherAvailable });
    }
    if (url.pathname === "/__spine/refresh" && request.method === "POST") {
      const root = await requestedRootPath(url);
      await ensureLibraryWatcher(root);
      catalogCache = null;
      libraryChangeRevision++;
      return json({ revision: libraryChangeRevision });
    }
    if (url.pathname === "/__spine/files") {
      await requestedRootPath(url);
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
      await requestedRootPath(url);
      const path = safeRelativePath(url.searchParams.get("path") ?? "");
      if (ignored(path, await ignoreRules())) return errorResponse("File excluded by .editorignore.", 404);
      const full = await rootRelativePath(path);
      const file = Bun.file(full);
      if (!(await file.exists())) return errorResponse("File not found.", 404);
      const info = await stat(full);
      return new Response(file, { headers: {
        "content-type": contentType(full),
        "cache-control": "no-store",
        "x-ba-spine-file-mtime": String(info.mtimeMs),
        "x-ba-spine-file-size": String(info.size),
      } });
    }
    if (url.pathname === "/__spine/thumbnail/fingerprint" && request.method === "GET") {
      const root = await requestedRootPath(url);
      const directory = safeRelativePath(url.searchParams.get("directory") ?? "");
      return json({ fingerprint: await thumbnailFingerprint(directory, root) });
    }
    if (url.pathname === "/__spine/thumbnail" && request.method === "GET") {
      const root = await requestedRootPath(url);
      const directory = safeRelativePath(url.searchParams.get("directory") ?? "");
      const fingerprint = url.searchParams.get("fingerprint") ?? "";
      const thumbnail = await viewerThumbnailCache.get(root, directory, fingerprint);
      if (!thumbnail) return errorResponse("Thumbnail is not cached.", 404);
      const body = new Uint8Array(thumbnail.bytes.byteLength);
      body.set(thumbnail.bytes);
      return new Response(body.buffer as ArrayBuffer, { headers: { "content-type": thumbnail.contentType, "cache-control": "no-store" } });
    }
    if (url.pathname === "/__spine/thumbnail" && request.method === "POST") {
      const root = await requestedRootPath(url);
      const directory = safeRelativePath(url.searchParams.get("directory") ?? "");
      const fingerprint = url.searchParams.get("fingerprint") ?? "";
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
      if (contentType !== "image/webp" && contentType !== "image/png") return errorResponse("Viewer thumbnails must be WebP or PNG images.");
      const bytes = await readBoundedBytes(request, MAX_VIEWER_THUMBNAIL_BYTES);
      if (!bytes) return errorResponse("Viewer thumbnail content is required.");
      await viewerThumbnailCache.put(root, directory, fingerprint, contentType, bytes);
      return json({ ok: true });
    }
    if (url.pathname === "/__spine/thumbnail" && request.method === "DELETE") {
      const root = await requestedRootPath(url);
      const directory = safeRelativePath(url.searchParams.get("directory") ?? "");
      await viewerThumbnailCache.invalidate(root, directory);
      return json({ ok: true });
    }
    return errorResponse("Unknown viewer endpoint.", 404);
  } catch (error) {
    return errorResponse(error, error instanceof CompanionUnavailableError ? 503 : 400);
  }
}

function startSuiteUpdater(executable: string, suiteRoot: string, archivePath: string, sha256: string, version: string, app: "viewer" | "editor"): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["--install", archivePath, sha256, version, app], {
      cwd: suiteRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

const staticRoot = resolve(import.meta.dir, "../views/viewer");
const apiToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: {
    data: {} as { sessionId: string },
    maxPayloadLength: 8 * 1024 * 1024,
    idleTimeout: 120,
    perMessageDeflate: false,
    open(socket) { ffmpegVideoRecorder.attachSocket(socket.data.sessionId, socket); },
    message(socket, message) { ffmpegVideoRecorder.writeFrame(socket.data.sessionId, socket, message); },
    close(socket) { ffmpegVideoRecorder.socketClosed(socket.data.sessionId, socket); },
  },
  async fetch(request, host) {
    const url = new URL(request.url);
    if (url.pathname === COMPANION_HANDOFF_PATH || url.pathname === COMPANION_HEALTH_PATH || url.pathname === COMPANION_ACTIVATE_PATH) return companionInbox.handle(request);
    if (url.pathname === "/__spine/video/ffmpeg/stream") {
      if (url.searchParams.get("token") !== apiToken) return errorResponse("Unauthorized video stream.", 403);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!ffmpegVideoRecorder.claimSocket(sessionId)) return errorResponse("The FFmpeg recording session is unavailable.", 404);
      if (!host.upgrade(request, { data: { sessionId } })) {
        ffmpegVideoRecorder.releaseSocketClaim(sessionId);
        return errorResponse("Could not open the Viewer video stream.", 400);
      }
      return;
    }
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
  companionRegistration = await registerCompanionEndpoint("viewer", server.port, {
    token: companionInbox.token,
    ...(!portableSuite ? { launchPlan: launchPlanFor("viewer") } : {}),
  });
} catch (error) {
  server.stop(true);
  if (error instanceof CompanionAlreadyRunningError) process.exit(0);
  throw error;
}
const shutdownViewerHost = onceDesktopHostShutdown(() => {
  closeLibraryWatcher();
  companionRegistration.close();
  server.stop(true);
});
process.once("exit", shutdownViewerHost);

const viewerWindowStatePath = join(Utils.paths.appData, "BA Spine Suite", "Viewer", "window-state.json");
function connectedDisplays(): WindowDisplay[] {
  try {
    const displays = Screen.getAllDisplays();
    return displays.length ? displays : [Screen.getPrimaryDisplay()];
  } catch {
    try { return [Screen.getPrimaryDisplay()]; } catch { return []; }
  }
}
const initialDisplays = connectedDisplays();
const viewerMinimumWindowSize = { width: 760, height: 560 };
const restoredWindowState = restoreDesktopWindowState(await readDesktopWindowState(viewerWindowStatePath), initialDisplays, viewerMinimumWindowSize);
const defaultWindowFrame = defaultDesktopWindowFrame(initialDisplays, { width: 1440, height: 940 }, viewerMinimumWindowSize);
let nativeWindow: BrowserWindow;
try {
  nativeWindow = new BrowserWindow({
    title: "BA Spine Viewer",
    url: `http://${server.hostname}:${server.port}/`,
    frame: restoredWindowState?.frame ?? defaultWindowFrame ?? { width: 1440, height: 940 },
  });
  window = nativeWindow;
  if (process.platform === "win32" && process.arch === "x64") {
    const removeNativeMinimum = installWindowsNativeWindowMinimum(nativeWindow, viewerMinimumWindowSize.width, viewerMinimumWindowSize.height);
    if (!removeNativeMinimum) throw new Error("Could not install the native Windows 760 × 560 minimum-size hook.");
    nativeWindow.on("close", removeNativeMinimum);
    console.log("[ba-spine-viewer] hard native minimum 760 × 560 logical pixels installed");
  } else if (process.platform === "win32") {
    console.warn(`[ba-spine-viewer] native minimum hook is unavailable on ${process.arch}; using the resize correction fallback`);
  }
} catch (error) {
  try { (window as (BrowserWindow & { close(): void }) | null)?.close(); } catch { /* preserve the original native-window error */ }
  window = null;
  shutdownViewerHost();
  throw error;
}
nativeWindow.on("close", shutdownViewerHost);
const applyNativeMinimum = () => {
  enforceDesktopWindowMinimum(nativeWindow, connectedDisplays(), viewerMinimumWindowSize);
};
applyNativeMinimum();
nativeWindow.on("move", applyNativeMinimum);
nativeWindow.on("resize", applyNativeMinimum);
nativeWindow.on("resize", () => syncViewerApplicationMenu(nativeWindow.isFullScreen()));
if (restoredWindowState?.maximized) nativeWindow.maximize();
syncViewerApplicationMenu(nativeWindow.isFullScreen());
startDesktopWindowStatePersistence(nativeWindow, viewerWindowStatePath, connectedDisplays, (error) => console.warn("[ba-spine-viewer] could not save window state", error));

void window;
