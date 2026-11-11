import { compositionEvaluationContextAt, type CompositionEvaluationContext, type CompositionSection, type SpineComposition } from "./spineComposition";

export type CompositionPersistentTimeMapping = "continuous-output" | "original-authored-time";
export type CompositionScheduleSegmentKind = "composition" | "section" | "initial-idle" | "between-idle" | "final-idle" | "gap";

export interface CompositionScheduleSegment {
  id: string;
  kind: CompositionScheduleSegmentKind;
  start: number;
  duration: number;
  sectionId?: string;
  /** Section-local time sampled at this segment's output start. */
  sectionTimeStart: number;
  /** Authored time sampled at this output start; null for unfilled gaps, which use output time. */
  sourceTimeStart: number | null;
}

export interface SpineCompositionSchedule {
  frameRate: number;
  duration: number;
  persistentTimeMapping: CompositionPersistentTimeMapping;
  segments: CompositionScheduleSegment[];
}

export interface CompositionArrangementOptions {
  /** Ordered section instances. Entries are preserved in order. */
  sectionIds: readonly string[];
  idleSectionId?: string | null;
  initialIdleLoops?: number;
  betweenSectionIdleSeconds?: number;
  finalIdleLoops?: number;
  persistentTimeMapping?: CompositionPersistentTimeMapping;
}

export interface CompositionScheduleSample {
  segment: CompositionScheduleSegment;
  outputTime: number;
  sourceTime: number;
  sectionLocalTime?: number;
  sectionInstanceStartTimes: Readonly<Record<string, number>>;
  globalTimeOffset: number;
  context: CompositionEvaluationContext;
}

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function boundedCount(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.min(20, Math.floor(Number.isFinite(value) ? value! : fallback)));
}

function boundedGap(value: number | undefined): number {
  return Math.max(0, Math.min(30, Number.isFinite(value) ? value! : 0));
}

/** Shared schedule for the default authored-range export. */
export function createCanonicalCompositionSchedule(duration: number, frameRate = 30): SpineCompositionSchedule {
  const safeEnd = Math.max(0.01, safeDuration(duration));
  return {
    frameRate: Math.max(1, Number.isFinite(frameRate) ? frameRate : 30),
    duration: safeEnd,
    persistentTimeMapping: "continuous-output",
    segments: [{ id: "composition", kind: "composition", start: 0, duration: safeEnd, sectionTimeStart: 0, sourceTimeStart: 0 }],
  };
}

function appendSegment(
  segments: CompositionScheduleSegment[],
  state: { time: number },
  kind: CompositionScheduleSegmentKind,
  duration: number,
  section?: CompositionSection,
  sectionTimeStart = 0,
  id?: string,
): void {
  const safe = safeDuration(duration);
  if (safe <= 0) return;
  segments.push({
    id: id ?? `${kind}-${segments.length + 1}`,
    kind,
    start: state.time,
    duration: safe,
    ...(section ? { sectionId: section.id } : {}),
    sectionTimeStart,
    sourceTimeStart: section ? section.start + sectionTimeStart : null,
  });
  state.time += safe;
}

function appendIdleDuration(
  segments: CompositionScheduleSegment[],
  state: { time: number },
  kind: "initial-idle" | "between-idle" | "final-idle",
  duration: number,
  idleSection: CompositionSection | undefined,
): void {
  let remaining = safeDuration(duration);
  const sectionDuration = idleSection ? Math.max(0, idleSection.end - idleSection.start) : 0;
  let part = 0;
  while (remaining > 1e-9) {
    const slice = idleSection && sectionDuration > 0 ? Math.min(remaining, sectionDuration) : remaining;
    appendSegment(segments, state, idleSection ? kind : "gap", slice, idleSection, 0, `${kind}-${++part}`);
    remaining -= slice;
  }
}

/**
 * Build an explicit arrangement from section instances and authored idle gaps.
 * Section clocks restart for each instance; persistent time is resolved by the
 * same evaluator context used by Timeline, Camera, Viewer, and export.
 */
export function createCompositionArrangementSchedule(
  composition: SpineComposition,
  options: CompositionArrangementOptions,
): SpineCompositionSchedule {
  const sections = new Map(composition.sections.map((section) => [section.id, section]));
  const sectionIds = [...options.sectionIds];
  const duplicate = sectionIds.find((id, index) => sectionIds.indexOf(id) !== index);
  if (duplicate) throw new Error(`Arrangement repeats section “${duplicate}”; use one explicit instance per entry.`);
  for (const id of sectionIds) {
    if (!sections.has(id)) throw new Error(`Arrangement references missing section “${id}”.`);
  }
  const idleId = options.idleSectionId ?? null;
  const idleSection = idleId ? sections.get(idleId) : undefined;
  if (idleId && !idleSection) throw new Error(`Arrangement references missing idle section “${idleId}”.`);
  if (idleSection && idleSection.route && idleSection.route.role !== "idle") {
    throw new Error(`Arrangement idle section “${idleSection.id}” is not routed as idle.`);
  }

  const segments: CompositionScheduleSegment[] = [];
  const state = { time: 0 };
  const idleDuration = idleSection ? safeDuration(idleSection.end - idleSection.start) : 0;
  const initialLoops = boundedCount(options.initialIdleLoops, 1);
  const finalLoops = boundedCount(options.finalIdleLoops, 1);
  const gapDuration = boundedGap(options.betweenSectionIdleSeconds);

  if (idleDuration > 0 && initialLoops > 0) {
    appendIdleDuration(segments, state, "initial-idle", idleDuration * initialLoops, idleSection);
  }
  sectionIds.forEach((sectionId, index) => {
    const section = sections.get(sectionId)!;
    appendSegment(segments, state, "section", section.end - section.start, section, 0, `section-${section.id}`);
    if (index < sectionIds.length - 1 && gapDuration > 0) {
      appendIdleDuration(segments, state, "between-idle", gapDuration, idleSection);
    }
  });
  if (idleDuration > 0 && finalLoops > 0) {
    appendIdleDuration(segments, state, "final-idle", idleDuration * finalLoops, idleSection);
  }

  if (segments.length === 0) throw new Error("Arrangement must include at least one valid section instance or idle loop.");
  return {
    frameRate: Math.max(1, Number.isFinite(composition.frameRate) ? composition.frameRate : 30),
    duration: state.time,
    persistentTimeMapping: options.persistentTimeMapping ?? "continuous-output",
    segments,
  };
}

/** Resolve one schedule segment at an exact output timestamp. */
export function compositionScheduleSampleForSegment(
  composition: SpineComposition,
  schedule: SpineCompositionSchedule,
  segment: CompositionScheduleSegment,
  outputTime: number,
): CompositionScheduleSample {
  const safeOutputTime = Math.max(segment.start, Math.min(segment.start + segment.duration, Number.isFinite(outputTime) ? outputTime : segment.start));
  const elapsed = safeOutputTime - segment.start;
  const section = segment.sectionId ? composition.sections.find((item) => item.id === segment.sectionId) : undefined;
  const sectionLocalTime = section ? segment.sectionTimeStart + elapsed : undefined;
  const sourceTime = segment.sourceTimeStart === null ? safeOutputTime : segment.sourceTimeStart + elapsed;
  const persistentTime = schedule.persistentTimeMapping === "continuous-output" ? safeOutputTime : sourceTime;
  if (segment.kind === "composition") {
    const context = compositionEvaluationContextAt(composition, sourceTime, safeOutputTime);
    return {
      segment,
      outputTime: safeOutputTime,
      sourceTime,
      sectionInstanceStartTimes: Object.fromEntries(composition.sections.map((item) => [item.id, item.start])),
      globalTimeOffset: 0,
      context: { ...context, persistentTime },
    };
  }
  const sectionInstanceStartTimes = section
    ? { [section.id]: segment.start - segment.sectionTimeStart }
    : {};
  const channels = section?.route?.ownedChannels;
  const route = section?.route;
  const duration = section ? Math.max(0.01, section.end - section.start) : segment.duration;
  const local = sectionLocalTime ?? 0;
  const activeSectionWeight = route?.role === "talk"
    ? Math.min(
      route.blendIn > 0 ? Math.min(1, local / route.blendIn) : 1,
      route.blendOut > 0 ? Math.min(1, Math.max(0, duration - local) / route.blendOut) : 1,
    )
    : 1;
  return {
    segment,
    outputTime: safeOutputTime,
    sourceTime,
    ...(sectionLocalTime !== undefined ? { sectionLocalTime } : {}),
    sectionInstanceStartTimes,
    globalTimeOffset: segment.sourceTimeStart === null ? 0 : segment.start - segment.sourceTimeStart,
    context: {
      compositionTime: sourceTime,
      transportTime: safeOutputTime,
      persistentTime,
      ...(section ? {
        sectionInstanceTimes: { [section.id]: sectionLocalTime! },
        activeSectionId: section.id,
        activeSectionChannels: channels,
        activeSectionWeight,
      } : {}),
    },
  };
}

/** Resolve output time to the schedule's section-instance and persistent clocks. */
export function compositionScheduleSampleAt(
  composition: SpineComposition,
  schedule: SpineCompositionSchedule,
  outputTime: number,
): CompositionScheduleSample | null {
  if (!schedule.segments.length) return null;
  const bounded = Math.max(0, Math.min(schedule.duration, Number.isFinite(outputTime) ? outputTime : 0));
  let segment = schedule.segments.find((item) => bounded >= item.start && bounded < item.start + item.duration);
  if (!segment && bounded === schedule.duration) segment = schedule.segments.at(-1);
  if (!segment) return null;
  return compositionScheduleSampleForSegment(composition, schedule, segment, bounded);
}
