import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const task = Bun.argv[2] === "build" ? "build" : "dev";
const prepare = Bun.spawn(["bun", "scripts/prepare-viewer.ts"], {
  cwd: desktopRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await prepare.exited !== 0) process.exit(prepare.exitCode ?? 1);

const command = task === "build"
  ? ["bunx", "electrobun", "build", "--env=stable"]
  : ["bunx", "electrobun", "dev", "--watch"];
const environment = { ...process.env };
if (task === "dev" && !environment.BA_SPINE_DATA) environment.BA_SPINE_DATA = resolve(repositoryRoot, "data");
const app = Bun.spawn(command, {
  cwd: desktopRoot,
  env: environment,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await app.exited);
