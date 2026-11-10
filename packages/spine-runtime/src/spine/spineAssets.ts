import type { SpineFiles } from "./spineRuntime";
import { isEditorIgnored, parseEditorIgnore, type EditorIgnoreRule } from "./editorIgnore";
import { manifestReferenceCandidates, normalizeSpineManifest, type SpineManifestAssetSet, type SpineManifestRecord } from "./spineManifest";

export interface CharacterVariant {
  variant: string;
  directory: string;
  assetId?: string;
  devName?: string;
}

export interface CharacterExtra {
  type: string;
  directory: string;
  assetId?: string;
  devName?: string;
}

export interface CharacterEntry {
  variants: CharacterVariant[];
  extras?: CharacterExtra[];
}

export interface IndexedAsset extends CharacterVariant {
  extraType?: string;
}

export function indexedAssets(entry: CharacterEntry | undefined): IndexedAsset[] {
  if (!entry) return [];
  return [
    ...entry.variants,
    ...(entry.extras ?? []).map(({ type, directory, assetId, devName }) => ({
      variant: type,
      directory,
      ...(assetId ? { assetId } : {}),
      ...(devName ? { devName } : {}),
      extraType: type,
    })),
  ];
}

export interface CharacterIndex {
  schemaVersion: number;
  characters: Record<string, CharacterEntry>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseCharacterIndex(value: unknown): CharacterIndex | null {
  const root = record(value);
  const rawCharacters = record(root?.characters);
  if (root?.schemaVersion !== 1 || !rawCharacters) return null;

  const characters: Record<string, CharacterEntry> = {};
  for (const [name, value] of Object.entries(rawCharacters)) {
    const rawEntry = record(value);
    if (!rawEntry || !Array.isArray(rawEntry.variants)) continue;
    const variants = rawEntry.variants.flatMap((value): CharacterVariant[] => {
      const item = record(value);
      if (typeof item?.variant !== "string" || typeof item.directory !== "string") return [];
      return [{
        variant: item.variant,
        directory: item.directory,
        ...(typeof item.assetId === "string" ? { assetId: item.assetId } : {}),
        ...(typeof item.devName === "string" ? { devName: item.devName } : {}),
      }];
    });
    if (!variants.length) continue;
    const extras = Array.isArray(rawEntry.extras)
      ? rawEntry.extras.flatMap((value): CharacterExtra[] => {
          const item = record(value);
          if (typeof item?.type !== "string" || typeof item.directory !== "string") return [];
          return [{
            type: item.type,
            directory: item.directory,
            ...(typeof item.assetId === "string" ? { assetId: item.assetId } : {}),
            ...(typeof item.devName === "string" ? { devName: item.devName } : {}),
          }];
        })
      : [];
    characters[name] = { variants, ...(extras.length ? { extras } : {}) };
  }
  return Object.keys(characters).length ? { schemaVersion: 1, characters } : null;
}

/** Prefer a valid selected-root catalog, while never carrying its private metadata into the viewer. */
export async function readCharacterIndex(source: AssetSource, fallback: CharacterIndex): Promise<CharacterIndex> {
  for (const path of ["characters.json", "catalog.json"]) {
    try {
      const file = await source.getFile(path);
      if (!file) continue;
      const index = parseCharacterIndex(JSON.parse(await file.text()) as unknown);
      if (index) return index;
    } catch {
      // A missing or malformed local catalog falls back to the next file or the bundled index.
    }
  }
  return fallback;
}

export interface AssetSource {
  getSetFiles: (directory: string, signal?: AbortSignal) => Promise<SpineFiles>;
  /** Resolve a manifest-declared root-relative Spine set path without inferring from directory names. */
  getSetFilesAtPath?: (path: string, signal?: AbortSignal) => Promise<SpineFiles>;
  getDirectories: () => Promise<string[]>;
  getFile: (path: string, signal?: AbortSignal) => Promise<File | null>;
  getManifest?: (directory: string) => Promise<SpineManifestRecord | null>;
}

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

type WebkitFile = File & { webkitRelativePath?: string };

const SPINE_SET_FILE = /\.(?:atlas|skel)$/i;
const EDITOR_DIRECTORIES = new Set([".editor", ".shittim-spine-editor"]);

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function filePathCandidates(path: string): string[] {
  const normalized = normalizedPath(path);
  const withoutAudioRoot = normalized.replace(/^audios\/voicelines\//i, "");
  const withoutAudios = normalized.replace(/^audios\//i, "");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return [...new Set([normalized, withoutAudioRoot, withoutAudios, basename])].filter(Boolean);
}

async function childDirectory(handle: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await handle.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function directoryEntries(handle: FileSystemDirectoryHandle): Promise<Array<[string, FileSystemHandle]>> {
  const entries: Array<[string, FileSystemHandle]> = [];
  for await (const entry of (handle as DirectoryHandleWithEntries).entries()) entries.push(entry);
  return entries;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isEditorDataPath(path: string): boolean {
  return EDITOR_DIRECTORIES.has(path.split("/")[0]?.toLocaleLowerCase() ?? "");
}

function ignored(path: string, rules: readonly EditorIgnoreRule[], isDirectory = false): boolean {
  return !isEditorDataPath(path) && isEditorIgnored(path, rules, isDirectory);
}

async function readIgnoreRules(root: FileSystemDirectoryHandle): Promise<EditorIgnoreRule[]> {
  const file = await fileAtPath(root, ".editorignore");
  if (!file) return [];
  try {
    return parseEditorIgnore(await file.text());
  } catch {
    return [];
  }
}

interface DirectoryAssetSet {
  directory: string;
  path: string;
  handle: FileSystemDirectoryHandle;
}

interface DirectoryCatalog {
  sets: DirectoryAssetSet[];
  manifests: Map<string, SpineManifestRecord>;
  rules: EditorIgnoreRule[];
}

async function catalogDirectory(handle: FileSystemDirectoryHandle, path: string, rules: readonly EditorIgnoreRule[]): Promise<DirectoryAssetSet[]> {
  if (isEditorDataPath(path) || ignored(path, rules, true)) return [];
  const entries = await directoryEntries(handle);
  const usableEntries = entries.filter(([name, entry]) => {
    const childPath = joinPath(path, name);
    return name !== "node_modules" && name !== ".git" && !isEditorDataPath(childPath) && !ignored(childPath, rules, entry.kind === "directory");
  });
  if (usableEntries.some(([name, entry]) => entry.kind === "file" && SPINE_SET_FILE.test(name))) {
    return [{ directory: handle.name, path: path || ".", handle }];
  }
  const children = await Promise.all(
    usableEntries
      .filter(([, entry]) => entry.kind === "directory")
      .map(([name, entry]) => catalogDirectory(entry as FileSystemDirectoryHandle, joinPath(path, name), rules)),
  );
  return children.flat();
}

async function catalogManifests(handle: FileSystemDirectoryHandle, path: string, rules: readonly EditorIgnoreRule[], output: Map<string, SpineManifestRecord>): Promise<void> {
  if (isEditorDataPath(path) || ignored(path, rules, true)) return;
  const entries = await directoryEntries(handle);
  await Promise.all(entries.map(async ([name, entry]) => {
    const childPath = joinPath(path, name);
    if (name === "node_modules" || name === ".git" || isEditorDataPath(childPath) || ignored(childPath, rules, entry.kind === "directory")) return;
    if (entry.kind === "file" && name.toLocaleLowerCase() === "manifest.json") {
      try {
        const parsed = normalizeSpineManifest(JSON.parse(await (entry as FileSystemFileHandle).getFile().then((file) => file.text())), path.split("/").at(-1));
        if (parsed) output.set(parsed.id, { manifest: parsed, path: childPath });
      } catch {
        // A malformed manifest should not hide legacy asset discovery.
      }
      return;
    }
    if (entry.kind === "directory") await catalogManifests(entry as FileSystemDirectoryHandle, childPath, rules, output);
  }));
}

async function filesInDirectory(handle: FileSystemDirectoryHandle, path: string, rules: readonly EditorIgnoreRule[]): Promise<SpineFiles> {
  const files: SpineFiles = new Map();
  for (const [name, entry] of await directoryEntries(handle)) {
    if (entry.kind === "file" && !ignored(joinPath(path, name), rules)) files.set(name, await (entry as FileSystemFileHandle).getFile());
  }
  return files;
}

async function fileAtPath(handle: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const parts = normalizedPath(path).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  let directory = handle;
  for (const part of parts.slice(0, -1)) {
    const next = await childDirectory(directory, part);
    if (!next) return null;
    directory = next;
  }
  try {
    return await directory.getFileHandle(parts.at(-1)!).then((entry) => entry.getFile());
  } catch {
    return null;
  }
}

export function sourceFromDirectory(root: FileSystemDirectoryHandle): AssetSource {
  let catalogPromise: Promise<DirectoryCatalog> | null = null;
  const loadCatalog = () => catalogPromise ??= (async () => {
    const rules = await readIgnoreRules(root);
    const manifests = new Map<string, SpineManifestRecord>();
    await catalogManifests(root, "", rules, manifests);
    const discovered = manifests.size > 0 ? [] : await catalogDirectory(root, "", rules);
    const unique = new Map<string, DirectoryAssetSet>();
    for (const set of discovered) if (!unique.has(set.directory)) unique.set(set.directory, set);
    return {
      sets: [...unique.values()].sort((a, b) => a.directory.localeCompare(b.directory, undefined, { sensitivity: "base" })),
      manifests,
      rules,
    };
  })();
  const filesFromManifest = async (record: SpineManifestRecord, assets: SpineManifestAssetSet): Promise<SpineFiles> => {
    const files: SpineFiles = new Map();
    for (const reference of assets.files) {
      for (const candidate of manifestReferenceCandidates(record, reference)) {
        const file = await fileAtPath(root, candidate);
        if (file) {
          files.set(file.name, file);
          break;
        }
      }
    }
    return files;
  };
  const filesFromManifestPath = async (path: string): Promise<SpineFiles> => {
    const catalog = await loadCatalog();
    const wanted = normalizedPath(path).replace(/\/+$/, "");
    for (const record of catalog.manifests.values()) {
      for (const assets of Object.values(record.manifest.assets)) {
        const hasPath = assets.files.some((reference) => manifestReferenceCandidates(record, reference)
          .some((candidate) => candidate.toLocaleLowerCase().startsWith(`${wanted.toLocaleLowerCase()}/`)));
        if (hasPath) return filesFromManifest(record, assets);
      }
    }
    throw new Error(`Manifest Spine path not found: ${path}`);
  };
  return {
    getDirectories: async () => {
      const catalog = await loadCatalog();
      if (catalog.manifests.size > 0) return [...catalog.manifests.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return catalog.sets.map((set) => set.directory);
    },
    getSetFiles: async (directory) => {
      const catalog = await loadCatalog();
      const manifestRecord = catalog.manifests.get(directory) ?? [...catalog.manifests.values()].find((record) => record.manifest.assets[directory]);
      const manifestAssets = manifestRecord?.manifest.assets[directory];
      if (manifestRecord && manifestAssets) return filesFromManifest(manifestRecord, manifestAssets);
      const set = catalog.sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return filesInDirectory(set.handle, set.path === "." ? "" : set.path, catalog.rules);
    },
    getSetFilesAtPath: filesFromManifestPath,
    getFile: async (path) => {
      const rules = (await loadCatalog()).rules;
      for (const candidate of filePathCandidates(path)) {
        const file = await fileAtPath(root, candidate);
        if (file && !ignored(candidate, rules)) return file;
      }
      return null;
    },
    getManifest: async (directory) => (await loadCatalog()).manifests.get(directory) ?? null,
  };
}

interface InputFile {
  path: string;
  file: File;
}

function inputFiles(fileList: FileList): { rootName: string; files: InputFile[] } {
  const files = [...fileList].map((file) => {
    const path = normalizedPath((file as WebkitFile).webkitRelativePath || file.name);
    const slash = path.indexOf("/");
    return { path: slash === -1 ? path : path.slice(slash + 1), file, rootName: slash === -1 ? path : path.slice(0, slash) };
  });
  return { rootName: files[0]?.rootName ?? "", files: files.map(({ path, file }) => ({ path, file })) };
}

interface InputAssetSet {
  directory: string;
  prefix: string;
}

interface InputCatalog {
  sets: InputAssetSet[];
  manifests: Map<string, SpineManifestRecord>;
  rules: EditorIgnoreRule[];
}

function inputAssetSets(files: readonly InputFile[], rootName: string, rules: readonly EditorIgnoreRule[]): InputAssetSet[] {
  const unique = new Map<string, InputAssetSet>();
  for (const entry of files) {
    if (!SPINE_SET_FILE.test(entry.path) || ignored(entry.path, rules)) continue;
    const slash = entry.path.lastIndexOf("/");
    const prefix = slash < 0 ? "" : entry.path.slice(0, slash + 1);
    const directory = slash < 0 ? rootName : entry.path.slice(0, slash).split("/").at(-1) ?? rootName;
    if (directory && !unique.has(directory)) unique.set(directory, { directory, prefix });
  }
  return [...unique.values()].sort((a, b) => a.directory.localeCompare(b.directory, undefined, { sensitivity: "base" }));
}

export function sourceFromInput(fileList: FileList): AssetSource {
  const { rootName, files } = inputFiles(fileList);
  let catalogPromise: Promise<InputCatalog> | null = null;
  const loadCatalog = () => catalogPromise ??= (async () => {
    const ignoreFile = files.find((entry) => entry.path.toLocaleLowerCase() === ".editorignore");
    const rules = ignoreFile ? parseEditorIgnore(await ignoreFile.file.text()) : [];
    const manifests = new Map<string, SpineManifestRecord>();
    for (const entry of files.filter((item) => item.path.toLocaleLowerCase().endsWith("/manifest.json") || item.path.toLocaleLowerCase() === "manifest.json")) {
      try {
        const parsed = normalizeSpineManifest(JSON.parse(await entry.file.text()), entry.path.split("/").at(-2) ?? rootName);
        if (parsed) manifests.set(parsed.id, { manifest: parsed, path: entry.path });
      } catch {
        // Ignore malformed manifests and retain the legacy input fallback.
      }
    }
    return { sets: inputAssetSets(files, rootName, rules), manifests, rules };
  })();
  const findFiles = (prefix: string, rules: readonly EditorIgnoreRule[]) => files
    .filter(({ path }) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && !ignored(path, rules))
    .map(({ path, file }) => [path.slice(prefix.length), file] as const);
  const findFile = (path: string): File | null => {
    const requested = normalizedPath(path);
    const lower = requested.toLocaleLowerCase();
    const exact = files.find((entry) => entry.path === requested || entry.path.toLocaleLowerCase() === lower);
    if (exact) return exact.file;
    const basename = lower.split("/").at(-1);
    if (!basename) return null;
    const matches = files.filter((entry) => entry.path.split("/").at(-1)?.toLocaleLowerCase() === basename);
    return matches.length === 1 ? matches[0]!.file : null;
  };
  const filesFromManifest = (record: SpineManifestRecord, assets: SpineManifestAssetSet): SpineFiles => {
    const entries: Array<[string, File]> = [];
    for (const reference of assets.files) {
      for (const candidate of manifestReferenceCandidates(record, reference)) {
        const file = findFile(candidate);
        if (file) {
          entries.push([file.name, file]);
          break;
        }
      }
    }
    return new Map(entries);
  };
  const filesFromManifestPath = async (path: string): Promise<SpineFiles> => {
    const catalog = await loadCatalog();
    const wanted = normalizedPath(path).replace(/\/+$/, "").toLocaleLowerCase();
    for (const record of catalog.manifests.values()) {
      for (const assets of Object.values(record.manifest.assets)) {
        const hasPath = assets.files.some((reference) => manifestReferenceCandidates(record, reference)
          .some((candidate) => candidate.toLocaleLowerCase().startsWith(`${wanted}/`)));
        if (hasPath) return filesFromManifest(record, assets);
      }
    }
    throw new Error(`Manifest Spine path not found: ${path}`);
  };

  return {
    getDirectories: async () => {
      const catalog = await loadCatalog();
      if (catalog.manifests.size > 0) return [...catalog.manifests.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return catalog.sets.map((set) => set.directory);
    },
    getSetFiles: async (directory) => {
      const catalog = await loadCatalog();
      const manifestRecord = catalog.manifests.get(directory) ?? [...catalog.manifests.values()].find((record) => record.manifest.assets[directory]);
      const manifestAssets = manifestRecord?.manifest.assets[directory];
      if (manifestRecord && manifestAssets) {
        return filesFromManifest(manifestRecord, manifestAssets);
      }
      const set = catalog.sets.find((item) => item.directory === directory);
      if (!set) throw new Error(`Spine directory not found: ${directory}`);
      return new Map(findFiles(set.prefix, catalog.rules));
    },
    getSetFilesAtPath: filesFromManifestPath,
    getFile: async (path) => {
      const rules = (await loadCatalog()).rules;
      for (const candidate of filePathCandidates(path)) {
        const file = findFile(candidate);
        if (file && !ignored(candidate, rules)) return file;
      }
      return null;
    },
    getManifest: async (directory) => (await loadCatalog()).manifests.get(directory) ?? null,
  };
}
