import { describe, expect, test } from "bun:test";
import { indexedAssets, readCharacterIndex, sourceFromDirectory, sourceFromInput } from "./spineAssets";

type MockEntry = FileSystemFileHandle | MockDirectory;

interface MockDirectory extends FileSystemDirectoryHandle {
  entries: () => AsyncIterableIterator<[string, MockEntry]>;
}

function mockFile(name: string, contents = "asset"): FileSystemFileHandle {
  const file = new File([contents], name);
  return {
    kind: "file",
    name,
    getFile: async () => file,
  } as unknown as FileSystemFileHandle;
}

function mockDirectory(name: string, children: MockEntry[]): MockDirectory {
  const directory = {
    kind: "directory",
    name,
    async *entries() {
      for (const child of children) yield [child.name, child];
    },
    async getDirectoryHandle(childName: string) {
      const child = children.find((entry) => entry.kind === "directory" && entry.name === childName);
      if (!child) throw new Error(`Missing directory: ${childName}`);
      return child;
    },
    async getFileHandle(childName: string) {
      const child = children.find((entry) => entry.kind === "file" && entry.name === childName);
      if (!child) throw new Error(`Missing file: ${childName}`);
      return child;
    },
  } as unknown as MockDirectory;
  return directory;
}

function inputFile(path: string): File {
  const name = path.split("/").pop()!;
  const file = new File([path], name);
  Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path });
  return file;
}

function fileList(paths: string[]): FileList {
  const files = paths.map(inputFile) as File[] & { item: (index: number) => File | null };
  files.item = (index) => files[index] ?? null;
  return files as unknown as FileList;
}

describe("Spine local asset sources", () => {
  test("keeps extras in a separate indexed asset group", () => {
    expect(indexedAssets({
      variants: [{ variant: "Base", directory: "Airi_home" }],
      extras: [
        { type: "alternate-home", directory: "Airi0_home" },
        { type: "background", directory: "Airi_bg", assetId: "BG001" },
      ],
    })).toEqual([
      { variant: "Base", directory: "Airi_home" },
      { variant: "alternate-home", directory: "Airi0_home", extraType: "alternate-home" },
      { variant: "background", directory: "Airi_bg", assetId: "BG001", extraType: "background" },
    ]);
  });

  test("reads a valid selected-root catalog and omits private root metadata", async () => {
    const localIndex = mockFile("characters.json", JSON.stringify({
      schemaVersion: 1,
      source: "private local metadata",
      characters: {
        Aru: {
          variants: [{ variant: "Base", directory: "Aru_home", assetId: "CH0001", devName: "Aru_default" }],
          extras: [{ type: "scene", directory: "Aru_scene" }],
        },
      },
    }));
    const source = sourceFromDirectory(mockDirectory("selected-assets", [localIndex]));
    const fallback = { schemaVersion: 1, characters: { Hina: { variants: [{ variant: "Base", directory: "Hina_home" }] } } };

    const index = await readCharacterIndex(source, fallback);

    expect(index).toEqual({
      schemaVersion: 1,
      characters: {
        Aru: {
          variants: [{ variant: "Base", directory: "Aru_home", assetId: "CH0001", devName: "Aru_default" }],
          extras: [{ type: "scene", directory: "Aru_scene" }],
        },
      },
    });
    expect(JSON.stringify(index)).not.toContain("private local metadata");
  });

  test("falls through a malformed characters file to the selected-root catalog", async () => {
    const source = sourceFromDirectory(mockDirectory("selected-assets", [
      mockFile("characters.json", "not valid json"),
      mockFile("catalog.json", JSON.stringify({
        schemaVersion: 1,
        characters: { Airi: { variants: [{ variant: "Base", directory: "Airi_home" }] } },
      })),
    ]));
    const fallback = { schemaVersion: 1, characters: { Hina: { variants: [{ variant: "Base", directory: "Hina_home" }] } } };

    expect(await readCharacterIndex(source, fallback)).toEqual({
      schemaVersion: 1,
      characters: { Airi: { variants: [{ variant: "Base", directory: "Airi_home" }] } },
    });
  });

  test("resolves lobby sets and voice files relative to a selected asset root", async () => {
    const atlas = mockFile("Airi_home.atlas");
    const skeleton = mockFile("Airi_home.skel");
    const image = mockFile("Airi_home.png");
    const voiceManifest = mockFile("voicelines.json", "manifest");
    const lobby = mockDirectory("Airi_home", [atlas, skeleton, image]);
    const root = mockDirectory("selected-assets", [
      mockDirectory("lobbies", [lobby]),
      mockDirectory("audios", [mockDirectory("voicelines", [voiceManifest])]),
      mockFile("characters.json", "index"),
    ]);

    const source = sourceFromDirectory(root);
    expect(await source.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await source.getSetFiles("Airi_home")).keys())]).toEqual([
      "Airi_home.atlas",
      "Airi_home.skel",
      "Airi_home.png",
    ]);
    expect(await source.getFile("audios/voicelines/voicelines.json")).toBe(await voiceManifest.getFile());
  });

  test("treats a selected individual lobby as one direct set", async () => {
    const root = mockDirectory("Airi_home", [mockFile("Airi_home.atlas"), mockFile("Airi_home.skel")]);
    const source = sourceFromDirectory(root);

    expect(await source.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await source.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel"]);
  });

  test("recursively catalogs sets and keeps the root editor data readable", async () => {
    const project = mockFile("Airi_home.spine-project.json", "project");
    const nestedSet = mockDirectory("Airi_home", [mockFile("Airi_home.atlas"), mockFile("Airi_home.skel"), mockFile("Airi_home.png")]);
    const ignoredSet = mockDirectory("Fake_home", [mockFile("Fake_home.atlas"), mockFile("Fake_home.skel")]);
    const root = mockDirectory("ba-spine", [
      mockFile(".editorignore", "sprites/"),
      mockDirectory(".editor", [project]),
      mockDirectory("lobbies", [nestedSet]),
      mockDirectory("sprites", [ignoredSet]),
    ]);

    const source = sourceFromDirectory(root);
    expect(await source.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await source.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel", "Airi_home.png"]);
    expect(await source.getFile(".editor/Airi_home.spine-project.json")).toBe(await project.getFile());
  });

  test("handles the directory-input fallback for a whole root and a lobby folder", async () => {
    const rootSource = sourceFromInput(fileList([
      "bundle/lobbies/Airi_home/Airi_home.atlas",
      "bundle/lobbies/Airi_home/Airi_home.skel",
      "bundle/audios/voicelines/voicelines.json",
    ]));
    expect(await rootSource.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await rootSource.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel"]);
    expect((await rootSource.getFile("audios/voicelines/voicelines.json"))?.name).toBe("voicelines.json");

    const lobbySource = sourceFromInput(fileList([
      "Airi_home/Airi_home.atlas",
      "Airi_home/Airi_home.skel",
    ]));
    expect(await lobbySource.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await lobbySource.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel"]);
  });

  test("catalogs nested input sets without requiring a lobbies directory", async () => {
    const source = sourceFromInput(fileList([
      "ba-spine/assets/characters/Airi_home/Airi_home.atlas",
      "ba-spine/assets/characters/Airi_home/Airi_home.skel",
      "ba-spine/assets/characters/Airi_home/Airi_home.png",
      "ba-spine/.editor/Airi_home.spine-project.json",
    ]));

    expect(await source.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await source.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel", "Airi_home.png"]);
    expect((await source.getFile(".editor/Airi_home.spine-project.json"))?.name).toBe("Airi_home.spine-project.json");
  });

  test("uses explicit manifest asset paths instead of scanning the lobby directory", async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      id: "Airi_home",
      entrySequence: null,
      entryMode: "runtime-intro",
      assets: {
        Airi_home: {
          atlas: { scope: "lobby", path: "spine/Airi_home.atlas" },
          skeletons: [{ scope: "lobby", path: "spine/Airi_home.skel" }],
          pages: [{ scope: "lobby", path: "spine/Airi_home.png" }],
          files: [
            { scope: "lobby", path: "spine/Airi_home.atlas" },
            { scope: "lobby", path: "spine/Airi_home.skel" },
            { scope: "lobby", path: "spine/Airi_home.png" },
          ],
        },
      },
    });
    const root = mockDirectory("ba-spine", [
      mockDirectory("lobbies", [mockDirectory("Airi_home", [
        mockFile("manifest.json", manifest),
        mockDirectory("spine", [mockFile("Airi_home.atlas"), mockFile("Airi_home.skel"), mockFile("Airi_home.png")]),
      ])]),
    ]);
    const source = sourceFromDirectory(root);
    expect(await source.getDirectories()).toEqual(["Airi_home"]);
    expect([...((await source.getSetFiles("Airi_home")).keys())]).toEqual(["Airi_home.atlas", "Airi_home.skel", "Airi_home.png"]);
    expect((await source.getManifest?.("Airi_home"))?.manifest.entrySequence).toBeNull();
  });

  test("resolves canonical voice paths when only the voice folder was selected", async () => {
    const source = sourceFromInput(fileList([
      "voicelines/Airi/Airi_MemorialLobby_1_1.ogg",
    ]));
    expect((await source.getFile("audios/voicelines/Airi/Airi_MemorialLobby_1_1.ogg"))?.name).toBe("Airi_MemorialLobby_1_1.ogg");
  });

  test("resolves canonical voice paths from a selected voice directory", async () => {
    const voice = mockFile("Airi_MemorialLobby_1_1.ogg");
    const source = sourceFromDirectory(mockDirectory("voicelines", [mockDirectory("Airi", [voice])]));
    expect((await source.getFile("audios/voicelines/Airi/Airi_MemorialLobby_1_1.ogg"))?.name).toBe("Airi_MemorialLobby_1_1.ogg");
  });
});
