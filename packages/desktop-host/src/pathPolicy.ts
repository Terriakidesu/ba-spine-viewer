import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function normalizeLibraryRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.includes("\0")) {
    throw new Error("A relative path inside the selected library is required.");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path traversal is not allowed.");
  }
  if (segments.length === 0) throw new Error("A relative path inside the selected library is required.");
  return segments.join("/");
}

export function resolveLibraryPath(root: string, relativePath: string): string {
  const normalized = normalizeLibraryRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const fullPath = resolve(absoluteRoot, ...normalized.split("/"));
  const fromRoot = relative(absoluteRoot, fullPath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Path is outside the selected library.");
  }
  return fullPath;
}

export function isPathWithinLibrary(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export async function resolveExistingLibraryPath(root: string, relativePath: string): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const target = await realpath(resolveLibraryPath(realRoot, relativePath));
  if (target === realRoot || !isPathWithinLibrary(realRoot, target)) throw new Error("Path is outside the selected library.");
  return target;
}

/** Check the existing parent chain both before and after creating save directories. */
export async function assertLibraryWritePath(root: string, targetPath: string): Promise<void> {
  const realRoot = await realpath(resolve(root));
  const target = resolve(targetPath);
  if (!isPathWithinLibrary(realRoot, target) || target === realRoot) throw new Error("Path is outside the selected library.");

  let ancestor = dirname(target);
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (!isPathWithinLibrary(realRoot, actual)) throw new Error("Path is outside the selected library.");
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor || !isPathWithinLibrary(realRoot, parent)) throw new Error("Path is outside the selected library.");
      ancestor = parent;
    }
  }
}

export function isSupportedEditorWritePath(value: string): boolean {
  let path: string;
  try {
    path = normalizeLibraryRelativePath(value);
  } catch {
    return false;
  }
  return /^\.editor\/[^/]+\.json$/i.test(path)
    || /^lobbies\/[^/]+\/(?:manifest\.json|interactions\.json|subtitles\.json)$/i.test(path)
    || /^lobbies\/[^/]+\/\.editor\/workspace\.json$/i.test(path)
    || /^lobbies\/[^/]+\/sequences\/[^/]+\.json$/i.test(path)
    || /^audios\/voicelines\/[^/]+\/subtitles\.json$/i.test(path);
}
