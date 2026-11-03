import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const DEFAULT_ARTIFACT_MARKERS = ["data/catalog.json"];
const SCAN_CHUNK_BYTES = 64 * 1024;

interface ByteMarker {
  label: string;
  bytes: Buffer;
}

function markerVariants(marker: string): string[] {
  const variants = new Set<string>();
  for (const path of [marker, marker.replaceAll("\\", "/"), marker.replaceAll("/", "\\")]) {
    variants.add(path);
    variants.add(path.toLowerCase());
    variants.add(path.toUpperCase());
  }
  return [...variants];
}

function byteMarkers(markers: readonly string[]): ByteMarker[] {
  const result: ByteMarker[] = [];
  for (const marker of markers.filter((item) => item.trim().length > 0)) {
    for (const variant of markerVariants(marker)) {
      result.push({ label: marker, bytes: Buffer.from(variant, "utf8") });
      result.push({ label: marker, bytes: Buffer.from(variant, "utf16le") });
    }
  }
  return result;
}

async function findMarkersInFile(path: string, markers: readonly ByteMarker[]): Promise<string[]> {
  if (markers.length === 0) return [];
  const found = new Set<string>();
  const markerLabels = new Set(markers.map((marker) => marker.label));
  const longest = Math.max(...markers.map((marker) => marker.bytes.byteLength));
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES })) {
    const bytes = carry.length ? Buffer.concat([carry, chunk as Buffer]) : chunk as Buffer;
    for (const marker of markers) {
      if (!found.has(marker.label) && bytes.indexOf(marker.bytes) !== -1) found.add(marker.label);
    }
    if (found.size === markerLabels.size) break;
    carry = bytes.subarray(Math.max(0, bytes.length - longest + 1));
  }
  return [...found];
}

/** Scan one packaged directory without following symlinks or loading large binaries into memory. */
export async function auditPackagedDirectory(root: string, forbiddenPaths: readonly string[] = []): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const issues: string[] = [];
  let rootInfo;
  try { rootInfo = await lstat(absoluteRoot); }
  catch { return [`Missing packaged directory: ${absoluteRoot}`]; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [`Packaged path is not a regular directory: ${absoluteRoot}`];

  const markers = byteMarkers([...DEFAULT_ARTIFACT_MARKERS, ...forbiddenPaths]);
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { issues.push(`Cannot read packaged directory: ${relative(absoluteRoot, directory) || "."}`); return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(absoluteRoot, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        issues.push(`${relativePath}: unexpected symbolic link in packaged output.`);
      } else if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === "data") issues.push(`${relativePath}: packaged asset-library data directory is forbidden.`);
        await visit(path);
      } else if (entry.isFile()) {
        try {
          for (const marker of await findMarkersInFile(path, markers)) {
            issues.push(`${relativePath}: contains forbidden marker "${marker}".`);
          }
        } catch {
          issues.push(`${relativePath}: could not be inspected.`);
        }
      }
    }
  }
  await visit(absoluteRoot);
  return issues;
}

async function auditBuildLog(path: string, forbiddenPaths: readonly string[]): Promise<string[]> {
  try {
    const markers = byteMarkers([...DEFAULT_ARTIFACT_MARKERS, ...forbiddenPaths]);
    return (await findMarkersInFile(path, markers))
      .map((label) => `${path}: build log contains forbidden marker "${label}".`);
  } catch {
    return [`Cannot read build log: ${path}`];
  }
}

/** Find and audit every stable package produced for both standalone apps. */
export async function auditReleaseArtifacts(
  repositoryRoot: string,
  additionalForbiddenPaths: readonly string[] = [],
  buildLogs: readonly string[] = [],
): Promise<string[]> {
  const root = resolve(repositoryRoot);
  const forbiddenPaths = [root, ...additionalForbiddenPaths.map((path) => isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(root, path))];
  const issues: string[] = [];
  for (const app of ["viewer", "editor"] as const) {
    const buildRoot = join(root, "apps", app, "desktop", "build");
    let entries;
    try { entries = await readdir(buildRoot, { withFileTypes: true }); }
    catch {
      issues.push(`${app}: packaged build directory is missing; run bun run build first.`);
      continue;
    }
    const packages = entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("stable-"));
    if (packages.length === 0) {
      issues.push(`${app}: no stable packaged output was found in ${buildRoot}.`);
      continue;
    }
    for (const item of packages) {
      const packageRoot = join(buildRoot, item.name);
      issues.push(...(await auditPackagedDirectory(packageRoot, forbiddenPaths)).map((issue) => `${app}/${item.name}: ${issue}`));
    }
  }
  for (const path of buildLogs) issues.push(...await auditBuildLog(path, forbiddenPaths));
  return issues;
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const additionalForbiddenPaths = (process.env.BA_SPINE_FORBIDDEN_PATHS ?? "")
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean);
  const buildLogs = (process.env.BA_SPINE_BUILD_LOGS ?? "")
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean);
  const issues = await auditReleaseArtifacts(repositoryRoot, additionalForbiddenPaths, buildLogs);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`[release-audit] ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("[release-audit] Viewer and Editor stable packages passed the data/workspace-path audit.");
  }
}
