import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { isPathWithinLibrary } from "@ba-spine/desktop-host/pathPolicy";

export interface AudioAssetCatalogEntry {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

const AUDIO_EXTENSIONS = new Set([".ogg", ".wav", ".mp3", ".m4a", ".flac", ".aac", ".opus"]);

/** Discover bounded audio assets while ignoring symlinks and paths outside the real asset root. */
export async function discoverAudioAssets(
  assetRoot: string,
  isIgnored: (path: string, isDirectory: boolean) => boolean,
  maxAssets = 10_000,
  maxDepth = 24,
): Promise<{ assets: AudioAssetCatalogEntry[]; truncated: boolean }> {
  const root = await realpath(assetRoot);
  const assets: AudioAssetCatalogEntry[] = [];
  let truncated = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || assets.length >= maxAssets) { truncated = true; return; }
    let actualDirectory: string;
    try { actualDirectory = await realpath(directory); } catch { return; }
    if (!isPathWithinLibrary(root, actualDirectory)) return;
    const entries = await readdir(actualDirectory, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(actualDirectory, entry.name);
      const path = relative(root, fullPath).replaceAll(sep, "/");
      if (isIgnored(path, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
        if (assets.length >= maxAssets) { truncated = true; return; }
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) {
        if (assets.length >= maxAssets) { truncated = true; return; }
        const info = await stat(fullPath).catch(() => null);
        if (!info?.isFile()) continue;
        assets.push({ path, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  }

  await visit(root, 0);
  assets.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  return { assets, truncated };
}
