import { isEditorIgnored, parseEditorIgnore, type EditorIgnoreRule } from "@ba-spine/spine-runtime/spine/editorIgnore";
import { manifestReferenceCandidates, normalizeSpineCatalog, normalizeSpineManifest, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";

export interface LibraryEntry {
  name: string;
  kind: "file" | "directory";
}

export interface LibraryReader {
  readText(path: string): Promise<string | null>;
  readDirectory(path: string): Promise<LibraryEntry[]>;
}

export interface SpineSet {
  directory: string;
  path: string;
  files?: string[];
}

export interface DiscoverSpineSetsOptions {
  /** Include related scene/background sets in addition to each lobby's primary set. */
  includeRelated?: boolean;
  manifestConcurrency?: number;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await map(items[index]!);
    }
  }));
  return output;
}

async function manifests(reader: LibraryReader, concurrency: number, rules: readonly EditorIgnoreRule[]): Promise<SpineManifestRecord[]> {
  const paths: string[] = [];
  try {
    const catalog = normalizeSpineCatalog(JSON.parse((await reader.readText("catalog.json")) ?? "null") as unknown);
    if (catalog) paths.push(...Object.values(catalog.lobbies).map((item) => item.manifest).filter((path) => !isEditorIgnored(path, rules)));
  } catch {
    // Root-manifest and recursive legacy discovery remain available.
  }
  if (paths.length === 0 && !isEditorIgnored("manifest.json", rules)) paths.push("manifest.json");

  const records = await mapConcurrent([...new Set(paths)], concurrency, async (path) => {
    try {
      const content = await reader.readText(path);
      if (content === null) return null;
      const fallbackId = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
      const manifest = normalizeSpineManifest(JSON.parse(content) as unknown, fallbackId);
      return manifest ? { manifest, path: path.replaceAll("\\", "/") } : null;
    } catch {
      return null;
    }
  });
  return records.filter((record): record is SpineManifestRecord => record !== null);
}

async function ignoreRules(reader: LibraryReader): Promise<EditorIgnoreRule[]> {
  try {
    return parseEditorIgnore((await reader.readText(".editorignore")) ?? "");
  } catch {
    return [];
  }
}

async function discoverLegacy(reader: LibraryReader, rules: readonly EditorIgnoreRule[]): Promise<SpineSet[]> {
  const output: SpineSet[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await reader.readDirectory(directory);
    const usable = entries.filter((entry) => {
      const path = [directory, entry.name].filter(Boolean).join("/");
      return !["node_modules", ".git", ".editor", ".shittim-spine-editor"].includes(entry.name.toLocaleLowerCase())
        && !isEditorIgnored(path, rules, entry.kind === "directory");
    });
    if (usable.some((entry) => entry.kind === "file" && /\.(?:atlas|skel)$/i.test(entry.name))) {
      output.push({ directory: directory.split("/").at(-1) || ".", path: directory || "." });
      return;
    }
    await Promise.all(usable.filter((entry) => entry.kind === "directory").map((entry) => visit([directory, entry.name].filter(Boolean).join("/"))));
  };
  await visit("");
  return output;
}

export async function discoverSpineSets(reader: LibraryReader, options: DiscoverSpineSetsOptions = {}): Promise<SpineSet[]> {
  const concurrency = Number.isFinite(options.manifestConcurrency)
    ? Math.max(1, Math.floor(options.manifestConcurrency!))
    : 12;
  const rules = await ignoreRules(reader);
  const records = await manifests(reader, concurrency, rules);
  if (records.length > 0) {
    const sets = new Map<string, SpineSet>();
    for (const record of records) {
      for (const [directory, assets] of Object.entries(record.manifest.assets)) {
        if (options.includeRelated === false && directory !== record.manifest.id) continue;
        const files = assets.files
          .map((reference) => manifestReferenceCandidates(record, reference)[0])
          .filter((path): path is string => Boolean(path) && !isEditorIgnored(path, rules));
        if (assets.files.length > 0 && files.length === 0) continue;
        sets.set(directory, { directory, path: record.path, files });
      }
    }
    if (sets.size > 0) return [...sets.values()].sort((a, b) => a.directory.localeCompare(b.directory, undefined, { sensitivity: "base" }));
  }

  const legacy = await discoverLegacy(reader, rules);
  const unique = new Map(legacy.map((set) => [set.directory, set]));
  return [...unique.values()].sort((a, b) => a.directory.localeCompare(b.directory, undefined, { sensitivity: "base" }));
}
