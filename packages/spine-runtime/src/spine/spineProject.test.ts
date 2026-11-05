import { expect, test } from "bun:test";
import { normalizeSpineInteractionProject } from "./spineInteraction";
import { editorProjectPath, legacyEditorProjectPath, readLocalInteractionProject } from "./spineProject";

function sourceFromFiles(files: Record<string, string>) {
  return {
    getFile: async (path: string) => {
      const content = files[path];
      return content === undefined ? null : new File([content], path.split("/").at(-1) ?? "project.json", { type: "application/json" });
    },
  };
}

function editorProject() {
  return {
    schemaVersion: 2,
    name: "Local project",
    assetDirectory: "Airi_home",
    effectsStrength: 0.85,
    interactions: [{
      id: "pat",
      name: "Patting",
      color: "#ff668f",
      enabled: true,
      trigger: "hold",
      startAnimation: "Pat_01_M",
      followAnimation: "Pat_01_M",
      endAnimation: "PatEnd_01_M",
      faceStartAnimation: "Pat_01_A",
      faceFollowAnimation: "Pat_01_A",
      faceEndAnimation: "PatEnd_01_A",
      followTargetBone: "root/Touch_Point",
      sensitivity: 0.25,
      limitX: 90,
      limitY: 65,
      smoothing: 8,
      allowX: false,
      allowY: true,
      rotationEnabled: true,
      rotationAxis: "y",
      rotationMin: -10,
      rotationMax: 20,
      regions: [{
        id: "head",
        name: "Head",
        enabled: true,
        shape: "ellipse",
        anchorBone: "root/Touch_Point",
        offsetX: 2,
        offsetY: 3,
        radiusX: 100,
        radiusY: 75,
        rotation: 4,
      }],
    }],
  };
}

test("normalizes editor projects into the viewer playback contract", () => {
  const normalized = normalizeSpineInteractionProject(editorProject(), "Airi_home");

  expect(normalized?.assetDirectory).toBe("Airi_home");
  expect(normalized?.effectsStrength).toBe(0.85);
  expect(normalized?.interactions[0]).toMatchObject({ allowX: false, rotationEnabled: true, rotationAxis: "y" });
  expect(normalized?.interactions[0]?.regions[0]).toMatchObject({ offsetX: 2, offsetY: 3, rotation: 4 });
});

test("viewer local project loading prefers .editor and falls back to the legacy path", async () => {
  const content = JSON.stringify(editorProject());
  const modern = await readLocalInteractionProject(sourceFromFiles({ [editorProjectPath("Airi_home")]: content }), "Airi_home");
  expect(modern?.name).toBe("Local project");

  const legacy = await readLocalInteractionProject(sourceFromFiles({ [legacyEditorProjectPath("Airi_home")]: content }), "Airi_home");
  expect(legacy?.name).toBe("Local project");
});

test("Viewer project reload restores the saved camera track and reads refreshed shot data", async () => {
  const path = editorProjectPath("Airi_home");
  const files: Record<string, string> = {
    [path]: JSON.stringify({
      ...editorProject(),
      timeline: {
        sequenceId: "opening",
        duration: 5,
        layers: [],
        subtitles: [],
        audio: [],
        camera: {
          enabled: true,
          aspectRatio: "4:3",
          referenceLayerId: "character",
          constraint: { mode: "manual", boundId: "room" },
          safeBounds: [{ id: "room", name: "Room", x: -40, y: -20, width: 80, height: 60, enabled: true, visible: false, locked: true, priority: 3 }],
          keyframes: [{ id: "shot", time: 2, centerX: 10, centerY: 20, frameHeight: 30, easing: "smooth", constraint: { mode: "manual", boundId: "room" } }],
        },
      },
    }),
  };
  const firstLoad = await readLocalInteractionProject(sourceFromFiles(files), "Airi_home");
  expect(firstLoad?.timeline?.camera).toMatchObject({
    enabled: true,
    aspectRatio: "4:3",
    referenceLayerId: "character",
    constraint: { mode: "manual", boundId: "room" },
    safeBounds: [{ id: "room", visible: false, locked: true, priority: 3 }],
    keyframes: [{ id: "shot", time: 2, centerX: 10, centerY: 20, frameHeight: 30, easing: "smooth" }],
  });

  const refreshedValue = JSON.parse(files[path]!) as { timeline: { camera: { keyframes: Array<{ centerX: number }> } } };
  refreshedValue.timeline.camera.keyframes[0]!.centerX = 45;
  files[path] = JSON.stringify(refreshedValue);
  const refreshedLoad = await readLocalInteractionProject(sourceFromFiles(files), "Airi_home");
  expect(refreshedLoad?.timeline?.camera?.keyframes[0]?.centerX).toBe(45);
});

test("manifest projects restore authored sequences but never promote workspace selection to entry", async () => {
  const opening = { sequenceId: "opening", duration: 12, loop: false, layers: [], subtitles: [], audio: [] };
  const talk = { sequenceId: "talk-5", duration: 5, loop: false, layers: [], subtitles: [], audio: [] };
  const files: Record<string, string> = {
    "lobbies/Airi_home/interactions.json": JSON.stringify({ interactions: [] }),
    "lobbies/Airi_home/sequences/opening.json": JSON.stringify(opening),
    "lobbies/Airi_home/sequences/talk-5.json": JSON.stringify(talk),
    ".editor/Airi_home.workspace.json": JSON.stringify({ selectedSequenceId: "talk-5", name: "Airi workspace" }),
  };
  const project = await readLocalInteractionProject({
    ...sourceFromFiles(files),
    getManifest: async () => ({
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
    }),
  }, "Airi_home");
  expect(project?.entrySequence).toBe("opening");
  expect(project?.timeline?.sequenceId).toBe("talk-5");
  expect(project?.sequences?.opening?.sequenceId).toBe("opening");
});

test("normalizes per-sequence layers, timing, subtitles, and audio", () => {
  const raw = {
    ...editorProject(),
    timeline: {
      sequenceId: "talk-1",
      duration: 8,
      loop: false,
      layersInitialized: true,
      layers: [{ id: "character", name: "Airi", role: "character", directory: "Airi_home", enabled: true, animation: "Talk_01_M", start: 1, end: 4, animationOffset: 0.5, loop: false, x: 2, y: 3, scale: 1.1, opacity: 0.8, order: 1 }],
      subtitles: [{ id: "line", start: 1, end: 2.5, enabled: true, text: { en: "Hello", ja: "こんにちは", ko: "안녕" } }],
      audio: [{ id: "voice", name: "voice.ogg", path: "audios/voicelines/voice.ogg", start: 1, end: 2.5, enabled: true, volume: 0.75 }],
    },
    sequences: {
      opening: { sequenceId: "opening", duration: 12, loop: false, layers: [], subtitles: [], audio: [] },
    },
  };
  const normalized = normalizeSpineInteractionProject(raw, "Airi_home");

  expect(normalized?.timeline).toMatchObject({ sequenceId: "talk-1", duration: 8, loop: false });
  expect(normalized?.timeline?.layers[0]).toMatchObject({ directory: "Airi_home", start: 1, end: 4, scale: 1.1 });
  expect(normalized?.timeline?.subtitles[0]?.text.ja).toBe("こんにちは");
  expect(normalized?.timeline?.audio[0]).toMatchObject({ path: "audios/voicelines/voice.ogg", volume: 0.75 });
  expect(normalized?.sequences?.opening?.sequenceId).toBe("opening");
});
