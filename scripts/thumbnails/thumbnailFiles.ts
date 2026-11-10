import { lstat, link, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { assertLibraryWritePath, isPathWithinLibrary, resolveExistingLibraryPath, resolveLibraryPath } from "../../packages/desktop-host/src/pathPolicy";
import { manifestReferenceCandidates, normalizeSpineManifest } from "../../packages/spine-runtime/src/spine/spineManifest";
import { LOBBY_THUMBNAIL_HEIGHT, LOBBY_THUMBNAIL_WIDTH, lobbyThumbnailPath } from "../../packages/spine-runtime/src/spine/spineThumbnail";

export interface ThumbnailJob { directory: string; output: string; files: string[] }

export async function thumbnailJob(root: string, directory: string): Promise<ThumbnailJob> {
  const output = resolveLibraryPath(root, lobbyThumbnailPath(directory));
  const manifestPath = `lobbies/${directory}/manifest.json`;
  const manifestFile = await resolveExistingLibraryPath(root, manifestPath);
  const manifest = normalizeSpineManifest(JSON.parse(await readFile(manifestFile, "utf8")), directory);
  if (!manifest || manifest.id !== directory) throw new Error("Manifest identity does not match the lobby directory.");
  const assets = manifest.assets[directory];
  if (!assets) throw new Error("Manifest has no primary Spine asset set.");
  const references = [assets.atlas, ...assets.skeletons, ...assets.pages, ...assets.files];
  const paths = [...new Set(references.flatMap((reference) => manifestReferenceCandidates({ manifest, path: manifestPath }, reference).slice(0, 1)))]
    .filter((path) => /\.(?:atlas|skel|png|webp|jpe?g)$/i.test(path));
  const files: string[] = [];
  for (const path of paths) files.push(await resolveExistingLibraryPath(root, path));
  if (!files.some((file) => file.endsWith(".atlas")) || !files.some((file) => file.endsWith(".skel"))) throw new Error("Manifest does not provide an atlas and skeleton.");
  if (new Set(files.map((file) => basename(file).toLowerCase())).size !== files.length) throw new Error("Ambiguous duplicate asset filenames.");
  await assertLibraryWritePath(root, output);
  return { directory, output, files };
}

export function validateThumbnailPng(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || buffer.toString("ascii", 12, 16) !== "IHDR"
    || buffer.readUInt32BE(16) !== LOBBY_THUMBNAIL_WIDTH || buffer.readUInt32BE(20) !== LOBBY_THUMBNAIL_HEIGHT) {
    throw new Error("Expected a 640×360 (16:9) PNG thumbnail.");
  }
}

export async function thumbnailExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Thumbnail destination is not a regular file.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Atomic publication; without --force, an existing file is never overwritten. */
export async function saveThumbnail(root: string, path: string, bytes: Uint8Array, force: boolean): Promise<boolean> {
  validateThumbnailPng(bytes);
  await assertLibraryWritePath(root, path);
  if (await thumbnailExists(path) && !force) return false;
  const temporary = resolve(dirname(path), `.thumbnail-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await assertLibraryWritePath(root, path);
    if (force) { await thumbnailExists(path); await rename(temporary, path); }
    else {
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    }
    return true;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function thumbnailDirectories(root: string, selected?: string): Promise<string[]> {
  if (selected) { lobbyThumbnailPath(selected); return [selected]; }
  const lobbyRoot = await resolveExistingLibraryPath(root, "lobbies");
  return (await readdir(lobbyRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function checkedThumbnailRoot(path: string): Promise<string> {
  const repositoryData = resolve(import.meta.dir, "../../data");
  const rejectData = () => { throw new Error("Do not generate thumbnails inside repository data/. Use an external library or disposable fixtures."); };
  if (isPathWithinLibrary(repositoryData, resolve(path))) rejectData();
  const root = await realpath(resolve(path));
  const realData = await realpath(repositoryData).catch(() => repositoryData);
  if (isPathWithinLibrary(realData, root)) rejectData();
  return root;
}
