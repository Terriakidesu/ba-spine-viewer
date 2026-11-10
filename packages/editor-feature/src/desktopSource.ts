import type { SpineFiles } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { AssetSource } from "@ba-spine/spine-runtime/spine/spineAssets";
import { normalizeSpineManifest, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { parseHandoffMessage, parseSpineDraftSnapshot, type SpineDraftSnapshot, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";
import { createResourceQueue } from "@ba-spine/spine-runtime/spine/resourceQueue";

declare global {
  interface Window {
    __BA_SPINE_HOST_TOKEN__?: string;
  }
}

interface SpineSet { directory: string; path: string; files?: string[] }
interface Catalog { rootPath: string | null; sets: SpineSet[] }

export interface DesktopTextFile {
  path: string;
  content: string;
}

export interface DesktopSaveFile {
  path: string;
  content: string;
  expectedVersion: string;
}

export class DesktopSaveConflictError extends Error {
  constructor(readonly currentVersions: Record<string, string>) {
    super(`External changes detected in: ${Object.keys(currentVersions).join(", ")}`);
    this.name = "DesktopSaveConflictError";
  }
}

export interface DesktopAssetSource extends AssetSource {
  readonly desktop: true;
  readonly rootPath: string;
  openText: () => Promise<DesktopTextFile | null>;
  openProject: () => Promise<DesktopTextFile | null>;
  readText: (path: string) => Promise<string | null>;
  openAudio: () => Promise<string[]>;
  listAudioAssets?: () => Promise<{ assets: Array<{ path: string; sizeBytes: number; modifiedAt: string }>; truncated: boolean }>;
  saveText: (path: string, content: string) => Promise<void>;
  saveBatch: (files: readonly DesktopSaveFile[], overwriteVersions?: Readonly<Record<string, string>>) => Promise<{ backupPath: string | null }>;
}

export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && Boolean(window.__BA_SPINE_HOST_TOKEN__);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof window !== "undefined" && window.__BA_SPINE_HOST_TOKEN__) headers.set("x-ba-spine-token", window.__BA_SPINE_HOST_TOKEN__);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; currentVersions?: unknown };
    if (response.status === 409 && body.currentVersions && typeof body.currentVersions === "object" && !Array.isArray(body.currentVersions)) {
      throw new DesktopSaveConflictError(Object.fromEntries(Object.entries(body.currentVersions).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
    }
    throw new Error(body.error ?? `Desktop editor request failed (${response.status}).`);
  }
  return response;
}

const queueFileLoad = createResourceQueue(4);

async function loadFile(path: string, signal?: AbortSignal): Promise<File | null> {
  return queueFileLoad(async () => {
    signal?.throwIfAborted();
    const headers = new Headers();
    if (typeof window !== "undefined" && window.__BA_SPINE_HOST_TOKEN__) headers.set("x-ba-spine-token", window.__BA_SPINE_HOST_TOKEN__);
    const response = await fetch(`/__spine/file?path=${encodeURIComponent(path)}`, { headers, signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read ${path}.`);
    const blob = await response.blob();
    signal?.throwIfAborted();
    return new File([blob], path.split("/").at(-1) ?? "asset");
  }, signal);
}

export async function chooseDesktopSource(): Promise<DesktopAssetSource | null> {
  const selected = await request("/__spine/open-root", { method: "POST" }).then((response) => response.json()) as { rootPath: string | null };
  if (!selected.rootPath) return null;
  return sourceFromDesktop(selected.rootPath);
}

export async function chooseDesktopSourceAt(rootPath: string): Promise<DesktopAssetSource | null> {
  const selected = await request("/__spine/use-root", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath }),
  }).then((response) => response.json()) as { rootPath: string | null };
  if (!selected.rootPath) return null;
  return sourceFromDesktop(selected.rootPath);
}

export async function chooseDesktopProject(): Promise<{ source: DesktopAssetSource; file: DesktopTextFile } | null> {
  const selected = await request("/__spine/open-project", { method: "POST" }).then((response) => response.json()) as DesktopTextFile & { rootPath: string | null };
  if (!selected.rootPath || !selected.path) return null;
  return { source: sourceFromDesktop(selected.rootPath), file: { path: selected.path, content: selected.content } };
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

export async function publishDesktopDraft(snapshot: SpineDraftSnapshot): Promise<void> {
  await request("/__spine/companion/draft-publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parseSpineDraftSnapshot(snapshot)),
  });
}

export async function revokeDesktopDraft(sessionId: string): Promise<void> {
  await request("/__spine/companion/draft-revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function publishDesktopEditorSaveState(dirty: boolean): Promise<void> {
  if (!isDesktopHost()) return;
  await request("/__spine/suite-update/editor-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dirty }),
  });
}

export function sourceFromDesktop(rootPath: string): DesktopAssetSource {
  let catalogPromise: Promise<Catalog> | null = null;
  const manifestPromises = new Map<string, Promise<SpineManifestRecord | null>>();
  const loadCatalog = () => catalogPromise ??= request("/__spine/catalog").then((response) => response.json() as Promise<Catalog>);
  const filesForSet = async (set: SpineSet, signal?: AbortSignal): Promise<SpineFiles> => {
    signal?.throwIfAborted();
    if (set.files) {
      const entries = await Promise.all(set.files.map(async (path) => [path, await loadFile(path, signal)] as const));
      return new Map(entries.filter((entry): entry is [string, File] => entry[1] !== null).map(([path, file]) => [file.name || path.split("/").at(-1)!, file])) as SpineFiles;
    }
    const files = await request(`/__spine/files?directory=${encodeURIComponent(set.path)}`, { signal }).then((response) => response.json()) as { files: string[] };
    const entries = await Promise.all(files.files.map(async (name) => [name, await loadFile(set.path === "." ? name : `${set.path}/${name}`, signal)] as const));
    return new Map(entries.filter((entry): entry is [string, File] => entry[1] !== null)) as SpineFiles;
  };
  const loadManifest = (directory: string): Promise<SpineManifestRecord | null> => manifestPromises.get(directory) ?? (() => {
    const promise = (async () => {
      for (const path of [`lobbies/${directory}/manifest.json`, "manifest.json"]) {
        const content = await (async () => {
          const file = await loadFile(path);
          return file ? file.text() : null;
        })();
        if (content === null) continue;
        try {
          const manifest = normalizeSpineManifest(JSON.parse(content), directory);
          if (manifest) return { manifest, path };
        } catch {
          // Fall back to the legacy project loader when a manifest is malformed.
        }
      }
      return null;
    })();
    manifestPromises.set(directory, promise);
    void promise.then(
      () => { if (manifestPromises.get(directory) === promise) manifestPromises.delete(directory); },
      () => { if (manifestPromises.get(directory) === promise) manifestPromises.delete(directory); },
    );
    return promise;
  })();
  return {
    desktop: true,
    rootPath,
    getDirectories: async () => (await loadCatalog()).sets.map((set) => set.directory),
    getSetFiles: async (directory, signal) => {
      signal?.throwIfAborted();
      const set = (await loadCatalog()).sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return filesForSet(set, signal);
    },
    getSetFilesAtPath: async (path, signal) => {
      signal?.throwIfAborted();
      const wanted = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLocaleLowerCase();
      const set = (await loadCatalog()).sets.find((item) => item.path.toLocaleLowerCase() === wanted || item.files?.some((file) => file.toLocaleLowerCase().startsWith(`${wanted}/`)));
      if (!set) throw new Error(`Manifest Spine path not found: ${path}`);
      return filesForSet(set, signal);
    },
    getFile: loadFile,
    getManifest: loadManifest,
    openText: async () => {
      const selected = await request("/__spine/open-file", { method: "POST" }).then((response) => response.json()) as { path: string | null; content: string | null };
      return selected.path && selected.content !== null ? { path: selected.path, content: selected.content } : null;
    },
    openProject: async () => {
      const selected = await request("/__spine/open-project", { method: "POST" }).then((response) => response.json()) as { path: string | null; content: string | null };
      return selected.path && selected.content !== null ? { path: selected.path, content: selected.content } : null;
    },
    readText: async (path) => {
      const file = await loadFile(path);
      return file ? file.text() : null;
    },
    openAudio: async () => {
      const selected = await request("/__spine/open-audio", { method: "POST" }).then((response) => response.json()) as { paths?: unknown };
      return Array.isArray(selected.paths) ? selected.paths.filter((path): path is string => typeof path === "string") : [];
    },
    listAudioAssets: async () => {
      const value = await request("/__spine/audio-assets", { method: "GET" }).then((response) => response.json()) as { assets?: unknown; truncated?: unknown };
      const assets = Array.isArray(value.assets) ? value.assets.flatMap((asset) => {
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
        const item = asset as Record<string, unknown>;
        return typeof item.path === "string" && typeof item.sizeBytes === "number" && typeof item.modifiedAt === "string"
          ? [{ path: item.path, sizeBytes: item.sizeBytes, modifiedAt: item.modifiedAt }]
          : [];
      }) : [];
      return { assets, truncated: value.truncated === true };
    },
    saveText: async (path, content) => {
      const original = await (async () => {
        const file = await loadFile(path);
        return file ? file.text() : null;
      })();
      await request("/__spine/save-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ path, content, expectedVersion: contentVersion(original) }] }),
      });
    },
    saveBatch: async (files, overwriteVersions = {}) => {
      const result = await request("/__spine/save-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files, overwriteVersions }),
      }).then((response) => response.json()) as { backupPath?: unknown };
      return { backupPath: typeof result.backupPath === "string" ? result.backupPath : null };
    },
  };
}
