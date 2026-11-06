import { useCallback, useEffect, useState } from "react";

export const RELEASE_REPOSITORY = "Terriakidesu/ba-spine-viewer";
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const CACHE_KEY = "ba-spine-suite:release-check:v1";
const AUTO_CHECK_KEY = "ba-spine-suite:auto-release-check:v1";
const SKIPPED_VERSION_KEY = "ba-spine-suite:skipped-release:v1";

export interface GitHubReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface GitHubRelease {
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
  notes: string;
  assets: GitHubReleaseAsset[];
}

export type ReleaseCheckStatus = "unchecked" | "checking" | "current" | "available" | "skipped" | "error";

export interface ReleaseUpdateState {
  status: ReleaseCheckStatus;
  latestRelease: GitHubRelease | null;
  checkedAt: number | null;
  error: string | null;
}

interface ReleaseCache {
  checkedAt: number;
  etag?: string;
  release: GitHubRelease;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CheckReleaseOptions {
  force?: boolean;
  now?: number;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  storage?: StorageLike | null;
}

function storageFor(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function readCache(storage: StorageLike | null): ReleaseCache | null {
  try {
    const value = storage?.getItem(CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<ReleaseCache>;
    if (!Number.isFinite(parsed.checkedAt) || Number(parsed.checkedAt) < 0 || !parsed.release || typeof parsed.release !== "object") return null;
    const release = parsed.release as Partial<GitHubRelease>;
    if (typeof release.version !== "string" || !parseSemanticVersion(release.version)
      || typeof release.name !== "string" || typeof release.url !== "string") return null;
    const safeUrl = safeGitHubUrl(release.url);
    const assets = Array.isArray(release.assets) ? release.assets.slice(0, 100).flatMap((asset): GitHubReleaseAsset[] => {
      if (!asset || typeof asset.name !== "string" || typeof asset.downloadUrl !== "string") return [];
      try {
        return [{
          name: asset.name.slice(0, 200),
          downloadUrl: safeGitHubUrl(asset.downloadUrl),
          size: Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : 0,
        }];
      } catch {
        return [];
      }
    }) : [];
    const publishedAt = typeof release.publishedAt === "string" && Number.isFinite(Date.parse(release.publishedAt)) ? release.publishedAt : null;
    return {
      checkedAt: Number(parsed.checkedAt),
      ...(typeof parsed.etag === "string" && parsed.etag.length <= 512 ? { etag: parsed.etag } : {}),
      release: {
        version: release.version,
        name: release.name.slice(0, 200),
        url: safeUrl,
        publishedAt,
        notes: typeof release.notes === "string" ? release.notes.slice(0, 24_000) : "",
        assets,
      },
    };
  } catch {
    return null;
  }
}

interface SemanticVersionParts {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

function semanticVersionParts(value: string): SemanticVersionParts | null {
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  const build = match[5] ? match[5].split(".") : [];
  if (prerelease.some((identifier) => !/^[0-9A-Za-z-]+$/.test(identifier)
    || (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")))
    || build.some((identifier) => !/^[0-9A-Za-z-]+$/.test(identifier))) return null;
  return { major: match[1]!, minor: match[2]!, patch: match[3]!, prerelease };
}

export function parseSemanticVersion(value: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const parsed = semanticVersionParts(value);
  if (!parsed) return null;
  return { major: Number(parsed.major), minor: Number(parsed.minor), patch: Number(parsed.patch), prerelease: parsed.prerelease };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Compare SemVer values; build metadata is ignored and prereleases sort before stable releases. */
export function compareSemanticVersions(left: string, right: string): number {
  const a = semanticVersionParts(left);
  const b = semanticVersionParts(right);
  if (!a || !b) throw new Error("Cannot compare invalid semantic versions.");
  for (const key of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifiers(a[key], b[key]);
    if (comparison !== 0) return comparison;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function safeGitHubUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub returned a release without a valid URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
    || !url.pathname.startsWith(`/${RELEASE_REPOSITORY}/`)) {
    throw new Error("GitHub returned an unexpected release URL.");
  }
  return url.toString();
}

/** Normalize the bounded fields used by the About page; never render GitHub HTML or markdown. */
export function parseGitHubRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid release response.");
  const raw = value as Record<string, unknown>;
  if (raw.draft === true || raw.prerelease === true) throw new Error("GitHub did not return a stable release.");
  if (typeof raw.tag_name !== "string" || !parseSemanticVersion(raw.tag_name)) throw new Error("The latest GitHub release has an invalid SemVer tag.");
  const rawAssets = Array.isArray(raw.assets) ? raw.assets : [];
  const assets = rawAssets.slice(0, 100).flatMap((asset): GitHubReleaseAsset[] => {
    if (!asset || typeof asset !== "object") return [];
    const item = asset as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.browser_download_url !== "string") return [];
    try {
      const downloadUrl = safeGitHubUrl(item.browser_download_url);
      return [{ name: item.name.slice(0, 200), downloadUrl, size: Number.isFinite(item.size) ? Number(item.size) : 0 }];
    } catch {
      return [];
    }
  });
  const publishedAt = typeof raw.published_at === "string" && Number.isFinite(Date.parse(raw.published_at)) ? raw.published_at : null;
  return {
    version: raw.tag_name,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 200) : raw.tag_name,
    url: safeGitHubUrl(raw.html_url),
    publishedAt,
    notes: typeof raw.body === "string" ? raw.body.slice(0, 24_000) : "",
    assets,
  };
}

let pendingCheck: Promise<ReleaseCache> | null = null;

export async function checkForLatestRelease(options: CheckReleaseOptions = {}): Promise<ReleaseCache> {
  const storage = storageFor(options.storage);
  const now = options.now ?? Date.now();
  const cached = readCache(storage);
  if (!options.force && cached && now >= cached.checkedAt && now - cached.checkedAt < RELEASE_CHECK_INTERVAL_MS) return cached;
  if (pendingCheck) return pendingCheck;

  pendingCheck = (async () => {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await (options.fetcher ?? fetch)(LATEST_RELEASE_API, {
      method: "GET",
      headers,
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    let release: GitHubRelease;
    if (response.status === 304 && cached) release = cached.release;
    else {
      if (!response.ok) throw new Error(response.status === 403
        ? "GitHub rate-limited update checks. Try again later."
        : `GitHub update check failed (${response.status}).`);
      release = parseGitHubRelease(await response.json() as unknown);
    }
    const etag = response.headers.get("ETag") ?? cached?.etag;
    const result: ReleaseCache = {
      checkedAt: options.now ?? Date.now(),
      ...(etag ? { etag } : {}),
      release,
    };
    try { storage?.setItem(CACHE_KEY, JSON.stringify(result)); }
    catch { /* Update checks still work if local storage is unavailable. */ }
    return result;
  })();

  try { return await pendingCheck; }
  finally { pendingCheck = null; }
}

export function automaticReleaseChecksEnabled(storage?: StorageLike | null): boolean {
  try { return storageFor(storage)?.getItem(AUTO_CHECK_KEY) !== "false"; }
  catch { return true; }
}

function setAutomaticReleaseChecksEnabled(value: boolean): void {
  try { storageFor()?.setItem(AUTO_CHECK_KEY, value ? "true" : "false"); }
  catch { /* The preference is optional. */ }
}

function skippedVersion(storage: StorageLike | null): string | null {
  try { return storage?.getItem(SKIPPED_VERSION_KEY) ?? null; }
  catch { return null; }
}

function stateFromCache(currentVersion: string): ReleaseUpdateState {
  const cache = readCache(storageFor());
  if (!cache) return { status: "unchecked", latestRelease: null, checkedAt: null, error: null };
  const skipped = skippedVersion(storageFor());
  const status = compareSemanticVersions(cache.release.version, currentVersion) <= 0 ? "current"
    : skipped === cache.release.version ? "skipped" : "available";
  return { status, latestRelease: cache.release, checkedAt: cache.checkedAt, error: null };
}

export function useReleaseUpdates(currentVersion: string): {
  state: ReleaseUpdateState;
  automaticChecks: boolean;
  setAutomaticChecks: (enabled: boolean) => void;
  checkNow: () => Promise<void>;
  skipLatest: () => void;
  showSkipped: () => void;
} {
  const [state, setState] = useState<ReleaseUpdateState>(() => stateFromCache(currentVersion));
  const [automaticChecks, setAutomaticChecksState] = useState(automaticReleaseChecksEnabled);

  const applyCache = useCallback((cache: ReleaseCache) => {
    const skipped = skippedVersion(storageFor());
    const status = compareSemanticVersions(cache.release.version, currentVersion) <= 0 ? "current"
      : skipped === cache.release.version ? "skipped" : "available";
    setState({ status, latestRelease: cache.release, checkedAt: cache.checkedAt, error: null });
  }, [currentVersion]);

  useEffect(() => {
    setState(stateFromCache(currentVersion));
  }, [currentVersion]);

  useEffect(() => {
    if (!automaticChecks) return;
    let active = true;
    void checkForLatestRelease().then((cache) => {
      if (active) applyCache(cache);
    }).catch((error: unknown) => {
      if (active) setState((previous) => ({
        ...previous,
        status: previous.latestRelease ? previous.status : "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    return () => { active = false; };
  }, [applyCache, automaticChecks]);

  const checkNow = useCallback(async () => {
    setState((previous) => ({ ...previous, status: "checking", error: null }));
    try { applyCache(await checkForLatestRelease({ force: true })); }
    catch (error) {
      setState((previous) => ({
        ...previous,
        status: previous.latestRelease ? previous.status : "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [applyCache]);

  const setAutomaticChecks = useCallback((enabled: boolean) => {
    setAutomaticReleaseChecksEnabled(enabled);
    setAutomaticChecksState(enabled);
  }, []);

  const skipLatest = useCallback(() => {
    const release = state.latestRelease;
    if (!release || compareSemanticVersions(release.version, currentVersion) <= 0) return;
    try { storageFor()?.setItem(SKIPPED_VERSION_KEY, release.version); }
    catch { /* Skipping is best effort when storage is restricted. */ }
    setState((previous) => ({ ...previous, status: "skipped" }));
  }, [currentVersion, state.latestRelease]);

  const showSkipped = useCallback(() => {
    try { storageFor()?.removeItem(SKIPPED_VERSION_KEY); }
    catch { /* Showing the release is best effort when storage is restricted. */ }
    setState((previous) => previous.latestRelease && compareSemanticVersions(previous.latestRelease.version, currentVersion) > 0
      ? { ...previous, status: "available" }
      : previous);
  }, [currentVersion]);

  return { state, automaticChecks, setAutomaticChecks, checkNow, skipLatest, showSkipped };
}
