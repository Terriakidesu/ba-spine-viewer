export type VideoRecordingMode = "opening-idle" | "idle-only";
export type VideoRecordingFormat = "webm" | "mp4";
export type VideoRecordingResolution = 720 | 1080;
export type VideoRecordingFrameRate = 30 | 60;

export interface VideoRecordingSettings {
  mode: VideoRecordingMode;
  idleLoops: number;
  resolution: VideoRecordingResolution;
  frameRate: VideoRecordingFrameRate;
  framing: "current" | "saved";
  includeAudio: boolean;
  includeSubtitles: boolean;
  format: VideoRecordingFormat;
}

export interface VideoRecordingPlan {
  mode: VideoRecordingMode;
  openingDuration: number;
  idleDuration: number;
  idleLoops: number;
  totalDuration: number;
}

export interface VideoRecordingProgress {
  phase: "opening" | "idle";
  elapsed: number;
  total: number;
  idleLoopsCompleted: number;
  fraction: number;
  finished: boolean;
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
  mode: VideoRecordingMode,
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

export function videoRecordingProgress(plan: VideoRecordingPlan, elapsedSeconds: number): VideoRecordingProgress {
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
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

export function videoRecordingDimensions(resolution: VideoRecordingResolution, aspectRatio: "16:9" | "4:3" | "1:1"): { width: number; height: number } {
  const height = resolution;
  const ratio = aspectRatio === "4:3" ? 4 / 3 : aspectRatio === "1:1" ? 1 : 16 / 9;
  const width = Math.round(height * ratio / 2) * 2;
  return { width, height };
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

/** Draw all visible Spine canvases/color layers and optional subtitle DOM into one output canvas. */
export function drawSpineStageFrame(
  context: CanvasRenderingContext2D,
  stageElement: HTMLElement,
  width: number,
  height: number,
  includeSubtitles: boolean,
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
    const subtitleRoot = stageElement.closest(".spine-stage-frame") ?? stageElement.parentElement ?? stageElement;
    for (const element of subtitleRoot.querySelectorAll<HTMLElement>(".spine-dialogue")) {
      drawSubtitle(context, element, stage, scale, offsetX, offsetY);
    }
  }
  return true;
}

export interface CanvasRecordingCapture {
  canvas: HTMLCanvasElement;
  stream: MediaStream;
  recorder: MediaRecorder;
  addAudioElement: (audio: HTMLMediaElement) => void;
  stopDrawing: () => void;
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
  const draw = () => drawSpineStageFrame(context, options.stage, options.width, options.height, options.includeSubtitles);
  if (!draw()) throw new Error("The Viewer stage is not ready to record.");
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
    draw();
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
