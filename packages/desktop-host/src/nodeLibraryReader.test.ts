import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { assertLibraryWritePath } from "./pathPolicy";
import { createNodeLibraryReader } from "./nodeLibraryReader";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ba-spine-library-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("read-only native library adapter", () => {
  test("reads a contained synthetic library and lists only ordinary files/directories", async () => {
    await withFixture(async (root) => {
      await mkdir(join(root, "lobbies", "Airi_home", "spine"), { recursive: true });
      await writeFile(join(root, "catalog.json"), "{\"schemaVersion\":1}", "utf8");
      await writeFile(join(root, "lobbies", "Airi_home", "spine", "lobby.atlas"), "atlas", "utf8");
      const reader = createNodeLibraryReader(root);

      expect(await reader.readText("catalog.json")).toBe("{\"schemaVersion\":1}");
      expect(await reader.readText("missing.json")).toBeNull();
      expect(await reader.readText("lobbies/Airi_home/spine/lobby.atlas")).toBe("atlas");
      expect(await reader.readDirectory("lobbies/Airi_home/spine")).toEqual([{ name: "lobby.atlas", kind: "file" }]);
      await expect(reader.readText("../outside.json")).rejects.toThrow();
    });
  });

  test("keeps editor write targets inside the selected root", async () => {
    await withFixture(async (root) => {
      await mkdir(join(root, "lobbies", "Airi_home"), { recursive: true });
      await assertLibraryWritePath(root, join(root, "lobbies", "Airi_home", "manifest.json"));
      await expect(assertLibraryWritePath(root, join(root, "..", "outside.json"))).rejects.toThrow();
    });
  });
});
