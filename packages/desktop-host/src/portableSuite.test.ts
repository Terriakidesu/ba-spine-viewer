import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPortableSuite,
  firstRecognizableLibraryPath,
  isRecognizableSpineLibrary,
  parsePortableSuiteManifest,
  suiteCompanionLauncherPath,
} from "./portableSuite";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function suiteRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "BA Spine Suite 日本語 "));
  temporaryDirectories.push(root);
  await mkdir(join(root, "apps", "editor", "BASpineEditor", "bin"), { recursive: true });
  await mkdir(join(root, "apps", "viewer", "BASpineViewer", "bin"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "apps", "editor", "BASpineEditor", "bin", "launcher.exe"), "editor");
  await writeFile(join(root, "apps", "viewer", "BASpineViewer", "bin", "launcher.exe"), "viewer");
  await writeFile(join(root, "Editor.exe"), "root editor launcher");
  await writeFile(join(root, "Viewer.exe"), "root viewer launcher");
  await writeFile(join(root, "suite.json"), JSON.stringify({
    schemaVersion: 1,
    suiteVersion: "0.1.0",
    platform: "windows-x64",
    apps: {
      editor: "apps/editor/BASpineEditor/bin/launcher.exe",
      viewer: "apps/viewer/BASpineViewer/bin/launcher.exe",
    },
    dataDirectory: "data",
  }));
  return root;
}

async function writeLibrary(root: string, name = "catalog.json"): Promise<string> {
  const library = join(root, name);
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "catalog.json"), JSON.stringify({ schemaVersion: 1, lobbies: { Airi_home: { manifest: "lobbies/Airi_home/manifest.json" } } }));
  return library;
}

describe("portable suite discovery", () => {
  test("validates the manifest and resolves bundle paths under a relocated Unicode root", async () => {
    const root = await suiteRoot();
    const suite = await discoverPortableSuite(root);
    expect(suite.root).toBe(root);
    expect(suite.manifest.suiteVersion).toBe("0.1.0");
    expect(suite.appPaths.editor).toBe(join(root, "apps", "editor", "BASpineEditor", "bin", "launcher.exe"));
    expect(suite.dataPath).toBe(join(root, "data"));
    expect(suiteCompanionLauncherPath(root, "viewer")).toBe(join(root, "Viewer.exe"));
  });

  test("rejects unsupported versions, absolute paths, traversal, and unsafe separators", () => {
    const valid = {
      schemaVersion: 1,
      suiteVersion: "0.1.0",
      platform: "windows-x64",
      apps: { editor: "apps/editor/bin/launcher.exe", viewer: "apps/viewer/bin/launcher.exe" },
      dataDirectory: "data",
    };
    expect(() => parsePortableSuiteManifest({ ...valid, schemaVersion: 2 })).toThrow(/unsupported schema/);
    expect(() => parsePortableSuiteManifest({ ...valid, apps: { ...valid.apps, editor: "C:/outside/launcher.exe" } })).toThrow(/safe relative/);
    expect(() => parsePortableSuiteManifest({ ...valid, apps: { ...valid.apps, viewer: "apps/../outside/bin/launcher.exe" } })).toThrow(/safe relative/);
    expect(() => parsePortableSuiteManifest({ ...valid, dataDirectory: "apps\\data" })).toThrow(/safe relative/);
  });

  test("rejects missing bundle launchers and does not invent a suite-local library", async () => {
    const root = await suiteRoot();
    await rm(join(root, "apps", "viewer", "BASpineViewer", "bin", "launcher.exe"));
    await expect(discoverPortableSuite(root)).rejects.toThrow();
    expect(await isRecognizableSpineLibrary(join(root, "data"))).toBe(false);
    expect(await readdir(join(root, "data"))).toEqual([]);
  });

  test("uses explicit, remembered, then suite-local libraries in bounded precedence order", async () => {
    const root = await suiteRoot();
    const explicit = await writeLibrary(root, "explicit");
    const remembered = await writeLibrary(root, "remembered");
    const suiteData = await writeLibrary(join(root, "data"), "library");
    expect(await firstRecognizableLibraryPath([explicit, remembered, suiteData])).toBe(explicit);
    expect(await firstRecognizableLibraryPath([join(root, "missing"), remembered, suiteData])).toBe(remembered);
    expect(await firstRecognizableLibraryPath([null, null, suiteData])).toBe(suiteData);
    expect(await firstRecognizableLibraryPath([join(root, "missing")])).toBeNull();
  });

  test("leaves suite data untouched during discovery", async () => {
    const root = await suiteRoot();
    const library = await writeLibrary(join(root, "data"), "library");
    const before = await readFile(join(library, "catalog.json"), "utf8");
    await discoverPortableSuite(root);
    await firstRecognizableLibraryPath([join(root, "data", "library")]);
    expect(await readFile(join(library, "catalog.json"), "utf8")).toBe(before);
  });
});
