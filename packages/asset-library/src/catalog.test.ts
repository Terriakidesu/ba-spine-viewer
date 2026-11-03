import { describe, expect, test } from "bun:test";
import { discoverSpineSets, type LibraryReader } from "./catalog";

const manifest = {
  schemaVersion: 1,
  id: "Airi_home",
  atlas: { scope: "lobby", path: "spine/Airi_home.atlas" },
  skeleton: { scope: "lobby", path: "spine/Airi_home.skel" },
  assets: {
    Airi_home: { atlas: { scope: "lobby", path: "spine/Airi_home.atlas" }, skeletons: [{ scope: "lobby", path: "spine/Airi_home.skel" }], files: [{ scope: "lobby", path: "spine/Airi_home.atlas" }] },
    Airi_bg: { atlas: { scope: "root", path: "lobbies/Airi_bg/scene.atlas" }, files: [{ scope: "root", path: "lobbies/Airi_bg/scene.atlas" }] },
  },
};

function reader(files: Record<string, string>, directories: Record<string, Array<{ name: string; kind: "file" | "directory" }>> = {}): LibraryReader {
  return {
    async readText(path) { return files[path] ?? null; },
    async readDirectory(path) { return directories[path] ?? []; },
  };
}

describe("asset library catalog discovery", () => {
  test("resolves primary and related manifest assets concurrently into stable sets", async () => {
    const catalog = JSON.stringify({ schemaVersion: 1, lobbies: { Airi_home: { manifest: "lobbies/Airi_home/manifest.json" } } });
    const sets = await discoverSpineSets(reader({
      "catalog.json": catalog,
      "lobbies/Airi_home/manifest.json": JSON.stringify(manifest),
    }));
    expect(sets.map((set) => set.directory)).toEqual(["Airi_bg", "Airi_home"]);
    expect(sets.find((set) => set.directory === "Airi_home")?.files).toEqual(["lobbies/Airi_home/spine/Airi_home.atlas"]);
    expect(sets.find((set) => set.directory === "Airi_bg")?.files).toEqual(["lobbies/Airi_bg/scene.atlas"]);
  });

  test("can restrict the editor picker to primary lobby sets", async () => {
    const sets = await discoverSpineSets(reader({
      "catalog.json": JSON.stringify({ schemaVersion: 1, lobbies: { Airi_home: { manifest: "lobbies/Airi_home/manifest.json" } } }),
      "lobbies/Airi_home/manifest.json": JSON.stringify(manifest),
    }), { includeRelated: false });
    expect(sets.map((set) => set.directory)).toEqual(["Airi_home"]);
  });

  test("bounds concurrent manifest reads to the requested limit", async () => {
    const lobbies = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`Set_${index}`, { manifest: `lobbies/Set_${index}/manifest.json` }]));
    let active = 0;
    let maximum = 0;
    const catalog = JSON.stringify({ schemaVersion: 1, lobbies });
    const source: LibraryReader = {
      async readText(path) {
        if (path === "catalog.json") return catalog;
        if (!path.endsWith("/manifest.json")) return null;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        const id = path.split("/")[1]!;
        return JSON.stringify({ ...manifest, id, assets: { [id]: manifest.assets.Airi_home } });
      },
      async readDirectory() { return []; },
    };
    const sets = await discoverSpineSets(source, { includeRelated: false, manifestConcurrency: 3 });
    expect(sets).toHaveLength(19);
    expect(maximum).toBe(3);
  });

  test("falls back to recursive discovery and applies .editorignore", async () => {
    const sets = await discoverSpineSets(reader({
      ".editorignore": "sprites/",
    }, {
      "": [{ name: "lobbies", kind: "directory" }, { name: "sprites", kind: "directory" }],
      "lobbies": [{ name: "Legacy_home", kind: "directory" }],
      "lobbies/Legacy_home": [{ name: "Legacy.atlas", kind: "file" }],
      "sprites": [{ name: "generated", kind: "directory" }],
      "sprites/generated": [{ name: "ignore.atlas", kind: "file" }],
    }));
    expect(sets.map((set) => set.directory)).toEqual(["Legacy_home"]);
  });
});
