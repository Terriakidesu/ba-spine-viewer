import { findIdleAnimation } from "./spineAnimation";
import type { SpineMeta } from "./spineRuntime";
import { normalizeSpineCameraTrack, type SpineCameraTrack } from "./spineCameraMotion";

export type SpineTimelineLayerRole = "character" | "scene" | "background" | "overlay";
export type SpineTimelineLanguage = "en" | "ja" | "ko";
export type SpineTimelineBlendMode = "normal" | "multiply" | "screen" | "additive";

export interface SpineTimelineColorClip {
  id: string;
  name: string;
  color: string;
  start: number;
  end: number;
  opacity: number;
  fadeIn: number;
  fadeOut: number;
  enabled: boolean;
}

export interface SpineTimelineColorLayer {
  id: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  opacity: number;
  order: number;
  blendMode: SpineTimelineBlendMode;
  clips: SpineTimelineColorClip[];
}

export interface SpineTimelineAnimationClip {
  id: string;
  animation: string;
  faceAnimation?: string;
  start: number;
  end: number;
  endMode?: "auto" | "manual";
  animationOffset: number;
  loop: boolean;
  enabled?: boolean;
  /** Keep this final opening animation running when the opening hands off to interaction idle. */
  continueAfterOpening?: boolean;
  /** Scene clips can explicitly hide the character while they are active. */
  hideCharacter?: boolean;
}

export interface SpineTimelineLayer {
  id: string;
  name: string;
  role: SpineTimelineLayerRole;
  directory: string;
  enabled: boolean;
  locked?: boolean;
  blendMode?: SpineTimelineBlendMode;
  animation: string;
  faceAnimation?: string;
  animationClips?: SpineTimelineAnimationClip[];
  /** Use the main character's matching animation and sample clock when available. */
  followMainAnimation?: boolean;
  start: number;
  end: number;
  endMode?: "auto" | "manual";
  animationOffset: number;
  loop: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  order: number;
}

export interface SpineTimelineSubtitle {
  id: string;
  start: number;
  end: number;
  enabled: boolean;
  text: Record<SpineTimelineLanguage, string>;
}

export interface SpineTimelineAudio {
  id: string;
  name: string;
  path: string;
  start: number;
  end: number;
  enabled: boolean;
  volume: number;
}

export type SpineTimelineAudioPreloadState = "loading" | "ready" | "missing";

/** Do not advance playback until enabled audio is ready or known to be unavailable. */
export function timelineAudioPreloadsReady(
  clips: readonly Pick<SpineTimelineAudio, "id" | "enabled">[],
  states: Readonly<Record<string, SpineTimelineAudioPreloadState>>,
): boolean {
  return clips.every((clip) => !clip.enabled || states[clip.id] === "ready" || states[clip.id] === "missing");
}

export interface SpineTimelineAudioPlaybackDecision {
  seek: boolean;
  play: boolean;
  started: boolean;
}

/** Keep timeline audio synchronized without restarting a clip every playhead frame. */
export function timelineAudioPlaybackDecision(input: {
  active: boolean;
  playing: boolean;
  currentTime: number;
  previousTime: number | undefined;
  started: boolean;
  ended: boolean;
}): SpineTimelineAudioPlaybackDecision {
  if (!input.active) return { seek: false, play: false, started: false };
  const rewound = input.previousTime !== undefined && input.currentTime < input.previousTime - 0.05;
  const entered = !input.started || rewound;
  return {
    seek: entered,
    play: input.playing && (entered || !input.ended),
    started: true,
  };
}

export interface SpineTimeline {
  sequenceId: string;
  openingMode: "scene-first" | "direct" | "skip";
  sceneDuration: number;
  openingIdleDuration: number;
  durationMode: "auto" | "manual";
  duration: number;
  loop: boolean;
  layersInitialized?: boolean;
  /** Root-relative Spine set directories for every layer in this sequence. */
  assetPaths?: Record<string, string>;
  layers: SpineTimelineLayer[];
  colorLayers?: SpineTimelineColorLayer[];
  subtitles: SpineTimelineSubtitle[];
  audio: SpineTimelineAudio[];
  language: SpineTimelineLanguage;
  camera?: SpineCameraTrack;
}

export type SpineTimelineVisualLayer =
  | { kind: "spine"; layer: SpineTimelineLayer }
  | { kind: "color"; layer: SpineTimelineColorLayer };

export function timelineVisualLayers(timeline: Pick<SpineTimeline, "layers"> & { colorLayers?: SpineTimelineColorLayer[] }): SpineTimelineVisualLayer[] {
  return [
    ...timeline.layers.map((layer) => ({ kind: "spine" as const, layer })),
    ...(timeline.colorLayers ?? []).map((layer) => ({ kind: "color" as const, layer })),
  ].sort((a, b) => a.layer.order - b.layer.order || a.layer.id.localeCompare(b.layer.id));
}

/** Keep camera-reference choice independent of compositing order changes. */
export function timelineReferenceLayerId(timeline: Pick<SpineTimeline, "layers"> & { camera?: SpineTimeline["camera"] }): string {
  const authoredReference = timeline.camera?.referenceLayerId;
  if (authoredReference && timeline.layers.some((layer) => layer.id === authoredReference)) return authoredReference;
  return timeline.layers.find((layer) => layer.role === "character")?.id ?? timeline.layers[0]?.id ?? "";
}

export function timelineActiveColorClip(layer: SpineTimelineColorLayer, time: number): SpineTimelineColorClip | null {
  if (!layer.enabled) return null;
  return [...layer.clips]
    .filter((clip) => clip.enabled && time >= clip.start && time <= clip.end)
    .sort((a, b) => b.start - a.start || a.id.localeCompare(b.id))[0] ?? null;
}

export function timelineColorClipOpacity(layer: SpineTimelineColorLayer, clip: SpineTimelineColorClip, time: number): number {
  if (!layer.enabled || !clip.enabled || time < clip.start || time > clip.end) return 0;
  const duration = Math.max(0.01, clip.end - clip.start);
  const elapsed = time - clip.start;
  const remaining = clip.end - time;
  const fadeIn = clip.fadeIn > 0 ? Math.min(1, elapsed / clip.fadeIn) : 1;
  const fadeOut = clip.fadeOut > 0 ? Math.min(1, remaining / clip.fadeOut) : 1;
  return Math.max(0, Math.min(1, layer.opacity)) * Math.max(0, Math.min(1, clip.opacity)) * Math.min(fadeIn, fadeOut);
}

export function timelineColorLayerEnd(layer: SpineTimelineColorLayer): number {
  return layer.enabled ? Math.max(0, ...layer.clips.filter((clip) => clip.enabled).map((clip) => clip.end)) : 0;
}

export function timelineBlendModeCss(mode: SpineTimelineBlendMode): "normal" | "multiply" | "screen" | "plus-lighter" {
  return mode === "additive" ? "plus-lighter" : mode;
}

export function normalizeColorClipFades<T extends Pick<SpineTimelineColorClip, "start" | "end" | "fadeIn" | "fadeOut">>(clip: T): T {
  const duration = Math.max(0.01, clip.end - clip.start);
  const fadeIn = Math.max(0, Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0);
  const fadeOut = Math.max(0, Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0);
  const total = fadeIn + fadeOut;
  const scale = total > duration ? duration / total : 1;
  return { ...clip, fadeIn: fadeIn * scale, fadeOut: fadeOut * scale };
}

export interface SpineTimelineProject {
  timeline?: SpineTimeline;
  sequences?: Record<string, SpineTimeline>;
}

/** Idle is a runtime animation, not an alias for the opening timeline. */
export function timelineIdleAnimation(meta: Pick<SpineMeta, "idleAnimation" | "animations">): string {
  return meta.idleAnimation || findIdleAnimation(meta.animations) || "";
}

/** Resolve a per-clip face animation, preserving an explicit empty override. */
export function timelineFaceAnimation(
  layer: Pick<SpineTimelineLayer, "faceAnimation">,
  clip?: Pick<SpineTimelineAnimationClip, "faceAnimation"> | null,
): string {
  return clip?.faceAnimation ?? layer.faceAnimation ?? "";
}

/** A talk's idle tail stays visible until the sequence, not its clip, ends. */
export function timelineTalkIdleStart(layer: SpineTimelineLayer, animationDuration: number): number {
  return Math.max(layer.end, layer.start + Math.max(0, animationDuration - layer.animationOffset));
}

/** Resolve a localized cue using the same fallback order in the editor and viewer. */
export function timelineSubtitleText(cue: Pick<SpineTimelineSubtitle, "text">, language: SpineTimelineLanguage): string {
  return cue.text[language] || cue.text.en || cue.text.ja || cue.text.ko || "";
}

/** Return every active subtitle, preserving the authored timeline order. */
export function timelineActiveSubtitleTexts(timeline: Pick<SpineTimeline, "subtitles" | "language">, currentTime: number): string[] {
  return timeline.subtitles
    .filter((cue) => cue.enabled && currentTime >= cue.start && currentTime <= cue.end)
    .map((cue) => timelineSubtitleText(cue, timeline.language))
    .filter((text) => text.trim().length > 0);
}

export function timelineSequenceIds(project: SpineTimelineProject): string[] {
  const ids: string[] = [];
  if (project.timeline) ids.push(project.timeline.sequenceId);
  for (const id of Object.keys(project.sequences ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Return authored numbered talk sequences in playback order. */
export function timelineTalkSequenceIds(project: SpineTimelineProject): string[] {
  return timelineSequenceIds(project)
    .filter((id) => /^talk-\d+$/i.test(id))
    .sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0));
}

/** A talk sequence is still playing until its authored idle tail begins. */
export function timelineTalkInProgress(sequenceId: string, idleMode: "none" | "persistent" | "bridge"): boolean {
  return /^talk-\d+$/i.test(sequenceId) && idleMode === "none";
}

export function timelineForSequence(project: SpineTimelineProject, sequenceId: string): SpineTimeline | null {
  if (project.timeline?.sequenceId === sequenceId) return project.timeline;
  return project.sequences?.[sequenceId] ?? null;
}

export function timelinePlaybackDuration(
  timeline: Pick<SpineTimeline, "layers" | "subtitles" | "audio" | "duration"> & { colorLayers?: SpineTimelineColorLayer[]; sequenceId?: string; durationMode?: SpineTimeline["durationMode"] },
  openingMinimumDuration = 0,
  layerEndFor: (layer: SpineTimelineLayer) => number = (layer) => Array.isArray(layer.animationClips)
    ? Math.max(0, ...layer.animationClips.filter((clip) => clip.enabled !== false).map((clip) => clip.end))
    : layer.end,
  talkMixDuration = 0,
): number {
  const allLayerEnd = Math.max(0, ...timeline.layers.filter((layer) => layer.enabled).map(layerEndFor));
  const selectedLayerEnd = timeline.sequenceId === "opening" && timeline.durationMode !== "auto"
    ? Math.max(0, ...timeline.layers.filter((layer) => layer.enabled).flatMap((layer) => Array.isArray(layer.animationClips)
      ? [layerEndFor(layer)]
      : layer.endMode === "manual" ? [layerEndFor(layer)] : []))
    : allLayerEnd;
  const authoredContentEnd = Math.max(0, ...timeline.subtitles.map((cue) => cue.end), ...timeline.audio.map((clip) => clip.end));
  const colorContentEnd = Math.max(0, ...(timeline.colorLayers ?? []).map(timelineColorLayerEnd));
  const contentEnd = Math.max(authoredContentEnd, colorContentEnd);
  const enabledContentEnd = Math.max(
    0,
    ...timeline.subtitles.filter((cue) => cue.enabled).map((cue) => cue.end),
    ...timeline.audio.filter((clip) => clip.enabled).map((clip) => clip.end),
    ...(timeline.colorLayers ?? []).map(timelineColorLayerEnd),
  );
  const isTalkSequence = /^talk-\d+$/i.test(timeline.sequenceId ?? "");
  let baseDuration: number;
  if (timeline.sequenceId === "opening" && timeline.durationMode === "auto" && (timeline.layers.length > 0 || (timeline.colorLayers?.length ?? 0) > 0)) {
    // Automatic openings end at their last visible/authored endpoint. This
    // removes stale blank tail time left by an older import while the caller
    // can still protect an intro that has not yet reached its idle state.
    baseDuration = Math.max(1, openingMinimumDuration, selectedLayerEnd, contentEnd);
  } else if (isTalkSequence && timeline.durationMode === "auto") {
    // Talk auto-fit ignores stale saved duration and disabled dialogue while
    // retaining every enabled layer, subtitle, and voice endpoint.
    baseDuration = Math.max(1, allLayerEnd, enabledContentEnd);
  } else if (isTalkSequence) {
    // Manual Talk duration is an intentional override, including when it is
    // shorter than a clip endpoint.
    baseDuration = Math.max(1, timeline.duration);
  } else {
    baseDuration = Math.max(1, timeline.duration, selectedLayerEnd, authoredContentEnd);
  }
  const talkTail = isTalkSequence && timeline.layers.some((layer) => layer.role === "character" && layer.enabled)
    ? Math.max(0, Math.min(2, Number.isFinite(talkMixDuration) ? talkMixDuration : 0))
    : 0;
  return baseDuration + talkTail;
}

/** Resolve an automatic opening's meaningful endpoint for both UIs. */
export function timelineOpeningDuration(
  timeline: Pick<SpineTimeline, "layers" | "subtitles" | "audio"> & { colorLayers?: SpineTimelineColorLayer[]; openingMode?: SpineTimeline["openingMode"]; sceneDuration?: number },
  introDuration: number,
  layerEndFor: (layer: SpineTimelineLayer) => number = (layer) => layer.animationClips?.length ? Math.max(0, ...layer.animationClips.map((clip) => clip.end)) : layer.end,
): number {
  const character = timeline.layers.find((layer) => layer.role === "character");
  const hasAnimationClips = Array.isArray(character?.animationClips);
  const introStart = character
    ? Math.max(0, character.start)
    : timeline.openingMode === "scene-first" ? Math.max(0, timeline.sceneDuration ?? 0) : 0;
  const introEnd = hasAnimationClips ? 0 : introStart + (timeline.openingMode === "skip" ? 0 : Math.max(0, introDuration));
  const layerEnd = Math.max(0, ...timeline.layers.filter((layer) => layer.enabled).map(layerEndFor));
  const contentEnd = Math.max(0, ...timeline.subtitles.map((cue) => cue.end), ...timeline.audio.map((clip) => clip.end), ...(timeline.colorLayers ?? []).map(timelineColorLayerEnd));
  return Math.max(1, introEnd, layerEnd, contentEnd);
}

export interface SpineTimelineAdvance {
  time: number;
  finished: boolean;
}

/** Advance a timeline clock identically in the editor and published viewer. */
export function advanceSpineTimeline(currentTime: number, deltaSeconds: number, speed: number, duration: number, loop: boolean): SpineTimelineAdvance {
  const safeDuration = Math.max(0.01, duration);
  const next = Math.max(0, currentTime) + Math.max(0, deltaSeconds) * Math.max(0, speed);
  if (next < safeDuration) return { time: next, finished: false };
  if (loop) return { time: next % safeDuration, finished: false };
  return { time: safeDuration, finished: true };
}

/** Compute the deterministic sample clock shared by the editor and viewer. */
export function timelineLayerSampleTime(layer: Pick<SpineTimelineLayer, "start" | "animationOffset" | "loop" | "role">, currentTime: number, sequenceId: string, openingMode: SpineTimeline["openingMode"], introDuration: number, animationDuration: number): number {
  const openingCharacter = sequenceId === "opening" && layer.role === "character";
  const useIntro = openingCharacter && openingMode !== "skip" && currentTime >= layer.start && currentTime - layer.start < introDuration;
  const elapsed = Math.max(0, currentTime - layer.start);
  if (useIntro) return elapsed;
  const value = (openingCharacter ? Math.max(0, elapsed - introDuration) : elapsed) + layer.animationOffset;
  if (!animationDuration) return value;
  return layer.loop ? value % animationDuration : Math.min(value, animationDuration);
}

/** Resolve the visible endpoint used by both timeline previews. */
export function timelineLayerPlaybackEnd(layer: Pick<SpineTimelineLayer, "start" | "end" | "endMode" | "loop" | "animationOffset">, animationDuration: number): number {
  if (layer.loop || layer.endMode === "manual" || !Number.isFinite(animationDuration) || animationDuration <= 0) return layer.end;
  return Math.max(layer.start + 0.01, layer.start + Math.max(0.01, animationDuration - Math.max(0, layer.animationOffset)));
}

export function timelineAnimationClipPlaybackEnd(clip: Pick<SpineTimelineAnimationClip, "start" | "end" | "endMode" | "loop" | "animationOffset">, animationDuration: number): number {
  if (clip.loop || clip.endMode === "manual" || !Number.isFinite(animationDuration) || animationDuration <= 0) return clip.end;
  return Math.max(clip.start + 0.01, clip.start + Math.max(0.01, animationDuration - Math.max(0, clip.animationOffset)));
}

export function timelineAnimationClipSampleTime(clip: Pick<SpineTimelineAnimationClip, "start" | "animationOffset" | "loop">, currentTime: number, animationDuration: number, forceLoop = false): number {
  const elapsed = Math.max(0, currentTime - clip.start) + clip.animationOffset;
  if (!animationDuration) return elapsed;
  return forceLoop || clip.loop ? elapsed % animationDuration : Math.min(elapsed, animationDuration);
}

function fallbackAnimation(layer: SpineTimelineLayer, meta: Pick<SpineMeta, "animations" | "idleAnimation">): string {
  return layer.animation || timelineIdleAnimation(meta);
}

/** Return authored clips, or a virtual equivalent for older single-animation timelines. */
export function timelineLayerAnimationClips(
  layer: SpineTimelineLayer,
  meta: Pick<SpineMeta, "animations" | "introAnimation" | "idleAnimation"> | null,
  sequenceId: string,
  openingMode: SpineTimeline["openingMode"],
  introDuration: number,
): SpineTimelineAnimationClip[] {
  if (Array.isArray(layer.animationClips)) return [...layer.animationClips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const fallback = meta ? fallbackAnimation(layer, meta) : layer.animation;
  if (sequenceId === "opening" && layer.role === "character") {
    const intro = openingMode !== "skip" ? meta?.introAnimation ?? "" : "";
    if (intro && introDuration > 0) {
      const introEnd = layer.start + introDuration;
      return [
        { id: `${layer.id}-legacy-intro`, animation: intro, start: layer.start, end: introEnd, endMode: "auto", animationOffset: 0, loop: false },
        { id: `${layer.id}-legacy-idle`, animation: fallback, start: introEnd, end: Math.max(introEnd + 0.01, layer.end), endMode: "auto", animationOffset: layer.animationOffset, loop: layer.loop, continueAfterOpening: true },
      ];
    }
    return [{ id: `${layer.id}-legacy-opening`, animation: fallback, start: layer.start, end: Math.max(layer.start + 0.01, layer.end), endMode: layer.endMode, animationOffset: layer.animationOffset, loop: layer.loop, continueAfterOpening: true }];
  }
  return [{ id: `${layer.id}-legacy`, animation: fallback, start: layer.start, end: Math.max(layer.start + 0.01, layer.end), endMode: layer.endMode, animationOffset: layer.animationOffset, loop: layer.loop }];
}

/** Find the active clip on a layer; later-starting clips win if ranges overlap. */
export function timelineActiveAnimationClip(
  layer: SpineTimelineLayer,
  meta: Pick<SpineMeta, "animations" | "introAnimation" | "idleAnimation"> | null,
  currentTime: number,
  sequenceId: string,
  openingMode: SpineTimeline["openingMode"],
  introDuration: number,
  continueAfterOpening = false,
): SpineTimelineAnimationClip | null {
  const clips = timelineLayerAnimationClips(layer, meta, sequenceId, openingMode, introDuration);
  if (continueAfterOpening && sequenceId === "opening") {
    const continuation = clips.filter((clip) => clip.enabled !== false && clip.continueAfterOpening && currentTime >= clip.start)
      .sort((a, b) => b.start - a.start)[0];
    if (continuation) return continuation;
  }
  return clips.filter((clip) => clip.enabled !== false && currentTime >= clip.start && currentTime < clip.end)
    .sort((a, b) => b.start - a.start)[0] ?? null;
}

/** Scene-track clip metadata controls whether the character is visible alongside it. */
export function timelineSceneHidesCharacter(timeline: Pick<SpineTimeline, "layers">, currentTime: number): boolean {
  return timeline.layers.some((layer) => layer.role === "scene" && layer.enabled
    && timelineActiveAnimationClip(layer, null, currentTime, "opening", "direct", 0)?.hideCharacter === true);
}

export function timelineOpeningContinuationStart(timeline: SpineTimeline, layer: SpineTimelineLayer, meta: Pick<SpineMeta, "animations" | "introAnimation" | "idleAnimation"> | null, introDuration: number): number {
  const clips = timelineLayerAnimationClips(layer, meta, timeline.sequenceId, timeline.openingMode, introDuration);
  return clips.filter((clip) => clip.enabled !== false && clip.continueAfterOpening).sort((a, b) => b.start - a.start)[0]?.start
    ?? layer.start + (timeline.openingMode === "skip" ? 0 : introDuration);
}

/** Talk tracks retain the character's idle body underneath the authored motion. */
export function timelineAnimationNeedsIdleUnderlay(animation: string): boolean {
  return /^talk/i.test(animation);
}

function exactAnimation(animations: readonly string[], requested: string): string | null {
  if (!requested) return null;
  return animations.find((name) => name.toLocaleLowerCase() === requested.toLocaleLowerCase()) ?? null;
}

/** Resolve the animation used by a timeline layer in both the editor and viewer. */
export function timelineLayerAnimation(layer: SpineTimelineLayer, meta: Pick<SpineMeta, "animations" | "introAnimation" | "idleAnimation">, mainAnimation: string | undefined, currentTime: number, sequenceId: string, openingMode: SpineTimeline["openingMode"], introDuration: number, continueAfterOpening = false, forceIdle = false): string {
  if (forceIdle && layer.role === "character") return timelineIdleAnimation(meta);
  const activeClip = timelineActiveAnimationClip(layer, meta, currentTime, sequenceId, openingMode, introDuration, continueAfterOpening);
  const clipDriven = Array.isArray(layer.animationClips);
  const fallback = fallbackAnimation(layer, meta);
  if (clipDriven) {
    if (!activeClip) return "";
    return (layer.followMainAnimation && mainAnimation ? exactAnimation(meta.animations, mainAnimation) : null)
      ?? exactAnimation(meta.animations, activeClip.animation)
      ?? fallback;
  }
  const openingCharacter = sequenceId === "opening" && layer.role === "character";
  const useIntro = openingCharacter && openingMode !== "skip" && Boolean(meta.introAnimation) && currentTime >= layer.start && currentTime - layer.start < introDuration;
  const followed = layer.followMainAnimation && mainAnimation ? exactAnimation(meta.animations, mainAnimation) : null;
  if (followed) return followed;
  if (useIntro && meta.introAnimation) return exactAnimation(meta.animations, meta.introAnimation) ?? fallback;
  return fallback;
}

export interface TimelineMainAnimationState {
  animation: string;
  time: number;
  loop: boolean;
  useIntro: boolean;
}

/** Resolve the main character animation and clock shared by all following layers. */
export function timelineMainAnimation(layer: SpineTimelineLayer, meta: Pick<SpineMeta, "animations" | "introAnimation" | "idleAnimation">, currentTime: number, sequenceId: string, openingMode: SpineTimeline["openingMode"], introDuration: number, animationDuration: number, continueAfterOpening = false): TimelineMainAnimationState {
  const clipDriven = Array.isArray(layer.animationClips);
  if (clipDriven) {
    const clip = timelineActiveAnimationClip(layer, meta, currentTime, sequenceId, openingMode, introDuration, continueAfterOpening);
    if (clip) {
      const time = timelineAnimationClipSampleTime(clip, currentTime, animationDuration, continueAfterOpening && clip.continueAfterOpening === true);
      const talkCharacter = sequenceId.startsWith("talk-") && layer.role === "character" && layer.endMode !== "manual";
      return { animation: clip.animation || fallbackAnimation(layer, meta), time, loop: continueAfterOpening && clip.continueAfterOpening ? true : talkCharacter ? false : clip.loop, useIntro: false };
    }
    return { animation: "", time: 0, loop: false, useIntro: false };
  }
  const openingCharacter = sequenceId === "opening" && layer.role === "character";
  const useIntro = openingCharacter && openingMode !== "skip" && Boolean(meta.introAnimation) && currentTime >= layer.start && currentTime - layer.start < introDuration;
  const animation = useIntro && meta.introAnimation ? meta.introAnimation : layer.animation || timelineIdleAnimation(meta);
  const talkCharacter = sequenceId.startsWith("talk-") && layer.role === "character" && layer.endMode !== "manual";
  return {
    animation,
    time: timelineLayerSampleTime(layer, currentTime, sequenceId, openingMode, introDuration, animationDuration),
    loop: talkCharacter ? false : layer.loop,
    useIntro,
  };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback));
}

function timelineRole(value: unknown): SpineTimelineLayerRole {
  return value === "scene" || value === "background" || value === "overlay" ? value : "character";
}

function timelineLanguage(value: unknown): SpineTimelineLanguage {
  return value === "ja" || value === "ko" ? value : "en";
}

function timelineText(value: unknown): Record<SpineTimelineLanguage, string> {
  if (!value || typeof value !== "object") return { en: "", ja: "", ko: "" };
  const text = value as Record<string, unknown>;
  const read = (...keys: string[]) => keys.map((key) => text[key]).find((item): item is string => typeof item === "string") ?? "";
  return { en: read("en", "EN"), ja: read("ja", "JA", "JR"), ko: read("ko", "KO", "KR") };
}

function normalizeLayer(value: unknown, index: number, duration: number): SpineTimelineLayer | null {
  if (!value || typeof value !== "object") return null;
  const layer = value as Partial<SpineTimelineLayer>;
  const directory = stringValue(layer.directory);
  if (!directory) return null;
  const start = nonNegative(layer.start, 0);
  const role = timelineRole(layer.role);
  return {
    id: stringValue(layer.id, `timeline-layer-${index + 1}`),
    name: stringValue(layer.name, directory),
    role,
    directory,
    enabled: layer.enabled !== false,
    locked: layer.locked === true,
    blendMode: layer.blendMode === "multiply" || layer.blendMode === "screen" || layer.blendMode === "additive" ? layer.blendMode : "normal",
    animation: stringValue(layer.animation),
    ...(typeof layer.faceAnimation === "string" ? { faceAnimation: layer.faceAnimation } : {}),
    ...(Array.isArray(layer.animationClips) ? { animationClips: layer.animationClips.map((value, clipIndex) => normalizeAnimationClip(value, index, clipIndex)).filter((clip): clip is SpineTimelineAnimationClip => clip !== null) } : {}),
    followMainAnimation: layer.followMainAnimation === undefined ? role === "background" : layer.followMainAnimation === true,
    start,
    end: Math.max(start + 0.01, finiteNumber(layer.end, duration)),
    ...(layer.endMode === "manual" ? { endMode: "manual" as const } : layer.endMode === "auto" ? { endMode: "auto" as const } : {}),
    animationOffset: nonNegative(layer.animationOffset, 0),
    loop: layer.loop !== false,
    x: finiteNumber(layer.x, 0),
    y: finiteNumber(layer.y, 0),
    scale: Math.max(0.01, finiteNumber(layer.scale, 1)),
    opacity: Math.max(0, Math.min(1, finiteNumber(layer.opacity, 1))),
    order: Math.max(0, finiteNumber(layer.order, index)),
  };
}

function normalizeAnimationClip(value: unknown, layerIndex: number, clipIndex: number): SpineTimelineAnimationClip | null {
  if (!value || typeof value !== "object") return null;
  const clip = value as Partial<SpineTimelineAnimationClip>;
  const start = nonNegative(clip.start, 0);
  return {
    id: stringValue(clip.id, `timeline-layer-${layerIndex + 1}-clip-${clipIndex + 1}`),
    animation: stringValue(clip.animation),
    ...(typeof clip.faceAnimation === "string" ? { faceAnimation: clip.faceAnimation } : {}),
    start,
    end: Math.max(start + 0.01, finiteNumber(clip.end, start + 1)),
    ...(clip.endMode === "manual" ? { endMode: "manual" as const } : clip.endMode === "auto" ? { endMode: "auto" as const } : {}),
    animationOffset: nonNegative(clip.animationOffset, 0),
    loop: clip.loop === true,
    ...(typeof clip.enabled === "boolean" ? { enabled: clip.enabled } : {}),
    ...(typeof clip.continueAfterOpening === "boolean" ? { continueAfterOpening: clip.continueAfterOpening } : {}),
    ...(typeof clip.hideCharacter === "boolean" ? { hideCharacter: clip.hideCharacter } : {}),
  };
}

function normalizeSubtitle(value: unknown, index: number, duration: number): SpineTimelineSubtitle | null {
  if (!value || typeof value !== "object") return null;
  const cue = value as Partial<SpineTimelineSubtitle>;
  const start = Math.max(0, finiteNumber(cue.start, 0));
  return {
    id: stringValue(cue.id, `subtitle-${index + 1}`),
    start,
    end: Math.max(start + 0.01, finiteNumber(cue.end, Math.min(duration, start + 2))),
    enabled: cue.enabled !== false,
    text: timelineText(cue.text),
  };
}

function normalizeAudio(value: unknown, index: number, duration: number): SpineTimelineAudio | null {
  if (!value || typeof value !== "object") return null;
  const clip = value as Partial<SpineTimelineAudio>;
  const path = stringValue(clip.path);
  if (!path) return null;
  const start = Math.max(0, finiteNumber(clip.start, 0));
  return {
    id: stringValue(clip.id, `audio-${index + 1}`),
    name: stringValue(clip.name, path.split(/[\\/]/).pop() ?? path),
    path,
    start,
    end: Math.max(start + 0.01, finiteNumber(clip.end, Math.min(duration, start + 2))),
    enabled: clip.enabled !== false,
    volume: Math.max(0, Math.min(1, finiteNumber(clip.volume, 1))),
  };
}

function normalizeColorClip(value: unknown, layerIndex: number, clipIndex: number): SpineTimelineColorClip | null {
  if (!value || typeof value !== "object") return null;
  const clip = value as Partial<SpineTimelineColorClip>;
  const start = nonNegative(clip.start, 0);
  const end = Math.max(start + 0.01, finiteNumber(clip.end, start + 1));
  const rawColor = stringValue(clip.color, "#000000");
  const color = /^#[\da-f]{6}$/i.test(rawColor) ? rawColor.toUpperCase() : "#000000";
  return normalizeColorClipFades({
    id: stringValue(clip.id, `color-layer-${layerIndex + 1}-clip-${clipIndex + 1}`),
    name: stringValue(clip.name, "Color"),
    color,
    start,
    end,
    opacity: Math.max(0, Math.min(1, finiteNumber(clip.opacity, 1))),
    fadeIn: nonNegative(clip.fadeIn, 0),
    fadeOut: nonNegative(clip.fadeOut, 0),
    enabled: clip.enabled !== false,
  });
}

/** Normalize new color tracks while keeping legacy timeline JSON valid. */
export function normalizeSpineColorLayers(value: unknown): SpineTimelineColorLayer[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item, index) => {
    const layer = item as Partial<SpineTimelineColorLayer>;
    const blendMode = layer.blendMode === "multiply" || layer.blendMode === "screen" || layer.blendMode === "additive"
      ? layer.blendMode
      : "normal";
    return {
      id: stringValue(layer.id, `color-layer-${index + 1}`),
      name: stringValue(layer.name, `Color ${index + 1}`),
      enabled: layer.enabled !== false,
      locked: layer.locked === true,
      opacity: Math.max(0, Math.min(1, finiteNumber(layer.opacity, 1))),
      order: Math.max(0, finiteNumber(layer.order, index)),
      blendMode,
    clips: (Array.isArray(layer.clips) ? layer.clips : [])
        .map((clip, clipIndex) => normalizeColorClip(clip, index, clipIndex))
        .filter((clip): clip is SpineTimelineColorClip => clip !== null)
        .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        .reduce<SpineTimelineColorClip[]>((clips, clip) => {
          const previousEnd = clips.at(-1)?.end ?? 0;
          const start = Math.max(previousEnd, clip.start);
          const duration = clip.end - clip.start;
          clips.push(normalizeColorClipFades({ ...clip, start, end: start + duration }));
          return clips;
        }, []),
    };
  });
}

export function normalizeSpineTimeline(value: unknown): SpineTimeline | null {
  if (!value || typeof value !== "object") return null;
  const timeline = value as Partial<SpineTimeline>;
  const duration = Math.max(1, finiteNumber(timeline.duration, 12));
  return {
    sequenceId: stringValue(timeline.sequenceId, "legacy"),
    openingMode: timeline.openingMode === "scene-first" || timeline.openingMode === "skip" ? timeline.openingMode : "direct",
    sceneDuration: nonNegative(timeline.sceneDuration, 3),
    openingIdleDuration: nonNegative(timeline.openingIdleDuration, 3),
    durationMode: timeline.durationMode === "auto" ? "auto" : "manual",
    duration,
    loop: timeline.loop !== false,
    ...(typeof timeline.layersInitialized === "boolean" ? { layersInitialized: timeline.layersInitialized } : {}),
    ...(timeline.assetPaths && typeof timeline.assetPaths === "object" && !Array.isArray(timeline.assetPaths)
      ? { assetPaths: Object.fromEntries(Object.entries(timeline.assetPaths).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0)) }
      : {}),
    layers: (Array.isArray(timeline.layers) ? timeline.layers : [])
      .map((layer, index) => normalizeLayer(layer, index, duration))
      .filter((layer): layer is SpineTimelineLayer => layer !== null),
    colorLayers: normalizeSpineColorLayers(timeline.colorLayers),
    subtitles: (Array.isArray(timeline.subtitles) ? timeline.subtitles : [])
      .map((cue, index) => normalizeSubtitle(cue, index, duration))
      .filter((cue): cue is SpineTimelineSubtitle => cue !== null),
    audio: (Array.isArray(timeline.audio) ? timeline.audio : [])
      .map((clip, index) => normalizeAudio(clip, index, duration))
      .filter((clip): clip is SpineTimelineAudio => clip !== null),
    language: timelineLanguage(timeline.language),
    ...(timeline.camera ? { camera: normalizeSpineCameraTrack(timeline.camera, duration) ?? undefined } : {}),
  };
}
