import type { SpineFiles } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { AssetSource } from "@ba-spine/spine-runtime/spine/spineAssets";
import { manifestReferenceCandidates, normalizeSpineManifest, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { parseHandoffMessage, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";

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

export function sourceFromDesktop(rootPath: string): DesktopAssetSource {
  let catalogPromise: Promise<DesktopCatalog> | null = null;
  const manifests = new Map<string, Promise<SpineManifestRecord | null>>();
  const loadCatalog = () => catalogPromise ??= request("/__spine/catalog").then((response) => response.json() as Promise<DesktopCatalog>);

  const loadFile = async (path: string): Promise<File | null> => {
    const response = await request(`/__spine/file?path=${encodeURIComponent(path)}`).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("(404)")) return null;
      throw error;
    });
    if (!response) return null;
    const blob = await response.blob();
    return new File([blob], path.split("/").at(-1) ?? "asset");
  };

  const filesForSet = async (set: SpineSet): Promise<SpineFiles> => {
    let paths = set.files;
    if (!paths) {
      const query = encodeURIComponent(set.path);
      const result = await request(`/__spine/files?directory=${query}`).then((response) => response.json()) as { files: string[] };
      paths = result.files.map((name) => set.path === "." ? name : `${set.path}/${name}`);
    }
    const entries = await Promise.all(paths.map(async (path) => [path, await loadFile(path)] as const));
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
  };
}
