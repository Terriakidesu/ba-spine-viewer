import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ViewerThumbnailCache } from "./viewerThumbnailCache";

describe("external Viewer thumbnail cache", () => {
  test("invalidates only the selected lobby in the selected library", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ba-spine-thumbnail-fixture-"));
    const cacheRoot = join(temporary, "app-data-cache");
    const libraryRoot = join(temporary, "fixture-library");
    await mkdir(libraryRoot, { recursive: true });
    await writeFile(join(libraryRoot, "sentinel.json"), "fixture source stays unchanged");
    const cache = new ViewerThumbnailCache(cacheRoot);
    const first = new Uint8Array([1, 2, 3]);
    const other = new Uint8Array([4, 5, 6]);
    try {
      await cache.put(libraryRoot, "Airi_home", "v1", "image/png", first);
      await cache.put(libraryRoot, "Hina_home", "v1", "image/png", other);
      await cache.put(join(temporary, "other-fixture-library"), "Airi_home", "v1", "image/png", other);

      await cache.invalidate(libraryRoot, "Airi_home");

      expect(await cache.get(libraryRoot, "Airi_home", "v1")).toBeNull();
      expect(await cache.get(libraryRoot, "Hina_home", "v1")).toMatchObject({ bytes: other, contentType: "image/png" });
      expect(await cache.get(join(temporary, "other-fixture-library"), "Airi_home", "v1")).toMatchObject({ bytes: other, contentType: "image/png" });
      expect(cacheRoot).not.toBe(libraryRoot);
      expect(await readFile(join(libraryRoot, "sentinel.json"), "utf8")).toBe("fixture source stays unchanged");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps only the latest version and rejects unsupported or oversized images", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ba-spine-thumbnail-fixture-"));
    const cache = new ViewerThumbnailCache(join(temporary, "cache"));
    try {
      await cache.put("/fixture/library", "Airi_home", "old-fingerprint", "image/webp", new Uint8Array([1]));
      await cache.put("/fixture/library", "Airi_home", "new-fingerprint", "image/webp", new Uint8Array([2]));
      expect(await cache.get("/fixture/library", "Airi_home", "old-fingerprint")).toBeNull();
      expect(await cache.get("/fixture/library", "Airi_home", "new-fingerprint")).toMatchObject({ bytes: new Uint8Array([2]), contentType: "image/webp" });
      await expect(cache.put("/fixture/library", "Airi_home", "bad", "text/plain", new Uint8Array([1]))).rejects.toThrow("WebP or PNG");
      await expect(cache.put("/fixture/library", "Airi_home", "large", "image/png", new Uint8Array(1024 * 1024 + 1))).rejects.toThrow("1 MB");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
