import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { normalizeSpineCatalog } from "@ba-spine/spine-runtime/spine/spineManifest";

export const PORTABLE_SUITE_MANIFEST = "suite.json";
export const PORTABLE_SUITE_MANIFEST_MAX_BYTES = 16 * 1024;
export const PORTABLE_SUITE_LIBRARY_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

export type PortableSuiteApp = "editor" | "viewer";

export interface PortableSuiteManifest {
  schemaVersion: 1;
  suiteVersion: string;
  platform: "windows-x64";
  apps: Record<PortableSuiteApp, string>;
  dataDirectory: string;
}

export interface ResolvedPortableSuite {
  root: string;
  manifest: PortableSuiteManifest;
  appPaths: Record<PortableSuiteApp, string>;
  dataPath: string;
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  if (isAbsolute(value) || win32.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((part) => part.length > 0 && part !== "." && part !== "..")
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validatedManifest(value: unknown): PortableSuiteManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Portable suite manifest must be an object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["schemaVersion", "suiteVersion", "platform", "apps", "dataDirectory"].includes(key))) {
    throw new Error("Portable suite manifest contains unsupported fields.");
  }
  if (raw.schemaVersion !== 1) throw new Error("Portable suite manifest uses an unsupported schema version.");
  if (typeof raw.suiteVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.suiteVersion)) {
    throw new Error("Portable suite version is invalid.");
  }
  if (raw.platform !== "windows-x64") throw new Error("This portable suite build targets Windows x64.");
  if (!raw.apps || typeof raw.apps !== "object" || Array.isArray(raw.apps)) throw new Error("Portable suite app paths are missing.");
  const apps = raw.apps as Record<string, unknown>;
  if (Object.keys(apps).length !== 2 || !safeRelativePath(apps.editor) || !safeRelativePath(apps.viewer)) {
    throw new Error("Portable suite app paths must be safe relative paths for both apps.");
  }
  if (!String(apps.editor).toLowerCase().endsWith("/bin/launcher.exe")
    || !String(apps.viewer).toLowerCase().endsWith("/bin/launcher.exe")) {
    throw new Error("Portable suite app paths must identify Electrobun Windows launchers.");
  }
  if (!safeRelativePath(raw.dataDirectory)) throw new Error("Portable suite data path must be a safe relative path.");
  return {
    schemaVersion: 1,
    suiteVersion: raw.suiteVersion,
    platform: "windows-x64",
    apps: { editor: apps.editor, viewer: apps.viewer },
    dataDirectory: raw.dataDirectory,
  };
}

function containedPath(root: string, relativePath: string): string {
  const candidate = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw new Error("Portable suite path escapes its root.");
  }
  return candidate;
}

function validManifestFile(path: string, size: number, isRegularFile: boolean, isLink: boolean): void {
  if (!isRegularFile || isLink || size > PORTABLE_SUITE_MANIFEST_MAX_BYTES) {
    throw new Error("Portable suite manifest must be a small regular file.");
  }
}

export function parsePortableSuiteManifest(value: unknown): PortableSuiteManifest {
  return validatedManifest(value);
}

/** Validate suite metadata and both bundle launchers; never create or modify suite contents. */
export async function discoverPortableSuite(rootPath: string): Promise<ResolvedPortableSuite> {
  if (!rootPath || rootPath.length > 32_768 || /[\u0000-\u001f\u007f]/.test(rootPath)
    || !(isAbsolute(rootPath) || win32.isAbsolute(rootPath))) throw new Error("Portable suite root path is invalid.");
  const inputInfo = await lstat(rootPath);
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) throw new Error("Portable suite root must be a regular directory.");
  const root = await realpath(rootPath);
  const manifestPath = join(root, PORTABLE_SUITE_MANIFEST);
  const manifestInfo = await lstat(manifestPath);
  validManifestFile(manifestPath, manifestInfo.size, manifestInfo.isFile(), manifestInfo.isSymbolicLink());
  const contents = await readFile(manifestPath);
  if (contents.byteLength > PORTABLE_SUITE_MANIFEST_MAX_BYTES) throw new Error("Portable suite manifest exceeds its size limit.");
  const manifest = validatedManifest(JSON.parse(contents.toString("utf8")) as unknown);
  const appPaths = {} as Record<PortableSuiteApp, string>;
  for (const app of ["editor", "viewer"] as const) {
    const path = containedPath(root, manifest.apps[app]);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Portable suite ${app} launcher must be a regular file.`);
    const actual = await realpath(path);
    const rel = relative(root, actual);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)) {
      throw new Error(`Portable suite ${app} launcher resolves outside the suite.`);
    }
    appPaths[app] = actual;
  }
  const dataPath = containedPath(root, manifest.dataDirectory);
  try {
    const dataInfo = await lstat(dataPath);
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) throw new Error("Portable suite data path must be a regular directory.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { root, manifest, appPaths, dataPath };
}

/** Synchronous companion-app helper; invalid suite metadata falls back to the installed-app plan. */
export function suiteCompanionLauncherPath(rootPath: string, app: PortableSuiteApp): string | null {
  try {
    if (!rootPath || rootPath.length > 32_768 || /[\u0000-\u001f\u007f]/.test(rootPath)
      || !(isAbsolute(rootPath) || win32.isAbsolute(rootPath))) return null;
    const inputInfo = lstatSync(rootPath);
    if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) return null;
    const root = realpathSync(rootPath);
    const manifestPath = join(root, PORTABLE_SUITE_MANIFEST);
    const info = lstatSync(manifestPath);
    validManifestFile(manifestPath, info.size, info.isFile(), info.isSymbolicLink());
    const raw = readFileSync(manifestPath);
    if (raw.byteLength > PORTABLE_SUITE_MANIFEST_MAX_BYTES) return null;
    const manifest = validatedManifest(JSON.parse(raw.toString("utf8")) as unknown);
    const bundle = containedPath(root, manifest.apps[app]);
    const bundleInfo = lstatSync(bundle);
    if (!bundleInfo.isFile() || bundleInfo.isSymbolicLink()) return null;
    const actualBundle = realpathSync(bundle);
    const actualBundleRelative = relative(root, actualBundle);
    if (!actualBundleRelative || actualBundleRelative === ".." || actualBundleRelative.startsWith(`..${sep}`)
      || isAbsolute(actualBundleRelative) || win32.isAbsolute(actualBundleRelative)) return null;
    const launcher = join(root, app === "editor" ? "Editor.exe" : "Viewer.exe");
    const relativeLauncher = relative(root, launcher);
    if (!relativeLauncher || relativeLauncher === ".." || relativeLauncher.startsWith(`..${sep}`)) return null;
    const launcherInfo = lstatSync(launcher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink()) return null;
    const actual = realpathSync(launcher);
    const actualRelative = relative(root, actual);
    if (!actualRelative || actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || !existsSync(launcher)) return null;
    return actual;
  } catch {
    return null;
  }
}

/** Recognize a library using a bounded catalog read or immediate Spine asset entries, without writing to it. */
export async function isRecognizableSpineLibrary(path: string): Promise<boolean> {
  try {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) return false;
    const catalogPath = join(root, "catalog.json");
    try {
      const info = await lstat(catalogPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > PORTABLE_SUITE_LIBRARY_CATALOG_MAX_BYTES) return false;
      const parsed = JSON.parse(await readFile(catalogPath, "utf8")) as unknown;
      const catalog = normalizeSpineCatalog(parsed);
      if (catalog && catalog.schemaVersion === 1 && Object.keys(catalog.lobbies).length > 0) return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return false;
    }
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root, { withFileTypes: true }));
    return entries.some((entry) => !entry.isSymbolicLink()
      && (entry.isDirectory() || entry.isFile())
      && /\.(?:atlas|skel)$/i.test(entry.name));
  } catch {
    return false;
  }
}

/** Choose the first valid library in the documented portable-discovery order. */
export async function firstRecognizableLibraryPath(paths: readonly (string | null | undefined)[]): Promise<string | null> {
  for (const path of paths) {
    if (!path || !await isRecognizableSpineLibrary(path)) continue;
    try { return await realpath(path); } catch { /* The path disappeared during discovery. */ }
  }
  return null;
}
