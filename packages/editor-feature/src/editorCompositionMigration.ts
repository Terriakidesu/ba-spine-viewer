import type { SpineTimeline, SpineTimelineProject } from "@ba-spine/spine-runtime/spine/spineTimeline";
import {
  migrateLegacyTimelinesToComposition,
  type LegacyCompositionScheduleEntry,
  type SpineCompositionMigrationReport,
} from "@ba-spine/spine-runtime/spine/spineCompositionMigration";
import type { SpineComposition } from "@ba-spine/spine-runtime/spine/spineComposition";
import type { EditorProject, EditorTimeline } from "./editorModel";

export interface EditorCompositionMigrationOptions {
  schedule: readonly LegacyCompositionScheduleEntry[];
  frameRate: number;
  persistentTimeMapping: "continuous-output" | "original-authored-time";
  persistentBackgrounds?: boolean;
}

export interface EditorCompositionMigrationResult {
  composition: SpineComposition;
  report: SpineCompositionMigrationReport;
}

function asSpineTimeline(timeline: EditorTimeline, sequenceId: string): SpineTimeline {
  return {
    ...timeline,
    sequenceId,
    openingMode: timeline.openingMode ?? "direct",
    sceneDuration: timeline.sceneDuration ?? 0,
    openingIdleDuration: timeline.openingIdleDuration ?? 0,
    durationMode: timeline.durationMode ?? "manual",
    colorLayers: timeline.colorLayers,
    language: timeline.language,
  };
}

/** Build an explicit legacy migration draft. The Editor project is never mutated or saved. */
export function migrateEditorProjectComposition(
  project: EditorProject,
  options: EditorCompositionMigrationOptions,
): EditorCompositionMigrationResult {
  const storedActiveSequenceId = project.timeline.sequenceId ?? "legacy";
  const activeSequenceId = storedActiveSequenceId === "legacy" && !project.sequences?.opening ? "opening" : storedActiveSequenceId;
  const authoredSequences = { ...(project.sequences ?? {}) };
  if (activeSequenceId !== "legacy" || !project.sequences?.opening) authoredSequences[activeSequenceId] = project.timeline;
  const sequences = Object.fromEntries(Object.entries(authoredSequences).map(([id, timeline]) => [id, asSpineTimeline(timeline, id)]));
  const timelineProject: SpineTimelineProject = {
    timeline: sequences[activeSequenceId],
    sequences,
    ...(project.sequenceOrder ? { sequenceOrder: project.sequenceOrder } : {}),
    ...(project.deletedSequenceIds ? { deletedSequenceIds: project.deletedSequenceIds } : {}),
  };
  const migrated = migrateLegacyTimelinesToComposition(timelineProject, {
    id: `legacy-composition-${project.assetDirectory}`,
    name: `${project.name} composition`,
    frameRate: options.frameRate,
    schedule: options.schedule,
    persistentTimeMapping: options.persistentTimeMapping,
    persistentBackgrounds: options.persistentBackgrounds,
    assetIdentityFor: (directory, timeline) => `directory:${timeline.assetPaths?.[directory] ?? directory}`,
  });
  return { composition: migrated.composition, report: migrated.report };
}
