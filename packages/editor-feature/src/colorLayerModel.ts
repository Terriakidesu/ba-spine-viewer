import { normalizeColorClipFades, type SpineTimelineColorClip } from "@ba-spine/spine-runtime/spine/spineTimeline";

export type ColorClipPreset = "solid" | "fade-from-black" | "fade-to-black" | "white-flash";
export type ColorClipFade = "in" | "out";

export function colorClipPreset(id: string, preset: ColorClipPreset, start: number, duration = 2): SpineTimelineColorClip {
  const safeStart = Math.max(0, start);
  const safeDuration = Math.max(0.05, duration);
  const clip: SpineTimelineColorClip = {
    id,
    name: preset === "fade-from-black" ? "Fade from black" : preset === "fade-to-black" ? "Fade to black" : preset === "white-flash" ? "White flash" : "Color hold",
    color: preset === "white-flash" ? "#FFFFFF" : "#000000",
    start: safeStart,
    end: safeStart + safeDuration,
    opacity: 1,
    fadeIn: preset === "fade-to-black" ? safeDuration : preset === "white-flash" ? safeDuration * 0.2 : 0,
    fadeOut: preset === "fade-from-black" ? safeDuration : preset === "white-flash" ? safeDuration * 0.8 : 0,
    enabled: true,
  };
  return normalizeColorClipFades(clip);
}

function orderedOthers(clips: readonly SpineTimelineColorClip[], id: string): SpineTimelineColorClip[] {
  return clips.filter((clip) => clip.id !== id).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function adjustColorClipFade(clip: SpineTimelineColorClip, side: ColorClipFade, delta: number): SpineTimelineColorClip {
  if (!Number.isFinite(delta)) return clip;
  const duration = Math.max(0.01, clip.end - clip.start);
  const current = side === "in" ? clip.fadeIn : clip.fadeOut;
  const requested = side === "in" ? current + delta : current - delta;
  const fade = Math.max(0, Math.min(duration, requested));
  return normalizeColorClipFades({ ...clip, [side === "in" ? "fadeIn" : "fadeOut"]: fade });
}

/** Move a clip into the nearest available gap, keeping same-track clips disjoint. */
export function moveColorClip(clips: readonly SpineTimelineColorClip[], id: string, requestedStart: number): SpineTimelineColorClip[] {
  const clip = clips.find((item) => item.id === id);
  if (!clip || !Number.isFinite(requestedStart)) return [...clips];
  const duration = Math.max(0.01, clip.end - clip.start);
  const desired = Math.max(0, requestedStart);
  let cursor = 0;
  const candidates: number[] = [];
  for (const other of orderedOthers(clips, id)) {
    const latestStart = other.start - duration;
    if (latestStart >= cursor) candidates.push(Math.max(cursor, Math.min(latestStart, desired)));
    cursor = Math.max(cursor, other.end);
  }
  candidates.push(Math.max(cursor, desired));
  const start = candidates.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0]!;
  const moved = { ...clip, start, end: start + duration };
  return clips.map((item) => item.id === id ? normalizeColorClipFades(moved) : item).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Move a same-track selection by a shared delta without changing relative gaps. */
export function moveColorClipGroup(clips: readonly SpineTimelineColorClip[], ids: readonly string[], requestedDelta: number): SpineTimelineColorClip[] {
  if (!Number.isFinite(requestedDelta) || ids.length === 0) return [...clips];
  const selected = new Set(ids);
  const moving = clips.filter((clip) => selected.has(clip.id));
  if (!moving.length) return [...clips];
  const stationary = clips.filter((clip) => !selected.has(clip.id));
  const [minDelta, maxDelta] = colorClipGroupDeltaRange(moving, stationary);
  const delta = Math.max(minDelta, Math.min(maxDelta, requestedDelta));
  return clips.map((clip) => selected.has(clip.id)
    ? normalizeColorClipFades({ ...clip, start: clip.start + delta, end: clip.end + delta })
    : clip).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

function colorClipGroupDeltaRange(moving: readonly SpineTimelineColorClip[], stationary: readonly SpineTimelineColorClip[]): [number, number] {
  if (!moving.length) return [0, 0];
  let minDelta = -Math.min(...moving.map((clip) => clip.start));
  let maxDelta = Number.POSITIVE_INFINITY;
  for (const movingClip of moving) {
    for (const stationaryClip of stationary) {
      if (movingClip.end <= stationaryClip.start) maxDelta = Math.min(maxDelta, stationaryClip.start - movingClip.end);
      else if (stationaryClip.end <= movingClip.start) minDelta = Math.max(minDelta, stationaryClip.end - movingClip.start);
    }
  }
  return [minDelta, maxDelta];
}

/** Clamp color selections across tracks to one shared delta so their timing stays aligned. */
export function moveColorClipGroups(
  groups: readonly { clips: readonly SpineTimelineColorClip[]; ids: readonly string[] }[],
  requestedDelta: number,
): SpineTimelineColorClip[][] {
  if (!Number.isFinite(requestedDelta) || groups.length === 0) return groups.map(({ clips }) => [...clips]);
  const ranges = groups.map(({ clips, ids }) => {
    const selected = new Set(ids);
    return colorClipGroupDeltaRange(clips.filter((clip) => selected.has(clip.id)), clips.filter((clip) => !selected.has(clip.id)));
  });
  const minDelta = Math.max(...ranges.map(([minimum]) => minimum));
  const maxDelta = Math.min(...ranges.map(([, maximum]) => maximum));
  const delta = Math.max(minDelta, Math.min(maxDelta, requestedDelta));
  return groups.map(({ clips, ids }) => moveColorClipGroup(clips, ids, delta));
}

export function trimColorClipStart(clips: readonly SpineTimelineColorClip[], id: string, requestedStart: number): SpineTimelineColorClip[] {
  const clip = clips.find((item) => item.id === id);
  if (!clip || !Number.isFinite(requestedStart)) return [...clips];
  const previousEnd = Math.max(0, ...orderedOthers(clips, id).filter((item) => item.start < clip.start).map((item) => item.end));
  const start = Math.max(previousEnd, Math.min(clip.end - 0.01, Math.max(0, requestedStart)));
  const resized = normalizeColorClipFades({ ...clip, start });
  return clips.map((item) => item.id === id ? resized : item).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function trimColorClipEnd(clips: readonly SpineTimelineColorClip[], id: string, requestedEnd: number): SpineTimelineColorClip[] {
  const clip = clips.find((item) => item.id === id);
  if (!clip || !Number.isFinite(requestedEnd)) return [...clips];
  const nextStart = Math.min(Number.POSITIVE_INFINITY, ...orderedOthers(clips, id).filter((item) => item.start > clip.start).map((item) => item.start));
  const end = Math.min(nextStart, Math.max(clip.start + 0.01, requestedEnd));
  const resized = normalizeColorClipFades({ ...clip, end });
  return clips.map((item) => item.id === id ? resized : item).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function duplicateColorClip(clips: readonly SpineTimelineColorClip[], id: string, nextId: string): SpineTimelineColorClip[] {
  const source = clips.find((item) => item.id === id);
  if (!source) return [...clips];
  return moveColorClip([...clips, { ...source, id: nextId, name: `${source.name} copy` }], nextId, source.end);
}

export function deleteColorClip(clips: readonly SpineTimelineColorClip[], id: string): SpineTimelineColorClip[] {
  return clips.filter((item) => item.id !== id);
}
