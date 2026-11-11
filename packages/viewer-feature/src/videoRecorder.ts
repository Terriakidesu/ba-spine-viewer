import { timelineForSequence, timelineSubtitleText, type SpineTimeline, type SpineTimelineProject } from "@ba-spine/spine-runtime/spine/spineTimeline";
import type { SpineCameraAspectRatio } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import { createLegacyCompositionSchedule } from "@ba-spine/spine-runtime/spine/spineCompositionMigration";
import type { SpineComposition } from "@ba-spine/spine-runtime/spine/spineComposition";

export type VideoRecordingMode = "full-sequence" | "opening-idle" | "idle-only";
export type VideoRecordingFormat = "webm" | "mp4";
export type VideoRecordingResolution = 720 | 1080 | 1440 | 2160;
export type VideoRecordingFrameRate = 30 | 60;
export type VideoRecordingQuality = "high" | "balanced" | "compact";

export const VIDEO_RECORDING_QUALITY_STORAGE_KEY = "ba-spine-viewer-video-quality";

export function normalizeVideoRecordingQuality(value: unknown): VideoRecordingQuality {
  return value === "high" || value === "compact" ? value : "balanced";
}

export function readVideoRecordingQuality(storage?: Pick<Storage, "getItem"> | null): VideoRecordingQuality {
  try {
    const target = storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage)
      : storage;
    return normalizeVideoRecordingQuality(target?.getItem(VIDEO_RECORDING_QUALITY_STORAGE_KEY));
  } catch {
    return "balanced";
  }
}

export function writeVideoRecordingQuality(value: unknown, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage)
      : storage;
    target?.setItem(VIDEO_RECORDING_QUALITY_STORAGE_KEY, normalizeVideoRecordingQuality(value));
  } catch {
    // Preferences are optional; a storage restriction must not interrupt exports.
  }
}

export interface VideoRecordingSettings {
  mode: VideoRecordingMode;
  idleLoops: number;
  includeOpening: boolean;
  talkSequenceIds: string[];
  initialIdleLoops: number;
  betweenTalkIdleSeconds: number;
  finalIdleLoops: number;
  resolution: VideoRecordingResolution;
  aspectRatio: SpineCameraAspectRatio;
  frameRate: VideoRecordingFrameRate;
  framing: "current" | "saved";
  includeAudio: boolean;
  includeSubtitles: boolean;
  format: VideoRecordingFormat;
  quality: VideoRecordingQuality;
}

export interface VideoRecordingPlan {
  mode: VideoRecordingMode;
  openingDuration: number;
  idleDuration: number;
  idleLoops: number;
  totalDuration: number;
  segments?: VideoRecordingSegment[];
}

export interface VideoRecordingSegment {
  kind: "composition" | "opening" | "initial-idle" | "between-idle" | "talk" | "final-idle" | "idle";
  duration: number;
  sequenceId?: string;
  talkNumber?: number;
  talkCount?: number;
}

/** Export the canonical composition's authored range without rebuilding a legacy arrangement. */
export function createUnifiedCompositionRecordingPlan(duration: number): VideoRecordingPlan {
  const safeDuration = Number.isFinite(duration) ? Math.max(0.01, duration) : 0.01;
  return {
    mode: "full-sequence",
    openingDuration: safeDuration,
    idleDuration: 0.01,
    idleLoops: 1,
    totalDuration: safeDuration,
    segments: [{ kind: "composition", sequenceId: "__unified-composition__", duration: safeDuration }],
  };
}

export interface VideoRecordingTimelineOffset {
  timeline: SpineTimeline;
  start: number;
  duration: number;
}

export interface VideoRecordingSubtitleSpan {
  id: string;
  text: string;
  start: number;
  end: number;
  row: number;
}

export interface VideoRecordingAudioSchedule {
  start: number;
  duration: number;
  volume: number;
  sourceOffset: number;
}

export interface VideoRecordingProgress {
  phase: "opening" | "idle" | "talk" | "final-idle";
  elapsed: number;
  total: number;
  idleLoopsCompleted: number;
  fraction: number;
  finished: boolean;
  segmentIndex?: number;
  segment?: VideoRecordingSegment;
  segmentElapsed?: number;
}

export interface SupportedVideoFormat {
  format: VideoRecordingFormat;
  mimeType: string;
}

interface MediaRecorderSupport {
  isTypeSupported?: (mimeType: string) => boolean;
}

interface SharedMediaAudioSource {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

let sharedAudioContext: AudioContext | null = null;
const sharedMediaAudioSources = new WeakMap<HTMLMediaElement, SharedMediaAudioSource>();

const MIME_CANDIDATES: Record<VideoRecordingFormat, readonly string[]> = {
  webm: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
  mp4: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E", "video/mp4"],
};

export function detectSupportedVideoFormats(recorder: MediaRecorderSupport | null = typeof MediaRecorder === "undefined" ? null : MediaRecorder): SupportedVideoFormat[] {
  if (!recorder?.isTypeSupported) return [];
  const formats: SupportedVideoFormat[] = [];
  for (const format of ["webm", "mp4"] as const) {
    const mimeType = MIME_CANDIDATES[format].find((candidate) => {
      try {
        return recorder.isTypeSupported!(candidate);
      } catch {
        return false;
      }
    });
    if (mimeType) formats.push({ format, mimeType });
  }
  return formats;
}

export function createVideoRecordingPlan(
  mode: "opening-idle" | "idle-only",
  openingDuration: number,
  idleDuration: number,
  idleLoops: number,
): VideoRecordingPlan {
  const safeOpeningDuration = Number.isFinite(openingDuration) ? Math.max(0, openingDuration) : 0;
  const safeIdleDuration = Number.isFinite(idleDuration) ? Math.max(0.01, idleDuration) : 0.01;
  const safeIdleLoops = Math.max(1, Math.min(20, Math.floor(Number.isFinite(idleLoops) ? idleLoops : 3)));
  return {
    mode,
    openingDuration: safeOpeningDuration,
    idleDuration: safeIdleDuration,
    idleLoops: safeIdleLoops,
    totalDuration: safeIdleDuration * safeIdleLoops + (mode === "opening-idle" ? safeOpeningDuration : 0),
  };
}

/** Build a deterministic recording order for an opening, selected Talks, and a required final idle. */
export function createFullSequenceRecordingPlan(options: {
  openingDuration: number;
  idleDuration: number;
  openingSequenceId?: string | null;
  idleSequenceId?: string | null;
  includeOpening: boolean;
  initialIdleLoops: number;
  betweenTalkIdleSeconds: number;
  finalIdleLoops: number;
  talks: readonly { sequenceId: string; duration: number }[];
  selectedTalkSequenceIds: readonly string[];
}): VideoRecordingPlan {
  const openingDuration = Number.isFinite(options.openingDuration) ? Math.max(0, options.openingDuration) : 0;
  const idleDuration = Number.isFinite(options.idleDuration) ? Math.max(0.01, options.idleDuration) : 0.01;
  const safeLoops = (value: number) => Math.max(1, Math.min(20, Math.floor(Number.isFinite(value) ? value : 1)));
  const initialIdleLoops = safeLoops(options.initialIdleLoops);
  const finalIdleLoops = safeLoops(options.finalIdleLoops);
  const selected = new Set(options.selectedTalkSequenceIds);
  const talks = options.talks
    .filter((talk) => selected.has(talk.sequenceId) && Number.isFinite(talk.duration) && talk.duration > 0);
  const idleSequenceId = options.idleSequenceId ?? options.openingSequenceId ?? talks[0]?.sequenceId;
  const schedule = createLegacyCompositionSchedule({
    openingDuration,
    openingSequenceId: options.openingSequenceId,
    idleDuration,
    idleSequenceId,
    includeOpening: options.includeOpening,
    initialIdleLoops,
    betweenTalkIdleSeconds: options.betweenTalkIdleSeconds,
    finalIdleLoops,
    talks,
  });
  let talkNumber = 0;
  const segments: VideoRecordingSegment[] = schedule.map((entry) => {
    if (entry.kind === "talk") talkNumber += 1;
    return {
      kind: entry.kind as VideoRecordingSegment["kind"],
      ...(entry.sequenceId ? { sequenceId: entry.sequenceId } : {}),
      ...(entry.kind === "talk" ? { talkNumber, talkCount: talks.length } : {}),
      duration: entry.duration,
    };
  });
  return {
    mode: "full-sequence",
    openingDuration: options.includeOpening && options.openingSequenceId ? openingDuration : 0,
    idleDuration,
    idleLoops: finalIdleLoops,
    totalDuration: segments.reduce((total, segment) => total + segment.duration, 0),
    segments,
  };
}

/** Resolve the active segment and its local clock from the linear recording time. */
export function videoRecordingSegmentAt(plan: VideoRecordingPlan, elapsedSeconds: number): { index: number; segment: VideoRecordingSegment; elapsed: number } | null {
  const segments = plan.segments;
  if (!segments?.length) return null;
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  let start = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const end = start + segment.duration;
    if (elapsed < end || index === segments.length - 1) {
      return { index, segment, elapsed: Math.max(0, Math.min(segment.duration, elapsed - start)) };
    }
    start = end;
  }
  return null;
}

/** Stable start time for a plan segment, used to keep the visible export clock monotonic. */
export function videoRecordingSegmentStart(plan: VideoRecordingPlan, index: number): number {
  if (!plan.segments || !Number.isInteger(index) || index < 0 || index >= plan.segments.length) return 0;
  return plan.segments.slice(0, index).reduce((total, segment) => total + segment.duration, 0);
}

export function videoRecordingGlobalTime(plan: VideoRecordingPlan, index: number, segmentElapsed: number): number {
  const segment = plan.segments?.[index];
  if (!segment) return Math.max(0, Math.min(plan.totalDuration, Number.isFinite(segmentElapsed) ? segmentElapsed : 0));
  const local = Math.max(0, Math.min(segment.duration, Number.isFinite(segmentElapsed) ? segmentElapsed : 0));
  return Math.max(0, Math.min(plan.totalDuration, videoRecordingSegmentStart(plan, index) + local));
}

/** Map only Opening and Talk authored cues to the continuous Full sequence clock. */
export function videoRecordingTimelineOffsets(plan: VideoRecordingPlan, project: SpineTimelineProject): VideoRecordingTimelineOffset[] {
  if (!plan.segments) return [];
  const offsets: VideoRecordingTimelineOffset[] = [];
  let start = 0;
  for (const segment of plan.segments) {
    const duration = Math.max(0, Number.isFinite(segment.duration) ? segment.duration : 0);
    if ((segment.kind === "opening" || segment.kind === "talk") && segment.sequenceId) {
      const timeline = timelineForSequence(project, segment.sequenceId);
      if (timeline) offsets.push({ timeline, start, duration });
    }
    start += duration;
  }
  return offsets;
}

/** Resolve enabled subtitle cues onto the selected export plan's continuous clock. */
export function videoRecordingSubtitleSpans(plan: VideoRecordingPlan, project: SpineTimelineProject): VideoRecordingSubtitleSpan[] {
  if (!plan.segments || plan.totalDuration <= 0) return [];
  const spans = videoRecordingTimelineOffsets(plan, project).flatMap(({ timeline, start, duration }) => timeline.subtitles.flatMap((cue) => {
    if (!cue.enabled || duration <= 0) return [];
    const cueStart = Number.isFinite(cue.start) ? Math.max(0, cue.start) : 0;
    const cueEnd = Number.isFinite(cue.end) ? Math.max(0, cue.end) : 0;
    const localStart = Math.min(duration, cueStart);
    const localEnd = Math.min(duration, cueEnd);
    const text = timelineSubtitleText(cue, timeline.language).trim();
    if (localEnd <= localStart || !text) return [];
    return [{
      id: `${timeline.sequenceId}:${cue.id}:${start}`,
      text,
      start: start + localStart,
      end: start + localEnd,
    }];
  })).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));

  return stackVideoRecordingSubtitleSpans(spans);
}

/** Resolve canonical composition subtitles onto its authored export range. */
export function videoRecordingCompositionSubtitleSpans(
  composition: SpineComposition,
  language: SpineTimeline["language"],
): VideoRecordingSubtitleSpan[] {
  const spans = composition.subtitles.flatMap((cue) => {
    if (!cue.enabled) return [];
    const start = Math.max(0, cue.start);
    const end = Math.min(composition.duration, cue.end);
    const text = cue.text[language]?.trim() ?? "";
    if (end <= start || !text) return [];
    return [{ id: `${composition.id}:${cue.id}`, text, start, end }];
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  return stackVideoRecordingSubtitleSpans(spans);
}

function stackVideoRecordingSubtitleSpans(spans: Omit<VideoRecordingSubtitleSpan, "row">[]): VideoRecordingSubtitleSpan[] {
  const rowEnds: number[] = [];
  return spans.map((span) => {
    let row = rowEnds.findIndex((end) => end <= span.start);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = span.end;
    return { ...span, row };
  });
}

export function videoRecordingProgress(plan: VideoRecordingPlan, elapsedSeconds: number): VideoRecordingProgress {
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  if (plan.segments?.length) {
    const active = videoRecordingSegmentAt(plan, elapsed);
    const boundedElapsed = Math.min(plan.totalDuration, elapsed);
    const segment = active?.segment;
    const phase = segment?.kind === "opening" || segment?.kind === "composition" ? "opening"
      : segment?.kind === "talk" ? "talk"
        : segment?.kind === "final-idle" ? "final-idle"
          : "idle";
    const loopsCompleted = segment && (segment.kind === "initial-idle" || segment.kind === "final-idle")
      ? Math.min(segment.kind === "final-idle" ? plan.idleLoops : 20, Math.floor((active?.elapsed ?? 0) / plan.idleDuration))
      : 0;
    return {
      phase,
      elapsed: boundedElapsed,
      total: plan.totalDuration,
      idleLoopsCompleted: loopsCompleted,
      fraction: plan.totalDuration > 0 ? Math.min(1, elapsed / plan.totalDuration) : 1,
      finished: elapsed >= plan.totalDuration,
      ...(active ? { segmentIndex: active.index, segment: active.segment, segmentElapsed: active.elapsed } : {}),
    };
  }
  const idleElapsed = Math.max(0, elapsed - (plan.mode === "opening-idle" ? plan.openingDuration : 0));
  const idleLoopsCompleted = Math.min(plan.idleLoops, Math.floor(idleElapsed / plan.idleDuration));
  return {
    phase: plan.mode === "opening-idle" && elapsed < plan.openingDuration ? "opening" : "idle",
    elapsed: Math.min(plan.totalDuration, elapsed),
    total: plan.totalDuration,
    idleLoopsCompleted,
    fraction: plan.totalDuration > 0 ? Math.min(1, elapsed / plan.totalDuration) : 1,
    finished: elapsed >= plan.totalDuration,
  };
}

export function videoRecordingDimensions(resolution: VideoRecordingResolution, aspectRatio: "16:9" | "4:3"): { width: number; height: number } {
  const height = resolution;
  const ratio = aspectRatio === "4:3" ? 4 / 3 : 16 / 9;
  const width = Math.round(height * ratio / 2) * 2;
  return { width, height };
}

/** Extra backing scale after device-pixel ratio so Spine canvases match the export pixel density. */
export function videoRecordingResolutionScale(
  stageWidth: number,
  stageHeight: number,
  outputWidth: number,
  outputHeight: number,
  devicePixelRatio: number,
): number {
  if (![stageWidth, stageHeight, outputWidth, outputHeight].every(Number.isFinite)
    || stageWidth <= 0 || stageHeight <= 0 || outputWidth <= 0 || outputHeight <= 0) return 1;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const outputScale = Math.min(outputWidth / stageWidth, outputHeight / stageHeight);
  return Math.max(1, outputScale / dpr);
}

export function videoFilenameStem(value: string): string {
  const normalized = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return normalized.slice(0, 100) || "spine-recording";
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function wrapSubtitleLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = words[0] ?? "";
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (context.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawSubtitle(context: CanvasRenderingContext2D, element: HTMLElement, stage: DOMRect, scale: number, offsetX: number, offsetY: number) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) return;
  const rect = element.getBoundingClientRect();
  const x = offsetX + (rect.left - stage.left) * scale;
  const y = offsetY + (rect.top - stage.top) * scale;
  const width = rect.width * scale;
  const height = rect.height * scale;
  const opacity = Number.parseFloat(style.opacity) || 1;
  const paddingX = Number.parseFloat(style.paddingLeft) * scale || 0;
  const paddingY = Number.parseFloat(style.paddingTop) * scale || 0;
  const fontSize = Number.parseFloat(style.fontSize) * scale || 14 * scale;
  const lineHeightValue = Number.parseFloat(style.lineHeight);
  const lineHeight = (Number.isFinite(lineHeightValue) ? lineHeightValue : Number.parseFloat(style.fontSize) * 1.45) * scale;
  const radius = (Number.parseFloat(style.borderTopLeftRadius) || 0) * scale;

  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = style.backgroundColor;
  roundedRect(context, x, y, width, height, radius);
  context.fill();
  const borderWidth = Number.parseFloat(style.borderTopWidth) * scale || 0;
  if (borderWidth > 0) {
    context.strokeStyle = style.borderTopColor;
    context.lineWidth = borderWidth;
    roundedRect(context, x + borderWidth / 2, y + borderWidth / 2, width - borderWidth, height - borderWidth, radius);
    context.stroke();
  }

  const fontWeight = style.fontWeight || "400";
  const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? `${style.fontStyle} ` : "";
  context.font = `${fontStyle}${fontWeight} ${fontSize}px ${style.fontFamily || "sans-serif"}`;
  context.textAlign = style.textAlign === "left" || style.textAlign === "right" ? style.textAlign : "center";
  context.textBaseline = "middle";
  context.fillStyle = style.color;
  const text = element.innerText || element.textContent || "";
  const lines = wrapSubtitleLines(context, text, Math.max(1, width - paddingX * 2));
  const firstY = y + paddingY + Math.max(0, (height - paddingY * 2 - lineHeight * lines.length) / 2) + lineHeight / 2;
  const textX = context.textAlign === "left" ? x + paddingX : context.textAlign === "right" ? x + width - paddingX : x + width / 2;
  lines.forEach((line, index) => context.fillText(line, textX, firstY + index * lineHeight, Math.max(1, width - paddingX * 2)));
  context.restore();
}

interface StageFramePlan {
  subtitleRoot: Element;
}

export const VIDEO_RECORDING_SUBTITLE_SELECTOR = ".spine-dialogue, .spine-behavior-subtitle";

function createStageFramePlan(stageElement: HTMLElement): StageFramePlan {
  return {
    subtitleRoot: stageElement.closest(".spine-stage-frame") ?? stageElement.parentElement ?? stageElement,
  };
}

function drawStageFrame(
  context: CanvasRenderingContext2D,
  stageElement: HTMLElement,
  width: number,
  height: number,
  includeSubtitles: boolean,
  plan: StageFramePlan,
): boolean {
  const stage = stageElement.getBoundingClientRect();
  if (stage.width <= 0 || stage.height <= 0) return false;
  const scale = Math.min(width / stage.width, height / stage.height);
  const outputWidth = stage.width * scale;
  const outputHeight = stage.height * scale;
  const offsetX = (width - outputWidth) / 2;
  const offsetY = (height - outputHeight) / 2;
  const stageStyle = getComputedStyle(stageElement);
  context.save();
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "#102432";
  context.fillRect(0, 0, width, height);
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  context.beginPath();
  context.rect(0, 0, stage.width, stage.height);
  context.clip();
  context.fillStyle = stageStyle.backgroundColor || "#102432";
  context.fillRect(0, 0, stage.width, stage.height);

  const visual = stageElement.querySelector<HTMLElement>(".spine-visual-composition");
  if (visual) {
    const layers = [...visual.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element, index) => ({ element, index, z: Number.parseInt(getComputedStyle(element).zIndex, 10) || 0 }))
      .sort((a, b) => a.z - b.z || a.index - b.index);
    for (const { element } of layers) {
      const style = getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      if (style.display === "none" || style.visibility === "hidden" || opacity <= 0) continue;
      const rect = element.getBoundingClientRect();
      const x = rect.left - stage.left;
      const y = rect.top - stage.top;
      const blend = style.mixBlendMode === "multiply" || style.mixBlendMode === "screen" ? style.mixBlendMode : style.mixBlendMode === "plus-lighter" ? "lighter" : "source-over";
      context.globalAlpha = opacity;
      context.globalCompositeOperation = blend;
      if (element instanceof HTMLCanvasElement) context.drawImage(element, x, y, rect.width, rect.height);
      else {
        context.fillStyle = style.backgroundColor;
        context.fillRect(x, y, rect.width, rect.height);
      }
    }
  } else {
    const canvas = stageElement.querySelector<HTMLCanvasElement>("canvas");
    if (canvas) context.drawImage(canvas, 0, 0, stage.width, stage.height);
  }
  context.restore();

  if (includeSubtitles) {
    for (const element of plan.subtitleRoot.querySelectorAll<HTMLElement>(VIDEO_RECORDING_SUBTITLE_SELECTOR)) {
      drawSubtitle(context, element, stage, scale, offsetX, offsetY);
    }
  }
  return true;
}

/** Draw all visible Spine canvases/color layers and optional subtitle DOM into one output canvas. */
export function drawSpineStageFrame(
  context: CanvasRenderingContext2D,
  stageElement: HTMLElement,
  width: number,
  height: number,
  includeSubtitles: boolean,
): boolean {
  return drawStageFrame(context, stageElement, width, height, includeSubtitles, createStageFramePlan(stageElement));
}

function createStageFrameRenderer(stageElement: HTMLElement, width: number, height: number, includeSubtitles: boolean) {
  const plan = createStageFramePlan(stageElement);
  return (context: CanvasRenderingContext2D) => drawStageFrame(context, stageElement, width, height, includeSubtitles, plan);
}

export interface CanvasRecordingCapture {
  canvas: HTMLCanvasElement;
  stream: MediaStream;
  recorder: MediaRecorder;
  addAudioElement: (audio: HTMLMediaElement) => void;
  stopDrawing: () => void;
  stopTracks: () => void;
}

export interface CanvasFrameCapture {
  canvas: HTMLCanvasElement;
  captureFrame: () => Promise<Blob>;
}

export interface AudioRecordingCapture {
  recorder: MediaRecorder;
  mimeType: string;
  addAudioElement: (audio: HTMLMediaElement) => void;
  start: () => void;
  stop: () => Promise<Blob>;
  stopTracks: () => void;
}

function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== "closed") return sharedAudioContext;
  const AudioContextConstructor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  sharedAudioContext = new AudioContextConstructor();
  return sharedAudioContext;
}

/** The number of fixed-rate output frames due at a given elapsed time. */
export function videoFrameTargetCount(elapsedSeconds: number, frameRate: number, totalFrames: number): number {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(totalFrames) || totalFrames <= 0) return 0;
  return Math.min(Math.floor(totalFrames), Math.max(0, Math.floor(Math.max(0, elapsedSeconds) * frameRate) + 1));
}

/** Fixed output frame count; every frame is sampled at index / frameRate. */
export function videoRecordingFrameCount(totalDuration: number, frameRate: number): number {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) return 0;
  return Math.max(1, Math.ceil(totalDuration * frameRate - 1e-9));
}

/** Clip a source audio segment to the exported timeline without changing its authored start. */
export function videoRecordingAudioSchedule(start: number, end: number, volume: number, totalDuration: number, sourceOffset = 0): VideoRecordingAudioSchedule | null {
  if (![start, end, volume, totalDuration, sourceOffset].every(Number.isFinite) || totalDuration <= 0 || end <= start || sourceOffset < 0) return null;
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(totalDuration, end);
  if (safeEnd <= safeStart) return null;
  return {
    start: safeStart,
    duration: safeEnd - safeStart,
    volume: Math.max(0, Math.min(1, volume)),
    sourceOffset: sourceOffset + (safeStart - start),
  };
}

/** Capture one composited JPEG frame at a time for the native FFmpeg pipeline. */
export function createCanvasFrameCapture(options: {
  stage: HTMLElement;
  width: number;
  height: number;
  includeSubtitles: boolean;
}): CanvasFrameCapture {
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("The Viewer could not create a video capture canvas.");
  const draw = createStageFrameRenderer(options.stage, options.width, options.height, options.includeSubtitles);
  if (!draw(context)) throw new Error("The Viewer stage is not ready to record.");
  return {
    canvas,
    captureFrame: () => new Promise<Blob>((resolve, reject) => {
      if (!draw(context)) {
        reject(new Error("The Viewer stage is no longer ready to record."));
        return;
      }
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The Viewer could not encode a video frame.")), "image/jpeg", 0.86);
    }),
  };
}

/** Record the selected WebView audio mix separately so FFmpeg can mux it after video capture. */
export async function createAudioRecordingCapture(options: {
  includeAudio: boolean;
  audioElements: readonly HTMLMediaElement[];
}): Promise<AudioRecordingCapture | null> {
  if (!options.includeAudio) return null;
  if (typeof MediaRecorder === "undefined") throw new Error("Audio recording is not supported in this WebView.");
  const audioContext = getSharedAudioContext();
  if (!audioContext) {
    if (options.audioElements.some((audio) => Boolean(audio.currentSrc || audio.src))) throw new Error("This WebView cannot mix the selected audio sources.");
    return null;
  }

  const destination = audioContext.createMediaStreamDestination();
  const attachedAudioSources = new Set<SharedMediaAudioSource>();
  const addAudioElement = (audio: HTMLMediaElement) => {
    const existingSource = sharedMediaAudioSources.get(audio);
    if (existingSource && attachedAudioSources.has(existingSource)) return;
    if (!audio.currentSrc && !audio.src) return;
    let shared = existingSource;
    if (!shared) {
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioContext.destination);
      shared = { source, gain };
      sharedMediaAudioSources.set(audio, shared);
    }
    shared.gain.gain.value = audio.muted ? 0 : audio.volume;
    shared.gain.connect(destination);
    attachedAudioSources.add(shared);
  };

  try {
    options.audioElements.forEach(addAudioElement);
    await audioContext.resume();
  } catch (error) {
    for (const source of attachedAudioSources) source.gain.disconnect(destination);
    throw error;
  }

  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]
    .find((candidate) => {
      try { return MediaRecorder.isTypeSupported(candidate); }
      catch { return false; }
    });
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    destination.stream.getTracks().forEach((track) => track.stop());
    for (const source of attachedAudioSources) source.gain.disconnect(destination);
    throw error;
  }
  const chunks: Blob[] = [];
  let tracksStopped = false;
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  const actualMimeType = recorder.mimeType || mimeType || "audio/webm";
  return {
    recorder,
    mimeType: actualMimeType,
    addAudioElement,
    start: () => {
      if (recorder.state === "inactive") recorder.start(1000);
    },
    stop: () => new Promise<Blob>((resolve, reject) => {
      if (recorder.state === "inactive") {
        resolve(new Blob(chunks, { type: actualMimeType }));
        return;
      }
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: actualMimeType })), { once: true });
      recorder.addEventListener("error", (event) => reject((event as Event & { error?: DOMException }).error ?? new Error("The Viewer could not record audio.")), { once: true });
      try { recorder.stop(); }
      catch (error) { reject(error); }
    }),
    stopTracks: () => {
      if (tracksStopped) return;
      tracksStopped = true;
      destination.stream.getTracks().forEach((track) => track.stop());
      for (const source of attachedAudioSources) source.gain.disconnect(destination);
    },
  };
}

/** Create a real-time canvas recording and attach any capturable audio elements. */
export async function createCanvasRecordingCapture(options: {
  stage: HTMLElement;
  width: number;
  height: number;
  frameRate: number;
  includeAudio: boolean;
  includeSubtitles: boolean;
  audioElements: readonly HTMLMediaElement[];
  mimeType: string;
}): Promise<CanvasRecordingCapture> {
  if (typeof MediaRecorder === "undefined") throw new Error("Video recording is not supported in this WebView.");
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The Viewer could not create a video capture canvas.");
  const draw = createStageFrameRenderer(options.stage, options.width, options.height, options.includeSubtitles);
  if (!draw(context)) throw new Error("The Viewer stage is not ready to record.");
  const videoStream = canvas.captureStream(options.frameRate);
  const stream = new MediaStream(videoStream.getVideoTracks());
  const audioContext = options.includeAudio ? getSharedAudioContext() : null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  const attachedAudioSources = new Set<SharedMediaAudioSource>();
  const addAudioElement = (audio: HTMLMediaElement) => {
    if (!options.includeAudio) return;
    const existingSource = sharedMediaAudioSources.get(audio);
    if (existingSource && attachedAudioSources.has(existingSource)) return;
    if (!audio.currentSrc && !audio.src) return;
    if (!audioContext || !audioDestination) throw new Error("This WebView cannot mix the selected audio sources.");
    let shared = existingSource;
    if (!shared) {
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioContext.destination);
      shared = { source, gain };
      sharedMediaAudioSources.set(audio, shared);
    }
    shared.gain.gain.value = audio.muted ? 0 : audio.volume;
    shared.gain.connect(audioDestination);
    attachedAudioSources.add(shared);
  };
  if (options.includeAudio) {
    if (!audioContext) {
      videoStream.getTracks().forEach((track) => track.stop());
      if (options.audioElements.some((audio) => Boolean(audio.currentSrc || audio.src))) {
        throw new Error("This WebView cannot mix the selected audio sources.");
      }
    } else {
      audioDestination = audioContext.createMediaStreamDestination();
      try {
        options.audioElements.forEach(addAudioElement);
        for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
        await audioContext.resume();
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        for (const source of attachedAudioSources) source.gain.disconnect(audioDestination);
        throw error;
      }
    }
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: options.mimeType });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (audioDestination) {
      for (const source of attachedAudioSources) source.gain.disconnect(audioDestination);
    }
    throw error;
  }
  let frame = 0;
  const drawLoop = () => {
    draw(context);
    frame = requestAnimationFrame(drawLoop);
  };
  frame = requestAnimationFrame(drawLoop);
  return {
    canvas,
    stream,
    recorder,
    addAudioElement,
    stopDrawing: () => cancelAnimationFrame(frame),
    stopTracks: () => {
      stream.getTracks().forEach((track) => track.stop());
      if (audioDestination) {
        for (const source of attachedAudioSources) source.gain.disconnect(audioDestination);
      }
    },
  };
}
