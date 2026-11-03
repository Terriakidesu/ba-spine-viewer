import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const source = join(repositoryRoot, "apps", "viewer", "dist");
const target = join(desktopRoot, "build", "viewer");

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
