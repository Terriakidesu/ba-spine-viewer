export type SpineManifestPathScope = "lobby" | "root";

export interface SpineManifestPath {
  scope: SpineManifestPathScope;
  path: string;
}

export interface SpineManifestAssetSet {
  atlas: SpineManifestPath;
  skeletons: SpineManifestPath[];
  pages: SpineManifestPath[];
  files: SpineManifestPath[];
}

export interface SpineManifest {
  schemaVersion: number;
  id: string;
  /** The authored opening. Null means this lobby deliberately uses the Spine runtime intro. */
  entrySequence: string | null;
  entryMode: "authored-sequence" | "runtime-intro";
  /** Short-form paths for the lobby's primary Spine set. */
  skeleton?: SpineManifestPath;
  atlas?: SpineManifestPath;
  assets: Record<string, SpineManifestAssetSet>;
  sequences?: Record<string, SpineManifestPath>;
  interactions?: SpineManifestPath;
  subtitles?: SpineManifestPath;
  /** Original shared subtitle source retained as a migration mirror. */
  legacySubtitles?: SpineManifestPath;
  workspace?: SpineManifestPath;
}

export interface SpineManifestRecord {
  manifest: SpineManifest;
  path: string;
}

export interface SpineCatalogLobby {
  manifest: string;
}

export interface SpineCatalog {
  schemaVersion: number;
  characters?: Record<string, unknown>;
  unmatched?: unknown[];
  lobbies: Record<string, SpineCatalogLobby>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

export function manifestPath(scope: SpineManifestPathScope, path: string): SpineManifestPath {
  return { scope, path: normalizedPath(path) };
}

function normalizePath(value: unknown, defaultScope: SpineManifestPathScope): SpineManifestPath | null {
  if (typeof value === "string") {
    const path = normalizedPath(value);
    return path ? manifestPath(defaultScope, path) : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SpineManifestPath>;
  const path = text(raw.path);
  if (!path) return null;
  return manifestPath(raw.scope === "root" || raw.scope === "lobby" ? raw.scope : defaultScope, path);
}

function normalizeAssetSet(value: unknown): SpineManifestAssetSet | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SpineManifestAssetSet>;
  const atlas = normalizePath(raw.atlas, "root");
  if (!atlas) return null;
  const readPaths = (candidate: unknown): SpineManifestPath[] => Array.isArray(candidate)
    ? candidate.map((item) => normalizePath(item, atlas.scope)).filter((item): item is SpineManifestPath => item !== null)
    : [];
  const skeletons = readPaths(raw.skeletons);
  const pages = readPaths(raw.pages);
  const files = readPaths(raw.files);
  return {
    atlas,
    skeletons,
    pages,
    files: files.length > 0 ? files : [atlas, ...skeletons, ...pages],
  };
}

/** Normalize a manifest while retaining explicit path scopes for both consumers. */
export function normalizeSpineManifest(value: unknown, fallbackId?: string): SpineManifest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SpineManifest>;
  const id = text(raw.id) ?? fallbackId ?? "";
  if (!id) return null;
  const primaryAtlas = normalizePath(raw.atlas, "lobby");
  const primarySkeleton = normalizePath(raw.skeleton, "lobby");
  const rawAssets = raw.assets && typeof raw.assets === "object" && !Array.isArray(raw.assets) ? raw.assets : {};
  const assets = Object.fromEntries(Object.entries(rawAssets)
    .map(([directory, item]) => [directory, normalizeAssetSet(item)] as const)
    .filter((entry): entry is [string, SpineManifestAssetSet] => Boolean(entry[0] && entry[1])));
  if (!assets[id] && primaryAtlas && primarySkeleton) {
    assets[id] = {
      atlas: primaryAtlas,
      skeletons: [primarySkeleton],
      pages: [],
      files: [primaryAtlas, primarySkeleton],
    };
  }
  if (Object.keys(assets).length === 0) return null;
  const sequences = raw.sequences && typeof raw.sequences === "object" && !Array.isArray(raw.sequences)
    ? Object.fromEntries(Object.entries(raw.sequences)
      .map(([sequenceId, path]) => [sequenceId, normalizePath(path, "lobby")] as const)
      .filter((entry): entry is [string, SpineManifestPath] => Boolean(entry[0] && entry[1])))
    : {};
  const optionalPath = (value: unknown): SpineManifestPath | undefined => normalizePath(value, "lobby") ?? undefined;
  const entrySequence = raw.entrySequence === null ? null : text(raw.entrySequence);
  return {
    schemaVersion: typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion) ? Math.max(1, Math.trunc(raw.schemaVersion)) : 1,
    id,
    entrySequence,
    entryMode: raw.entryMode === "runtime-intro" || entrySequence === null ? "runtime-intro" : "authored-sequence",
    ...(primarySkeleton ? { skeleton: primarySkeleton } : assets[id]?.skeletons[0] ? { skeleton: assets[id]!.skeletons[0] } : {}),
    ...(primaryAtlas ? { atlas: primaryAtlas } : assets[id]?.atlas ? { atlas: assets[id]!.atlas } : {}),
    assets,
    ...(Object.keys(sequences).length > 0 ? { sequences } : {}),
    ...(optionalPath(raw.interactions) ? { interactions: optionalPath(raw.interactions) } : {}),
    ...(optionalPath(raw.subtitles) ? { subtitles: optionalPath(raw.subtitles) } : {}),
    ...(optionalPath(raw.legacySubtitles) ? { legacySubtitles: optionalPath(raw.legacySubtitles) } : {}),
    ...(optionalPath(raw.workspace) ? { workspace: optionalPath(raw.workspace) } : {}),
  };
}

export function normalizeSpineCatalog(value: unknown): SpineCatalog | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SpineCatalog>;
  if (!raw.lobbies || typeof raw.lobbies !== "object" || Array.isArray(raw.lobbies)) return null;
  const lobbies = Object.fromEntries(Object.entries(raw.lobbies)
    .map(([id, item]) => {
      const manifest = typeof item === "string" ? item : item && typeof item === "object" ? (item as { manifest?: unknown }).manifest : null;
      return [id, typeof manifest === "string" && manifest.trim() ? { manifest: normalizedPath(manifest) } : null] as const;
    })
    .filter((entry): entry is [string, SpineCatalogLobby] => entry[1] !== null));
  return {
    schemaVersion: typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion) ? Math.max(1, Math.trunc(raw.schemaVersion)) : 1,
    ...(raw.characters && typeof raw.characters === "object" && !Array.isArray(raw.characters) ? { characters: raw.characters as Record<string, unknown> } : {}),
    ...(Array.isArray(raw.unmatched) ? { unmatched: raw.unmatched } : {}),
    lobbies,
  };
}

export function manifestReferenceCandidates(record: SpineManifestRecord, reference: SpineManifestPath): string[] {
  const path = normalizedPath(reference.path);
  if (!path) return [];
  if (reference.scope === "root") return [path];
  const manifestDirectory = record.path.includes("/") ? record.path.slice(0, record.path.lastIndexOf("/")) : "";
  const lobbyDirectory = `lobbies/${record.manifest.id}`;
  const manifestIsInLobbyDirectory = manifestDirectory.toLocaleLowerCase() === lobbyDirectory.toLocaleLowerCase();
  return [...new Set([
    manifestDirectory && !manifestIsInLobbyDirectory ? `${manifestDirectory}/${path}` : "",
    `${lobbyDirectory}/${path}`,
    path,
  ].filter(Boolean))];
}

export function sequencePath(sequenceId: string): SpineManifestPath {
  const safe = sequenceId.replace(/[^A-Za-z0-9._-]+/g, "-") || "sequence";
  return manifestPath("lobby", `sequences/${safe}.json`);
}

/** Write the compact JSON form while retaining scoped objects for root-level references. */
export function serializeSpineManifest(manifest: SpineManifest): Record<string, unknown> {
  const reference = (value: SpineManifestPath): string | SpineManifestPath => value.scope === "lobby" ? value.path : value;
  return {
    ...manifest,
    ...(manifest.skeleton ? { skeleton: reference(manifest.skeleton) } : {}),
    ...(manifest.atlas ? { atlas: reference(manifest.atlas) } : {}),
    ...(manifest.sequences ? { sequences: Object.fromEntries(Object.entries(manifest.sequences).map(([id, value]) => [id, reference(value)])) } : {}),
    ...(manifest.interactions ? { interactions: reference(manifest.interactions) } : {}),
    ...(manifest.subtitles ? { subtitles: reference(manifest.subtitles) } : {}),
    ...(manifest.legacySubtitles ? { legacySubtitles: reference(manifest.legacySubtitles) } : {}),
    ...(manifest.workspace ? { workspace: reference(manifest.workspace) } : {}),
  };
}
