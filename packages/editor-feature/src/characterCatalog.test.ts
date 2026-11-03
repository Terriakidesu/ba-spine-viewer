import { expect, test } from "bun:test";
import { characterDirectoryLabel, parseCharacterDirectoryCatalog, parseCharacterDirectoryLabels } from "./characterCatalog";

test("character catalog labels variants with their display name and asset id", () => {
  const labels = parseCharacterDirectoryLabels({
    characters: {
      Seia: {
        variants: [
          { variant: "Base", directory: "CH0070_home", assetId: "CH0070" },
          { variant: "Swimsuit", directory: "CH0295_home", assetId: "CH0295" },
        ],
        extras: [{ type: "scene", directory: "Seia_scene" }],
      },
    },
  });
  expect(characterDirectoryLabel("CH0070_home", labels)).toBe("Seia (CH0070)");
  expect(characterDirectoryLabel("CH0295_home", labels)).toBe("Seia Swimsuit (CH0295)");
  expect(characterDirectoryLabel("Seia_scene", labels)).toBe("Seia Scene");
  expect(characterDirectoryLabel("unknown_home", labels)).toBe("unknown_home");
});

test("character catalog retains family grouping, role badges, and related extras", () => {
  const catalog = parseCharacterDirectoryCatalog({
    characters: {
      Seia: {
        role: "Special",
        variants: [{ variant: "Base", directory: "CH0070_home", assetId: "CH0070" }],
        extras: [
          { type: "scene", directory: "Seia_scene" },
          { type: "background", directory: "Seia_background" },
        ],
      },
    },
  });
  expect(catalog).toEqual({
    CH0070_home: { label: "Seia (CH0070)", group: "Seia", kind: "character", role: "Special" },
    Seia_scene: { label: "Seia Scene", group: "Seia", kind: "scene", role: "Scene" },
    Seia_background: { label: "Seia Background", group: "Seia", kind: "background", role: "Background" },
  });
  expect(parseCharacterDirectoryLabels({ characters: { Seia: { variants: [{ directory: "CH0070_home" }] } } })).toEqual({ CH0070_home: "Seia" });
});
