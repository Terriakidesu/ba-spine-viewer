import { spawn } from "node:child_process";
import { isAbsolute, posix, win32 } from "node:path";
import type { HandoffTargetApp } from "@ba-spine/platform-contracts/handoff";
import { suiteCompanionLauncherPath } from "./portableSuite";

export interface CompanionLaunchPlan {
  command: string;
  args: string[];
  cwd?: string;
}

export type CompanionPlatform = "win32" | "darwin" | "linux";

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function pathApi(platform: CompanionPlatform) {
  return platform === "win32" ? win32 : posix;
}

const APP_IDENTIFIERS: Record<HandoffTargetApp, string> = {
  viewer: "dev.ba-spine.viewer",
  editor: "dev.ba-spine.editor",
};

function commandName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);
}

/** Validate persisted launch metadata; spawning never uses a shell. */
export function parseCompanionLaunchPlan(value: unknown): CompanionLaunchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Companion launch plan must be an object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["command", "args", "cwd"].includes(key))) throw new Error("Companion launch plan contains an unsupported field.");
  if (typeof raw.command !== "string" || raw.command.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw.command)
    || !(absolutePath(raw.command) || commandName(raw.command))) {
    throw new Error("Companion launch command must be an absolute path or a simple executable name.");
  }
  if (!Array.isArray(raw.args) || raw.args.length > 32 || raw.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || /[\u0000]/.test(arg))) {
    throw new Error("Companion launch arguments are invalid.");
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !absolutePath(raw.cwd) || /[\u0000-\u001f\u007f]/.test(raw.cwd))) {
    throw new Error("Companion launch working directory must be an absolute path.");
  }
  return {
    command: raw.command,
    args: [...raw.args] as string[],
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
  };
}

/**
 * Fallback for first-run discovery when the target hasn't written a launch
 * record yet. macOS delegates bundle lookup to LaunchServices; Windows/Linux
 * use Electrobun's managed app layout.
 */
export function defaultCompanionLaunchPlan(
  app: HandoffTargetApp,
  options: {
    platform?: CompanionPlatform;
    appDataRoot: string;
    channel: "stable" | "canary" | "dev";
    workspaceRoot?: string;
    suiteRoot?: string;
  },
): CompanionLaunchPlan {
  const platform = options.platform ?? process.platform as CompanionPlatform;
  if (options.suiteRoot && platform === "win32") {
    const command = suiteCompanionLauncherPath(options.suiteRoot, app);
    if (command) return { command, args: [], cwd: options.suiteRoot };
  }
  if (options.workspaceRoot) {
    return {
      command: "bun",
      args: ["run", `dev:${app}`],
      cwd: pathApi(platform).resolve(options.workspaceRoot),
    };
  }
  if (platform === "darwin") return { command: "open", args: ["-b", APP_IDENTIFIERS[app]] };
  const launcher = platform === "win32" ? "launcher.exe" : "launcher";
  const path = pathApi(platform);
  const command = path.join(options.appDataRoot, APP_IDENTIFIERS[app], options.channel, "app", "bin", launcher);
  return { command, args: [] };
}

/** Start a known native app without a shell or command-line handoff payload. */
export function launchCompanionProcess(value: unknown): Promise<void> {
  const plan = parseCompanionLaunchPlan(value);
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(plan.command, plan.args, {
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}
