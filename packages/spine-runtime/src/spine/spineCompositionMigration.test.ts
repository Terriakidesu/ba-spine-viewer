import { expect, test } from "bun:test";
import { evaluateComposition, type SpineComposition } from "./spineComposition";
import { createLegacyCompositionSchedule, DEFAULT_FULL_SEQUENCE_ARRANGEMENT, migrateLegacyTimelinesToComposition } from "./spineCompositionMigration";
import type { SpineTimeline, SpineTimelineProject } from "./spineTimeline";

function timeline(sequenceId: string, layers: SpineTimeline["layers"], overrides: Partial<SpineTimeline> = {}): SpineTimeline {
  return {
    sequenceId,
    openingMode: sequenceId === "opening" ? "scene-first" : "direct",
    sceneDuration: 2,
    openingIdleDuration: 2,
    durationMode: "manual",
    duration: 8,
    loop: true,
    layers,
    subtitles: [],
    audio: [],
    language: "en",
    ...overrides,
  };
}

const character = (animation: string, id = "character") => ({
  id,
  name: "Airi",
  role: "character" as const,
  directory: "Airi_home",
  enabled: true,
  animation,
  start: 0,
  end: 8,
  animationOffset: 0,
  loop: true,
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
  order: 2,
});

const background = {
  id: "background",
  name: "Airi background",
  role: "background" as const,
  directory: "Airi_bg",
  enabled: true,
  animation: "BG_Idle",
  followMainAnimation: true,
  start: 0,
  end: 8,
  animationOffset: 0,
  loop: true,
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
  order: 0,
};

test("legacy migration makes an explicit composition schedule without changing or dropping sequence source data", () => {
  const opening = timeline("opening", [character("Idle"), background], {
    layers: [
      { ...character("Idle"), animationClips: [{ id: "idle", animation: "Idle", start: 0, end: 8, animationOffset: 0, loop: true }] },
      background,
    ],
    subtitles: [{ id: "opening-cue", start: 1, end: 2, enabled: true, text: { en: "Opening", ja: "", ko: "" } }],
    audio: [{ id: "opening-voice", name: "opening.ogg", path: "opening.ogg", start: 1, end: 3, enabled: true, volume: 0.8 }],
    colorLayers: [{ id: "wash", name: "Color wash", enabled: true, locked: false, opacity: 0.7, order: 4, blendMode: "screen", clips: [{ id: "red", name: "Red", color: "#FF0000", start: 0, end: 2, opacity: 0.5, fadeIn: 0.5, fadeOut: 0.5, enabled: true }] }],
    camera: { enabled: true, aspectRatio: "16:9", constraint: { mode: "automatic" }, safeBounds: [], keyframes: [{ id: "shot", time: 0, centerX: 10, centerY: 20, frameHeight: 100, easing: "linear" }] },
  });
  const talk = timeline("talk-1", [{ ...character("Talk_01_M"), animationClips: [{ id: "talk", animation: "Talk_01_M", start: 0, end: 2, animationOffset: 0, loop: false }] }], {
    audio: [{ id: "voice", name: "talk.ogg", path: "talk.ogg", start: 0.25, end: 1.5, enabled: true, volume: 1 }],
    subtitles: [{ id: "cue", start: 0.5, end: 1.5, enabled: true, text: { en: "Talk", ja: "", ko: "" } }],
  });
  const project: SpineTimelineProject = { timeline: opening, sequences: { "talk-1": talk }, sequenceOrder: ["opening", "talk-1"] };
  const before = JSON.stringify(project);
  const migrated = migrateLegacyTimelinesToComposition(project, {
    id: "Airi-composition",
    name: "Airi presentation",
    frameRate: 30,
    persistentTimeMapping: "continuous-output",
    schedule: [
      { id: "opening-range", kind: "opening", sequenceId: "opening", start: 0, duration: 2, sourceStart: 0 },
      { id: "idle-before-talk", kind: "idle", sequenceId: "opening", start: 2, duration: 1, sourceStart: 2 },
      { id: "talk-range", kind: "talk", sequenceId: "talk-1", start: 3, duration: 2, sourceStart: 0 },
      { id: "final-idle", kind: "idle", sequenceId: "opening", start: 5, duration: 2, sourceStart: 5 },
    ],
    assetIdentityFor: (directory) => `asset-id:${directory}`,
    animationDurationFor: (_directory, name) => name === "BG_Idle" ? 4 : 2,
  });
  const value = migrated.composition;
  expect(JSON.stringify(project)).toBe(before);
  expect(migrated.report.originalDataRetained).toBe(true);
  expect(value.sections.map(({ id }) => id)).toEqual(["opening-range", "idle-before-talk", "talk-range", "final-idle"]);
  expect(value.idleSectionId).toBe("idle-before-talk");
  expect(value.sections.find(({ id }) => id === "talk-range")?.route).toMatchObject({
    role: "talk",
    returnToSectionId: "idle-before-talk",
    duplicateTrigger: "ignore",
    interruption: "replace",
    blendIn: 0.14,
    blendOut: 0.14,
  });
  expect(value.layers).toHaveLength(2);
  const bg = value.layers.find((layer) => layer.role === "background")!;
  const char = value.layers.find((layer) => layer.role === "character")!;
  expect(bg.order).toBe(0);
  expect(char.order).toBe(2);
  expect(bg.transformParentId).toBe(char.id);
  expect(bg.animationBinding).toEqual({ sourceLayerId: char.id, fallback: "authored-animation" });
  const persistentBgClips = value.animationClips.filter((clip) => clip.layerId === bg.id);
  expect(persistentBgClips.some((clip) => clip.start <= 3 && clip.end >= 5)).toBe(true);
  expect(persistentBgClips.every((clip) => clip.sourceClock.kind === "composition")).toBe(true);
  const duringTalk = evaluateComposition(value, { compositionTime: 4 });
  expect(duringTalk.activeAnimationClips.some(({ clip }) => clip.layerId === bg.id)).toBe(true);
  expect(value.audio.map(({ sectionId }) => sectionId)).toEqual(["opening-range", "idle-before-talk", "talk-range"]);
  expect(value.subtitles.map(({ sectionId }) => sectionId)).toEqual(["opening-range", "talk-range"]);
  expect(value.colorLayers[0]?.clips[0]?.color.r).toBeCloseTo(1);
  expect(value.camera?.keyframes[0]?.time).toBe(0);
  expect(migrated.report.diagnostics.map(({ code }) => code)).toContain("opening-mode");
  expect(value.migrationMetadata?.originalTimelines).toBeDefined();
});

test("migration does not merge different legacy layer IDs even when their asset paths and display names match", () => {
  const opening = timeline("opening", [character("Idle", "character-a"), { ...character("Idle", "character-b"), role: "overlay", directory: "Airi_home" }]);
  const migrated = migrateLegacyTimelinesToComposition({ timeline: opening }, {
    id: "composition",
    name: "Composition",
    frameRate: 30,
    persistentTimeMapping: "original-authored-time",
    schedule: [{ id: "opening", kind: "opening", sequenceId: "opening", start: 0, duration: 4, sourceStart: 0 }],
    assetIdentityFor: (directory) => `same-asset:${directory}`,
  });
  expect(migrated.composition.layers).toHaveLength(2);
  expect(migrated.composition.layers[0]?.id).not.toBe(migrated.composition.layers[1]?.id);
});

test("migration reports schedule gaps and missing asset animation metadata rather than silently assuming export settings", () => {
  const opening = timeline("opening", [character("Idle")]);
  const migrated = migrateLegacyTimelinesToComposition({ timeline: opening }, {
    id: "composition",
    name: "Composition",
    frameRate: 30,
    persistentTimeMapping: "continuous-output",
    schedule: [
      { id: "first", kind: "opening", sequenceId: "opening", start: 0, duration: 2, sourceStart: 0 },
      { id: "second", kind: "talk", sequenceId: "opening", start: 3, duration: 1, sourceStart: 1 },
    ],
  });
  expect(migrated.report.diagnostics.map(({ code }) => code)).toContain("schedule-gap");
  expect(migrated.report.diagnostics.map(({ code }) => code)).toContain("unknown-animation-duration");
  expect(migrated.report.assumptions.some((text) => text.includes("manifest path/directory"))).toBe(true);
  expect(migrated.composition.migrationMetadata?.migrationSchedule).toEqual(migrated.report.schedule);
});

test("shared legacy export/migration arrangement has explicit one-loop, half-second gap, and continuous-output defaults", () => {
  expect(DEFAULT_FULL_SEQUENCE_ARRANGEMENT).toEqual({
    includeOpening: true,
    initialIdleLoops: 1,
    betweenTalkIdleSeconds: 0.5,
    finalIdleLoops: 1,
    persistentTimeMapping: "continuous-output",
    persistentBackgrounds: true,
  });
  const schedule = createLegacyCompositionSchedule({
    openingSequenceId: "opening",
    openingDuration: 4,
    idleSequenceId: "opening",
    idleDuration: 2,
    talks: [{ sequenceId: "talk-1", duration: 3 }, { sequenceId: "talk-2", duration: 2 }],
  });
  expect(schedule.map(({ id, kind, sequenceId, start, duration }) => ({ id, kind, sequenceId, start, duration }))).toEqual([
    { id: "opening", kind: "opening", sequenceId: "opening", start: 0, duration: 4 },
    { id: "initial-idle", kind: "initial-idle", sequenceId: "opening", start: 4, duration: 2 },
    { id: "talk-1", kind: "talk", sequenceId: "talk-1", start: 6, duration: 3 },
    { id: "between-idle-1", kind: "between-idle", sequenceId: "opening", start: 9, duration: 0.5 },
    { id: "talk-2", kind: "talk", sequenceId: "talk-2", start: 9.5, duration: 2 },
    { id: "final-idle", kind: "final-idle", sequenceId: "opening", start: 11.5, duration: 2 },
  ]);
});
