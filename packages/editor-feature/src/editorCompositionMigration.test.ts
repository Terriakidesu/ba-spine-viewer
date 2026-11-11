import { expect, test } from "bun:test";
import { createProject } from "./editorModel";
import { migrateEditorProjectComposition } from "./editorCompositionMigration";

test("Editor migration is an explicit in-memory draft and maps supplied sequence ranges", () => {
  const project = createProject("Fixture_home", ["Idle", "Talk_01_M"], []);
  project.timeline = {
    ...project.timeline,
    sequenceId: "opening",
    duration: 4,
    layersInitialized: true,
    layers: project.timeline.layers.map((layer) => ({
      ...layer,
      animation: "Idle",
      animationClips: [{ id: "opening-idle", animation: "Idle", start: 0, end: 4, animationOffset: 0, loop: true }],
      end: 4,
    })),
  };
  project.sequences = {
    "talk-1": {
      ...project.timeline,
      sequenceId: "talk-1",
      duration: 2,
      layers: project.timeline.layers.map((layer) => ({
        ...layer,
        animation: "Talk_01_M",
        animationClips: [{ id: "talk-clip", animation: "Talk_01_M", start: 0, end: 2, animationOffset: 0, loop: false }],
        end: 2,
      })),
    },
  };
  project.sequenceOrder = ["opening", "talk-1"];
  const original = JSON.stringify(project);

  const migrated = migrateEditorProjectComposition(project, {
    frameRate: 30,
    persistentTimeMapping: "continuous-output",
    schedule: [
      { id: "opening-range", kind: "opening", sequenceId: "opening", start: 0, duration: 2, sourceStart: 0 },
      { id: "idle-range", kind: "idle", sequenceId: "opening", start: 2, duration: 1, sourceStart: 2 },
      { id: "talk-range", kind: "talk", sequenceId: "talk-1", start: 3, duration: 2, sourceStart: 0 },
    ],
  });

  expect(JSON.stringify(project)).toBe(original);
  expect(migrated.composition.sections.map(({ id }) => id)).toEqual(["opening-range", "idle-range", "talk-range"]);
  expect(migrated.composition.idleSectionId).toBe("idle-range");
  expect(migrated.composition.sections[2]?.route?.returnToSectionId).toBe("idle-range");
  expect(migrated.composition.migrationMetadata?.originalTimelines).toBeDefined();
  expect(migrated.report.sourceSequenceIds).toEqual(["opening", "talk-1"]);
});
