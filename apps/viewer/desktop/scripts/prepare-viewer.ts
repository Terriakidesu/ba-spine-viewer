import { createHash } from "node:crypto";
import { createReadStream, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const source = join(repositoryRoot, "apps", "viewer", "dist");
const target = join(desktopRoot, "build", "viewer");
const ffmpegArchive = join(desktopRoot, "resources", "ffmpeg-9.0.1-win-x64.zip");
const ffmpegOutput = join(desktopRoot, "build", "ffmpeg");
const ffmpegArchiveSha256 = "d5d4c1262bb6969c892b054f6b39f877137c5b1dee60c8d5e6a037262f4412e9";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const build = Bun.spawn(["bun", "run", "vite", "build", "--config", "apps/viewer/vite.config.ts"], {
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await build.exited !== 0) process.exit(build.exitCode ?? 1);
if (!existsSync(source)) throw new Error(`Viewer build was not created: ${source}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

rmSync(ffmpegOutput, { recursive: true, force: true });
if (process.platform === "win32" && process.arch === "x64") {
  if (!existsSync(ffmpegArchive)) throw new Error(`Bundled FFmpeg archive is missing: ${ffmpegArchive}`);
  if (await sha256File(ffmpegArchive) !== ffmpegArchiveSha256) throw new Error("The bundled FFmpeg archive did not match its pinned SHA-256 checksum.");
  mkdirSync(ffmpegOutput, { recursive: true });
  const extract = Bun.spawn(["tar", "-xf", ffmpegArchive, "-C", ffmpegOutput], {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await extract.exited !== 0) throw new Error("Could not extract the bundled FFmpeg executable.");
  if (!existsSync(join(ffmpegOutput, "ffmpeg.exe"))) throw new Error("The bundled FFmpeg archive did not contain ffmpeg.exe.");
  cpSync(join(desktopRoot, "resources", "FFmpeg-LICENSE.txt"), join(ffmpegOutput, "FFmpeg-LICENSE.txt"));
  cpSync(join(desktopRoot, "resources", "FFmpeg-build-notice.txt"), join(ffmpegOutput, "FFmpeg-build-notice.txt"));
  cpSync(join(desktopRoot, "resources", "FFmpeg-NOTICE.txt"), join(ffmpegOutput, "FFmpeg-NOTICE.txt"));
}
