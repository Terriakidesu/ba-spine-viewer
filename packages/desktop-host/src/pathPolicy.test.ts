import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isPathWithinLibrary, isSupportedEditorWritePath, normalizeLibraryRelativePath, resolveLibraryPath } from "./pathPolicy";

describe("native library path policy", () => {
  test("normalizes separators but rejects absolute and traversal paths", () => {
    expect(normalizeLibraryRelativePath("lobbies\\Airi_home\\manifest.json")).toBe("lobbies/Airi_home/manifest.json");
    for (const path of ["", "/etc/passwd", "C:\\temp\\file", "../outside", "lobbies/../outside", "lobbies/./file"]) {
      expect(() => normalizeLibraryRelativePath(path)).toThrow();
    }
  });

  test("resolves only a contained relative path", () => {
    const root = process.platform === "win32" ? "D:/library" : "/tmp/library";
    expect(resolveLibraryPath(root, "lobbies/Airi_home/manifest.json")).toBe(resolve(root, "lobbies", "Airi_home", "manifest.json"));
    expect(() => resolveLibraryPath(root, "../../outside.json")).toThrow();
  });

  test("checks resolved paths using platform-aware containment", () => {
    expect(isPathWithinLibrary("D:/library", "D:/library/lobbies/Airi_home" )).toBe(true);
    expect(isPathWithinLibrary("D:/library", "D:/library-backup/file.json")).toBe(false);
  });

  test("limits editor writes to authored project metadata", () => {
    for (const path of [
      ".editor/Airi_home.workspace.json",
      ".editor/backups/save-1730000000000-123e4567-e89b-12d3-a456-426614174000.json",
      "lobbies/Airi_home/manifest.json",
      "lobbies/Airi_home/interactions.json",
      "lobbies/Airi_home/sequences/opening.json",
      "lobbies/Airi_home/.editor/workspace.json",
      "audios/voicelines/Airi/subtitles.json",
    ]) expect(isSupportedEditorWritePath(path)).toBe(true);

    for (const path of [
      "catalog.json",
      ".editor/backups/../manifest.json",
      "characters.json",
      "lobbies/Airi_home/spine/Airi_home.skel",
      "lobbies/Airi_home/spine/Airi_home.atlas",
      "lobbies/Airi_home/spine/Airi_home.png",
      "audios/voicelines/Airi/voice.ogg",
      "../../outside.json",
    ]) expect(isSupportedEditorWritePath(path)).toBe(false);
  });
});
