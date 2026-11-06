import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const source = join(repositoryRoot, "apps", "viewer", "dist");
const target = join(desktopRoot, "build", "viewer");
const ffmpegOutput = join(desktopRoot, "build", "ffmpeg");

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
  const download = Bun.spawn(["bun", "scripts/download-ffmpeg.ts"], {
    cwd: desktopRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await download.exited !== 0) throw new Error("Could not download and prepare the pinned FFmpeg executable.");
  if (!existsSync(join(ffmpegOutput, "ffmpeg.exe"))) throw new Error("The bundled FFmpeg archive did not contain ffmpeg.exe.");
}
