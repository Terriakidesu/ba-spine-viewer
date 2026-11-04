import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCompanionLaunchPlan, parseCompanionLaunchPlan } from "./companionLaunch";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

  test("prefers the validated sibling suite launcher, including paths with spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "BA Suite Companion "));
    temporaryDirectories.push(root);
    await mkdir(join(root, "apps", "editor", "BASpineEditor", "bin"), { recursive: true });
    await mkdir(join(root, "apps", "viewer", "BASpineViewer", "bin"), { recursive: true });
    await writeFile(join(root, "apps", "editor", "BASpineEditor", "bin", "launcher.exe"), "editor bundle");
    await writeFile(join(root, "apps", "viewer", "BASpineViewer", "bin", "launcher.exe"), "viewer bundle");
    await writeFile(join(root, "Viewer.exe"), "root launcher");
    await writeFile(join(root, "suite.json"), JSON.stringify({
      schemaVersion: 1,
      suiteVersion: "0.1.0",
      platform: "windows-x64",
      apps: { editor: "apps/editor/BASpineEditor/bin/launcher.exe", viewer: "apps/viewer/BASpineViewer/bin/launcher.exe" },
      dataDirectory: "data",
    }));
    expect(defaultCompanionLaunchPlan("viewer", {
      platform: "win32",
      appDataRoot: "C:\\unused",
      channel: "stable",
      suiteRoot: root,
    })).toEqual({ command: join(root, "Viewer.exe"), args: [], cwd: root });
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
