import { expect, test } from "bun:test";
import { createProject, EDITOR_SCHEMA_VERSION } from "./editorModel";
import { captureEditorProjectBaseline, editorProjectDraftValue, pendingProjectForDirectory, prepareEditorProjectSave, readSavedEditorProject, saveManifestEditorProject, type SavedEditorProjectSource, type WritableEditorProjectSource } from "./editorProject";
import { manifestPath, type SpineManifestRecord } from "@ba-spine/spine-runtime/spine/spineManifest";
import { normalizeSpineInteractionProject } from "@ba-spine/spine-runtime/spine/spineInteraction";

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
  const errors: string[] = [];

  const pending = await readSavedEditorProject(sourceFromFiles({
    ".editor/Airi_home.spine-project.json": JSON.stringify(saved),
  }), "Airi_home", (message) => errors.push(message));

  expect(errors).toEqual([]);
  expect(pending?.name).toBe("Saved Airi project");
  expect(pending?.timeline.duration).toBe(42);
  expect(pending?.timeline).toMatchObject({ selectedColorLayerId: "wash", selectedColorClipId: "flash" });
  expect(pending?.timeline.colorLayers[0]?.blendMode).toBe("additive");
  expect(pendingProjectForDirectory(pending, "Airi_home")?.name).toBe("Saved Airi project");
  expect(pendingProjectForDirectory(pending, "Hina_home")).toBeNull();
});

test("draft preview converts the live project to a Viewer snapshot without invoking persistence", () => {
  const project = createProject("Airi_home", [], []);
  project.name = "Live unsaved draft";
  project.timeline.sequenceId = "opening";
  project.timeline.duration = 12;
  const snapshot = editorProjectDraftValue(project);
  expect(snapshot).toMatchObject({
    schemaVersion: project.schemaVersion,
    assetDirectory: "Airi_home",
    entrySequence: null,
    name: "Live unsaved draft",
    interactions: [{ id: project.interactions[0]!.id }],
    timeline: { sequenceId: "opening", duration: 12 },
    sequences: { opening: { sequenceId: "opening", duration: 12 } },
  });
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  expect(normalizeSpineInteractionProject(snapshot, "Airi_home")).toMatchObject({
    assetDirectory: "Airi_home",
    interactions: [{ id: project.interactions[0]!.id }],
    sequences: { opening: { sequenceId: "opening", duration: 12 } },
  });
});

test("saved project loading falls back to the legacy editor directory", async () => {
  const saved = createProject("Airi_home", [], []);
  const pending = await readSavedEditorProject(sourceFromFiles({
    ".shittim-spine-editor/Airi_home.spine-project.json": JSON.stringify(saved),
  }), "Airi_home", () => {});

  expect(pending?.assetDirectory).toBe("Airi_home");
});

test("editor restores manifest sequences and keeps the explicit entry sequence separate", async () => {
  const source = sourceFromFiles({
    "lobbies/Airi_home/interactions.json": JSON.stringify({ interactions: [] }),
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
  project.timeline.sequenceId = "talk-1";
  project.timeline.durationMode = "manual";
  project.timeline.duration = 8;
  project.timeline.colorLayers = [{
    id: "wash", name: "Wash", enabled: true, locked: false, opacity: 0.65, order: 2, blendMode: "screen",
    clips: [{ id: "fade", name: "Fade", color: "#244466", start: 1, end: 7, opacity: 0.8, fadeIn: 2, fadeOut: 1, enabled: true }],
  }];
  project.timeline.selectedColorLayerId = "wash";
  project.timeline.selectedColorClipId = "fade";

  const saved = await saveManifestEditorProject(source, project);
  expect(JSON.parse(writes[".editor/Airi_home.workspace.json"]!).projectSchemaVersion).toBe(EDITOR_SCHEMA_VERSION);

  const reopened = await readSavedEditorProject({
    readText: async (path) => writes[path] ?? null,
    getManifest: async () => saved ? { ...record, manifest: saved.manifest } : null,
  }, "Airi_home", () => {});
  expect(reopened?.timeline).toMatchObject({ sequenceId: "talk-1", duration: 8, durationMode: "manual" });
  expect(reopened?.timeline.colorLayers[0]).toMatchObject({ id: "wash", opacity: 0.65, order: 2, blendMode: "screen" });
  expect(reopened?.timeline.colorLayers[0]?.clips[0]).toMatchObject({ id: "fade", color: "#244466", start: 1, end: 7, fadeIn: 2, fadeOut: 1 });
  expect(reopened?.timeline).toMatchObject({ selectedColorLayerId: "wash", selectedColorClipId: "fade" });
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
