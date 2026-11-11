import { describe, expect, test } from "bun:test";
import { createEmptySpineComposition } from "@ba-spine/spine-runtime/spine/spineComposition";
import { applyCompositionEdits, normalizeCompositionEditOperation } from "./compositionEdits";

describe("typed composition edits", () => {
  test("strictly normalizes composition operation shapes at the MCP boundary", () => {
    expect(normalizeCompositionEditOperation({ kind: "set_duration", duration: 12 })).toEqual({ kind: "set_duration", duration: 12 });
    expect(normalizeCompositionEditOperation({ kind: "set_camera", camera: null })).toEqual({ kind: "set_camera", camera: null });
    expect(() => normalizeCompositionEditOperation({ kind: "remove_layer", layerId: "layer", propertyPath: "unsafe" })).toThrow(/unsupported field/);
    expect(() => normalizeCompositionEditOperation({ kind: "set_layer_base_property", layerId: "layer", property: "layer.position.x", value: { r: 1, g: 0, b: 0 } })).toThrow(/requires a/);
    expect(() => normalizeCompositionEditOperation({ kind: "upsert_property_track", track: {
      id: "track", target: { kind: "layer", layerId: "layer", path: "untyped" }, property: "layer.position.x", clock: { kind: "composition" },
      enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: false, holdAfter: false, keys: [],
    } })).toThrow(/unsupported field/);
  });

  test("applies section, layer, clip, track and keyframe edits as one valid draft", () => {
    const composition = createEmptySpineComposition("composition", "Composition", 8);
    const layer = {
      id: "character",
      name: "Character",
      role: "character" as const,
      order: 0,
      assetDirectory: "Airi_home",
      assetIdentity: "asset:airi",
      transformParentId: null,
      baseProperties: { "layer.position.x": 0 },
      enabled: true,
      locked: false,
    };
    const clip = {
      id: "talk-clip",
      layerId: layer.id,
      animation: "talk_01",
      clock: { kind: "composition" as const },
      sourceClock: { kind: "clip-source" as const },
      start: 1,
      end: 4,
      sourceStart: 0,
      sourceEnd: 3,
      sourceOriginTime: 1,
      sourceOffset: 0,
      speed: 1,
      loop: false,
      endBehavior: "clear" as const,
      blendIn: 0.14,
      blendOut: 0.14,
      mixingMode: "replace" as const,
      weight: 1,
      priority: 0,
      enabled: true,
    };
    const track = {
      id: "x-track",
      target: { kind: "layer" as const, layerId: layer.id },
      property: "layer.position.x",
      clock: { kind: "composition" as const },
      enabled: true,
      priority: 0,
      blendMode: "override" as const,
      weight: 1,
      holdBefore: false,
      holdAfter: true,
      keys: [],
    };

    const result = applyCompositionEdits(composition, [
      { kind: "upsert_layer", layer },
      { kind: "upsert_section", section: { id: "talk", name: "Talk", start: 1, end: 4 } },
      { kind: "upsert_animation_clip", clip },
      { kind: "upsert_property_track", track },
      { kind: "upsert_keyframe", trackId: track.id, key: { id: "x-start", time: 1, value: 0, interpolation: "linear" } },
      { kind: "upsert_keyframe", trackId: track.id, key: { id: "x-end", time: 4, value: 120, interpolation: "linear" } },
    ]);

    expect(result.composition.layers).toHaveLength(1);
    expect(result.composition.sections).toEqual([{ id: "talk", name: "Talk", start: 1, end: 4 }]);
    expect(result.composition.animationClips).toEqual([clip]);
    expect(result.composition.propertyTracks[0]?.keys.map(({ id }) => id)).toEqual(["x-start", "x-end"]);
    expect(result.createdEntityIds).toEqual(["character", "talk", "talk-clip", "x-track", "x-start", "x-end"]);
    expect(result.affectedEntityIds).toContain("x-track");
    expect(result.warnings).toEqual([]);
    expect(composition.layers).toHaveLength(0);
  });

  test("rejects invalid edits atomically and respects composition layer locks", () => {
    const composition = createEmptySpineComposition("composition", "Composition", 8);
    composition.layers.push({
      id: "locked",
      name: "Locked",
      role: "character",
      order: 0,
      assetDirectory: "Airi_home",
      assetIdentity: "asset:airi",
      transformParentId: null,
      baseProperties: {},
      enabled: true,
      locked: true,
    });

    expect(() => applyCompositionEdits(composition, [
      { kind: "set_layer_base_property", layerId: "locked", property: "layer.position.x", value: 10 },
    ])).toThrow("Composition layer is locked: locked");
    expect(composition.layers[0]?.baseProperties).toEqual({});
    expect(() => applyCompositionEdits(composition, [
      { kind: "upsert_section", section: { id: "bad", name: "Bad", start: 9, end: 8 } },
    ])).toThrow("Composition edit is invalid: invalid-range");
    expect(composition.sections).toEqual([]);
  });

  test("removes a keyframe by stable track and key IDs", () => {
    const composition = createEmptySpineComposition("composition", "Composition", 8);
    composition.layers.push({
      id: "layer",
      name: "Layer",
      role: "character",
      order: 0,
      assetDirectory: "Airi_home",
      assetIdentity: "asset:airi",
      transformParentId: null,
      baseProperties: {},
      enabled: true,
      locked: false,
    });
    composition.propertyTracks.push({
      id: "track",
      target: { kind: "layer", layerId: "layer" },
      property: "layer.position.x",
      clock: { kind: "composition" },
      enabled: true,
      priority: 0,
      blendMode: "override",
      weight: 1,
      holdBefore: false,
      holdAfter: false,
      keys: [{ id: "key", time: 1, value: 4, interpolation: "linear" }],
    });

    const result = applyCompositionEdits(composition, [{ kind: "remove_keyframe", trackId: "track", keyId: "key" }]);
    expect(result.composition.propertyTracks[0]?.keys).toEqual([]);
    expect(result.affectedEntityIds).toEqual(["track", "key"]);
  });

  test("locked layer tracks cannot be removed through composition operations", () => {
    const composition = createEmptySpineComposition("composition", "Composition", 8);
    composition.layers.push({
      id: "locked",
      name: "Locked",
      role: "character",
      order: 0,
      assetDirectory: "Airi_home",
      assetIdentity: "asset:airi",
      transformParentId: null,
      baseProperties: {},
      enabled: true,
      locked: true,
    });
    composition.propertyTracks.push({
      id: "locked-track",
      target: { kind: "layer", layerId: "locked" },
      property: "layer.position.x",
      clock: { kind: "composition" },
      enabled: true,
      priority: 0,
      blendMode: "override",
      weight: 1,
      holdBefore: false,
      holdAfter: false,
      keys: [],
    });
    expect(() => applyCompositionEdits(composition, [{ kind: "remove_property_track", trackId: "locked-track" }])).toThrow("Composition layer is locked: locked");
    expect(composition.propertyTracks).toHaveLength(1);
  });
});
