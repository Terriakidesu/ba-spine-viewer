import { describe, expect, test } from "bun:test";
import type { DesktopAssetSource } from "./desktopSource";
import { getViewerThumbnail } from "./lobbyThumbnail";

describe("Viewer thumbnail memory cache", () => {
  test("reuses the same fingerprinted image after a thumbnail row remounts", async () => {
    const image = new Blob(["cached preview"], { type: "image/webp" });
    let cacheReads = 0;
    const source = {
      desktop: true,
      rootPath: `thumbnail-memory-test-${Date.now()}-${Math.random()}`,
      getThumbnailFingerprint: async () => "fixture-fingerprint",
      getThumbnail: async () => { cacheReads++; return image; },
      getThumbnailFiles: async () => { throw new Error("A cache hit must not load Spine files."); },
      putThumbnail: async () => undefined,
    } as unknown as DesktopAssetSource;

    const first = await getViewerThumbnail(source, "Airi_home", "lobby", new AbortController().signal);
    const second = await getViewerThumbnail(source, "Airi_home", "lobby", new AbortController().signal);

    expect(first).toBe(image);
    expect(second).toBe(image);
    expect(cacheReads).toBe(1);
  });

  test("separates face and lobby images even when they share source assets", async () => {
    const images = new Map([
      ["lobby-v2:fixture-fingerprint", new Blob(["lobby"], { type: "image/webp" })],
      ["face-v1:fixture-fingerprint", new Blob(["face"], { type: "image/webp" })],
    ]);
    let cacheReads = 0;
    const source = {
      desktop: true,
      rootPath: `thumbnail-kinds-test-${Date.now()}-${Math.random()}`,
      getThumbnailFingerprint: async () => "fixture-fingerprint",
      getThumbnail: async (_directory: string, fingerprint: string) => { cacheReads++; return images.get(fingerprint) ?? null; },
      getThumbnailFiles: async () => { throw new Error("A cache hit must not load Spine files."); },
      putThumbnail: async () => undefined,
    } as unknown as DesktopAssetSource;

    const lobby = await getViewerThumbnail(source, "Airi_home", "lobby", new AbortController().signal);
    const face = await getViewerThumbnail(source, "Airi_home", "face", new AbortController().signal);

    expect(await lobby?.text()).toBe("lobby");
    expect(await face?.text()).toBe("face");
    expect(cacheReads).toBe(2);
  });
});
