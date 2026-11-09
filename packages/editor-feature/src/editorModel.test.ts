import { describe, expect, test } from "bun:test";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import {
  createProject,
  compositionDirectories,
  EDITOR_SCHEMA_VERSION,
  ensureTimelineLayers,
  isLegacyPinchRegion,
  normalizeProject,
  normalizeViewSettings,
  repairPinchRegions,
  validateProject,
  type EditorProject,
} from "./editorModel";

function bone(path: string, name = path.split("/").pop()!, x = 0, y = 0): SpineEditorBone {
  return {
    path,
    name,
    parentPath: null,
    x,
    y,
    endX: x + 10,
    endY: y,
    screenX: x,
    screenY: y,
    screenEndX: x + 10,
    screenEndY: y,
    screenLocalXEndX: x + 1,
    screenLocalXEndY: y,
    screenLocalYEndX: x,
    screenLocalYEndY: y + 1,
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    length: 10,
    rotation: 0,
    active: true,
  };
}

test("background timeline layers follow the main animation by default and keep explicit overrides", () => {
  const project = normalizeProject({
    schemaVersion: 2,
    assetDirectory: "Akari_home",
    interactions: [],
    timeline: {
      layers: [
        { id: "character", directory: "Akari_home", role: "character" },
        { id: "background", directory: "akari_bg", role: "background", followMainAnimation: false },
      ],
    },
  }, "Akari_home");
  expect(project?.timeline.layers.find((layer) => layer.role === "background")?.followMainAnimation).toBe(false);

  const legacy = normalizeProject({
    schemaVersion: 2,
    assetDirectory: "Akari_home",
    interactions: [],
    timeline: { layers: [{ id: "background", directory: "akari_bg", role: "background" }] },
  }, "Akari_home");
  expect(legacy?.timeline.layers.find((layer) => layer.role === "background")?.followMainAnimation).toBe(true);
});

test("project Light FX strength defaults, clamps, and survives normalization", () => {
  const project = createProject("Airi_home", [], []);
  expect(project.effectsStrength).toBe(0.5);
  project.effectsStrength = 0.85;
  expect(normalizeProject(JSON.parse(JSON.stringify(project)), "Airi_home")?.effectsStrength).toBe(0.85);
  expect(normalizeProject({ ...project, effectsStrength: 4 }, "Airi_home")?.effectsStrength).toBe(1);
  expect(normalizeProject({ ...project, effectsStrength: -2 }, "Airi_home")?.effectsStrength).toBe(0);
});

test("look-follow settings migrate from legacy projects and survive normalization", () => {
  const defaults = createProject("Airi_home", [], []);
  expect(defaults.lookFollow).toMatchObject({ enabled: true, targetBonePath: null, delay: 0.3, rangeX: null, rangeY: null, smoothing: 14, allowX: true, allowY: true });

  const legacy = normalizeProject({ schemaVersion: 6, assetDirectory: "Airi_home", interactions: [] }, "Airi_home")!;
  expect(legacy.lookFollow).toEqual(defaults.lookFollow);

  const authored = normalizeProject({
    ...defaults,
    lookFollow: {
      enabled: false,
      targetBonePath: "root/Touch_Eye",
      delay: 4,
      rangeX: 88,
      rangeY: null,
      smoothing: 0,
      allowX: false,
      allowY: true,
      startAnimation: "Look_Custom_M",
      faceStartAnimation: "",
      endAnimation: "Look_Custom_End_M",
      faceEndAnimation: "Look_Custom_End_A",
    },
  }, "Airi_home")!;
  expect(authored.lookFollow).toMatchObject({ enabled: false, targetBonePath: "root/Touch_Eye", delay: 2, rangeX: 88, rangeY: null, smoothing: 1, allowX: false, allowY: true, startAnimation: "Look_Custom_M", endAnimation: "Look_Custom_End_M" });
  expect(normalizeProject(JSON.parse(JSON.stringify(authored)), "Airi_home")?.lookFollow).toEqual(authored.lookFollow);
});

test("legacy behavior projects receive a default graph layout and manual positions survive reload", () => {
  const legacyProject = createProject("Airi_home", ["Pat_01_M", "Pat_02_M", "PatEnd_01_M"], []);
  const patting = legacyProject.behaviorMachines!.find((machine) => machine.name === "Patting")!;
  const migrated = normalizeProject({
    ...legacyProject,
    schemaVersion: 7,
    behaviorGraphLayouts: undefined,
  }, "Airi_home")!;
  const migratedLayout = migrated.behaviorGraphLayouts[patting.id]!;
  expect(migratedLayout.mode).toBe("auto");
  expect(Object.keys(migratedLayout.statePositions).sort()).toEqual(patting.states.map((state) => state.id).sort());
  const flowX = ["idle", "starting", "active", "releasing"].map((id) => migratedLayout.statePositions[id]!.x);
  expect(flowX[0]).toBeLessThan(flowX[1]!);
  expect(flowX[1]).toBeLessThan(flowX[2]!);
  expect(flowX[2]).toBeLessThan(flowX[3]!);

  const manual = {
    ...migrated,
    behaviorGraphLayouts: {
      ...migrated.behaviorGraphLayouts,
      [patting.id]: { mode: "manual" as const, statePositions: { ...migratedLayout.statePositions, active: { x: 612, y: 244 } } },
    },
  };
  const reopened = normalizeProject(JSON.parse(JSON.stringify(manual)), "Airi_home")!;
  expect(reopened.behaviorGraphLayouts[patting.id]?.mode).toBe("manual");
  expect(reopened.behaviorGraphLayouts[patting.id]?.statePositions.active).toEqual({ x: 612, y: 244 });
  expect(reopened.behaviorMachines).toEqual(migrated.behaviorMachines);
});

test("legacy Talk timelines migrate to auto duration without resetting current manual overrides", () => {
  const legacy = normalizeProject({
    schemaVersion: 2,
    assetDirectory: "Akari_home",
    interactions: [],
    timeline: { sequenceId: "talk-1", duration: 19, durationMode: "manual", layers: [] },
    sequences: { "talk-2": { sequenceId: "talk-2", duration: 18, durationMode: "manual", layers: [] } },
  }, "Akari_home")!;
  expect(legacy.timeline.durationMode).toBe("auto");
  expect(legacy.sequences?.["talk-2"]?.durationMode).toBe("auto");

  const current = normalizeProject({
    schemaVersion: 3,
    assetDirectory: "Akari_home",
    interactions: [],
    timeline: { sequenceId: "talk-1", duration: 19, durationMode: "manual", layers: [] },
  }, "Akari_home")!;
  expect(current.timeline.durationMode).toBe("manual");
  expect(current.timeline.colorLayers).toEqual([]);
});

test("color compositor settings and clips survive project save and reopen", () => {
  const project = normalizeProject({
    schemaVersion: 4,
    assetDirectory: "Akari_home",
    interactions: [],
    timeline: {
      sequenceId: "opening",
      duration: 6,
      durationMode: "auto",
      layers: [{ id: "character", directory: "Akari_home", role: "character", order: 1, blendMode: "screen" }],
      colorLayers: [{
        id: "wash", name: "Blue wash", enabled: true, locked: true, opacity: 0.75, order: 0, blendMode: "multiply",
        clips: [{ id: "fade", name: "Fade", color: "#1234AB", start: 1, end: 6, opacity: 0.6, fadeIn: 1.5, fadeOut: 2, enabled: false }],
      }],
      selectedColorLayerId: "wash",
      selectedColorClipId: "fade",
    },
    sequences: { "talk-1": { sequenceId: "talk-1", layers: [], colorLayers: [{ id: "talk-wash", clips: [] }] } },
  }, "Akari_home")!;
  const reopened = normalizeProject(JSON.parse(JSON.stringify(project)), "Akari_home")!;
  expect(reopened.timeline.layers[0]).toMatchObject({ order: 1, blendMode: "screen", locked: false });
  expect(reopened.timeline.colorLayers[0]).toMatchObject({ id: "wash", name: "Blue wash", enabled: true, locked: true, opacity: 0.75, order: 0, blendMode: "multiply" });
  expect(reopened.timeline.colorLayers[0]?.clips[0]).toMatchObject({ id: "fade", color: "#1234AB", start: 1, end: 6, opacity: 0.6, fadeIn: 1.5, fadeOut: 2, enabled: false });
  expect(reopened.timeline).toMatchObject({ selectedColorLayerId: "wash", selectedColorClipId: "fade" });
  expect(reopened.sequences?.["talk-1"]?.colorLayers[0]?.id).toBe("talk-wash");
  expect(reopened.timeline.durationMode).toBe("auto");
});

test("v4 projects migrate without camera data and camera tracks remain intact through schema 7", () => {
  const legacy = normalizeProject({
    schemaVersion: 4,
    assetDirectory: "Airi_home",
    interactions: [],
    timeline: { sequenceId: "opening", duration: 5, layers: [] },
  }, "Airi_home")!;
  expect(legacy.schemaVersion).toBe(EDITOR_SCHEMA_VERSION);
  expect(legacy.timeline.camera).toBeUndefined();

  const project = normalizeProject({
    schemaVersion: 4,
    assetDirectory: "Airi_home",
    interactions: [],
    timeline: {
      sequenceId: "opening",
      duration: 5,
      layers: [],
      camera: {
        enabled: true,
        aspectRatio: "1:1",
        constraint: { mode: "manual", boundId: "room" },
        safeBounds: [{ id: "room", name: "Room", x: 0, y: 0, width: 250, height: 250, enabled: true }],
        keyframes: [{ id: "shot", time: 2, centerX: 30, centerY: 40, frameHeight: 150, easing: "hold" }],
      },
    },
    sequences: { "talk-1": { sequenceId: "talk-1", duration: 3, layers: [], camera: { enabled: false, aspectRatio: "4:3", safeBounds: [], keyframes: [] } } },
  }, "Airi_home")!;
  const reopened = normalizeProject(JSON.parse(JSON.stringify(project)), "Airi_home")!;
  expect(reopened.schemaVersion).toBe(EDITOR_SCHEMA_VERSION);
  expect(reopened.timeline.camera).toMatchObject({ aspectRatio: "16:9", constraint: { mode: "manual", boundId: "room" } });
  expect(reopened.timeline.camera?.keyframes[0]).toMatchObject({ time: 2, centerX: 30, centerY: 40, frameHeight: 84.375, easing: "hold" });
  expect(reopened.sequences?.["talk-1"]?.camera).toMatchObject({ enabled: false, aspectRatio: "4:3" });
});

test("clip-based opening timelines survive editor save and reopen normalization", () => {
  const raw = {
    schemaVersion: 2,
    assetDirectory: "CH0184_home",
    interactions: [],
    timeline: {
      sequenceId: "opening",
      openingMode: "direct",
      durationMode: "auto",
      layers: [{
        id: "character",
        directory: "CH0184_home",
        role: "character",
        animationClips: [
          { id: "start-idle", animation: "Start_Idle", start: 0, end: 1.2, animationOffset: 0, loop: false },
          { id: "scene", animation: "Scene", start: 1.2, end: 2.8, animationOffset: 0, loop: false },
          { id: "start-idle-2", animation: "Start_Idle_2", start: 2.8, end: 4, animationOffset: 0, loop: false },
          { id: "idle", animation: "Idle_01", start: 4, end: 7, animationOffset: 0, loop: true, continueAfterOpening: true },
        ],
      }],
    },
  };
  const saved = normalizeProject(raw, "CH0184_home")!;
  const reopened = normalizeProject(JSON.parse(JSON.stringify(saved)), "CH0184_home")!;
  expect(reopened.timeline.layers[0]?.animationClips?.map((clip) => [clip.animation, clip.start, clip.end])).toEqual([
    ["Start_Idle", 0, 1.2], ["Scene", 1.2, 2.8], ["Start_Idle_2", 2.8, 4], ["Idle_01", 4, 7],
  ]);
  expect(reopened.timeline.layers[0]?.animationClips?.at(-1)).toMatchObject({ continueAfterOpening: true, loop: true });
});

test("legacy interactions receive release-return defaults and preserve authored settings on reopen", () => {
  const project = createProject("Airi_home", ["Idle_01", "Touch_01_M", "Touch_02_M"], []);
  const raw = JSON.parse(JSON.stringify(project)) as EditorProject;
  delete (raw.interactions[0] as Partial<EditorProject["interactions"][number]>).returnDuration;
  delete (raw.interactions[0] as Partial<EditorProject["interactions"][number]>).returnEasing;
  const migrated = normalizeProject(raw, "Airi_home")!;
  expect(migrated.interactions[0]).toMatchObject({ returnDuration: 0.35, returnEasing: "ease-out" });
  migrated.interactions[0]!.returnDuration = 0.8;
  migrated.interactions[0]!.returnEasing = "linear";
  const reopened = normalizeProject(JSON.parse(JSON.stringify(migrated)), "Airi_home")!;
  expect(reopened.interactions[0]).toMatchObject({ returnDuration: 0.8, returnEasing: "linear" });
});

describe("Spine editor project model", () => {
  test("an intentionally empty project survives save/load", () => {
    const empty = normalizeProject({ schemaVersion: 1, interactions: [] }, "test");
    expect(empty?.interactions).toEqual([]);
    expect(empty?.selectedInteractionId).toBeNull();
    expect(empty?.selectedRegionId).toBeNull();
  });
  test("detects supported interaction presets and keeps bone-relative regions", () => {
    const project = createProject("Airi_home", ["Idle_01", "Touch_01_M", "Touch_02_M", "TouchEnd_01_M", "Pinch_01_M", "Pat2_01_M", "Pat2_02_M"], [bone("root"), bone("root/Touch_Point", "Touch_Point")]);
    expect(project.interactions.map((item) => item.name)).toEqual(["Touch", "Cheek pinch", "Patting"]);
    expect(project.interactions[0]?.startAnimation).toBe("Touch_01_M");
    expect(project.interactions[0]?.followAnimation).toBe("Touch_02_M");
    expect(project.interactions[0]?.endAnimation).toBe("TouchEnd_01_M");
    expect(project.interactions[0]?.regions[0]?.anchorBone).toBe("root/Touch_Point");
  });

  test("pat presets use release animations rather than selecting the unchanged start name", () => {
    const project = createProject("test", ["Idle_01", "Pat_01_M", "Pat_01_A", "PatEnd_01_M", "PatEnd_01_A"], []);
    expect(project.interactions[0]?.endAnimation).toBe("PatEnd_01_M");
    expect(project.interactions[0]?.faceEndAnimation).toBe("PatEnd_01_A");
  });

  test("normalizes imported projects and repairs stale selections", () => {
    const project = normalizeProject({
      schemaVersion: 1,
      name: "Imported",
      interactions: [{
        id: "touch",
        name: "Touch",
        regions: [{ id: "hand", name: "Hand", shape: "rectangle", anchorBone: "root/hand", offsetX: 12, offsetY: -4, radiusX: 80, radiusY: 40, rotation: 12 }],
      }],
      selectedInteractionId: "deleted",
      selectedRegionId: "deleted",
    }, "Airi_home");
    expect(project?.selectedInteractionId).toBe("touch");
    expect(project?.selectedRegionId).toBe("hand");
    expect(project?.interactions[0]?.regions[0]).toMatchObject({
      shape: "rectangle",
      anchorBone: "root/hand",
      offsetX: 12,
      offsetY: -4,
      radiusX: 80,
      radiusY: 40,
      rotation: 12,
    });
    expect(project?.interactions[0]).toMatchObject({ allowX: true, allowY: true, rotationEnabled: false, rotationAxis: "x", rotationMin: -15, rotationMax: 15 });
    expect(normalizeProject({ schemaVersion: 99, interactions: [{ id: "x" }] }, "Airi_home")).toBeNull();
  });

  test("normalizes shared bone display settings", () => {
    expect(normalizeViewSettings({ showBones: false, showBoneNames: true, showConstraints: false, showInactiveBones: true })).toEqual({
      showBones: false,
      showBoneNames: true,
      showConstraints: false,
      showInactiveBones: true,
    });
    expect(normalizeViewSettings(null)).toBeNull();
  });

  test("places pinch regions on cheek controls and repairs the old Touch_Point default", () => {
    const animations = ["Idle_01", "Pinch_01_M", "Pinch_02_M", "PinchEnd_01_M"];
    const touchOnly = [bone("root/Touch_Point", "Touch_Point")];
    const cheekControls = [...touchOnly, bone("root/L_chin_rot", "L_chin_rot"), bone("root/R_chin_rot", "R_chin_rot")];
    const keyedControls = [
      ...touchOnly,
      bone("root/Touch_Point/Touch_Point_Key", "Touch_Point_Key"),
      ...cheekControls.slice(1),
    ];
    const detected = createProject("Kei_home", animations, cheekControls).interactions[0]!;
    expect(detected.regions.map((region) => region.anchorBone)).toEqual(["root/L_chin_rot", "root/R_chin_rot"]);
    expect(detected.regions.map((region) => region.placement)).toEqual(["cheek-v1", "cheek-v1"]);
    expect(createProject("Kei_home", animations, keyedControls).interactions[0]?.followTargetBone).toBe("root/Touch_Point/Touch_Point_Key");

    const legacy = createProject("Kei_home", animations, touchOnly);
    const oldRegion = legacy.interactions[0]!.regions[0]!;
    expect(isLegacyPinchRegion(legacy, oldRegion)).toBe(true);
    const repaired = repairPinchRegions(legacy, keyedControls);
    expect(repaired.repaired).toBe(1);
    expect(repaired.project.interactions[0]?.followTargetBone).toBe("root/Touch_Point/Touch_Point_Key");
    expect(repaired.project.interactions[0]?.regions.map((region) => region.name)).toEqual(["Left cheek", "Right cheek"]);
  });

  test("reports missing references and overlapping enabled regions", () => {
    const project = normalizeProject({
      schemaVersion: 1,
      interactions: [
        {
          id: "left",
          name: "Left",
          startAnimation: "Missing_Start",
          followTargetBone: "root/missing",
          regions: [{ id: "left-region", name: "Left region", anchorBone: "root", radiusX: 40, radiusY: 40 }],
        },
        {
          id: "right",
          name: "Right",
          regions: [{ id: "right-region", name: "Right region", anchorBone: "root", offsetX: 10, radiusX: 40, radiusY: 40 }],
        },
      ],
    }, "Airi_home") as EditorProject;
    const warnings = validateProject(project, ["Idle_01"], [bone("root")]);
    expect(warnings.map((warning) => warning.kind)).toEqual(["missing-animation", "missing-bone", "overlap"]);
    expect(warnings[2]?.message).toContain("overlaps");
  });

  test("discovers matching bg and scene Spine sets in render order", () => {
    expect(compositionDirectories("Airi_home", ["Airi_home", "Airi_bg", "Airi_scene", "Hina_bg"])).toEqual([
      { directory: "Airi_bg", role: "background" },
      { directory: "Airi_scene", role: "scene" },
      { directory: "Airi_home", role: "character" },
    ]);
    expect(compositionDirectories("Airi_bg", ["Airi_home", "Airi_bg", "Airi_scene"])).toEqual([
      { directory: "Airi_bg", role: "background" },
      { directory: "Airi_scene", role: "scene" },
      { directory: "Airi_home", role: "character" },
    ]);
    const project = createProject("Airi_home", ["Idle_01"], [bone("root")]);
    const timeline = ensureTimelineLayers(project.timeline, "Airi_home", ["Airi_home", "Airi_bg", "Airi_scene"]);
    expect(timeline.layers.map((layer) => [layer.directory, layer.order])).toEqual([
      ["Airi_home", 2],
      ["Airi_bg", 0],
      ["Airi_scene", 1],
    ]);
  });

  test("does not rediscover a layer after an initialized timeline intentionally removes it", () => {
    const project = createProject("Airi_home", [], []);
    const initialized = ensureTimelineLayers(project.timeline, "Airi_home", ["Airi_home", "Airi_scene"]);
    const withoutScene = { ...initialized, layers: initialized.layers.filter((layer) => layer.role !== "scene") };
    const restored = ensureTimelineLayers(withoutScene, "Airi_home", ["Airi_home", "Airi_scene"]);
    expect(restored.layers.map((layer) => layer.directory)).toEqual(["Airi_home"]);
    expect(restored.layersInitialized).toBe(true);
  });

  test("normalizes timeline cues and keeps old projects importable", () => {
    const project = normalizeProject({
      schemaVersion: 1,
      interactions: [],
      timeline: {
        duration: 8,
        layers: [{ id: "char", directory: "Airi_home", role: "character", start: 1, end: 6, opacity: 2 }],
        subtitles: [{ id: "cue", start: 2, end: 4, text: { EN: "Hello", KR: "안녕" } }],
        audio: [{ id: "voice", path: "voice.ogg", start: 2, end: 4, volume: 2 }],
      },
    }, "Airi_home");
    expect(project?.timeline).toMatchObject({ duration: 8, loop: true, selectedLayerId: "char", selectedCueId: "cue" });
    expect(project?.timeline.layers[0]).toMatchObject({ start: 1, end: 6, endMode: "auto", opacity: 1 });
    expect(project?.timeline.subtitles[0]?.text).toEqual({ en: "Hello", ja: "", ko: "안녕" });
    expect(project?.timeline.audio[0]).toMatchObject({ path: "voice.ogg", volume: 1, enabled: true });
    expect(normalizeProject({ schemaVersion: 1, interactions: [] }, "Airi_home")?.timeline.layers[0]?.directory).toBe("Airi_home");
  });

  test("removes duplicate imported subtitle and audio alternatives during normalization", () => {
    const project = normalizeProject({
      schemaVersion: 1,
      interactions: [],
      sequences: {
        "talk-1": {
          duration: 4,
          subtitles: [
            { id: "short-cue", lineId: "MemorialLobby_1", start: 1, end: 1.1, text: { en: "Same" } },
            { id: "long-cue", lineId: "MemorialLobby_1", start: 1, end: 3, text: { en: "Same" } },
          ],
          audio: [
            { id: "short-audio", lineId: "MemorialLobby_1", path: "short.ogg", start: 1, end: 1.1 },
            { id: "long-audio", lineId: "MemorialLobby_1", path: "long.ogg", start: 1, end: 3 },
          ],
        },
      },
    }, "Airi_home")!;
    expect(project.sequences?.["talk-1"]?.subtitles).toHaveLength(1);
    expect(project.sequences?.["talk-1"]?.subtitles[0]).toMatchObject({ id: "long-cue", end: 3 });
    expect(project.sequences?.["talk-1"]?.audio).toHaveLength(1);
    expect(project.sequences?.["talk-1"]?.audio[0]).toMatchObject({ id: "long-audio", path: "long.ogg", end: 3 });
  });
});
