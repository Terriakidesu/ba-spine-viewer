import type { EditorAnimationClip, EditorAudioClip, EditorColorLayer, EditorSubtitleCue, EditorTimeline, EditorTimelineLayer } from "./editorModel";
import { moveColorClip } from "./colorLayerModel";
import { extendTimelineDuration, insertAnimationClipRipple } from "./sequenceModel";

export type TimelineClipboardSelection =
  | { kind: "animation"; id: string }
  | { kind: "color"; id: string }
  | { kind: "cue"; id: string }
  | { kind: "audio"; id: string };

export type TimelineClipboardEntry =
  | { kind: "animation"; layerId: string; clip: EditorAnimationClip }
  | { kind: "color"; layerId: string; clip: EditorColorLayer["clips"][number] }
  | { kind: "cue"; cue: EditorSubtitleCue }
  | { kind: "audio"; clip: EditorAudioClip };

export interface TimelineClipboard {
  anchor: number;
  entries: TimelineClipboardEntry[];
}

export interface TimelinePasteResult {
  timeline: EditorTimeline;
  selections: TimelineClipboardSelection[];
  pastedCount: number;
  skippedCount: number;
  adjustedCount: number;
}

export type AnimationClipResolver = (layer: EditorTimelineLayer, timeline: EditorTimeline) => readonly EditorAnimationClip[];
export type TimelineClipboardIdFactory = () => string;

function entryStart(entry: TimelineClipboardEntry): number {
  return entry.kind === "cue" ? entry.cue.start : entry.clip.start;
}

function validRange(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start + 0.01;
}

/** Snapshot selected clips into an app-local clipboard; layer selections are intentionally excluded. */
export function copyTimelineSelection(
  timeline: EditorTimeline,
  selections: readonly TimelineClipboardSelection[],
  resolveAnimationClips: AnimationClipResolver,
): TimelineClipboard | null {
  const entries: TimelineClipboardEntry[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const key = `${selection.kind}:${selection.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (selection.kind === "animation") {
      for (const layer of timeline.layers) {
        const clip = resolveAnimationClips(layer, timeline).find((item) => item.id === selection.id);
        if (!clip) continue;
        if (validRange(clip.start, clip.end)) entries.push({ kind: "animation", layerId: layer.id, clip: { ...clip } });
        break;
      }
    } else if (selection.kind === "color") {
      for (const layer of timeline.colorLayers) {
        const clip = layer.clips.find((item) => item.id === selection.id);
        if (!clip) continue;
        if (validRange(clip.start, clip.end)) entries.push({ kind: "color", layerId: layer.id, clip: { ...clip } });
        break;
      }
    } else if (selection.kind === "cue") {
      const cue = timeline.subtitles.find((item) => item.id === selection.id);
      if (cue && validRange(cue.start, cue.end)) entries.push({ kind: "cue", cue: { ...cue, text: { ...cue.text } } });
    } else {
      const clip = timeline.audio.find((item) => item.id === selection.id);
      if (clip && validRange(clip.start, clip.end)) entries.push({ kind: "audio", clip: { ...clip } });
    }
  }
  if (entries.length === 0) return null;
  return { anchor: Math.min(...entries.map(entryStart)), entries };
}

function generatedId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `clip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Paste at the playhead while preserving relative timing and keeping same-track clips valid. */
export function pasteTimelineSelection(
  timeline: EditorTimeline,
  clipboard: TimelineClipboard,
  targetTime: number,
  resolveAnimationClips: AnimationClipResolver,
  createId: TimelineClipboardIdFactory = generatedId,
): TimelinePasteResult {
  if (!Number.isFinite(targetTime) || !Number.isFinite(clipboard.anchor) || clipboard.entries.length === 0) {
    return { timeline, selections: [], pastedCount: 0, skippedCount: clipboard.entries.length, adjustedCount: 0 };
  }

  const delta = Math.max(0, targetTime) - clipboard.anchor;
  const cueIdMap = new Map(clipboard.entries
    .filter((entry): entry is Extract<TimelineClipboardEntry, { kind: "cue" }> => entry.kind === "cue")
    .map(({ cue }) => [cue.id, createId()]));
  const copiedCues = clipboard.entries.filter((entry): entry is Extract<TimelineClipboardEntry, { kind: "cue" }> => entry.kind === "cue");
  const animationByLayer = new Map<string, EditorAnimationClip[]>();
  const changedAnimationLayers = new Set<string>();
  const colorsByLayer = new Map<string, EditorColorLayer["clips"]>();
  const changedColorLayers = new Set<string>();
  const subtitles = [...timeline.subtitles];
  const audio = [...timeline.audio];
  const selections: TimelineClipboardSelection[] = [];
  const selectionLayerIds = new Map<string, string>();
  let adjustedCount = 0;
  const orderedEntries = clipboard.entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => entryStart(a.entry) - entryStart(b.entry) || a.index - b.index);

  for (const { entry } of orderedEntries) {
    if (entry.kind === "animation") {
      const layer = timeline.layers.find((item) => item.id === entry.layerId);
      if (!layer || layer.locked) continue;
      let clips = animationByLayer.get(layer.id);
      if (!clips) {
        clips = [...resolveAnimationClips(layer, timeline)];
        animationByLayer.set(layer.id, clips);
      }
      const clip: EditorAnimationClip = {
        ...entry.clip,
        id: createId(),
        start: entry.clip.start + delta,
        end: entry.clip.end + delta,
      };
      animationByLayer.set(layer.id, insertAnimationClipRipple(clips, clip));
      changedAnimationLayers.add(layer.id);
      selections.push({ kind: "animation", id: clip.id });
      selectionLayerIds.set(`animation:${clip.id}`, layer.id);
    } else if (entry.kind === "color") {
      const layer = timeline.colorLayers.find((item) => item.id === entry.layerId);
      if (!layer || layer.locked) continue;
      const clips = colorsByLayer.get(layer.id) ?? [...layer.clips];
      const clip = {
        ...entry.clip,
        id: createId(),
        name: `${entry.clip.name} copy`,
        start: entry.clip.start + delta,
        end: entry.clip.end + delta,
      };
      const nextClips = moveColorClip([...clips, clip], clip.id, clip.start);
      if (nextClips.find((item) => item.id === clip.id)?.start !== clip.start) adjustedCount += 1;
      colorsByLayer.set(layer.id, nextClips);
      changedColorLayers.add(layer.id);
      selections.push({ kind: "color", id: clip.id });
      selectionLayerIds.set(`color:${clip.id}`, layer.id);
    } else if (entry.kind === "cue") {
      const id = cueIdMap.get(entry.cue.id)!;
      const cue: EditorSubtitleCue = {
        ...entry.cue,
        id,
        lineId: undefined,
        start: entry.cue.start + delta,
        end: entry.cue.end + delta,
        text: { ...entry.cue.text },
      };
      subtitles.push(cue);
      selections.push({ kind: "cue", id });
    } else {
      const id = createId();
      const clip: EditorAudioClip = {
        ...entry.clip,
        id,
        start: entry.clip.start + delta,
        end: entry.clip.end + delta,
      };
      if (entry.clip.subtitleId !== undefined) {
        clip.subtitleId = entry.clip.subtitleId === null ? null : cueIdMap.get(entry.clip.subtitleId) ?? null;
      } else if (entry.clip.lineId) {
        const linkedCue = copiedCues
          .filter(({ cue }) => cue.lineId === entry.clip.lineId)
          .sort((a, b) => Math.abs(a.cue.start - entry.clip.start) - Math.abs(b.cue.start - entry.clip.start))[0];
        clip.subtitleId = linkedCue ? cueIdMap.get(linkedCue.cue.id) ?? null : null;
        clip.lineId = undefined;
      }
      audio.push(clip);
      selections.push({ kind: "audio", id });
    }
  }

  if (selections.length === 0) {
    return { timeline, selections, pastedCount: 0, skippedCount: clipboard.entries.length, adjustedCount: 0 };
  }

  const layers = timeline.layers.map((layer) => changedAnimationLayers.has(layer.id)
    ? { ...layer, animationClips: animationByLayer.get(layer.id)! }
    : layer);
  const colorLayers = timeline.colorLayers.map((layer) => changedColorLayers.has(layer.id)
    ? { ...layer, clips: colorsByLayer.get(layer.id)! }
    : layer);
  const lastSelection = selections.at(-1)!;
  const lastLayerId = selectionLayerIds.get(`${lastSelection.kind}:${lastSelection.id}`) ?? null;
  const nextTimeline = extendTimelineDuration({
    ...timeline,
    layers,
    colorLayers,
    subtitles,
    audio,
    selectedLayerId: lastSelection.kind === "animation" ? lastLayerId : null,
    selectedCueId: lastSelection.kind === "cue" ? lastSelection.id : null,
    selectedColorLayerId: lastSelection.kind === "color" ? lastLayerId : null,
    selectedColorClipId: lastSelection.kind === "color" ? lastSelection.id : null,
  });
  return {
    timeline: nextTimeline,
    selections,
    pastedCount: selections.length,
    skippedCount: clipboard.entries.length - selections.length,
    adjustedCount,
  };
}
