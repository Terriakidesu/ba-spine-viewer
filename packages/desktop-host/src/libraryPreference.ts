import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";

export const MAX_LAST_LIBRARY_PATH_BYTES = 32 * 1024;

/** Explicit configuration wins, then the per-app choice, then the optional development-only default. */
export function initialLibraryPath(
  configuredPath: string | undefined,
  rememberedPath: string | null,
  developmentDefaultPath: string | null,
): string | null {
  return configuredPath || rememberedPath || developmentDefaultPath;
}

function isAbsoluteLibraryPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 32_768
    && !/[\u0000-\u001f\u007f]/.test(value)
    && (isAbsolute(value) || win32.isAbsolute(value));
}

/** Read the versioned last-library path without following symlinks or trusting unbounded app-data files. */
export async function readLastLibraryPath(preferencePath: string): Promise<string | null> {
  try {
    const info = await lstat(preferencePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LAST_LIBRARY_PATH_BYTES) return null;
    const contents = await readFile(preferencePath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_LAST_LIBRARY_PATH_BYTES) return null;
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).length !== 2 || !isAbsoluteLibraryPath(record.path)) return null;
    return record.path;
  } catch {
    return null;
  }
}

/** Return the remembered root when it is currently mounted; leave stale preferences intact for removable drives. */
export async function restoreLastLibraryPath(preferencePath: string): Promise<string | null> {
  const savedPath = await readLastLibraryPath(preferencePath);
  if (!savedPath) return null;
  try {
    const canonicalPath = await realpath(savedPath);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : null;
  } catch {
    return null;
  }
}

/** Atomically persist an explicitly selected absolute library path in app data. */
export async function writeLastLibraryPath(preferencePath: string, libraryPath: string): Promise<void> {
  if (!isAbsoluteLibraryPath(libraryPath)) throw new Error("A valid absolute library path is required.");
  const contents = JSON.stringify({ version: 1, path: libraryPath });
  if (Buffer.byteLength(contents, "utf8") > MAX_LAST_LIBRARY_PATH_BYTES) throw new Error("Library path preference exceeds its size limit.");
  await mkdir(dirname(preferencePath), { recursive: true });
  const temporaryPath = `${preferencePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, preferencePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
