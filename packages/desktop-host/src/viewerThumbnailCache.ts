import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MAX_VIEWER_THUMBNAIL_BYTES = 1024 * 1024;
export const MAX_VIEWER_THUMBNAIL_ENTRIES = 256;
export const MAX_VIEWER_THUMBNAIL_CACHE_BYTES = 128 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Map([["image/webp", "webp"], ["image/png", "png"]]);

export interface CachedViewerThumbnail {
  bytes: Uint8Array;
  contentType: "image/webp" | "image/png";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function variantForFingerprint(fingerprint: string): "face" | "lobby" | "legacy" {
  return /^face-v\d+:/i.test(fingerprint) ? "face" : /^lobby-v\d+:/i.test(fingerprint) ? "lobby" : "legacy";
}

function cacheFilename(fingerprint: string, extension: string): string {
  const variant = variantForFingerprint(fingerprint);
  const prefix = variant === "legacy" ? "" : `${variant}-`;
  return `${prefix}${digest(fingerprint)}.${extension}`;
}

function validateKeyPart(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid thumbnail ${label}.`);
  }
}

/** Disk-backed Viewer thumbnail cache. Its root belongs in OS app data, never in the asset library. */
export class ViewerThumbnailCache {
  constructor(private readonly cacheRoot: string) {}

  private directory(libraryRoot: string, lobbyId: string): string {
    validateKeyPart(libraryRoot, "library identity");
    validateKeyPart(lobbyId, "lobby ID");
    return join(resolve(this.cacheRoot), digest(resolve(libraryRoot)), digest(lobbyId));
  }

  async get(libraryRoot: string, lobbyId: string, fingerprint: string): Promise<CachedViewerThumbnail | null> {
    validateKeyPart(fingerprint, "fingerprint");
    const directory = this.directory(libraryRoot, lobbyId);
    for (const [contentType, extension] of ALLOWED_CONTENT_TYPES) {
      const path = join(directory, cacheFilename(fingerprint, extension));
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_VIEWER_THUMBNAIL_BYTES) return null;
        return { bytes: new Uint8Array(await readFile(path)), contentType: contentType as CachedViewerThumbnail["contentType"] };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return null;
  }

  async put(libraryRoot: string, lobbyId: string, fingerprint: string, contentType: string, bytes: Uint8Array): Promise<void> {
    validateKeyPart(fingerprint, "fingerprint");
    const extension = ALLOWED_CONTENT_TYPES.get(contentType);
    if (!extension) throw new Error("Viewer thumbnails must be WebP or PNG images.");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_VIEWER_THUMBNAIL_BYTES) {
      throw new Error("Viewer thumbnail must be non-empty and no larger than 1 MB.");
    }

    const directory = this.directory(libraryRoot, lobbyId);
    await mkdir(directory, { recursive: true });
    const filename = cacheFilename(fingerprint, extension);
    const target = join(directory, filename);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    // Retain one current fingerprint per preview kind, so face and lobby views coexist.
    const entries = await readdir(directory, { withFileTypes: true });
    const variant = variantForFingerprint(fingerprint);
    const categoryPrefix = variant === "legacy" ? "" : `${variant}-`;
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name !== filename && /\.(?:webp|png)$/i.test(entry.name)
        && (variant === "legacy"
          ? !/^(?:face|lobby)-/i.test(entry.name)
          : entry.name.startsWith(categoryPrefix) || variant === "lobby" && /^[a-f0-9]{64}\.(?:webp|png)$/i.test(entry.name)))
      .map((entry) => rm(join(directory, entry.name), { force: true })));
    await this.prune();
  }

  async invalidate(libraryRoot: string, lobbyId: string): Promise<void> {
    await rm(this.directory(libraryRoot, lobbyId), { recursive: true, force: true });
  }

  private async prune(): Promise<void> {
    const candidates: Array<{ path: string; modified: number; size: number }> = [];
    let libraryDirectories;
    try { libraryDirectories = await readdir(resolve(this.cacheRoot), { withFileTypes: true }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const library of libraryDirectories.filter((entry) => entry.isDirectory())) {
      const lobbiesPath = join(resolve(this.cacheRoot), library.name);
      const lobbyDirectories = await readdir(lobbiesPath, { withFileTypes: true });
      for (const lobby of lobbyDirectories.filter((entry) => entry.isDirectory())) {
        const lobbyPath = join(lobbiesPath, lobby.name);
        for (const image of await readdir(lobbyPath, { withFileTypes: true })) {
          if (!image.isFile() || !/\.(?:webp|png)$/i.test(image.name)) continue;
          const path = join(lobbyPath, image.name);
          const info = await lstat(path);
          if (info.isFile() && !info.isSymbolicLink()) candidates.push({ path, modified: info.mtimeMs, size: info.size });
        }
      }
    }
    candidates.sort((left, right) => right.modified - left.modified || right.path.localeCompare(left.path));
    let kept = 0;
    let bytes = 0;
    for (const item of candidates) {
      if (kept < MAX_VIEWER_THUMBNAIL_ENTRIES && bytes + item.size <= MAX_VIEWER_THUMBNAIL_CACHE_BYTES) {
        kept++;
        bytes += item.size;
      } else {
        await rm(item.path, { force: true });
      }
    }
  }
}
