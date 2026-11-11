import type { SpineCameraTrack } from "./spineCameraMotion";
import type {
  CompositionAnimationClip,
  CompositionColor,
  CompositionColorClip,
  CompositionColorLayer,
  CompositionLayer,
  CompositionPropertyTrack,
  CompositionSection,
  CompositionSectionRoute,
  CompositionSubtitleCue,
  SpineComposition,
} from "./spineComposition";
import { createEmptySpineComposition, defaultTalkSectionRoute } from "./spineComposition";
import {
  timelineForSequence,
  timelineSequenceIds,
  type SpineTimeline,
  type SpineTimelineAnimationClip,
  type SpineTimelineLayer,
  type SpineTimelineProject,
} from "./spineTimeline";

export type LegacyCompositionSegmentKind = "opening" | "idle" | "initial-idle" | "between-idle" | "final-idle" | "talk" | "section" | "gap";

export const DEFAULT_FULL_SEQUENCE_ARRANGEMENT = {
  includeOpening: true,
  initialIdleLoops: 1,
  betweenTalkIdleSeconds: 0.5,
  finalIdleLoops: 1,
  persistentTimeMapping: "continuous-output" as const,
  persistentBackgrounds: true,
};

export interface LegacyArrangementInput {
  openingSequenceId?: string | null;
  openingDuration: number;
  idleSequenceId?: string | null;
  idleDuration: number;
  includeOpening?: boolean;
  initialIdleLoops?: number;
  betweenTalkIdleSeconds?: number;
  finalIdleLoops?: number;
  talks: readonly { sequenceId: string; duration: number }[];
}

/** Shared default export/migration arrangement: opening, one idle loop, talks with 0.5s gaps, one final idle loop. */
export function createLegacyCompositionSchedule(input: LegacyArrangementInput): LegacyCompositionScheduleEntry[] {
  const safeLoops = (value: number | undefined, fallback: number) => Math.max(1, Math.min(20, Math.floor(Number.isFinite(value) ? value! : fallback)));
  const idleDuration = Number.isFinite(input.idleDuration) ? Math.max(0.01, input.idleDuration) : 0.01;
  const openingDuration = Number.isFinite(input.openingDuration) ? Math.max(0, input.openingDuration) : 0;
  const initialIdleLoops = safeLoops(input.initialIdleLoops, DEFAULT_FULL_SEQUENCE_ARRANGEMENT.initialIdleLoops);
  const finalIdleLoops = safeLoops(input.finalIdleLoops, DEFAULT_FULL_SEQUENCE_ARRANGEMENT.finalIdleLoops);
  const between = Number.isFinite(input.betweenTalkIdleSeconds)
    ? Math.max(0, Math.min(30, input.betweenTalkIdleSeconds!))
    : DEFAULT_FULL_SEQUENCE_ARRANGEMENT.betweenTalkIdleSeconds;
  const talks = input.talks.filter((talk) => Number.isFinite(talk.duration) && talk.duration > 0);
  const idleSequenceId = input.idleSequenceId ?? input.openingSequenceId ?? talks[0]?.sequenceId ?? null;
  const segments: LegacyCompositionScheduleEntry[] = [];
  let start = 0;
  const push = (id: string, kind: LegacyCompositionSegmentKind, sequenceId: string | null, duration: number, sourceStart = 0) => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    segments.push({ id, kind, sequenceId, start, duration, sourceStart });
    start += duration;
  };
  if (input.includeOpening !== false && input.openingSequenceId && openingDuration > 0) {
    push("opening", "opening", input.openingSequenceId, openingDuration);
  }
  push("initial-idle", "initial-idle", idleSequenceId, idleDuration * initialIdleLoops);
  talks.forEach((talk, index) => {
    push(`talk-${index + 1}`, "talk", talk.sequenceId, talk.duration);
    if (index < talks.length - 1 && between > 0) push(`between-idle-${index + 1}`, "between-idle", idleSequenceId, between);
  });
  push("final-idle", "final-idle", idleSequenceId, Math.max(1, idleDuration * finalIdleLoops));
  return segments;
}

/** The migration caller supplies the exact selected range/arrangement; no viewer preference is guessed. */
export interface LegacyCompositionScheduleEntry {
  id: string;
  kind: LegacyCompositionSegmentKind;
  sequenceId: string | null;
  start: number;
  duration: number;
  /** Source-sequence time at the start of this output segment. */
  sourceStart: number;
}

export interface SpineCompositionMigrationOptions {
  id: string;
  name: string;
  frameRate: number;
  schedule: readonly LegacyCompositionScheduleEntry[];
  persistentTimeMapping: "continuous-output" | "original-authored-time";
  persistentBackgrounds?: boolean;
  idleSectionId?: string | null;
  entrySectionId?: string | null;
  assetIdentityFor?: (directory: string, timeline: SpineTimeline) => string | null;
  animationDurationFor?: (directory: string, animation: string) => number | null;
}

export interface SpineCompositionMigrationReport {
  sourceSequenceIds: string[];
  schedule: LegacyCompositionScheduleEntry[];
  assumptions: string[];
  diagnostics: Array<{ severity: "warning" | "error"; code: string; message: string; targetId?: string }>;
  originalDataRetained: true;
}

export interface SpineCompositionMigrationResult {
  composition: SpineComposition;
  report: SpineCompositionMigrationReport;
}

interface LayerOccurrence {
  layer: SpineTimelineLayer;
  groupId: string;
  ordinal: number;
}

interface LayerGroup {
  layer: CompositionLayer;
  occurrences: Map<string, LayerOccurrence[]>;
  firstTimeline: SpineTimeline;
  backgroundSourceOriginTime?: number;
  backgroundSourceOffset?: number;
}

function safeId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_") || "empty";
}

function layerSignature(layer: SpineTimelineLayer, ordinal: number): string {
  return JSON.stringify([layer.id, layer.role, layer.directory, ordinal]);
}

function toLinear(channel: number): number {
  const sRGB = channel / 255;
  return sRGB <= 0.04045 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
}

function legacyHexColor(value: string): CompositionColor {
  const match = value.match(/^#?([\da-f]{6})$/i);
  if (!match) return { r: 0, g: 0, b: 0, a: 1 };
  const hex = match[1]!;
  return {
    r: toLinear(Number.parseInt(hex.slice(0, 2), 16)),
    g: toLinear(Number.parseInt(hex.slice(2, 4), 16)),
    b: toLinear(Number.parseInt(hex.slice(4, 6), 16)),
    a: 1,
  };
}

function sectionRoute(kind: LegacyCompositionSegmentKind, idleSectionId: string | null): CompositionSectionRoute | undefined {
  if (kind === "talk") {
    return {
      ...defaultTalkSectionRoute(idleSectionId ?? ""),
      returnToSectionId: idleSectionId,
    };
  }
  if (kind === "idle" || kind === "initial-idle" || kind === "between-idle" || kind === "final-idle") return {
    role: "idle",
    returnToSectionId: null,
    ownedChannels: ["body", "face", "camera", "effects", "scene", "skeletal-overrides"],
    duplicateTrigger: "ignore",
    interruption: "replace",
    blendIn: 0.14,
    blendOut: 0.14,
    cameraReturn: "persistent",
  };
  if (kind === "opening") return {
    role: "opening",
    returnToSectionId: idleSectionId,
    ownedChannels: ["body", "face", "audio", "subtitles", "camera", "effects", "scene", "skeletal-overrides"],
    duplicateTrigger: "restart",
    interruption: "replace",
    blendIn: 0,
    blendOut: 0.14,
    cameraReturn: "blend",
  };
  return undefined;
}

function isIdleKind(kind: LegacyCompositionSegmentKind): boolean {
  return kind === "idle" || kind === "initial-idle" || kind === "between-idle" || kind === "final-idle";
}

function legacyAnimationClips(layer: SpineTimelineLayer): SpineTimelineAnimationClip[] {
  if (Array.isArray(layer.animationClips)) return layer.animationClips;
  if (!layer.animation) return [];
  return [{
    id: `${layer.id}-legacy-single`,
    animation: layer.animation,
    ...(typeof layer.faceAnimation === "string" ? { faceAnimation: layer.faceAnimation } : {}),
    start: layer.start,
    end: Math.max(layer.start + 0.01, layer.end),
    endMode: layer.endMode,
    animationOffset: layer.animationOffset,
    loop: layer.loop,
  }];
}

function copyOriginalTimelines(project: SpineTimelineProject, ids: readonly string[]): Record<string, SpineTimeline | null> {
  return Object.fromEntries(ids.map((id) => [id, timelineForSequence(project, id)]));
}

/**
 * Explicit, non-destructive conversion from separate legacy timelines to one composition.
 * The input is never mutated or saved; source documents are embedded in migration metadata.
 */
export function migrateLegacyTimelinesToComposition(
  project: SpineTimelineProject,
  options: SpineCompositionMigrationOptions,
): SpineCompositionMigrationResult {
  const sourceSequenceIds = timelineSequenceIds(project);
  const sequenceTimelines = Object.fromEntries(sourceSequenceIds.map((id) => [id, timelineForSequence(project, id)]));
  const assumptions: string[] = [
    "Migration is in-memory only; original sequence documents are retained verbatim in migration metadata and are not rewritten.",
    `Arrangement offsets and idle gaps come from the caller-supplied schedule (${options.schedule.length} entries); no Viewer-local export preferences are inferred.`,
    `Persistent source-clock mapping is explicitly set to “${options.persistentTimeMapping}”.`,
    "Legacy layer IDs are matched only when ID, role, asset directory, and within-sequence duplicate ordinal all agree.",
    "Legacy follow-main-animation is split into an explicit transform parent and animation-name binding; clip clock remains independent.",
    "Keyed color values are converted from legacy sRGB hex to linear-light channels.",
  ];
  const diagnostics: SpineCompositionMigrationReport["diagnostics"] = [];
  const sortedSchedule = [...options.schedule].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const report = (severity: "warning" | "error", code: string, message: string, targetId?: string) => diagnostics.push({ severity, code, message, ...(targetId ? { targetId } : {}) });
  const seenEntryIds = new Set<string>();
  let previousEnd = 0;
  for (const entry of sortedSchedule) {
    if (!entry.id || seenEntryIds.has(entry.id)) report("error", "duplicate-schedule-id", `Schedule entry ID “${entry.id}” is empty or duplicated.`, entry.id);
    seenEntryIds.add(entry.id);
    if (![entry.start, entry.duration, entry.sourceStart].every(Number.isFinite) || entry.start < 0 || entry.duration <= 0 || entry.sourceStart < 0) {
      report("error", "invalid-schedule-entry", `Schedule entry “${entry.id}” has invalid time values.`, entry.id);
    }
    if (entry.start < previousEnd - 1e-6) report("error", "overlapping-schedule", `Schedule entry “${entry.id}” overlaps the previous entry.`, entry.id);
    if (entry.start > previousEnd + 1e-6) report("warning", "schedule-gap", `The ${Number((entry.start - previousEnd).toFixed(6))}s gap before “${entry.id}” remains an empty range.`, entry.id);
    previousEnd = Math.max(previousEnd, entry.start + entry.duration);
    if (entry.sequenceId && !sequenceTimelines[entry.sequenceId]) report("warning", "missing-sequence", `Schedule entry “${entry.id}” refers to missing sequence “${entry.sequenceId}”.`, entry.id);
  }
  const duration = Math.max(0.01, ...sortedSchedule.map((entry) => entry.start + Math.max(0, entry.duration)));
  const composition = createEmptySpineComposition(options.id, options.name, duration, options.frameRate);
  const designatedIdleSectionId = options.idleSectionId
    ?? sortedSchedule.find((entry) => entry.kind === "final-idle")?.id
    ?? sortedSchedule.find((entry) => isIdleKind(entry.kind))?.id
    ?? null;
  const scheduleGaps: Array<{ id: string; start: number; end: number }> = [];
  let sectionCursor = 0;
  for (const entry of sortedSchedule) {
    if (entry.start > sectionCursor + 1e-6) {
      const gap = { id: `migration-gap-${sectionCursor.toFixed(6)}-${entry.start.toFixed(6)}`, start: sectionCursor, end: entry.start };
      scheduleGaps.push(gap);
      composition.sections.push({ ...gap, name: "Unmapped gap" });
    }
    const route = sectionRoute(entry.kind, designatedIdleSectionId);
    composition.sections.push({
      id: entry.id,
      name: entry.sequenceId ? entry.kind === "opening" ? "Opening" : entry.kind.includes("idle") ? "Idle" : entry.sequenceId.replace(/^talk-/i, "Talk ") : entry.kind === "gap" ? "Gap" : entry.id,
      start: entry.start,
      end: entry.start + entry.duration,
      ...(route ? { route } : {}),
    });
    sectionCursor = Math.max(sectionCursor, entry.start + entry.duration);
  }
  composition.idleSectionId = designatedIdleSectionId;
  composition.entrySectionId = options.entrySectionId
    ?? sortedSchedule.find((entry) => entry.kind === "opening")?.id
    ?? sortedSchedule[0]?.id
    ?? null;
  if (composition.idleSectionId && !composition.sections.some((section) => section.id === composition.idleSectionId)) {
    report("error", "missing-idle-section", `Configured idle section “${composition.idleSectionId}” is not in the migration schedule.`, composition.idleSectionId);
  }
  if (composition.entrySectionId && !composition.sections.some((section) => section.id === composition.entrySectionId)) {
    report("error", "missing-entry-section", `Configured entry section “${composition.entrySectionId}” is not in the migration schedule.`, composition.entrySectionId);
  }

  const groups = new Map<string, LayerGroup>();
  const sequenceOccurrences = new Map<string, LayerOccurrence[]>();
  for (const sequenceId of sourceSequenceIds) {
    const timeline = sequenceTimelines[sequenceId];
    if (!timeline) continue;
    const ordinalByBase = new Map<string, number>();
    const occurrences: LayerOccurrence[] = [];
    for (const oldLayer of timeline.layers) {
      const base = JSON.stringify([oldLayer.id, oldLayer.role, oldLayer.directory]);
      const ordinal = ordinalByBase.get(base) ?? 0;
      ordinalByBase.set(base, ordinal + 1);
      const signature = layerSignature(oldLayer, ordinal);
      let group = groups.get(signature);
      if (!group) {
        const assetPath = timeline.assetPaths?.[oldLayer.directory] ?? oldLayer.directory;
        const assetIdentity = options.assetIdentityFor?.(oldLayer.directory, timeline) || `directory:${assetPath}`;
        group = {
          layer: {
            id: `legacy-layer-${safeId(signature)}`,
            name: oldLayer.name,
            role: oldLayer.role,
            order: oldLayer.order,
            assetDirectory: oldLayer.directory,
            assetIdentity,
            transformParentId: null,
            baseProperties: {
              "layer.position.x": oldLayer.x,
              "layer.position.y": oldLayer.y,
              "layer.rotation": oldLayer.rotation ?? 0,
              "layer.scale.x": oldLayer.scale,
              "layer.scale.y": oldLayer.scale,
              "layer.opacity": oldLayer.opacity,
              "layer.visible": oldLayer.enabled,
              "layer.blendMode": oldLayer.blendMode ?? "normal",
            },
            enabled: true,
            locked: oldLayer.locked === true,
          },
          occurrences: new Map(),
          firstTimeline: timeline,
        };
        groups.set(signature, group);
      } else if (group.layer.assetIdentity !== (options.assetIdentityFor?.(oldLayer.directory, timeline) || `directory:${timeline.assetPaths?.[oldLayer.directory] ?? oldLayer.directory}`)) {
        report("warning", "asset-identity-conflict", `Legacy layer “${oldLayer.id}” maps to different asset identities; the first identity is retained.`, group.layer.id);
      }
      occurrences.push({ layer: oldLayer, groupId: group.layer.id, ordinal });
    }
    sequenceOccurrences.set(sequenceId, occurrences);
  }
  composition.layers = [...groups.values()].map((group) => group.layer);

  const propertyKeys = new Map<string, { targetLayerId: string; property: string; keys: Array<{ id: string; time: number; value: CompositionPropertyTrack["keys"][number]["value"]; interpolation: "step" | "linear" }> }>();
  const addLayerKey = (layerId: string, property: string, time: number, value: CompositionPropertyTrack["keys"][number]["value"], id: string, interpolation: "step" | "linear" = "step") => {
    const key = `${layerId}\u0000${property}`;
    let track = propertyKeys.get(key);
    if (!track) {
      track = { targetLayerId: layerId, property, keys: [] };
      propertyKeys.set(key, track);
    }
    track.keys.push({ id, time: Number(time.toFixed(6)), value, interpolation });
  };

  for (const gap of scheduleGaps) {
    for (const group of groups.values()) {
      if (group.layer.role !== "background" || options.persistentBackgrounds === false) {
        addLayerKey(group.layer.id, "layer.visible", gap.start, false, `${safeId(gap.id)}:a-hide`);
      }
    }
  }

  for (const entry of sortedSchedule) {
    const timeline = entry.sequenceId ? sequenceTimelines[entry.sequenceId] : null;
    const occurrences = entry.sequenceId ? sequenceOccurrences.get(entry.sequenceId) ?? [] : [];
    const presentLayerIds = new Set(occurrences.map((occurrence) => occurrence.groupId));
    for (const group of groups.values()) {
      if (group.layer.role === "background" && options.persistentBackgrounds !== false) continue;
      if (!presentLayerIds.has(group.layer.id)) addLayerKey(group.layer.id, "layer.visible", entry.start, false, `${safeId(entry.id)}:a-hide`);
    }
    for (const occurrence of occurrences) {
      const oldLayer = occurrence.layer;
      const globalId = occurrence.groupId;
      const start = entry.start;
      const values: Array<[string, number | string]> = [
        ["layer.position.x", oldLayer.x],
        ["layer.position.y", oldLayer.y],
        ["layer.rotation", oldLayer.rotation ?? 0],
        ["layer.scale.x", oldLayer.scale],
        ["layer.scale.y", oldLayer.scale],
        ["layer.opacity", oldLayer.opacity],
        ["layer.blendMode", oldLayer.blendMode ?? "normal"],
      ];
      for (const [property, value] of values) addLayerKey(globalId, property, start, value, `${safeId(entry.id)}:${safeId(property)}`);
      addLayerKey(globalId, "layer.visible", start, oldLayer.enabled, `${safeId(entry.id)}:${oldLayer.enabled ? "z-show" : "a-hide"}`);
    }
    if (entry.kind !== "gap" && timeline && entry.sequenceId) {
      const mainCharacter = occurrences.find((occurrence) => occurrence.layer.role === "character");
      for (const occurrence of occurrences) {
        if (!occurrence.layer.followMainAnimation || !mainCharacter || occurrence.groupId === mainCharacter.groupId) continue;
        const group = [...groups.values()].find((candidate) => candidate.layer.id === occurrence.groupId)!;
        const currentParent = group.layer.transformParentId;
        if (currentParent && currentParent !== mainCharacter.groupId) report("warning", "legacy-parent-conflict", `Layer “${occurrence.layer.id}” has different legacy follow parents; the first is retained.`, group.layer.id);
        else group.layer.transformParentId = mainCharacter.groupId;
        const currentBinding = group.layer.animationBinding?.sourceLayerId;
        if (currentBinding && currentBinding !== mainCharacter.groupId) report("warning", "legacy-animation-binding-conflict", `Layer “${occurrence.layer.id}” has different legacy animation-name sources; the first is retained.`, group.layer.id);
        else group.layer.animationBinding = { sourceLayerId: mainCharacter.groupId, fallback: "authored-animation" };
      }

      const sourceEnd = entry.sourceStart + entry.duration;
      for (const occurrence of occurrences) {
        const oldLayer = occurrence.layer;
        const isPersistentBackground = options.persistentBackgrounds !== false && oldLayer.role === "background";
        for (const oldClip of legacyAnimationClips(oldLayer)) {
          const intersectStart = Math.max(oldClip.start, entry.sourceStart);
          const intersectEnd = Math.min(oldClip.end, sourceEnd);
          if (intersectEnd <= intersectStart) continue;
          const globalStart = entry.start + intersectStart - entry.sourceStart;
          const globalEnd = entry.start + intersectEnd - entry.sourceStart;
          const assetDuration = options.animationDurationFor?.(oldLayer.directory, oldClip.animation);
          const sourceLength = assetDuration && Number.isFinite(assetDuration) && assetDuration > 0
            ? assetDuration
            : Math.max(0.01, oldClip.end - oldClip.start + oldClip.animationOffset);
          if (!assetDuration && oldClip.animation) report("warning", "unknown-animation-duration", `Animation “${oldClip.animation}” on “${oldLayer.name}” has no asset duration metadata; migration uses its authored clip span as a provisional source range.`, oldClip.id);
          const group = [...groups.values()].find((candidate) => candidate.layer.id === occurrence.groupId)!;
          let sourceOriginTime = 0;
          let sourceOffset = oldClip.animationOffset;
          if (isPersistentBackground && options.persistentTimeMapping === "continuous-output") {
            if (group.backgroundSourceOriginTime === undefined) {
              group.backgroundSourceOriginTime = globalStart;
              group.backgroundSourceOffset = Math.max(0, intersectStart - oldLayer.start) + oldClip.animationOffset;
            }
            sourceOriginTime = group.backgroundSourceOriginTime;
            sourceOffset = group.backgroundSourceOffset ?? oldClip.animationOffset;
          } else if (isPersistentBackground) {
            sourceOriginTime = entry.start;
            sourceOffset = Math.max(0, entry.sourceStart - oldLayer.start) + oldClip.animationOffset;
          }
          const clip: CompositionAnimationClip = {
            id: `legacy-animation-${safeId(entry.id)}-${safeId(oldLayer.id)}-${safeId(oldClip.id)}`,
            layerId: occurrence.groupId,
            animation: oldClip.animation,
            ...(typeof oldClip.faceAnimation === "string" ? { faceAnimation: oldClip.faceAnimation } : {}),
            clock: { kind: "composition" },
            sourceClock: isPersistentBackground ? { kind: "composition" } : { kind: "clip-source" },
            start: globalStart,
            end: globalEnd,
            sourceStart: 0,
            sourceEnd: sourceLength,
            sourceOriginTime,
            sourceOffset,
            speed: 1,
            loop: oldClip.loop,
            endBehavior: oldClip.continueAfterOpening ? "hold" : "clear",
            blendIn: 0,
            blendOut: 0,
            mixingMode: "replace",
            weight: 1,
            priority: 0,
            enabled: oldLayer.enabled && oldClip.enabled !== false,
          };
          composition.animationClips.push(clip);
          if (oldClip.continueAfterOpening) report("warning", "opening-continuation", `Legacy continuation on clip “${oldClip.id}” is retained as an explicit hold clip; review its global endpoint.`, clip.id);
          if (oldClip.hideCharacter) report("warning", "legacy-hide-character", `Legacy hide-character behavior on “${oldClip.id}” needs an explicit visibility track in the migrated section.`, clip.id);
        }
      }

      for (const audio of timeline.audio) {
        const intersectStart = Math.max(audio.start, entry.sourceStart);
        const intersectEnd = Math.min(audio.end, sourceEnd);
        if (intersectEnd <= intersectStart) continue;
        composition.audio.push({
          id: `legacy-audio-${safeId(entry.id)}-${safeId(audio.id)}`,
          name: audio.name,
          path: audio.path,
          start: intersectStart - entry.sourceStart,
          end: intersectEnd - entry.sourceStart,
          sourceOffset: Math.max(0, intersectStart - audio.start),
          volume: audio.volume,
          enabled: audio.enabled,
          sectionId: entry.id,
        });
      }
      for (const cue of timeline.subtitles) {
        const intersectStart = Math.max(cue.start, entry.sourceStart);
        const intersectEnd = Math.min(cue.end, sourceEnd);
        if (intersectEnd <= intersectStart) continue;
        composition.subtitles.push({
          id: `legacy-subtitle-${safeId(entry.id)}-${safeId(cue.id)}`,
          start: intersectStart - entry.sourceStart,
          end: intersectEnd - entry.sourceStart,
          enabled: cue.enabled,
          text: { ...cue.text },
          sectionId: entry.id,
        });
      }
    }
  }

  for (const group of groups.values()) {
    addLayerKey(group.layer.id, "layer.visible", duration, false, "~composition-end-hide");
  }

  const layerById = new Map([...groups.values()].map((group) => [group.layer.id, group.layer]));
  composition.propertyTracks = [...propertyKeys.values()].map((item): CompositionPropertyTrack => ({
    id: `legacy-property-${safeId(item.targetLayerId)}-${safeId(item.property)}`,
    target: { kind: "layer", layerId: item.targetLayerId },
    property: item.property,
    clock: { kind: "composition" },
    enabled: true,
    priority: 0,
    blendMode: "override",
    weight: 1,
    baseValue: layerById.get(item.targetLayerId)?.baseProperties[item.property],
    holdBefore: true,
    holdAfter: true,
    keys: item.keys.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
  }));

  for (const group of groups.values()) {
    if (group.layer.role === "background" && options.persistentBackgrounds !== false) {
      const clips = composition.animationClips.filter((clip) => clip.layerId === group.layer.id).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index]!;
        const next = clips[index + 1];
        if (next && next.start > clip.end) clip.end = next.start;
        else if (!next && clip.end < composition.duration) clip.end = composition.duration;
      }
    }
  }

  const colorGroups = new Map<string, CompositionColorLayer>();
  const colorOrdinalBySequence = new Map<string, Map<string, number>>();
  for (const entry of sortedSchedule) {
    const timeline = entry.sequenceId ? sequenceTimelines[entry.sequenceId] : null;
    if (!timeline || !entry.sequenceId) continue;
    let ordinalByBase = colorOrdinalBySequence.get(entry.sequenceId);
    if (!ordinalByBase) { ordinalByBase = new Map(); colorOrdinalBySequence.set(entry.sequenceId, ordinalByBase); }
    for (const oldLayer of timeline.colorLayers ?? []) {
      const base = JSON.stringify([oldLayer.id, oldLayer.name]);
      const ordinal = ordinalByBase.get(base) ?? 0;
      ordinalByBase.set(base, ordinal + 1);
      const signature = JSON.stringify([oldLayer.id, oldLayer.name, ordinal]);
      let layer = colorGroups.get(signature);
      if (!layer) {
        layer = {
          id: `legacy-color-layer-${safeId(signature)}`,
          name: oldLayer.name,
          enabled: oldLayer.enabled,
          locked: oldLayer.locked,
          opacity: oldLayer.opacity,
          order: oldLayer.order,
          blendMode: oldLayer.blendMode,
          clips: [],
        };
        colorGroups.set(signature, layer);
      }
      const windowEnd = entry.sourceStart + entry.duration;
      for (const oldClip of oldLayer.clips) {
        const intersectStart = Math.max(oldClip.start, entry.sourceStart);
        const intersectEnd = Math.min(oldClip.end, windowEnd);
        if (intersectEnd <= intersectStart) continue;
        const clip: CompositionColorClip = {
          id: `legacy-color-${safeId(entry.id)}-${safeId(oldClip.id)}`,
          name: oldClip.name,
          start: entry.start + intersectStart - entry.sourceStart,
          end: entry.start + intersectEnd - entry.sourceStart,
          color: legacyHexColor(oldClip.color),
          opacity: oldClip.opacity,
          fadeIn: Math.max(0, oldClip.fadeIn - (intersectStart - oldClip.start)),
          fadeOut: Math.max(0, oldClip.fadeOut - (oldClip.end - intersectEnd)),
          enabled: oldClip.enabled,
        };
        layer.clips.push(clip);
      }
    }
  }
  composition.colorLayers = [...colorGroups.values()];

  const cameraKeyframes: SpineCameraTrack["keyframes"] = [];
  const cameraBounds = new Map<string, SpineCameraTrack["safeBounds"][number]>();
  let cameraBase: SpineCameraTrack | null = null;
  let cameraBaseSequenceId: string | null = null;
  for (const entry of sortedSchedule) {
    const timeline = entry.sequenceId ? sequenceTimelines[entry.sequenceId] : null;
    const camera = timeline?.camera;
    if (!camera) continue;
    if (!cameraBase) {
      cameraBase = camera;
      cameraBaseSequenceId = entry.sequenceId;
    }
    const mapBoundId = (boundId: string) => `legacy-bound-${safeId(entry.sequenceId ?? "none")}-${safeId(boundId)}`;
    for (const bound of camera.safeBounds) cameraBounds.set(mapBoundId(bound.id), { ...bound, id: mapBoundId(bound.id) });
    const sourceEnd = entry.sourceStart + entry.duration;
    for (const keyframe of camera.keyframes) {
      if (keyframe.time < entry.sourceStart || keyframe.time > sourceEnd) continue;
      const constraint = keyframe.constraint ?? camera.constraint;
      cameraKeyframes.push({
        ...keyframe,
        id: `legacy-camera-${safeId(entry.id)}-${safeId(keyframe.id)}`,
        time: entry.start + keyframe.time - entry.sourceStart,
        ...(constraint.mode === "manual" ? { constraint: { ...constraint, boundId: mapBoundId(constraint.boundId) } } : {}),
      });
    }
  }
  if (cameraBase) {
    const seenCameraTimes = new Map<number, SpineCameraTrack["keyframes"][number]>();
    for (const keyframe of cameraKeyframes.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) seenCameraTimes.set(keyframe.time, keyframe);
    const referenceLayerId = cameraBase.referenceLayerId && cameraBaseSequenceId
      ? sequenceOccurrences.get(cameraBaseSequenceId)?.find((occurrence) => occurrence.layer.id === cameraBase!.referenceLayerId)?.groupId
      : undefined;
    composition.camera = {
      ...cameraBase,
      ...(referenceLayerId ? { referenceLayerId } : {}),
      safeBounds: [...cameraBounds.values()],
      keyframes: [...seenCameraTimes.values()],
    };
  }

  sourceSequenceIds.forEach((sequenceId) => {
    const timeline = sequenceTimelines[sequenceId];
    if (timeline?.sequenceId === "opening" && timeline.openingMode !== "direct") {
      report("warning", "opening-mode", `Opening mode “${timeline.openingMode}” requires asset metadata/author review; source timeline is retained for fidelity.`, sequenceId);
    }
  });
  if (options.persistentBackgrounds !== false) assumptions.push("Background-role layers are treated as persistent migration presets: their last authored animation continues to the next authored background clip or composition end.");
  if (!options.assetIdentityFor) {
    assumptions.push("Stable asset identity falls back to the manifest path/directory because no asset-revision provider was supplied.");
    report("warning", "path-derived-asset-identity", "Bone/slot/constraint references will require asset-capability validation because migration used path-derived asset identities.");
  }
  const hasIdleRange = sortedSchedule.some((entry) => isIdleKind(entry.kind));
  if (!hasIdleRange) report("warning", "no-idle-range", "The selected schedule contains no explicit idle range; Talk routes cannot return to an authored idle section.");
  if (sortedSchedule.some((entry) => entry.kind === "talk") && !hasIdleRange) {
    report("warning", "talk-underlay-unresolved", "No Talk idle underlay was inferred; author an explicit idle animation clip or supply one during migration review.");
  }

  composition.migrationMetadata = {
    source: "legacy-opening-talk-sequences",
    sourceSequenceIds,
    sequenceOrder: project.sequenceOrder ? [...project.sequenceOrder] : null,
    deletedSequenceIds: project.deletedSequenceIds ? [...project.deletedSequenceIds] : null,
    originalTimelines: copyOriginalTimelines(project, sourceSequenceIds),
    migrationSchedule: sortedSchedule,
    persistentTimeMapping: options.persistentTimeMapping,
    persistentBackgrounds: options.persistentBackgrounds !== false,
    assumptions: [...assumptions],
  };
  return {
    composition,
    report: { sourceSequenceIds, schedule: sortedSchedule, assumptions, diagnostics, originalDataRetained: true },
  };
}
