import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PORTABLE_SUITE_UPDATE_REPOSITORY = "Terriakidesu/ba-spine-viewer";
export const PORTABLE_SUITE_UPDATE_DIRECTORY = ".ba-spine-update";
export const PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const CHECKSUM_LIMIT_BYTES = 2048;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface DownloadedPortableSuiteUpdate {
  status: "ready" | "downloading";
  version: string;
}

export interface StagedPortableSuiteUpdate {
  version: string;
  archiveName: string;
  archivePath: string;
  sha256: string;
}

export interface PortableSuiteUpdateStatus {
  status: "unsupported" | "idle" | "downloading" | "ready";
  version: string | null;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface ReleaseAssets {
  version: string;
  zip: GitHubReleaseAsset;
  checksum: GitHubReleaseAsset;
}

interface StagedUpdateRecord {
  schemaVersion: 1;
  version: string;
  archiveName: string;
  sha256: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function normalizedVersion(value: string): string {
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!STABLE_VERSION.test(version)) throw new Error("The suite update version is invalid.");
  return version;
}

export function isNewerPortableSuiteVersion(candidate: string, current: string): boolean {
  const a = normalizedVersion(candidate).split(".");
  const b = normalizedVersion(current).split(".");
  for (let index = 0; index < 3; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.length !== right.length) return left.length > right.length;
    if (left !== right) return left > right;
  }
  return false;
}

function expectedAssetNames(version: string): { zip: string; checksum: string } {
  const base = `BA-Spine-Suite-${normalizedVersion(version)}-win-x64.zip`;
  return { zip: base, checksum: `${base}.sha256` };
}

function safeDownloadUrl(value: unknown, tag: string, assetName: string): string {
  if (typeof value !== "string") throw new Error("GitHub returned an invalid suite update asset URL.");
  const url = new URL(value);
  const expectedPath = `/${PORTABLE_SUITE_UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.pathname !== expectedPath || url.search || url.hash) {
    throw new Error("GitHub returned an unexpected suite update asset URL.");
  }
  return url.toString();
}

async function releaseAssets(version: string, fetcher: Fetcher): Promise<ReleaseAssets> {
  const normalized = normalizedVersion(version);
  const tag = `v${normalized}`;
  const response = await fetcher(`https://api.github.com/repos/${PORTABLE_SUITE_UPDATE_REPOSITORY}/releases/tags/${tag}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not load suite release details (${response.status}).`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.draft === true || payload.prerelease === true || payload.tag_name !== tag || !Array.isArray(payload.assets)) {
    throw new Error("GitHub did not return the requested stable suite release.");
  }
  const names = expectedAssetNames(normalized);
  const findAsset = (name: string): GitHubReleaseAsset => {
    const raw = payload.assets as unknown[];
    const item = raw.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).name === name) as Record<string, unknown> | undefined;
    if (!item || typeof item.browser_download_url !== "string" || !Number.isSafeInteger(item.size) || Number(item.size) < 0) {
      throw new Error(`GitHub release is missing ${name}.`);
    }
    const size = Number(item.size);
    if (name === names.zip && (size <= 0 || size > PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES)) {
      throw new Error("The suite update archive is empty or exceeds the download size limit.");
    }
    return { name, browser_download_url: safeDownloadUrl(item.browser_download_url, tag, name), size };
  };
  return { version: normalized, zip: findAsset(names.zip), checksum: findAsset(names.checksum) };
}

function updatePaths(suiteRoot: string, version: string) {
  const normalized = normalizedVersion(version);
  const names = expectedAssetNames(normalized);
  const directory = join(suiteRoot, PORTABLE_SUITE_UPDATE_DIRECTORY);
  return {
    directory,
    archiveName: names.zip,
    archivePath: join(directory, names.zip),
    recordPath: join(directory, `suite-update-${normalized}.json`),
    lockPath: join(directory, `download-${normalized}.lock`),
  };
}

async function requireUpdateDirectory(suiteRoot: string): Promise<string> {
  const path = join(suiteRoot, PORTABLE_SUITE_UPDATE_DIRECTORY);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The suite update staging path is not a regular directory.");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    try { await mkdir(path, { recursive: false }); }
    catch (createError) {
      if (!isAlreadyExists(createError)) throw createError;
      const racedInfo = await lstat(path);
      if (!racedInfo.isDirectory() || racedInfo.isSymbolicLink()) throw new Error("The suite update staging path is not a regular directory.");
    }
  }
  return path;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function clearStaleDownloadLock(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128) return false;
    const text = await readFile(lockPath, "utf8");
    const record = JSON.parse(text) as { pid?: unknown };
    if (typeof record.pid !== "number" || processIsRunning(record.pid)) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch (error) {
    return isMissingFile(error);
  }
}

async function readStagedRecord(suiteRoot: string, version: string): Promise<StagedPortableSuiteUpdate | null> {
  const paths = updatePaths(suiteRoot, version);
  try {
    const directoryInfo = await lstat(paths.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return null;
    const [archiveInfo, recordInfo, text] = await Promise.all([
      lstat(paths.archivePath),
      lstat(paths.recordPath),
      readFile(paths.recordPath, "utf8"),
    ]);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size <= 0 || archiveInfo.size > PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES
      || !recordInfo.isFile() || recordInfo.isSymbolicLink() || recordInfo.size > 1024) return null;
    const record = JSON.parse(text) as Partial<StagedUpdateRecord>;
    if (record.schemaVersion !== 1 || record.version !== normalizedVersion(version) || record.archiveName !== paths.archiveName
      || typeof record.sha256 !== "string" || !DIGEST.test(record.sha256)) return null;
    return { version: record.version, archiveName: record.archiveName, archivePath: paths.archivePath, sha256: record.sha256 };
  } catch {
    return null;
  }
}

export async function getPortableSuiteUpdateStatus(suiteRoot: string | null, version: string | null): Promise<PortableSuiteUpdateStatus> {
  if (!suiteRoot || !version) return { status: "unsupported", version: null };
  const paths = updatePaths(suiteRoot, version);
  if (await readStagedRecord(suiteRoot, version)) return { status: "ready", version: normalizedVersion(version) };
  try {
    const info = await lstat(paths.lockPath);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 128) {
      const record = JSON.parse(await readFile(paths.lockPath, "utf8")) as { pid?: unknown; version?: unknown };
      if (record.version === normalizedVersion(version) && typeof record.pid === "number") {
        if (processIsRunning(record.pid)) return { status: "downloading", version: normalizedVersion(version) };
        await rm(paths.lockPath, { force: true });
      }
    }
  } catch {
    // Missing/unreadable progress state means no usable staged update is ready.
  }
  return { status: "idle", version: null };
}

export async function hasPortableSuiteUpdater(suiteRoot: string): Promise<boolean> {
  try {
    const info = await lstat(join(suiteRoot, "SuiteUpdater.exe"));
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function downloadTextAsset(asset: GitHubReleaseAsset, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(asset.browser_download_url, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not download the suite checksum (${response.status}).`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CHECKSUM_LIMIT_BYTES) throw new Error("The suite checksum file is unexpectedly large.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > CHECKSUM_LIMIT_BYTES) throw new Error("The suite checksum file is unexpectedly large.");
  return text;
}

function checksumFor(text: string, archiveName: string): string {
  const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*(?:\r?\n)?$/.exec(text);
  if (!match || match[2] !== archiveName) throw new Error("The suite checksum file does not match the update archive.");
  return match[1]!;
}

async function downloadArchive(asset: GitHubReleaseAsset, destination: string, fetcher: Fetcher): Promise<void> {
  const response = await fetcher(asset.browser_download_url, { credentials: "omit", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`Could not download the suite update archive (${response.status}).`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES) throw new Error("The suite update archive exceeds the download size limit.");
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      received += chunk.byteLength;
      callback(received > PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES
        ? new Error("The suite update archive exceeds the download size limit.")
        : null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    limiter,
    createWriteStream(destination, { flags: "wx" }),
  );
  if (received === 0 || received !== asset.size) throw new Error("The downloaded suite archive size does not match the release metadata.");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadPortableSuiteUpdate(
  suiteRoot: string,
  version: string,
  fetcher: Fetcher = fetch,
): Promise<DownloadedPortableSuiteUpdate> {
  const normalized = normalizedVersion(version);
  await requireUpdateDirectory(suiteRoot);
  const paths = updatePaths(suiteRoot, normalized);
  if (await readStagedRecord(suiteRoot, normalized)) return { status: "ready", version: normalized };

  let lock;
  try {
    lock = await open(paths.lockPath, "wx", 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (await clearStaleDownloadLock(paths.lockPath)) {
      try { lock = await open(paths.lockPath, "wx", 0o600); }
      catch (retryError) {
        if (isAlreadyExists(retryError)) return { status: "downloading", version: normalized };
        throw retryError;
      }
    } else {
      return { status: "downloading", version: normalized };
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, version: normalized }));
    const release = await releaseAssets(normalized, fetcher);
    const checksumText = await downloadTextAsset(release.checksum, fetcher);
    const expectedDigest = checksumFor(checksumText, release.zip.name);
    const temporaryPath = join(paths.directory, `${release.zip.name}.partial-${process.pid}-${randomUUID()}`);
    try {
      await downloadArchive(release.zip, temporaryPath, fetcher);
      const actualDigest = await sha256File(temporaryPath);
      if (actualDigest !== expectedDigest) throw new Error("The suite update archive failed its SHA-256 check.");
      try {
        const oldInfo = await lstat(paths.archivePath);
        if (!oldInfo.isFile() || oldInfo.isSymbolicLink()) throw new Error("The existing suite update archive path is unsafe.");
        await rm(paths.archivePath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      await rename(temporaryPath, paths.archivePath);
      const record: StagedUpdateRecord = { schemaVersion: 1, version: normalized, archiveName: release.zip.name, sha256: actualDigest };
      const recordTemporaryPath = `${paths.recordPath}.partial-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(recordTemporaryPath, `${JSON.stringify(record)}\n`, { flag: "wx" });
        try {
          const oldRecord = await lstat(paths.recordPath);
          if (!oldRecord.isFile() || oldRecord.isSymbolicLink()) throw new Error("The existing suite update record path is unsafe.");
          await rm(paths.recordPath);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        await rename(recordTemporaryPath, paths.recordPath);
      } finally {
        await rm(recordTemporaryPath, { force: true });
      }
      return { status: "ready", version: normalized };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  } finally {
    await lock.close();
    await rm(paths.lockPath, { force: true });
  }
}

export async function getStagedPortableSuiteUpdate(suiteRoot: string, version: string): Promise<StagedPortableSuiteUpdate> {
  const staged = await readStagedRecord(suiteRoot, version);
  if (!staged) throw new Error("The suite update has not finished downloading.");
  const info = await stat(staged.archivePath);
  if (!info.isFile() || info.size <= 0 || info.size > PORTABLE_SUITE_UPDATE_MAX_ARCHIVE_BYTES) throw new Error("The staged suite update archive is invalid.");
  if (basename(staged.archivePath) !== staged.archiveName) throw new Error("The staged suite update archive path is invalid.");
  if (await sha256File(staged.archivePath) !== staged.sha256) {
    const paths = updatePaths(suiteRoot, version);
    await Promise.all([rm(paths.archivePath, { force: true }), rm(paths.recordPath, { force: true })]);
    throw new Error("The staged suite update archive failed its SHA-256 check. Download it again.");
  }
  return staged;
}
