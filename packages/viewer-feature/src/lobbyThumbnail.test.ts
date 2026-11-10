import { describe, expect, test } from "bun:test";
import type { DesktopAssetSource } from "./desktopSource";
import { getViewerThumbnail } from "./lobbyThumbnail";

describe("saved lobby thumbnails", () => {
  test("both thumbnail styles read the saved PNG without touching Spine or the generated cache", async () => {
    const image = new File(["saved thumbnail"], "thumbnail.png", { type: "image/png" });
    const paths: string[] = [];
    const forbidden = async () => { throw new Error("Browsing must not load or render Spine assets."); };
    const source = {
      getFile: async (path: string) => { paths.push(path); return image; },
      getThumbnailFingerprint: forbidden, getThumbnailFiles: forbidden, getThumbnail: forbidden, putThumbnail: forbidden,
    } as unknown as DesktopAssetSource;
    for (const kind of ["face", "lobby"] as const) {
      expect(await getViewerThumbnail(source, "Airi_home", kind, new AbortController().signal)).toBe(image);
    }
    expect(paths).toEqual(["lobbies/Airi_home/thumbnail.png", "lobbies/Airi_home/thumbnail.png"]);
  });

  test("missing thumbnails stay placeholders, without generation", async () => {
    const source = { getFile: async () => null } as unknown as DesktopAssetSource;
    expect(await getViewerThumbnail(source, "Airi_home", "lobby", new AbortController().signal)).toBeNull();
  });

  test("cancelled requests perform no IO", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = { getFile: async () => { throw new Error("Unexpected IO"); } } as unknown as DesktopAssetSource;
    await expect(getViewerThumbnail(source, "Airi_home", "lobby", controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
});
