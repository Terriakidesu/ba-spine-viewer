import { createHash } from "node:crypto";
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const resources = join(desktopRoot, "resources");
const cacheDirectory = join(repositoryRoot, ".cache", "ffmpeg");
const archivePath = join(cacheDirectory, "ffmpeg-9.0.1-full_build.zip");
const partialArchivePath = `${archivePath}.${process.pid}.partial`;
const ffmpegOutput = join(desktopRoot, "build", "ffmpeg");
const archiveUrl = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-full_build.zip";
const archiveSize = 251_427_729;
const archiveSha256 = "2e8e28af97c2ae338ccef92e36da9b2a4cd21d0cad9dde093545606cb07f5b00";
const executableMember = "ffmpeg-9.0.1-full_build/bin/ffmpeg.exe";
const executableSha256 = "57c56e369d5b4873b4d93fc1a1d833cb7cd8bc9325c14b05c34ce60b22842d8a";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifiedArchiveAvailable(): Promise<boolean> {
  if (!existsSync(archivePath)) return false;
  if (statSync(archivePath).size !== archiveSize) return false;
  return await sha256File(archivePath) === archiveSha256;
}

async function ensureVerifiedArchive(): Promise<void> {
  mkdirSync(cacheDirectory, { recursive: true });
  if (await verifiedArchiveAvailable()) {
    console.info("[ffmpeg] Using the SHA-256-verified cached FFmpeg 9.0.1 archive.");
    return;
  }

  rmSync(partialArchivePath, { force: true });
  console.info(`[ffmpeg] Downloading pinned FFmpeg 9.0.1 from ${archiveUrl}`);
  try {
    const response = await fetch(archiveUrl, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`FFmpeg download failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== archiveSize) {
      throw new Error(`FFmpeg download size did not match the pinned ${archiveSize}-byte archive.`);
    }

    await Bun.write(partialArchivePath, response);
    if (statSync(partialArchivePath).size !== archiveSize) {
      throw new Error(`FFmpeg download size did not match the pinned ${archiveSize}-byte archive.`);
    }
    const digest = await sha256File(partialArchivePath);
    if (digest !== archiveSha256) throw new Error(`FFmpeg archive SHA-256 mismatch: ${digest}`);

    rmSync(archivePath, { force: true });
    renameSync(partialArchivePath, archivePath);
  } catch (error) {
    rmSync(partialArchivePath, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The bundled FFmpeg downloader currently supports Windows x64 only.");
  }

  await ensureVerifiedArchive();
  const extractionRoot = mkdtempSync(join(tmpdir(), "ba-spine-ffmpeg-"));
  try {
    const extract = Bun.spawn(["tar", "-xf", archivePath, "-C", extractionRoot, executableMember], {
      cwd: repositoryRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await extract.exited !== 0) throw new Error("Could not extract ffmpeg.exe from the verified Gyan archive.");

    const downloadedExecutable = join(extractionRoot, executableMember);
    if (!existsSync(downloadedExecutable)) throw new Error(`The Gyan archive did not contain ${executableMember}.`);
    const executableDigest = await sha256File(downloadedExecutable);
    if (executableDigest !== executableSha256) throw new Error(`FFmpeg executable SHA-256 mismatch: ${executableDigest}`);

    rmSync(ffmpegOutput, { recursive: true, force: true });
    mkdirSync(ffmpegOutput, { recursive: true });
    cpSync(downloadedExecutable, join(ffmpegOutput, "ffmpeg.exe"));
    for (const notice of ["FFmpeg-LICENSE.txt", "FFmpeg-build-notice.txt", "FFmpeg-NOTICE.txt"]) {
      cpSync(join(resources, notice), join(ffmpegOutput, notice));
    }
    console.info("[ffmpeg] Verified and prepared FFmpeg 9.0.1 for the Viewer build.");
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

await main();
