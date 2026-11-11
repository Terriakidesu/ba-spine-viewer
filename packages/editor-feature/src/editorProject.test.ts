import { expect, test } from "bun:test";
import { createProject, EDITOR_SCHEMA_VERSION } from "./editorModel";
import { createEmptySpineComposition } from "@ba-spine/spine-runtime/spine/spineComposition";
import { captureEditorProjectBaseline, editorProjectDraftValue, pendingProjectForDirectory, prepareEditorProjectSave, readSavedEditorProject, saveManifestEditorProject, type SavedEditorProjectSource, type WritableEditorProjectSource } from "./editorProject";
import { manifestPath, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { normalizeSpineInteractionProject } from "@ba-spine/spine-runtime/spine/spineInteraction";
import { behaviorMachineWithLookFollowSettings } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { createSpineBehaviorPreset } from "./behaviorPresets";

function sourceFromFiles(files: Record<string, string>) {
  return {
    readText: async (path: string) => files[path] ?? null,
  };
}

test("asset-set switching restores the saved .editor project", async () => {
  const saved = createProject("Airi_home", [], []);
  saved.name = "Saved Airi project";
  saved.timeline.duration = 42;
  saved.timeline.colorLayers = [{
    id: "wash", name: "Saved wash", enabled: true, locked: false, opacity: 1, order: 1, blendMode: "additive",
    clips: [{ id: "flash", name: "Flash", color: "#FFFFFF", start: 3, end: 5, opacity: 0.8, fadeIn: 0.2, fadeOut: 0.8, enabled: true }],
  }];
  saved.timeline.selectedColorLayerId = "wash";
  saved.timeline.selectedColorClipId = "flash";
  const firstMachine = saved.behaviorMachines![0]!;
  saved.behaviorGraphLayouts[firstMachine.id] = {
    mode: "manual",
    statePositions: { [firstMachine.initialStateId]: { x: 488, y: 212 } },
  };
  const errors: string[] = [];

  const pending = await readSavedEditorProject(sourceFromFiles({
    ".editor/Airi_home.spine-project.json": JSON.stringify(saved),
  }), "Airi_home", (message) => errors.push(message));

  expect(errors).toEqual([]);
  expect(pending?.name).toBe("Saved Airi project");
  expect(pending?.timeline.duration).toBe(42);
  expect(pending?.timeline).toMatchObject({ selectedColorLayerId: "wash", selectedColorClipId: "flash" });
  expect(pending?.timeline.colorLayers[0]?.blendMode).toBe("additive");
  expect(pending?.behaviorGraphLayouts[firstMachine.id]).toMatchObject({
    mode: "manual",
    statePositions: { [firstMachine.initialStateId]: { x: 488, y: 212 } },
  });
  expect(pendingProjectForDirectory(pending, "Airi_home")?.name).toBe("Saved Airi project");
  expect(pendingProjectForDirectory(pending, "Hina_home")).toBeNull();
});

test("graph layout metadata survives a complete non-manifest save and reload", async () => {
  const project = createProject("GraphFixture", ["Pat_01_M", "Pat_02_M"], []);
  project.composition = createEmptySpineComposition("GraphFixture-composition", "GraphFixture composition", 8, 30);
  const machine = project.behaviorMachines!.find((item) => item.name === "Patting")!;
  const originalMachines = structuredClone(project.behaviorMachines);
  const previous = project.behaviorGraphLayouts[machine.id]!;
  project.behaviorGraphLayouts[machine.id] = {
    mode: "manual",
    statePositions: { ...previous.statePositions, active: { x: 712, y: 308 } },
  };
  const files: Record<string, string> = {};
  const source: WritableEditorProjectSource = {
    readText: async (path) => files[path] ?? null,
    saveText: async (path, content) => { files[path] = content; },
  };

  const prepared = await prepareEditorProjectSave(source, project);
  expect(prepared.files).toHaveLength(1);
  for (const file of prepared.files) files[file.path] = file.content;
  const reopened = await readSavedEditorProject(source, "GraphFixture", () => {});

  expect(reopened?.behaviorGraphLayouts[machine.id]).toMatchObject({
    mode: "manual",
    statePositions: { active: { x: 712, y: 308 } },
  });
  expect(reopened?.behaviorMachines).toEqual(originalMachines);
  expect(reopened?.composition).toEqual(project.composition);
});

test("draft preview converts the live project to a Viewer snapshot without invoking persistence", () => {
  const project = createProject("Airi_home", [], []);
  project.name = "Live unsaved draft";
  project.effectsStrength = 0.85;
  project.lookFollow = { ...project.lookFollow, delay: 0.65, rangeX: 82, allowY: false };
  const firstMachine = project.behaviorMachines![0]!;
  project.behaviorGraphLayouts[firstMachine.id] = {
    mode: "manual",
    statePositions: { [firstMachine.initialStateId]: { x: 336, y: 176 } },
  };
  project.timeline.sequenceId = "opening";
  project.timeline.duration = 12;
  project.timeline.camera = { enabled: true, aspectRatio: "1:1", constraint: { mode: "none" }, safeBounds: [], keyframes: [{ id: "draft-key", time: 3, centerX: 10, centerY: 20, frameHeight: 300 }] } as unknown as NonNullable<typeof project.timeline.camera>;
  const snapshot = editorProjectDraftValue(project);
  expect(snapshot).toMatchObject({
    schemaVersion: project.schemaVersion,
    assetDirectory: "Airi_home",
    entrySequence: null,
    name: "Live unsaved draft",
    effectsStrength: 0.85,
    lookFollow: { delay: 0.65, rangeX: 82, allowY: false },
    behaviorGraphLayouts: {
      [firstMachine.id]: { mode: "manual", statePositions: { [firstMachine.initialStateId]: { x: 336, y: 176 } } },
    },
    interactions: [{ id: project.interactions[0]!.id }],
    timeline: { sequenceId: "opening", duration: 12, camera: { aspectRatio: "1:1" } },
    sequences: { opening: { sequenceId: "opening", duration: 12, camera: { aspectRatio: "1:1" } } },
  });
  const draftMachines = snapshot.behaviorMachines as Array<{ sourceLegacyInteractionId: string | null; name: string; activation: { holdDelay: number } }>;
  expect(draftMachines.some((machine) => machine.sourceLegacyInteractionId === project.interactions[0]!.id)).toBe(true);
  expect(draftMachines.find((machine) => machine.name === "Look-follow")?.activation.holdDelay).toBe(0.65);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  expect(normalizeSpineInteractionProject(snapshot, "Airi_home")).toMatchObject({
    assetDirectory: "Airi_home",
    effectsStrength: 0.85,
    lookFollow: { delay: 0.65, rangeX: 82, allowY: false },
    interactions: [{ id: project.interactions[0]!.id }],
    sequences: { opening: { sequenceId: "opening", duration: 12, camera: { aspectRatio: "16:9" } } },
  });
  expect(normalizeSpineInteractionProject(snapshot, "Airi_home")?.sequences?.opening?.camera?.keyframes[0]?.frameHeight).toBe(168.75);
});

test("saved project loading falls back to the legacy editor directory", async () => {
  const saved = createProject("Airi_home", [], []);
  const pending = await readSavedEditorProject(sourceFromFiles({
    ".shittim-spine-editor/Airi_home.spine-project.json": JSON.stringify(saved),
  }), "Airi_home", () => {});

  expect(pending?.assetDirectory).toBe("Airi_home");
});

test("legacy square camera projects visibly fall back in memory without changing saved data", async () => {
  const saved = createProject("Airi_home", [], []);
  const raw = {
    ...saved,
    timeline: {
      ...saved.timeline,
      camera: {
        enabled: true,
        aspectRatio: "1:1",
        constraint: { mode: "automatic" },
        safeBounds: [],
        keyframes: [{ id: "legacy-shot", time: 0, centerX: 0, centerY: 0, frameHeight: 160 }],
      },
    },
  };
  const content = JSON.stringify(raw);
  const files = { ".editor/Airi_home.spine-project.json": content };
  let legacyNotice = false;
  const pending = await readSavedEditorProject(sourceFromFiles(files), "Airi_home", () => {}, () => { legacyNotice = true; });

  expect(legacyNotice).toBe(true);
  expect(pending?.timeline.camera).toMatchObject({ aspectRatio: "16:9" });
  expect(pending?.timeline.camera?.keyframes[0]?.frameHeight).toBe(90);
  expect(files[".editor/Airi_home.spine-project.json"]).toBe(content);
});

test("editor restores manifest sequences and keeps the explicit entry sequence separate", async () => {
  const composition = createEmptySpineComposition("manifest-composition", "Manifest composition", 12, 30);
  const source = sourceFromFiles({
    "lobbies/Airi_home/interactions.json": JSON.stringify({ interactions: [], composition, sequenceOrder: ["talk-5", "opening"], deletedSequenceIds: ["talk-2"] }),
    "lobbies/Airi_home/sequences/opening.json": JSON.stringify({ sequenceId: "opening", duration: 12, layers: [], subtitles: [], audio: [] }),
    "lobbies/Airi_home/sequences/talk-5.json": JSON.stringify({ sequenceId: "talk-5", duration: 19, durationMode: "manual", layers: [], subtitles: [], audio: [] }),
    ".editor/Airi_home.workspace.json": JSON.stringify({ selectedSequenceId: "talk-5", name: "Workspace name" }),
  }) as SavedEditorProjectSource;
  source.getManifest = async (): Promise<SpineManifestRecord> => ({
    path: "lobbies/Airi_home/manifest.json",
    manifest: {
      schemaVersion: 1,
      id: "Airi_home",
      entrySequence: "opening",
      entryMode: "authored-sequence",
      assets: { Airi_home: { atlas: { scope: "lobby", path: "spine/a.atlas" }, skeletons: [], pages: [], files: [] } },
      sequences: {
        opening: { scope: "lobby", path: "sequences/opening.json" },
        "talk-5": { scope: "lobby", path: "sequences/talk-5.json" },
      },
      interactions: { scope: "lobby", path: "interactions.json" },
      workspace: { scope: "root", path: ".editor/Airi_home.workspace.json" },
    },
  });
  const project = await readSavedEditorProject(source, "Airi_home", () => {});
  expect(project?.entrySequence).toBe("opening");
  expect(project?.timeline.sequenceId).toBe("talk-5");
  expect(project?.timeline.durationMode).toBe("auto");
  expect(project?.name).toBe("Workspace name");
  expect(project?.sequenceOrder).toEqual(["opening", "talk-5"]);
  expect(project?.deletedSequenceIds).toEqual(["talk-2"]);
  expect(project?.composition).toEqual(composition);
});

test("manifest saves sequence order and removes intentionally deleted sequence references", async () => {
  const record: SpineManifestRecord = {
    path: "lobbies/Airi_home/manifest.json",
    manifest: {
      schemaVersion: 1,
      id: "Airi_home",
      entrySequence: "opening",
      entryMode: "authored-sequence",
      assets: { Airi_home: { atlas: manifestPath("lobby", "spine/a.atlas"), skeletons: [], pages: [], files: [] } },
      sequences: {
        opening: manifestPath("lobby", "sequences/opening.json"),
        "talk-2": manifestPath("lobby", "sequences/talk-2.json"),
      },
      interactions: manifestPath("lobby", "interactions.json"),
      workspace: manifestPath("root", ".editor/Airi_home.workspace.json"),
    },
  };
  const writes: Record<string, string> = {};
  const source: WritableEditorProjectSource = {
    readText: async (path) => writes[path] ?? null,
    saveText: async (path, content) => { writes[path] = content; },
    getManifest: async () => record,
  };
  const project = createProject("Airi_home", [], []);
  project.composition = createEmptySpineComposition("Airi-composition", "Airi composition", 8, 30);
  project.timeline.sequenceId = "opening";
  project.sequences = { "talk-2": { ...project.timeline, sequenceId: "talk-2" } };
  project.sequenceOrder = ["opening", "talk-3", "talk-1"];
  project.deletedSequenceIds = ["talk-2"];
  const initialMachine = project.behaviorMachines![0]!;
  project.behaviorGraphLayouts[initialMachine.id] = {
    mode: "manual",
    statePositions: { [initialMachine.initialStateId]: { x: 420, y: 180 } },
  };

  const saved = await saveManifestEditorProject(source, project);
  expect(saved?.manifest.sequences).toEqual({ opening: manifestPath("lobby", "sequences/opening.json") });
  expect(writes["lobbies/Airi_home/interactions.json"]).toContain('"sequenceOrder": [\n    "opening",\n    "talk-3",\n    "talk-1"\n  ]');
  expect(writes["lobbies/Airi_home/interactions.json"]).toContain('"deletedSequenceIds": [\n    "talk-2"\n  ]');
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).behaviorGraphLayouts[initialMachine.id]).toMatchObject({
    mode: "manual",
    statePositions: { [initialMachine.initialStateId]: { x: 420, y: 180 } },
  });
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).composition).toEqual(project.composition);
  expect(writes["lobbies/Airi_home/sequences/talk-2.json"]).toBeUndefined();
});

test("manifest workspace schema marker persists and preserves a manual Talk override", async () => {
  const record: SpineManifestRecord = {
    path: "lobbies/Airi_home/manifest.json",
    manifest: {
      schemaVersion: 1,
      id: "Airi_home",
      entrySequence: null,
      entryMode: "runtime-intro",
      assets: { Airi_home: { atlas: manifestPath("lobby", "spine/a.atlas"), skeletons: [], pages: [], files: [] } },
      sequences: {},
      interactions: manifestPath("lobby", "interactions.json"),
      workspace: manifestPath("root", ".editor/Airi_home.workspace.json"),
    },
  };
  const writes: Record<string, string> = {};
  const source: WritableEditorProjectSource = {
    readText: async (path) => writes[path] ?? null,
    saveText: async (path, content) => { writes[path] = content; },
    getManifest: async () => record,
  };
  const project = createProject("Airi_home", [], []);
  project.effectsStrength = 0.9;
  project.lookFollow = { ...project.lookFollow, enabled: false, delay: 0.7, targetBonePath: "root/Touch_Eye" };
  const patting = createSpineBehaviorPreset("head-interaction");
  project.behaviorMachines = [...project.behaviorMachines!, patting];
  project.behaviorGraphLayouts = {
    [patting.id]: { mode: "manual", statePositions: { idle: { x: 512, y: 208 }, active: { x: 760, y: 208 } } },
  };
  project.timeline.sequenceId = "talk-1";
  project.timeline.durationMode = "manual";
  project.timeline.duration = 8;
  project.timeline.colorLayers = [{
    id: "wash", name: "Wash", enabled: true, locked: false, opacity: 0.65, order: 2, blendMode: "screen",
    clips: [{ id: "fade", name: "Fade", color: "#244466", start: 1, end: 7, opacity: 0.8, fadeIn: 2, fadeOut: 1, enabled: true }],
  }];
  project.timeline.selectedColorLayerId = "wash";
  project.timeline.selectedColorClipId = "fade";
  project.timeline.camera = {
    enabled: true,
    aspectRatio: "4:3",
    constraint: { mode: "manual", boundId: "room" },
    safeBounds: [{ id: "room", name: "Room", x: -100, y: -50, width: 800, height: 600, enabled: true }],
    keyframes: [{ id: "wide-shot", time: 2, centerX: 40, centerY: 60, frameHeight: 400, easing: "smooth" }],
  };

  const saved = await saveManifestEditorProject(source, project);
  expect(JSON.parse(writes[".editor/Airi_home.workspace.json"]!).projectSchemaVersion).toBe(EDITOR_SCHEMA_VERSION);
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).effectsStrength).toBe(0.9);
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).lookFollow).toEqual(project.lookFollow);
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).behaviorGraphLayouts[patting.id]).toEqual(project.behaviorGraphLayouts[patting.id]);
  expect(JSON.parse(writes["lobbies/Airi_home/interactions.json"]!).behaviorMachines).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceLegacyInteractionId: project.interactions[0]!.id }),
    expect.objectContaining({ name: "Look-follow", activation: expect.objectContaining({ holdDelay: 0.7 }) }),
  ]));
  expect(JSON.parse(writes["lobbies/Airi_home/sequences/talk-1.json"]!).camera).toMatchObject({ aspectRatio: "4:3", constraint: { mode: "manual", boundId: "room" } });

  const reopened = await readSavedEditorProject({
    readText: async (path) => writes[path] ?? null,
    getManifest: async () => saved ? { ...record, manifest: saved.manifest } : null,
  }, "Airi_home", () => {});
  expect(reopened?.timeline).toMatchObject({ sequenceId: "talk-1", duration: 8, durationMode: "manual" });
  expect(reopened?.effectsStrength).toBe(0.9);
  expect(reopened?.lookFollow).toEqual(project.lookFollow);
  expect(reopened?.behaviorMachines?.map((machine) => machine.id)).toEqual(project.behaviorMachines?.map((machine) => machine.id));
  expect(reopened?.behaviorGraphLayouts[patting.id]).toMatchObject(project.behaviorGraphLayouts[patting.id]!);
  expect(reopened?.timeline.colorLayers[0]).toMatchObject({ id: "wash", opacity: 0.65, order: 2, blendMode: "screen" });
  expect(reopened?.timeline.colorLayers[0]?.clips[0]).toMatchObject({ id: "fade", color: "#244466", start: 1, end: 7, fadeIn: 2, fadeOut: 1 });
  expect(reopened?.timeline).toMatchObject({ selectedColorLayerId: "wash", selectedColorClipId: "fade" });
  expect(reopened?.timeline.camera?.keyframes[0]).toMatchObject({ id: "wide-shot", time: 2, centerX: 40, centerY: 60, frameHeight: 400, easing: "smooth" });
});

test("manifest save and reopen prefer authored Look-follow behavior over stale compatibility defaults", async () => {
  const record: SpineManifestRecord = {
    path: "lobbies/LookFixture/manifest.json",
    manifest: {
      schemaVersion: 1,
      id: "LookFixture",
      entrySequence: null,
      entryMode: "runtime-intro",
      assets: { LookFixture: { atlas: manifestPath("lobby", "spine/a.atlas"), skeletons: [], pages: [], files: [] } },
      sequences: {},
      interactions: manifestPath("lobby", "interactions.json"),
      workspace: manifestPath("root", ".editor/LookFixture.workspace.json"),
    },
  };
  const files: Record<string, string> = {};
  const source: WritableEditorProjectSource = {
    readText: async (path) => files[path] ?? null,
    saveText: async (path, content) => { files[path] = content; },
    getManifest: async () => record,
  };
  const project = createProject("LookFixture", [], []);
  const authoredLook = {
    ...project.lookFollow,
    enabled: false,
    delay: 0.82,
    targetBonePath: "root/LookTarget",
    rangeX: 73,
    rangeY: 41,
    allowY: false,
    smoothing: 19,
    startAnimation: "LookStart_M",
    faceEndAnimation: "LookEnd_A",
  };
  const lookMachine = project.behaviorMachines!.find((machine) => machine.id === "look-follow")!;
  project.behaviorMachines = project.behaviorMachines!.map((machine) => machine.id === lookMachine.id
    ? behaviorMachineWithLookFollowSettings({ ...machine, sourceLegacyInteractionId: null }, authoredLook)
    : machine);
  // Deliberately leave the compatibility field at defaults to reproduce the reported reset.

  const saved = await saveManifestEditorProject(source, project);
  const authoredFile = JSON.parse(files["lobbies/LookFixture/interactions.json"]!);
  expect(authoredFile.lookFollow).toMatchObject(authoredLook);
  expect(authoredFile.behaviorMachines.filter((machine: { id: string }) => machine.id === "look-follow")).toHaveLength(1);

  const reopened = await readSavedEditorProject({
    readText: async (path) => files[path] ?? null,
    getManifest: async () => saved ? { ...record, manifest: saved.manifest } : null,
  }, "LookFixture", () => {});
  expect(reopened?.lookFollow).toMatchObject(authoredLook);
  expect(reopened?.behaviorMachines?.filter((machine) => machine.id === "look-follow")).toHaveLength(1);
  expect(reopened?.behaviorMachines?.find((machine) => machine.id === "look-follow")?.sourceLegacyInteractionId).toBeNull();
});

test("prepares manifest project output without writing and captures fixture baselines", async () => {
  const record: SpineManifestRecord = {
    path: "lobbies/Airi_home/manifest.json",
    manifest: {
      schemaVersion: 1,
      id: "Airi_home",
      entrySequence: "opening",
      entryMode: "authored-sequence",
      assets: { Airi_home: { atlas: manifestPath("lobby", "spine/a.atlas"), skeletons: [], pages: [], files: [] } },
      sequences: { opening: manifestPath("lobby", "sequences/opening.json") },
      interactions: manifestPath("lobby", "interactions.json"),
      subtitles: manifestPath("root", "audios/voicelines/Airi/subtitles.json"),
      legacySubtitles: manifestPath("root", "audios/voicelines/Airi/legacy-subtitles.json"),
      workspace: manifestPath("root", ".editor/Airi_home.workspace.json"),
    },
  };
  const fixtureFiles: Record<string, string> = {
    "lobbies/Airi_home/manifest.json": JSON.stringify(record.manifest),
    "lobbies/Airi_home/interactions.json": "{\"interactions\":[]}\n",
    "lobbies/Airi_home/sequences/opening.json": "{\"sequenceId\":\"opening\"}\n",
    ".editor/Airi_home.workspace.json": "{\"selectedSequenceId\":\"opening\"}\n",
    "audios/voicelines/Airi/subtitles.json": "{\"lines\":[]}\n",
    "audios/voicelines/Airi/legacy-subtitles.json": "{\"legacy\":true}\n",
  };
  const source: SavedEditorProjectSource = {
    readText: async (path) => fixtureFiles[path] ?? null,
    getManifest: async () => record,
  };
  const project = createProject("Airi_home", [], []);
  project.timeline.sequenceId = "opening";
  project.timeline.subtitlePath = "audios/voicelines/Airi/subtitles.json";

  const prepared = await prepareEditorProjectSave(source, project);
  const baseline = await captureEditorProjectBaseline(source, project);
  expect(prepared.manifestSave?.manifestPath).toBe("lobbies/Airi_home/manifest.json");
  expect(prepared.files.map((file) => file.path)).toContain("lobbies/Airi_home/sequences/opening.json");
  expect(prepared.files.every((file) => JSON.parse(file.content))).toBe(true);
  expect(baseline["lobbies/Airi_home/manifest.json"]).toBeDefined();
  expect(baseline["audios/voicelines/Airi/legacy-subtitles.json"]).toBeDefined();
});
