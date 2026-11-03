import { describe, expect, test } from "bun:test";
import { defaultCompanionLaunchPlan, parseCompanionLaunchPlan } from "./companionLaunch";

describe("portable companion launch discovery", () => {
  test("uses Electrobun's managed app path on Windows and Linux for first launch", () => {
    expect(defaultCompanionLaunchPlan("editor", {
      platform: "win32",
      appDataRoot: "C:\\Users\\Test User\\AppData\\Local",
      channel: "stable",
    })).toEqual({
      command: "C:\\Users\\Test User\\AppData\\Local\\dev.ba-spine.editor\\stable\\app\\bin\\launcher.exe",
      args: [],
    });
    expect(defaultCompanionLaunchPlan("viewer", {
      platform: "linux",
      appDataRoot: "/home/test/.local/share",
      channel: "canary",
    })).toEqual({
      command: "/home/test/.local/share/dev.ba-spine.viewer/canary/app/bin/launcher",
      args: [],
    });
  });

  test("uses LaunchServices bundle lookup on macOS", () => {
    expect(defaultCompanionLaunchPlan("viewer", {
      platform: "darwin",
      appDataRoot: "/Users/test/Library/Application Support",
      channel: "stable",
    })).toEqual({ command: "open", args: ["-b", "dev.ba-spine.viewer"] });
  });

  test("launches the matching workspace task in development and preserves paths with spaces", () => {
    expect(defaultCompanionLaunchPlan("editor", {
      platform: "win32",
      appDataRoot: "C:\\unused",
      channel: "dev",
      workspaceRoot: "C:\\Dev Projects\\ba spine",
    })).toEqual({
      command: "bun",
      args: ["run", "dev:editor"],
      cwd: "C:\\Dev Projects\\ba spine",
    });
  });

  test("rejects shell metacharacters and malformed launch descriptors", () => {
    expect(() => parseCompanionLaunchPlan({ command: "cmd.exe & powershell", args: [] })).toThrow();
    expect(() => parseCompanionLaunchPlan({ command: "bun", args: ["run", "dev:editor", "\0"] })).toThrow();
    expect(parseCompanionLaunchPlan({ command: "bun", args: ["run", "dev:viewer"], cwd: "C:\\workspace" }))
      .toEqual({ command: "bun", args: ["run", "dev:viewer"], cwd: "C:\\workspace" });
  });
});
