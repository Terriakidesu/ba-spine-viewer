import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createZstdDecompress } from "node:zlib";

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
  const scanner = new MarkerScanner(markers);
  for await (const chunk of createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES })) scanner.push(chunk);
  return scanner.results();
}

class MarkerScanner {
  private readonly found = new Set<string>();
  private readonly markerLabels: Set<string>;
  private readonly longest: number;
  private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly markers: readonly ByteMarker[]) {
    this.markerLabels = new Set(markers.map((marker) => marker.label));
    this.longest = markers.length ? Math.max(...markers.map((marker) => marker.bytes.byteLength)) : 0;
  }

  push(chunk: Uint8Array): void {
    if (!this.markers.length || this.found.size === this.markerLabels.size) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const bytes = this.carry.length ? Buffer.concat([this.carry, input]) : input;
    for (const marker of this.markers) {
      if (!this.found.has(marker.label) && bytes.indexOf(marker.bytes) !== -1) this.found.add(marker.label);
    }
    if (this.found.size !== this.markerLabels.size) {
      this.carry = bytes.subarray(Math.max(0, bytes.length - this.longest + 1));
    }
  }

  results(): string[] {
    return [...this.found];
  }
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async nextChunk(): Promise<boolean> {
    while (this.offset >= this.current.length && !this.ended) {
      const next = await this.iterator.next();
      this.ended = next.done ?? false;
      if (this.ended) return false;
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
    return this.offset < this.current.length;
  }

  async readExactly(size: number): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      if (!(await this.nextChunk())) {
        if (remaining === size) return null;
        throw new Error("truncated TAR header");
      }
      const count = Math.min(remaining, this.current.length - this.offset);
      parts.push(this.current.subarray(this.offset, this.offset + count));
      this.offset += count;
      remaining -= count;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }

  async consumeExactly(size: number, consume: (chunk: Buffer) => void): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (!(await this.nextChunk())) throw new Error("truncated TAR entry");
      const count = Math.min(remaining, this.current.length - this.offset);
      consume(this.current.subarray(this.offset, this.offset + count));
      this.offset += count;
      remaining -= count;
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarSize(field: Buffer): number | null {
  if (field[0] & 0x80) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  const text = tarString(field).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

function paxPath(body: Buffer): string | null {
  let offset = 0;
  while (offset < body.length) {
    const separator = body.indexOf(0x20, offset);
    if (separator < 0) return null;
    const recordLength = Number(body.subarray(offset, separator).toString("ascii"));
    if (!Number.isSafeInteger(recordLength) || recordLength <= separator - offset + 1 || offset + recordLength > body.length) return null;
    const record = body.subarray(separator + 1, offset + recordLength - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice(5);
    offset += recordLength;
  }
  return null;
}

function includesDataDirectory(path: string, directory: boolean): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const candidates = directory ? segments : segments.slice(0, -1);
  return candidates.some((segment) => segment.toLowerCase() === "data");
}

/** Inspect a compressed TAR without extracting it, including its directory table and file contents. */
async function auditTarZstdFile(path: string, relativePath: string, markers: readonly ByteMarker[]): Promise<string[]> {
  const issues: string[] = [];
  const scanner = new MarkerScanner(markers);
  const reader = new AsyncByteReader(createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES }).pipe(createZstdDecompress()));
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  let globalPaxPath: string | null = null;

  try {
    for (;;) {
      const header = await reader.readExactly(512);
      if (!header) break;
      scanner.push(header);
      if (header.every((byte) => byte === 0)) continue;

      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      const size = tarSize(header.subarray(124, 136));
      if (size === null) throw new Error("invalid or oversized TAR entry length");

      const isMetadata = ["L", "K", "x", "g"].includes(type);
      const collectMetadata = isMetadata && size <= 1024 * 1024;
      if (isMetadata && !collectMetadata) issues.push(`${relativePath}: compressed TAR metadata entry exceeds the inspection limit.`);
      const metadata: Buffer[] = [];
      await reader.consumeExactly(size, (chunk) => {
        scanner.push(chunk);
        if (collectMetadata) metadata.push(Buffer.from(chunk));
      });
      const padding = (512 - (size % 512)) % 512;
      await reader.consumeExactly(padding, (chunk) => scanner.push(chunk));

      if (type === "L") {
        pendingLongName = metadata.length ? tarString(Buffer.concat(metadata)) : null;
        continue;
      }
      if (type === "x" || type === "g") {
        const pathOverride = metadata.length ? paxPath(Buffer.concat(metadata)) : null;
        if (type === "g") globalPaxPath = pathOverride ?? globalPaxPath;
        else pendingPaxPath = pathOverride;
        continue;
      }
      if (type === "K") continue;

      const rawName = tarString(header.subarray(0, 100));
      const prefix = tarString(header.subarray(345, 500));
      const headerName = prefix ? `${prefix}/${rawName}` : rawName;
      const entryName = pendingPaxPath ?? globalPaxPath ?? pendingLongName ?? headerName;
      pendingPaxPath = null;
      pendingLongName = null;
      const directory = type === "5" || entryName.endsWith("/");

      if (includesDataDirectory(entryName, directory)) {
        issues.push(`${relativePath}: compressed TAR contains forbidden asset-library data directory "${entryName}".`);
      }
      if (type === "1" || type === "2") {
        issues.push(`${relativePath}: compressed TAR contains an unexpected link entry "${entryName}".`);
      }
    }
  } catch {
    issues.push(`${relativePath}: compressed TAR could not be safely inspected.`);
  } finally {
    await reader.close().catch(() => undefined);
  }

  for (const marker of scanner.results()) issues.push(`${relativePath}: compressed TAR contains forbidden marker "${marker}".`);
  return issues;
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
        if (entry.name.toLowerCase().endsWith(".tar.zst")) {
          issues.push(...await auditTarZstdFile(path, relativePath, markers));
        } else {
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
  }
  await visit(absoluteRoot);
  return issues;
}

async function auditWindowsLauncher(packageRoot: string, app: "viewer" | "editor"): Promise<string[]> {
  const bundleDirectory = app === "viewer" ? "BASpineViewer" : "BASpineEditor";
  const relativePath = `${bundleDirectory}/bin/launcher.exe`;
  const executablePath = join(packageRoot, bundleDirectory, "bin", "launcher.exe");
  let info;
  try { info = await lstat(executablePath); }
  catch { return [`${relativePath}: packaged Windows launcher is missing.`]; }
  if (!info.isFile() || info.isSymbolicLink()) return [`${relativePath}: packaged Windows launcher is not a regular file.`];

  let file;
  try {
    file = await open(executablePath, "r");
    const signature = Buffer.alloc(2);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead !== 2 || signature[0] !== 0x4d || signature[1] !== 0x5a) {
      return [`${relativePath}: packaged launcher does not have a valid Windows PE signature.`];
    }
  } catch {
    return [`${relativePath}: packaged Windows launcher could not be inspected.`];
  } finally {
    await file?.close().catch(() => undefined);
  }
  return [];
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
      if (item.name.toLowerCase().startsWith("stable-win-")) {
        issues.push(...(await auditWindowsLauncher(packageRoot, app)).map((issue) => `${app}/${item.name}: ${issue}`));
      }
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
    console.log("[release-audit] Viewer and Editor stable packages passed the archive, data, and workspace-path audit.");
  }
}
