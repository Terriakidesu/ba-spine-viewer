import type { BoneTreeBone } from "./boneTree";

export type BoneNavigationFilter = "all" | "interaction-targets" | "selected-branch";

export interface BoneTargetPreferences {
  favorites: string[];
  recent: string[];
}

function addAncestors(path: string, byPath: ReadonlyMap<string, BoneTreeBone>, result: Set<string>) {
  const visited = new Set([path]);
  let parentPath = byPath.get(path)?.parentPath ?? null;
  while (parentPath && !visited.has(parentPath)) {
    visited.add(parentPath);
    result.add(parentPath);
    parentPath = byPath.get(parentPath)?.parentPath ?? null;
  }
}

/** Return the allowed target paths plus ancestor context, or null for the All view. */
export function bonePathsForFilter(
  bones: readonly BoneTreeBone[],
  filter: BoneNavigationFilter,
  interactionTargetPaths: readonly string[],
  selectedPath: string | null,
): Set<string> | null {
  if (filter === "all") return null;

  const byPath = new Map(bones.map((bone) => [bone.path, bone]));
  const targets = new Set<string>();
  if (filter === "interaction-targets") {
    for (const path of interactionTargetPaths) if (byPath.has(path)) targets.add(path);
  } else {
    if (!selectedPath || !byPath.has(selectedPath)) return targets;
    targets.add(selectedPath);
    for (const bone of bones) {
      const visited = new Set<string>();
      let parentPath = bone.parentPath;
      while (parentPath && !visited.has(parentPath)) {
        if (parentPath === selectedPath) {
          targets.add(bone.path);
          break;
        }
        visited.add(parentPath);
        parentPath = byPath.get(parentPath)?.parentPath ?? null;
      }
    }
  }

  const result = new Set(targets);
  for (const path of targets) addAncestors(path, byPath, result);
  return result;
}

export function parentBonePaths(bones: readonly BoneTreeBone[]): Set<string> {
  const paths = new Set(bones.map((bone) => bone.path));
  return new Set(bones.flatMap((bone) => bone.parentPath && paths.has(bone.parentPath) ? [bone.parentPath] : []));
}

export function initialCollapsedBonePaths(bones: readonly BoneTreeBone[]): Set<string> {
  const paths = new Set(bones.map((bone) => bone.path));
  const roots = new Set(bones.filter((bone) => !bone.parentPath || !paths.has(bone.parentPath)).map((bone) => bone.path));
  return new Set([...parentBonePaths(bones)].filter((path) => !roots.has(path)));
}

function uniquePaths(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of value) {
    if (typeof path !== "string" || !path.trim() || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
    if (result.length >= limit) break;
  }
  return result;
}

export function normalizeBoneTargetPreferences(value: unknown): BoneTargetPreferences {
  if (!value || typeof value !== "object") return { favorites: [], recent: [] };
  const raw = value as Partial<BoneTargetPreferences>;
  return {
    favorites: uniquePaths(raw.favorites, 40),
    recent: uniquePaths(raw.recent, 8),
  };
}

export function toggleBoneFavorite(favorites: readonly string[], path: string): string[] {
  return favorites.includes(path)
    ? favorites.filter((favorite) => favorite !== path)
    : [path, ...favorites.filter((favorite) => favorite !== path)].slice(0, 40);
}

export function rememberBoneTarget(recent: readonly string[], path: string, limit = 6): string[] {
  return [path, ...recent.filter((item) => item !== path)].slice(0, Math.max(1, limit));
}

export function boneTargetPreferencesKey(assetRoot: string, directory: string): string {
  return `shittim-spine-editor:bone-targets:v1:${encodeURIComponent(`${assetRoot}\n${directory}`)}`;
}
