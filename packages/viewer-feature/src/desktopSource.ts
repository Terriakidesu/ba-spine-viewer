import type { SpineFiles } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { AssetSource } from "@ba-spine/spine-runtime/spine/spineAssets";
import { manifestReferenceCandidates, normalizeSpineManifest, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { parseHandoffMessage, parseSpineDraftSnapshot, type SpineDraftSnapshot, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";

declare global {
  interface Window {
    __BA_SPINE_HOST_TOKEN__?: string;
  }
}

interface SpineSet {
  directory: string;
  path: string;
  files?: string[];
}

interface DesktopCatalog {
  rootPath: string | null;
  sets: SpineSet[];
}

export interface DesktopAssetSource extends AssetSource {
  readonly desktop: true;
  readonly rootPath: string;
  getThumbnailFingerprint: (directory: string, signal?: AbortSignal) => Promise<string>;
  getThumbnail: (directory: string, fingerprint: string, signal?: AbortSignal) => Promise<Blob | null>;
  getThumbnailFiles: (directory: string, signal?: AbortSignal) => Promise<SpineFiles>;
  putThumbnail: (directory: string, fingerprint: string, image: Blob, signal?: AbortSignal) => Promise<void>;
  invalidateThumbnail: (directory: string, signal?: AbortSignal) => Promise<void>;
  getLibraryChangeState: (signal?: AbortSignal) => Promise<{ revision: number; watching: boolean }>;
  refreshLibrary: (signal?: AbortSignal) => Promise<DesktopAssetSource>;
}

export interface DesktopFfmpegVideoSupport {
  available: boolean;
  formats: Array<"webm" | "mp4">;
  version: string | null;
  hardwareEncoders: string[];
}

export interface DesktopFfmpegVideoStream {
  sendFrame: (frame: Blob) => Promise<void>;
  close: () => Promise<void>;
}

export interface DesktopFfmpegVideoStatus {
  phase: "rendering" | "encoding" | "saving";
  progress: number;
  encoder?: string;
}

export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && Boolean(window.__BA_SPINE_HOST_TOKEN__);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (window.__BA_SPINE_HOST_TOKEN__) headers.set("x-ba-spine-token", window.__BA_SPINE_HOST_TOKEN__);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`${body.error ?? "Viewer request failed."} (${response.status})`);
  }
  return response;
}

/** Read the native desktop window's fullscreen state; null indicates web preview. */
export async function getDesktopFullscreen(): Promise<boolean | null> {
  if (!isDesktopHost()) return null;
  const result = await request("/__spine/window/fullscreen").then((response) => response.json()) as { fullScreen?: unknown };
  return typeof result.fullScreen === "boolean" ? result.fullScreen : null;
}

/** Use native fullscreen in the desktop app so the OS title and menu bars are hidden too. */
export async function setDesktopFullscreen(fullScreen: boolean): Promise<void> {
  if (!isDesktopHost()) return;
  await request("/__spine/window/fullscreen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fullScreen }),
  });
}

export async function chooseDesktopVideoDirectory(): Promise<string | null> {
  if (!isDesktopHost()) return null;
  const result = await request("/__spine/video/location", { method: "POST" }).then((response) => response.json()) as { directoryName?: unknown };
  return typeof result.directoryName === "string" && result.directoryName ? result.directoryName : null;
}

export async function saveDesktopVideo(blob: Blob, filename: string, format: "webm" | "mp4"): Promise<string> {
  const result = await request("/__spine/video/save", {
    method: "POST",
    headers: {
      "content-type": format === "webm" ? "video/webm" : "video/mp4",
      "x-ba-spine-video-name": encodeURIComponent(filename),
    },
    body: blob,
  }).then((response) => response.json()) as { fileName?: unknown };
  if (typeof result.fileName !== "string" || !result.fileName) throw new Error("The Viewer did not return the saved video filename.");
  return result.fileName;
}

export async function getDesktopFfmpegVideoSupport(): Promise<DesktopFfmpegVideoSupport | null> {
  if (!isDesktopHost()) return null;
  const support = await request("/__spine/video/ffmpeg/support").then((response) => response.json()) as Partial<DesktopFfmpegVideoSupport>;
  if (typeof support.available !== "boolean" || !Array.isArray(support.formats)) throw new Error("The Viewer returned invalid FFmpeg recording support.");
  return {
    available: support.available,
    formats: support.formats.filter((format): format is "webm" | "mp4" => format === "webm" || format === "mp4"),
    version: typeof support.version === "string" ? support.version : null,
    hardwareEncoders: Array.isArray(support.hardwareEncoders) ? support.hardwareEncoders.filter((encoder): encoder is string => typeof encoder === "string") : [],
  };
}

export async function startDesktopFfmpegVideoRecording(options: {
  filename: string;
  width: number;
  height: number;
  frameRate: number;
  format: "webm" | "mp4";
}): Promise<string> {
  const result = await request("/__spine/video/ffmpeg/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  }).then((response) => response.json()) as { sessionId?: unknown };
  if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("The Viewer did not start an FFmpeg recording session.");
  return result.sessionId;
}

export async function openDesktopFfmpegVideoStream(sessionId: string): Promise<DesktopFfmpegVideoStream> {
  if (!isDesktopHost() || !window.__BA_SPINE_HOST_TOKEN__) throw new Error("The native video stream is unavailable.");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ sessionId, token: window.__BA_SPINE_HOST_TOKEN__ });
  const socket = new WebSocket(`${protocol}//${window.location.host}/__spine/video/ffmpeg/stream?${query}`);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Could not connect to the Viewer FFmpeg recording stream.")); };
    const onClose = () => { cleanup(); reject(new Error("The Viewer FFmpeg recording stream closed before it was ready.")); };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
  return {
    async sendFrame(frame) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("The Viewer FFmpeg recording stream is closed.");
      while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 16 * 1024 * 1024) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 8));
      }
      if (socket.readyState !== WebSocket.OPEN) throw new Error("The Viewer FFmpeg recording stream closed while sending video frames.");
      socket.send(frame);
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
          };
          const onOpen = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error("Could not connect to the Viewer FFmpeg recording stream.")); };
          const onClose = () => { cleanup(); resolve(); };
          socket.addEventListener("open", onOpen, { once: true });
          socket.addEventListener("error", onError, { once: true });
          socket.addEventListener("close", onClose, { once: true });
        });
      }
      while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 8));
      }
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close(1000, "Recording complete.");
        if (socket.readyState === WebSocket.CLOSED) resolve();
      });
    },
  };
}

export async function addDesktopFfmpegAudioTrack(sessionId: string, track: {
  start: number;
  duration: number;
  volume: number;
  extension: string;
  file: Blob;
}): Promise<void> {
  const query = new URLSearchParams({ sessionId });
  await request(`/__spine/video/ffmpeg/audio?${query}`, {
    method: "POST",
    headers: {
      "content-type": track.file.type || "application/octet-stream",
      "x-ba-spine-audio-start": String(track.start),
      "x-ba-spine-audio-duration": String(track.duration),
      "x-ba-spine-audio-volume": String(track.volume),
      "x-ba-spine-audio-extension": track.extension,
    },
    body: track.file,
  });
}

export async function getDesktopFfmpegVideoStatus(sessionId: string): Promise<DesktopFfmpegVideoStatus> {
  const query = new URLSearchParams({ sessionId });
  const status = await request(`/__spine/video/ffmpeg/status?${query}`).then((response) => response.json()) as Partial<DesktopFfmpegVideoStatus>;
  if ((status.phase !== "rendering" && status.phase !== "encoding" && status.phase !== "saving")
    || typeof status.progress !== "number" || !Number.isFinite(status.progress)) {
    throw new Error("The Viewer returned an invalid FFmpeg export status.");
  }
  return { phase: status.phase, progress: Math.max(0, Math.min(1, status.progress)) };
}

export async function finishDesktopFfmpegVideoRecording(sessionId: string, frameCount: number): Promise<{ fileName: string; encoder: string }> {
  const result = await request("/__spine/video/ffmpeg/finish", {
    method: "POST",
    headers: {
      "x-ba-spine-video-session": sessionId,
      "x-ba-spine-video-frames": String(frameCount),
    },
  }).then((response) => response.json()) as { fileName?: unknown; encoder?: unknown };
  if (typeof result.fileName !== "string" || !result.fileName || typeof result.encoder !== "string" || !result.encoder) {
    throw new Error("The Viewer did not return the FFmpeg video export result.");
  }
  return { fileName: result.fileName, encoder: result.encoder };
}

export async function cancelDesktopFfmpegVideoRecording(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await request("/__spine/video/ffmpeg/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function loadDesktopSource(): Promise<DesktopAssetSource | null> {
  if (!isDesktopHost()) return null;
  const selected = await request("/__spine/root").then((response) => response.json()) as { rootPath: string | null };
  return selected.rootPath ? sourceFromDesktop(selected.rootPath) : null;
}

export async function chooseDesktopSource(): Promise<DesktopAssetSource | null> {
  if (!isDesktopHost()) return null;
  const selected = await request("/__spine/open-root", { method: "POST" }).then((response) => response.json()) as { rootPath: string | null };
  return selected.rootPath ? sourceFromDesktop(selected.rootPath) : null;
}

export async function chooseDesktopSourceAt(rootPath: string): Promise<DesktopAssetSource> {
  const selected = await request("/__spine/use-root", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath }),
  }).then((response) => response.json()) as { rootPath: string };
  return sourceFromDesktop(selected.rootPath);
}

export async function receiveDesktopHandoffs(): Promise<SpineHandoffMessage[]> {
  if (!isDesktopHost()) return [];
  const result = await request("/__spine/companion/pending").then((response) => response.json()) as { messages?: unknown };
  if (!Array.isArray(result.messages)) return [];
  return result.messages.map(parseHandoffMessage);
}

export async function acknowledgeDesktopHandoff(requestId: string): Promise<void> {
  await request("/__spine/companion/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestIds: [requestId] }),
  });
}

export async function sendDesktopHandoff(message: SpineHandoffMessage): Promise<void> {
  await request("/__spine/companion/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parseHandoffMessage(message)),
  });
}

export async function readDesktopDraftSnapshot(sessionId: string): Promise<SpineDraftSnapshot | null> {
  if (!isDesktopHost()) return null;
  const result = await request(`/__spine/companion/draft-read?sessionId=${encodeURIComponent(sessionId)}`)
    .then((response) => response.json()) as { snapshot?: unknown };
  return result.snapshot ? parseSpineDraftSnapshot(result.snapshot) : null;
}

export function sourceFromDesktop(rootPath: string): DesktopAssetSource {
  let catalogPromise: Promise<DesktopCatalog> | null = null;
  const manifests = new Map<string, Promise<SpineManifestRecord | null>>();
  const rootQuery = `rootPath=${encodeURIComponent(rootPath)}`;
  const loadCatalog = () => catalogPromise ??= request(`/__spine/catalog?${rootQuery}`).then((response) => response.json() as Promise<DesktopCatalog>);

  const loadFile = async (path: string, signal?: AbortSignal): Promise<File | null> => {
    const response = await request(`/__spine/file?path=${encodeURIComponent(path)}&${rootQuery}`, { signal }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("(404)")) return null;
      throw error;
    });
    if (!response) return null;
    const blob = await response.blob();
    const modifiedAt = Number(response.headers.get("x-ba-spine-file-mtime"));
    return new File([blob], path.split("/").at(-1) ?? "asset", Number.isFinite(modifiedAt) && modifiedAt > 0 ? { lastModified: modifiedAt } : undefined);
  };

  const filesForSet = async (set: SpineSet, signal?: AbortSignal): Promise<SpineFiles> => {
    let paths = set.files;
    if (!paths) {
      const query = encodeURIComponent(set.path);
      const result = await request(`/__spine/files?directory=${query}&${rootQuery}`, { signal }).then((response) => response.json()) as { files: string[] };
      paths = result.files.map((name) => set.path === "." ? name : `${set.path}/${name}`);
    }
    const entries = await Promise.all(paths.map(async (path) => [path, await loadFile(path, signal)] as const));
    return new Map(entries.flatMap(([path, file]) => file ? [[file.name || path.split("/").at(-1)!, file] as const] : [])) as SpineFiles;
  };

  const loadManifest = (directory: string): Promise<SpineManifestRecord | null> => {
    const cached = manifests.get(directory);
    if (cached) return cached;
    const promise = (async () => {
      for (const path of [`lobbies/${directory}/manifest.json`, "manifest.json"]) {
        const file = await loadFile(path);
        if (!file) continue;
        try {
          const manifest = normalizeSpineManifest(JSON.parse(await file.text()) as unknown, directory);
          if (manifest) return { manifest, path };
        } catch {
          // The viewer can still load legacy sets without a valid manifest.
        }
      }
      return null;
    })();
    manifests.set(directory, promise);
    return promise;
  };

  return {
    desktop: true,
    rootPath,
    getDirectories: async () => (await loadCatalog()).sets.map((set) => set.directory),
    getSetFiles: async (directory, signal) => {
      const set = (await loadCatalog()).sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return filesForSet(set, signal);
    },
    getThumbnailFiles: async (directory, signal) => {
      const set = (await loadCatalog()).sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return filesForSet(set, signal);
    },
    getSetFilesAtPath: async (path, signal) => {
      const wanted = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLocaleLowerCase();
      const set = (await loadCatalog()).sets.find((item) => item.path.toLocaleLowerCase() === wanted || item.files?.some((file) => file.toLocaleLowerCase().startsWith(`${wanted}/`)));
      if (!set) throw new Error(`Manifest Spine path not found: ${path}`);
      return filesForSet(set, signal);
    },
    getFile: loadFile,
    getManifest: loadManifest,
    getThumbnailFingerprint: async (directory, signal) => {
      const query = new URLSearchParams({ directory, rootPath });
      const result = await request(`/__spine/thumbnail/fingerprint?${query}`, { signal }).then((response) => response.json()) as { fingerprint?: unknown };
      if (typeof result.fingerprint !== "string") throw new Error(`Could not fingerprint thumbnail assets for ${directory}.`);
      return result.fingerprint;
    },
    getThumbnail: async (directory, fingerprint, signal) => {
      const query = new URLSearchParams({ directory, fingerprint, rootPath });
      const response = await request(`/__spine/thumbnail?${query}`, { signal }).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("(404)")) return null;
        throw error;
      });
      return response ? response.blob() : null;
    },
    putThumbnail: async (directory, fingerprint, image, signal) => {
      const query = new URLSearchParams({ directory, fingerprint, rootPath });
      await request(`/__spine/thumbnail?${query}`, { method: "POST", headers: { "content-type": image.type }, body: image, signal });
    },
    invalidateThumbnail: async (directory, signal) => {
      const query = new URLSearchParams({ directory, rootPath });
      await request(`/__spine/thumbnail?${query}`, { method: "DELETE", signal });
    },
    getLibraryChangeState: async (signal) => {
      const query = new URLSearchParams({ rootPath });
      const state = await request(`/__spine/changes?${query}`, { signal }).then((response) => response.json()) as { revision?: unknown; watching?: unknown };
      if (!Number.isSafeInteger(state.revision) || typeof state.watching !== "boolean") {
        throw new Error("The Viewer host returned invalid library change status.");
      }
      return { revision: state.revision as number, watching: state.watching };
    },
    refreshLibrary: async (signal) => {
      const query = new URLSearchParams({ rootPath });
      await request(`/__spine/refresh?${query}`, { method: "POST", signal });
      return sourceFromDesktop(rootPath);
    },
  };
}
