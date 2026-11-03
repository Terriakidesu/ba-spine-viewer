import { realpath, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LibraryEntry, LibraryReader } from "@ba-spine/asset-library/catalog";
import { normalizeLibraryRelativePath, resolveLibraryPath } from "./pathPolicy";

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)));
}

/** A read-only library adapter that rejects traversal and symlink escapes. */
export function createNodeLibraryReader(libraryRoot: string): LibraryReader {
  const rootPromise = realpath(resolve(libraryRoot));

  async function containedPath(path: string, allowRoot = false): Promise<{ root: string; target: string } | null> {
    const root = await rootPromise;
    if (allowRoot && (path === "" || path === ".")) return { root, target: root };
    const normalized = normalizeLibraryRelativePath(path);
    const lexicalPath = resolveLibraryPath(root, normalized);
    let target: string;
    try {
      target = await realpath(lexicalPath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!isWithin(root, target)) throw new Error("Resolved path is outside the selected asset library.");
    return { root, target };
  }

  return {
    async readText(path) {
      const resolved = await containedPath(path);
      if (!resolved) return null;
      try {
        return await readFile(resolved.target, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async readDirectory(path) {
      const resolved = await containedPath(path, true);
      if (!resolved) return [];
      const entries = await readdir(resolved.target, { withFileTypes: true });
      return entries.flatMap((entry): LibraryEntry[] => entry.isDirectory()
        ? [{ name: entry.name, kind: "directory" }]
        : entry.isFile() ? [{ name: entry.name, kind: "file" }] : []);
    },
  };
}
