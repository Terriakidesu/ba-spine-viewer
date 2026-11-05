import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconClose, IconCompress, IconDot, IconExpand, IconEye, IconEyeOff, IconFolder, IconHand, IconHelp, IconMessage, IconPause, IconPlay, IconRotate, IconSearch, IconSliders, IconStar, IconSync, IconTarget, IconUsers } from "@ba-spine/app-ui/icons";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { setLanguage, t, useLanguage, type LangKey } from "./i18n";
import { normalizeVoiceVolume, readViewerVoiceVolume, restoreViewerHandoffState, writeViewerVoiceVolume, type ViewerHandoffRestoreState, type ViewerReloadSnapshot } from "./handoffState";
import { acknowledgeDesktopHandoff, addDesktopFfmpegAudioTrack, cancelDesktopFfmpegVideoRecording, chooseDesktopSource, chooseDesktopSourceAt, chooseDesktopVideoDirectory, finishDesktopFfmpegVideoRecording, getDesktopFfmpegVideoStatus, getDesktopFfmpegVideoSupport, getDesktopFullscreen, isDesktopHost, loadDesktopSource, openDesktopFfmpegVideoStream, readDesktopDraftSnapshot, receiveDesktopHandoffs, saveDesktopVideo, sendDesktopHandoff, setDesktopFullscreen, startDesktopFfmpegVideoRecording, type DesktopAssetSource, type DesktopFfmpegVideoStream } from "./desktopSource";
import { libraryIdentityForPath, type SpineDraftSnapshot, type SpineHandoffMessage } from "@ba-spine/platform-contracts/handoff";
import {
  INTRO_ANIMATION,
  SpineRenderer,
  type SpineCameraMode,
  type SpineCameraPose,
  type SpineFiles,
  type SpineInteractionMode,
  type SpineInteractionOverlay,
  type SpineLoadProgress,
  type SpineMeta,
  type SpineProgress,
} from "@ba-spine/spine-runtime/spine/spineRuntime";
import { DEFAULT_TALK_MIX_DURATION, normalizeAnimationMixDuration, normalizeSpineInteractionProject, type SpineInteractionProject } from "@ba-spine/spine-runtime/spine/spineInteraction";
import { readLocalInteractionProject } from "@ba-spine/spine-runtime/spine/spineProject";
import characterIndexJson from "./characters.json";
import {
  sourceFromDirectory,
  sourceFromInput,
  indexedAssets,
  readCharacterIndex,
  type AssetSource,
  type CharacterIndex,
  type IndexedAsset,
} from "@ba-spine/spine-runtime/spine/spineAssets";
import { DEFAULT_EFFECTS_STRENGTH } from "@ba-spine/spine-runtime/spine/spineEffects";
import { EMPTY_VIEWER_NAVIGATION, matchesLibrarySearch, nextViewerListIndex, normalizeViewerNavigation, readViewerNavigation, recordRecentLobby, toggleViewerFavorite, writeViewerNavigation, type ViewerNavigationState } from "./viewerNavigation";
import { LobbyThumbnail } from "./lobbyThumbnail";
import { preloadSpineAudio, releasePreloadedSpineAudio, spineAudioPathCandidates, type PreloadedSpineAudio } from "@ba-spine/spine-runtime/spine/spineAudio";
import {
  dialogueForVoiceLine,
  introVoiceLineForCharacter,
  parseVoiceCatalog,
  parseVoiceCharacterFile,
  parseVoiceManifest,
  playableVoiceLines,
  voiceLineForLanguage,
  voiceLineIndexForAnimation,
  voiceCatalogEntryForDirectory,
  voiceCharacterForDirectory,
  type SpineVoiceCatalog,
  type SpineVoiceCharacter,
  type SpineVoiceManifest,
  type SpineVoiceLine,
} from "@ba-spine/spine-runtime/spine/spineVoicelines";
import { SpineCompositionViewport, type SpineCompositionViewportHandle } from "@ba-spine/spine-runtime/ui/SpineCompositionViewport";
import { timelineForSequence, timelinePlaybackDuration, timelineSequenceIds, timelineTalkInProgress, timelineTalkSequenceIds, type SpineTimeline } from "@ba-spine/spine-runtime/spine/spineTimeline";
import { readViewerAspectRatio, writeViewerAspectRatio, type ViewerAspectRatio } from "./viewerPresentation";
import { createCanvasFrameCapture, createCanvasRecordingCapture, createFullSequenceRecordingPlan, createVideoRecordingPlan, detectSupportedVideoFormats, videoFilenameStem, videoRecordingAudioSchedule, videoRecordingDimensions, videoRecordingFrameCount, videoRecordingProgress, videoRecordingResolutionScale, videoRecordingSegmentAt, type AudioRecordingCapture, type CanvasFrameCapture, type CanvasRecordingCapture, type SupportedVideoFormat, type VideoRecordingFormat, type VideoRecordingPlan, type VideoRecordingSettings } from "./videoRecorder";

type ViewerDraftPreview = Omit<SpineDraftSnapshot, "project"> & { project: SpineInteractionProject };

const bundledCharacterIndex = characterIndexJson as CharacterIndex;
const MAX_CONCURRENT_VOICE_PRELOADS = 4;

function projectTimelineDuration(timeline: SpineTimeline, project: SpineInteractionProject | null): number {
  const talkMix = normalizeAnimationMixDuration(project?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
  return timelinePlaybackDuration(timeline, 0, undefined, talkMix);
}

function fullSequenceRecordingPlan(
  project: SpineInteractionProject,
  settings: VideoRecordingSettings,
  metrics: { openingDuration: number; idleDuration: number },
): VideoRecordingPlan {
  const opening = timelineForSequence(project, "opening");
  const talks = timelineTalkSequenceIds(project).flatMap((sequenceId) => {
    const timeline = timelineForSequence(project, sequenceId);
    return timeline ? [{ sequenceId, duration: projectTimelineDuration(timeline, project) }] : [];
  });
  return createFullSequenceRecordingPlan({
    openingDuration: metrics.openingDuration,
    idleDuration: metrics.idleDuration,
    openingSequenceId: opening ? "opening" : null,
    idleSequenceId: opening ? "opening" : talks[0]?.sequenceId ?? null,
    includeOpening: settings.includeOpening,
    initialIdleLoops: settings.initialIdleLoops,
    betweenTalkIdleSeconds: settings.betweenTalkIdleSeconds,
    finalIdleLoops: settings.finalIdleLoops,
    talks,
    selectedTalkSequenceIds: settings.talkSequenceIds,
  });
}

function extraLabel(type: string): string {
  const key: LangKey | null = type === "alternate-home"
    ? "spine.extra.alternateHome"
    : type === "background"
      ? "spine.extra.background"
      : type === "multi-lobby"
        ? "spine.extra.multiLobby"
        : type === "scene"
          ? "spine.extra.scene"
          : null;
  return key ? t(key) : type;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
};

interface VideoWritableHandle {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
    abort?: () => Promise<void>;
  }>;
}

type VideoPickerWindow = DirectoryPickerWindow & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<VideoWritableHandle>;
};

function videoFileExtension(format: VideoRecordingFormat): ".webm" | ".mp4" {
  return format === "webm" ? ".webm" : ".mp4";
}

async function chooseVideoDestination(format: VideoRecordingFormat, name: string): Promise<VideoDestination | null> {
  const filename = `${videoFilenameStem(name)}${videoFileExtension(format)}`;
  if (isDesktopHost()) {
    const locationName = await chooseDesktopVideoDirectory();
    if (!locationName) return null;
    return { filename, locationName, save: (blob) => saveDesktopVideo(blob, filename, format) };
  }

  const picker = window as VideoPickerWindow;
  if (picker.showSaveFilePicker) {
    const handle = await picker.showSaveFilePicker.call(window, {
      suggestedName: filename,
      types: [{
        description: format === "webm" ? "WebM video" : "MP4 video",
        accept: { [format === "webm" ? "video/webm" : "video/mp4"]: [videoFileExtension(format)] },
      }],
    });
    return {
      filename,
      save: async (blob) => {
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => undefined);
          throw error;
        }
      },
    };
  }

  if (picker.showDirectoryPicker) {
    const directory = await picker.showDirectoryPicker.call(window);
    const uniqueName = `${videoFilenameStem(name)}-${crypto.randomUUID()}${videoFileExtension(format)}`;
    return {
      filename: uniqueName,
      locationName: directory.name,
      save: async (blob) => {
        const handle = await directory.getFileHandle(uniqueName, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => undefined);
          throw error;
        }
      },
    };
  }
  throw new Error("This browser does not provide a save-location picker for video exports.");
}

interface VideoDestination {
  filename: string;
  locationName?: string;
  save: (blob: Blob) => Promise<string | void>;
}

interface ViewerPlaybackSnapshot {
  sequenceId: string;
  progress: SpineProgress;
  playing: boolean;
  speed: number;
  loop: boolean;
  idleMode: "none" | "persistent" | "bridge";
  animation: string;
  animationSelectionOrigin: "automatic" | "explicit";
  skipIntro: boolean;
  cameraMode: SpineCameraMode;
  cameraPose: SpineCameraPose | null;
}

interface VideoRecordingRun {
  settings: VideoRecordingSettings;
  useFfmpeg: boolean;
  destination: VideoDestination;
  snapshot: ViewerPlaybackSnapshot;
  phase: "preparing" | "opening" | "idle" | "rendering" | "mixing" | "encoding" | "saving" | "stopping";
  plan: VideoRecordingPlan | null;
  recorder: MediaRecorder | null;
  capture: CanvasRecordingCapture | null;
  audioCapture: AudioRecordingCapture | null;
  desktopSessionId: string | null;
  desktopStream: DesktopFfmpegVideoStream | null;
  desktopFrameCapture: CanvasFrameCapture | null;
  desktopAudioTracks: Array<{ file: File; start: number; duration: number; volume: number; extension: string; sequenceId: string }>;
  runtimeSubtitleSegments: Array<{ start: number; end: number; clipIndex: number }>;
  lastRuntimeSubtitleClip: number | null;
  desktopFrameTask: Promise<void> | null;
  desktopFrameCount: number;
  desktopTotalFrames: number;
  renderStartedAt: number | null;
  exportStartedAt: number;
  outputWidth: number;
  outputHeight: number;
  chunks: Blob[];
  saveWhenStopped: boolean;
  stopRequested: boolean;
  preparationStarted: boolean;
  finalized: boolean;
  failureMessage?: string;
  idleStartedAt: number | null;
  startedAt: number | null;
  segmentIndex: number;
  segmentStartedAt: number | null;
  segmentTimelineStart: number;
  activeSequenceId: string | null;
  lastPreviewAt: number;
  lastUiUpdate: number;
  source: "composition" | "runtime";
}

interface VideoRecorderDialogState {
  phase: "settings" | "preparing" | "recording" | "rendering" | "mixing" | "encoding" | "saving" | "canceling" | "error" | "complete";
  settings: VideoRecordingSettings;
  elapsed: number;
  framesRendered?: number;
  totalFrames?: number;
  audioTracksMixed?: number;
  totalAudioTracks?: number;
  encodeProgress?: number;
  encoder?: string;
  encoderHardware?: boolean;
  encoderAttempt?: number;
  encoderAttempts?: number;
  encodedFrames?: number;
  totalEncodedFrames?: number;
  encodedTimeSeconds?: number;
  totalEncodeTimeSeconds?: number;
  encodeFps?: number;
  encodeSpeed?: number;
  encodeEtaSeconds?: number;
  renderFps?: number;
  renderEtaSeconds?: number;
  renderElapsedSeconds?: number;
  stageStartedAt?: number;
  stageElapsedSeconds?: number;
  totalStartedAt?: number;
  wallElapsedSeconds?: number;
  currentAudioTrack?: string;
  currentAudioSequence?: string;
  saveOperation?: "finalizing" | "copying" | "verifying";
  saveBytesCopied?: number;
  saveTotalBytes?: number;
  outputBytes?: number;
  outputWidth?: number;
  outputHeight?: number;
  outputFrameRate?: number;
  outputDurationSeconds?: number;
  savedLocation?: string;
  exportElapsedSeconds?: number;
  detail?: string;
  savedFileName?: string;
  error?: string;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : t("spine.error.unknown");
}


export interface SpineViewportHandle {
  resetCamera: () => void;
  setResolutionScale: (scale: number, includeLayerScale?: boolean) => void;
  toggleFullscreen: () => Promise<void>;
  setAnimation: (animation: string) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setLoop: (loop: boolean) => void;
  setCameraMode: (mode: SpineCameraMode) => void;
  getCameraPose: () => SpineCameraPose | null;
  setCameraPose: (pose: SpineCameraPose | null) => void;
  setInteractionMode: (mode: SpineInteractionMode) => void;
  setTalkAudioPending: (pending: boolean) => void;
  isTalkActive: () => boolean;
  triggerTalk: (animation?: string) => void;
  startIntroAudio: () => void;
  replayIntro: () => void;
  restartPlayback: () => void;
  seek: (time: number) => void;
  prepareRecordingPlayback: (includeOpening: boolean) => boolean;
  advanceRecordingFrame: (deltaSeconds: number) => boolean;
  getRecordingMetrics: () => { openingDuration: number; idleDuration: number; idleAnimation: string; introMarkers: number[]; ready: boolean };
}

interface SpineViewportProps {
  files: SpineFiles | null;
  directory: string;
  interactionProject: SpineInteractionProject | null;
  animation: string;
  playing: boolean;
  speed: number;
  loop: boolean;
  cameraMode: SpineCameraMode;
  interactionMode: SpineInteractionMode;
  skipIntro: boolean;
  showInteractionPoints: boolean;
  effectsStrength: number;
  preserveDrawingBuffer?: boolean;
  recordingMeta: SpineMeta | null;
  onMeta: (meta: SpineMeta | null) => void;
  onProgress: (progress: SpineProgress) => void;
  onLoading: (loading: boolean) => void;
  onLoadProgress: (progress: SpineLoadProgress) => void;
  onError: (error: Error | null) => void;
  onCameraMode: (mode: SpineCameraMode) => void;
  onTalk: (index: number, animation: string, eventCount: number) => boolean;
  onTalkClip: (index: number, clipIndex: number) => void;
  onIntro: (animation: string, eventCount: number) => boolean;
  onIntroClip: (clipIndex: number) => void;
}

const SpineViewport = forwardRef<SpineViewportHandle, SpineViewportProps>(function SpineViewport({
  files,
  directory,
  interactionProject,
  animation,
  playing,
  speed,
  loop,
  cameraMode,
  interactionMode,
  skipIntro,
  showInteractionPoints,
  effectsStrength,
  preserveDrawingBuffer = false,
  recordingMeta,
  onMeta,
  onProgress,
  onLoading,
  onLoadProgress,
  onError,
  onCameraMode,
  onTalk,
  onTalkClip,
  onIntro,
  onIntroClip,
}, ref) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineRenderer | null>(null);
  const resolutionScaleRef = useRef(1);
  const [interactionOverlay, setInteractionOverlay] = useState<SpineInteractionOverlay>({ canvasWidth: 0, canvasHeight: 0, points: [] });
  const callbacks = useRef({ onMeta, onProgress, onLoading, onLoadProgress, onError, onCameraMode, onTalk, onTalkClip, onIntro, onIntroClip });
  callbacks.current = { onMeta, onProgress, onLoading, onLoadProgress, onError, onCameraMode, onTalk, onTalkClip, onIntro, onIntroClip };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const renderer = new SpineRenderer(canvas, {
        onMeta: (meta) => {
          callbacks.current.onMeta(meta);
        },
        onProgress: (progress) => callbacks.current.onProgress(progress),
        onLoading: (loading) => callbacks.current.onLoading(loading),
        onLoadProgress: (progress) => callbacks.current.onLoadProgress(progress),
        onError: (error) => callbacks.current.onError(error),
        onCameraMode: (mode) => callbacks.current.onCameraMode(mode),
        onTalk: (index, animation, eventCount) => callbacks.current.onTalk(index, animation, eventCount),
        onTalkClip: (index, clipIndex) => callbacks.current.onTalkClip(index, clipIndex),
        onIntro: (animation, eventCount) => callbacks.current.onIntro(animation, eventCount),
        onIntroClip: (clipIndex) => callbacks.current.onIntroClip(clipIndex),
        onInteractionPoints: (overlay) => setInteractionOverlay(overlay),
      }, { preserveDrawingBuffer });
      renderer.setCameraMode(cameraMode);
      renderer.setInteractionMode(interactionMode);
      renderer.setResolutionScale(resolutionScaleRef.current);
      renderer.setSkipIntro(skipIntro);
      renderer.setEffectsStrength(effectsStrength);
      renderer.setShowInteractionPoints(showInteractionPoints);
      renderer.setPlaying(playing);
      renderer.setSpeed(speed);
      renderer.setLoop(loop);
      rendererRef.current = renderer;
      return () => {
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch (error) {
      callbacks.current.onError(new Error(errorMessage(error)));
    }
  }, [preserveDrawingBuffer]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setInteractionMode(interactionMode);
    renderer.setSkipIntro(skipIntro);
    if (files) void renderer.load(files, directory, interactionProject);
    else renderer.clear();
  }, [files, directory, interactionProject, preserveDrawingBuffer]);

  useEffect(() => rendererRef.current?.setAnimation(animation), [animation]);
  useEffect(() => rendererRef.current?.setPlaying(playing), [playing]);
  useEffect(() => rendererRef.current?.setSpeed(speed), [speed]);
  useEffect(() => rendererRef.current?.setLoop(loop), [loop]);
  useEffect(() => rendererRef.current?.setInteractionMode(interactionMode), [interactionMode]);
  useEffect(() => rendererRef.current?.setCameraMode(cameraMode), [cameraMode]);
  useEffect(() => rendererRef.current?.setSkipIntro(skipIntro), [skipIntro]);
  useEffect(() => rendererRef.current?.setEffectsStrength(effectsStrength), [effectsStrength]);
  useEffect(() => rendererRef.current?.setShowInteractionPoints(showInteractionPoints), [showInteractionPoints]);

  useImperativeHandle(ref, () => ({
    resetCamera: () => rendererRef.current?.resetCamera(),
    setResolutionScale: (scale) => {
      resolutionScaleRef.current = scale;
      rendererRef.current?.setResolutionScale(scale);
    },
    toggleFullscreen: async () => {
      const layout = stageRef.current?.closest<HTMLElement>(".spine-layout");
      if (layout && rendererRef.current) await rendererRef.current.toggleFullscreen(layout);
    },
    setAnimation: (value) => rendererRef.current?.setAnimation(value),
    setPlaying: (value) => rendererRef.current?.setPlaying(value),
    setSpeed: (value) => rendererRef.current?.setSpeed(value),
    setLoop: (value) => rendererRef.current?.setLoop(value),
    setCameraMode: (value) => rendererRef.current?.setCameraMode(value),
    getCameraPose: () => rendererRef.current?.getCameraPose() ?? null,
    setCameraPose: (value) => rendererRef.current?.setCameraPose(value),
    setInteractionMode: (value) => rendererRef.current?.setInteractionMode(value),
    setTalkAudioPending: (value) => rendererRef.current?.setTalkAudioPending(value),
    isTalkActive: () => rendererRef.current?.isTalkActive() ?? false,
    triggerTalk: (value) => rendererRef.current?.triggerTalk(value),
    startIntroAudio: () => rendererRef.current?.startIntroAudio(),
    replayIntro: () => rendererRef.current?.replayIntro(),
    restartPlayback: () => rendererRef.current?.restartPlayback(),
    seek: (value) => rendererRef.current?.seek(value),
    prepareRecordingPlayback: (includeOpening) => rendererRef.current?.prepareRecordingPlayback(includeOpening) ?? false,
    advanceRecordingFrame: (deltaSeconds) => rendererRef.current?.advanceRecordingFrame(deltaSeconds) ?? false,
    getRecordingMetrics: () => {
      const renderer = rendererRef.current;
       if (!renderer || !recordingMeta) return { openingDuration: 0, idleDuration: 0, idleAnimation: "", introMarkers: [], ready: false };
       const openingDuration = recordingMeta.introAnimation ? renderer.getEditorAnimationInfo(recordingMeta.introAnimation).duration : 0;
       const idleAnimation = recordingMeta.idleAnimation || "";
       const idleDuration = idleAnimation ? renderer.getEditorAnimationInfo(idleAnimation).duration : 0;
       const introMarkers = recordingMeta.introAnimation ? renderer.getEditorAnimationInfo(recordingMeta.introAnimation).markers : [];
       return { openingDuration, idleDuration, idleAnimation, introMarkers, ready: true };
    },
  }), [recordingMeta]);

  const overlayWidth = interactionOverlay.canvasWidth;
  const overlayHeight = interactionOverlay.canvasHeight;
  const colors = { pat: "#ff668f", pinch: "#28c7ed", touch: "#ffc857" } as const;
  return <div ref={stageRef} className={`spine-stage${interactionMode === "interaction" ? " spine-stage-interaction" : ""}`}>
    <canvas ref={canvasRef} aria-label={t("spine.stageAria")} />
    {showInteractionPoints && interactionOverlay.points.length > 0 && overlayWidth > 0 && overlayHeight > 0 && <svg className="spine-interaction-overlay" viewBox={`0 0 ${overlayWidth} ${overlayHeight}`} preserveAspectRatio="none" aria-hidden="true">
      {interactionOverlay.points.map((point, index) => {
        const color = colors[point.kind];
        const matrix = `matrix(${point.axisXEndX - point.centerX} ${point.axisXEndY - point.centerY} ${point.axisYEndX - point.centerX} ${point.axisYEndY - point.centerY} ${point.centerX} ${point.centerY})`;
        return <g key={`${point.kind}-${index}`} className={`spine-interaction-point spine-interaction-point-${point.kind}`}>
          {point.shape === "ellipse" ? <ellipse transform={matrix} cx="0" cy="0" rx="1" ry="1" fill={color} fillOpacity=".14" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /> : <rect transform={matrix} x="-1" y="-1" width="2" height="2" fill={color} fillOpacity=".14" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />}
          <circle cx={point.centerX} cy={point.centerY} r="7" fill={color} fillOpacity=".9" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <text x={point.centerX + 11} y={point.centerY - 10} fill={color} stroke="#10202d" strokeWidth="4" paintOrder="stroke" fontSize="18" fontWeight="700">{point.kind}</text>
        </g>;
      })}
    </svg>}
  </div>;
});

function formatSeconds(value: number) {
  return value.toFixed(2);
}

function formatRecorderDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  const totalSeconds = Math.ceil(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatRecorderBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

const RECORDING_AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"]);

function recordingAudioExtension(file: File): string | null {
  const extension = file.name.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  return RECORDING_AUDIO_EXTENSIONS.has(extension) ? extension : null;
}

async function loadRecordingAudioFile(source: AssetSource, path: string): Promise<File | null> {
  for (const candidate of spineAudioPathCandidates(path)) {
    try {
      const file = await source.getFile(candidate);
      if (file) return file;
    } catch {
      // Match Viewer playback's path fallback behavior for missing optional audio.
    }
  }
  return null;
}

interface VoiceSession {
  kind: "talk" | "intro";
  run: number;
  talkIndex: number;
  lineIndex: number;
  line: SpineVoiceLine;
  eventCount: number;
  started: Set<number>;
  files: Promise<Array<PreloadedSpineAudio | null>>;
}

function cachedVoiceAudio(
  cache: Map<string, Promise<PreloadedSpineAudio | null>>,
  source: AssetSource,
  path: string,
): Promise<PreloadedSpineAudio | null> {
  const current = cache.get(path);
  if (current) return current;
  const audioPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const rootedPath = /^audios\//i.test(audioPath) ? audioPath : `audios/voicelines/${audioPath}`;
  const pending = (async () => {
    for (const candidate of spineAudioPathCandidates(rootedPath)) {
      try {
        const file = await source.getFile(candidate);
        if (file) return preloadSpineAudio(file);
      } catch {
        // Try the remaining common path spellings.
      }
    }
    return null;
  })()
    .catch(() => null);
  cache.set(path, pending);
  return pending;
}

function voiceAnimationForLine(line: SpineVoiceLine): string | undefined {
  if (line.animation) return line.animation;
  const number = Number(line.id.match(/(\d+)$/)?.[1] ?? Number.NaN);
  return Number.isFinite(number) ? `Talk_${String(number).padStart(2, "0")}_M` : undefined;
}

function loadingLabel(progress: SpineLoadProgress | null, folderLoading: boolean): string {
  if (folderLoading) return t("spine.loading.folder");
  if (!progress) return t("spine.loading");
  switch (progress.stage) {
    case "files": return t("spine.loading.files");
    case "atlas": return t("spine.loading.atlas");
    case "textures": return t("spine.loading.textures", { loaded: progress.loaded, total: progress.total });
    case "skeleton": return t("spine.loading.skeleton");
    case "finalizing": return t("spine.loading.finalizing");
    case "audio": return t("spine.loading.audio", { loaded: progress.loaded, total: progress.total });
  }
}

export function Spine() {
  const language = useLanguage();
  const [characterIndex, setCharacterIndex] = useState<CharacterIndex>(bundledCharacterIndex);
  const characterNames = useMemo(() => Object.keys(characterIndex.characters).sort((a, b) => a.localeCompare(b)), [characterIndex]);
  const firstCharacter = characterNames[0] ?? "";
  const [selectedCharacter, setSelectedCharacter] = useState(firstCharacter);
  const [selectedDirectory, setSelectedDirectory] = useState(characterIndex.characters[firstCharacter]?.variants[0]?.directory ?? "");
  const [expandedCharacter, setExpandedCharacter] = useState(firstCharacter);
  const [selectedSequenceId, setSelectedSequenceId] = useState("");
  const [characterSearch, setCharacterSearch] = useState("");
  const [navigationLibraryIdentity, setNavigationLibraryIdentity] = useState("");
  const [navigation, setNavigation] = useState<ViewerNavigationState>(EMPTY_VIEWER_NAVIGATION);
  const [source, setSource] = useState<AssetSource | null>(null);
  const [availableDirectories, setAvailableDirectories] = useState<Set<string> | null>(null);
  const [libraryChangesAvailable, setLibraryChangesAvailable] = useState(false);
  const [libraryWatcherAvailable, setLibraryWatcherAvailable] = useState<boolean | null>(null);
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);
  const [setFiles, setSetFiles] = useState<SpineFiles | null>(null);
  const [localInteractionProject, setLocalInteractionProject] = useState<SpineInteractionProject | null>(null);
  const [draftPreview, setDraftPreview] = useState<ViewerDraftPreview | null>(null);
  const [draftPreviewNotice, setDraftPreviewNotice] = useState<string | null>(null);
  const [interactionProjectLoading, setInteractionProjectLoading] = useState(false);
  const [setLoading, setSetLoading] = useState(false);
  const [rendererLoading, setRendererLoading] = useState(false);
  const [rendererLoadProgress, setRendererLoadProgress] = useState<SpineLoadProgress | null>(null);
  const [compositionLoadProgress, setCompositionLoadProgress] = useState<SpineLoadProgress | null>(null);
  const [voiceAudioProgress, setVoiceAudioProgress] = useState({ loaded: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [meta, setMeta] = useState<SpineMeta | null>(null);
  const [animation, setAnimation] = useState("");
  const [animationSelectionOrigin, setAnimationSelectionOrigin] = useState<"automatic" | "explicit">("automatic");
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [cameraMode, setCameraMode] = useState<SpineCameraMode>("fit");
  const [aspectRatio, setAspectRatio] = useState<ViewerAspectRatio>(() => readViewerAspectRatio());
  const [interactionMode, setInteractionMode] = useState<SpineInteractionMode>("interaction");
  const [skipIntro, setSkipIntro] = useState(false);
  const [showInteractionPoints, setShowInteractionPoints] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(true);
  const [showFullscreenControlsHint, setShowFullscreenControlsHint] = useState(false);
  const [fullscreenClean, setFullscreenClean] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [effectsStrength, setEffectsStrength] = useState(DEFAULT_EFFECTS_STRENGTH);
  const [progress, setProgress] = useState<SpineProgress>({ time: 0, duration: 0, animation: null });
  const [fullscreen, setFullscreen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [voiceCatalog, setVoiceCatalog] = useState<SpineVoiceCatalog | null>(null);
  const [voiceManifest, setVoiceManifest] = useState<SpineVoiceManifest | null>(null);
  const [voiceCharacter, setVoiceCharacter] = useState<SpineVoiceCharacter | null>(null);
  const [voiceLineIndex, setVoiceLineIndex] = useState<number | null>(null);
  const [voiceClipIndex, setVoiceClipIndex] = useState(0);
  const [selectedVoiceLineIndex, setSelectedVoiceLineIndex] = useState<number | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceVolume, setVoiceVolume] = useState(readViewerVoiceVolume);
  const [showDialogue, setShowDialogue] = useState(true);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [talkAutoplay, setTalkAutoplay] = useState(false);
  const [idleMode, setIdleMode] = useState<"none" | "persistent" | "bridge">("none");
  const [videoRecorderFormats, setVideoRecorderFormats] = useState<SupportedVideoFormat[]>(() => detectSupportedVideoFormats());
  const [desktopFfmpegFormats, setDesktopFfmpegFormats] = useState<VideoRecordingFormat[]>([]);
  const [videoRecorderSettings, setVideoRecorderSettings] = useState<VideoRecordingSettings>(() => ({
    mode: "opening-idle",
    idleLoops: 3,
    includeOpening: true,
    talkSequenceIds: [],
    initialIdleLoops: 1,
    betweenTalkIdleSeconds: 0.5,
    finalIdleLoops: 1,
    resolution: 1080,
    frameRate: 30,
    framing: "current",
    includeAudio: true,
    includeSubtitles: true,
    format: videoRecorderFormats.some(({ format }) => format === "webm") ? "webm" : videoRecorderFormats[0]?.format ?? "webm",
  }));
  const [videoRecorderTalkSelectionInitialized, setVideoRecorderTalkSelectionInitialized] = useState(false);
  const [videoRecorderDialog, setVideoRecorderDialog] = useState<VideoRecorderDialogState | null>(null);
  const [videoRecorderPreviewUrl, setVideoRecorderPreviewUrl] = useState<string | null>(null);
  const videoRecorderDialogRef = useRef<VideoRecorderDialogState | null>(null);
  videoRecorderDialogRef.current = videoRecorderDialog;
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<SpineViewportHandle>(null);
  const compositionRef = useRef<SpineCompositionViewportHandle>(null);
  const stageFrameRef = useRef<HTMLDivElement>(null);
  const videoRecordingRunRef = useRef<VideoRecordingRun | null>(null);
  const pendingVideoRestoreRef = useRef<ViewerPlaybackSnapshot | null>(null);
  const videoRecorderPreviewUrlRef = useRef<string | null>(null);
  const videoRecorderCameraPoseRef = useRef<SpineCameraPose | null>(null);
  const fullscreenLayoutRef = useRef<HTMLDivElement>(null);
  const fullscreenControlsRef = useRef<HTMLDivElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioCacheRef = useRef(new Map<string, Promise<PreloadedSpineAudio | null>>());
  const voiceRunRef = useRef(0);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const pendingHandoffRef = useRef<SpineHandoffMessage | null>(null);
  const pendingHandoffRestoreRef = useRef<{ lobbyId: string; state: ViewerHandoffRestoreState } | null>(null);
  const draftPreviewRef = useRef(draftPreview);
  const viewerReloadStateRef = useRef<{ rootPath: string | null; lobbyId: string; snapshot: ViewerReloadSnapshot } | null>(null);
  const handledHandoffIdsRef = useRef(new Set<string>());
  const autoPlayTimerRef = useRef<number | null>(null);
  const fullscreenHideTimerRef = useRef<number | null>(null);
  const fullscreenControlsHintTimerRef = useRef<number | null>(null);
  const fullscreenControlsHintSeenRef = useRef(false);
  const talkAutoplayRef = useRef(false);
  const authoredTalkIndexRef = useRef(0);
  const stagePointer = useRef<{ x: number; y: number } | null>(null);
  const freePlaying = useRef(true);
  const freeLoop = useRef(true);
  const freeSpeed = useRef(1);
  const progressRef = useRef(progress);
  const navigationRootRef = useRef<string | null>(null);
  const fullscreenRef = useRef(fullscreen);
  draftPreviewRef.current = draftPreview;
  fullscreenRef.current = fullscreen;
  progressRef.current = progress;

  talkAutoplayRef.current = talkAutoplay;

  useEffect(() => {
    if (!videoRecorderDialog || !["preparing", "recording", "rendering", "mixing", "encoding", "saving", "canceling"].includes(videoRecorderDialog.phase)) return;
    const timer = window.setInterval(() => {
      setVideoRecorderDialog((current) => {
        if (!current || !["preparing", "recording", "rendering", "mixing", "encoding", "saving", "canceling"].includes(current.phase)) return current;
        const now = performance.now();
        return {
          ...current,
          stageElapsedSeconds: current.stageStartedAt === undefined ? current.stageElapsedSeconds : Math.max(0, (now - current.stageStartedAt) / 1000),
          wallElapsedSeconds: current.totalStartedAt === undefined ? current.wallElapsedSeconds : Math.max(0, (now - current.totalStartedAt) / 1000),
        };
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [videoRecorderDialog?.phase]);

  const startVideoRecorderStage = (phase: VideoRecorderDialogState["phase"], patch: Partial<VideoRecorderDialogState> = {}) => {
    const now = performance.now();
    setVideoRecorderDialog((current) => current ? {
      ...current,
      ...patch,
      phase,
      stageStartedAt: now,
      stageElapsedSeconds: 0,
    } : current);
  };

  const updateVideoRecorderPreview = (image: Blob) => {
    const next = URL.createObjectURL(image);
    const previous = videoRecorderPreviewUrlRef.current;
    videoRecorderPreviewUrlRef.current = next;
    setVideoRecorderPreviewUrl(next);
    if (previous) URL.revokeObjectURL(previous);
  };

  const clearVideoRecorderPreview = () => {
    const previous = videoRecorderPreviewUrlRef.current;
    videoRecorderPreviewUrlRef.current = null;
    setVideoRecorderPreviewUrl(null);
    if (previous) URL.revokeObjectURL(previous);
  };

  useEffect(() => () => {
    const previewUrl = videoRecorderPreviewUrlRef.current;
    videoRecorderPreviewUrlRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, []);

  useEffect(() => {
    if (videoRecorderFormats.length === 0 || videoRecorderFormats.some(({ format }) => format === videoRecorderSettings.format)) return;
    setVideoRecorderSettings((current) => ({ ...current, format: videoRecorderFormats[0]!.format }));
  }, [videoRecorderFormats, videoRecorderSettings.format]);

  useEffect(() => {
    let live = true;
    void getDesktopFfmpegVideoSupport().then((support) => {
      if (!live || !support) return;
      setDesktopFfmpegFormats(support.available ? support.formats : []);
      if (!support.available) return;
      setVideoRecorderFormats((current) => {
        const supported = new Map(current.map((format) => [format.format, format]));
        for (const format of support.formats) {
          if (!supported.has(format)) supported.set(format, { format, mimeType: format === "webm" ? "video/webm" : "video/mp4" });
        }
        return (["webm", "mp4"] as const).flatMap((format) => supported.has(format) ? [supported.get(format)!] : []);
      });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const sourceRootPath = source && "rootPath" in source && typeof source.rootPath === "string" ? source.rootPath : null;
  const navigationRootKey = sourceRootPath ?? (source ? "ephemeral-local-preview" : null);
  const desktopSource = source && "desktop" in source && source.desktop ? source as DesktopAssetSource : null;

  useEffect(() => {
    let live = true;
    void loadDesktopSource().then((desktopSource) => {
      if (!live || !desktopSource) return;
      setSource(desktopSource);
      setError(null);
    }).catch((reason: unknown) => {
      if (live) setError(t("spine.error.folder", { error: errorMessage(reason) }));
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    navigationRootRef.current = null;
    setNavigationLibraryIdentity("");
    setNavigation(EMPTY_VIEWER_NAVIGATION);
    if (!source || !navigationRootKey) return () => { live = false; };
    if (!sourceRootPath) {
      // Browser folder handles and file inputs have no trustworthy stable path identity.
      // Keep their navigation state in memory rather than sharing it across libraries.
      navigationRootRef.current = navigationRootKey;
      return () => { live = false; };
    }
    const identity = libraryIdentityForPath(sourceRootPath);
    void identity.then((key) => {
      if (!live) return;
      try { setNavigation(readViewerNavigation(localStorage, key)); }
      catch { setNavigation(EMPTY_VIEWER_NAVIGATION); }
      navigationRootRef.current = navigationRootKey;
      setNavigationLibraryIdentity(key);
    }).catch(() => {
      if (!live) return;
      navigationRootRef.current = navigationRootKey;
    });
    return () => { live = false; };
  }, [navigationRootKey, source, sourceRootPath]);

  useEffect(() => {
    if (navigationRootRef.current !== navigationRootKey || !availableDirectories) return;
    setNavigation((current) => normalizeViewerNavigation(current, availableDirectories));
  }, [availableDirectories, navigationLibraryIdentity, navigationRootKey]);

  useEffect(() => {
    if (!navigationLibraryIdentity || navigationRootRef.current !== navigationRootKey) return;
    try { writeViewerNavigation(localStorage, navigationLibraryIdentity, navigation); }
    catch { /* Preferences are a convenience; keep them for this session if storage is unavailable. */ }
  }, [navigation, navigationLibraryIdentity, navigationRootKey]);

  useEffect(() => {
    if (!isDesktopHost()) return;
    let live = true;
    let polling = false;
    const poll = async () => {
      if (!live || polling) return;
      polling = true;
      try {
        for (const message of await receiveDesktopHandoffs()) {
          if (!live) continue;
          if (handledHandoffIdsRef.current.has(message.requestId)) {
            await acknowledgeDesktopHandoff(message.requestId).catch(() => undefined);
            break;
          }
          try {
            const nextSource = await chooseDesktopSourceAt(message.library.path);
            if (await libraryIdentityForPath(nextSource.rootPath) !== message.library.identity) {
              throw new Error("The library identity does not match the handoff path.");
            }
            let incomingDraft: ViewerDraftPreview | null = null;
            if (message.draft) {
              const snapshot = await readDesktopDraftSnapshot(message.draft.sessionId);
              if (!snapshot
                || snapshot.sessionId !== message.draft.sessionId
                || snapshot.library.identity !== message.library.identity
                || snapshot.lobbyId !== message.lobbyId) {
                throw new Error("The unsaved draft preview session is stale or no longer available.");
              }
              if (snapshot.project.assetDirectory !== message.lobbyId) throw new Error("The unsaved draft targets a different lobby.");
              const project = normalizeSpineInteractionProject(snapshot.project, message.lobbyId);
              if (!project) throw new Error("The unsaved draft project is not valid for Viewer preview.");
              incomingDraft = { ...snapshot, project };
            }
            const [directories, nextIndex] = await Promise.all([
              nextSource.getDirectories(),
              readCharacterIndex(nextSource, bundledCharacterIndex),
            ]);
            if (!directories.includes(message.lobbyId)) throw new Error(`The received lobby “${message.lobbyId}” is not in the selected library.`);
            const character = Object.entries(nextIndex.characters)
              .find(([, info]) => indexedAssets(info).some((asset) => asset.directory === message.lobbyId));
            if (!character) throw new Error(`No character entry contains lobby “${message.lobbyId}”.`);

            const previous = viewerReloadStateRef.current;
            const currentIdentity = previous?.rootPath ? await libraryIdentityForPath(previous.rootPath) : null;
            const sameSelection = previous?.lobbyId === message.lobbyId && currentIdentity === message.library.identity;
            const previousSnapshot = previous ? {
              ...previous.snapshot,
              cameraPose: compositionRef.current?.getCameraPose() ?? viewportRef.current?.getCameraPose() ?? previous.snapshot.cameraPose,
            } : {
              language,
              cameraMode,
              cameraPose: null,
              voiceVolume,
              playing,
              loop,
              speed,
              playheadSeconds: progressRef.current.time,
              sequenceId: selectedSequenceId,
              animation,
            };
            const restored = restoreViewerHandoffState(previousSnapshot, message, sameSelection);
            pendingHandoffRef.current = {
              ...message,
              ...(restored.sequenceId ? { sequenceId: restored.sequenceId } : {}),
              ...(restored.playheadSeconds !== undefined ? { playheadSeconds: restored.playheadSeconds } : {}),
            };
            pendingHandoffRestoreRef.current = { lobbyId: message.lobbyId, state: restored };
            setInteractionProjectLoading(true);
            setCharacterIndex(nextIndex);
            setSelectedCharacter(character[0]);
            setSelectedDirectory(message.lobbyId);
            setAvailableDirectories(new Set(directories));
            setLocalInteractionProject(null);
            setDraftPreview(incomingDraft);
            setDraftPreviewNotice(null);
            setSetFiles(null);
            setSource(nextSource);
            setLanguage(restored.language);
            setCameraMode(restored.cameraMode);
            setVoiceVolume(restored.voiceVolume);
            setPlaying(restored.playing);
            setLoop(restored.loop);
            setSpeed(restored.speed);
            setError(null);
          } catch (reason) {
            if (live) setError(`Could not open the received lobby: ${errorMessage(reason)}`);
          } finally {
            handledHandoffIdsRef.current.add(message.requestId);
            await acknowledgeDesktopHandoff(message.requestId).catch(() => undefined);
          }
          break;
        }
      } catch (reason) {
        if (live) setError(`Companion handoff polling failed: ${errorMessage(reason)}`);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 800);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  // React's DOM typings do not expose the non-standard directory attribute,
  // and React may omit an unknown JSX prop. Set it on the actual input so the
  // fallback opens a directory chooser rather than a single-file chooser.
  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    let live = true;
    if (!source) {
      setCharacterIndex(bundledCharacterIndex);
      return () => { live = false; };
    }
    void readCharacterIndex(source, bundledCharacterIndex).then((index) => {
      if (live) setCharacterIndex(index);
    });
    return () => { live = false; };
  }, [source]);

  useEffect(() => {
    if (!characterIndex.characters[selectedCharacter]) {
      const nextCharacter = characterNames[0] ?? "";
      setSelectedCharacter(nextCharacter);
      setSelectedDirectory(characterIndex.characters[nextCharacter]?.variants[0]?.directory ?? "");
      setExpandedCharacter(nextCharacter);
      return;
    }
    const variants = indexedAssets(characterIndex.characters[selectedCharacter]);
    if (variants.some((variant) => variant.directory === selectedDirectory)) return;
    setSelectedDirectory(variants[0]?.directory ?? "");
  }, [characterIndex, characterNames, selectedCharacter, selectedDirectory]);

  useEffect(() => {
    let live = true;
    setVoiceCatalog(null);
    setVoiceManifest(null);
    setVoiceCharacter(null);
    if (!source) return () => { live = false; };
    const readJson = async (path: string): Promise<unknown | null> => {
      const file = await source.getFile(path);
      if (!file) return null;
      try {
        return JSON.parse(await file.text());
      } catch {
        return null;
      }
    };
    void Promise.all([
      readJson("audios/voicelines/index.json"),
      readJson("audios/voicelines/voicelines.json"),
    ]).then(([catalog, manifest]) => {
      if (!live) return;
      setVoiceCatalog(parseVoiceCatalog(catalog));
      setVoiceManifest(parseVoiceManifest(manifest));
    });
    return () => { live = false; };
  }, [source]);

  const allVariants = indexedAssets(characterIndex.characters[selectedCharacter]);
  const variants = source && availableDirectories
    ? allVariants.filter((variant) => availableDirectories.has(variant.directory))
    : [];
  const loadedCharacters = useMemo(() => {
    if (!source) return [];
    if (!availableDirectories) return [];
    return characterNames.filter((name) => indexedAssets(characterIndex.characters[name]).some((variant) => availableDirectories.has(variant.directory)));
  }, [availableDirectories, source]);
  const filteredCharacters = useMemo(() => {
    const query = characterSearch.trim();
    if (!query) return loadedCharacters;
    return loadedCharacters.filter((name) => {
      const fields = [name, ...indexedAssets(characterIndex.characters[name])
        .filter((asset) => !availableDirectories || availableDirectories.has(asset.directory))
        .flatMap((asset) => [asset.variant, asset.directory, asset.assetId, asset.devName, asset.extraType])];
      return matchesLibrarySearch(query, fields);
    });
  }, [availableDirectories, characterIndex, characterSearch, loadedCharacters]);
  const lobbyLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const [name, entry] of Object.entries(characterIndex.characters)) {
      for (const asset of indexedAssets(entry)) labels[asset.directory] = `${name} · ${asset.extraType ? extraLabel(asset.extraType) : asset.variant}`;
    }
    return labels;
  }, [characterIndex, language]);
  const favoriteLobbies = navigation.favorites.filter((directory) => availableDirectories?.has(directory));
  const recentLobbies = navigation.recent.filter((directory) => availableDirectories?.has(directory));
  const selectedVariant = variants.find((variant) => variant.directory === selectedDirectory) ?? variants[0];
  const selectedDirectoryName = selectedVariant?.directory ?? "";
  const thumbnailSource = desktopSource;
  useEffect(() => {
    if (!navigationRootKey || navigationRootRef.current !== navigationRootKey
      || !selectedDirectoryName || !availableDirectories?.has(selectedDirectoryName)) return;
    setNavigation((current) => recordRecentLobby(current, selectedDirectoryName));
  }, [availableDirectories, navigationRootKey, selectedDirectoryName]);
  const selectedInteractionProject = draftPreview?.lobbyId === selectedDirectoryName ? draftPreview.project : localInteractionProject;
  useEffect(() => {
    setEffectsStrength(selectedInteractionProject?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH);
  }, [selectedDirectoryName, selectedInteractionProject]);
  const compositionSequenceIds = selectedInteractionProject ? timelineSequenceIds(selectedInteractionProject) : [];
  const compositionPreloadTimelines = useMemo(
    () => selectedInteractionProject
      ? timelineSequenceIds(selectedInteractionProject).map((id) => timelineForSequence(selectedInteractionProject, id)).filter((item): item is SpineTimeline => item !== null)
      : [],
    [selectedInteractionProject],
  );
  const compositionSequenceSignature = compositionSequenceIds.join("\u001f");
  const compositionSequenceId = selectedSequenceId && compositionSequenceIds.includes(selectedSequenceId)
    ? selectedSequenceId
    : "";
  const compositionTimeline = selectedInteractionProject ? timelineForSequence(selectedInteractionProject, compositionSequenceId) : null;
  const compositionActive = Boolean(compositionTimeline);
  const videoRecorderApplyingCamera = videoRecorderDialog?.phase === "settings"
    || videoRecorderDialog?.phase === "preparing"
    || videoRecorderDialog?.phase === "recording"
    || videoRecorderDialog?.phase === "rendering"
    || videoRecorderDialog?.phase === "mixing"
    || videoRecorderDialog?.phase === "encoding"
    || videoRecorderDialog?.phase === "saving"
    || videoRecorderDialog?.phase === "canceling";
  const savedCameraForRecording = videoRecorderApplyingCamera && videoRecorderDialog?.settings.framing === "saved";
  const compositionCameraMode: SpineCameraMode = savedCameraForRecording
    ? compositionTimeline?.camera?.enabled ? "authored" : "fit"
    : interactionMode === "free"
      ? "artwork"
      : compositionTimeline?.camera?.enabled ? "authored" : "fit";
  const outputAspectRatio = savedCameraForRecording && compositionTimeline?.camera?.enabled
    ? compositionTimeline.camera.aspectRatio
    : aspectRatio;
  const authoredTalkSequenceIds = selectedInteractionProject ? timelineTalkSequenceIds(selectedInteractionProject) : [];
  const authoredTalkAutoplayAvailable = Boolean(
    selectedInteractionProject
      && authoredTalkSequenceIds.length > 0
      && timelineForSequence(selectedInteractionProject, "opening"),
  );
  const activeViewport = () => compositionActive ? compositionRef.current : viewportRef.current;
  useEffect(() => {
    if (videoRecorderDialog) return;
    const pose = videoRecorderCameraPoseRef.current;
    videoRecorderCameraPoseRef.current = null;
    if (pose && !videoRecordingRunRef.current) {
      const frame = requestAnimationFrame(() => activeViewport()?.setCameraPose(pose));
      return () => cancelAnimationFrame(frame);
    }
  }, [compositionActive, videoRecorderDialog?.phase]);

  useEffect(() => {
    if (videoRecorderDialog?.phase !== "settings" || videoRecorderDialog.settings.framing !== "current") return;
    const pose = videoRecorderCameraPoseRef.current;
    if (!pose) return;
    const frame = requestAnimationFrame(() => activeViewport()?.setCameraPose(pose));
    return () => cancelAnimationFrame(frame);
  }, [compositionActive, compositionSequenceId, meta, selectedDirectoryName, videoRecorderDialog?.phase, videoRecorderDialog?.settings.framing]);

  const fitAllArtwork = () => {
    if (interactionMode !== "free") return;
    setCameraMode("artwork");
    activeViewport()?.resetCamera();
  };
  useEffect(() => { writeViewerAspectRatio(aspectRatio); }, [aspectRatio]);
  useEffect(() => {
    const nextMode: SpineCameraMode = interactionMode === "free"
      ? "artwork"
      : compositionTimeline?.camera?.enabled ? "authored" : "fit";
    if (cameraMode !== nextMode) setCameraMode(nextMode);
  }, [cameraMode, compositionSequenceId, interactionMode, selectedDirectoryName, selectedInteractionProject]);
  const draftSessionId = draftPreview?.sessionId ?? null;
  useEffect(() => {
    if (!draftSessionId || !isDesktopHost()) return;
    let live = true;
    let timer: number | null = null;
    const pollDraft = async () => {
      if (!live) return;
      const current = draftPreviewRef.current;
      if (!current || current.sessionId !== draftSessionId) return;
      try {
        const snapshot = await readDesktopDraftSnapshot(draftSessionId);
        if (!live) return;
        if (!snapshot
          || snapshot.sessionId !== current.sessionId
          || snapshot.library.identity !== current.library.identity
          || snapshot.lobbyId !== current.lobbyId) {
          setDraftPreview(null);
          setDraftPreviewNotice(t("spine.draft.ended"));
          return;
        }
        if (snapshot.project.assetDirectory !== snapshot.lobbyId) throw new Error("Draft lobby mismatch.");
        if (snapshot.revision > current.revision) {
          const project = normalizeSpineInteractionProject(snapshot.project, snapshot.lobbyId);
          if (!project) throw new Error("Draft project is no longer valid.");
          setDraftPreview((active) => active?.sessionId === draftSessionId ? { ...snapshot, project } : active);
        }
      } catch {
        if (live) {
          setDraftPreview(null);
          setDraftPreviewNotice(t("spine.draft.disconnected"));
        }
        return;
      }
      if (live) timer = window.setTimeout(() => { void pollDraft(); }, 600);
    };
    void pollDraft();
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [draftSessionId]);

  useEffect(() => {
    if (draftPreview && draftPreview.lobbyId !== selectedDirectoryName) {
      setDraftPreview(null);
      setDraftPreviewNotice(t("spine.draft.ended"));
    }
  }, [draftPreview?.sessionId, selectedDirectoryName]);

  viewerReloadStateRef.current = {
    rootPath: source && "rootPath" in source && typeof source.rootPath === "string" ? source.rootPath : null,
    lobbyId: selectedDirectoryName,
    snapshot: {
      language,
      cameraMode,
      cameraPose: null,
      voiceVolume,
      playing,
      loop,
      speed,
      playheadSeconds: progress.time,
      sequenceId: selectedSequenceId,
      animation,
    },
  };

  useEffect(() => {
    let live = true;
    setLocalInteractionProject(null);
    if (!source || !selectedDirectoryName) {
      setInteractionProjectLoading(false);
      return () => { live = false; };
    }
    setInteractionProjectLoading(true);
    void readLocalInteractionProject(source, selectedDirectoryName).then((project) => {
      if (!live) return;
      setLocalInteractionProject(project);
      setInteractionProjectLoading(false);
    }).catch((reason: unknown) => {
      if (!live) return;
      setLocalInteractionProject(null);
      setInteractionProjectLoading(false);
      setError(t("spine.error.loadSet", { error: errorMessage(reason) }));
    });
    return () => { live = false; };
  }, [selectedDirectoryName, source]);

  useEffect(() => {
    const entrySequence = selectedInteractionProject?.entrySequence;
    const sequenceIds = selectedInteractionProject ? timelineSequenceIds(selectedInteractionProject) : [];
    const pendingHandoff = pendingHandoffRef.current;
    const handoffSequence = pendingHandoff?.lobbyId === selectedDirectoryName ? pendingHandoff.sequenceId : undefined;
    const currentSequence = sequenceIds.includes(selectedSequenceId) ? selectedSequenceId : "";
    const initialSequence = handoffSequence && sequenceIds.includes(handoffSequence)
      ? handoffSequence
      : !pendingHandoff && currentSequence
        ? currentSequence
        : entrySequence && sequenceIds.includes(entrySequence) ? entrySequence : "";
    const videoRestore = pendingVideoRestoreRef.current;
    const sequenceToSelect = videoRestore ? videoRestore.sequenceId : initialSequence;
    const recorderRun = videoRecordingRunRef.current;
    setIdleMode(videoRestore
      ? videoRestore.idleMode
      : recorderRun?.phase === "preparing" && recorderRun.source === "composition" && recorderRun.settings.mode === "idle-only"
        ? "persistent"
        : "none");
    setSelectedSequenceId(sequenceToSelect);
    const initialTimeline = selectedInteractionProject && sequenceToSelect ? timelineForSequence(selectedInteractionProject, sequenceToSelect) : null;
    setProgress({
      time: videoRestore?.progress.time ?? 0,
      duration: videoRestore?.progress.duration ?? (initialTimeline ? projectTimelineDuration(initialTimeline, selectedInteractionProject) : 0),
      animation: videoRestore?.progress.animation ?? null,
    });
  }, [compositionSequenceSignature, selectedDirectoryName, selectedInteractionProject?.entrySequence, selectedSequenceId]);

  useEffect(() => {
    const handoff = pendingHandoffRef.current;
    if (!handoff || handoff.lobbyId !== selectedDirectoryName || !setFiles || interactionProjectLoading) return;
    if (selectedInteractionProject) {
      const sequenceIds = timelineSequenceIds(selectedInteractionProject);
      const expectedSequence = handoff.sequenceId && sequenceIds.includes(handoff.sequenceId)
        ? handoff.sequenceId
        : selectedInteractionProject.entrySequence && sequenceIds.includes(selectedInteractionProject.entrySequence)
          ? selectedInteractionProject.entrySequence
          : "";
      if (expectedSequence && selectedSequenceId !== expectedSequence) return;
    }
    if (handoff.playheadSeconds !== undefined) {
      if (compositionActive) {
        const duration = compositionTimeline ? projectTimelineDuration(compositionTimeline, selectedInteractionProject) : handoff.playheadSeconds;
        compositionRef.current?.seek(Math.min(handoff.playheadSeconds, duration));
      } else {
        const duration = progress.duration || handoff.playheadSeconds;
        viewportRef.current?.seek(Math.min(handoff.playheadSeconds, duration));
      }
    }
    pendingHandoffRef.current = null;
  }, [compositionActive, compositionTimeline, interactionProjectLoading, progress.duration, selectedDirectoryName, selectedInteractionProject, selectedSequenceId, setFiles]);

  const legacyVoiceCharacter = voiceCharacterForDirectory(voiceManifest, selectedDirectoryName);
  const selectedVoiceCharacter = voiceCharacter ?? legacyVoiceCharacter;
  const voiceLines = useMemo(
    () => playableVoiceLines(selectedVoiceCharacter).map((line) => voiceLineForLanguage(line, language)),
    [language, selectedVoiceCharacter],
  );
  const introVoiceLine = useMemo(() => {
    const line = introVoiceLineForCharacter(voiceCharacter) ?? introVoiceLineForCharacter(legacyVoiceCharacter);
    return line ? voiceLineForLanguage(line, language) : undefined;
  }, [language, legacyVoiceCharacter, voiceCharacter]);
  const voiceAudioPaths = useMemo(
    () => [...new Set([
      ...(introVoiceLineForCharacter(selectedVoiceCharacter)?.audio ?? []),
      ...playableVoiceLines(selectedVoiceCharacter).flatMap((line) => line.audio),
    ])],
    [selectedVoiceCharacter],
  );
  const activeVoiceLine = voiceLineIndex === null
    ? undefined
    : voiceLineIndex < 0
      ? introVoiceLine
      : voiceLines.length > 0 ? voiceLines[voiceLineIndex % voiceLines.length] : undefined;
  const activeDialogue = activeVoiceLine ? dialogueForVoiceLine(activeVoiceLine, language, voiceClipIndex) : "";

  useEffect(() => {
    let live = true;
    setVoiceCharacter(null);
    if (!source || !selectedDirectoryName || !voiceCatalog) return () => { live = false; };
    const entry = voiceCatalogEntryForDirectory(voiceCatalog, selectedDirectoryName);
    if (!entry) return () => { live = false; };
    void source.getFile(`audios/voicelines/${entry.file}`).then(async (file) => {
      if (!live || !file) return;
      try {
        setVoiceCharacter(parseVoiceCharacterFile(JSON.parse(await file.text()), entry.audioDirectory));
      } catch {
        setVoiceCharacter(null);
      }
    });
    return () => { live = false; };
  }, [source, selectedDirectoryName, voiceCatalog]);

  const folderLoading = Boolean(source && !availableDirectories);
  const selectedSetAvailable = Boolean(source && selectedDirectoryName && availableDirectories?.has(selectedDirectoryName));
  const filesLoading = setLoading || (selectedSetAvailable && !setFiles && !error);
  const rendererPending = selectedSetAvailable && Boolean(setFiles) && !meta && !error;
  const voiceAudioLoading = voiceAudioProgress.total > 0 && voiceAudioProgress.loaded < voiceAudioProgress.total;
  const compositionAudioLoading = compositionActive
    && compositionLoadProgress?.stage === "audio"
    && compositionLoadProgress.loaded < compositionLoadProgress.total;
  const backgroundAudioLoading = voiceAudioLoading || compositionAudioLoading;
  // Audio preparation is intentionally non-blocking: once the character scene
  // is visible, Talk/sequence audio must never replace it with a loading card.
  const isLoading = !error && Boolean(folderLoading || filesLoading || rendererLoading || rendererPending);
  const videoRecorderReadyRef = useRef(false);
  videoRecorderReadyRef.current = !isLoading && !backgroundAudioLoading && Boolean(meta);
  const compositionRendererProgress = compositionLoadProgress?.stage === "audio" ? null : compositionLoadProgress;
  const loadingProgress: SpineLoadProgress | null = folderLoading
      ? null
      : filesLoading
        ? { stage: "files", loaded: 0, total: 0 }
      : rendererLoading || rendererPending
        ? (compositionActive ? compositionRendererProgress : rendererLoadProgress) ?? { stage: "skeleton", loaded: 0, total: 1 }
        : null;
  useEffect(() => {
    if (videoRecorderDialog?.phase !== "settings" || isLoading || backgroundAudioLoading) return;
    let live = true;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!live || !videoRecorderReadyRef.current) return;
        const frame = stageFrameRef.current;
        const stage = frame?.querySelector<HTMLElement>(".spine-stage");
        if (!stage) return;
        const dimensions = videoRecordingDimensions(720, outputAspectRatio);
        const scale = Math.min(1, 720 / dimensions.width, 720 / dimensions.height);
        const capture = createCanvasFrameCapture({
          stage,
          width: Math.max(2, Math.round(dimensions.width * scale / 2) * 2),
          height: Math.max(2, Math.round(dimensions.height * scale / 2) * 2),
          includeSubtitles: videoRecorderDialog.settings.includeSubtitles,
        });
        void capture.captureFrame().then((image) => {
          if (live) updateVideoRecorderPreview(image);
        }).catch(() => undefined);
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [backgroundAudioLoading, isLoading, outputAspectRatio, selectedDirectoryName, videoRecorderDialog?.phase, videoRecorderDialog?.settings.framing, videoRecorderDialog?.settings.includeSubtitles]);

  const animationOptions: Array<string | { value: string; label: string; disabled?: boolean }> = meta
    ? [
      ...(!meta.idleAnimation ? [{ value: "", label: t("spine.noIdleDetected"), disabled: true }] : []),
      ...(meta.introAnimation && meta.idleAnimation ? [INTRO_ANIMATION] : []),
      ...meta.animations.map((name) => ({ value: name, label: name })),
    ]
    : [];

  const clearVoiceAudio = () => {
    const audio = voiceAudioRef.current;
    if (audio) {
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    voiceAudioRef.current = null;
  };

  const clearAutoPlayTimer = () => {
    if (autoPlayTimerRef.current !== null) window.clearTimeout(autoPlayTimerRef.current);
    autoPlayTimerRef.current = null;
  };

  const queueNextAutoTalk = (lineIndex: number, run: number, attempt = 0) => {
    clearAutoPlayTimer();
    autoPlayTimerRef.current = window.setTimeout(() => {
      autoPlayTimerRef.current = null;
      if (run !== voiceRunRef.current || !talkAutoplayRef.current) return;
      const line = voiceLines[lineIndex];
      if (!line || !interactionReady) {
        talkAutoplayRef.current = false;
        setTalkAutoplay(false);
        return;
      }
      // Runtime auto-talk can crossfade directly from the previous Talk once
      // its voice has ended; waiting for the old animation to fade to idle
      // creates a visible idle gap and defeats the configured Talk mix.
      if (compositionActive) compositionRef.current?.triggerTalk(voiceAnimationForLine(line));
      else viewportRef.current?.triggerTalk(voiceAnimationForLine(line));
      // If the renderer rejected the request while its interaction state was
      // changing, keep the same line queued until it can be accepted.
      if (voiceSessionRef.current?.lineIndex !== lineIndex) {
        if (attempt < 20) queueNextAutoTalk(lineIndex, run, attempt + 1);
        else {
          talkAutoplayRef.current = false;
          setTalkAutoplay(false);
        }
      }
    }, attempt === 0 ? 180 : 80);
  };

  const finishVoicePlayback = (run: number) => {
    if (run !== voiceRunRef.current) return;
    const session = voiceSessionRef.current;
    voiceSessionRef.current = null;
    if (session?.kind === "talk") {
      if (compositionActive) compositionRef.current?.setTalkAudioPending(false);
      else viewportRef.current?.setTalkAudioPending(false);
    }
    setVoicePlaying(false);
    setVoiceLineIndex(null);
    setVoiceClipIndex(0);
    const authoredTimelineAutoplay = compositionActive && authoredTalkAutoplayAvailable;
    if (session?.kind === "talk" && talkAutoplayRef.current && !authoredTimelineAutoplay) {
      const nextIndex = session.lineIndex + 1;
      if (nextIndex < voiceLines.length) queueNextAutoTalk(nextIndex, run);
      else {
        // Auto-play is deliberately a one-shot tour of the available talks.
        clearAutoPlayTimer();
        talkAutoplayRef.current = false;
        setTalkAutoplay(false);
      }
    } else if (session?.kind === "talk" && authoredTimelineAutoplay) {
      // Editor-authored autoplay is advanced by the saved talk timeline's
      // onFinished callback. Audio ending is only the voice gate; it must not
      // interrupt the authored animation or select the next talk early.
      clearAutoPlayTimer();
    }
  };

  const stopVoice = (updateState = true, cancelAutoPlay = true) => {
    voiceRunRef.current += 1;
    voiceSessionRef.current = null;
    clearAutoPlayTimer();
    if (cancelAutoPlay) {
      talkAutoplayRef.current = false;
      authoredTalkIndexRef.current = 0;
    }
    clearVoiceAudio();
    if (compositionActive) compositionRef.current?.setTalkAudioPending(false);
    else viewportRef.current?.setTalkAudioPending(false);
    if (updateState) {
      setVoicePlaying(false);
      setVoiceLineIndex(null);
      setVoiceClipIndex(0);
      if (cancelAutoPlay) setTalkAutoplay(false);
    }
  };

  const resetAssetPlayback = () => {
    pendingHandoffRestoreRef.current = null;
    setDraftPreview(null);
    setDraftPreviewNotice(null);
    stopVoice();
    setPlaying(true);
    setCameraMode(interactionMode === "free" ? "artwork" : "fit");
    setSelectedSequenceId("");
    setIdleMode("none");
    setAnimation("");
    setAnimationSelectionOrigin("automatic");
    setSetFiles(null);
    setProgress({ time: 0, duration: 0, animation: null });
    setMeta(null);
    setError(null);
  };

  const returnToSavedFiles = () => {
    setDraftPreview(null);
    setDraftPreviewNotice(t("spine.draft.returned"));
  };

  const playVoiceClip = async (session: VoiceSession, clipIndex: number): Promise<void> => {
    if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session || clipIndex >= session.line.audio.length) return;
    const files = await session.files;
    if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session) return;
    const prepared = files[clipIndex] ?? null;
    const continueMissingClip = () => {
      if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session) return;
      setVoicePlaying(false);
      setVoiceLineIndex(null);
      if (clipIndex + 1 >= session.line.audio.length) finishVoicePlayback(session.run);
      else if (clipIndex + 1 >= session.eventCount) void playVoiceClip(session, clipIndex + 1);
    };
    if (!prepared) {
      continueMissingClip();
      return;
    }

    const playable = await prepared.ready;
    if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session) return;
    if (!playable) {
      continueMissingClip();
      return;
    }

    clearVoiceAudio();
    const audio = prepared.audio;
    audio.volume = normalizeVoiceVolume(voiceVolume);
    audio.currentTime = 0;
    voiceAudioRef.current = audio;
    const recording = videoRecordingRunRef.current;
    const recordingAudioCapture = recording?.audioCapture ?? recording?.capture;
    if (recording?.settings.includeAudio && !recordingAudioCapture) {
      stopVideoRecording(false, "This WebView cannot mix the selected audio sources.");
      return;
    }
    if (recordingAudioCapture && recording?.settings.includeAudio) {
      try {
        recordingAudioCapture.addAudioElement(audio);
      } catch (error) {
        stopVideoRecording(false, errorMessage(error));
        return;
      }
    }
    audio.onplay = () => {
      if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session || voiceAudioRef.current !== audio) return;
      setVoiceLineIndex(session.lineIndex);
      setVoiceClipIndex(clipIndex);
      setVoicePlaying(true);
    };
    const ended = () => {
      if (session.run !== voiceRunRef.current || voiceSessionRef.current !== session || voiceAudioRef.current !== audio) return;
      clearVoiceAudio();
      setVoicePlaying(false);
      setVoiceLineIndex(null);
      if (clipIndex + 1 >= session.line.audio.length) finishVoicePlayback(session.run);
      else if (clipIndex + 1 >= session.eventCount) void playVoiceClip(session, clipIndex + 1);
    };
    audio.onended = ended;
    audio.onerror = ended;
    try {
      await audio.play();
    } catch {
      if (session.run === voiceRunRef.current && voiceSessionRef.current === session && voiceAudioRef.current === audio) stopVoice();
    }
  };

  const beginVoiceSession = (index: number, animation: string, eventCount: number): boolean => {
    if (!voiceEnabled || !source || voiceLines.length === 0) return false;
    const lineIndex = voiceLineIndexForAnimation(voiceLines, animation, index);
    const line = voiceLines[lineIndex];
    if (!line || line.audio.length === 0) return false;
    stopVoice(true, false);
    const run = voiceRunRef.current;
    const files = Promise.all(line.audio.map((path) => cachedVoiceAudio(voiceAudioCacheRef.current, source, path)));
    const session: VoiceSession = { kind: "talk", run, talkIndex: index, lineIndex, line, eventCount, started: new Set(), files };
    voiceSessionRef.current = session;
    setSelectedVoiceLineIndex(lineIndex);
    if (eventCount === 0) {
      session.started.add(0);
      void playVoiceClip(session, 0);
    }
    return true;
  };

  const beginIntroVoiceSession = (_animation: string, eventCount: number): boolean => {
    // Authored compositions already contain their intro audio as timeline
    // clips. The runtime voice catalog must not attach a second copy.
    if (compositionActive || videoRecordingRunRef.current?.useFfmpeg) return false;
    if (!voiceEnabled || !source || !introVoiceLine || introVoiceLine.audio.length === 0) return false;
    stopVoice(true, false);
    const run = voiceRunRef.current;
    const files = Promise.all(introVoiceLine.audio.map((path) => cachedVoiceAudio(voiceAudioCacheRef.current, source, path)));
    const session: VoiceSession = {
      kind: "intro",
      run,
      talkIndex: -1,
      lineIndex: -1,
      line: introVoiceLine,
      eventCount,
      started: new Set(),
      files,
    };
    voiceSessionRef.current = session;
    if (eventCount === 0) {
      session.started.add(0);
      void playVoiceClip(session, 0);
    }
    return true;
  };

  const playVoiceEvent = (index: number, clipIndex: number) => {
    const session = voiceSessionRef.current;
    if (!session || session.kind !== "talk" || session.run !== voiceRunRef.current || session.talkIndex !== index || session.started.has(clipIndex)) return;
    session.started.add(clipIndex);
    void playVoiceClip(session, clipIndex);
  };

  const playIntroVoiceEvent = (clipIndex: number) => {
    const session = voiceSessionRef.current;
    if (!session || session.kind !== "intro" || session.run !== voiceRunRef.current || session.started.has(clipIndex)) return;
    session.started.add(clipIndex);
    void playVoiceClip(session, clipIndex);
  };

  useEffect(() => {
    stopVoice();
    setVoiceLineIndex(null);
    setVoiceClipIndex(0);
    setSelectedVoiceLineIndex(null);
  }, [language, selectedDirectoryName, source]);

  useEffect(() => {
    const cache = new Map<string, Promise<PreloadedSpineAudio | null>>();
    voiceAudioCacheRef.current = cache;
    let live = true;
    let loaded = 0;
    const paths = source && selectedDirectoryName ? voiceAudioPaths : [];
    setVoiceAudioProgress({ loaded: 0, total: paths.length });
    if (source && selectedDirectoryName) {
      let nextPath = 0;
      const worker = async () => {
        while (live) {
          const index = nextPath++;
          const path = paths[index];
          if (!path) return;
          try {
            const audio = await cachedVoiceAudio(cache, source, path);
            if (audio) await audio.ready;
          } catch {
            // Missing or undecodable optional voice must not block playback.
          } finally {
            if (live) setVoiceAudioProgress({ loaded: ++loaded, total: paths.length });
          }
        }
      };
      void Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_VOICE_PRELOADS, paths.length) }, () => worker()));
    }
    return () => {
      live = false;
      if (voiceAudioCacheRef.current === cache) voiceAudioCacheRef.current = new Map();
      for (const pending of cache.values()) void pending.then((audio) => { if (audio) releasePreloadedSpineAudio(audio); });
    };
  }, [selectedDirectoryName, source, voiceAudioPaths]);

  useEffect(() => {
    if (!voiceEnabled) stopVoice();
  }, [voiceEnabled]);

  useEffect(() => {
    const audio = voiceAudioRef.current;
    if (audio) audio.volume = normalizeVoiceVolume(voiceVolume);
    writeViewerVoiceVolume(voiceVolume);
  }, [voiceVolume]);

  useEffect(() => () => stopVoice(false), []);

  useEffect(() => {
    if (meta?.introAnimation && voiceSessionRef.current?.kind === "intro" && progress.animation !== meta.introAnimation) stopVoice(false, false);
  }, [meta?.introAnimation, progress.animation]);

  useEffect(() => {
    if (!compositionActive && progress.animation === meta?.introAnimation && introVoiceLine) viewportRef.current?.startIntroAudio();
  }, [compositionActive, introVoiceLine, meta?.introAnimation, progress.animation, voiceEnabled]);

  useEffect(() => {
    if (!source) {
      setAvailableDirectories(null);
      return;
    }
    let live = true;
    source.getDirectories().then(
      (directories) => {
        if (live) setAvailableDirectories(new Set(directories));
      },
      (reason) => {
        if (!live) return;
        setAvailableDirectories(new Set());
        setError(t("spine.error.folder", { error: errorMessage(reason) }));
      },
    );
    return () => { live = false; };
  }, [source]);

  useEffect(() => {
    setLibraryChangesAvailable(false);
    setLibraryWatcherAvailable(null);
    if (!desktopSource) return;
    let live = true;
    let polling = false;
    let baseline: number | null = null;
    const controller = new AbortController();
    const pollChanges = async () => {
      if (!live || polling) return;
      polling = true;
      try {
        const state = await desktopSource.getLibraryChangeState(controller.signal);
        if (!live) return;
        setLibraryWatcherAvailable(state.watching);
        if (baseline === null) baseline = state.revision;
        else if (state.revision !== baseline) setLibraryChangesAvailable(true);
      } catch {
        if (live) setLibraryWatcherAvailable(false);
      } finally {
        polling = false;
      }
    };
    void pollChanges();
    const timer = window.setInterval(() => { void pollChanges(); }, 2000);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [desktopSource]);

  useEffect(() => {
    if (!source || !selectedDirectoryName || !availableDirectories?.has(selectedDirectoryName)) {
      setSetFiles(null);
      setSetLoading(false);
      return;
    }
    let live = true;
    const controller = new AbortController();
    setSetFiles(null);
    setSetLoading(true);
    setError(null);
    source.getSetFiles(selectedDirectoryName, controller.signal).then(
      (files) => {
        if (!live) return;
        setSetFiles(files);
        setSetLoading(false);
      },
      (reason) => {
        if (!live) return;
        setSetLoading(false);
        setError(t("spine.error.loadSet", { error: errorMessage(reason) }));
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [availableDirectories, source, selectedDirectoryName]);

  useEffect(() => {
    if (!source || !availableDirectories) return;
    const nextCharacter = characterNames.find((name) => indexedAssets(characterIndex.characters[name]).some((variant) => availableDirectories.has(variant.directory)));
    const selectedIsLoaded = indexedAssets(characterIndex.characters[selectedCharacter]).some((variant) => availableDirectories.has(variant.directory));
    if (selectedIsLoaded) return;
    if (pendingHandoffRestoreRef.current?.lobbyId === selectedDirectoryName) pendingHandoffRestoreRef.current = null;
    const nextVariant = nextCharacter ? indexedAssets(characterIndex.characters[nextCharacter]).find((variant) => availableDirectories.has(variant.directory)) : undefined;
    resetAssetPlayback();
    setSelectedCharacter(nextCharacter ?? "");
    setSelectedDirectory(nextVariant?.directory ?? "");
    setExpandedCharacter(nextCharacter ?? "");
  }, [availableDirectories, selectedCharacter, source]);

  const clearFullscreenHideTimer = () => {
    if (fullscreenHideTimerRef.current !== null) window.clearTimeout(fullscreenHideTimerRef.current);
    fullscreenHideTimerRef.current = null;
  };

  const clearFullscreenControlsHintTimer = () => {
    if (fullscreenControlsHintTimerRef.current !== null) window.clearTimeout(fullscreenControlsHintTimerRef.current);
    fullscreenControlsHintTimerRef.current = null;
  };

  const showFullscreenControlsHintOnce = () => {
    if (fullscreenControlsHintSeenRef.current) return;
    fullscreenControlsHintSeenRef.current = true;
    setShowFullscreenControlsHint(true);
    clearFullscreenControlsHintTimer();
    fullscreenControlsHintTimerRef.current = window.setTimeout(() => {
      fullscreenControlsHintTimerRef.current = null;
      setShowFullscreenControlsHint(false);
    }, 2600);
  };

  const scheduleFullscreenHide = () => {
    clearFullscreenHideTimer();
    if (!fullscreen || fullscreenClean || showOptions) return;
    fullscreenHideTimerRef.current = window.setTimeout(() => {
      fullscreenHideTimerRef.current = null;
      if (fullscreen && !showOptions) {
        setShowFullscreenControls(false);
        showFullscreenControlsHintOnce();
      }
    }, 3600);
  };

  const revealFullscreenControls = () => {
    if (!fullscreen || fullscreenClean) return;
    clearFullscreenControlsHintTimer();
    setShowFullscreenControlsHint(false);
    setShowFullscreenControls(true);
    scheduleFullscreenHide();
  };

  const hideFullscreenControls = () => {
    if (!fullscreen || fullscreenClean) return;
    clearFullscreenHideTimer();
    clearFullscreenControlsHintTimer();
    setShowFullscreenControlsHint(false);
    setShowFullscreenControls(false);
  };

  const enterCleanFullscreen = () => {
    if (!fullscreen) return;
    clearFullscreenHideTimer();
    clearFullscreenControlsHintTimer();
    setShowFullscreenControlsHint(false);
    setShowOptions(false);
    setShowSidebar(false);
    setShowFullscreenControls(false);
    setFullscreenClean(true);
  };

  const exitCleanFullscreen = () => {
    setFullscreenClean(false);
    clearFullscreenControlsHintTimer();
    setShowFullscreenControlsHint(false);
    setShowFullscreenControls(true);
    scheduleFullscreenHide();
  };

  useEffect(() => {
    const applyFullscreenState = (active: boolean) => {
      if (fullscreenRef.current === active) return;
      fullscreenRef.current = active;
      clearFullscreenHideTimer();
      clearFullscreenControlsHintTimer();
      setShowFullscreenControlsHint(false);
      if (active) fullscreenControlsHintSeenRef.current = false;
      setFullscreen(active);
      setShowSidebar(!active);
      setShowOptions(false);
      setShowFullscreenControls(active);
      setFullscreenClean(false);
    };
    const onFullscreen = () => applyFullscreenState(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    let live = true;
    let pollTimer: number | null = null;
    const pollNativeFullscreen = () => {
      void getDesktopFullscreen().then((active) => {
        if (live && active !== null) applyFullscreenState(active);
      }).catch(() => undefined);
    };
    if (isDesktopHost()) {
      pollNativeFullscreen();
      pollTimer = window.setInterval(pollNativeFullscreen, 350);
    }
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, []);

  useEffect(() => {
    if (!fullscreen || !showOptions) return;
    clearFullscreenHideTimer();
    if (fullscreenClean) setFullscreenClean(false);
    setShowFullscreenControls(true);
  }, [fullscreen, fullscreenClean, showOptions]);

  useEffect(() => {
    const layout = fullscreenLayoutRef.current;
    const controls = fullscreenControlsRef.current;
    const workspace = layout?.querySelector<HTMLElement>(".spine-workspace");
    const heading = workspace?.querySelector<HTMLElement>(".spine-workspace-heading");
    if (!layout || !workspace || !controls || !heading || typeof ResizeObserver === "undefined") return;

    const updateSettingsBounds = () => {
      layout.style.setProperty("--spine-fullscreen-controls-height", `${controls.getBoundingClientRect().height}px`);
      const workspaceRect = workspace.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const headingHeight = heading.getClientRects().length ? headingRect.bottom - workspaceRect.top : 10;
      const settingsBottom = controls.getClientRects().length ? workspaceRect.bottom - controlsRect.top + 8 : 8;
      workspace.style.setProperty("--spine-settings-top", `${Math.max(8, headingHeight + 4)}px`);
      workspace.style.setProperty("--spine-settings-bottom", `${Math.max(8, settingsBottom)}px`);
    };
    const observer = new ResizeObserver(updateSettingsBounds);
    observer.observe(workspace);
    observer.observe(heading);
    observer.observe(controls);
    updateSettingsBounds();
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--spine-fullscreen-controls-height");
      workspace.style.removeProperty("--spine-settings-top");
      workspace.style.removeProperty("--spine-settings-bottom");
    };
  }, [fullscreen]);

  useEffect(() => {
    scheduleFullscreenHide();
    return clearFullscreenHideTimer;
  }, [fullscreen, fullscreenClean, showOptions]);

  useEffect(() => () => {
    clearFullscreenHideTimer();
    clearFullscreenControlsHintTimer();
  }, []);

  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) setShowSidebar(false);
  }, []);

  const chooseFolder = async () => {
    if (videoRecordingRunRef.current) return;
    if (isDesktopHost()) {
      try {
        const desktopSource = await chooseDesktopSource();
        if (!desktopSource) return;
        resetAssetPlayback();
        setSource(desktopSource);
        setAvailableDirectories(null);
        setSetFiles(null);
      } catch (reason) {
        setError(t("spine.error.folder", { error: errorMessage(reason) }));
      }
      return;
    }
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      const input = inputRef.current;
      if (!input) return;
      input.value = "";
      input.click();
      return;
    }
    try {
      const handle = await picker.call(window);
      resetAssetPlayback();
      setSource(sourceFromDirectory(handle));
      setAvailableDirectories(null);
      setSetFiles(null);
    } catch (reason) {
      // A cancelled picker is a normal interaction, not an error state.
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(t("spine.error.folder", { error: errorMessage(reason) }));
    }
  };

  const refreshDesktopLibrary = async () => {
    if (!desktopSource || libraryRefreshing) return;
    setLibraryRefreshing(true);
    try {
      const nextSource = await desktopSource.refreshLibrary();
      const current = viewerReloadStateRef.current;
      if (current?.rootPath === desktopSource.rootPath && current.lobbyId === selectedDirectoryName) {
        const cameraPose = activeViewport()?.getCameraPose() ?? null;
        pendingHandoffRestoreRef.current = {
          lobbyId: selectedDirectoryName,
          state: {
            language: current.snapshot.language,
            cameraMode: current.snapshot.cameraMode,
            ...(cameraPose ? { cameraPose } : {}),
            voiceVolume: current.snapshot.voiceVolume,
            playing: current.snapshot.playing,
            loop: current.snapshot.loop,
            speed: current.snapshot.speed,
            ...(current.snapshot.sequenceId ? { sequenceId: current.snapshot.sequenceId } : {}),
            playheadSeconds: progressRef.current.time,
            ...(current.snapshot.animation ? { animation: current.snapshot.animation } : {}),
          },
        };
      }
      setLibraryChangesAvailable(false);
      setAvailableDirectories(null);
      setSetFiles(null);
      setSource(nextSource);
      setError(null);
    } catch (reason) {
      setError(t("spine.library.refreshError", { error: errorMessage(reason) }));
    } finally {
      setLibraryRefreshing(false);
    }
  };

  const openInEditor = async () => {
    if (!source || !("rootPath" in source) || typeof source.rootPath !== "string" || !selectedDirectoryName) return;
    try {
      const message: SpineHandoffMessage = {
        protocolVersion: 1,
        requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        targetApp: "editor",
        library: { identity: await libraryIdentityForPath(source.rootPath), path: source.rootPath },
        lobbyId: selectedDirectoryName,
        ...(compositionSequenceId ? { sequenceId: compositionSequenceId } : {}),
        language,
        ...(Number.isFinite(progress.time) && progress.time >= 0 ? { playheadSeconds: progress.time } : {}),
      };
      await sendDesktopHandoff(message);
      setHandoffStatus("Handoff sent to BA Spine Editor.");
    } catch (reason) {
      setHandoffStatus(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (videoRecordingRunRef.current) return;
    if (!event.currentTarget.files?.length) return;
    resetAssetPlayback();
    setSource(sourceFromInput(event.currentTarget.files));
    setAvailableDirectories(null);
    setSetFiles(null);
  };

  const selectCharacter = (name: string) => {
    if (videoRecordingRunRef.current) return;
    const first = indexedAssets(characterIndex.characters[name]).find((variant) => !availableDirectories || availableDirectories.has(variant.directory));
    resetAssetPlayback();
    setSelectedCharacter(name);
    setSelectedDirectory(first?.directory ?? "");
    setExpandedCharacter(name);
  };

  const selectLobby = (lobbyId: string) => {
    if (videoRecordingRunRef.current) return;
    const character = Object.entries(characterIndex.characters)
      .find(([, entry]) => indexedAssets(entry).some((asset) => asset.directory === lobbyId));
    if (!character || !availableDirectories?.has(lobbyId)) return;
    resetAssetPlayback();
    setSelectedCharacter(character[0]);
    setSelectedDirectory(lobbyId);
    setExpandedCharacter(character[0]);
  };

  const toggleFavorite = (lobbyId: string) => {
    setNavigation((current) => toggleViewerFavorite(current, lobbyId));
  };

  const onCharacterListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!filteredCharacters.length || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-browser-item]")];
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-browser-item]") : null;
    const focused = target ? options.indexOf(target) : -1;
    const current = focused >= 0 ? focused : options.findIndex((item) => item.dataset.character === selectedCharacter);
    const next = current < 0
      ? event.key === "ArrowUp" ? options.length - 1 : 0
      : nextViewerListIndex(options.length, current, event.key);
    const targetItem = next >= 0 ? options[next] : null;
    if (!targetItem) return;
    event.preventDefault();
    targetItem.focus();
    targetItem.click();
  };

  const selectAnimation = (value: string) => {
    stopVoice();
    setAnimation(value);
    setAnimationSelectionOrigin("explicit");
    viewportRef.current?.setAnimation(value);
    setProgress((current) => ({ ...current, time: 0 }));
  };

  const toggleSkipIntro = (value: boolean) => {
    if (interactionMode === "interaction") stopVoice();
    setSkipIntro(value);
    if (!meta) return;
    if (interactionMode === "interaction") {
      setAnimation(value && meta.idleAnimation ? meta.idleAnimation : meta.defaultAnimation);
      setAnimationSelectionOrigin("automatic");
    } else if (value && animation === INTRO_ANIMATION && meta.idleAnimation) {
      selectAnimation(meta.idleAnimation);
    }
  };

  const selectInteractionMode = (value: SpineInteractionMode) => {
    if (videoRecordingRunRef.current) return;
    if (value === interactionMode) return;
    stopVoice();
    if (value === "interaction") {
      freePlaying.current = playing;
      freeLoop.current = loop;
      freeSpeed.current = speed;
      setCameraMode("fit");
      setPlaying(true);
      setLoop(true);
      setSpeed(1);
    } else {
      setCameraMode("artwork");
      setPlaying(freePlaying.current);
      setLoop(freeLoop.current);
      setSpeed(freeSpeed.current);
    }
    setInteractionMode(value);
    viewportRef.current?.setInteractionMode(value);
    if (value === "free") activeViewport()?.resetCamera();
  };

  const interactionReady = interactionMode === "interaction"
    && Boolean(meta)
    && progress.animation !== null
    && (skipIntro || !(meta?.introAnimation && meta.idleAnimation) || progress.animation !== meta.introAnimation);

  const playTalk = (line?: SpineVoiceLine, preserveAutoplay = false) => {
    if (!interactionReady) return;
    const rendererTalkActive = compositionActive
      ? compositionRef.current?.isTalkActive() === true
      : viewportRef.current?.isTalkActive() === true;
    const authoredTalkActive = compositionActive && timelineTalkInProgress(compositionSequenceId, idleMode);
    if (rendererTalkActive || authoredTalkActive) return;
    stopVoice(true, !preserveAutoplay);
    if (compositionActive && selectedInteractionProject && authoredTalkSequenceIds.length > 0) {
      const requestedNumber = line ? Number((line.animation || line.id).match(/(?:Talk_|talk-|_)(\d+)/i)?.[1]) : null;
      const currentIndex = authoredTalkSequenceIds.indexOf(compositionSequenceId);
      const nextId = requestedNumber !== null && Number.isFinite(requestedNumber)
        ? authoredTalkSequenceIds.find((id) => Number(id.match(/\d+$/)?.[0]) === requestedNumber)
        : authoredTalkSequenceIds[(currentIndex + 1) % authoredTalkSequenceIds.length];
      const next = nextId ? timelineForSequence(selectedInteractionProject, nextId) : null;
      if (next && nextId) {
        setIdleMode("none");
        setSelectedSequenceId(nextId);
        setProgress({ time: 0, duration: projectTimelineDuration(next, selectedInteractionProject), animation: null });
        setPlaying(true);
      }
      return;
    }
    if (compositionActive) compositionRef.current?.triggerTalk(line ? voiceAnimationForLine(line) : undefined);
    else viewportRef.current?.triggerTalk(line ? voiceAnimationForLine(line) : undefined);
  };

  const selectDialogue = (value: string) => {
    const index = value === "" ? null : Number(value);
    setSelectedVoiceLineIndex(Number.isInteger(index) && index !== null && index >= 0 && index < voiceLines.length ? index : null);
    if (index === null || !Number.isInteger(index)) return;
    const line = voiceLines[index];
    if (line) playTalk(line, talkAutoplay);
  };

  const toggleTalkAutoplay = () => {
    if (talkAutoplay) {
      stopVoice();
      if (compositionActive && idleMode === "bridge") {
        setIdleMode("persistent");
        setPlaying(true);
      }
      return;
    }
    if (!interactionReady || (voiceLines.length === 0 && !authoredTalkSequenceIds.length)) return;
    if (authoredTalkAutoplayAvailable && selectedInteractionProject) {
      stopVoice(true, false);
      authoredTalkIndexRef.current = 0;
      talkAutoplayRef.current = true;
      setTalkAutoplay(true);
      setSelectedVoiceLineIndex(null);
      const firstTalkId = authoredTalkSequenceIds[authoredTalkIndexRef.current++];
      const firstTalk = firstTalkId ? timelineForSequence(selectedInteractionProject, firstTalkId) : null;
      if (!firstTalk) {
        talkAutoplayRef.current = false;
        setTalkAutoplay(false);
        return;
      }
      setIdleMode("none");
      setSelectedSequenceId(firstTalkId);
      setProgress({ time: 0, duration: projectTimelineDuration(firstTalk, selectedInteractionProject), animation: null });
      setPlaying(true);
      return;
    }
    const startIndex = selectedVoiceLineIndex !== null && selectedVoiceLineIndex < voiceLines.length ? selectedVoiceLineIndex : 0;
    stopVoice(true, false);
    talkAutoplayRef.current = true;
    setTalkAutoplay(true);
    setSelectedVoiceLineIndex(startIndex);
    queueNextAutoTalk(startIndex, voiceRunRef.current);
  };

  const handleCompositionFinished = () => {
    const recording = videoRecordingRunRef.current;
    if (recording?.source === "composition") {
      if (recording.settings.mode === "full-sequence") return;
      if (recording.phase === "opening") {
        recording.phase = "idle";
        recording.idleStartedAt = performance.now();
        setIdleMode("persistent");
      }
      return;
    }
    const opening = selectedInteractionProject ? timelineForSequence(selectedInteractionProject, "opening") : null;
    const authoredAutoplay = talkAutoplayRef.current && authoredTalkSequenceIds.length > 0 && Boolean(opening);

    if (idleMode === "bridge") {
      const nextId = authoredAutoplay ? authoredTalkSequenceIds[authoredTalkIndexRef.current++] : undefined;
      const next = nextId && selectedInteractionProject ? timelineForSequence(selectedInteractionProject, nextId) : null;
      if (next && nextId) {
        setIdleMode("none");
        setSelectedSequenceId(nextId);
        setProgress({ time: 0, duration: projectTimelineDuration(next, selectedInteractionProject), animation: null });
      } else {
        talkAutoplayRef.current = false;
        setTalkAutoplay(false);
        setIdleMode("persistent");
      }
      setPlaying(true);
      return;
    }

    if (compositionSequenceId.startsWith("talk-")) {
      // Each Talk already blends out to idle over its final mix interval. Start
      // the next authored Talk at that boundary rather than inserting a second
      // idle bridge that makes the Talk-to-Talk autoplay transition feel cut.
      const nextId = authoredAutoplay ? authoredTalkSequenceIds[authoredTalkIndexRef.current++] : undefined;
      const next = nextId && selectedInteractionProject ? timelineForSequence(selectedInteractionProject, nextId) : null;
      if (next && nextId) {
        setIdleMode("none");
        setSelectedSequenceId(nextId);
        setProgress({ time: 0, duration: projectTimelineDuration(next, selectedInteractionProject), animation: null });
        setPlaying(true);
        return;
      }
      if (authoredAutoplay) {
        talkAutoplayRef.current = false;
        authoredTalkIndexRef.current = 0;
        setTalkAutoplay(false);
      }
      setProgress({ time: 0, duration: Math.max(0.01, compositionTimeline?.openingIdleDuration ?? 3), animation: null });
      setIdleMode("persistent");
      setPlaying(true);
      return;
    }

    if (compositionSequenceId === "opening") {
      if (idleMode === "none") {
        // The first opening is one-shot. Keep the same renderers and continue
        // their clocks in persistent idle instead of stopping on the last
        // opening frame.
        setIdleMode("persistent");
        setPlaying(true);
        return;
      }
    }

    // Keep the final idle pose visible after the one-shot tour completes.
    talkAutoplayRef.current = false;
    authoredTalkIndexRef.current = 0;
    setIdleMode("persistent");
    setTalkAutoplay(false);
    setPlaying(true);
  };

  const prepareDesktopAudioTracks = async (run: VideoRecordingRun, metrics: { openingDuration?: number; introMarkers?: number[] }) => {
    const plan = run.plan;
    if (!plan || !run.settings.includeAudio || (run.settings.mode !== "opening-idle" && run.settings.mode !== "full-sequence") || !source) return;
    const addTrack = (file: File, start: number, end: number, volume: number, sequenceId: string) => {
      const schedule = videoRecordingAudioSchedule(start, end, volume, plan.totalDuration);
      if (!schedule) return;
      const extension = recordingAudioExtension(file);
      if (!extension) throw new Error(t("spine.recorder.audioFormat", { name: file.name }));
      run.desktopAudioTracks.push({ file, ...schedule, extension, sequenceId });
    };

    if (run.source === "composition" && selectedInteractionProject) {
      if (run.settings.mode === "full-sequence" && plan.segments) {
        let offset = 0;
        for (const segment of plan.segments) {
          if (segment.kind === "opening" || segment.kind === "talk") {
            const timeline = segment.sequenceId ? timelineForSequence(selectedInteractionProject, segment.sequenceId) : null;
            for (const clip of timeline?.audio ?? []) {
              if (!clip.enabled || clip.start >= segment.duration) continue;
              const file = await loadRecordingAudioFile(source, clip.path);
              if (!file) continue;
              addTrack(file, offset + clip.start, offset + Math.min(segment.duration, clip.end), clip.volume, segment.sequenceId ?? "opening");
            }
          }
          offset += segment.duration;
        }
        return;
      }
      for (const clip of compositionTimeline?.audio ?? []) {
        if (!clip.enabled || clip.start >= plan.totalDuration) continue;
        const file = await loadRecordingAudioFile(source, clip.path);
        if (!file) continue;
        addTrack(file, clip.start, clip.end, clip.volume, compositionTimeline?.sequenceId ?? "opening");
      }
      return;
    }

    if (!voiceEnabled || !introVoiceLine) return;
    const markers = metrics.introMarkers?.length ? metrics.introMarkers : introVoiceLine.markers ?? [];
    let sequentialStart = 0;
    for (let index = 0; index < introVoiceLine.audio.length; index++) {
      const path = introVoiceLine.audio[index];
      if (!path) continue;
      const file = await loadRecordingAudioFile(source, path);
      if (!file) continue;
      const preloaded = await cachedVoiceAudio(voiceAudioCacheRef.current, source, path);
      if (preloaded) await preloaded.ready;
      const audioDuration = preloaded?.audio.duration;
      const marker = markers[index];
      const start = Number.isFinite(marker) ? Math.max(0, marker!) : sequentialStart;
      const segmentDuration = Number.isFinite(audioDuration) && audioDuration! > 0
        ? audioDuration!
        : Math.max(0, plan.openingDuration - start);
      if (start >= plan.openingDuration || segmentDuration <= 0) continue;
      addTrack(file, start, start + segmentDuration, normalizeVoiceVolume(voiceVolume), "opening");
      if (showDialogue) run.runtimeSubtitleSegments.push({ start, end: start + segmentDuration, clipIndex: index });
      sequentialStart = Math.max(sequentialStart, start + segmentDuration);
    }
  };

  const restoreVideoRecording = (
    run: VideoRecordingRun,
    failure?: string,
    savedFileName?: string,
    encoder?: string,
    result?: { encoderHardware?: boolean; encoderAttempt?: number; encoderAttempts?: number; outputBytes?: number },
  ) => {
    if (videoRecordingRunRef.current !== run) return;
    stopVoice();
    run.capture?.stopDrawing();
    run.capture?.stopTracks();
    run.audioCapture?.stopTracks();
    (run.source === "composition" ? compositionRef.current : viewportRef.current)?.setResolutionScale(1);
    pendingVideoRestoreRef.current = run.snapshot;
    videoRecordingRunRef.current = null;
    setPlaying(false);
    setSelectedSequenceId(run.snapshot.sequenceId);
    setIdleMode(run.snapshot.idleMode);
    setProgress(run.snapshot.progress);
    setAnimation(run.snapshot.animation);
    setAnimationSelectionOrigin(run.snapshot.animationSelectionOrigin);
    setSkipIntro(run.snapshot.skipIntro);
    setSpeed(run.snapshot.speed);
    setLoop(run.snapshot.loop);
    setCameraMode(run.snapshot.cameraMode);
    setVideoRecorderDialog(failure
      ? { phase: "error", settings: run.settings, elapsed: 0, error: failure }
      : savedFileName
        ? {
          phase: "complete",
          settings: run.settings,
          elapsed: run.plan?.totalDuration ?? 0,
          framesRendered: run.desktopFrameCount,
          totalFrames: run.desktopTotalFrames,
          savedFileName,
          savedLocation: run.destination.locationName,
          encoder: encoder ?? (run.useFfmpeg ? undefined : "MediaRecorder (WebView)"),
          encoderHardware: result?.encoderHardware,
          encoderAttempt: result?.encoderAttempt,
          encoderAttempts: result?.encoderAttempts,
          outputBytes: result?.outputBytes,
          outputWidth: run.outputWidth,
          outputHeight: run.outputHeight,
          outputFrameRate: run.settings.frameRate,
          outputDurationSeconds: run.useFfmpeg && run.desktopTotalFrames > 0
            ? run.desktopTotalFrames / run.settings.frameRate
            : run.plan?.totalDuration,
          exportElapsedSeconds: Math.max(0, (performance.now() - run.exportStartedAt) / 1000),
          wallElapsedSeconds: Math.max(0, (performance.now() - run.exportStartedAt) / 1000),
        }
        : null);
  };

  const finalizeVideoRecording = async (run: VideoRecordingRun) => {
    if (run.finalized) return;
    run.finalized = true;
    let failure = run.failureMessage;
    let savedFileName: string | undefined;
    let encoder: string | undefined;
    let encoderHardware: boolean | undefined;
    let encoderAttempt: number | undefined;
    let encoderAttempts: number | undefined;
    let outputBytes: number | undefined;
    try {
      await run.desktopFrameTask?.catch(() => undefined);
      if (run.useFfmpeg) {
        await run.desktopStream?.close();
        run.desktopStream = null;
        if (failure || run.failureMessage) throw new Error(failure ?? run.failureMessage);
        if (run.saveWhenStopped) {
          if (!run.desktopSessionId) throw new Error("The Viewer FFmpeg session was not started.");
          const sessionId = run.desktopSessionId;
          const finish = finishDesktopFfmpegVideoRecording(sessionId, run.desktopFrameCount);
          let finished = false;
          void finish.then(() => { finished = true; }, () => { finished = true; });
          while (!finished) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
            if (finished) break;
            const status = await getDesktopFfmpegVideoStatus(sessionId).catch(() => null);
            if (!status) break;
            if (status.phase === "encoding" || status.phase === "saving") {
              const phase = status.phase;
              run.phase = phase;
              setVideoRecorderDialog((current) => current ? {
                ...current,
                phase,
                stageStartedAt: status.elapsedSeconds !== undefined
                  ? performance.now() - status.elapsedSeconds * 1000
                  : current.phase === phase ? current.stageStartedAt : performance.now(),
                stageElapsedSeconds: status.elapsedSeconds ?? (current.phase === phase ? current.stageElapsedSeconds : 0),
                encodeProgress: phase === "encoding" ? status.progress : undefined,
                encoder: status.encoder ?? current.encoder,
                encoderHardware: status.encoderHardware ?? current.encoderHardware,
                encoderAttempt: status.encoderAttempt,
                encoderAttempts: status.encoderAttempts,
                encodedFrames: status.framesEncoded,
                totalEncodedFrames: status.totalFrames,
                encodedTimeSeconds: status.encodedTimeSeconds,
                totalEncodeTimeSeconds: status.totalTimeSeconds,
                encodeFps: status.fps,
                encodeSpeed: status.speed,
                encodeEtaSeconds: status.etaSeconds,
                saveOperation: status.saveOperation,
                saveBytesCopied: status.saveBytesCopied,
                saveTotalBytes: status.saveTotalBytes,
              } : current);
            }
          }
          const result = await finish;
          savedFileName = result.fileName;
          encoder = result.encoder;
          encoderHardware = result.encoderHardware;
          encoderAttempt = result.encoderAttempt;
          encoderAttempts = result.encoderAttempts;
          outputBytes = result.outputBytes;
          run.desktopSessionId = null;
        } else if (run.desktopSessionId) {
          await cancelDesktopFfmpegVideoRecording(run.desktopSessionId);
          run.desktopSessionId = null;
        }
      } else {
        if (failure) throw new Error(failure);
        if (run.saveWhenStopped) {
          const mimeType = run.recorder?.mimeType || (run.settings.format === "webm" ? "video/webm" : "video/mp4");
          const blob = new Blob(run.chunks, { type: mimeType });
          if (blob.size === 0) throw new Error("The WebView exported an empty video.");
          const result = await run.destination.save(blob);
          savedFileName = typeof result === "string" ? result : run.destination.filename;
          outputBytes = blob.size;
        }
      }
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      if (run.desktopSessionId) {
        await cancelDesktopFfmpegVideoRecording(run.desktopSessionId).catch(() => undefined);
        run.desktopSessionId = null;
      }
    }
    restoreVideoRecording(run, failure, savedFileName, encoder, { encoderHardware, encoderAttempt, encoderAttempts, outputBytes });
  };

  const renderDesktopFfmpegFrames = async (run: VideoRecordingRun) => {
    const plan = run.plan;
    if (!plan || !run.desktopFrameCapture || !run.desktopStream) throw new Error("The FFmpeg frame renderer is not ready.");
    const waitForPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    run.desktopTotalFrames = videoRecordingFrameCount(plan.totalDuration, run.settings.frameRate);
    if (run.desktopTotalFrames < 1) throw new Error("The video export has no frames to render.");
    run.renderStartedAt = performance.now();
    run.startedAt ??= run.renderStartedAt;
    run.phase = "rendering";
    startVideoRecorderStage("rendering", { framesRendered: 0, totalFrames: run.desktopTotalFrames, detail: t("spine.recorder.rendering") });

    for (let index = 0; index < run.desktopTotalFrames; index++) {
      if (run.stopRequested) return;
      const time = index / run.settings.frameRate;
      let needsPaintWait = false;
      if (run.source === "composition") {
        if (run.settings.mode === "full-sequence") {
          const activeSegment = videoRecordingSegmentAt(plan, time);
          if (!activeSegment) throw new Error(t("spine.recorder.emptySequence"));
          if (activeSegment.index !== run.segmentIndex) {
            beginCompositionRecordingSegment(run, activeSegment.index);
            await waitForPaint();
            await waitForPaint();
          }
          compositionRef.current?.sampleRecordingFrame(activeSegment.elapsed, time);
          needsPaintWait = true;
        } else {
          const timelineTime = run.settings.mode === "idle-only" ? plan.openingDuration + time : time;
          const idle = run.settings.mode === "idle-only" || timelineTime >= plan.openingDuration;
          if (idle && run.phase !== "idle") {
            run.phase = "idle";
            setIdleMode("persistent");
            needsPaintWait = true;
          }
          compositionRef.current?.sampleRecordingFrame(timelineTime, time);
          needsPaintWait = true;
        }
      } else {
        const segment = run.settings.includeSubtitles
          ? run.runtimeSubtitleSegments.find((item) => time >= item.start && time < item.end)?.clipIndex ?? null
          : null;
        if (showDialogue && segment !== run.lastRuntimeSubtitleClip) {
          run.lastRuntimeSubtitleClip = segment;
          setVoiceLineIndex(segment === null ? null : -1);
          setVoiceClipIndex(segment ?? 0);
          needsPaintWait = true;
        }
        const advanced = viewportRef.current?.advanceRecordingFrame(index === 0 ? 0 : 1 / run.settings.frameRate);
        if (!advanced) throw new Error(t("spine.recorder.stageUnavailable"));
      }
      if (needsPaintWait) await waitForPaint();
      if (run.stopRequested) return;
      const frame = await run.desktopFrameCapture.captureFrame();
      await run.desktopStream.sendFrame(frame);
      run.desktopFrameCount = index + 1;
      if (index === 0 || index % run.settings.frameRate === 0 || index === run.desktopTotalFrames - 1) updateVideoRecorderPreview(frame);
      if (index % Math.max(1, Math.floor(run.settings.frameRate / 4)) === 0 || index === run.desktopTotalFrames - 1) {
        const elapsed = Math.min(plan.totalDuration, time);
        const renderElapsedSeconds = Math.max(0, (performance.now() - run.renderStartedAt!) / 1000);
        const renderFps = renderElapsedSeconds >= 0.25 ? run.desktopFrameCount / renderElapsedSeconds : undefined;
        setVideoRecorderDialog((current) => current ? {
          ...current,
          phase: "rendering",
          elapsed,
          framesRendered: run.desktopFrameCount,
          totalFrames: run.desktopTotalFrames,
          renderFps,
          renderEtaSeconds: renderFps && renderFps > 0 ? (run.desktopTotalFrames - run.desktopFrameCount) / renderFps : undefined,
          renderElapsedSeconds,
        } : current);
      }
    }

    if (run.stopRequested) return;
    run.phase = "mixing";
    startVideoRecorderStage("mixing", {
      elapsed: plan.totalDuration,
      framesRendered: run.desktopFrameCount,
      totalFrames: run.desktopTotalFrames,
      audioTracksMixed: 0,
      totalAudioTracks: run.desktopAudioTracks.length,
      currentAudioTrack: run.desktopAudioTracks[0]?.file.name,
      currentAudioSequence: run.desktopAudioTracks[0]?.sequenceId,
      detail: t("spine.recorder.mixing"),
    });
    for (let index = 0; index < run.desktopAudioTracks.length; index++) {
      if (run.stopRequested) return;
      const track = run.desktopAudioTracks[index]!;
      await addDesktopFfmpegAudioTrack(run.desktopSessionId!, track);
      setVideoRecorderDialog((current) => current ? {
        ...current,
        audioTracksMixed: index + 1,
        currentAudioTrack: track.file.name,
        currentAudioSequence: track.sequenceId,
      } : current);
    }
    if (run.stopRequested) return;
    run.phase = "encoding";
    run.saveWhenStopped = true;
    run.stopRequested = true;
    setPlaying(false);
    startVideoRecorderStage("encoding", {
      encodeProgress: 0,
      encodedFrames: 0,
      totalEncodedFrames: run.desktopFrameCount,
      encodedTimeSeconds: 0,
      totalEncodeTimeSeconds: plan.totalDuration,
      encodeFps: undefined,
      encodeSpeed: undefined,
      encodeEtaSeconds: undefined,
      encoder: undefined,
      encoderHardware: undefined,
      encoderAttempt: undefined,
      encoderAttempts: undefined,
      detail: t("spine.recorder.encoding"),
    });
  };

  const startDesktopFfmpegFrameRender = (run: VideoRecordingRun) => {
    const task = renderDesktopFfmpegFrames(run);
    run.desktopFrameTask = task;
    void task.then(() => {
      if (run.stopRequested && run.saveWhenStopped) void finalizeVideoRecording(run);
    }).catch((error: unknown) => {
      if (!run.stopRequested) stopVideoRecording(false, errorMessage(error));
      else if (run.failureMessage) void finalizeVideoRecording(run);
    });
  };

  const stopVideoRecording = (save: boolean, failure?: string) => {
    const run = videoRecordingRunRef.current;
    if (!run || run.stopRequested) return;
    run.stopRequested = true;
    run.saveWhenStopped = save;
    run.failureMessage = failure;
    run.phase = "stopping";
    setPlaying(false);
    const phase = failure ? "saving" : save ? "saving" : "canceling";
    startVideoRecorderStage(phase, { saveOperation: "finalizing", detail: t(phase === "saving" ? "spine.recorder.saving" : "spine.recorder.canceling") });
    run.capture?.stopDrawing();
    if (!run.recorder || run.recorder.state === "inactive") {
      void finalizeVideoRecording(run);
      return;
    }
    try {
      run.recorder.stop();
    } catch (error) {
      run.failureMessage = failure ?? errorMessage(error);
      void finalizeVideoRecording(run);
    }
  };

  const handleViewerProgress = (next: SpineProgress, sourceKind: "composition" | "runtime") => {
    progressRef.current = next;
    const run = videoRecordingRunRef.current;
    if (!run || run.phase === "preparing" || run.phase === "stopping" || run.source !== sourceKind || !run.plan) {
      setProgress(next);
      return;
    }
    const now = performance.now();
    if (!run.useFfmpeg && run.capture && now - run.lastPreviewAt >= 750) {
      run.lastPreviewAt = now;
      run.capture.canvas.toBlob((image) => { if (image && videoRecordingRunRef.current === run) updateVideoRecorderPreview(image); }, "image/jpeg", 0.82);
    }

    if (run.settings.mode === "full-sequence" && sourceKind === "composition" && run.plan.segments) {
      if (run.useFfmpeg) {
        setProgress(next);
        return;
      }
      if (run.segmentIndex < 0) beginCompositionRecordingSegment(run, 0);
      const segment = run.plan.segments[run.segmentIndex];
      if (!segment) {
        stopVideoRecording(false, t("spine.recorder.emptySequence"));
        return;
      }
      run.segmentStartedAt ??= now;
      const localElapsed = Math.max(0, (now - run.segmentStartedAt) / 1000);
      const elapsed = Math.min(run.plan.totalDuration, run.segmentTimelineStart + localElapsed);
      if (localElapsed >= segment.duration) {
        const nextIndex = run.segmentIndex + 1;
        if (nextIndex < run.plan.segments.length) beginCompositionRecordingSegment(run, nextIndex);
        else {
          setProgress(next);
          setVideoRecorderDialog((current) => current ? { ...current, elapsed: run.plan!.totalDuration } : current);
          stopVideoRecording(true);
        }
        return;
      }
      setProgress(next);
      if (now - run.lastUiUpdate >= 180) {
        run.lastUiUpdate = now;
        const recordingProgress = videoRecordingProgress(run.plan, elapsed);
        setVideoRecorderDialog((current) => current ? {
          ...current,
          elapsed: recordingProgress.elapsed,
        } : current);
      }
      return;
    }

    if (run.useFfmpeg) {
      if (sourceKind === "composition") setProgress(next);
      return;
    }

    let elapsed: number;
    if (sourceKind === "composition") {
      if (run.phase === "opening" && next.time >= run.plan.openingDuration) {
        run.phase = "idle";
        run.idleStartedAt = now;
        setIdleMode("persistent");
      }
      elapsed = run.settings.mode === "idle-only"
        ? Math.max(0, next.time - run.plan.openingDuration)
        : next.time;
    } else {
      if (run.phase === "opening" && next.animation && next.animation !== meta?.introAnimation) {
        run.phase = "idle";
        run.idleStartedAt = now;
      }
      if (run.settings.mode === "idle-only") elapsed = (now - (run.startedAt ?? now)) / 1000;
      else if (run.phase === "opening") elapsed = Math.min(run.plan.openingDuration, next.time);
      else elapsed = run.plan.openingDuration + Math.max(0, now - (run.idleStartedAt ?? now)) / 1000;
    }

    const recordingProgress = videoRecordingProgress(run.plan, elapsed);
    // Composition time is an input back into its synchronized renderers, so
    // keep that clock current. Runtime playback is internally clocked and only
    // needs occasional React updates for the inert recording dialog.
    if (sourceKind === "composition") setProgress(next);
    if (now - run.lastUiUpdate >= 180 || recordingProgress.finished) {
      run.lastUiUpdate = now;
      if (sourceKind === "runtime") setProgress(next);
      setVideoRecorderDialog((current) => current ? {
        ...current,
        elapsed: recordingProgress.elapsed,
      } : current);
    }
    if (recordingProgress.finished) stopVideoRecording(true);
  };

  const openVideoRecorder = () => {
    if (interactionMode !== "interaction") return;
    videoRecorderCameraPoseRef.current = activeViewport()?.getCameraPose() ?? null;
    clearVideoRecorderPreview();
    const settings = videoRecorderTalkSelectionInitialized
      ? videoRecorderSettings
      : { ...videoRecorderSettings, talkSequenceIds: authoredTalkSequenceIds };
    if (!videoRecorderTalkSelectionInitialized) {
      setVideoRecorderTalkSelectionInitialized(true);
      setVideoRecorderSettings(settings);
    }
    setVideoRecorderDialog({ phase: "settings", settings, elapsed: 0 });
  };

  const updateVideoRecorderSettings = (patch: Partial<VideoRecordingSettings>) => {
    if (patch.talkSequenceIds) setVideoRecorderTalkSelectionInitialized(true);
    setVideoRecorderSettings((current) => ({ ...current, ...patch }));
    setVideoRecorderDialog((current) => current?.phase === "settings"
      ? { ...current, settings: { ...current.settings, ...patch } }
      : current);
  };

  const beginCompositionRecordingSegment = (run: VideoRecordingRun, index: number) => {
    const plan = run.plan;
    const segments = plan?.segments;
    const segment = segments?.[index];
    if (!plan || !segments || !segment) return;
    const targetSequenceId = segment.sequenceId ?? run.activeSequenceId ?? compositionSequenceId;
    const targetTimeline = selectedInteractionProject && targetSequenceId
      ? timelineForSequence(selectedInteractionProject, targetSequenceId)
      : compositionTimeline;
    const sequenceChanged = Boolean(targetSequenceId && targetSequenceId !== run.activeSequenceId);
    const idleSegment = segment.kind !== "opening" && segment.kind !== "talk";
    run.segmentIndex = index;
    run.segmentStartedAt = run.startedAt === null ? null : performance.now();
    run.segmentTimelineStart = segments.slice(0, index).reduce((total, item) => total + item.duration, 0);
    run.activeSequenceId = targetSequenceId || null;
    run.phase = segment.kind === "opening" ? "opening" : "idle";
    if (sequenceChanged && targetSequenceId) setSelectedSequenceId(targetSequenceId);
    setIdleMode(idleSegment ? "persistent" : "none");
    if (sequenceChanged || index === 0 || !idleSegment) {
      setProgress({
        time: 0,
        duration: targetTimeline ? projectTimelineDuration(targetTimeline, selectedInteractionProject) : 0,
        animation: null,
      });
    }
  };

  const startVideoRecording = async () => {
    if (interactionMode !== "interaction") return;
    if (!videoRecorderDialog || videoRecorderDialog.phase !== "settings") return;
    const settings = videoRecorderDialog.settings;
    const selectedFormat = videoRecorderFormats.find((item) => item.format === settings.format);
    if (!selectedFormat) {
      setVideoRecorderDialog({ ...videoRecorderDialog, phase: "error", error: t("spine.recorder.unsupported") });
      return;
    }
    if (settings.mode === "full-sequence" && (!selectedInteractionProject || !compositionActive)) {
      setVideoRecorderDialog({ ...videoRecorderDialog, phase: "error", error: t("spine.recorder.fullSequenceUnavailable") });
      return;
    }
    const modeName = settings.mode;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputName = `${videoFilenameStem(`${selectedCharacter} ${modeName} ${timestamp}`)}.${settings.format}`;
    let destination: VideoDestination | null;
    try {
      destination = await chooseVideoDestination(settings.format, outputName.replace(/\.[^.]+$/, ""));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setVideoRecorderDialog({ ...videoRecorderDialog, phase: "error", error: errorMessage(error) });
      return;
    }
    if (!destination || videoRecorderDialogRef.current?.phase !== "settings") return;

    const recordingUsesComposition = settings.mode === "full-sequence"
      ? Boolean(compositionActive && selectedInteractionProject)
      : compositionActive || hasOpeningSequence;
    const exportStartedAt = performance.now();
    const outputDimensions = videoRecordingDimensions(settings.resolution, outputAspectRatio);
    const snapshot: ViewerPlaybackSnapshot = {
      sequenceId: selectedSequenceId,
      progress: { ...progressRef.current },
      playing,
      speed,
      loop,
      idleMode,
      animation,
      animationSelectionOrigin,
      skipIntro,
      cameraMode,
      cameraPose: videoRecorderCameraPoseRef.current ?? activeViewport()?.getCameraPose() ?? null,
    };
    const run: VideoRecordingRun = {
      settings,
      useFfmpeg: isDesktopHost() && desktopFfmpegFormats.includes(settings.format),
      destination,
      snapshot,
      phase: "preparing",
      plan: null,
      recorder: null,
      capture: null,
      audioCapture: null,
      desktopSessionId: null,
      desktopStream: null,
      desktopFrameCapture: null,
      desktopFrameTask: null,
      desktopAudioTracks: [],
      runtimeSubtitleSegments: [],
      lastRuntimeSubtitleClip: null,
      desktopFrameCount: 0,
      desktopTotalFrames: 0,
      renderStartedAt: null,
      exportStartedAt,
      outputWidth: outputDimensions.width,
      outputHeight: outputDimensions.height,
      chunks: [],
      saveWhenStopped: false,
      stopRequested: false,
      preparationStarted: false,
      finalized: false,
      idleStartedAt: null,
      startedAt: null,
      segmentIndex: -1,
      segmentStartedAt: null,
      segmentTimelineStart: 0,
      activeSequenceId: selectedSequenceId || null,
      lastPreviewAt: 0,
      lastUiUpdate: 0,
      source: recordingUsesComposition ? "composition" : "runtime",
    };
    videoRecordingRunRef.current = run;
    setVideoRecorderSettings(settings);
    setVideoRecorderDialog({
      phase: "preparing",
      settings,
      elapsed: 0,
      stageStartedAt: exportStartedAt,
      stageElapsedSeconds: 0,
      totalStartedAt: exportStartedAt,
      wallElapsedSeconds: 0,
      detail: t("spine.recorder.waiting"),
    });
    stopVoice();
    talkAutoplayRef.current = false;
    setTalkAutoplay(false);
    setPlaying(false);
    setSpeed(1);
    setLoop(true);

    if (recordingUsesComposition) {
      const sequenceId = compositionSequenceIds.includes("opening") ? "opening" : compositionSequenceId;
      const timeline = selectedInteractionProject && sequenceId ? timelineForSequence(selectedInteractionProject, sequenceId) : compositionTimeline;
      run.activeSequenceId = sequenceId || null;
      setSelectedSequenceId(sequenceId);
      const startsWithOpening = settings.mode === "opening-idle"
        ? Boolean(meta?.introAnimation && sequenceId === "opening")
        : settings.mode === "full-sequence"
          ? settings.includeOpening && sequenceId === "opening"
          : false;
      setIdleMode(settings.mode === "idle-only" || (settings.mode === "full-sequence" && !startsWithOpening) ? "persistent" : "none");
      setProgress({ time: 0, duration: timeline ? projectTimelineDuration(timeline, selectedInteractionProject) : 0, animation: null });
    } else if (settings.mode === "idle-only" || !meta?.introAnimation) {
      const idleAnimation = meta?.idleAnimation || animation;
      setAnimation(idleAnimation);
      setAnimationSelectionOrigin("explicit");
      setProgress({ time: 0, duration: meta?.duration ?? 0, animation: null });
    } else {
      setSkipIntro(false);
      setAnimation(INTRO_ANIMATION);
      setAnimationSelectionOrigin("explicit");
      setProgress({ time: 0, duration: meta.duration, animation: null });
    }
  };

  useEffect(() => {
    const run = videoRecordingRunRef.current;
    if (!run || run.phase !== "preparing" || videoRecorderDialog?.phase !== "preparing" || run.preparationStarted) return;
    if (isLoading || backgroundAudioLoading || !meta || !selectedDirectoryName) return;
    if (run.source === "composition" && !compositionActive) return;
    run.preparationStarted = true;
    setVideoRecorderDialog((current) => current ? { ...current, detail: t("spine.recorder.preparingOutput") } : current);
    void (async () => {
      const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await nextFrame();
      await nextFrame();
      if (videoRecordingRunRef.current !== run) return;
      if (!videoRecorderReadyRef.current) {
        run.preparationStarted = false;
        return;
      }
      const metrics = run.source === "composition"
        ? compositionRef.current?.getRecordingMetrics(run.settings.mode === "full-sequence" ? openingTimelineForRecording ?? undefined : undefined, run.settings.mode === "full-sequence")
        : viewportRef.current?.getRecordingMetrics();
      if (!metrics?.ready) {
        run.preparationStarted = false;
        return;
      }
      if (!metrics || metrics.idleDuration <= 0) throw new Error(t("spine.recorder.noIdle"));
      const selectedFormat = videoRecorderFormats.find((item) => item.format === run.settings.format);
      if (!selectedFormat) throw new Error(t("spine.recorder.unsupported"));
      run.plan = run.settings.mode === "full-sequence"
        ? selectedInteractionProject
          ? fullSequenceRecordingPlan(selectedInteractionProject, run.settings, metrics)
          : null
        : createVideoRecordingPlan(run.settings.mode, metrics.openingDuration, metrics.idleDuration, run.settings.idleLoops);
      if (!run.plan || run.plan.totalDuration <= 0) throw new Error(t("spine.recorder.emptySequence"));
      if (run.source === "composition") {
        if (run.settings.mode === "full-sequence") {
          beginCompositionRecordingSegment(run, 0);
          compositionRef.current?.sampleRecordingFrame(0, 0);
        } else if (run.settings.mode === "idle-only" || run.plan.openingDuration <= 0) {
          setIdleMode("persistent");
          compositionRef.current?.sampleRecordingFrame(0, 0);
        } else {
          setIdleMode("none");
          compositionRef.current?.sampleRecordingFrame(0, 0);
        }
      } else if (run.useFfmpeg) {
        const includeOpening = run.settings.mode === "opening-idle" && run.plan.openingDuration > 0;
        if (!viewportRef.current?.prepareRecordingPlayback(includeOpening)) throw new Error(t("spine.recorder.noIdle"));
        setAnimationSelectionOrigin("explicit");
      } else if (run.settings.mode === "idle-only" || run.plan.openingDuration <= 0) {
        const idleAnimation = metrics.idleAnimation || meta.idleAnimation || animation;
        setAnimation(idleAnimation);
        setAnimationSelectionOrigin("explicit");
        viewportRef.current?.setAnimation(idleAnimation);
        viewportRef.current?.seek(0);
      } else {
        setSkipIntro(false);
        setAnimation(INTRO_ANIMATION);
        setAnimationSelectionOrigin("explicit");
        viewportRef.current?.replayIntro();
      }
      if (run.settings.framing === "current") {
        const viewport = run.source === "composition" ? compositionRef.current : viewportRef.current;
        viewport?.setCameraPose(run.snapshot.cameraPose);
      }
      await nextFrame();
      await nextFrame();
      if (videoRecordingRunRef.current !== run) return;
      const stageFrame = stageFrameRef.current;
      const stage = stageFrame?.querySelector<HTMLElement>(".spine-stage");
      if (!stage) throw new Error(t("spine.recorder.stageUnavailable"));
      const dimensions = videoRecordingDimensions(run.settings.resolution, outputAspectRatio);
      const stageBounds = stage.getBoundingClientRect();
      const resolutionScale = videoRecordingResolutionScale(
        stageBounds.width,
        stageBounds.height,
        dimensions.width,
        dimensions.height,
        window.devicePixelRatio || 1,
      );
      const viewport = run.source === "composition" ? compositionRef.current : viewportRef.current;
      viewport?.setResolutionScale(resolutionScale, true);
      await nextFrame();
      await nextFrame();
      if (videoRecordingRunRef.current !== run || run.stopRequested) return;
      const audioElements = [
        ...Array.from(stageFrame?.querySelectorAll<HTMLMediaElement>("audio") ?? []),
        ...(voiceAudioRef.current ? [voiceAudioRef.current] : []),
      ];
      if (run.useFfmpeg) {
        await nextFrame();
        await nextFrame();
        if (videoRecordingRunRef.current !== run || run.stopRequested) return;
        const sessionId = await startDesktopFfmpegVideoRecording({
          filename: run.destination.filename,
          width: dimensions.width,
          height: dimensions.height,
          frameRate: run.settings.frameRate,
          format: run.settings.format,
        });
        if (videoRecordingRunRef.current !== run || run.stopRequested) {
          await cancelDesktopFfmpegVideoRecording(sessionId);
          return;
        }
        run.desktopSessionId = sessionId;
        const stream = await openDesktopFfmpegVideoStream(sessionId);
        if (videoRecordingRunRef.current !== run || run.stopRequested) {
          await stream.close();
          await cancelDesktopFfmpegVideoRecording(sessionId);
          run.desktopSessionId = null;
          return;
        }
        run.desktopStream = stream;
        run.desktopFrameCapture = createCanvasFrameCapture({
          stage,
          width: dimensions.width,
          height: dimensions.height,
          includeSubtitles: run.settings.includeSubtitles,
        });
        await prepareDesktopAudioTracks(run, metrics);
      } else {
        const capture = await createCanvasRecordingCapture({
          stage,
          width: dimensions.width,
          height: dimensions.height,
          frameRate: run.settings.frameRate,
          includeAudio: run.settings.includeAudio,
          includeSubtitles: run.settings.includeSubtitles,
          audioElements,
          mimeType: selectedFormat.mimeType,
        });
        if (videoRecordingRunRef.current !== run || run.stopRequested) {
          capture.stopDrawing();
          capture.stopTracks();
          return;
        }
        run.capture = capture;
        run.recorder = capture.recorder;
        capture.recorder.ondataavailable = (event) => { if (event.data.size > 0) run.chunks.push(event.data); };
        capture.recorder.onerror = (event) => {
          const recorderError = (event as Event & { error?: DOMException }).error;
          stopVideoRecording(false, recorderError?.message || t("spine.recorder.encodeError"));
        };
        capture.recorder.onstop = () => { void finalizeVideoRecording(run); };
      }
      run.phase = run.settings.mode === "full-sequence"
        ? run.plan.segments?.[run.segmentIndex]?.kind === "opening" ? "opening" : "idle"
        : run.settings.mode === "opening-idle" && run.plan.openingDuration > 0 ? "opening" : "idle";
      run.recorder?.start(1000);
      await nextFrame();
      await nextFrame();
      if (videoRecordingRunRef.current === run && !run.stopRequested) {
        if (run.useFfmpeg) {
          startDesktopFfmpegFrameRender(run);
          return;
        }
        run.startedAt = performance.now();
        if (run.settings.mode === "full-sequence") run.segmentStartedAt = run.startedAt;
        if (run.phase === "idle") run.idleStartedAt = run.startedAt;
        startVideoRecorderStage("recording", { elapsed: 0, detail: t("spine.recorder.recording") });
        run.audioCapture?.start();
        setPlaying(true);
      }
    })().catch((error: unknown) => stopVideoRecording(false, errorMessage(error)));
  }, [animation, backgroundAudioLoading, compositionActive, compositionLoadProgress, compositionSequenceId, isLoading, meta, outputAspectRatio, selectedDirectoryName, videoRecorderFormats, videoRecorderDialog?.phase]);

  useEffect(() => {
    const snapshot = pendingVideoRestoreRef.current;
    if (!snapshot || videoRecordingRunRef.current || isLoading) return;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingVideoRestoreRef.current !== snapshot || videoRecordingRunRef.current) return;
        pendingVideoRestoreRef.current = null;
        const viewport = compositionActive ? compositionRef.current : viewportRef.current;
        if (!compositionActive) {
          setAnimation(snapshot.animation);
          setAnimationSelectionOrigin(snapshot.animationSelectionOrigin);
          viewportRef.current?.setAnimation(snapshot.animation);
        }
        viewport?.setCameraPose(snapshot.cameraPose);
        viewport?.seek(snapshot.progress.time);
        setPlaying(snapshot.playing);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [compositionActive, compositionSequenceId, idleMode, isLoading, selectedDirectoryName, videoRecorderDialog?.phase]);

  const togglePlayback = () => setPlaying((value) => !value);

  const toggleViewerFullscreen = async () => {
    if (isDesktopHost()) {
      await setDesktopFullscreen(!fullscreen);
      return;
    }
    await activeViewport()?.toggleFullscreen();
  };

  const restartPlayback = () => {
    stopVoice();
    setPlaying(true);
    if (compositionActive && selectedInteractionProject && timelineForSequence(selectedInteractionProject, "opening")) {
      setIdleMode("none");
      setSelectedSequenceId("opening");
      setProgress({ time: 0, duration: projectTimelineDuration(timelineForSequence(selectedInteractionProject, "opening")!, selectedInteractionProject), animation: null });
      return;
    }
    setProgress((current) => ({ ...current, time: 0 }));
    activeViewport()?.restartPlayback();
  };

  const restartOpening = () => {
    stopVoice();
    setPlaying(true);
    const opening = selectedInteractionProject ? timelineForSequence(selectedInteractionProject, "opening") : null;
    if (opening && selectedInteractionProject) {
      const alreadyOpening = compositionSequenceId === "opening";
      setIdleMode("none");
      setSelectedSequenceId("opening");
      setProgress({ time: 0, duration: projectTimelineDuration(opening, selectedInteractionProject), animation: null });
      if (alreadyOpening) compositionRef.current?.seek(0);
      return;
    }
    if (!compositionActive && meta?.introAnimation && meta.idleAnimation) {
      setAnimation(INTRO_ANIMATION);
      setAnimationSelectionOrigin("explicit");
      setProgress((current) => ({ ...current, time: 0 }));
      viewportRef.current?.replayIntro();
    }
  };

  const handleViewportMeta = (next: SpineMeta | null) => {
    const pendingRestore = pendingHandoffRestoreRef.current;
    const restoring = pendingRestore?.lobbyId === selectedDirectoryName ? pendingRestore.state : null;
    setMeta(next);
    if (!next && restoring) return;
    const restoredAnimation = restoring?.animation && next && (
      next.animations.includes(restoring.animation)
      || (restoring.animation === INTRO_ANIMATION && Boolean(next.introAnimation && next.idleAnimation))
    )
      ? restoring.animation
      : undefined;
    const nextAnimation = restoredAnimation ?? (skipIntro && next?.idleAnimation ? next.idleAnimation : next?.defaultAnimation ?? "");
    setAnimation(nextAnimation);
    setAnimationSelectionOrigin(restoredAnimation ? "explicit" : "automatic");
    setCameraMode(interactionMode === "free"
      ? "artwork"
      : compositionTimeline?.camera?.enabled ? "authored" : "fit");
    if (next && restoring) {
      if (restoredAnimation && interactionMode === "free" && !compositionActive) viewportRef.current?.setAnimation(restoredAnimation);
      if (restoring.cameraPose) {
        if (compositionActive) compositionRef.current?.setCameraPose(restoring.cameraPose);
        else viewportRef.current?.setCameraPose(restoring.cameraPose);
      }
      if (restoring.playheadSeconds !== undefined) {
        const duration = compositionActive && compositionTimeline
          ? projectTimelineDuration(compositionTimeline, selectedInteractionProject)
          : next.duration;
        const time = Math.max(0, Math.min(restoring.playheadSeconds, duration));
        setProgress({ time, duration, animation: nextAnimation || null });
        if (compositionActive) compositionRef.current?.seek(time);
        else viewportRef.current?.seek(time);
      }
      pendingHandoffRestoreRef.current = null;
    }
    if (!next && !compositionActive) setProgress({ time: 0, duration: 0, animation: null });
  };

  const handleViewportError = (next: Error | null) => {
    if (next) pendingHandoffRestoreRef.current = null;
    setError(next ? t("spine.error.render", { error: next.message }) : null);
  };

  const seekPlayback = (time: number) => {
    const duration = progressRef.current.duration;
    if (duration <= 0) return;
    activeViewport()?.seek(Math.max(0, Math.min(duration, time)));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      if (videoRecorderDialog) {
        if (key === "escape") {
          event.preventDefault();
          if (videoRecorderDialog.phase === "settings" || videoRecorderDialog.phase === "error" || videoRecorderDialog.phase === "complete") setVideoRecorderDialog(null);
          else if (videoRecorderDialog.phase === "preparing" || videoRecorderDialog.phase === "recording" || videoRecorderDialog.phase === "rendering" || videoRecorderDialog.phase === "mixing") stopVideoRecording(false);
        }
        return;
      }
      if (key === "escape") {
        if (target?.closest("input, select, textarea, [contenteditable]")) return;
        if (showOptions) {
          event.preventDefault();
          setShowOptions(false);
          return;
        }
        if (fullscreen) {
          event.preventDefault();
          if (isDesktopHost()) void setDesktopFullscreen(false);
          else if (document.fullscreenElement) void document.exitFullscreen();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (target?.closest("input, select, textarea, button, a, [contenteditable]")) return;

      if (key === "arrowleft" || key === "arrowright") {
        const current = progressRef.current;
        if (current.duration <= 0) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 5;
        seekPlayback(current.time + (key === "arrowleft" ? -step : step));
        return;
      }
      if (key === "home" || key === "end") {
        const current = progressRef.current;
        if (current.duration <= 0) return;
        event.preventDefault();
        seekPlayback(key === "home" ? 0 : current.duration);
        return;
      }
      if (event.shiftKey) return;

      if (event.code === "Space") {
        if (interactionMode !== "free" || !meta) return;
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (key === "r" && meta) {
        event.preventDefault();
        restartPlayback();
      } else if (key === "t" && interactionReady) {
        event.preventDefault();
        playTalk();
      } else if (key === "f") {
        event.preventDefault();
        void toggleViewerFullscreen();
      } else if (key === "i") {
        event.preventDefault();
        selectInteractionMode("interaction");
      } else if (key === "p") {
        event.preventDefault();
        selectInteractionMode("free");
      } else if (key === "o") {
        event.preventDefault();
        setShowOptions((shown) => !shown);
      } else if (key === "l" && meta && interactionMode === "free" && !compositionActive) {
        event.preventDefault();
        setLoop((value) => !value);
      } else if (key === "v" && voiceLines.length > 0) {
        event.preventDefault();
        setVoiceEnabled((value) => !value);
      } else if (key === "0" && meta) {
        event.preventDefault();
        activeViewport()?.resetCamera();
      } else if (key === "h" && fullscreen) {
        event.preventDefault();
        if (fullscreenClean) exitCleanFullscreen();
        else if (showFullscreenControls) hideFullscreenControls();
        else revealFullscreenControls();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cameraMode, compositionActive, compositionSequenceId, fullscreen, fullscreenClean, interactionMode, interactionReady, loop, meta, playing, selectedInteractionProject, showFullscreenControls, showOptions, speed, videoRecorderDialog, voiceLines.length]);

  const showAspectRatioControl = interactionMode === "interaction";
  const viewportCameraMode: SpineCameraMode = savedCameraForRecording ? "fit" : interactionMode === "free" ? "artwork" : "fit";
  const hasOpeningSequence = Boolean(selectedInteractionProject && compositionSequenceIds.includes("opening"));
  const canRestartOpening = hasOpeningSequence || (!compositionActive && Boolean(meta?.introAnimation && meta.idleAnimation));
  const recorderSettings = videoRecorderDialog?.settings ?? videoRecorderSettings;
  const recorderMetrics = compositionActive ? compositionRef.current?.getRecordingMetrics() : viewportRef.current?.getRecordingMetrics();
  const openingTimelineForRecording = selectedInteractionProject ? timelineForSequence(selectedInteractionProject, "opening") : null;
  const fullSequenceMetrics = compositionActive && openingTimelineForRecording
    ? compositionRef.current?.getRecordingMetrics(openingTimelineForRecording, true)
    : recorderMetrics;
  const recorderTalkOptions = selectedInteractionProject ? authoredTalkSequenceIds.map((sequenceId) => {
    const timeline = timelineForSequence(selectedInteractionProject, sequenceId);
    const characterLayer = timeline?.layers.find((layer) => layer.role === "character");
    let missingReason = "";
    if (!characterLayer || !characterLayer.enabled) missingReason = t("spine.recorder.missingCharacter");
    else if (availableDirectories && !availableDirectories.has(characterLayer.directory) && !timeline?.assetPaths?.[characterLayer.directory]) missingReason = t("spine.recorder.missingAssets");
    else if (meta && characterLayer.directory === selectedDirectoryName) {
      const talkAnimations = [characterLayer.animation, ...(characterLayer.animationClips ?? []).map((clip) => clip.animation)]
        .filter((animation) => /^talk/i.test(animation));
      const unavailable = talkAnimations.find((animation) => !meta.animations.some((name) => name.toLocaleLowerCase() === animation.toLocaleLowerCase()));
      if (unavailable) missingReason = t("spine.recorder.missingAnimation", { name: unavailable });
    }
    return { sequenceId, timeline, missingReason, duration: timeline ? projectTimelineDuration(timeline, selectedInteractionProject) : 0 };
  }) : [];
  const selectedMissingTalks = recorderTalkOptions.filter((talk) => recorderSettings.talkSequenceIds.includes(talk.sequenceId) && talk.missingReason);
  const estimatedFullSequencePlan = selectedInteractionProject && fullSequenceMetrics?.ready && fullSequenceMetrics.idleDuration > 0
    ? fullSequenceRecordingPlan(selectedInteractionProject, recorderSettings, fullSequenceMetrics)
    : null;
  const recorderEstimate = videoRecorderDialog?.phase === "settings"
    ? recorderSettings.mode === "full-sequence"
      ? estimatedFullSequencePlan
      : recorderMetrics?.ready && recorderMetrics.idleDuration > 0
        ? createVideoRecordingPlan(recorderSettings.mode, recorderMetrics.openingDuration, recorderMetrics.idleDuration, recorderSettings.idleLoops)
        : null
    : null;
  const recorderEstimateFrames = recorderEstimate ? videoRecordingFrameCount(recorderEstimate.totalDuration, recorderSettings.frameRate) : 0;
  const recorderUsesFfmpeg = isDesktopHost() && desktopFfmpegFormats.includes(recorderSettings.format);
  const activeExportRun = videoRecordingRunRef.current;
  const activeRecordingSegment = activeExportRun?.plan?.segments?.[activeExportRun.segmentIndex];
  const recordingIdleOverride = activeExportRun?.source === "composition"
    && activeExportRun.settings.mode === "full-sequence"
    && Boolean(activeRecordingSegment && activeRecordingSegment.kind !== "opening" && activeRecordingSegment.kind !== "talk");
  const activeExportProgress = activeExportRun?.plan
    ? videoRecordingProgress(activeExportRun.plan, videoRecorderDialog?.elapsed ?? 0)
    : null;
  const recorderSegmentLabel = activeExportProgress?.segment
    ? activeExportProgress.segment.kind === "opening" ? t("spine.recorder.segment.opening")
      : activeExportProgress.segment.kind === "initial-idle" ? t("spine.recorder.segment.initialIdle")
        : activeExportProgress.segment.kind === "between-idle" ? t("spine.recorder.segment.betweenIdle")
          : activeExportProgress.segment.kind === "talk" ? t("spine.recorder.segment.talk", { n: activeExportProgress.segment.talkNumber ?? 0, total: activeExportProgress.segment.talkCount ?? 0 })
            : activeExportProgress.segment.kind === "final-idle" ? t("spine.recorder.segment.finalIdle")
              : t("spine.recorder.idleLoops")
    : "";
  const isExportProgressPhase = Boolean(videoRecorderDialog
    && videoRecorderDialog.phase !== "settings"
    && videoRecorderDialog.phase !== "error"
    && videoRecorderDialog.phase !== "complete");
  const activeExportUsesFfmpeg = activeExportRun?.useFfmpeg ?? recorderUsesFfmpeg;
  const recorderOutputDimensions = videoRecordingDimensions(recorderSettings.resolution, outputAspectRatio);
  const recorderStageItems = activeExportUsesFfmpeg
    ? [
      { id: "prepare", label: t("spine.recorder.stage.prepare") },
      { id: "render", label: t("spine.recorder.stage.render") },
      { id: "audio", label: t("spine.recorder.stage.audio") },
      { id: "encode", label: t("spine.recorder.stage.encode") },
      { id: "save", label: t("spine.recorder.stage.save") },
    ]
    : [
      { id: "prepare", label: t("spine.recorder.stage.prepare") },
      { id: "capture", label: t("spine.recorder.stage.capture") },
      { id: "save", label: t("spine.recorder.stage.save") },
    ];
  const recorderCurrentStageId = videoRecorderDialog?.phase === "preparing"
    ? "prepare"
    : videoRecorderDialog?.phase === "recording" || videoRecorderDialog?.phase === "rendering"
      ? activeExportUsesFfmpeg ? "render" : "capture"
      : videoRecorderDialog?.phase === "mixing"
        ? "audio"
        : videoRecorderDialog?.phase === "encoding"
          ? "encode"
          : "save";
  const recorderCurrentStageIndex = recorderStageItems.findIndex(({ id }) => id === recorderCurrentStageId);
  const recorderProgressFraction = videoRecorderDialog?.phase === "rendering" && videoRecorderDialog.totalFrames
    ? (videoRecorderDialog.framesRendered ?? 0) / videoRecorderDialog.totalFrames
    : videoRecorderDialog?.phase === "mixing" && (videoRecorderDialog.totalAudioTracks ?? 0) > 0
      ? (videoRecorderDialog.audioTracksMixed ?? 0) / (videoRecorderDialog.totalAudioTracks ?? 0)
      : videoRecorderDialog?.phase === "encoding" && videoRecorderDialog.encodeProgress !== undefined
        ? videoRecorderDialog.encodeProgress
        : videoRecorderDialog?.phase === "saving" && videoRecorderDialog.saveTotalBytes !== undefined && videoRecorderDialog.saveTotalBytes > 0
          ? (videoRecorderDialog.saveBytesCopied ?? 0) / videoRecorderDialog.saveTotalBytes
        : videoRecorderDialog?.phase === "recording" && activeExportRun?.plan
          ? videoRecordingProgress(activeExportRun.plan, videoRecorderDialog.elapsed).fraction
          : null;
  const recorderProgressPercent = recorderProgressFraction === null
    ? null
    : Math.max(0, Math.min(100, Math.round(recorderProgressFraction * 100)));
  const recorderPlanDuration = activeExportRun?.plan?.totalDuration ?? 0;
  const recorderVideoTime = `${formatSeconds(videoRecorderDialog?.elapsed ?? 0)}s${recorderPlanDuration > 0 ? ` / ${formatSeconds(recorderPlanDuration)}s` : ""}`;
  const recorderRenderSpeed = videoRecorderDialog?.renderFps && videoRecorderDialog.renderFps > 0
    ? `${(Math.round(videoRecorderDialog.renderFps * 10) / 10).toFixed(1)} FPS`
    : t("spine.recorder.measuring");
  const recorderWallElapsed = videoRecorderDialog?.wallElapsedSeconds;
  const recorderStageElapsed = videoRecorderDialog?.stageElapsedSeconds;
  const recorderAudioTracks = activeExportRun?.desktopAudioTracks.length ?? 0;
  const recorderAudioTrackProgress = videoRecorderDialog?.totalAudioTracks
    ? t("spine.recorder.audioProgress", { mixed: videoRecorderDialog.audioTracksMixed ?? 0, total: videoRecorderDialog.totalAudioTracks })
    : t("spine.recorder.noAudioTracks");
  const recorderAudioSequence = videoRecorderDialog?.currentAudioSequence === "opening"
    ? t("spine.sequenceOpening")
    : videoRecorderDialog?.currentAudioSequence?.match(/^talk-(\d+)$/i)
      ? t("spine.sequenceTalk", { n: videoRecorderDialog.currentAudioSequence.match(/^talk-(\d+)$/i)![1]! })
      : videoRecorderDialog?.currentAudioSequence ?? "—";
  const recorderEncodingTime = videoRecorderDialog?.encodedTimeSeconds !== undefined && videoRecorderDialog.totalEncodeTimeSeconds !== undefined
    ? `${formatSeconds(videoRecorderDialog.encodedTimeSeconds)}s / ${formatSeconds(videoRecorderDialog.totalEncodeTimeSeconds)}s`
    : t("spine.recorder.measuring");
  const recorderEncoderAttempt = videoRecorderDialog?.encoderAttempt && videoRecorderDialog.encoderAttempts
    ? `${videoRecorderDialog.encoderAttempt} / ${videoRecorderDialog.encoderAttempts}`
    : t("spine.recorder.measuring");
  const recorderEncoderType = videoRecorderDialog?.encoderHardware === undefined
    ? t("spine.recorder.measuring")
    : t(videoRecorderDialog.encoderHardware ? "spine.recorder.encoderHardware" : "spine.recorder.encoderSoftware");
  const recorderEncodeFps = videoRecorderDialog?.encodeFps !== undefined
    ? `${videoRecorderDialog.encodeFps.toFixed(1)} FPS`
    : t("spine.recorder.measuring");
  const recorderEncodeSpeed = videoRecorderDialog?.encodeSpeed !== undefined
    ? `${videoRecorderDialog.encodeSpeed.toFixed(2)}×`
    : t("spine.recorder.measuring");
  const recorderEncodedFrames = videoRecorderDialog?.encodedFrames !== undefined && videoRecorderDialog.totalEncodedFrames !== undefined
    ? `${Math.min(videoRecorderDialog.encodedFrames, videoRecorderDialog.totalEncodedFrames)} / ${videoRecorderDialog.totalEncodedFrames}`
    : t("spine.recorder.measuring");
  const recorderSaveOperation = videoRecorderDialog?.saveOperation
    ? t(`spine.recorder.saveOperation.${videoRecorderDialog.saveOperation}`)
    : t("spine.recorder.saveOperation.finalizing");
  const recorderSaveTransfer = videoRecorderDialog?.saveTotalBytes !== undefined
    ? `${formatRecorderBytes(videoRecorderDialog.saveBytesCopied)} / ${formatRecorderBytes(videoRecorderDialog.saveTotalBytes)}`
    : t("spine.recorder.measuring");
  const recorderAssetsProgress = activeExportRun?.source === "composition" ? compositionLoadProgress : rendererLoadProgress;
  const recorderAssetsStatus = recorderAssetsProgress && recorderAssetsProgress.total > 0
    ? `${recorderAssetsProgress.loaded} / ${recorderAssetsProgress.total} · ${recorderAssetsProgress.stage}`
    : isLoading || rendererLoading
      ? t("spine.recorder.measuring")
      : t("spine.recorder.assetsReady");
  const recorderPreparedAudioStatus = !recorderSettings.includeAudio
    ? t("spine.recorder.off")
    : !activeExportRun?.useFfmpeg
      ? t("spine.recorder.audioLiveCapture")
    : recorderAudioTracks > 0
      ? t("spine.recorder.audioTrackCount", { count: recorderAudioTracks })
      : videoRecorderDialog?.phase === "preparing"
        ? t("spine.recorder.preparingOutput")
        : "0";
  const recorderRemaining = videoRecorderDialog?.phase === "rendering"
    ? videoRecorderDialog.renderEtaSeconds
    : videoRecorderDialog?.phase === "recording" && activeExportRun?.plan
      ? undefined
      : videoRecorderDialog?.phase === "encoding"
        ? videoRecorderDialog.encodeEtaSeconds
      : undefined;
  const recorderLivePreview = Boolean((videoRecorderDialog?.phase === "rendering" && activeExportRun?.useFfmpeg)
    || (videoRecorderDialog?.phase === "recording" && activeExportRun?.capture));
  const recorderMetricItems = videoRecorderDialog?.phase === "preparing"
    ? [
      { label: t("spine.recorder.currentTask"), value: videoRecorderDialog.detail ?? t("spine.recorder.preparingOutput") },
      { label: t("spine.recorder.assets"), value: recorderAssetsStatus },
      { label: t("spine.recorder.audioTracks"), value: recorderPreparedAudioStatus },
      { label: t("spine.recorder.output"), value: `${activeExportRun?.outputWidth ?? recorderOutputDimensions.width} × ${activeExportRun?.outputHeight ?? recorderOutputDimensions.height} · ${activeExportRun?.settings.frameRate ?? recorderSettings.frameRate} FPS` },
      { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
      { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
    ]
    : videoRecorderDialog?.phase === "rendering"
      ? [
        { label: t("spine.recorder.frames"), value: `${videoRecorderDialog.framesRendered ?? 0} / ${videoRecorderDialog.totalFrames ?? activeExportRun?.desktopTotalFrames ?? 0}` },
        { label: t("spine.recorder.videoTime"), value: recorderVideoTime },
        { label: t("spine.recorder.renderSpeed"), value: recorderRenderSpeed },
        { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(videoRecorderDialog.renderElapsedSeconds ?? recorderStageElapsed) },
        { label: t("spine.recorder.timeRemaining"), value: formatRecorderDuration(recorderRemaining) },
        { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
      ]
      : videoRecorderDialog?.phase === "recording"
        ? [
          { label: t("spine.recorder.captureTargetRate"), value: `${activeExportRun?.settings.frameRate ?? recorderSettings.frameRate} FPS` },
          { label: t("spine.recorder.videoTime"), value: recorderVideoTime },
          { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
          { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
        ]
        : videoRecorderDialog?.phase === "mixing"
          ? [
            { label: t("spine.recorder.audioTracks"), value: recorderAudioTrackProgress },
            { label: t("spine.recorder.currentTrack"), value: videoRecorderDialog.currentAudioTrack ?? t("spine.recorder.noAudioTracks") },
            { label: t("spine.recorder.sequence"), value: recorderAudioSequence },
            { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
            { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
          ]
          : videoRecorderDialog?.phase === "encoding"
            ? [
              { label: t("spine.recorder.encoderName"), value: videoRecorderDialog.encoder ?? t("spine.recorder.measuring") },
              { label: t("spine.recorder.encoderType"), value: recorderEncoderType },
              { label: t("spine.recorder.encoderAttemptLabel"), value: recorderEncoderAttempt },
              { label: t("spine.recorder.encodedFrames"), value: recorderEncodedFrames },
              { label: t("spine.recorder.videoTime"), value: recorderEncodingTime },
              { label: t("spine.recorder.encodeFps"), value: recorderEncodeFps },
              { label: t("spine.recorder.encodeSpeed"), value: recorderEncodeSpeed },
              { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
              { label: t("spine.recorder.timeRemaining"), value: formatRecorderDuration(recorderRemaining) },
              { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
            ]
            : videoRecorderDialog?.phase === "saving"
              ? [
                { label: t("spine.recorder.saveOperation"), value: recorderSaveOperation },
                { label: t("spine.recorder.destination"), value: activeExportRun?.destination.locationName ?? t("spine.recorder.localDestination") },
                { label: t("spine.recorder.copyProgress"), value: recorderSaveTransfer },
                { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
                { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
              ]
              : videoRecorderDialog?.phase === "canceling"
                ? [
                  { label: t("spine.recorder.currentTask"), value: t("spine.recorder.canceling") },
                  { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
                  { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
                ]
              : [
                { label: t("spine.recorder.captureTargetRate"), value: `${activeExportRun?.settings.frameRate ?? recorderSettings.frameRate} FPS` },
                { label: t("spine.recorder.stageElapsed"), value: formatRecorderDuration(recorderStageElapsed) },
                { label: t("spine.recorder.totalElapsed"), value: formatRecorderDuration(recorderWallElapsed) },
              ];

  return <main className={`spine-page${isDesktopHost() && fullscreen ? " is-native-fullscreen" : ""}`}>
    <div className="spine-recorder-background" inert={Boolean(videoRecorderDialog)} aria-hidden={Boolean(videoRecorderDialog)}>
    <header className="spine-header">
      <div className="spine-brand">
        <span className="spine-kicker">BA Spine Suite / Spine 4.2</span>
        <div className="spine-title-row">
          <h1>{t("spine.title")}</h1>
          <span className={`spine-connection-pill${source ? " is-connected" : ""}`}><i />{source ? t("spine.preview.ready") : t("spine.preview.waiting")}</span>
        </div>
        <p>{t("spine.subtitle")}</p>
      </div>
      <div className="spine-header-tools"><LanguageSwitch /><ThemeSwitch /></div>
    </header>

    <section className={`spine-source${source ? " is-connected" : ""}`} aria-labelledby="spine-source-title">
      <div className="spine-source-copy">
        <span className="spine-source-icon" aria-hidden="true"><IconFolder /></span>
        <div>
          <strong id="spine-source-title">{t("spine.source.heading")}</strong>
          <span>{source ? t("spine.source.ready") : t("spine.source.hint")}</span>
        </div>
      </div>
      <small className="spine-source-local">{t("spine.source.localOnly")}</small>
      <div className="spine-source-action">
        {isDesktopHost() && source && <button className="suite-button btn ghost" type="button" onClick={() => void openInEditor()} disabled={!selectedDirectoryName}>{t("spine.source.editInEditor")}</button>}
        <button className="suite-button btn ghost" type="button" onClick={chooseFolder}><IconFolder /><span>{t(source ? "spine.source.change" : "spine.source.choose")}</span></button>
        <details className="spine-source-help">
          <summary aria-label={t("spine.source.helpAria")} title={t("spine.source.helpAria")}>?</summary>
          <div className="spine-source-help-panel">
            <strong>{t("spine.source.helpTitle")}</strong>
            <p>{t("spine.source.helpBody")}</p>
            <pre aria-label={t("spine.source.helpExampleAria")}>{`asset-root/\n└─ lobbies/\n   └─ <set>/\n      ├─ manifest.json\n      └─ spine/\n         ├─ <name>.atlas\n         ├─ <name>.skel\n         └─ <page>.png`}</pre>
            <p>{t("spine.source.helpFormat")}</p>
          </div>
        </details>
        <input ref={inputRef} type="file" multiple hidden onChange={onInputChange} />
      </div>
    </section>

    {error && <div className="alert spine-alert" role="alert">{error}</div>}
    {handoffStatus && <div className="spine-handoff-status" role="status">{handoffStatus}</div>}
    {draftPreview?.lobbyId === selectedDirectoryName && <div className="spine-draft-banner" role="status">
      <strong>{t("spine.draft.badge")}</strong>
      <span>{t("spine.draft.readOnly")}</span>
      <button className="suite-button btn ghost" type="button" onClick={returnToSavedFiles}>{t("spine.draft.return")}</button>
    </div>}
    {draftPreviewNotice && !draftPreview && <div className="spine-draft-notice" role="status">
      <span>{draftPreviewNotice}</span>
      <button type="button" aria-label={t("spine.draft.dismiss")} onClick={() => setDraftPreviewNotice(null)}><IconClose /></button>
    </div>}

    <div ref={fullscreenLayoutRef} className={`spine-layout${showSidebar ? "" : " spine-sidebar-hidden"}${fullscreenClean ? " spine-clean-mode" : ""}${fullscreen ? " is-fullscreen" : ""}`}>
      <aside id="spine-sidebar" className="spine-sidebar">
        <section className="spine-selector panel">
          <div className="spine-panel-heading">
            <div className="phead"><IconUsers /><span>{t("spine.characters")}</span></div>
            <span className="spine-character-count">{t("spine.characterCount", { n: filteredCharacters.length })}</span>
          </div>
          <div className="spine-search-field" role="search">
            <IconSearch />
            <input
              className="search spine-character-search"
              value={characterSearch}
              onChange={(event) => setCharacterSearch(event.target.value)}
              placeholder={t("spine.characterSearch")}
              aria-label={t("spine.characterSearchAria")}
            />
            {characterSearch && <button type="button" className="spine-search-clear" onClick={() => setCharacterSearch("")} aria-label={t("spine.characterSearchClear")} title={t("spine.characterSearchClear")}><IconClose /></button>}
          </div>
          <nav className="spine-navigation-links" aria-label={t("spine.quickAccess")}>
            {favoriteLobbies.length > 0 && <section>
              <h3>{t("spine.favorites")}</h3>
              {favoriteLobbies.map((lobbyId) => <button key={`favorite:${lobbyId}`} type="button" className={lobbyId === selectedDirectoryName ? "is-selected" : undefined} onClick={() => selectLobby(lobbyId)} title={lobbyId}>
                <IconStar /><span>{lobbyLabels[lobbyId] ?? lobbyId}</span>
              </button>)}
            </section>}
            {recentLobbies.length > 0 && <section>
              <h3>{t("spine.recents")}</h3>
              {recentLobbies.map((lobbyId) => <button key={`recent:${lobbyId}`} type="button" className={lobbyId === selectedDirectoryName ? "is-selected" : undefined} onClick={() => selectLobby(lobbyId)} title={lobbyId}>
                <span className="spine-recent-dot" aria-hidden="true" /><span>{lobbyLabels[lobbyId] ?? lobbyId}</span>
              </button>)}
            </section>}
          </nav>
          <span id="spine-character-keyboard-hint" className="spine-visually-hidden">{t("spine.keyboardHint")}</span>
          <div className="spine-character-list" role="group" aria-label={t("spine.charactersAria")} aria-keyshortcuts="ArrowUp ArrowDown Home End" aria-describedby="spine-character-keyboard-hint" onKeyDown={onCharacterListKeyDown}>
            {filteredCharacters.map((name) => {
              const availableAssets = indexedAssets(characterIndex.characters[name]).filter((variant) => availableDirectories?.has(variant.directory));
              const count = availableAssets.length;
              const query = characterSearch.trim();
              const characterMatches = !query || matchesLibrarySearch(query, [name]);
              const visibleVariants = characterMatches ? availableAssets : availableAssets.filter((variant) => matchesLibrarySearch(query, [variant.variant, variant.directory, variant.assetId, variant.devName, variant.extraType]));
              const expanded = Boolean(query) || expandedCharacter === name;
              return <section key={name} className={`spine-character-entry${name === selectedCharacter ? " is-selected" : ""}`}>
                <div className="spine-character-row-wrap">
                  <button
                    type="button"
                    data-browser-item
                    data-character={name}
                    aria-expanded={expanded}
                    className={`spine-character-row${name === selectedCharacter ? " is-selected" : ""}`}
                    onClick={() => {
                      if (videoRecordingRunRef.current) return;
                      if (name !== selectedCharacter) selectCharacter(name);
                      else setExpandedCharacter((current) => current === name ? "" : name);
                    }}
                  >
                    <span className="spine-character-expander" aria-hidden="true">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
                    <LobbyThumbnail source={thumbnailSource} directory={availableAssets.find((variant) => variant.directory === selectedDirectory)?.directory ?? availableAssets[0]?.directory ?? ""} kind="face" />
                    <span className="spine-character-option-label">{name}</span><small>{count}</small>
                  </button>
                </div>
                {expanded && <div className="spine-character-variants" role="group" aria-label={t("spine.characterVariants", { name })}>
                  {visibleVariants.map((variant) => <div key={variant.directory} className="spine-variant-row">
                    <button type="button" data-browser-item data-character={name} className={`spine-variant-select${variant.directory === selectedDirectoryName ? " is-selected" : ""}`} aria-current={variant.directory === selectedDirectoryName ? "true" : undefined} onClick={() => {
                      if (videoRecordingRunRef.current) return;
                      if (variant.directory !== selectedDirectoryName || name !== selectedCharacter) resetAssetPlayback();
                      setSelectedCharacter(name);
                      setSelectedDirectory(variant.directory);
                      setExpandedCharacter(name);
                    }}>
                      <LobbyThumbnail source={thumbnailSource} directory={variant.directory} kind="lobby" />
                      <span>{variant.extraType ? extraLabel(variant.extraType) : variant.variant}</span>
                    </button>
                    <button className={`spine-variant-favorite${navigation.favorites.includes(variant.directory) ? " is-favorite" : ""}`} type="button" aria-pressed={navigation.favorites.includes(variant.directory)} aria-label={t(navigation.favorites.includes(variant.directory) ? "spine.favorite.remove" : "spine.favorite.add")} title={t(navigation.favorites.includes(variant.directory) ? "spine.favorite.remove" : "spine.favorite.add")} onClick={() => toggleFavorite(variant.directory)}><IconStar /></button>
                  </div>)}
                  {visibleVariants.length === 0 && <p className="spine-character-no-variants">{t("spine.noMatchingVariants")}</p>}
                </div>}
              </section>;
            })}
            {filteredCharacters.length === 0 && <p className="hint">{source && !availableDirectories ? t("spine.loading") : t("spine.noCharacters")}</p>}
          </div>
          <div className="spine-variant-picker">
            <details className="spine-set-meta"><summary>{t("spine.assetDetails")}</summary><div>
              <code>{selectedDirectoryName}</code>
              {selectedVariant?.assetId && <span>{selectedVariant.assetId}</span>}
            </div></details>
          </div>
        </section>
      </aside>

        <section className={`spine-workspace${showFullscreenControls && !fullscreenClean ? "" : " spine-controls-hidden"}`} aria-label={t("spine.viewerAria")} onPointerMove={(event) => {
          if (event.pointerType !== "mouse" || !fullscreen || fullscreenClean) return;
          if (showFullscreenControls) scheduleFullscreenHide();
          else revealFullscreenControls();
        }}>
        <div className="spine-workspace-heading">
           <div className="spine-workspace-identity"><strong>{selectedCharacter}</strong><span>{selectedVariant?.extraType ? extraLabel(selectedVariant.extraType) : selectedVariant?.variant}</span></div>
          <div className="spine-workspace-status">
             <small role={backgroundAudioLoading ? "status" : undefined}>{backgroundAudioLoading
               ? t("spine.loading.audio", { loaded: voiceAudioLoading ? voiceAudioProgress.loaded : compositionLoadProgress?.loaded ?? 0, total: voiceAudioLoading ? voiceAudioProgress.total : compositionLoadProgress?.total ?? 0 })
               : t(meta ? "spine.preview.ready" : "spine.preview.waiting")}</small>
                {showAspectRatioControl && <label className="spine-output-ratio"><span>{t("spine.aspectRatio")}</span><select value={outputAspectRatio} onChange={(event) => setAspectRatio(event.target.value as ViewerAspectRatio)} aria-label={t("spine.aspectRatioAria")}>
                <option value="16:9">16:9</option><option value="4:3">4:3</option><option value="1:1">1:1</option>
              </select></label>}
            {desktopSource && <div className="spine-library-refresh">
              {libraryChangesAvailable
                ? <span className="spine-library-change-status" role="status">{t("spine.library.changesAvailable")}</span>
                : libraryWatcherAvailable === false
                  ? <span className="spine-library-change-status" role="status">{t("spine.library.watchUnavailable")}</span>
                  : null}
              <button className="spine-library-refresh-button" type="button" disabled={libraryRefreshing} onClick={() => void refreshDesktopLibrary()} aria-label={t(libraryRefreshing ? "spine.library.refreshing" : "spine.library.refresh")} title={t(libraryRefreshing ? "spine.library.refreshing" : "spine.library.refresh")}>
                <IconSync /><span>{t(libraryRefreshing ? "spine.library.refreshing" : "spine.library.refresh")}</span>
              </button>
            </div>}
            <button className="spine-sidebar-toggle" type="button" aria-expanded={showSidebar} aria-controls="spine-sidebar" onClick={() => setShowSidebar((shown) => !shown)} title={t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}>
              <IconUsers /><span>{t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}</span>
            </button>
          </div>
        </div>
        <div ref={stageFrameRef} className="spine-stage-frame" data-aspect-ratio={outputAspectRatio} data-free-canvas={!compositionActive && interactionMode === "free" ? "true" : "false"} onPointerDown={(event) => {
          stagePointer.current = { x: event.clientX, y: event.clientY };
        }} onPointerUp={(event) => {
          const start = stagePointer.current;
          stagePointer.current = null;
           if (fullscreen && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
             if (fullscreenClean) exitCleanFullscreen();
              else if (!showFullscreenControls) revealFullscreenControls();
              else if (interactionMode === "free") hideFullscreenControls();
            }
          }} onPointerCancel={() => { stagePointer.current = null; }}>
          {compositionActive && compositionTimeline && source
             ? <SpineCompositionViewport
                key={selectedDirectoryName}
                ref={compositionRef}
                source={source}
                timeline={compositionTimeline}
                preloadTimelines={compositionPreloadTimelines}
               interactionMode={interactionMode}
               interactionProject={selectedInteractionProject}
               showInteractionPoints={showInteractionPoints}
               currentTime={progress.time}
                playing={playing}
                 speed={speed}
                 effectsStrength={effectsStrength}
                 cameraMode={compositionCameraMode}
                  aspectRatio={outputAspectRatio}
                idleMode={idleMode}
                recordingIdleOverride={recordingIdleOverride}
                preserveDrawingBuffer={videoRecorderApplyingCamera}
               onMeta={handleViewportMeta}
                onProgress={(next) => handleViewerProgress(next, "composition")}
               onLoading={(loading) => { setRendererLoading(loading); if (!loading) setRendererLoadProgress(null); }}
               onLoadProgress={setCompositionLoadProgress}
                onError={handleViewportError}
                onFinished={handleCompositionFinished}
               onTalk={(index, talkAnimation, eventCount) => beginVoiceSession(index, talkAnimation, eventCount)}
               onTalkClip={playVoiceEvent}
               onIntro={(intro, eventCount) => beginIntroVoiceSession(intro, eventCount)}
               onIntroClip={playIntroVoiceEvent}
             />
             : <SpineViewport
               key={selectedDirectoryName}
               ref={viewportRef}
              files={setFiles}
              directory={selectedDirectoryName}
              interactionProject={selectedInteractionProject}
              animation={animation}
              playing={playing}
              speed={speed}
              loop={loop}
               cameraMode={viewportCameraMode}
              interactionMode={interactionMode}
              skipIntro={skipIntro}
              showInteractionPoints={showInteractionPoints}
              effectsStrength={effectsStrength}
              preserveDrawingBuffer={videoRecorderApplyingCamera}
              recordingMeta={meta}
              onMeta={handleViewportMeta}
                onProgress={(next) => handleViewerProgress(next, "runtime")}
               onLoading={(loading) => { setRendererLoading(loading); if (!loading) setRendererLoadProgress(null); }}
               onLoadProgress={setRendererLoadProgress}
                onError={handleViewportError}
               onCameraMode={setCameraMode}
              onTalk={(index, animation, eventCount) => beginVoiceSession(index, animation, eventCount)}
              onTalkClip={playVoiceEvent}
              onIntro={(intro, eventCount) => beginIntroVoiceSession(intro, eventCount)}
              onIntroClip={playIntroVoiceEvent}
            />}
          {showDialogue && activeVoiceLine && activeDialogue && <div className="spine-dialogue" aria-live="polite">{activeDialogue}</div>}
          {!source && <div className="spine-stage-empty"><strong>{t("spine.empty.heading")}</strong><span>{t("spine.empty.body")}</span></div>}
          {source && !setFiles && !error && !isLoading && <div className="spine-stage-empty"><strong>{t("spine.empty.set")}</strong><span>{selectedDirectoryName}</span></div>}
          <div className="spine-stage-hint">{t(interactionMode === "interaction" ? "spine.interactionHint" : "spine.stageHint")}</div>
          {isLoading && <div className="spine-loading-screen" role="status" aria-live="polite">
            <div className="spine-loading-card">
              <span className="spine-loading-spinner" aria-hidden="true" />
              <strong>{loadingLabel(loadingProgress, folderLoading)}</strong>
              <span>{folderLoading ? t("spine.loading.folderDetail") : loadingProgress?.stage === "audio" ? t("spine.loading.audioDetail") : t("spine.loadingDetail")}</span>
              <div className={`spine-loading-progress${loadingProgress && loadingProgress.total > 0 ? " is-determinate" : ""}`} role="progressbar" aria-label={t("spine.loadingDetail")} aria-valuemin={0} aria-valuemax={loadingProgress?.total || 100} aria-valuenow={loadingProgress && loadingProgress.total > 0 ? Math.min(loadingProgress.loaded, loadingProgress.total) : undefined}>
                <span style={loadingProgress && loadingProgress.total > 0 ? { width: `${Math.min(100, Math.round((loadingProgress.loaded / loadingProgress.total) * 100))}%` } : undefined} />
              </div>
            </div>
          </div>}
        </div>
          {fullscreen && !fullscreenClean && !showFullscreenControls && showFullscreenControlsHint && <div id="spine-controls-hint" className="spine-controls-hint" role="status">{t("spine.controls.tapHint")}</div>}
          {fullscreen && !fullscreenClean && !showFullscreenControls && showFullscreenControlsHint && <button className="spine-show-controls-edge" type="button" aria-controls="spine-playback-controls" aria-describedby="spine-controls-hint" aria-label={t("spine.controls.show")} title={t("spine.controls.show")} onClick={revealFullscreenControls}><IconChevronUp /></button>}

        <div ref={fullscreenControlsRef} id="spine-playback-controls" className={`spine-controls${showOptions ? " spine-options-open" : ""}`} aria-label={t("spine.controlsAria")}>
          <div className="spine-toolbar-row">
            <div className="spine-mode-switch" role="group" aria-label={t("spine.modeAria")}>
              <button className={interactionMode === "interaction" ? "is-selected" : undefined} type="button" aria-pressed={interactionMode === "interaction"} onClick={() => selectInteractionMode("interaction")}><IconHand /><span>{t("spine.mode.interaction")}</span></button>
              <button className={interactionMode === "free" ? "is-selected" : undefined} type="button" aria-pressed={interactionMode === "free"} onClick={() => selectInteractionMode("free")}><IconPlay /><span>{t("spine.mode.free")}</span></button>
            </div>
            <div className="spine-toolbar-actions">
              {canRestartOpening && <button className="spine-tool-button" type="button" disabled={!meta} onClick={restartOpening} aria-label={t("spine.restartOpening")} title={t("spine.restartOpening")}><IconRotate /><span>{t("spine.restartOpening")}</span></button>}
              {interactionMode === "free" && <button className="spine-tool-button" type="button" disabled={!meta} onClick={fitAllArtwork} aria-label={t("spine.fitAllArtwork")} title={t("spine.fitAllArtwork")}><IconTarget /><span>{t("spine.fitAllArtwork")}</span></button>}
              {interactionReady && meta?.interaction.talkCount ? <button className="spine-tool-button" type="button" onClick={() => playTalk()} aria-label={t("spine.talkAria")} title={t("spine.talkAria")}><IconMessage /><span>{t("spine.talk")}</span><small>{meta.interaction.talkCount}</small></button> : null}
              {interactionReady && (voiceLines.length > 0 || authoredTalkAutoplayAvailable) ? <button className={`spine-tool-button${talkAutoplay ? " is-active" : ""}`} type="button" onClick={toggleTalkAutoplay} aria-pressed={talkAutoplay} aria-label={t(talkAutoplay ? "spine.autoplayStop" : "spine.autoplayStart")} title={t(talkAutoplay ? "spine.autoplayStop" : "spine.autoplayStart")}><span>{talkAutoplay ? <IconPause /> : <IconPlay />}</span><span>{t("spine.autoplay")}</span></button> : null}
              {interactionMode === "interaction" && <button className="spine-tool-button spine-record-video-button" type="button" disabled={!meta || videoRecorderFormats.length === 0} onClick={openVideoRecorder} aria-label={t("spine.recorder.open")} title={t(videoRecorderFormats.length ? "spine.recorder.open" : "spine.recorder.unsupported")}><IconDot /><span>{t("spine.recorder.open")}</span></button>}
              <button className={`spine-tool-button${showOptions ? " is-active" : ""}`} type="button" aria-expanded={showOptions} aria-controls="spine-options" onClick={() => setShowOptions((shown) => !shown)}><IconSliders /><span>{t("spine.options")}</span></button>
               <details className="spine-shortcut-help">
                 <summary className="spine-tool-button" aria-label={t("spine.shortcuts")} title={t("spine.shortcuts")}><IconHelp /><span>{t("spine.shortcuts")}</span></summary>
                 <div className="spine-shortcut-panel">{t("spine.shortcutsHint")}</div>
               </details>
               <button className="spine-tool-button spine-sidebar-toggle" type="button" aria-expanded={showSidebar} aria-controls="spine-sidebar" onClick={() => setShowSidebar((shown) => !shown)} title={t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}><IconUsers /><span>{t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}</span></button>
               {fullscreen && <button className="spine-tool-button spine-clean-mode-toggle" type="button" aria-pressed={fullscreenClean} onClick={fullscreenClean ? exitCleanFullscreen : enterCleanFullscreen} title={t(fullscreenClean ? "spine.cleanMode.exit" : "spine.cleanMode.enter")}><span>{fullscreenClean ? <IconEye /> : <IconEyeOff />}</span><span>{t("spine.cleanMode")}</span></button>}
                {fullscreen && <button className="spine-tool-button spine-fullscreen-controls-toggle" type="button" aria-expanded={showFullscreenControls} onClick={showFullscreenControls ? hideFullscreenControls : revealFullscreenControls} title={t(showFullscreenControls ? "spine.controls.hide" : "spine.controls.show")}><IconChevronDown /><span>{t(showFullscreenControls ? "spine.controls.hide" : "spine.controls.show")}</span></button>}
                <button className="spine-tool-button" type="button" onClick={() => void toggleViewerFullscreen()} aria-label={t(fullscreen ? "a11y.fullscreenExit" : "a11y.fullscreenEnter")} title={t(fullscreen ? "a11y.fullscreenExit" : "a11y.fullscreenEnter")}><span>{fullscreen ? <IconCompress /> : <IconExpand />}</span><span className="spine-button-label">{t("spine.fullscreen")}</span></button>
            </div>
           </div>

           {voiceLines.length > 0 && <div className="spine-voice-row">
             <label className="spine-dialogue-picker"><span>{t("spine.dialogueSelect")}</span><select value={selectedVoiceLineIndex === null ? "" : String(selectedVoiceLineIndex)} onChange={(event) => selectDialogue(event.target.value)} disabled={!interactionReady} aria-label={t("spine.dialogueSelectAria")}>
               <option value="">{t("spine.dialogueNext")}</option>
               {voiceLines.map((line, index) => {
                 const number = line.id.match(/(\d+)$/)?.[1];
                 return <option key={`${line.id}-${index}`} value={index}>{t("spine.dialogueOption", { n: number ?? String(index + 1) })}</option>;
               })}
             </select></label>
             {talkAutoplay && <span className="spine-autoplay-status" role="status">{t("spine.autoplayPlaying")}</span>}
           </div>}

           {interactionMode === "free" && <div className="spine-playback-row">
            <button className="spine-icon-button" type="button" onClick={togglePlayback} disabled={!meta} aria-label={t(playing ? "spine.pause" : "spine.play")} title={t(playing ? "spine.pause" : "spine.play")}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button className="spine-icon-button spine-restart-icon" type="button" disabled={!meta} onClick={restartPlayback} aria-label={t("spine.restart")} title={t("spine.restart")}><IconRotate /></button>
            <input
              className="spine-scrubber"
              type="range"
              min="0"
              max={progress.duration || 0.01}
              step="0.01"
              value={Math.min(progress.time, progress.duration || 0.01)}
              disabled={!meta}
             onChange={(event) => activeViewport()?.seek(Number(event.target.value))}
              aria-label={t("spine.scrubber")}
            />
            <span className="spine-time" aria-live="off">{formatSeconds(progress.time)} / {formatSeconds(progress.duration)}s</span>
          </div>}

        </div>

           {showOptions && <aside id="spine-options" className="spine-settings-drawer" role="complementary" aria-label={t("spine.options")}>
             <div className="spine-settings-heading"><h2>{t("spine.options")}</h2><button type="button" onClick={() => setShowOptions(false)} aria-label={t("spine.options.close")} title={t("spine.options.close")}><IconClose /></button></div>
             <div className="spine-settings-scroll"><div className="spine-settings-grid">
                 {(interactionMode === "free" || !compositionActive || (selectedInteractionProject && compositionSequenceIds.length > 0)) && <section className="spine-settings-group">
                  <h3>{t("spine.settings.playbackGroup")}</h3>
                  {interactionMode === "free" && !compositionActive && <>
                    <label className="spine-setting-field"><span>{t("spine.animation")}</span><select value={animation} onChange={(event) => selectAnimation(event.target.value)} disabled={!meta} aria-label={t("spine.animationAria")}>
                      {animationOptions.map((option) => typeof option === "string" ? <option key={option} value={option}>{option === INTRO_ANIMATION ? t("spine.introIdle") : option}</option> : <option key={option.value} value={option.value} disabled={option.disabled === true}>{option.label}</option>)}
                    </select></label>
                    {!meta?.idleAnimation && <small className="spine-setting-hint">{t("spine.noIdleHint")}</small>}
                    {animationSelectionOrigin === "automatic" && meta?.idleAnimation && <small className="spine-setting-hint">{t(animation === INTRO_ANIMATION ? "spine.animation.autoIntro" : animation === meta.idleAnimation ? "spine.animation.autoIdle" : "spine.animation.autoFallback", { name: meta.idleAnimation })}</small>}
                  </>}
                  {interactionMode === "free" && <label className="spine-setting-field"><span>{t("spine.speed")}</span><select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label={t("spine.speedAria")}>
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
                  </select></label>}
                  {interactionMode === "free" && !compositionActive && <label className="spine-check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />{t("spine.loop")}</label>}
                  {!compositionActive && <label className="spine-check"><input type="checkbox" checked={skipIntro} onChange={(event) => toggleSkipIntro(event.target.checked)} />{t("spine.skipIntro")}</label>}
                  {selectedInteractionProject && compositionSequenceIds.length > 0 && <label className="spine-setting-field"><span>{t("spine.sequence")}</span><select value={compositionSequenceId || "__runtime-intro__"} onChange={(event) => { if (videoRecordingRunRef.current) return; const next = event.target.value === "__runtime-intro__" ? "" : event.target.value; const nextTimeline = next ? timelineForSequence(selectedInteractionProject, next) : null; stopVoice(); setIdleMode("none"); setProgress({ time: 0, duration: nextTimeline ? projectTimelineDuration(nextTimeline, selectedInteractionProject) : 0, animation: null }); setSelectedSequenceId(next); }} aria-label={t("spine.sequenceAria")}>
                    {!compositionSequenceId && <option value="__runtime-intro__">Runtime intro</option>}
                    {compositionSequenceIds.map((id) => <option key={id} value={id}>{id === "opening" ? t("spine.sequenceOpening") : id.match(/^talk-(\d+)$/)?.[1] ? t("spine.sequenceTalk", { n: id.match(/^talk-(\d+)$/)![1]! }) : id}</option>)}
                  </select></label>}
                  {interactionMode === "free" && !compositionActive && meta?.introAnimation && meta.idleAnimation && <button className="spine-settings-action" type="button" onClick={() => { setAnimation(INTRO_ANIMATION); setProgress((current) => ({ ...current, time: 0 })); viewportRef.current?.replayIntro(); }}><IconRotate /><span>{t("spine.replayIntro")}</span></button>}
                </section>}

                {voiceLines.length > 0 && <section className="spine-settings-group">
                  <h3>{t("spine.settings.audioGroup")}</h3>
                  <label className="spine-check spine-toggle-setting"><input type="checkbox" checked={voiceEnabled} onChange={(event) => setVoiceEnabled(event.target.checked)} />{t("spine.voice")}{voicePlaying && <small><IconDot /></small>}</label>
                  <label className="spine-setting-field"><span>{t("spine.voiceVolume")}</span><div className="spine-range-control"><input type="range" min="0" max="1" step="0.05" value={voiceVolume} onChange={(event) => setVoiceVolume(normalizeVoiceVolume(Number(event.target.value)))} aria-label={t("spine.voiceVolume")} /><output>{Math.round(voiceVolume * 100)}%</output></div></label>
                  <label className="spine-check spine-toggle-setting"><input type="checkbox" checked={showDialogue} onChange={(event) => setShowDialogue(event.target.checked)} />{t("spine.dialogue")}</label>
                </section>}

                 <section className="spine-settings-group">
                   <h3>{t("spine.settings.visualGroup")}</h3>
                   <label className="spine-check"><input type="checkbox" checked={showInteractionPoints} onChange={(event) => setShowInteractionPoints(event.target.checked)} disabled={!meta} />{t("spine.showInteractionPoints")}</label>
                   <label className="spine-setting-field"><span>{t("spine.effects")}</span><div className="spine-range-control"><input type="range" min="0" max="1" step="0.05" value={effectsStrength} onChange={(event) => setEffectsStrength(Number(event.target.value))} aria-label={t("spine.effects")} title={t("spine.effects.hint")} /><output>{Math.round(effectsStrength * 100)}%</output></div></label>
                </section>
              </div></div>
            </aside>}
        <p className="spine-caption">{meta ? t("spine.loaded", { animations: meta.animations.length }) : t("spine.caption")}</p>
      </section>
    </div>
    </div>
    {videoRecorderDialog && <div className="spine-recorder-backdrop">
      <section className={`spine-recorder-dialog${isExportProgressPhase ? " is-progress" : ""}`} role="dialog" aria-modal="true" aria-labelledby="spine-recorder-title">
        <div className="spine-recorder-heading">
          <div><span>{t("spine.recorder.eyebrow")}</span><h2 id="spine-recorder-title">{t(videoRecorderDialog.phase === "complete" ? "spine.recorder.complete" : isExportProgressPhase ? "spine.recorder.inProgress" : "spine.recorder.title")}</h2></div>
          {(videoRecorderDialog.phase === "settings" || videoRecorderDialog.phase === "error" || videoRecorderDialog.phase === "complete") && <button type="button" onClick={() => setVideoRecorderDialog(null)} aria-label={t("spine.recorder.close")}><IconClose /></button>}
        </div>
        <div className={`spine-recorder-content${isExportProgressPhase ? " is-progress" : ""}`}>
          <div className="spine-recorder-visual">
            <div className="spine-recorder-preview" data-aspect-ratio={outputAspectRatio} aria-label={t(recorderLivePreview ? "spine.recorder.previewLive" : "spine.recorder.previewSnapshot")}>
              {videoRecorderPreviewUrl
                ? <img src={videoRecorderPreviewUrl} alt={t(recorderLivePreview ? "spine.recorder.previewLive" : "spine.recorder.previewSnapshot")} />
                : <div className="spine-recorder-preview-empty"><span className="spine-recorder-spinner" aria-hidden="true" /><span>{t("spine.recorder.previewLoading")}</span></div>}
              <span className="spine-recorder-preview-label">{t(recorderLivePreview ? "spine.recorder.previewLive" : "spine.recorder.previewSnapshot")}</span>
            </div>
            {isExportProgressPhase && <section className="spine-recorder-summary" aria-label={t("spine.recorder.output")}>
              <h3>{t("spine.recorder.output")}</h3>
              <dl>
                <div><dt>{t("spine.recorder.fileName")}</dt><dd title={activeExportRun?.destination.filename}>{activeExportRun?.destination.filename ?? "—"}</dd></div>
                {activeExportRun?.destination.locationName && <div><dt>{t("spine.recorder.destination")}</dt><dd title={activeExportRun.destination.locationName}>{activeExportRun.destination.locationName}</dd></div>}
                <div><dt>{t("spine.recorder.character")}</dt><dd>{selectedCharacter}</dd></div>
                <div><dt>{t("spine.recorder.variant")}</dt><dd>{selectedVariant?.extraType ? extraLabel(selectedVariant.extraType) : selectedVariant?.variant ?? "—"}</dd></div>
                <div><dt>{t("spine.recorder.resolution")}</dt><dd>{recorderOutputDimensions.width} × {recorderOutputDimensions.height}</dd></div>
                <div><dt>{t("spine.recorder.frameRate")}</dt><dd>{recorderSettings.frameRate} FPS</dd></div>
                <div><dt>{t("spine.recorder.format")}</dt><dd>{recorderSettings.format.toUpperCase()} · {outputAspectRatio}</dd></div>
                <div><dt>{t("spine.recorder.sequence")}</dt><dd>{t(recorderSettings.mode === "full-sequence" ? "spine.recorder.mode.fullSequence" : recorderSettings.mode === "opening-idle" ? "spine.recorder.mode.openingIdle" : "spine.recorder.mode.idleOnly")}</dd></div>
                <div><dt>{t("spine.recorder.lightFx")}</dt><dd>{Math.round(effectsStrength * 100)}%</dd></div>
                <div><dt>{t("spine.recorder.includeAudio")}</dt><dd>{t(recorderSettings.includeAudio ? "spine.recorder.on" : "spine.recorder.off")}</dd></div>
                <div><dt>{t("spine.recorder.includeSubtitles")}</dt><dd>{t(recorderSettings.includeSubtitles ? "spine.recorder.on" : "spine.recorder.off")}</dd></div>
              </dl>
            </section>}
            {videoRecorderDialog.phase === "settings" && <section className="spine-recorder-settings-section spine-recorder-output-settings">
              <h3>{t("spine.recorder.outputSettings")}</h3>
              <div className="spine-recorder-fields">
                <label><span>{t("spine.recorder.resolution")}</span><select value={videoRecorderDialog.settings.resolution} onChange={(event) => updateVideoRecorderSettings({ resolution: Number(event.target.value) as VideoRecordingSettings["resolution"] })}>
                  <option value="720">720p</option><option value="1080">1080p</option><option value="1440">2K (1440p)</option><option value="2160">4K UHD (2160p)</option>
                </select></label>
                <label><span>{t("spine.recorder.frameRate")}</span><select value={videoRecorderDialog.settings.frameRate} onChange={(event) => updateVideoRecorderSettings({ frameRate: Number(event.target.value) as VideoRecordingSettings["frameRate"] })}>
                  <option value="30">30 FPS</option><option value="60">60 FPS</option>
                </select></label>
                <label><span>{t("spine.recorder.framing")}</span><select value={videoRecorderDialog.settings.framing} onChange={(event) => updateVideoRecorderSettings({ framing: event.target.value as VideoRecordingSettings["framing"] })}>
                  <option value="current">{t("spine.recorder.framing.current")}</option><option value="saved">{t("spine.recorder.framing.saved")}</option>
                </select></label>
                <label><span>{t("spine.recorder.format")}</span><select value={videoRecorderDialog.settings.format} onChange={(event) => updateVideoRecorderSettings({ format: event.target.value as VideoRecordingFormat })} disabled={videoRecorderFormats.length === 0}>
                  {videoRecorderFormats.map(({ format }) => <option key={format} value={format}>{format === "webm" ? "WebM" : "MP4"}</option>)}
                </select></label>
              </div>
              <div className="spine-recorder-toggles">
                <label><input type="checkbox" checked={videoRecorderDialog.settings.includeAudio} onChange={(event) => updateVideoRecorderSettings({ includeAudio: event.target.checked })} />{t("spine.recorder.includeAudio")}</label>
                <label><input type="checkbox" checked={videoRecorderDialog.settings.includeSubtitles} onChange={(event) => updateVideoRecorderSettings({ includeSubtitles: event.target.checked })} />{t("spine.recorder.includeSubtitles")}</label>
              </div>
            </section>}
          </div>
          <div className="spine-recorder-body">
            {videoRecorderDialog.phase === "settings" ? <>
              <section className="spine-recorder-settings-section">
                <h3>{t("spine.recorder.mode")}</h3>
                <div className="spine-recorder-fields">
                  <label><span className="spine-visually-hidden">{t("spine.recorder.mode")}</span><select aria-label={t("spine.recorder.mode")} value={videoRecorderDialog.settings.mode} onChange={(event) => updateVideoRecorderSettings({ mode: event.target.value as VideoRecordingSettings["mode"] })}>
                    <option value="full-sequence" disabled={!compositionActive || authoredTalkSequenceIds.length === 0}>{t("spine.recorder.mode.fullSequence")}</option>
                  <option value="opening-idle">{t("spine.recorder.mode.openingIdle")}</option>
                  <option value="idle-only">{t("spine.recorder.mode.idleOnly")}</option>
                  </select></label>
                  {videoRecorderDialog.settings.mode !== "full-sequence" && <label><span>{t("spine.recorder.idleLoops")}</span><input type="number" min="1" max="20" step="1" value={videoRecorderDialog.settings.idleLoops} onChange={(event) => updateVideoRecorderSettings({ idleLoops: Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))) })} />
                  </label>}
                </div>
                {videoRecorderDialog.settings.mode === "full-sequence" && <>
                  <div className="spine-recorder-full-options">
                    {hasOpeningSequence
                      ? <label><input type="checkbox" checked={videoRecorderDialog.settings.includeOpening} onChange={(event) => updateVideoRecorderSettings({ includeOpening: event.target.checked })} />{t("spine.recorder.includeOpening")}</label>
                      : <p className="spine-recorder-warning">{t("spine.recorder.openingMissing")}</p>}
                    <label><span>{t("spine.recorder.initialIdleLoops")}</span><input type="number" min="1" max="20" step="1" value={videoRecorderDialog.settings.initialIdleLoops} onChange={(event) => updateVideoRecorderSettings({ initialIdleLoops: Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))) })} /></label>
                    <label><span>{t("spine.recorder.betweenTalkIdle")}</span><input type="number" min="0" max="30" step="0.1" value={videoRecorderDialog.settings.betweenTalkIdleSeconds} onChange={(event) => updateVideoRecorderSettings({ betweenTalkIdleSeconds: Math.max(0, Math.min(30, Number(event.target.value) || 0)) })} /></label>
                    <label><span>{t("spine.recorder.finalIdleLoops")}</span><input type="number" min="1" max="20" step="1" value={videoRecorderDialog.settings.finalIdleLoops} onChange={(event) => updateVideoRecorderSettings({ finalIdleLoops: Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))) })} /></label>
                  </div>
                  <fieldset className="spine-recorder-talk-list">
                    <legend>{t("spine.recorder.talksToInclude")}</legend>
                    {recorderTalkOptions.map((talk) => {
                      const number = talk.sequenceId.match(/\d+$/)?.[0] ?? talk.sequenceId;
                      const checked = videoRecorderDialog.settings.talkSequenceIds.includes(talk.sequenceId);
                      return <label key={talk.sequenceId} className={talk.missingReason ? "has-warning" : undefined}>
                        <input type="checkbox" checked={checked} onChange={(event) => updateVideoRecorderSettings({ talkSequenceIds: event.target.checked
                          ? [...videoRecorderDialog.settings.talkSequenceIds, talk.sequenceId].sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0))
                          : videoRecorderDialog.settings.talkSequenceIds.filter((id) => id !== talk.sequenceId) })} />
                        <span>{t("spine.sequenceTalk", { n: number })}</span>
                        {talk.missingReason && <small>{talk.missingReason}</small>}
                        {!talk.missingReason && <small>{formatSeconds(talk.duration)}s</small>}
                      </label>;
                    })}
                  </fieldset>
                  {selectedMissingTalks.length > 0 && <p className="spine-recorder-error" role="alert">{selectedMissingTalks.map((talk) => `${talk.sequenceId}: ${talk.missingReason}`).join(" · ")}</p>}
                  <details className="spine-recorder-sequence-preview">
                    <summary>
                      <span>{t("spine.recorder.sequencePreview")}</span>
                      <small>{recorderEstimate?.segments?.length
                        ? `${t("spine.recorder.segmentCount", { count: recorderEstimate.segments.length })} · ${formatSeconds(recorderEstimate.totalDuration)}s`
                        : t("spine.recorder.estimateLoading")}</small>
                    </summary>
                    {recorderEstimate?.segments?.length
                      ? <ol>{recorderEstimate.segments.map((segment, index) => {
                        const label = segment.kind === "opening" ? t("spine.recorder.segment.opening")
                          : segment.kind === "initial-idle" ? t("spine.recorder.segment.initialIdle")
                            : segment.kind === "between-idle" ? t("spine.recorder.segment.betweenIdle")
                              : segment.kind === "talk" ? t("spine.recorder.segment.talk", { n: segment.talkNumber ?? index, total: segment.talkCount ?? 0 })
                                : segment.kind === "final-idle" ? t("spine.recorder.segment.finalIdle")
                                  : t("spine.recorder.idleLoops");
                        return <li key={`${segment.kind}:${segment.sequenceId ?? "idle"}:${index}`}><span>{label}</span><small>{formatSeconds(segment.duration)}s</small></li>;
                      })}</ol>
                      : <p className="spine-recorder-note">{t("spine.recorder.estimateLoading")}</p>}
                    <p className="spine-recorder-note">{t("spine.recorder.finalIdleNote")}</p>
                  </details>
                </>}
              </section>
              <p className="spine-recorder-estimate">{recorderEstimate
                ? t("spine.recorder.estimate", { duration: recorderEstimate.totalDuration.toFixed(1), frames: recorderEstimateFrames })
                : t("spine.recorder.estimateLoading")}</p>
              <p className="spine-recorder-note">{t("spine.recorder.note")}</p>
              {!recorderUsesFfmpeg && <p className="spine-recorder-fallback-note">{t("spine.recorder.fallback")}</p>}
              {videoRecorderFormats.length === 0 && <p className="spine-recorder-error" role="alert">{t("spine.recorder.unsupported")}</p>}
            </> : videoRecorderDialog.phase === "error" ? <>
              <p className="spine-recorder-error" role="alert">{videoRecorderDialog.error}</p>
            </> : videoRecorderDialog.phase === "complete" ? <>
              <p className="spine-recorder-complete-file" role="status">{t("spine.recorder.savedAs", { name: videoRecorderDialog.savedFileName ?? "" })}</p>
              <dl className="spine-recorder-complete-details">
                {videoRecorderDialog.savedLocation && <div><dt>{t("spine.recorder.destination")}</dt><dd title={videoRecorderDialog.savedLocation}>{videoRecorderDialog.savedLocation}</dd></div>}
                <div><dt>{t("spine.recorder.fileSize")}</dt><dd>{formatRecorderBytes(videoRecorderDialog.outputBytes)}</dd></div>
                <div><dt>{t("spine.recorder.duration")}</dt><dd>{videoRecorderDialog.outputDurationSeconds === undefined ? "—" : `${formatSeconds(videoRecorderDialog.outputDurationSeconds)}s`}</dd></div>
                <div><dt>{t("spine.recorder.resolution")}</dt><dd>{videoRecorderDialog.outputWidth && videoRecorderDialog.outputHeight ? `${videoRecorderDialog.outputWidth} × ${videoRecorderDialog.outputHeight}` : "—"}</dd></div>
                <div><dt>{t("spine.recorder.frameRate")}</dt><dd>{videoRecorderDialog.outputFrameRate ? `${videoRecorderDialog.outputFrameRate} FPS` : "—"}</dd></div>
                {videoRecorderDialog.encoder && <div><dt>{t("spine.recorder.encoderName")}</dt><dd>{videoRecorderDialog.encoder}{videoRecorderDialog.encoderHardware !== undefined ? ` · ${recorderEncoderType}` : ""}</dd></div>}
                {videoRecorderDialog.encoderAttempt && videoRecorderDialog.encoderAttempts && <div><dt>{t("spine.recorder.encoderAttemptLabel")}</dt><dd>{videoRecorderDialog.encoderAttempt} / {videoRecorderDialog.encoderAttempts}</dd></div>}
                <div><dt>{t("spine.recorder.totalElapsed")}</dt><dd>{formatRecorderDuration(videoRecorderDialog.exportElapsedSeconds)}</dd></div>
              </dl>
            </> : <div className="spine-recorder-dashboard" aria-live="polite">
              <div className="spine-recorder-dashboard-heading">
                <div>
                  <span className="spine-recorder-current-label">{t("spine.recorder.currentStage")}</span>
                  <strong>{videoRecorderDialog.phase === "preparing" ? t("spine.recorder.preparing")
                    : videoRecorderDialog.phase === "recording" ? t("spine.recorder.recording")
                      : videoRecorderDialog.phase === "rendering" ? t("spine.recorder.rendering")
                        : videoRecorderDialog.phase === "mixing" ? t("spine.recorder.mixing")
                          : videoRecorderDialog.phase === "encoding" ? t("spine.recorder.encoding")
                            : videoRecorderDialog.phase === "canceling" ? t("spine.recorder.canceling")
                              : t("spine.recorder.saving")}</strong>
                  <span className="spine-recorder-current-detail">
                    {videoRecorderDialog.phase === "preparing" && (videoRecorderDialog.detail ?? t("spine.recorder.waiting"))}
                     {videoRecorderDialog.phase === "recording" && activeExportRun?.plan && (activeExportRun.plan.mode === "full-sequence"
                       ? recorderSegmentLabel
                       : t("spine.recorder.loopProgress", { completed: activeExportProgress?.idleLoopsCompleted ?? 0, total: activeExportRun.plan.idleLoops }))}
                     {videoRecorderDialog.phase === "rendering" && <>{recorderSegmentLabel && <>{recorderSegmentLabel} · </>}{t("spine.recorder.frameProgress", { rendered: videoRecorderDialog.framesRendered ?? 0, total: videoRecorderDialog.totalFrames ?? 0 })}</>}
                    {videoRecorderDialog.phase === "mixing" && recorderAudioTrackProgress}
                    {videoRecorderDialog.phase === "encoding" && <>{videoRecorderDialog.encoder ? t("spine.recorder.encoder", { name: videoRecorderDialog.encoder }) : t("spine.recorder.encoding")}{videoRecorderDialog.encoderAttempt && videoRecorderDialog.encoderAttempts ? ` · ${t("spine.recorder.encoderAttempt", { attempt: videoRecorderDialog.encoderAttempt, total: videoRecorderDialog.encoderAttempts })}` : ""}</>}
                    {videoRecorderDialog.phase === "saving" && recorderSaveOperation}
                    {videoRecorderDialog.phase === "canceling" && t("spine.recorder.canceling")}
                  </span>
                </div>
                <strong className="spine-recorder-percent">{recorderProgressPercent === null ? "—" : `${recorderProgressPercent}%`}</strong>
              </div>
              <ol className="spine-recorder-stages" aria-label={t("spine.recorder.stages")}>
                {recorderStageItems.map((stage, index) => <li key={stage.id} className={index < recorderCurrentStageIndex ? "is-complete" : index === recorderCurrentStageIndex ? "is-current" : ""}>
                  <span className="spine-recorder-stage-marker" aria-hidden="true">{index < recorderCurrentStageIndex ? "✓" : index + 1}</span>
                  <span>{stage.label}</span>
                </li>)}
              </ol>
              <div className={`spine-recorder-progress${recorderProgressPercent === null ? " is-indeterminate" : ""}`} role="progressbar" aria-label={t("spine.recorder.progressAria")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={recorderProgressPercent ?? undefined}>
                <span style={recorderProgressPercent === null ? undefined : { width: `${recorderProgressPercent}%` }} />
              </div>
              <div className={`spine-recorder-metrics${activeExportUsesFfmpeg ? " is-frame-export" : ""}`}>
                {recorderMetricItems.map((item) => <div className="spine-recorder-metric" key={item.label}>
                  <span>{item.label}</span><strong>{item.value}</strong>
                </div>)}
              </div>
            </div>}
          </div>
        </div>
        <div className="spine-recorder-footer">
          {videoRecorderDialog.phase === "settings" && <div className="spine-recorder-actions">
            <button type="button" className="spine-recorder-secondary" onClick={() => setVideoRecorderDialog(null)}>{t("spine.recorder.cancel")}</button>
            <button type="button" className="spine-recorder-primary" disabled={!videoRecorderFormats.length || !meta || !recorderMetrics?.ready || (videoRecorderDialog.settings.mode === "full-sequence" && (!compositionActive || !selectedInteractionProject || !fullSequenceMetrics?.ready || authoredTalkSequenceIds.length === 0 || selectedMissingTalks.length > 0))} onClick={() => void startVideoRecording()}>{t("spine.recorder.start")}</button>
          </div>}
          {videoRecorderDialog.phase === "error" && <div className="spine-recorder-actions">
            <button type="button" className="spine-recorder-secondary" onClick={() => setVideoRecorderDialog({ phase: "settings", settings: videoRecorderSettings, elapsed: 0 })}>{t("spine.recorder.recordAgain")}</button>
            <button type="button" className="spine-recorder-primary" onClick={() => setVideoRecorderDialog(null)}>{t("spine.recorder.close")}</button>
          </div>}
          {videoRecorderDialog.phase === "complete" && <div className="spine-recorder-actions">
            <button type="button" className="spine-recorder-secondary" onClick={() => setVideoRecorderDialog({ phase: "settings", settings: videoRecorderSettings, elapsed: 0 })}>{t("spine.recorder.recordAgain")}</button>
            <button type="button" className="spine-recorder-primary" onClick={() => setVideoRecorderDialog(null)}>{t("spine.recorder.close")}</button>
          </div>}
          {isExportProgressPhase && <div className="spine-recorder-actions">
            <button type="button" className="spine-recorder-secondary" disabled={videoRecorderDialog.phase !== "preparing" && videoRecorderDialog.phase !== "recording" && videoRecorderDialog.phase !== "rendering" && videoRecorderDialog.phase !== "mixing"} onClick={() => stopVideoRecording(false)}>{t("spine.recorder.cancelExport")}</button>
          </div>}
        </div>
      </section>
    </div>}
  </main>;
}
