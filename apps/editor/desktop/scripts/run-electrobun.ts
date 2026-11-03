import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../../..");
const task = Bun.argv[2] === "build" ? "build" : "dev";
const mcpEnabled = task === "dev" && Bun.argv.slice(3).includes("--mcp");
const prepare = Bun.spawn(["bun", "scripts/prepare-editor.ts"], {
  cwd: desktopRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (await prepare.exited !== 0) process.exit(prepare.exitCode ?? 1);

const command = task === "build"
  ? ["bunx", "electrobun", "build", "--env=stable"]
  : ["bunx", "electrobun", "dev", "--watch"];
const app = Bun.spawn(command, {
  cwd: desktopRoot,
  env: {
    ...process.env,
    ...(task === "dev" ? { BA_SPINE_WORKSPACE_ROOT: repositoryRoot } : {}),
    BA_SPINE_EDITOR_MCP: mcpEnabled ? "1" : "0",
  },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await app.exited);
