import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IconChevronDown, IconChevronUp, IconClose, IconCompress, IconDot, IconExpand, IconEye, IconEyeOff, IconFolder, IconHand, IconMessage, IconPause, IconPlay, IconRotate, IconSearch, IconSliders, IconStar, IconSync, IconTarget, IconUsers } from "@ba-spine/app-ui/icons";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { setLanguage, t, useLanguage, type LangKey } from "./i18n";
import { normalizeVoiceVolume, readViewerVoiceVolume, restoreViewerHandoffState, writeViewerVoiceVolume, type ViewerHandoffRestoreState, type ViewerReloadSnapshot } from "./handoffState";
import { acknowledgeDesktopHandoff, chooseDesktopSource, chooseDesktopSourceAt, isDesktopHost, loadDesktopSource, readDesktopDraftSnapshot, receiveDesktopHandoffs, sendDesktopHandoff, type DesktopAssetSource } from "./desktopSource";
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

type ViewerDraftPreview = Omit<SpineDraftSnapshot, "project"> & { project: SpineInteractionProject };

const bundledCharacterIndex = characterIndexJson as CharacterIndex;

function projectTimelineDuration(timeline: SpineTimeline, project: SpineInteractionProject | null): number {
  const talkMix = normalizeAnimationMixDuration(project?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
  return timelinePlaybackDuration(timeline, 0, undefined, talkMix);
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

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : t("spine.error.unknown");
}


export interface SpineViewportHandle {
  resetCamera: () => void;
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
      });
      rendererRef.current = renderer;
      return () => {
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch (error) {
      callbacks.current.onError(new Error(errorMessage(error)));
    }
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setInteractionMode(interactionMode);
    renderer.setSkipIntro(skipIntro);
    if (files) void renderer.load(files, directory, interactionProject);
    else renderer.clear();
  }, [files, directory, interactionProject]);

  useEffect(() => rendererRef.current?.setAnimation(animation), [animation]);
  useEffect(() => rendererRef.current?.setPlaying(playing), [playing]);
  useEffect(() => rendererRef.current?.setSpeed(speed), [speed]);
  useEffect(() => rendererRef.current?.setLoop(loop), [loop]);
  useEffect(() => rendererRef.current?.setCameraMode(cameraMode), [cameraMode]);
  useEffect(() => rendererRef.current?.setInteractionMode(interactionMode), [interactionMode]);
  useEffect(() => rendererRef.current?.setSkipIntro(skipIntro), [skipIntro]);
  useEffect(() => rendererRef.current?.setEffectsStrength(effectsStrength), [effectsStrength]);
  useEffect(() => rendererRef.current?.setShowInteractionPoints(showInteractionPoints), [showInteractionPoints]);

  useImperativeHandle(ref, () => ({
    resetCamera: () => rendererRef.current?.resetCamera(),
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
  }), []);

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
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [cameraMode, setCameraMode] = useState<SpineCameraMode>("fill");
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
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<SpineViewportHandle>(null);
  const compositionRef = useRef<SpineCompositionViewportHandle>(null);
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
  const freeCameraMode = useRef<SpineCameraMode>("fill");
  const freePlaying = useRef(true);
  const freeLoop = useRef(true);
  const freeSpeed = useRef(1);
  const progressRef = useRef(progress);
  const navigationRootRef = useRef<string | null>(null);
  draftPreviewRef.current = draftPreview;
  progressRef.current = progress;

  talkAutoplayRef.current = talkAutoplay;

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
  const compositionSequenceIds = selectedInteractionProject ? timelineSequenceIds(selectedInteractionProject) : [];
  const compositionSequenceSignature = compositionSequenceIds.join("\u001f");
  const compositionSequenceId = selectedSequenceId && compositionSequenceIds.includes(selectedSequenceId)
    ? selectedSequenceId
    : "";
  const compositionTimeline = selectedInteractionProject ? timelineForSequence(selectedInteractionProject, compositionSequenceId) : null;
  const compositionActive = Boolean(compositionTimeline);
  const authoredTalkSequenceIds = selectedInteractionProject ? timelineTalkSequenceIds(selectedInteractionProject) : [];
  const authoredTalkAutoplayAvailable = Boolean(
    selectedInteractionProject
      && authoredTalkSequenceIds.length > 0
      && timelineForSequence(selectedInteractionProject, "opening"),
  );
  const activeViewport = () => compositionActive ? compositionRef.current : viewportRef.current;
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
    setIdleMode("none");
    setSelectedSequenceId(initialSequence);
    const initialTimeline = selectedInteractionProject && initialSequence ? timelineForSequence(selectedInteractionProject, initialSequence) : null;
    setProgress({
      time: 0,
      duration: initialTimeline ? projectTimelineDuration(initialTimeline, selectedInteractionProject) : 0,
      animation: null,
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
    () => [...new Set([...(introVoiceLine?.audio ?? []), ...voiceLines.flatMap((line) => line.audio)])],
    [introVoiceLine, voiceLines],
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
  const isLoading = !error && Boolean(folderLoading || filesLoading || rendererLoading || rendererPending || voiceAudioLoading || compositionAudioLoading);
  const compositionRendererProgress = compositionLoadProgress?.stage === "audio" ? null : compositionLoadProgress;
  const loadingProgress: SpineLoadProgress | null = folderLoading
      ? null
      : filesLoading
        ? { stage: "files", loaded: 0, total: 0 }
      : rendererLoading || rendererPending
        ? (compositionActive ? compositionRendererProgress : rendererLoadProgress) ?? { stage: "skeleton", loaded: 0, total: 1 }
        : voiceAudioLoading
          ? { stage: "audio", ...voiceAudioProgress }
          : compositionAudioLoading
            ? compositionLoadProgress
            : null;
  const animationOptions = meta
    ? [
      ...(meta.introAnimation && meta.idleAnimation ? [INTRO_ANIMATION] : []),
      ...meta.animations,
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
      const talkStillActive = compositionActive
        ? compositionRef.current?.isTalkActive() === true
        : viewportRef.current?.isTalkActive() === true;
      if (talkStillActive) {
        queueNextAutoTalk(lineIndex, run, attempt + 1);
        return;
      }
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
    setSelectedSequenceId("");
    setIdleMode("none");
    setAnimation("");
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
    if (compositionActive) return false;
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
      void Promise.all(paths.map(async (path) => {
        const audio = await cachedVoiceAudio(cache, source, path);
        if (audio) await audio.ready;
        if (live) setVoiceAudioProgress({ loaded: ++loaded, total: paths.length });
      }));
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
      if (document.fullscreenElement) {
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
    const onFullscreen = () => {
      const active = Boolean(document.fullscreenElement);
      clearFullscreenHideTimer();
      clearFullscreenControlsHintTimer();
      setShowFullscreenControlsHint(false);
      if (active) fullscreenControlsHintSeenRef.current = false;
      setFullscreen(active);
      setShowSidebar(!active);
      setShowOptions(false);
      setShowFullscreenControls(!active);
      setFullscreenClean(false);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const layout = fullscreenLayoutRef.current;
    const controls = fullscreenControlsRef.current;
    if (!layout || !controls || typeof ResizeObserver === "undefined") return;

    const updateControlsHeight = () => layout.style.setProperty("--spine-fullscreen-controls-height", `${controls.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(updateControlsHeight);
    observer.observe(controls);
    updateControlsHeight();
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--spine-fullscreen-controls-height");
    };
  }, []);

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
    if (!event.currentTarget.files?.length) return;
    resetAssetPlayback();
    setSource(sourceFromInput(event.currentTarget.files));
    setAvailableDirectories(null);
    setSetFiles(null);
  };

  const selectCharacter = (name: string) => {
    const first = indexedAssets(characterIndex.characters[name]).find((variant) => !availableDirectories || availableDirectories.has(variant.directory));
    resetAssetPlayback();
    setSelectedCharacter(name);
    setSelectedDirectory(first?.directory ?? "");
  };

  const selectLobby = (lobbyId: string) => {
    const character = Object.entries(characterIndex.characters)
      .find(([, entry]) => indexedAssets(entry).some((asset) => asset.directory === lobbyId));
    if (!character || !availableDirectories?.has(lobbyId)) return;
    resetAssetPlayback();
    setSelectedCharacter(character[0]);
    setSelectedDirectory(lobbyId);
  };

  const toggleFavorite = (lobbyId: string) => {
    setNavigation((current) => toggleViewerFavorite(current, lobbyId));
  };

  const onCharacterListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!filteredCharacters.length || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='option']")];
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[role='option']") : null;
    const focused = target ? options.indexOf(target) : -1;
    const current = focused >= 0 ? focused : Math.max(0, filteredCharacters.indexOf(selectedCharacter));
    const next = nextViewerListIndex(filteredCharacters.length, current, event.key);
    if (next < 0) return;
    event.preventDefault();
    options[next]?.focus();
    selectCharacter(filteredCharacters[next]!);
  };

  const selectAnimation = (value: string) => {
    stopVoice();
    setAnimation(value);
    viewportRef.current?.setAnimation(value);
    setProgress((current) => ({ ...current, time: 0 }));
  };

  const toggleSkipIntro = (value: boolean) => {
    if (interactionMode === "interaction") stopVoice();
    setSkipIntro(value);
    if (!meta) return;
    if (interactionMode === "interaction") {
      setAnimation(value && meta.idleAnimation ? meta.idleAnimation : meta.defaultAnimation);
    } else if (value && animation === INTRO_ANIMATION && meta.idleAnimation) {
      selectAnimation(meta.idleAnimation);
    }
  };

  const selectInteractionMode = (value: SpineInteractionMode) => {
    if (value === interactionMode) return;
    stopVoice();
    if (value === "interaction") {
      freeCameraMode.current = cameraMode;
      freePlaying.current = playing;
      freeLoop.current = loop;
      freeSpeed.current = speed;
      setCameraMode("game");
      setPlaying(true);
      setLoop(true);
      setSpeed(1);
    } else {
      setCameraMode(freeCameraMode.current);
      setPlaying(freePlaying.current);
      setLoop(freeLoop.current);
      setSpeed(freeSpeed.current);
    }
    setInteractionMode(value);
    viewportRef.current?.setInteractionMode(value);
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
      // Wait for the entire authored talk, including its return to idle.
      // Keep this composition and its loaded skeletons. Idle is an explicit
      // animation override, never a selection of the opening sequence.
      setProgress({ time: 0, duration: Math.max(0.01, compositionTimeline?.openingIdleDuration ?? 3), animation: null });
      setIdleMode(authoredAutoplay ? "bridge" : "persistent");
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

  const togglePlayback = () => setPlaying((value) => !value);

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
    if (restoring) setCameraMode(restoring.cameraMode);
    else setCameraMode(interactionMode === "interaction" ? "game" : next?.hasGameCamera ? "game" : "fill");
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
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, button, a, [contenteditable]")) return;
      const key = event.key.toLowerCase();

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
        void activeViewport()?.toggleFullscreen();
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
      } else if (key === "escape" && fullscreenClean) {
        event.preventDefault();
        exitCleanFullscreen();
      } else if (key === "h" && fullscreen) {
        event.preventDefault();
        if (fullscreenClean) exitCleanFullscreen();
        else if (showFullscreenControls) hideFullscreenControls();
        else revealFullscreenControls();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cameraMode, compositionActive, compositionSequenceId, fullscreen, fullscreenClean, interactionMode, interactionReady, loop, meta, playing, selectedInteractionProject, showFullscreenControls, speed, voiceLines.length]);

  return <main className="spine-page">
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

    <div ref={fullscreenLayoutRef} className={`spine-layout${showSidebar ? "" : " spine-sidebar-hidden"}${fullscreenClean ? " spine-clean-mode" : ""}`}>
      <aside id="spine-sidebar" className="spine-sidebar">
        <section className="spine-selector panel">
          <div className="spine-panel-heading">
            <div className="phead"><IconUsers /><span>{t("spine.characters")}</span></div>
            <span className="spine-character-count">{t("spine.characterCount", { n: filteredCharacters.length })}</span>
          </div>
          <label className="spine-search-field">
            <IconSearch />
            <input
              className="search spine-character-search"
              value={characterSearch}
              onChange={(event) => setCharacterSearch(event.target.value)}
              placeholder={t("spine.characterSearch")}
              aria-label={t("spine.characterSearchAria")}
            />
          </label>
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
          <div className="spine-character-list" role="listbox" aria-label={t("spine.charactersAria")} aria-keyshortcuts="ArrowUp ArrowDown Home End" aria-describedby="spine-character-keyboard-hint" onKeyDown={onCharacterListKeyDown}>
            {filteredCharacters.map((name) => {
              const availableAssets = indexedAssets(characterIndex.characters[name]).filter((variant) => availableDirectories?.has(variant.directory));
              const count = availableAssets.length;
              return <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === selectedCharacter}
                tabIndex={name === (filteredCharacters.includes(selectedCharacter) ? selectedCharacter : filteredCharacters[0]) ? 0 : -1}
                className={name === selectedCharacter ? "is-selected" : undefined}
                onClick={() => selectCharacter(name)}
              >
                <LobbyThumbnail source={thumbnailSource} directory={availableAssets[0]?.directory ?? ""} />
                <span className="spine-character-option-label">{name}</span><small>{count}</small>
              </button>;
            })}
            {filteredCharacters.length === 0 && <p className="hint">{source && !availableDirectories ? t("spine.loading") : t("spine.noCharacters")}</p>}
          </div>
          <div className="spine-variant-picker">
            {selectedDirectoryName && <button className={`spine-favorite-toggle${navigation.favorites.includes(selectedDirectoryName) ? " is-favorite" : ""}`} type="button" aria-pressed={navigation.favorites.includes(selectedDirectoryName)} onClick={() => toggleFavorite(selectedDirectoryName)}>
              <IconStar /><span>{t(navigation.favorites.includes(selectedDirectoryName) ? "spine.favorite.remove" : "spine.favorite.add")}</span>
            </button>}
            <label className="spine-field">
              <span>{t("spine.variant")}</span>
               <select value={selectedDirectoryName} onChange={(event) => { resetAssetPlayback(); setSelectedDirectory(event.target.value); }} aria-label={t("spine.variantAria")}>
                 {variants.some((variant) => !variant.extraType) && <optgroup label={t("spine.variant")}>
                   {variants.filter((variant) => !variant.extraType).map((variant) => <option key={variant.directory} value={variant.directory}>{variant.variant}</option>)}
                 </optgroup>}
                 {variants.some((variant) => variant.extraType) && <optgroup label={t("spine.extras")}>
                   {variants.filter((variant) => variant.extraType).map((variant) => <option key={variant.directory} value={variant.directory}>{extraLabel(variant.extraType!)}</option>)}
                 </optgroup>}
               </select>
            </label>
            <details className="spine-set-meta"><summary>{t("spine.assetDetails")}</summary><div>
              <code>{selectedDirectoryName}</code>
              {selectedVariant?.assetId && <span>{selectedVariant.assetId}</span>}
            </div></details>
          </div>
        </section>
      </aside>

        <section className={`spine-workspace${showFullscreenControls && !fullscreenClean ? "" : " spine-controls-hidden"}`} aria-label={t("spine.viewerAria")}>
        <div className="spine-workspace-heading">
           <div className="spine-workspace-identity"><strong>{selectedCharacter}</strong><span>{selectedVariant?.extraType ? extraLabel(selectedVariant.extraType) : selectedVariant?.variant}</span></div>
          <div className="spine-workspace-status">
            <small>{t(meta ? "spine.preview.ready" : "spine.preview.waiting")}</small>
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
        <div className="spine-stage-frame" onPointerDown={(event) => {
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
               interactionMode={interactionMode}
               interactionProject={selectedInteractionProject}
               showInteractionPoints={showInteractionPoints}
               currentTime={progress.time}
                playing={playing}
                speed={speed}
                effectsStrength={effectsStrength}
                idleMode={idleMode}
               onMeta={handleViewportMeta}
               onProgress={setProgress}
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
              cameraMode={cameraMode}
              interactionMode={interactionMode}
              skipIntro={skipIntro}
              showInteractionPoints={showInteractionPoints}
               effectsStrength={effectsStrength}
               onMeta={handleViewportMeta}
               onProgress={(next) => { if (!compositionActive) setProgress(next); }}
               onLoading={(loading) => { setRendererLoading(loading); if (!loading) setRendererLoadProgress(null); }}
               onLoadProgress={setRendererLoadProgress}
                onError={handleViewportError}
              onCameraMode={(mode) => setCameraMode(interactionMode === "interaction" ? "game" : mode)}
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
              {interactionReady && meta?.interaction.talkCount ? <button className="spine-tool-button" type="button" onClick={() => playTalk()} aria-label={t("spine.talkAria")} title={t("spine.talkAria")}><IconMessage /><span>{t("spine.talk")}</span><small>{meta.interaction.talkCount}</small></button> : null}
               {interactionReady && (voiceLines.length > 0 || authoredTalkAutoplayAvailable) ? <button className={`spine-tool-button${talkAutoplay ? " is-active" : ""}`} type="button" onClick={toggleTalkAutoplay} aria-pressed={talkAutoplay} aria-label={t(talkAutoplay ? "spine.autoplayStop" : "spine.autoplayStart")} title={t(talkAutoplay ? "spine.autoplayStop" : "spine.autoplayStart")}><span>{talkAutoplay ? <IconPause /> : <IconPlay />}</span><span>{t("spine.autoplay")}</span></button> : null}
              <button className={`spine-tool-button${showInteractionPoints ? " is-active" : ""}`} type="button" disabled={!meta} aria-pressed={showInteractionPoints} onClick={() => setShowInteractionPoints((shown) => !shown)} aria-label={t("spine.showInteractionPoints")} title={t("spine.showInteractionPoints")}><IconTarget /><span>{t("spine.points")}</span></button>
              <button className={`spine-tool-button${showOptions ? " is-active" : ""}`} type="button" aria-expanded={showOptions} aria-controls="spine-options" onClick={() => setShowOptions((shown) => !shown)}><IconSliders /><span>{t("spine.options")}</span></button>
              <button className="spine-tool-button spine-sidebar-toggle" type="button" aria-expanded={showSidebar} aria-controls="spine-sidebar" onClick={() => setShowSidebar((shown) => !shown)} title={t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}><IconUsers /><span>{t(showSidebar ? "spine.sidebar.hide" : "spine.sidebar.show")}</span></button>
               {fullscreen && <button className="spine-tool-button spine-clean-mode-toggle" type="button" aria-pressed={fullscreenClean} onClick={fullscreenClean ? exitCleanFullscreen : enterCleanFullscreen} title={t(fullscreenClean ? "spine.cleanMode.exit" : "spine.cleanMode.enter")}><span>{fullscreenClean ? <IconEye /> : <IconEyeOff />}</span><span>{t("spine.cleanMode")}</span></button>}
                {fullscreen && <button className="spine-tool-button spine-fullscreen-controls-toggle" type="button" aria-expanded={showFullscreenControls} onClick={showFullscreenControls ? hideFullscreenControls : revealFullscreenControls} title={t(showFullscreenControls ? "spine.controls.hide" : "spine.controls.show")}><IconChevronDown /><span>{t(showFullscreenControls ? "spine.controls.hide" : "spine.controls.show")}</span></button>}
               <button className="spine-tool-button" type="button" onClick={() => void activeViewport()?.toggleFullscreen()} aria-label={t(fullscreen ? "a11y.fullscreenExit" : "a11y.fullscreenEnter")} title={t(fullscreen ? "a11y.fullscreenExit" : "a11y.fullscreenEnter")}><span>{fullscreen ? <IconCompress /> : <IconExpand />}</span><span className="spine-button-label">{t("spine.fullscreen")}</span></button>
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

          {showOptions && <div id="spine-options" className="spine-settings-panel">
            <div className="spine-settings-heading"><strong>{t("spine.options")}</strong><button type="button" onClick={() => setShowOptions(false)} aria-label={t("spine.options.close")} title={t("spine.options.close")}><IconClose /></button></div>
            <div className="spine-settings-grid">
              {interactionMode === "free" && <>
                {!compositionActive && <>
                  <label className="spine-setting-field spine-animation-field"><span>{t("spine.animation")}</span><select value={animation} onChange={(event) => selectAnimation(event.target.value)} disabled={!meta} aria-label={t("spine.animationAria")}>
                    {animationOptions.map((name) => <option key={name} value={name}>{name === INTRO_ANIMATION ? t("spine.introIdle") : name}</option>)}
                  </select></label>
                  <label className="spine-setting-field"><span>{t("spine.camera")}</span><select value={cameraMode} onChange={(event) => setCameraMode(event.target.value as SpineCameraMode)} disabled={!meta} aria-label={t("spine.cameraAria")}>
                    <option value="fill">{t("spine.camera.fill")}</option><option value="fit">{t("spine.camera.fit")}</option>{meta?.hasGameCamera && <option value="game">{t("spine.camera.game")}</option>}
                  </select></label>
                </>}
                <label className="spine-setting-field"><span>{t("spine.speed")}</span><select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label={t("spine.speedAria")}>
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
                </select></label>
                {!compositionActive && <label className="spine-check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />{t("spine.loop")}</label>}
                 </>}
                  {selectedInteractionProject && compositionSequenceIds.length > 0 && <label className="spine-setting-field"><span>{t("spine.sequence")}</span><select value={compositionSequenceId || "__runtime-intro__"} onChange={(event) => { const next = event.target.value === "__runtime-intro__" ? "" : event.target.value; const nextTimeline = next ? timelineForSequence(selectedInteractionProject, next) : null; stopVoice(); setIdleMode("none"); setProgress({ time: 0, duration: nextTimeline ? projectTimelineDuration(nextTimeline, selectedInteractionProject) : 0, animation: null }); setSelectedSequenceId(next); }} aria-label={t("spine.sequenceAria")}>
                    {!compositionSequenceId && <option value="__runtime-intro__">Runtime intro</option>}
                    {compositionSequenceIds.map((id) => <option key={id} value={id}>{id === "opening" ? t("spine.sequenceOpening") : id.match(/^talk-(\d+)$/)?.[1] ? t("spine.sequenceTalk", { n: id.match(/^talk-(\d+)$/)![1]! }) : id}</option>)}
                  </select></label>}
                 {!compositionActive && <label className="spine-check spine-toggle-setting"><input type="checkbox" checked={skipIntro} onChange={(event) => toggleSkipIntro(event.target.checked)} />{t("spine.skipIntro")}</label>}
                 {voiceLines.length > 0 && <>
                    <label className="spine-check spine-toggle-setting"><input type="checkbox" checked={voiceEnabled} onChange={(event) => setVoiceEnabled(event.target.checked)} />{t("spine.voice")}{voicePlaying && <small><IconDot /></small>}</label>
                    <label className="spine-setting-field"><span>{t("spine.voiceVolume")}</span><input type="range" min="0" max="1" step="0.05" value={voiceVolume} onChange={(event) => setVoiceVolume(normalizeVoiceVolume(Number(event.target.value)))} aria-label={t("spine.voiceVolume")} /><output>{Math.round(voiceVolume * 100)}%</output></label>
                   <label className="spine-check spine-toggle-setting"><input type="checkbox" checked={showDialogue} onChange={(event) => setShowDialogue(event.target.checked)} />{t("spine.dialogue")}</label>
                </>}
                <label className="spine-setting-field spine-effects-field"><span>{t("spine.effects")}</span><input type="range" min="0" max="1" step="0.05" value={effectsStrength} onChange={(event) => setEffectsStrength(Number(event.target.value))} aria-label={t("spine.effects")} title={t("spine.effects.hint")} /><output>{Math.round(effectsStrength * 100)}%</output></label>
               <button className="spine-settings-action" type="button" disabled={!meta} onClick={() => activeViewport()?.resetCamera()}><IconRotate /><span>{t("spine.resetView")}</span></button>
               {interactionMode === "free" && !compositionActive && meta?.introAnimation && meta.idleAnimation && <button className="spine-settings-action" type="button" onClick={() => { setAnimation(INTRO_ANIMATION); setProgress((current) => ({ ...current, time: 0 })); viewportRef.current?.replayIntro(); }}><IconRotate /><span>{t("spine.replayIntro")}</span></button>}
            </div>
          </div>}
        </div>
        <p className="spine-caption">{meta ? t("spine.loaded", { animations: meta.animations.length }) : t("spine.caption")}<span className="spine-shortcuts"><strong>{t("spine.shortcuts")}</strong> {t("spine.shortcutsHint")}</span></p>
      </section>
    </div>
  </main>;
}
