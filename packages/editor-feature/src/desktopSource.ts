import type { SpineFiles } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { AssetSource } from "@ba-spine/spine-runtime/spine/spineAssets";
import { normalizeSpineManifest, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { parseHandoffMessage, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";

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

export interface DesktopAssetSource extends AssetSource {
  readonly desktop: true;
  readonly rootPath: string;
  openText: () => Promise<DesktopTextFile | null>;
  openProject: () => Promise<DesktopTextFile | null>;
  readText: (path: string) => Promise<string | null>;
  openAudio: () => Promise<string[]>;
  saveText: (path: string, content: string) => Promise<void>;
}

export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && Boolean(window.__BA_SPINE_HOST_TOKEN__);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof window !== "undefined" && window.__BA_SPINE_HOST_TOKEN__) headers.set("x-ba-spine-token", window.__BA_SPINE_HOST_TOKEN__);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Desktop editor request failed (${response.status}).`);
  }
  return response;
}

async function loadFile(path: string): Promise<File | null> {
  const headers = new Headers();
  if (typeof window !== "undefined" && window.__BA_SPINE_HOST_TOKEN__) headers.set("x-ba-spine-token", window.__BA_SPINE_HOST_TOKEN__);
  const response = await fetch(`/__spine/file?path=${encodeURIComponent(path)}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${path}.`);
  const blob = await response.blob();
  return new File([blob], path.split("/").at(-1) ?? "asset");
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

export function sourceFromDesktop(rootPath: string): DesktopAssetSource {
  let catalogPromise: Promise<Catalog> | null = null;
  const manifestPromises = new Map<string, Promise<SpineManifestRecord | null>>();
  const loadCatalog = () => catalogPromise ??= request("/__spine/catalog").then((response) => response.json() as Promise<Catalog>);
  const filesForSet = async (set: SpineSet): Promise<SpineFiles> => {
    if (set.files) {
      const entries = await Promise.all(set.files.map(async (path) => [path, await loadFile(path)] as const));
      return new Map(entries.filter((entry): entry is [string, File] => entry[1] !== null).map(([path, file]) => [file.name || path.split("/").at(-1)!, file])) as SpineFiles;
    }
    const files = await request(`/__spine/files?directory=${encodeURIComponent(set.path)}`).then((response) => response.json()) as { files: string[] };
    const entries = await Promise.all(files.files.map(async (name) => [name, await loadFile(set.path === "." ? name : `${set.path}/${name}`)] as const));
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
    return promise;
  })();
  return {
    desktop: true,
    rootPath,
    getDirectories: async () => (await loadCatalog()).sets.map((set) => set.directory),
    getSetFiles: async (directory) => {
      const set = (await loadCatalog()).sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return filesForSet(set);
    },
    getSetFilesAtPath: async (path) => {
      const wanted = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLocaleLowerCase();
      const set = (await loadCatalog()).sets.find((item) => item.path.toLocaleLowerCase() === wanted || item.files?.some((file) => file.toLocaleLowerCase().startsWith(`${wanted}/`)));
      if (!set) throw new Error(`Manifest Spine path not found: ${path}`);
      return filesForSet(set);
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
    saveText: async (path, content) => {
      await request("/__spine/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) });
    },
  };
}
