import { describe, expect, test } from "bun:test";
import { SPINE_MANIFEST_SCHEMA_VERSION, normalizeSpineCatalog, normalizeSpineManifest } from "./spineManifest";

const manifestValue = (schemaVersion?: number) => ({
  ...(schemaVersion === undefined ? {} : { schemaVersion }),
  id: "Airi_home",
  entrySequence: null,
  entryMode: "runtime-intro",
  assets: {
    Airi_home: {
      atlas: { scope: "lobby", path: "spine/Airi_home.atlas" },
      skeletons: [{ scope: "lobby", path: "spine/Airi_home.skel" }],
    },
  },
});

describe("Spine manifest schema versions", () => {
  test("uses the supported version for legacy manifests that omit it", () => {
    expect(normalizeSpineManifest(manifestValue())?.schemaVersion).toBe(SPINE_MANIFEST_SCHEMA_VERSION);
    expect(normalizeSpineCatalog({ lobbies: {} })?.schemaVersion).toBe(SPINE_MANIFEST_SCHEMA_VERSION);
  });

  test("preserves future versions so the Editor can explain compatibility warnings", () => {
    expect(normalizeSpineManifest(manifestValue(9))?.schemaVersion).toBe(9);
  });
});
