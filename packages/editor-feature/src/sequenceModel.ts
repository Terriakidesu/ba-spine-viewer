import { ensureTimelineLayers, type EditorAnimationClip, type EditorAudioClip, type EditorProject, type EditorSubtitleCue, type EditorTimeline, type EditorTimelineLayer } from "./editorModel";
import { timelineAnimationClipPlaybackEnd, timelineColorLayerEnd, timelineLayerAnimationClips, timelineLayerPlaybackEnd, timelineOpeningDuration } from "@ba-spine/spine-runtime/spine/spineTimeline";
import type { SpineMeta } from "@ba-spine/spine-runtime/spine/spineRuntime";

export type OpeningPhaseId = "scene" | "intro" | "idle";

export interface OpeningPhaseTiming {
  id: OpeningPhaseId;
  start: number;
  end: number;
}

export function effectiveAnimationClips(layer: EditorTimelineLayer, timeline: EditorTimeline, meta: SpineMeta | null, introDuration: number): EditorAnimationClip[] {
  return timelineLayerAnimationClips(layer, meta, timeline.sequenceId ?? "legacy", timeline.openingMode ?? "direct", introDuration) as EditorAnimationClip[];
}

export function animationClipEnd(clip: EditorAnimationClip, animationDuration: number): number {
  return timelineAnimationClipPlaybackEnd(clip, animationDuration);
}

/** Resolve an animation's non-looping endpoint from its decoded Spine duration. */
export function matchedAnimationEndpoint(
  timing: Pick<EditorAnimationClip, "start" | "animationOffset">,
  animationDuration: number,
): number | null {
  if (!Number.isFinite(timing.start) || !Number.isFinite(animationDuration) || animationDuration <= 0) return null;
  const offset = Number.isFinite(timing.animationOffset) ? Math.max(0, timing.animationOffset) : 0;
  return Math.max(timing.start + 0.01, timing.start + Math.max(0.01, animationDuration - offset));
}

/** Reposition a clip and ripple the later sequence; moving left through a clip inserts before it. */
export function moveAnimationClipRipple(clips: readonly EditorAnimationClip[], clipId: string, requestedStart: number, snap = 0, targets: number[] = []): EditorAnimationClip[] {
  const original = [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const selectedIndex = original.findIndex((clip) => clip.id === clipId);
  if (selectedIndex < 0) return [...clips];
  const selected = original[selectedIndex]!;
  const start = Math.max(0, snapToTargets(requestedStart, snap, targets));
  const delta = start - selected.start;
  if (Math.abs(delta) < 0.000001) return [...clips];
  const length = Math.max(0.01, selected.end - selected.start);
  if (delta > 0) {
    return original.map((clip, index) => index < selectedIndex ? clip : {
      ...clip,
      start: Math.max(0, clip.start + delta),
      end: Math.max(0.01, clip.end + delta),
    });
  }

  const remaining = original.filter((clip) => clip.id !== clipId);
  const collisionIndex = remaining.findIndex((clip) => clip.start < start + length && clip.end > start);
  const insertAt = collisionIndex < 0
    ? remaining.findIndex((clip) => clip.start >= start)
    : collisionIndex;
  const index = insertAt < 0 ? remaining.length : insertAt;
  const ordered = [...remaining.slice(0, index), selected, ...remaining.slice(index)];
  let previousEnd = 0;
  return ordered.map((clip) => {
    const duration = Math.max(0.01, clip.end - clip.start);
    const originalIndex = original.findIndex((item) => item.id === clip.id);
    const requested = clip.id === clipId ? start : clip.start + (originalIndex > selectedIndex ? delta : 0);
    const nextStart = clip.id === clipId ? start : Math.max(0, requested, previousEnd);
    previousEnd = nextStart + duration;
    return { ...clip, start: nextStart, end: previousEnd };
  });
}

export function insertAnimationClipRipple(clips: readonly EditorAnimationClip[], clip: EditorAnimationClip): EditorAnimationClip[] {
  const length = Math.max(0.01, clip.end - clip.start);
  const shifted = clips.map((item) => item.start >= clip.start
    ? { ...item, start: item.start + length, end: item.end + length }
    : item);
  return [...shifted, clip].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function duplicateAnimationClipRipple(clips: readonly EditorAnimationClip[], clipId: string, nextId: string): EditorAnimationClip[] {
  const source = clips.find((clip) => clip.id === clipId);
  if (!source) return [...clips];
  const length = Math.max(0.01, source.end - source.start);
  const duplicate = { ...source, id: nextId, start: source.end, end: source.end + length };
  return insertAnimationClipRipple(clips, duplicate);
}

export function deleteAnimationClipRipple(clips: readonly EditorAnimationClip[], clipId: string): EditorAnimationClip[] {
  const removed = clips.find((clip) => clip.id === clipId);
  if (!removed) return [...clips];
  const length = Math.max(0.01, removed.end - removed.start);
  return clips.filter((clip) => clip.id !== clipId).map((clip) => clip.start >= removed.end
    ? { ...clip, start: Math.max(0, clip.start - length), end: Math.max(0.01, clip.end - length) }
    : clip);
}

/** Resolve a non-looping layer's visible end from the actual Spine animation. */
export function animationEndForLayer(layer: Pick<EditorTimelineLayer, "start" | "end" | "endMode" | "loop" | "animationOffset">, animationDuration: number): number {
  return timelineLayerPlaybackEnd(layer, animationDuration);
}

/** Talk playback is bounded by its character animations, never by subtitle/audio clips. */
export function talkSequenceDuration(
  layers: readonly EditorTimelineLayer[],
  animationDurations: Readonly<Record<string, number>>,
  animationForLayer: (layer: EditorTimelineLayer) => string,
): number {
  const characters = layers.filter((layer) => layer.role === "character");
  if (characters.length === 0) return 1;
  return Math.max(1, ...characters.map((layer) => animationEndForLayer(
    layer.endMode === "manual" ? layer : { ...layer, loop: false },
    animationDurations[`${layer.id}:${animationForLayer(layer)}`] ?? 0,
  )));
}

/** Find the latest authored subtitle/audio or manually-sized layer endpoint. */
export function authoredTimelineEnd(timeline: Pick<EditorTimeline, "layers" | "subtitles" | "audio" | "colorLayers">): number {
  return Math.max(
    0,
    ...timeline.layers.filter((layer) => layer.endMode === "manual").map((layer) => layer.end),
    ...timeline.subtitles.map((cue) => cue.end),
    ...timeline.audio.map((clip) => clip.end),
    ...timeline.colorLayers.map(timelineColorLayerEnd),
  );
}

/**
 * Resolve an automatic opening's meaningful endpoint.
 *
 * The old importer could leave the saved duration longer than every visible
 * layer, which made the viewer display a blank tail after the character had
 * already reached idle. Keep the real intro and authored content, then trim
 * only the unused remainder.
 */
export function openingTimelineDuration(
  timeline: Pick<EditorTimeline, "layers" | "subtitles" | "audio" | "colorLayers" | "openingMode" | "sceneDuration">,
  introDuration: number,
  layerEndFor: (layer: EditorTimelineLayer) => number = (layer) => layer.end,
): number {
  return timelineOpeningDuration(timeline, introDuration, layerEndFor);
}

/** Preserve a timeline extension made by authored content without changing its mode. */
export function extendTimelineDuration(timeline: EditorTimeline): EditorTimeline {
  const contentEnd = Math.max(
    0,
    ...timeline.layers.filter((layer) => layer.endMode === "manual").map((layer) => layer.end),
    ...timeline.subtitles.map((cue) => cue.end),
    ...timeline.audio.map((clip) => clip.end),
    ...(timeline.durationMode === "auto" ? timeline.colorLayers.map(timelineColorLayerEnd) : []),
  );
  const duration = Math.max(1, timeline.duration, contentEnd);
  return duration === timeline.duration ? timeline : { ...timeline, duration };
}

/** Resolve an audio clip's explicit link, then retain compatibility with imported lineId links. */
export function linkedSubtitleForAudio(timeline: EditorTimeline, clip: Pick<EditorAudioClip, "subtitleId" | "lineId" | "start">): EditorSubtitleCue | null {
  if (clip.subtitleId === null) return null;
  if (clip.subtitleId) return timeline.subtitles.find((cue) => cue.id === clip.subtitleId) ?? null;
  if (!clip.lineId) return null;
  return timeline.subtitles
    .filter((cue) => cue.lineId === clip.lineId)
    .sort((a, b) => Math.abs(a.start - clip.start) - Math.abs(b.start - clip.start))[0] ?? null;
}

/** Set or clear an explicit one-to-one audio/subtitle relationship. */
export function linkAudioToSubtitle(timeline: EditorTimeline, audioId: string, subtitleId: string | null): EditorTimeline {
  if (subtitleId !== null && !timeline.subtitles.some((cue) => cue.id === subtitleId)) return timeline;
  if (!timeline.audio.some((clip) => clip.id === audioId)) return timeline;
  return {
    ...timeline,
    audio: timeline.audio.map((clip) => clip.id === audioId
      ? { ...clip, subtitleId }
      : subtitleId !== null && clip.subtitleId === subtitleId
        ? { ...clip, subtitleId: null }
        : clip),
  };
}

/** Fit an audio clip to its decoded source, and fit its linked subtitle when one exists. */
export function matchAudioAndSubtitleLength(timeline: EditorTimeline, audioId: string, decodedDuration: number): EditorTimeline {
  if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) return timeline;
  const clip = timeline.audio.find((item) => item.id === audioId);
  if (!clip) return timeline;
  const start = Math.max(0, clip.start);
  const end = start + Math.max(0.01, decodedDuration);
  const linked = linkedSubtitleForAudio(timeline, clip);
  return extendTimelineDuration({
    ...timeline,
    audio: timeline.audio.map((item) => item.id === audioId ? { ...item, start, end, autoEnd: true } : item),
    subtitles: linked
      ? timeline.subtitles.map((cue) => cue.id === linked.id ? { ...cue, start, end } : cue)
      : timeline.subtitles,
  });
}

/** Move an audio clip and its nearest subtitle cue from the same imported line together. */
export function moveAudioClip(timeline: EditorTimeline, id: string, start: number): EditorTimeline {
  const clip = timeline.audio.find((item) => item.id === id);
  if (!clip) return timeline;
  const nextStart = Math.max(0, start);
  const delta = nextStart - clip.start;
  const audio = timeline.audio.map((item) => item.id === id
    ? { ...item, start: nextStart, end: Math.max(nextStart + 0.01, item.end + delta) }
    : item);
  const linked = linkedSubtitleForAudio(timeline, clip);
  if (Math.abs(delta) < 0.000001 || !linked) return extendTimelineDuration({ ...timeline, audio });
  const subtitles = timeline.subtitles.map((cue) => cue.id === linked.id
    ? { ...cue, start: Math.max(0, cue.start + delta), end: Math.max(cue.start + delta + 0.01, cue.end + delta) }
    : cue);
  return extendTimelineDuration({ ...timeline, audio, subtitles });
}

export function openingPhaseTimings(mode: "scene-first" | "direct" | "skip", sceneDuration: number, introDuration: number, totalDuration: number, introStartOverride?: number): OpeningPhaseTiming[] {
  const phases: OpeningPhaseTiming[] = [];
  const safeScene = Math.max(0, sceneDuration);
  const safeIntro = mode === "skip" ? 0 : Math.max(0, introDuration);
  const sceneEnd = Math.max(0, introStartOverride ?? safeScene);
  let cursor = mode === "scene-first" ? sceneEnd : Math.max(0, introStartOverride ?? 0);
  if (mode === "scene-first" && sceneEnd > 0) {
    phases.push({ id: "scene", start: 0, end: sceneEnd });
  }
  if (safeIntro > 0) {
    phases.push({ id: "intro", start: cursor, end: cursor + safeIntro });
    cursor += safeIntro;
  }
  phases.push({ id: "idle", start: cursor, end: Math.max(cursor, totalDuration) });
  return phases;
}

export function talkSequenceId(animation: string): string {
  const number = animation.match(/talk[_ -]?(\d+)/i)?.[1];
  return number ? `talk-${Number(number)}` : "opening";
}

/** Return the next numbered Talk in playback order, optionally wrapping the playlist. */
export function nextTalkSequenceId(sequenceIds: readonly string[], currentId: string, loop = false): string | null {
  const ordered = [...new Set(sequenceIds.filter((id) => /^talk-\d+$/i.test(id)))]
    .sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0));
  const index = ordered.indexOf(currentId);
  if (index < 0 || ordered.length === 0) return null;
  if (index + 1 < ordered.length) return ordered[index + 1]!;
  return loop ? ordered[0]! : null;
}

export function switchSequence(project: EditorProject, id: string, animations: string[], directories: string[]): EditorProject {
  const previousId = project.timeline.sequenceId ?? "legacy";
  const sequences = { ...project.sequences };
  if (previousId !== id) sequences[previousId] = structuredClone(project.timeline);
  let next = previousId === id ? structuredClone(project.timeline) : sequences[id];
  if (!next) {
    const number = id.replace("talk-", "");
    const main = animations.find((name) => talkSequenceId(name) === id && /_m$/i.test(name));
    const face = animations.find((name) => talkSequenceId(name) === id && /_a$/i.test(name));
    const animation = id === "opening" ? "" : main ?? animations.find((name) => talkSequenceId(name) === id) ?? `Talk_${number.padStart(2, "0")}_M`;
    next = {
      ...structuredClone(project.timeline), sequenceId: id, duration: id === "opening" ? 12 : 1, loop: false,
      openingMode: "direct", sceneDuration: 3, openingIdleDuration: 3,
      durationMode: id === "opening" || /^talk-\d+$/i.test(id) ? "auto" : "manual",
      layersInitialized: false,
      subtitles: [], audio: [], selectedCueId: null,
      layers: project.timeline.layers.map((layer) => ({ ...layer, start: 0, end: 12, animation: layer.role === "character" ? animation : "", faceAnimation: layer.role === "character" ? face ?? "" : "", loop: id === "opening" })),
    };
  }
  if (id.startsWith("talk-")) {
    next = {
      ...next,
      layers: next.layers.map((layer) => layer.role === "character" && layer.endMode !== "manual" ? { ...layer, loop: false } : layer),
    };
  }
  if (id === "opening") {
    next = { ...next, openingIdleDuration: next.openingIdleDuration ?? 3, durationMode: next.durationMode ?? "manual" };
  }
  return { ...project, sequences, timeline: ensureTimelineLayers(next, project.assetDirectory, directories) };
}

/** Replace the imported subtitle/audio payload while preserving authored sequence and layer settings. */
export function replaceSubtitleImport(project: EditorProject, subtitlePath: string): EditorProject {
  const replace = (timeline: EditorTimeline): EditorTimeline => ({
    ...structuredClone(timeline),
    subtitlePath,
    subtitles: [],
    audio: [],
    selectedCueId: null,
  });
  return {
    ...project,
    timeline: replace(project.timeline),
    sequences: project.sequences
      ? Object.fromEntries(Object.entries(project.sequences).map(([id, timeline]) => [id, replace(timeline)]))
      : project.sequences,
  };
}

export function splitCue(timeline: EditorTimeline, id: string, time: number): EditorTimeline {
  const cue = timeline.subtitles.find((item) => item.id === id);
  if (!cue || time <= cue.start || time >= cue.end) return timeline;
  return { ...timeline, subtitles: timeline.subtitles.flatMap((item) => item.id === id ? [{ ...item, end: time }, { ...item, id: crypto.randomUUID(), start: time, text: { ...item.text } }] : [item]) };
}

export interface TimelineSnapResolution {
  value: number;
  target: number | null;
  source: "target" | "grid" | null;
}

export function resolveTimelineSnap(value: number, interval: number, targets: readonly number[], tolerance = 0.08): TimelineSnapResolution {
  const closest = targets.reduce((best, target) => Math.abs(target - value) < Math.abs(best - value) ? target : best, Number.POSITIVE_INFINITY);
  if (Number.isFinite(closest) && Math.abs(closest - value) <= tolerance) return { value: closest, target: closest, source: "target" };
  if (interval > 0) {
    const snapped = Math.round(value / interval) * interval;
    return { value: snapped, target: snapped, source: "grid" };
  }
  return { value, target: null, source: null };
}

export function snapToTargets(value: number, interval: number, targets: number[], tolerance = 0.08): number {
  return resolveTimelineSnap(value, interval, targets, tolerance).value;
}
