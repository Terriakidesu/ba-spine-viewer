import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { type SpineCameraPose, type SpineFiles, type SpineMeta, type SpineRenderer } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { DEFAULT_TALK_MIX_DURATION, normalizeAnimationMixDuration } from "@ba-spine/spine-runtime/spine/spineInteraction";
import {
  compositionDirectories,
  createTimelineLayer,
  ensureTimelineLayers,
  type EditorAnimationClip,
  type EditorColorLayer,
  type EditorProject,
  type EditorAudioClip,
  type EditorSubtitleCue,
  type EditorTimelineLayer,
  type TimelineLanguage,
  type TimelineLayerRole,
} from "./editorModel";
import type { DesktopAssetSource } from "./desktopSource";
import { manifestReferenceCandidates } from "@ba-spine/spine-runtime/spine/spineManifest";
import type { EditorSaveFile } from "./editorProject";
import { audioPlaybackDecision, clampAudioEnd, clampAudioStart, decodedAudioTiming } from "./audioModel";
import { animationClipEnd, animationEndForLayer, authoredTimelineEnd, deleteAnimationClipRipple, duplicateAnimationClipRipple, effectiveAnimationClips, extendTimelineDuration, insertAnimationClipRipple, linkAudioToSubtitle, linkedSubtitleForAudio, matchAudioAndSubtitleLength, moveAnimationClipRipple, nextTalkSequenceId, openingTimelineDuration, replaceSubtitleImport, resolveTimelineSnap, snapToTargets, splitCue, switchSequence, talkSequenceId } from "./sequenceModel";
import { advanceSpineTimeline, normalizeColorClipFades, timelineActiveColorClip, timelineActiveSubtitleTexts, timelineAudioPreloadsReady, timelineBlendModeCss, timelineColorClipOpacity, timelineLayerAnimation, timelineMainAnimation, timelinePlaybackDuration, timelineReferenceLayerId, timelineSceneHidesCharacter, timelineVisualLayers, type SpineTimelineAudioPreloadState } from "@ba-spine/spine-runtime/spine/spineTimeline";
import { SpineTimelineLayerCanvas } from "@ba-spine/spine-runtime/ui/SpineTimelineLayerCanvas";
import { spineAudioPathCandidates } from "@ba-spine/spine-runtime/spine/spineAudio";
import { serializeSubtitleDocument } from "./subtitleDocument";
import type { RecentFile } from "./recentFiles";
import { AssetPickerModal } from "./AssetPickerModal";
import { BoundedSliderField } from "./components/BoundedSliderField";
import { NumberField } from "./components/NumberField";
import { adjustColorClipFade, colorClipPreset, duplicateColorClip, moveColorClip, moveColorClipGroups, trimColorClipEnd, trimColorClipStart, type ColorClipPreset } from "./colorLayerModel";
import { characterDirectoryLabel, type CharacterDirectoryInfo, type CharacterDirectoryLabels } from "./characterCatalog";
import { isTextEditingTarget } from "./editorKeyboard";
import type { EditorMcpCommand, EditorMcpPreviewCaptureMode, EditorMcpTimelineBridge, EditorMcpTimelineSnapshot } from "./editorMcp";
import { clampStageScale, panStageView, resetStageView, zoomStageView, type StageView } from "./stageView";
import { SubtitleTextEditor } from "./SubtitleTextEditor";
import { TimelinePanelResizer } from "./TimelinePanelResizer";
import { TimelineSplitHandle } from "./TimelineSplitHandle";
import { DEFAULT_TIMELINE_LAYOUT_PREFERENCES, normalizeTimelineLayoutPreferences, TIMELINE_LAYOUT_PREFERENCES_KEY, type TimelineLayoutPreferences } from "./timelineLayout";
import { zoomTimelineAtCursor } from "./timelineView";
import { audioEnvelopePeaks } from "./audioEnvelope";
import { missingManifestAssetFiles, validateTimeline, type TimelineDiagnostic } from "./timelineDiagnostics";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconEye, IconEyeOff, IconExpand, IconLink, IconLock, IconMinus, IconPause, IconPlay, IconPlus, IconSkipBack, IconSkipForward, IconSound, IconSync, IconUnlock, IconUnlink } from "@ba-spine/app-ui/icons";
import "./timelineSnapFeedback.css";

const TIMELINE_SCALE = 96;
const MIN_TIMELINE_DURATION = 1;
const TRACK_HEADER_WIDTH = 190;

interface ImportedSubtitleEntry {
  start: number;
  end?: number;
  text: Record<TimelineLanguage, string>;
  audio: string[];
}

function AudioWaveform({ url, onDuration }: { url?: string; onDuration?: (duration: number) => void }) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  useEffect(() => {
    if (!url) return;
    let live = true;
    const context = new AudioContext();
    void fetch(url).then((response) => response.arrayBuffer()).then((bytes) => context.decodeAudioData(bytes)).then((buffer) => {
      if (!live) return;
      onDurationRef.current?.(buffer.duration);
      setPeaks(audioEnvelopePeaks(buffer.getChannelData(0)));
    }).catch(() => undefined).finally(() => { void context.close(); });
    return () => { live = false; };
  }, [url]);
  return <svg className="timeline-waveform" viewBox="0 0 160 30" preserveAspectRatio="none" aria-label="Audio waveform">{peaks.map((peak, index) => <line key={index} x1={index} x2={index} y1={15 - peak * 14} y2={15 + peak * 14} stroke="#a6ffdb" strokeWidth="0.7" />)}</svg>;
}

interface TimelineWorkspaceProps {
  source: DesktopAssetSource | null;
  directory: string;
  directories: string[];
  directoryLabels?: CharacterDirectoryLabels;
  directoryInfo?: Readonly<Record<string, CharacterDirectoryInfo>>;
  project: EditorProject | null;
  initialHandoff?: { requestId: string; sequenceId: string; playheadSeconds?: number } | null;
  initialSubtitlePath?: string | null;
  onSubtitleOpened: () => void;
  initialAudioPaths?: string[] | null;
  onAudioOpened: () => void;
  onRecentFile: (item: Omit<RecentFile, "lastOpened"> & { lastOpened?: number }) => void;
  onMutate: (mutator: (current: EditorProject) => EditorProject) => void;
  onLive: (mutator: (current: EditorProject) => EditorProject) => void;
  onBeginEdit: () => void;
  onSave: () => void | Promise<void>;
  onRegisterSave: (callback: ((getProject: () => EditorProject | null) => Promise<EditorSaveFile[]>) | null) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
  onRegisterMcp: (bridge: EditorMcpTimelineBridge | null) => void;
  onMcpSnapshot: (snapshot: EditorMcpTimelineSnapshot | null) => void;
}

function seconds(value: number): string {
  return `${value.toFixed(3)}s`;
}

function snapTime(value: number, snap: number, duration: number): number {
  const next = snap > 0 ? Math.round(value / snap) * snap : value;
  return Math.max(0, Math.min(duration, Number(next.toFixed(3))));
}

function readTimelineLayoutPreferences(): TimelineLayoutPreferences {
  try {
    const stored = localStorage.getItem(TIMELINE_LAYOUT_PREFERENCES_KEY);
    if (!stored) return DEFAULT_TIMELINE_LAYOUT_PREFERENCES;
    return normalizeTimelineLayoutPreferences(JSON.parse(stored) as unknown);
  } catch {
    return DEFAULT_TIMELINE_LAYOUT_PREFERENCES;
  }
}

type TimelineClipKind = "layer" | "color-layer" | "animation" | "color" | "cue" | "audio";
type TimelineSelection = { kind: TimelineClipKind; id: string };
type TimelineDragKind = TimelineClipKind | "layer-start" | "layer-end" | "animation-start" | "animation-end" | "color-start" | "color-end" | "color-fade-in" | "color-fade-out" | "cue-start" | "cue-end" | "audio-start" | "audio-end";
interface TimelineDragItem extends TimelineSelection { start: number; end: number; linked?: boolean; sourceDuration?: number; fadeIn?: number; fadeOut?: number }
interface TimelineDragState {
  kind: TimelineDragKind;
  id: string;
  x: number;
  start: number;
  end: number;
  items: TimelineDragItem[];
}
interface TimelineSnapFeedback { time: number; delta: number; source: "target" | "grid" }
interface TrackLabelResizeState { pointerId: number; x: number; width: number }
interface SelectedClipDetail extends TimelineSelection {
  label: string;
  start: number;
  end: number;
  enabled: boolean;
  removable: boolean;
}

interface AudioUrlRecord {
  path: string;
  source: DesktopAssetSource;
  url: string;
}

type VisualTrack = { kind: "spine"; layer: EditorTimelineLayer } | { kind: "color"; layer: EditorColorLayer };

function visualTrackKey(track: VisualTrack): string {
  return `${track.kind}:${track.layer.id}`;
}

function TimelineColorLayerPreview({ layer, time }: { layer: EditorColorLayer; time: number }) {
  const clip = timelineActiveColorClip(layer, time);
  if (!clip) return null;
  const opacity = timelineColorClipOpacity(layer, clip, time);
  if (opacity <= 0) return null;
  return <div className="timeline-color-layer" data-layer-id={layer.id} aria-hidden="true" style={{ zIndex: layer.order, backgroundColor: clip.color, opacity, mixBlendMode: timelineBlendModeCss(layer.blendMode) }} />;
}

interface PendingAudioLoad {
  path: string;
  source: DesktopAssetSource;
}

function cueText(cue: EditorSubtitleCue, language: TimelineLanguage): string {
  return cue.text[language] || cue.text.en || cue.text.ja || cue.text.ko || "Untitled subtitle";
}

function roleLabel(role: TimelineLayerRole): string {
  return role === "background" ? "BG" : role === "scene" ? "SCENE" : role === "character" ? "CHAR" : "OVERLAY";
}

function importedText(value: unknown): Record<TimelineLanguage, string> {
  if (!value || typeof value !== "object") return { en: "", ja: "", ko: "" };
  const item = value as Record<string, unknown>;
  const read = (...keys: string[]) => keys.map((key) => item[key]).find((candidate): candidate is string => typeof candidate === "string") ?? "";
  return { en: read("en", "EN"), ja: read("ja", "JA", "JR"), ko: read("ko", "KO", "KR") };
}

function subtitleTextKey(text: Record<TimelineLanguage, string>): string {
  return `${text.en}\u0000${text.ja}\u0000${text.ko}`;
}

function collapseDuplicateEntries(entries: ImportedSubtitleEntry[]): ImportedSubtitleEntry[] {
  const result: ImportedSubtitleEntry[] = [];
  for (const entry of entries) {
    const previousIndex = result.findIndex((previous) => Math.abs(previous.start - entry.start) < 0.0001 && subtitleTextKey(previous.text) === subtitleTextKey(entry.text));
    if (previousIndex < 0) result.push(entry);
    else if ((entry.end ?? Number.NEGATIVE_INFINITY) > (result[previousIndex]!.end ?? Number.NEGATIVE_INFINITY)) result[previousIndex] = entry;
  }
  return result;
}

function preferredAudioPath(alternatives: string[]): string[] {
  const global = alternatives.filter((path) => /_GL_/i.test(path));
  const base = alternatives.filter((path) => !/_(GL|JP|KR)_/i.test(path));
  const candidates = global.length ? global : base.length ? base : alternatives.filter((path) => /_JP_/i.test(path));
  return candidates.length ? [candidates[0]!] : alternatives.slice(0, 1);
}

function importedSubtitleCues(value: unknown): { cues: EditorSubtitleCue[]; audio: EditorAudioClip[]; duration: number } {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lines = Array.isArray(source.lines)
    ? source.lines
    : Array.isArray(source.characters)
      ? (source.characters.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).directory === source.directory) as Record<string, unknown> | undefined)?.lines
      : [];
  if (!Array.isArray(lines)) return { cues: [], audio: [], duration: 0 };
  const cues: EditorSubtitleCue[] = [];
  const audio: EditorAudioClip[] = [];
  const audioDirectory = typeof source.audioDirectory === "string" ? source.audioDirectory.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") : "";
  const audioPath = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.toLocaleLowerCase().startsWith("audios/")) return normalized;
    return `audios/voicelines/${audioDirectory && !normalized.includes("/") ? `${audioDirectory}/` : ""}${normalized}`;
  };
  let duration = 0;
  lines.forEach((candidate, lineIndex) => {
    if (!candidate || typeof candidate !== "object") return;
    const line = candidate as Record<string, unknown>;
    const parts = Array.isArray(line.parts) ? line.parts.filter((part) => part && typeof part === "object") as Record<string, unknown>[] : [];
    const markers = Array.isArray(line.markers) ? line.markers.filter((marker): marker is number => typeof marker === "number" && Number.isFinite(marker)) : [];
    const entries = (parts.length > 0
      ? parts.map((part, index) => ({
        start: typeof part.start === "number" && Number.isFinite(part.start) ? part.start : markers[index] ?? lineIndex * 2 + index * 2,
        end: typeof part.end === "number" && Number.isFinite(part.end) ? part.end : undefined,
        text: importedText(part.subtitle ?? part.text ?? line.subtitle ?? line.text),
        audio: Array.isArray(part.audio) ? part.audio.filter((item): item is string => typeof item === "string") : [],
      }))
      : [{ start: markers[0] ?? lineIndex * 2, end: undefined, text: importedText(line.subtitle ?? line.text ?? line), audio: Array.isArray(line.audio) ? line.audio.filter((item): item is string => typeof item === "string") : [] }]) as ImportedSubtitleEntry[];
    const compactEntries = collapseDuplicateEntries(entries);
    compactEntries.forEach((entry, index) => {
      const nextStart = compactEntries[index + 1]?.start;
      const end = Math.max(entry.start + 0.05, entry.end ?? nextStart ?? entry.start + 2);
      const cue: EditorSubtitleCue = {
        id: `subtitle-import-${lineIndex}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        start: Math.max(0, entry.start),
        end,
        enabled: true,
        text: entry.text,
      };
      cues.push(cue);
      duration = Math.max(duration, end);
      preferredAudioPath(entry.audio).forEach((path, audioIndex) => {
        const start = entry.start + audioIndex * 0.01;
        audio.push({
          id: `audio-import-${lineIndex}-${index}-${audioIndex}-${Math.random().toString(36).slice(2, 8)}`,
          name: path.split(/[\\/]/).pop() ?? path,
          path: audioPath(path),
          autoEnd: true,
          start,
          end,
          enabled: true,
          volume: 1,
        });
      });
    });
  });
  return { cues, audio, duration };
}

async function findAudioFile(source: DesktopAssetSource, path: string): Promise<File | null> {
  for (const candidate of spineAudioPathCandidates(path)) {
    const file = await source.getFile(candidate);
    if (file) return file;
  }
  return null;
}

function canvasHasVisiblePixels(source: HTMLCanvasElement): boolean {
  if (source.width <= 0 || source.height <= 0) return false;
  const probe = document.createElement("canvas");
  probe.width = 128;
  probe.height = Math.max(1, Math.round(128 * source.height / source.width));
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not inspect the rendered Spine canvas.");
  context.drawImage(source, 0, 0, probe.width, probe.height);
  const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
  for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha]! > 0) return true;
  return false;
}

export function TimelineWorkspace({ source, directory, directories, directoryLabels = {}, directoryInfo = {}, project, initialHandoff, initialSubtitlePath, onSubtitleOpened, initialAudioPaths, onAudioOpened, onRecentFile, onMutate, onLive, onBeginEdit, onSave, onRegisterSave, onStatus, onError, onRegisterMcp, onMcpSnapshot }: TimelineWorkspaceProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [previewUntil, setPreviewUntil] = useState<number | null>(null);
  const [talkAutoplayActive, setTalkAutoplayActive] = useState(false);
  const [loopTalkList, setLoopTalkList] = useState(false);
  const [pauseBetweenTalks, setPauseBetweenTalks] = useState(0.35);
  const [pendingTalkSequence, setPendingTalkSequence] = useState<string | null>(null);
  const [metas, setMetas] = useState<Record<string, SpineMeta | null>>({});
  const [sharedCameraPose, setSharedCameraPose] = useState<SpineCameraPose | null>(null);
  const [files, setFiles] = useState<Record<string, SpineFiles | null>>({});
  const [layerLoadErrors, setLayerLoadErrors] = useState<Record<string, string>>({});
  const [layerManifestVersions, setLayerManifestVersions] = useState<Record<string, number>>({});
  const [animationDurations, setAnimationDurations] = useState<Record<string, number>>({});
  const [zoom, setZoom] = useState(1);
  const [timelineLayout, setTimelineLayout] = useState(readTimelineLayoutPreferences);
  const { previewShare, sequencePanelWidth, inspectorPanelWidth, sequencePanelCollapsed, inspectorPanelCollapsed } = timelineLayout;
  const [trackLabelWidth, setTrackLabelWidth] = useState(TRACK_HEADER_WIDTH);
  const [colorHexDraft, setColorHexDraft] = useState<string | null>(null);
  const [stageView, setStageView] = useState<StageView>(() => resetStageView());
  const [stagePanning, setStagePanning] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [inspector, setInspector] = useState<"sequence" | "layer" | "color-layer" | "animation" | "color-clip" | "cue" | "audio" | "multi">("sequence");
  const appliedHandoffIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const spineRenderersRef = useRef(new Map<string, SpineRenderer>());
  const stagePanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  const scrubRef = useRef<number | null>(null);
  const [selectedClips, setSelectedClips] = useState<TimelineSelection[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [dragSnapFeedback, setDragSnapFeedback] = useState<TimelineSnapFeedback | null>(null);
  const [layerPickerOpen, setLayerPickerOpen] = useState(false);
  const audioElementsRef = useRef<Record<string, HTMLAudioElement | null>>({});
  const audioUrlsRef = useRef<Record<string, string>>({});
  const audioUrlRecordsRef = useRef<Record<string, AudioUrlRecord>>({});
  const pendingAudioLoadsRef = useRef<Record<string, PendingAudioLoad>>({});
  const audioStartedRef = useRef<Record<string, boolean>>({});
  const audioPreviousTimeRef = useRef<Record<string, number | undefined>>({});
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({});
  const [audioPreloadStates, setAudioPreloadStates] = useState<Record<string, SpineTimelineAudioPreloadState>>({});
  const [missingAudio, setMissingAudio] = useState<string[]>([]);
  const dragRef = useRef<TimelineDragState | null>(null);
  const trackLabelResizeRef = useRef<TrackLabelResizeState | null>(null);
  const trackDragRef = useRef<string | null>(null);
  const subtitleDocumentsRef = useRef<Record<string, Record<string, unknown>>>({});
  const subtitleOriginalsRef = useRef<Record<string, string | null>>({});
  const projectRef = useRef<EditorProject | null>(project);
  const sourceRef = useRef<DesktopAssetSource | null>(source);
  const directoryRef = useRef(directory);
  const currentTimeRef = useRef(currentTime);
  const talkAutoplayTimerRef = useRef<number | null>(null);
  const onMutateRef = useRef(onMutate);
  const sequenceContextRef = useRef({ animations: [] as string[], directories: [] as string[] });
  const saveSubtitleDocumentsRef = useRef<(getProject: () => EditorProject | null) => Promise<EditorSaveFile[]>>(async () => []);
  const onRegisterSaveRef = useRef(onRegisterSave);
  const timelineKeydownRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const openedSubtitleRef = useRef("");
  const openedAudioRef = useRef("");
  const restoredColorSelectionRef = useRef("");
  const mcpCommandLatestRef = useRef<(command: EditorMcpCommand) => Promise<unknown> | unknown>(() => { throw new Error("The timeline MCP bridge is not ready."); });
  const mcpSnapshotLatestRef = useRef<() => EditorMcpTimelineSnapshot | null>(() => null);
  const mcpRegisterLatestRef = useRef(onRegisterMcp);
  const mcpSnapshotCallbackLatestRef = useRef(onMcpSnapshot);
  const createMcpSnapshotLatestRef = useRef<() => EditorMcpTimelineSnapshot | null>(() => null);
  const mcpBridgeRef = useRef<EditorMcpTimelineBridge | null>(null);
  projectRef.current = project;
  currentTimeRef.current = currentTime;
  sourceRef.current = source;
  directoryRef.current = directory;
  onMutateRef.current = onMutate;
  onRegisterSaveRef.current = onRegisterSave;
  mcpRegisterLatestRef.current = onRegisterMcp;
  mcpSnapshotCallbackLatestRef.current = onMcpSnapshot;
  if (!mcpBridgeRef.current) {
    mcpBridgeRef.current = {
      snapshot: () => mcpSnapshotLatestRef.current(),
      execute: (command) => mcpCommandLatestRef.current(command),
    };
  }

  useEffect(() => {
    try {
      localStorage.setItem(TIMELINE_LAYOUT_PREFERENCES_KEY, JSON.stringify(timelineLayout));
    } catch { /* The split remains adjustable for this session. */ }
  }, [timelineLayout]);

  function updateTimelineLayout(patch: Partial<TimelineLayoutPreferences>) {
    setTimelineLayout((current) => normalizeTimelineLayoutPreferences({ ...current, ...patch }));
  }

  function pauseAudioElement(id: string) {
    const audio = audioElementsRef.current[id];
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  }

  function setAudioPreloadState(id: string, state: SpineTimelineAudioPreloadState) {
    setAudioPreloadStates((value) => value[id] === state ? value : { ...value, [id]: state });
  }

  function clearAudioUrl(id: string) {
    const record = audioUrlRecordsRef.current[id];
    if (record) {
      URL.revokeObjectURL(record.url);
      delete audioUrlRecordsRef.current[id];
    } else {
      const url = audioUrlsRef.current[id];
      if (url) URL.revokeObjectURL(url);
    }
    delete audioUrlsRef.current[id];
    delete audioStartedRef.current[id];
    delete audioPreviousTimeRef.current[id];
    delete pendingAudioLoadsRef.current[id];
    setAudioPreloadState(id, "loading");
    pauseAudioElement(id);
    setAudioUrls((value) => {
      if (!(id in value)) return value;
      const next = { ...value };
      delete next[id];
      return next;
    });
  }

  function storeAudioUrl(id: string, path: string, url: string, nextSource: DesktopAssetSource) {
    const previous = audioUrlRecordsRef.current[id];
    if (previous && previous.url !== url) {
      URL.revokeObjectURL(previous.url);
      pauseAudioElement(id);
    }
    audioUrlRecordsRef.current[id] = { path, source: nextSource, url };
    audioUrlsRef.current[id] = url;
    audioStartedRef.current[id] = false;
    audioPreviousTimeRef.current[id] = undefined;
    setAudioPreloadState(id, "loading");
    setAudioUrls((value) => value[id] === url ? value : { ...value, [id]: url });
  }

  const timeline = project?.timeline ?? null;
  const audioLoadKey = (timeline?.audio ?? []).map((clip) => `${clip.id}:${clip.path}`).join("|");
  const audioPreloadIdentityRef = useRef({ source, key: audioLoadKey });
  const audioPreloadsReady = audioPreloadIdentityRef.current.source === source
    && audioPreloadIdentityRef.current.key === audioLoadKey
    && timelineAudioPreloadsReady(timeline?.audio ?? [], audioPreloadStates);
  const discovered = useMemo(() => directory ? compositionDirectories(directory, directories) : [], [directory, directories]);
  const displayLayers = useMemo(() => [...(timeline?.layers ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)), [timeline?.layers]);
  const displayColorLayers = useMemo(() => [...(timeline?.colorLayers ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)), [timeline?.colorLayers]);
  const displayVisualTracks = useMemo<VisualTrack[]>(() => timeline ? timelineVisualLayers(timeline) : [], [timeline?.layers, timeline?.colorLayers]);
  const selectedLayer = timeline?.layers.find((layer) => layer.id === timeline.selectedLayerId) ?? null;
  const selectedCue = timeline?.subtitles.find((cue) => cue.id === timeline.selectedCueId) ?? null;
  const selectedCueIndex = selectedCue && timeline ? timeline.subtitles.findIndex((cue) => cue.id === selectedCue.id) : -1;
  const selectedAudio = timeline?.audio.find((clip) => clip.id === selectedAudioId) ?? null;
  function layerAnimationClips(layer: EditorTimelineLayer, value = timeline): EditorAnimationClip[] {
    if (!value) return [];
    const meta = metas[layer.id] ?? null;
    const intro = meta?.introAnimation ? animationDurations[`${layer.id}:${meta.introAnimation}`] ?? 0 : 0;
    return effectiveAnimationClips(layer, value, meta, intro);
  }
  function findAnimationClip(clipId: string, value = timeline): { layer: EditorTimelineLayer; clip: EditorAnimationClip } | null {
    for (const layer of value?.layers ?? []) {
      const clip = layerAnimationClips(layer, value).find((item) => item.id === clipId);
      if (clip) return { layer, clip };
    }
    return null;
  }
  function findColorClip(clipId: string, value = timeline): { layer: EditorColorLayer; clip: EditorColorLayer["clips"][number] } | null {
    for (const layer of value?.colorLayers ?? []) {
      const clip = layer.clips.find((item) => item.id === clipId);
      if (clip) return { layer, clip };
    }
    return null;
  }
  useEffect(() => {
    if (!timeline) return;
    const identity = `${directory}:${timeline.sequenceId ?? "legacy"}`;
    if (restoredColorSelectionRef.current === identity) return;
    restoredColorSelectionRef.current = identity;
    const clipId = timeline.selectedColorClipId;
    if (clipId && findColorClip(clipId)) {
      setSelectedClips([{ kind: "color", id: clipId }]);
      setInspector("color-clip");
      return;
    }
    const layerId = timeline.selectedColorLayerId;
    if (layerId && timeline.colorLayers.some((layer) => layer.id === layerId)) {
      setSelectedClips([{ kind: "color-layer", id: layerId }]);
      setInspector("color-layer");
    }
  }, [directory, timeline?.sequenceId]);
  const selectedColorClipSelection = selectedClips.find((item) => item.kind === "color");
  const selectedColorClipFound = selectedColorClipSelection ? findColorClip(selectedColorClipSelection.id) : null;
  const selectedColorLayer = selectedColorClipFound?.layer
    ?? timeline?.colorLayers.find((layer) => layer.id === selectedClips.find((item) => item.kind === "color-layer")?.id)
    ?? null;
  const selectedColorClip = selectedColorClipFound?.clip ?? null;
  useEffect(() => { setColorHexDraft(null); }, [selectedColorClip?.id, selectedColorClip?.color]);
  const selectedAnimation = selectedClips.find((item) => item.kind === "animation");
  const selectedAnimationClip = selectedAnimation ? findAnimationClip(selectedAnimation.id) : null;
  const layerDirectoriesKey = displayLayers.map((layer) => layer.directory).join("|");
  const layerAssetPathsKey = JSON.stringify(displayLayers.map((layer) => [layer.directory, project?.timeline.assetPaths?.[layer.directory] ?? null]));
  const characterLayer = timeline?.layers.find((layer) => layer.role === "character") ?? null;
  const characterMeta = characterLayer ? metas[characterLayer.id] ?? null : null;
  const referenceLayerId = timeline ? timelineReferenceLayerId(timeline) : "";
  const animations = characterMeta?.animations ?? [];
  const sequenceIds = useMemo(() => [...new Set(["opening", ...animations.filter((name) => /talk[_ -]?\d+/i.test(name)).map(talkSequenceId), ...Object.keys(project?.sequences ?? {}).filter((id) => id !== "legacy")])], [animations, project?.sequences]);
  useEffect(() => {
    if (!initialHandoff || appliedHandoffIdRef.current === initialHandoff.requestId || !timeline) return;
    if (!sequenceIds.includes(initialHandoff.sequenceId)) {
      if (characterLayer && !metas[characterLayer.id]) return;
      appliedHandoffIdRef.current = initialHandoff.requestId;
      onError(`The received sequence “${initialHandoff.sequenceId}” is not present in this project.`);
      return;
    }
    if (timeline.sequenceId !== initialHandoff.sequenceId) {
      chooseSequence(initialHandoff.sequenceId);
      return;
    }
    if (initialHandoff.playheadSeconds !== undefined) {
      setCurrentTime(Math.max(0, Math.min(initialHandoff.playheadSeconds, timeline.duration)));
    }
    appliedHandoffIdRef.current = initialHandoff.requestId;
  }, [initialHandoff, sequenceIds, timeline?.sequenceId, timeline?.duration, characterLayer?.id, metas, onError]);
  const talkSequenceIds = useMemo(() => sequenceIds.filter((id) => /^talk-\d+$/i.test(id))
    .sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0)), [sequenceIds]);
  sequenceContextRef.current = { animations, directories };
  const isTalkSequence = /^talk-\d+$/i.test(timeline?.sequenceId ?? "");

  function layerAnimation(layer: EditorTimelineLayer): string {
    const meta = metas[layer.id];
    if (!meta || !timeline) return layer.animation || meta?.idleAnimation || meta?.animations[0] || "";
    const intro = meta.introAnimation ? animationDurations[`${layer.id}:${meta.introAnimation}`] ?? 0 : 0;
    return timelineLayerAnimation(layer, meta, undefined, currentTime, timeline.sequenceId ?? "legacy", timeline.openingMode ?? "direct", intro);
  }

  function reorderVisualTrack(sourceKey: string, targetKey: string) {
    if (!timeline || sourceKey === targetKey) return;
    const tracks = [...displayVisualTracks];
    const sourceIndex = tracks.findIndex((track) => visualTrackKey(track) === sourceKey);
    const targetIndex = tracks.findIndex((track) => visualTrackKey(track) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    if (tracks[sourceIndex]!.layer.locked) return;
    const [rangeStart, rangeEnd] = [Math.min(sourceIndex, targetIndex), Math.max(sourceIndex, targetIndex)];
    if (tracks.slice(rangeStart, rangeEnd + 1).some((track) => track.layer.locked)) return;
    const [moved] = tracks.splice(sourceIndex, 1);
    tracks.splice(targetIndex, 0, moved!);
    const orders = new Map(tracks.map((track, index) => [visualTrackKey(track), index]));
    updateTimeline((value) => ({
      ...value,
      layers: value.layers.map((layer) => ({ ...layer, order: orders.get(`spine:${layer.id}`) ?? layer.order })),
      colorLayers: value.colorLayers.map((layer) => ({ ...layer, order: orders.get(`color:${layer.id}`) ?? layer.order })),
    }));
  }

  function updateColorLayer(id: string, patch: Partial<EditorColorLayer>, history = true) {
    updateTimeline((value) => ({
      ...value,
      colorLayers: value.colorLayers.map((layer) => layer.id === id && (!layer.locked || patch.locked !== undefined || Object.keys(patch).every((key) => key === "enabled")) ? { ...layer, ...patch } : layer),
    }), history);
  }

  function updateColorClip(id: string, patch: Partial<EditorColorLayer["clips"][number]>) {
    const { start: requestedStart, end: requestedEnd, ...fields } = patch;
    updateTimeline((value) => extendTimelineDuration({
      ...value,
      colorLayers: value.colorLayers.map((layer) => {
        if (layer.locked || !layer.clips.some((clip) => clip.id === id)) return layer;
        let clips = layer.clips;
        if (requestedStart !== undefined) clips = trimColorClipStart(clips, id, requestedStart);
        if (requestedEnd !== undefined) clips = trimColorClipEnd(clips, id, requestedEnd);
        clips = clips.map((clip) => clip.id === id ? normalizeColorClipFades({ ...clip, ...fields }) : clip);
        return { ...layer, clips };
      }),
    }));
  }

  function layerEnd(layer: EditorTimelineLayer): number {
    if (!layer.enabled) return 0;
    const talkCharacter = timeline?.sequenceId?.startsWith("talk-") && layer.role === "character" && layer.endMode !== "manual";
    const playbackLayer = talkCharacter ? { ...layer, loop: false } : layer;
    const clips = layerAnimationClips(playbackLayer);
    const enabledClips = clips.filter((clip) => clip.enabled !== false);
    if (enabledClips.length > 0) return Math.max(0, ...enabledClips.map((clip) => animationClipEnd(clip, animationDurations[`${layer.id}:${clip.animation}`] ?? 0)));
    if (Array.isArray(layer.animationClips)) return 0;
    const animationDuration = animationDurations[`${layer.id}:${layerAnimation(layer)}`] ?? 0;
    return animationEndForLayer(talkCharacter ? { ...layer, loop: false } : layer, animationDuration);
  }

  const openingMode = timeline?.openingMode ?? "direct";
  const introAnimation = characterMeta?.introAnimation ?? "";
  const introDuration = characterLayer && introAnimation ? animationDurations[`${characterLayer.id}:${introAnimation}`] ?? 0 : 0;
  const openingIntroStart = timeline?.sequenceId === "opening"
    ? Math.max(0, characterLayer?.start ?? timeline?.sceneDuration ?? 0)
    : 0;
  const explicitAnimationClips = displayLayers.some((layer) => Array.isArray(layer.animationClips));
  const openingIdleDuration = Math.max(0, timeline?.openingIdleDuration ?? 3);
  const mainCharacterAnimation = characterLayer ? layerAnimation(characterLayer) : "";
  const mainCharacterDuration = characterLayer && mainCharacterAnimation ? animationDurations[`${characterLayer.id}:${mainCharacterAnimation}`] ?? 0 : 0;
  const mainAnimationState = characterLayer && characterMeta && timeline
    ? timelineMainAnimation(characterLayer, characterMeta, currentTime, timeline.sequenceId ?? "legacy", openingMode, introDuration, mainCharacterDuration)
    : null;
  const mainAnimation = mainAnimationState?.animation ?? "";
  const mainAnimationTime = mainAnimationState?.time;
  const mainAnimationLoop = mainAnimationState?.loop;
  const talkMixDuration = normalizeAnimationMixDuration(project?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
  const openingAutoDuration = timeline?.sequenceId === "opening"
    ? openingTimelineDuration(timeline, introDuration, layerEnd)
    : 0;
  const duration = timeline
    ? timelinePlaybackDuration(timeline, timeline.sequenceId === "opening" && !explicitAnimationClips ? openingIntroStart + (openingMode === "skip" ? 0 : introDuration) : 0, layerEnd, talkMixDuration)
    : MIN_TIMELINE_DURATION;
  const animationsByLayer = useMemo(() => Object.fromEntries(Object.entries(metas)
    .flatMap(([id, meta]) => meta ? [[id, meta.animations] as const] : [])), [metas]);
  const timelineDiagnostics = useMemo(() => timeline ? validateTimeline(timeline, {
    availableDirectories: directories,
    animationsByLayer,
    duration,
    layerLoadErrors,
    manifestSchemaVersionsByLayer: layerManifestVersions,
    missingAudioPaths: missingAudio,
  }) : [], [animationsByLayer, directories, duration, layerLoadErrors, layerManifestVersions, missingAudio, timeline]);
  const timelineChecksPending = Boolean(source && (
    displayLayers.some((layer) => !Object.prototype.hasOwnProperty.call(files, layer.directory))
    || (timeline?.audio ?? []).some((clip) => audioPreloadStates[clip.id] !== "ready" && audioPreloadStates[clip.id] !== "missing")
  ));
  const autoTalkDuration = timeline && isTalkSequence
    ? timelinePlaybackDuration({ ...timeline, durationMode: "auto" }, 0, layerEnd, talkMixDuration)
    : 0;
  const talkBlendOutStart = isTalkSequence ? duration - talkMixDuration : undefined;
  const trackWidth = Math.max(640, duration * TIMELINE_SCALE * zoom + 48);
  const characterHidden = timeline ? timelineSceneHidesCharacter(timeline, currentTime) : false;

  function createMcpSnapshot(): EditorMcpTimelineSnapshot | null {
    if (!timeline) return null;
    const composition = stageRef.current?.querySelector<HTMLElement>(".timeline-visual-composition");
    const stage = stageRef.current;
    const stageBounds = stage?.getBoundingClientRect() ?? null;
    const compositionBounds = composition?.getBoundingClientRect() ?? null;
    const relativeRect = (bounds: DOMRect | null) => bounds && stageBounds
      ? { x: bounds.left - stageBounds.left, y: bounds.top - stageBounds.top, width: bounds.width, height: bounds.height }
      : null;
    const renderedLayers = composition ? Array.from(composition.children).flatMap((element) => {
      if (!(element instanceof HTMLElement)) return [];
      const style = window.getComputedStyle(element);
      const canvas = element instanceof HTMLCanvasElement ? element : null;
      const opacity = Number.parseFloat(style.opacity) || 0;
      return [{
        id: element.dataset.layerId ?? "unknown",
        kind: element.classList.contains("timeline-color-layer") ? "color" as const : "spine" as const,
        visible: style.visibility !== "hidden" && opacity > 0,
        opacity,
        blendMode: style.mixBlendMode,
        ...(canvas?.dataset.animation ? { animation: canvas.dataset.animation } : {}),
        ...(canvas?.dataset.sampleTime ? { sampleTime: Number(canvas.dataset.sampleTime) } : {}),
      }];
    }) : [];
    return {
      sequenceId: timeline.sequenceId ?? "legacy",
      currentTime: Number(currentTime.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      availableSequences: sequenceIds.map((id) => ({
        id,
        name: id === "opening" ? "Opening" : id.startsWith("talk-") ? `Talk ${id.slice(5).padStart(2, "0")}` : id,
      })),
      playing,
      speed,
      loop: timeline.loop,
      selected: selectedClips.map(({ kind, id }) => ({ kind, id })),
      visualLayers: displayVisualTracks.map((track) => track.kind === "spine"
        ? {
          kind: "spine" as const,
          id: track.layer.id,
          name: track.layer.name,
          directory: track.layer.directory,
          order: track.layer.order,
          enabled: track.layer.enabled,
          locked: Boolean(track.layer.locked),
          opacity: track.layer.opacity,
          blendMode: track.layer.blendMode ?? "normal",
        }
        : {
          kind: "color" as const,
          id: track.layer.id,
          name: track.layer.name,
          order: track.layer.order,
          enabled: track.layer.enabled,
          locked: track.layer.locked,
          opacity: track.layer.opacity,
          blendMode: track.layer.blendMode,
          clips: track.layer.clips.map((clip) => ({
            id: clip.id,
            name: clip.name,
            color: clip.color,
            start: clip.start,
            end: clip.end,
            opacity: clip.opacity,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            enabled: clip.enabled,
            active: clip.enabled && currentTime >= clip.start && currentTime <= clip.end,
            effectiveOpacity: timelineColorClipOpacity(track.layer, clip, currentTime),
          })),
        }),
      subtitles: timeline.subtitles.map((cue) => ({ id: cue.id, start: cue.start, end: cue.end, enabled: cue.enabled, text: cueText(cue, timeline.language) })),
      audio: timeline.audio.map((clip) => ({ id: clip.id, path: clip.path, start: clip.start, end: clip.end, enabled: clip.enabled })),
      renderedLayers,
      preview: {
        view: { ...stageView },
        stage: stageBounds ? { x: 0, y: 0, width: stageBounds.width, height: stageBounds.height } : null,
        composition: relativeRect(compositionBounds),
        renderers: composition ? Array.from(composition.querySelectorAll<HTMLCanvasElement>("canvas.spine-timeline-layer-canvas")).map((canvas) => {
          const style = window.getComputedStyle(canvas);
          const visible = style.visibility !== "hidden" && (Number.parseFloat(style.opacity) || 0) > 0;
          const diagnostics = spineRenderersRef.current.get(canvas.dataset.layerId ?? "")?.getPreviewDiagnostics();
          const sampleTime = Number(canvas.dataset.sampleTime);
          return {
            id: canvas.dataset.layerId ?? "unknown",
            visible,
            ready: diagnostics?.ready ?? false,
            contextLost: diagnostics?.contextLost ?? false,
            renderEnabled: diagnostics?.renderEnabled ?? false,
            canvasWidth: diagnostics?.canvasWidth ?? canvas.width,
            canvasHeight: diagnostics?.canvasHeight ?? canvas.height,
            animation: diagnostics?.animation ?? canvas.dataset.animation ?? "",
            sampleTime: Number.isFinite(sampleTime) ? sampleTime : null,
          };
        }) : [],
      },
    };
  }

  createMcpSnapshotLatestRef.current = createMcpSnapshot;

  async function captureMcpPreview(mode: EditorMcpPreviewCaptureMode = "composition") {
    const stage = stageRef.current;
    const composition = stage?.querySelector<HTMLElement>(".timeline-visual-composition");
    if (!stage || !composition) throw new Error("The timeline preview composition is not mounted.");

    const deadline = Date.now() + 5000;
    while (true) {
      const pending: string[] = [];
      for (const element of Array.from(composition.querySelectorAll<HTMLCanvasElement>("canvas.spine-timeline-layer-canvas"))) {
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || (Number.parseFloat(style.opacity) || 0) <= 0) continue;
        const id = element.dataset.layerId ?? "unknown";
        const renderer = spineRenderersRef.current.get(id);
        const diagnostics = renderer?.getPreviewDiagnostics();
        if (diagnostics?.contextLost) throw new Error(`Visible Spine layer ${id} has a lost WebGL context; reload the asset set before capturing.`);
        if (!renderer || !diagnostics?.ready || !diagnostics.renderEnabled || diagnostics.canvasWidth <= 0 || diagnostics.canvasHeight <= 0) pending.push(id);
      }
      if (pending.length === 0) break;
      if (Date.now() >= deadline) throw new Error(`Preview capture timed out waiting for visible Spine layer${pending.length === 1 ? "" : "s"}: ${pending.join(", ")}. Check asset loading and renderer diagnostics in editor_state.`);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const stageBounds = stage.getBoundingClientRect();
    const compositionBounds = composition.getBoundingClientRect();
    const bounds = mode === "viewport" ? stageBounds : compositionBounds;
    if (!bounds.width || !bounds.height) throw new Error(`The ${mode} preview has no visible size.`);
    const width = 960;
    const height = Math.max(1, Math.round(width * bounds.height / bounds.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the preview capture canvas.");
    context.fillStyle = mode === "viewport" ? window.getComputedStyle(stage).backgroundColor : "#08121b";
    context.fillRect(0, 0, width, height);
    const scaleX = width / bounds.width;
    const scaleY = height / bounds.height;
    let renderedVisualCount = 0;
    for (const element of Array.from(composition.children)) {
      if (!(element instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity) || 0;
      if (style.visibility === "hidden" || opacity <= 0) continue;
      const rect = element.getBoundingClientRect();
      const x = (rect.left - bounds.left) * scaleX;
      const y = (rect.top - bounds.top) * scaleY;
      const drawWidth = rect.width * scaleX;
      const drawHeight = rect.height * scaleY;
      context.globalAlpha = opacity;
      context.globalCompositeOperation = style.mixBlendMode === "multiply"
        ? "multiply"
        : style.mixBlendMode === "screen"
          ? "screen"
          : style.mixBlendMode === "plus-lighter"
            ? "lighter"
            : "source-over";
      if (element instanceof HTMLCanvasElement) {
        const id = element.dataset.layerId ?? "unknown";
        const renderer = spineRenderersRef.current.get(id);
        const diagnostics = renderer?.getPreviewDiagnostics();
        if (diagnostics?.contextLost) throw new Error(`Visible Spine layer ${id} lost its WebGL context during capture.`);
        if (!renderer?.renderFrameForCapture()) throw new Error(`Visible Spine layer ${id} was not ready to render a preview frame.`);
        if (!canvasHasVisiblePixels(element)) throw new Error(`Visible Spine layer ${id} rendered an empty frame at ${element.dataset.sampleTime ?? "the current time"}s; the preview capture was rejected.`);
        context.drawImage(element, x, y, drawWidth, drawHeight);
        renderedVisualCount += 1;
      } else if (element.classList.contains("timeline-color-layer")) {
        context.fillStyle = style.backgroundColor;
        context.fillRect(x, y, drawWidth, drawHeight);
        renderedVisualCount += 1;
      }
    }
    if (mode === "viewport") {
      const subtitle = stage.querySelector<HTMLElement>(".timeline-subtitle-preview");
      if (subtitle) {
        const style = window.getComputedStyle(subtitle);
        const rect = subtitle.getBoundingClientRect();
        const x = (rect.left - bounds.left) * scaleX;
        const y = (rect.top - bounds.top) * scaleY;
        const drawWidth = rect.width * scaleX;
        const drawHeight = rect.height * scaleY;
        const cornerRadius = Number.parseFloat(style.borderRadius) * scaleX || 0;
        const borderWidth = Number.parseFloat(style.borderTopWidth) * scaleX || 0;
        const fontSize = Number.parseFloat(style.fontSize) * scaleX;
        const paddingX = Number.parseFloat(style.paddingLeft) * scaleX;
        const paddingY = Number.parseFloat(style.paddingTop) * scaleY;
        const rawLineHeight = Number.parseFloat(style.lineHeight);
        const lineHeight = (Number.isFinite(rawLineHeight) ? rawLineHeight : Number.parseFloat(style.fontSize) * 1.45) * scaleY;
        context.save();
        context.globalAlpha = Number.parseFloat(style.opacity) || 1;
        context.fillStyle = style.backgroundColor;
        context.beginPath();
        context.roundRect(x, y, drawWidth, drawHeight, cornerRadius);
        context.fill();
        if (borderWidth > 0) {
          context.lineWidth = borderWidth;
          context.strokeStyle = style.borderTopColor;
          context.stroke();
        }
        context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
        context.fillStyle = style.color;
        context.textAlign = style.textAlign === "left" ? "left" : style.textAlign === "right" ? "right" : "center";
        context.textBaseline = "top";
        const textX = context.textAlign === "left" ? x + paddingX : context.textAlign === "right" ? x + drawWidth - paddingX : x + drawWidth / 2;
        Array.from(subtitle.children).forEach((child, index) => context.fillText(child.textContent ?? "", textX, y + paddingY + index * lineHeight, Math.max(1, drawWidth - paddingX * 2)));
        context.restore();
        renderedVisualCount += 1;
      }
    }
    if (renderedVisualCount === 0) throw new Error("The preview has no visible Spine, color, or subtitle content to capture.");
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    const preview = createMcpSnapshot()?.preview ?? null;
    return {
      imageDataUrl: canvas.toDataURL("image/png"),
      sequenceId: timeline?.sequenceId ?? "legacy",
      currentTime: Number(currentTime.toFixed(3)),
      mode,
      width,
      height,
      preview,
    };
  }

  function executeMcpCommand(command: EditorMcpCommand): unknown {
    if (!timeline) throw new Error("The timeline is not ready.");
    switch (command.name) {
      case "select_sequence":
        if (!sequenceIds.includes(command.sequenceId)) throw new Error(`Sequence not found: ${command.sequenceId}`);
        chooseSequence(command.sequenceId);
        return { sequenceId: command.sequenceId };
      case "seek": {
        if (!Number.isFinite(command.seconds) || command.seconds < 0) throw new Error("Seek time must be a non-negative number.");
        const next = Math.max(0, Math.min(duration, command.seconds));
        currentTimeRef.current = next;
        setPreviewUntil(null);
        setCurrentTime(next);
        setPlaying(false);
        return { currentTime: next, duration };
      }
      case "set_playback":
        setPreviewUntil(null);
        setPlaying(command.playing);
        return { playing: command.playing };
      case "set_preview_view": {
        const next = {
          scale: command.patch.scale === undefined ? stageView.scale : clampStageScale(command.patch.scale),
          x: command.patch.x ?? stageView.x,
          y: command.patch.y ?? stageView.y,
        };
        setStageView(next);
        return { view: next };
      }
      case "zoom_preview": {
        const stage = stageRef.current;
        if (!stage) throw new Error("The timeline preview stage is not mounted.");
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error("The timeline preview stage has no visible size.");
        const cursor = command.cursor ?? { x: rect.width / 2, y: rect.height / 2 };
        const next = zoomStageView(stageView, stageView.scale * command.factor, cursor, { width: rect.width, height: rect.height });
        setStageView(next);
        return { view: next, cursor };
      }
      case "pan_preview": {
        const next = panStageView(stageView, command.deltaX, command.deltaY);
        setStageView(next);
        return { view: next };
      }
      case "reset_preview": {
        const next = command.mode === "pan" ? { ...stageView, x: 0, y: 0 } : resetStageView();
        setStageView(next);
        return { view: next };
      }
      case "select_visual": {
        if (command.kind === "spine-layer") {
          if (!timeline.layers.some((layer) => layer.id === command.id)) throw new Error(`Spine layer not found: ${command.id}`);
          updateTimeline((value) => ({ ...value, selectedLayerId: command.id, selectedColorLayerId: null, selectedColorClipId: null, selectedCueId: null }));
          setSelectedClips([{ kind: "layer", id: command.id }]);
          setInspector("layer");
        } else if (command.kind === "color-layer") {
          if (!timeline.colorLayers.some((layer) => layer.id === command.id)) throw new Error(`Color layer not found: ${command.id}`);
          updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedColorLayerId: command.id, selectedColorClipId: null, selectedCueId: null }));
          setSelectedClips([{ kind: "color-layer", id: command.id }]);
          setInspector("color-layer");
        } else {
          const found = findColorClip(command.id);
          if (!found) throw new Error(`Color clip not found: ${command.id}`);
          updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: command.id, selectedCueId: null }));
          setSelectedClips([{ kind: "color", id: command.id }]);
          setInspector("color-clip");
        }
        return { kind: command.kind, id: command.id };
      }
      case "update_spine_layer": {
        const layer = timeline.layers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Spine layer not found: ${command.layerId}`);
        if (layer.locked && Object.keys(command.patch).some((key) => key !== "locked" && key !== "enabled")) throw new Error("The Spine layer is locked.");
        const nextStart = command.patch.start ?? layer.start;
        const nextEnd = command.patch.end ?? layer.end;
        if ((command.patch.start !== undefined || command.patch.end !== undefined) && nextEnd < nextStart + 0.01) throw new Error("Spine layer end must be at least 0.01 seconds after its start.");
        const patch = {
          ...command.patch,
          ...(command.patch.end !== undefined && command.patch.endMode === undefined ? { endMode: "manual" as const } : {}),
        };
        updateLayer(command.layerId, patch);
        return { layerId: command.layerId, updated: Object.keys(patch) };
      }
      case "reorder_visual_layer": {
        const sourceTrack = displayVisualTracks.find((track) => track.layer.id === command.layerId);
        const targetTrack = displayVisualTracks.find((track) => track.layer.id === command.targetLayerId);
        if (!sourceTrack || !targetTrack) throw new Error("Both visual layer ids must exist in the active sequence.");
        if (sourceTrack.layer.locked) throw new Error("The source visual layer is locked.");
        reorderVisualTrack(visualTrackKey(sourceTrack), visualTrackKey(targetTrack));
        return { moved: command.layerId, target: command.targetLayerId };
      }
      case "add_color_layer": {
        if (timeline.sequenceId !== "opening") throw new Error("Color layers can only be added to the opening sequence.");
        const id = addColorLayer(command.nameHint);
        if (!id) throw new Error("The color layer could not be added.");
        return { layerId: id };
      }
      case "add_color_clip": {
        const id = addColorClip(command.preset ?? "solid", command.layerId);
        if (!id) throw new Error("The color clip could not be added.");
        return { clipId: id };
      }
      case "update_color_layer": {
        const layer = timeline.colorLayers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Color layer not found: ${command.layerId}`);
        if (layer.locked && Object.keys(command.patch).some((key) => key !== "locked" && key !== "enabled")) throw new Error("The color layer is locked.");
        updateColorLayer(command.layerId, command.patch);
        return { layerId: command.layerId, updated: Object.keys(command.patch) };
      }
      case "update_color_clip": {
        const found = findColorClip(command.clipId);
        if (!found) throw new Error(`Color clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The color layer is locked.");
        updateColorClip(command.clipId, command.patch);
        return { clipId: command.clipId, updated: Object.keys(command.patch) };
      }
      case "capture_preview":
        return captureMcpPreview(command.mode);
      default:
        throw new Error(`The ${command.name} command is not available in the timeline workspace.`);
    }
  }

  mcpSnapshotLatestRef.current = createMcpSnapshot;
  mcpCommandLatestRef.current = executeMcpCommand;

  useEffect(() => {
    mcpRegisterLatestRef.current(mcpBridgeRef.current);
    return () => mcpRegisterLatestRef.current(null);
  }, []);

  useEffect(() => {
    mcpSnapshotCallbackLatestRef.current(createMcpSnapshot());
  }, [animationDurations, currentTime, directory, displayVisualTracks, duration, metas, playing, project, selectedClips, speed, stageView, timeline]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => mcpSnapshotCallbackLatestRef.current(createMcpSnapshotLatestRef.current()));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!timeline || timeline.sequenceId !== "opening" || timeline.durationMode !== "auto" || !characterMeta || (introAnimation && introDuration <= 0)) return;
    if (Math.abs(timeline.duration - openingAutoDuration) < 0.01) return;
    updateTimeline((value) => ({ ...value, duration: openingAutoDuration }), false);
  }, [characterMeta, duration, openingAutoDuration, introAnimation, introDuration, timeline]);

  useEffect(() => {
    if (!timeline || !isTalkSequence || timeline.durationMode !== "auto") return;
    const nextDuration = Math.max(1, autoTalkDuration - talkMixDuration);
    if (Math.abs(timeline.duration - nextDuration) < 0.01) return;
    updateTimeline((value) => ({ ...value, duration: nextDuration }), false);
  }, [autoTalkDuration, isTalkSequence, talkMixDuration, timeline]);

  function onAnimationDuration(layerId: string, animation: string, animationDuration: number) {
    const key = `${layerId}:${animation}`;
    setAnimationDurations((value) => value[key] === animationDuration ? value : { ...value, [key]: animationDuration });
    const currentTimeline = timeline;
    const currentLayer = currentTimeline?.layers.find((layer) => layer.id === layerId);
    if (!currentTimeline || !currentLayer) return;
    if (Array.isArray(currentLayer.animationClips)) {
      const nextClips = currentLayer.animationClips.map((clip) => {
        if (clip.animation !== animation || clip.endMode === "manual" || clip.loop) return clip;
        const end = animationClipEnd(clip, animationDuration);
        return Math.abs(clip.end - end) < 0.01 ? clip : { ...clip, end };
      });
      if (nextClips.every((clip, index) => clip === currentLayer.animationClips![index])) return;
      updateTimeline((value) => ({
        ...value,
        layers: value.layers.map((layer) => layer.id === layerId ? { ...layer, animationClips: nextClips } : layer),
        duration: Math.max(value.duration, ...nextClips.map((clip) => clip.end)),
      }), false);
      return;
    }
    if (currentLayer.endMode === "manual") return;
    const talkCharacter = currentTimeline.sequenceId?.startsWith("talk-") && currentLayer.role === "character";
    if (!talkCharacter && currentLayer.loop) return;
    const effectiveLayer = talkCharacter ? { ...currentLayer, loop: false } : currentLayer;
    const nextEnd = animationEndForLayer(effectiveLayer, animationDuration);
    const currentTalkDuration = talkCharacter
      ? Math.max(MIN_TIMELINE_DURATION, ...currentTimeline.layers.filter((layer) => layer.role === "character").map((layer) => layer.id === layerId ? nextEnd : layer.end))
      : 0;
    const nextDuration = talkCharacter
      ? Math.max(MIN_TIMELINE_DURATION, currentTimeline.duration, currentTalkDuration, authoredTimelineEnd(currentTimeline))
      : Math.max(currentTimeline.duration, nextEnd);
    const layerNeedsUpdate = Math.abs(currentLayer.end - nextEnd) >= 0.01 || (talkCharacter && currentLayer.loop);
    const durationNeedsUpdate = Math.abs(currentTimeline.duration - nextDuration) >= 0.01;
    if (!layerNeedsUpdate && !durationNeedsUpdate) return;
    updateTimeline((value) => ({
      ...value,
      layers: value.layers.map((layer) => layer.id === layerId && layer.endMode !== "manual" ? { ...layer, loop: talkCharacter ? false : layer.loop, end: nextEnd } : layer),
      duration: talkCharacter
        ? Math.max(MIN_TIMELINE_DURATION, value.duration, ...value.layers.filter((layer) => layer.role === "character").map((layer) => layer.id === layerId ? nextEnd : layer.end), authoredTimelineEnd(value))
        : Math.max(value.duration, nextEnd),
    }), false);
  }

  function chooseSequence(id: string) {
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
    talkAutoplayTimerRef.current = null;
    setPendingTalkSequence(null);
    setTalkAutoplayActive(false);
    onMutate((current) => switchSequence(current, id, animations, directories));
    currentTimeRef.current = 0;
    setCurrentTime(0); setPlaying(false); setPreviewUntil(null); setSelectedClips([]); setSelectedAudioId(null); setInspector("sequence");
  }

  function startTalkAutoplay() {
    const selected = talkSequenceIds.includes(timeline?.sequenceId ?? "") ? timeline?.sequenceId : talkSequenceIds[0];
    if (!selected) return;
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
    talkAutoplayTimerRef.current = null;
    setPendingTalkSequence(null);
    setTalkAutoplayActive(true);
    setPreviewUntil(null);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    if (timeline?.sequenceId !== selected) onMutate((current) => switchSequence(current, selected, animations, directories));
    setPlaying(true);
  }

  function replayTalkSequence() {
    if (!isTalkSequence) return;
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
    talkAutoplayTimerRef.current = null;
    setPendingTalkSequence(null);
    setPreviewUntil(null);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    setPlaying(true);
  }

  function stopTalkAutoplay() {
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
    talkAutoplayTimerRef.current = null;
    setPendingTalkSequence(null);
    setTalkAutoplayActive(false);
    setPreviewUntil(null);
    setPlaying(false);
    currentTimeRef.current = 0;
    setCurrentTime(0);
  }

  function previewAnimationClip(layer: EditorTimelineLayer, clip: EditorAnimationClip) {
    const end = animationClipEnd(clip, animationDurations[`${layer.id}:${clip.animation}`] ?? 0);
    setCurrentTime(clip.start);
    setPreviewUntil(Math.max(clip.start + 0.01, end));
    setPlaying(true);
  }

  function selectedTrackAnimationClips(): { layer: EditorTimelineLayer; clips: EditorAnimationClip[] } | null {
    const layer = selectedLayer ?? characterLayer;
    if (!layer) return null;
    return { layer, clips: layerAnimationClips(layer).filter((clip) => clip.enabled !== false) };
  }

  function stepSelectedTrackClip(direction: -1 | 1) {
    if (selectedColorLayer) {
      const clips = selectedColorLayer.clips.filter((clip) => clip.enabled).sort((a, b) => a.start - b.start);
      const index = clips.findIndex((clip) => currentTime >= clip.start && currentTime < clip.end);
      const next = clips[Math.max(0, Math.min(clips.length - 1, (index < 0 ? 0 : index) + direction))];
      if (next) { setCurrentTime(next.start); setPlaying(false); setPreviewUntil(null); }
      return;
    }
    const selected = selectedTrackAnimationClips();
    if (!selected?.clips.length) return;
    const index = selected.clips.findIndex((clip) => currentTime >= clip.start && currentTime < animationClipEnd(clip, animationDurations[`${selected.layer.id}:${clip.animation}`] ?? 0));
    const next = selected.clips[Math.max(0, Math.min(selected.clips.length - 1, (index < 0 ? 0 : index) + direction))];
    if (next) { setCurrentTime(next.start); setPlaying(false); setPreviewUntil(null); }
  }

  useEffect(() => {
    if (!project || !directory || project.timeline.layersInitialized) return;
    const ensured = ensureTimelineLayers(project.timeline, directory, directories);
    onLive((current) => ({ ...current, timeline: ensureTimelineLayers(current.timeline, directory, directories) }));
    onStatus(`Initialized ${ensured.layers.length} synchronized Spine layers.`);
  }, [directories, directory, onLive, onStatus, project]);

  useEffect(() => {
    if (!source || displayLayers.length === 0) {
      setFiles({});
      setLayerLoadErrors({});
      setLayerManifestVersions({});
      return;
    }
    let cancelled = false;
    setFiles({});
    setLayerLoadErrors({});
    setLayerManifestVersions({});
    void Promise.all(displayLayers.map(async (layer) => {
      try {
        const assetPath = project?.timeline.assetPaths?.[layer.directory];
        const files = assetPath && source.getSetFilesAtPath
          ? await source.getSetFilesAtPath(assetPath)
          : await source.getSetFiles(layer.directory);
        const manifest = await source.getManifest?.(layer.directory);
        const assetSet = manifest?.manifest.assets[layer.directory];
        if (manifest && !cancelled) setLayerManifestVersions((current) => ({ ...current, [layer.id]: manifest.manifest.schemaVersion }));
        if (manifest && assetSet) {
          const missingReferences = missingManifestAssetFiles(assetSet.files, [...files.keys()]);
          if (missingReferences.length > 0) {
            const firstMissing = missingReferences.slice(0, 4).join(", ");
            const suffix = missingReferences.length > 4 ? `, and ${missingReferences.length - 4} more` : "";
            throw new Error(`Manifest references missing files: ${firstMissing}${suffix}.`);
          }
        }
        if (files.size === 0) throw new Error("No Spine files were found for this layer.");
        return [layer.directory, files] as const;
      } catch (value) {
        if (!cancelled) {
          const message = value instanceof Error ? value.message : String(value);
          setLayerLoadErrors((current) => ({ ...current, [layer.id]: message }));
          onError(`${layer.directory}: ${message}`);
        }
        return [layer.directory, null] as const;
      }
    })).then((entries) => {
      if (!cancelled) setFiles(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [layerAssetPathsKey, layerDirectoriesKey, onError, source]);

  useEffect(() => {
    const clips = timeline?.audio ?? [];
    audioPreloadIdentityRef.current = { source, key: audioLoadKey };
    const wanted = new Set(clips.map((clip) => clip.id));
    for (const id of Object.keys(audioUrlRecordsRef.current)) {
      if (wanted.has(id)) continue;
      clearAudioUrl(id);
    }
    for (const id of Object.keys(pendingAudioLoadsRef.current)) {
      if (!wanted.has(id)) delete pendingAudioLoadsRef.current[id];
    }
    setMissingAudio((value) => {
      const next = value.filter((path) => clips.some((clip) => clip.path === path));
      return next.length === value.length ? value : next;
    });
    setAudioPreloadStates((value) => {
      const next: Record<string, SpineTimelineAudioPreloadState> = {};
      for (const clip of clips) {
        const record = audioUrlRecordsRef.current[clip.id];
        const resourceMatches = record?.path === clip.path && record.source === source;
        next[clip.id] = resourceMatches
          ? value[clip.id] ?? (audioElementsRef.current[clip.id]?.readyState && audioElementsRef.current[clip.id]!.readyState >= 3 ? "ready" : "loading")
          : "loading";
      }
      return Object.keys(next).length === Object.keys(value).length && Object.keys(next).every((id) => next[id] === value[id]) ? value : next;
    });
    for (const clip of clips) {
      const record = audioUrlRecordsRef.current[clip.id];
      if (record && record.path === clip.path && record.source === source) {
        const audio = audioElementsRef.current[clip.id];
        const readiness = audio?.readyState !== undefined && audio.readyState >= 3 ? "ready" : "loading";
        if (audioPreloadStates[clip.id] !== "missing") setAudioPreloadState(clip.id, readiness);
        continue;
      }
      if (record) clearAudioUrl(clip.id);
      else if (audioPreloadStates[clip.id] === "missing") setAudioPreloadState(clip.id, "loading");
      if (!source) {
        delete pendingAudioLoadsRef.current[clip.id];
        setAudioPreloadState(clip.id, "missing");
        continue;
      }
      const pending = pendingAudioLoadsRef.current[clip.id];
      if (pending?.path === clip.path && pending.source === source) continue;
      const request: PendingAudioLoad = { path: clip.path, source };
      pendingAudioLoadsRef.current[clip.id] = request;
      void findAudioFile(source, clip.path).then((file) => {
        if (pendingAudioLoadsRef.current[clip.id] !== request) return;
        delete pendingAudioLoadsRef.current[clip.id];
        const currentClip = projectRef.current?.timeline.audio.find((item) => item.id === clip.id);
        if (sourceRef.current !== source || currentClip?.path !== clip.path) return;
        if (!file) {
          setMissingAudio((value) => value.includes(clip.path) ? value : [...value, clip.path]);
          setAudioPreloadState(clip.id, "missing");
          return;
        }
        setMissingAudio((value) => value.filter((path) => path !== clip.path));
        storeAudioUrl(clip.id, clip.path, URL.createObjectURL(file), source);
      }).catch(() => {
        if (pendingAudioLoadsRef.current[clip.id] !== request) return;
        delete pendingAudioLoadsRef.current[clip.id];
        if (sourceRef.current === source && projectRef.current?.timeline.audio.some((item) => item.id === clip.id && item.path === clip.path)) {
          setMissingAudio((value) => value.includes(clip.path) ? value : [...value, clip.path]);
          setAudioPreloadState(clip.id, "missing");
        }
      });
    }
  }, [audioLoadKey, source, timeline?.audio]);

  useEffect(() => () => {
    for (const record of Object.values(audioUrlRecordsRef.current)) URL.revokeObjectURL(record.url);
    for (const audio of Object.values(audioElementsRef.current)) audio?.pause();
    audioUrlsRef.current = {};
    audioUrlRecordsRef.current = {};
    pendingAudioLoadsRef.current = {};
  }, []);

  useEffect(() => {
    audioStartedRef.current = {};
    audioPreviousTimeRef.current = {};
    setAudioDurations({});
  }, [directory, source, timeline?.sequenceId]);

  useEffect(() => {
    subtitleDocumentsRef.current = {};
    subtitleOriginalsRef.current = {};
  }, [directory, source]);

  useEffect(() => {
    if (!initialSubtitlePath) openedSubtitleRef.current = "";
  }, [initialSubtitlePath]);

  useEffect(() => {
    if (!initialAudioPaths?.length) openedAudioRef.current = "";
  }, [initialAudioPaths]);

  useEffect(() => {
    if (!initialSubtitlePath || !source || !project) return;
    const key = `${source.rootPath}:${directory}:${initialSubtitlePath}`;
    if (openedSubtitleRef.current === key) return;
    openedSubtitleRef.current = key;
    void source.readText(initialSubtitlePath).then((content) => {
      if (!content) throw new Error(`Recent subtitle file is missing: ${initialSubtitlePath}`);
      return importSubtitleFile({ path: initialSubtitlePath, content });
    }).then(() => onSubtitleOpened()).catch((value) => onError(value instanceof Error ? value.message : String(value)));
  }, [directory, initialSubtitlePath, onError, onSubtitleOpened, project, source]);

  function applyDecodedAudioDuration(id: string, decodedDuration: number) {
    const currentTimeline = timeline;
    const clip = currentTimeline?.audio.find((item) => item.id === id);
    if (!currentTimeline) return;
    if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) return;
    setAudioDurations((value) => value[id] === decodedDuration ? value : { ...value, [id]: decodedDuration });
    if (!clip?.autoEnd) return;
    const timing = decodedAudioTiming(clip.start, decodedDuration);
    if (!timing) return;
    const linked = linkedSubtitleForAudio(currentTimeline, clip);
    const linkedTimingMatches = !linked || (Math.abs(linked.start - clip.start) < 0.01 && Math.abs(linked.end - timing.end) < 0.01);
    if (Math.abs(clip.end - timing.end) < 0.01 && linkedTimingMatches) return;
    updateTimeline((value) => matchAudioAndSubtitleLength(value, id, decodedDuration), false);
  }

  useEffect(() => {
    if (!audioPreloadsReady) {
      Object.values(audioElementsRef.current).forEach((audio) => audio?.pause());
      return;
    }
    for (const clip of timeline?.audio ?? []) {
      const audio = audioElementsRef.current[clip.id];
      if (!audio) continue;
      if (audioPreloadStates[clip.id] === "missing") {
        audio.pause();
        audioStartedRef.current[clip.id] = false;
        audioPreviousTimeRef.current[clip.id] = undefined;
        continue;
      }
      audio.volume = clip.volume;
      audio.playbackRate = speed;
      const active = clip.enabled && currentTime >= clip.start && currentTime <= clip.end;
      const decision = audioPlaybackDecision({
        active,
        playing,
        currentTime,
        previousTime: audioPreviousTimeRef.current[clip.id],
        started: audioStartedRef.current[clip.id] === true,
        ended: audio.ended,
      });
      audioPreviousTimeRef.current[clip.id] = currentTime;
      audioStartedRef.current[clip.id] = decision.started;
      if (!active) { audio.pause(); continue; }
      const local = Math.max(0, currentTime - clip.start);
      if (decision.seek || Math.abs(audio.currentTime - local) > 0.08) audio.currentTime = local;
      if (decision.play) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  }, [audioPreloadsReady, audioUrls, currentTime, playing, speed, timeline?.audio]);

  useEffect(() => {
    if (!playing || !audioPreloadsReady) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const delta = Math.min(0.1, Math.max(0, (now - previous) / 1000));
      previous = now;
      const stopAt = previewUntil === null ? duration : Math.min(duration, previewUntil);
      const advanced = advanceSpineTimeline(currentTimeRef.current, delta, speed, stopAt, previewUntil === null && Boolean(timeline?.loop) && !talkAutoplayActive);
      currentTimeRef.current = advanced.time;
      setCurrentTime(advanced.time);
      if (advanced.finished) {
        setPlaying(false);
        if (previewUntil !== null) setPreviewUntil(null);
        else if (talkAutoplayActive && isTalkSequence && timeline?.sequenceId) {
          const next = nextTalkSequenceId(talkSequenceIds, timeline.sequenceId, loopTalkList);
          if (next) setPendingTalkSequence(next);
          else setTalkAutoplayActive(false);
        }
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioPreloadsReady, duration, isTalkSequence, loopTalkList, playing, previewUntil, speed, talkAutoplayActive, talkSequenceIds, timeline?.audio, timeline?.loop, timeline?.sequenceId]);

  useEffect(() => {
    if (!pendingTalkSequence || !talkAutoplayActive) return;
    const timer = window.setTimeout(() => {
      talkAutoplayTimerRef.current = null;
      const context = sequenceContextRef.current;
      onMutateRef.current((current) => switchSequence(current, pendingTalkSequence, context.animations, context.directories));
      currentTimeRef.current = 0;
      setCurrentTime(0);
      setPreviewUntil(null);
      setPendingTalkSequence(null);
      setPlaying(true);
    }, Math.max(0, pauseBetweenTalks * 1000));
    talkAutoplayTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (talkAutoplayTimerRef.current === timer) talkAutoplayTimerRef.current = null;
    };
  }, [pauseBetweenTalks, pendingTalkSequence, talkAutoplayActive]);

  useEffect(() => () => {
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
  }, []);

  useEffect(() => {
    if (!timeline) return;
    setCurrentTime((value) => Math.min(value, duration));
  }, [directory, duration, timeline]);

  function projectTimelines(current: EditorProject) {
    const activeId = current.timeline.sequenceId;
    return [current.timeline, ...Object.entries(current.sequences ?? {})
      .filter(([id, timeline]) => id !== activeId && timeline.sequenceId !== activeId)
      .map(([, timeline]) => timeline)];
  }

  async function saveSubtitleDocuments(getProject: () => EditorProject | null = () => projectRef.current): Promise<EditorSaveFile[]> {
      const current = getProject();
      const currentSource = sourceRef.current;
      if (!current || !currentSource) return [];
      const timelines = projectTimelines(current);
      const paths = new Set(timelines.map((item) => item.subtitlePath).filter((path): path is string => Boolean(path)));
      const writes: EditorSaveFile[] = [];
      for (const path of paths) {
        let document = subtitleDocumentsRef.current[path];
        if (!document) {
          const file = await currentSource.getFile(path);
          if (!file) throw new Error(`Linked subtitle file not found: ${path}`);
          const original = await file.text();
          subtitleOriginalsRef.current[path] = original;
          const parsed = JSON.parse(original) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Linked subtitle file is not a JSON object: ${path}`);
          document = parsed as Record<string, unknown>;
          subtitleDocumentsRef.current[path] = structuredClone(document);
        }
        const serialized = serializeSubtitleDocument(document, current.assetDirectory, timelines);
        writes.push({ path, content: serialized, baselineContent: subtitleOriginalsRef.current[path] ?? null });
        const record = await currentSource.getManifest?.(directoryRef.current);
        const legacyPath = record?.manifest.legacySubtitles
          ? manifestReferenceCandidates(record, record.manifest.legacySubtitles)[0]
          : undefined;
        if (legacyPath && legacyPath !== path) {
          if (!(legacyPath in subtitleOriginalsRef.current)) subtitleOriginalsRef.current[legacyPath] = await currentSource.readText(legacyPath);
          writes.push({ path: legacyPath, content: serialized, baselineContent: subtitleOriginalsRef.current[legacyPath] });
        }
      }
      return writes;
  }

  saveSubtitleDocumentsRef.current = saveSubtitleDocuments;

  useEffect(() => {
    onRegisterSaveRef.current((getProject) => saveSubtitleDocumentsRef.current(getProject));
  }, [directory, source]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const menu = addMenuRef.current;
      if (!menu?.open || (event.target instanceof Node && menu.contains(event.target))) return;
      menu.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  function updateTimeline(mutator: (timeline: EditorProject["timeline"]) => EditorProject["timeline"], history = true) {
    const callback = history ? onMutate : onLive;
    callback((current) => ({ ...current, timeline: mutator(current.timeline) }));
  }

  function updateTalkMixDuration(value: number) {
    if (!Number.isFinite(value)) return;
    onMutate((current) => ({ ...current, talkMixDuration: Math.max(0, Math.min(2, value)) }));
  }

  function updateLayer(id: string, patch: Partial<EditorTimelineLayer>, history = true) {
    updateTimeline((value) => {
      const selected = value.layers.find((layer) => layer.id === id);
      if (selected?.locked && patch.locked === undefined && !Object.keys(patch).every((key) => key === "enabled")) return value;
      const layers = value.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer);
      const openingCharacter = value.sequenceId === "opening" && selected?.role === "character" && patch.start !== undefined;
      const next = {
        ...value,
        layers,
        ...(openingCharacter && value.openingMode === "scene-first" ? { sceneDuration: Math.max(0, patch.start ?? selected.start) } : {}),
      };
      if (patch.end === undefined) return next;
      const changed = layers.find((layer) => layer.id === id);
      return { ...next, duration: Math.max(next.duration, changed?.end ?? next.duration) };
    }, history);
  }

  function updateAnimationClip(layerId: string, clipId: string, patch: Partial<EditorAnimationClip>, history = true) {
    updateTimeline((value) => {
      const layers = value.layers.map((layer) => {
        if (layer.id !== layerId) return layer;
        if (layer.locked) return layer;
        const clips = layerAnimationClips(layer, value);
        return { ...layer, animationClips: clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) };
      });
      const end = Math.max(0, ...layers.map((layer) => Math.max(0, ...layerAnimationClips(layer, value).map((clip) => animationClipEnd(clip, animationDurations[`${layer.id}:${clip.animation}`] ?? 0)))));
      return extendTimelineDuration({ ...value, layers, duration: Math.max(value.duration, end) });
    }, history);
  }

  function moveAnimationClipTo(layerId: string, clipId: string, start: number) {
    updateTimeline((value) => {
      const owner = value.layers.find((layer) => layer.id === layerId);
      if (!owner || owner.locked) return value;
      const clips = layerAnimationClips(owner, value);
      const targets = value.layers.flatMap((layer) => layerAnimationClips(layer, value).filter((clip) => clip.id !== clipId).flatMap((clip) => [clip.start, clip.end]));
      const moved = moveAnimationClipRipple(clips, clipId, start, value.snap, targets);
      const layers = value.layers.map((layer) => layer.id === layerId ? { ...layer, animationClips: moved } : layer);
      return extendTimelineDuration({ ...value, layers, duration: Math.max(value.duration, ...moved.map((clip) => clip.end)) });
    });
  }

  function addAnimationClip(layerId = timeline?.selectedLayerId ?? characterLayer?.id ?? "") {
    if (!timeline || !layerId) return;
    const layer = timeline.layers.find((item) => item.id === layerId);
    const meta = layer ? metas[layer.id] : null;
    if (!layer || layer.locked || !meta) {
      onStatus("Wait for the selected Spine layer to finish loading before adding an animation clip.");
      return;
    }
    const animation = meta.idleAnimation || meta.animations.find((name) => /^idle(?:_|$)/i.test(name)) || meta.animations[0] || "";
    const start = snapTime(currentTime, timeline.snap, Number.POSITIVE_INFINITY);
    const duration = Math.max(0.1, animationDurations[`${layer.id}:${animation}`] ?? (timeline.sequenceId === "opening" ? openingIdleDuration || 3 : 2));
    const loop = /^idle(?:_|$)/i.test(animation);
    const clip: EditorAnimationClip = {
      id: `animation-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      animation,
      start,
      end: start + (loop ? Math.max(duration, timeline.sequenceId === "opening" ? openingIdleDuration || 3 : duration) : duration),
      endMode: "auto",
      animationOffset: 0,
      loop,
      enabled: true,
      ...(timeline.sequenceId === "opening" && layer.role === "character" && loop ? { continueAfterOpening: true } : {}),
    };
    const clips = insertAnimationClipRipple(layerAnimationClips(layer), clip);
    updateTimeline((value) => ({ ...value, layers: value.layers.map((item) => item.id === layer.id ? { ...item, animationClips: clips } : item), selectedLayerId: layer.id, selectedColorLayerId: null, selectedColorClipId: null }));
    setSelectedClips([{ kind: "animation", id: clip.id }]);
    setSelectedAudioId(null);
    setInspector("animation");
    onStatus(`Added ${animation || "animation"} at ${seconds(start)}.`);
  }

  function duplicateSelectedAnimationClip() {
    if (!selectedAnimationClip || selectedAnimationClip.layer.locked) return;
    const id = `animation-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    updateTimeline((value) => {
      const layer = value.layers.find((item) => item.id === selectedAnimationClip.layer.id);
      if (!layer || layer.locked) return value;
      const clips = duplicateAnimationClipRipple(layerAnimationClips(layer, value), selectedAnimationClip.clip.id, id);
      return { ...value, layers: value.layers.map((item) => item.id === layer.id ? { ...item, animationClips: clips } : item), selectedColorLayerId: null, selectedColorClipId: null };
    });
    setSelectedClips([{ kind: "animation", id }]);
    setInspector("animation");
  }

  function updateCue(id: string, patch: Partial<EditorSubtitleCue>, history = true) {
    updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: value.subtitles.map((cue) => cue.id === id ? { ...cue, ...patch } : cue) }), history);
  }

  function updateAudio(id: string, patch: Partial<EditorAudioClip>, history = true) {
    updateTimeline((value) => extendTimelineDuration({ ...value, audio: value.audio.map((clip) => clip.id === id ? { ...clip, ...patch } : clip) }), history);
  }

  function setAudioSubtitleLink(audioId: string, subtitleId: string | null) {
    updateTimeline((value) => linkAudioToSubtitle(value, audioId, subtitleId));
    setPreviewUntil(null);
  }

  function matchSelectedAudioLength() {
    if (!selectedAudio || selectedAudioDuration === undefined) {
      onStatus("Decode the audio first before matching its length.");
      return;
    }
    const linked = timeline ? linkedSubtitleForAudio(timeline, selectedAudio) : null;
    updateTimeline((value) => matchAudioAndSubtitleLength(value, selectedAudio.id, selectedAudioDuration));
    onStatus(linked ? "Matched the audio clip and linked subtitle to the source duration." : "Matched the audio clip to the source duration.");
  }

  function previewSelectedAudio() {
    if (!selectedAudio) return;
    setCurrentTime(selectedAudio.start);
    setPreviewUntil(selectedAudio.end);
    setPlaying(true);
  }

  function addAudioFiles(selected: Array<{ path: string; file: File }>) {
    if (!selected.length || !timeline || !source) return;
    const clips = selected.map(({ path, file }, index): EditorAudioClip => {
      const id = `audio-file-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
      const start = snapTime(currentTime + index * 0.01, timeline.snap, Number.POSITIVE_INFINITY);
      storeAudioUrl(id, path, URL.createObjectURL(file), source);
      return { id, name: path.split(/[\\/]/).pop() ?? path, path, autoEnd: true, start, end: start + 2, enabled: true, volume: 1 };
    });
    updateTimeline((value) => extendTimelineDuration({ ...value, audio: [...value.audio, ...clips], selectedColorLayerId: null, selectedColorClipId: null }));
    if (clips.length === 1) {
      setSelectedAudio(clips[0]!.id);
    } else if (clips.length > 1) {
      setPreviewUntil(null);
      setSelectedClips(clips.map((clip) => ({ kind: "audio" as const, id: clip.id })));
      setSelectedAudioId(clips[0]!.id);
      setInspector("multi");
      updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), false);
    }
    onStatus(`Added ${clips.length} local audio clip${clips.length === 1 ? "" : "s"}.`);
  }

  useEffect(() => {
    if (!initialAudioPaths?.length || !source || !project || !timeline) return;
    const key = `${source.rootPath}:${directory}:${initialAudioPaths.join("|")}`;
    if (openedAudioRef.current === key) return;
    openedAudioRef.current = key;
    void Promise.all(initialAudioPaths.map(async (path) => {
      const file = await findAudioFile(source, path);
      if (!file) throw new Error(`Recent audio file is missing: ${path}`);
      return { path, file };
    })).then((selected) => {
      addAudioFiles(selected);
      onAudioOpened();
    }).catch((value) => onError(value instanceof Error ? value.message : String(value)));
  }, [directory, initialAudioPaths, onAudioOpened, onError, project, source, timeline]);

  function isClipSelected(kind: TimelineClipKind, id: string): boolean {
    return selectedClips.some((item) => item.kind === kind && item.id === id);
  }

  function focusTimelineClip(selection: TimelineSelection) {
    setPreviewUntil(null);
    if (selection.kind === "layer") {
      setSelectedAudioId(null);
      setInspector("layer");
      updateTimeline((value) => ({ ...value, selectedLayerId: selection.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), false);
    } else if (selection.kind === "color-layer") {
      setSelectedAudioId(null);
      setInspector("color-layer");
      updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: selection.id, selectedColorClipId: null }), false);
    } else if (selection.kind === "animation") {
      const found = findAnimationClip(selection.id);
      if (!found) return;
      setSelectedAudioId(null);
      setInspector("animation");
      updateTimeline((value) => ({ ...value, selectedLayerId: found.layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), false);
    } else if (selection.kind === "color") {
      const found = findColorClip(selection.id);
      if (!found) return;
      setSelectedAudioId(null);
      setInspector("color-clip");
      updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: found.clip.id }), false);
    } else if (selection.kind === "cue") {
      setSelectedAudioId(null);
      setInspector("cue");
      updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: selection.id, selectedColorLayerId: null, selectedColorClipId: null }), false);
    } else {
      setSelectedAudioId(selection.id);
      setInspector("audio");
      updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), false);
    }
  }

  function clearTimelineSelection() {
    setSelectedClips([]);
    setSelectedAudioId(null);
    setInspector("sequence");
    updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), false);
  }

  function selectTimelineClip(selection: TimelineSelection, event: ReactPointerEvent<HTMLElement>): TimelineSelection[] | null {
    event.stopPropagation();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (additive) {
      const exists = isClipSelected(selection.kind, selection.id);
      const next = exists
        ? selectedClips.filter((item) => item.kind !== selection.kind || item.id !== selection.id)
        : [...selectedClips, selection];
      setSelectedClips(next);
      if (next.length === 0) clearTimelineSelection();
      else {
        focusTimelineClip(next.at(-1)!);
        if (next.length > 1) setInspector("multi");
      }
      return null;
    }

    const next = isClipSelected(selection.kind, selection.id) ? selectedClips : [selection];
    setSelectedClips(next);
    focusTimelineClip(selection);
    if (next.length > 1) setInspector("multi");
    return next;
  }

  function setSelectedAudio(id: string | null) {
    if (!id) { clearTimelineSelection(); return; }
    const selection = { kind: "audio" as const, id };
    setSelectedClips([selection]);
    focusTimelineClip(selection);
  }

  function closeAddMenu() {
    if (addMenuRef.current) addMenuRef.current.open = false;
  }

  function addCue() {
    if (!timeline) return;
    const start = snapTime(currentTime, timeline.snap, Number.POSITIVE_INFINITY);
    setInspector("cue");
    setPreviewUntil(null);
    const cue: EditorSubtitleCue = {
      id: `subtitle-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      start,
      end: start + 2,
      enabled: true,
      text: { en: "", ja: "", ko: "" },
    };
    setSelectedClips([{ kind: "cue", id: cue.id }]);
    updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: [...value.subtitles, cue], selectedCueId: cue.id, selectedColorLayerId: null, selectedColorClipId: null }));
    onStatus(`Subtitle cue added at ${seconds(start)}.`);
  }

  async function importSubtitleFile(selected: { path: string; content: string }) {
    try {
      const raw = JSON.parse(selected.content) as Record<string, unknown>;
      const subtitlePath = selected.path;
      subtitleDocumentsRef.current[subtitlePath] = structuredClone(raw);
      subtitleOriginalsRef.current[subtitlePath] = selected.content;
      const sourceFile = Array.isArray(raw.characters) ? raw.characters.find((item) => (item as Record<string, unknown>).directory === directory) as Record<string, unknown> : raw;
      if (!sourceFile || !Array.isArray(sourceFile.lines)) throw new Error("No matching character subtitle lines found.");
      let count = 0;
      subtitleDocumentsRef.current = { [subtitlePath]: structuredClone(raw) };
      onMutate((current) => {
        let next = replaceSubtitleImport(current, subtitlePath);
        const original = current.timeline.sequenceId ?? "opening";
        for (const candidate of sourceFile.lines as Record<string, unknown>[]) {
          const number = String(candidate.id ?? "").match(/(\d+)$/)?.[1];
          if (number === undefined) continue;
          const id = Number(number) === 0 ? "opening" : `talk-${Number(number)}`;
          next = switchSequence(next, id, animations, directories);
          const imported = importedSubtitleCues({ ...sourceFile, lines: [candidate] });
        next = { ...next, timeline: extendTimelineDuration({ ...next.timeline, subtitlePath, duration: Math.max(next.timeline.duration, imported.duration), subtitles: imported.cues.map((cue) => ({ ...cue, lineId: String(candidate.id) })), audio: imported.audio.map((clip) => ({ ...clip, lineId: String(candidate.id) })), selectedCueId: imported.cues[0]?.id ?? null }) };
          count += imported.cues.length;
        }
        return switchSequence(next, original, animations, directories);
      });
      if (source) onRecentFile({ kind: "subtitle", path: subtitlePath, rootPath: source.rootPath, label: subtitlePath.split(/[\\/]/).pop() ?? subtitlePath, directory });
      onStatus(`Replaced the previous subtitle/audio import with ${count} cue${count === 1 ? "" : "s"}.${subtitlePath ? " Source JSON is linked; changes will be written with Save project." : " Original files unchanged."}`);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    }
  }

  async function importSubtitles() {
    if (!source) return;
    try {
      const selected = await source.openText();
      if (selected) await importSubtitleFile(selected);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    }
  }

  async function selectAudioFiles(): Promise<Array<{ path: string; file: File }>> {
    if (!source) return [];
    try {
      const paths = await source.openAudio();
      paths.forEach((path) => onRecentFile({ kind: "audio", path, rootPath: source.rootPath, label: path.split(/[\\/]/).pop() ?? path, directory }));
      return (await Promise.all(paths.map(async (path) => ({ path, file: await source.getFile(path) })))).filter((entry): entry is { path: string; file: File } => entry.file !== null);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
      return [];
    }
  }

  async function importAudio() {
    const selected = await selectAudioFiles();
    addAudioFiles(selected);
  }

  async function relinkAudio() {
    const selected = await selectAudioFiles();
    if (!selected.length || !timeline || !source) return;
    const missing = timeline.audio.filter((clip) => missingAudio.includes(clip.path) && !audioUrlsRef.current[clip.id]);
    const used = new Set<string>();
    let linked = 0;
    for (const { path, file } of selected) {
      const fileName = (path.split(/[\\/]/).pop() ?? path).toLocaleLowerCase();
      const clip = missing.find((candidate) => !used.has(candidate.id) && (candidate.path.split(/[\\/]/).pop() ?? candidate.path).toLocaleLowerCase() === fileName);
      if (!clip) continue;
      used.add(clip.id);
      delete pendingAudioLoadsRef.current[clip.id];
      storeAudioUrl(clip.id, clip.path, URL.createObjectURL(file), source);
      setMissingAudio((value) => value.filter((path) => path !== clip.path));
      linked += 1;
    }
    onStatus(linked ? `Relinked ${linked} audio clip${linked === 1 ? "" : "s"}.` : "No selected audio filenames matched the missing clips.");
  }

  function deleteCue() {
    if (!selectedCue) return;
    updateTimeline((value) => {
      const subtitles = value.subtitles.filter((cue) => cue.id !== selectedCue.id);
      const audio = value.audio.map((clip) => clip.subtitleId === selectedCue.id ? { ...clip, subtitleId: null } : clip);
      return { ...value, subtitles, audio, selectedCueId: null };
    });
    setSelectedClips([]);
    setInspector("sequence");
  }

  function deleteAudio() {
    if (!selectedAudio) return;
    updateTimeline((value) => {
      const audio = value.audio.filter((clip) => clip.id !== selectedAudio.id);
      return { ...value, audio };
    });
    setSelectedClips([]);
    setSelectedAudioId(null);
    setInspector("sequence");
  }

  function deleteSelectedClips() {
    if (!selectedClips.length || !timeline) return;
    const layers = new Set(selectedClips.filter((item) => item.kind === "layer").map((item) => item.id));
    const colorLayers = new Set(selectedClips.filter((item) => item.kind === "color-layer").map((item) => item.id));
    const animations = new Set(selectedClips.filter((item) => item.kind === "animation").map((item) => item.id));
    const colorClips = new Set(selectedClips.filter((item) => item.kind === "color").map((item) => item.id));
    const cues = new Set(selectedClips.filter((item) => item.kind === "cue").map((item) => item.id));
    const audio = new Set(selectedClips.filter((item) => item.kind === "audio").map((item) => item.id));
    const removableLayers = new Set(timeline.layers.filter((layer) => layers.has(layer.id) && layer.role !== "character" && !layer.locked).map((layer) => layer.id));
    const removableColorLayers = new Set(timeline.colorLayers.filter((layer) => colorLayers.has(layer.id) && !layer.locked).map((layer) => layer.id));
    updateTimeline((value) => ({
      ...value,
      layers: value.layers.filter((layer) => !removableLayers.has(layer.id)).map((layer) => {
        if (layer.locked) return layer;
        const clips = layerAnimationClips(layer, value);
        const selected = clips.filter((clip) => animations.has(clip.id));
        if (!selected.length) return layer;
        return { ...layer, animationClips: selected.reduce((current, clip) => deleteAnimationClipRipple(current, clip.id), clips) };
      }),
      colorLayers: value.colorLayers.filter((layer) => !removableColorLayers.has(layer.id)).map((layer) => layer.locked ? layer : { ...layer, clips: layer.clips.filter((clip) => !colorClips.has(clip.id)) }),
      subtitles: value.subtitles.filter((cue) => !cues.has(cue.id)),
      audio: value.audio.filter((clip) => !audio.has(clip.id)).map((clip) => clip.subtitleId && cues.has(clip.subtitleId) ? { ...clip, subtitleId: null } : clip),
      selectedLayerId: removableLayers.has(value.selectedLayerId ?? "") ? null : value.selectedLayerId,
      selectedCueId: cues.has(value.selectedCueId ?? "") ? null : value.selectedCueId,
      selectedColorLayerId: null,
      selectedColorClipId: null,
    }));
    for (const id of audio) {
      clearAudioUrl(id);
    }
    setSelectedClips([]);
    setSelectedAudioId(null);
    setInspector("sequence");
  }

  function setSelectedClipsEnabled(enabled: boolean) {
    if (!selectedClips.length) return;
    const layers = new Set(selectedClips.filter((item) => item.kind === "layer").map((item) => item.id));
    const colorLayers = new Set(selectedClips.filter((item) => item.kind === "color-layer").map((item) => item.id));
    const animations = new Set(selectedClips.filter((item) => item.kind === "animation").map((item) => item.id));
    const colorClips = new Set(selectedClips.filter((item) => item.kind === "color").map((item) => item.id));
    const cues = new Set(selectedClips.filter((item) => item.kind === "cue").map((item) => item.id));
    const audio = new Set(selectedClips.filter((item) => item.kind === "audio").map((item) => item.id));
    updateTimeline((value) => ({
      ...value,
      layers: value.layers.map((layer) => {
        if (layer.locked) return layer;
        const clips = layerAnimationClips(layer, value);
        const hasAnimationSelection = clips.some((clip) => animations.has(clip.id));
        if (!layers.has(layer.id) && !hasAnimationSelection) return layer;
        return {
          ...layer,
          ...(layers.has(layer.id) ? { enabled } : {}),
          ...(hasAnimationSelection ? { animationClips: clips.map((clip) => animations.has(clip.id) ? { ...clip, enabled } : clip) } : {}),
        };
      }),
      colorLayers: value.colorLayers.map((layer) => {
        if (layer.locked) return layer;
        const hasColorSelection = layer.clips.some((clip) => colorClips.has(clip.id));
        if (!colorLayers.has(layer.id) && !hasColorSelection) return layer;
        return {
          ...layer,
          ...(colorLayers.has(layer.id) ? { enabled } : {}),
          ...(hasColorSelection ? { clips: layer.clips.map((clip) => colorClips.has(clip.id) ? { ...clip, enabled } : clip) } : {}),
        };
      }),
      subtitles: value.subtitles.map((cue) => cues.has(cue.id) ? { ...cue, enabled } : cue),
      audio: value.audio.map((clip) => audio.has(clip.id) ? { ...clip, enabled } : clip),
    }));
  }

  function addLayer(directoryToAdd: string) {
    if (!timeline || !directoryToAdd || timeline.layers.some((layer) => layer.directory === directoryToAdd)) return;
    const found = discovered.find((item) => item.directory === directoryToAdd);
    const role = found?.role ?? (/_scene$/i.test(directoryToAdd) ? "scene" : /_bg$/i.test(directoryToAdd) ? "background" : "overlay");
    const layer = createTimelineLayer(directoryToAdd, role, Math.max(-1, ...timeline.layers.map((item) => item.order), ...timeline.colorLayers.map((item) => item.order)) + 1, duration);
    updateTimeline((value) => ({ ...value, layers: [...value.layers, layer], selectedLayerId: layer.id, selectedColorLayerId: null, selectedColorClipId: null }));
    setSelectedClips([{ kind: "layer", id: layer.id }]);
    setInspector("layer");
    onStatus(`Added ${directoryToAdd} as a ${role} layer.`);
  }

  function addColorLayer(nameHint?: string): string | null {
    if (!timeline) return null;
    const id = `color-layer-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
    const order = Math.max(-1, ...timeline.layers.map((layer) => layer.order), ...timeline.colorLayers.map((layer) => layer.order)) + 1;
    const layer: EditorColorLayer = {
      id,
      name: nameHint?.trim() || `Color ${timeline.colorLayers.length + 1}`,
      enabled: true,
      locked: false,
      opacity: 1,
      order,
      blendMode: "normal",
      clips: [],
    };
    updateTimeline((value) => ({ ...value, colorLayers: [...value.colorLayers, layer], selectedLayerId: null, selectedCueId: null, selectedColorLayerId: layer.id, selectedColorClipId: null }));
    setSelectedClips([{ kind: "color-layer", id }]);
    setInspector("color-layer");
    onStatus(`Added ${layer.name}.`);
    return id;
  }

  function addColorClip(preset: ColorClipPreset = "solid", requestedLayerId?: string): string | null {
    if (!timeline) return null;
    const requestedLayer = requestedLayerId ? timeline.colorLayers.find((item) => item.id === requestedLayerId) ?? null : null;
    let layer = (requestedLayer && !requestedLayer.locked ? requestedLayer : null)
      ?? (selectedColorLayer && !selectedColorLayer.locked ? selectedColorLayer : null)
      ?? [...timeline.colorLayers].reverse().find((item) => !item.locked)
      ?? null;
    if (requestedLayerId && (!requestedLayer || requestedLayer.locked)) throw new Error("Choose an existing unlocked color layer.");
    const createdLayer = !layer;
    if (!layer) {
      const id = `color-layer-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
      layer = {
        id,
        name: `Color ${timeline.colorLayers.length + 1}`,
        enabled: true,
        locked: false,
        opacity: 1,
        order: Math.max(-1, ...timeline.layers.map((item) => item.order), ...timeline.colorLayers.map((item) => item.order)) + 1,
        blendMode: "normal",
        clips: [],
      };
    }
    const clipId = `color-clip-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
    const clip = colorClipPreset(clipId, preset, snapTime(currentTime, timeline.snap, Number.POSITIVE_INFINITY));
    const targetLayer = layer;
    const clips = moveColorClip([...targetLayer.clips, clip], clip.id, clip.start);
    updateTimeline((value) => extendTimelineDuration({
      ...value,
      colorLayers: createdLayer
        ? [...value.colorLayers, { ...targetLayer, clips }]
        : value.colorLayers.map((item) => item.id === targetLayer.id ? { ...item, clips } : item),
      selectedLayerId: null,
      selectedCueId: null,
      selectedColorLayerId: targetLayer.id,
      selectedColorClipId: clip.id,
    }));
    setSelectedClips([{ kind: "color", id: clip.id }]);
    setInspector("color-clip");
    onStatus(`Added ${clip.name} at ${seconds(clip.start)}.`);
    return clip.id;
  }

  function duplicateSelectedColorClip() {
    if (!selectedColorClipFound || selectedColorLayer?.locked) return;
    const id = `color-clip-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
    const clips = duplicateColorClip(selectedColorClipFound.layer.clips, selectedColorClipFound.clip.id, id);
    updateColorLayer(selectedColorClipFound.layer.id, { clips });
    updateTimeline((value) => ({ ...value, selectedColorLayerId: selectedColorClipFound.layer.id, selectedColorClipId: id }), false);
    setSelectedClips([{ kind: "color", id }]);
    setInspector("color-clip");
  }

  function applyColorClipPreset(preset: ColorClipPreset) {
    if (!selectedColorClip || selectedColorLayer?.locked) return;
    const next = colorClipPreset(selectedColorClip.id, preset, selectedColorClip.start, selectedColorClip.end - selectedColorClip.start);
    updateColorClip(selectedColorClip.id, { name: next.name, color: next.color, opacity: next.opacity, fadeIn: next.fadeIn, fadeOut: next.fadeOut });
  }

  function removeLayer() {
    if (!selectedLayer || selectedLayer.role === "character" || selectedLayer.locked) return;
    const nextLayer = timeline?.layers.filter((layer) => layer.id !== selectedLayer.id).at(-1) ?? null;
    updateTimeline((value) => {
      const layers = value.layers.filter((layer) => layer.id !== selectedLayer.id);
      return { ...value, layers, selectedLayerId: layers.at(-1)?.id ?? null };
    });
    setSelectedClips(nextLayer ? [{ kind: "layer", id: nextLayer.id }] : []);
    setInspector(nextLayer ? "layer" : "sequence");
  }

  function dragClipKind(kind: TimelineDragKind): TimelineClipKind {
    if (kind === "color-fade-in" || kind === "color-fade-out") return "color";
    return kind.endsWith("-start") || kind.endsWith("-end") ? kind.slice(0, kind.lastIndexOf("-")) as TimelineClipKind : kind as TimelineClipKind;
  }

  function dragItem(selection: TimelineSelection): TimelineDragItem | null {
    if (!timeline) return null;
    if (selection.kind === "layer") {
      const layer = timeline.layers.find((item) => item.id === selection.id);
      return layer ? { ...selection, start: layer.start, end: layerEnd(layer) } : null;
    }
    if (selection.kind === "color-layer") return null;
    if (selection.kind === "animation") {
      const found = findAnimationClip(selection.id);
      return found ? { ...selection, start: found.clip.start, end: animationClipEnd(found.clip, animationDurations[`${found.layer.id}:${found.clip.animation}`] ?? 0) } : null;
    }
    if (selection.kind === "color") {
      const found = findColorClip(selection.id);
      return found ? { ...selection, start: found.clip.start, end: found.clip.end, fadeIn: found.clip.fadeIn, fadeOut: found.clip.fadeOut } : null;
    }
    if (selection.kind === "cue") {
      const cue = timeline.subtitles.find((item) => item.id === selection.id);
      return cue ? { ...selection, start: cue.start, end: cue.end } : null;
    }
    const audio = timeline.audio.find((item) => item.id === selection.id);
    return audio ? { ...selection, start: audio.start, end: audio.end, sourceDuration: audioDurations[audio.id] } : null;
  }

  function linkedSubtitleItems(items: TimelineDragItem[]): TimelineDragItem[] {
    if (!timeline) return [];
    const existing = new Set(items.filter((item) => item.kind === "cue").map((item) => item.id));
    return items.flatMap((item) => {
      if (item.kind !== "audio" || !item.linked) return [];
      const clip = timeline.audio.find((candidate) => candidate.id === item.id);
      if (!clip) return [];
      const cue = linkedSubtitleForAudio(timeline, clip);
      if (!cue) return [];
      if (existing.has(cue.id)) return [];
      existing.add(cue.id);
      return [{ kind: "cue" as const, id: cue.id, start: cue.start, end: cue.end, linked: true }];
    });
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, kind: TimelineDragKind, id: string, start: number, end: number, selection: TimelineSelection[] = selectedClips) {
    event.stopPropagation();
    setDragSnapFeedback(null);
    const clipKind = dragClipKind(kind);
    if (clipKind === "color") {
      const found = findColorClip(id);
      if (!found || found.layer.locked) return;
    } else if (clipKind === "animation") {
      if (findAnimationClip(id)?.layer.locked) return;
    } else if (clipKind === "layer") {
      if (timeline?.layers.find((layer) => layer.id === id)?.locked) return;
    }
    const captureTarget = event.currentTarget.closest(".timeline-track-rows") as HTMLElement | null;
    (captureTarget ?? event.currentTarget).setPointerCapture(event.pointerId);
    const selected = selection.some((item) => item.kind === clipKind && item.id === id) ? selection : [{ kind: clipKind, id }];
    const items = selected.map((item) => dragItem(item)).filter((item): item is TimelineDragItem => item !== null);
    if (!items.some((item) => item.kind === clipKind && item.id === id)) items.push({ kind: clipKind, id, start, end });
    if (kind === "audio") items.push(...linkedSubtitleItems(items.map((item) => item.kind === "audio" ? { ...item, linked: true } : item)));
    dragRef.current = { kind, id, x: event.clientX, start, end, items };
    onBeginEdit();
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeLabel = trackLabelResizeRef.current;
    if (resizeLabel?.pointerId === event.pointerId) {
      setTrackLabelWidth(Math.max(150, Math.min(360, resizeLabel.width + event.clientX - resizeLabel.x)));
      return;
    }
    const drag = dragRef.current;
    if (!drag || !timeline) return;
    const delta = (event.clientX - drag.x) / (TIMELINE_SCALE * zoom);
    const resize = drag.kind !== dragClipKind(drag.kind);
    const resizeKind = dragClipKind(drag.kind);
    const selectedCueIds = new Set(drag.items.filter((item) => item.kind === "cue" && !item.linked).map((item) => item.id));
    const selectedAnimationIds = new Set(drag.items.filter((item) => item.kind === "animation").map((item) => item.id));
    const selectedColorIds = new Set(drag.items.filter((item) => item.kind === "color").map((item) => item.id));
    const selectedAudioIds = new Set(drag.items.filter((item) => item.kind === "audio").map((item) => item.id));
    const animationTargets = timeline.layers.flatMap((layer) => layerAnimationClips(layer).filter((clip) => !selectedAnimationIds.has(clip.id)).flatMap((clip) => [clip.start, clip.end]));
    const colorTargets = timeline.colorLayers.flatMap((layer) => layer.clips.filter((clip) => !selectedColorIds.has(clip.id)).flatMap((clip) => [clip.start, clip.end]));
    const audioTargets = timeline.audio.filter((clip) => !selectedAudioIds.has(clip.id)).flatMap((clip) => [clip.start, clip.end]);
    const targets = [...markers, currentTime, ...animationTargets, ...colorTargets, ...audioTargets, ...timeline.subtitles.filter((cue) => !selectedCueIds.has(cue.id)).flatMap((cue) => [cue.start, cue.end])];
    const resizeAnchor = drag.kind.endsWith("-end") ? drag.end : drag.start;
    const snapResolution = resolveTimelineSnap(resizeAnchor + delta, event.altKey ? 0 : timeline.snap, event.altKey ? [] : targets);
    const snappedDelta = snapResolution.value - resizeAnchor;
    const moveItems = drag.items.filter((item) => !item.linked || !resize);
    const moveDelta = resize ? snappedDelta : Math.max(-Math.min(...moveItems.map((item) => item.start)), snappedDelta);
    setDragSnapFeedback(snapResolution.source ? { time: snapResolution.value, delta: resize ? snappedDelta : moveDelta, source: snapResolution.source } : null);

    updateTimeline((value) => {
      let layers = value.layers;
      let colorLayers = value.colorLayers;
      let subtitles = value.subtitles;
      let audio = value.audio;
      let sceneDuration = value.sceneDuration;
      for (const item of drag.items) {
        if (resize && (item.kind !== resizeKind || item.linked)) continue;
        if (!resize) {
          const start = Math.max(0, item.start + moveDelta);
          const length = item.kind === "audio" && item.sourceDuration !== undefined
            ? Math.min(item.end - item.start, Math.max(0.01, item.sourceDuration))
            : item.end - item.start;
          const end = Math.max(start + 0.01, start + length);
          if (item.kind === "layer") {
            layers = layers.map((layer) => layer.id === item.id ? { ...layer, start, end } : layer);
            if (value.sequenceId === "opening" && value.openingMode === "scene-first" && layers.find((layer) => layer.id === item.id)?.role === "character") sceneDuration = start;
          } else if (item.kind === "animation") {
            if (item.id !== drag.id) continue;
            const owner = layers.find((layer) => layerAnimationClips(layer, value).some((clip) => clip.id === item.id));
            if (!owner || owner.locked) continue;
            let clips = moveAnimationClipRipple(layerAnimationClips(owner, value), item.id, item.start + moveDelta, 0, targets);
            const selectedItems = drag.items.filter((candidate) => candidate.kind === "animation" && clips.some((clip) => clip.id === candidate.id));
            if (selectedItems.length > 1) clips = clips.map((clip) => {
              const selectedItem = selectedItems.find((candidate) => candidate.id === clip.id);
              if (!selectedItem) return clip;
              const nextStart = Math.max(0, selectedItem.start + moveDelta);
              return { ...clip, start: nextStart, end: nextStart + (selectedItem.end - selectedItem.start) };
            });
            layers = layers.map((layer) => layer.id === owner.id ? { ...layer, animationClips: clips } : layer);
          } else if (item.kind === "color") {
            if (item.id !== drag.id) continue;
            const colorSelection = drag.items.filter((candidate) => candidate.kind === "color");
            const owners = colorLayers.filter((layer) => !layer.locked && layer.clips.some((clip) => colorSelection.some((candidate) => candidate.id === clip.id)));
            const groups = owners.map((owner) => ({
              layer: owner,
              ids: colorSelection.filter((candidate) => owner.clips.some((clip) => clip.id === candidate.id)).map((candidate) => candidate.id),
            }));
            const movedGroups = moveColorClipGroups(groups.map(({ layer, ids }) => ({ clips: layer.clips, ids })), moveDelta);
            colorLayers = colorLayers.map((layer) => {
              const groupIndex = groups.findIndex((group) => group.layer.id === layer.id);
              return groupIndex < 0 ? layer : { ...layer, clips: movedGroups[groupIndex]! };
            });
          }
          else if (item.kind === "cue") subtitles = subtitles.map((cue) => cue.id === item.id ? { ...cue, start, end } : cue);
          else audio = audio.map((clip) => clip.id === item.id ? { ...clip, start, end } : clip);
        } else if (drag.kind === "color-fade-in" || drag.kind === "color-fade-out") {
          if (item.kind !== "color" || item.id !== drag.id) continue;
          const owner = colorLayers.find((layer) => layer.clips.some((clip) => clip.id === item.id));
          const clip = owner?.clips.find((candidate) => candidate.id === item.id);
          if (!owner || owner.locked || !clip) continue;
          const fadeBase = { ...clip, fadeIn: item.fadeIn ?? clip.fadeIn, fadeOut: item.fadeOut ?? clip.fadeOut };
          const adjusted = adjustColorClipFade(fadeBase, drag.kind === "color-fade-in" ? "in" : "out", snappedDelta);
          const clips = owner.clips.map((candidate) => candidate.id === item.id ? adjusted : candidate);
          colorLayers = colorLayers.map((layer) => layer.id === owner.id ? { ...layer, clips } : layer);
        } else if (drag.kind.endsWith("-start")) {
          const start = item.kind === "audio" && item.sourceDuration !== undefined
            ? clampAudioStart(item.end, item.start + moveDelta, item.sourceDuration)
            : Math.min(Math.max(0, item.start + moveDelta), item.end - 0.01);
          if (item.kind === "layer") {
            layers = layers.map((layer) => layer.id === item.id ? { ...layer, start } : layer);
            if (value.sequenceId === "opening" && value.openingMode === "scene-first" && layers.find((layer) => layer.id === item.id)?.role === "character") sceneDuration = start;
          } else if (item.kind === "animation") {
            const owner = layers.find((layer) => layerAnimationClips(layer, value).some((clip) => clip.id === item.id));
            if (!owner || owner.locked) continue;
            const clips = layerAnimationClips(owner, value).map((clip) => clip.id === item.id
              ? { ...clip, start, animationOffset: Math.max(0, clip.animationOffset + start - clip.start) }
              : clip);
            layers = layers.map((layer) => layer.id === owner.id ? { ...layer, animationClips: clips } : layer);
          } else if (item.kind === "color") {
            const owner = colorLayers.find((layer) => layer.clips.some((clip) => clip.id === item.id));
            if (!owner || owner.locked) continue;
            const clips = trimColorClipStart(owner.clips, item.id, start);
            colorLayers = colorLayers.map((layer) => layer.id === owner.id ? { ...layer, clips } : layer);
          } else if (item.kind === "cue") subtitles = subtitles.map((cue) => cue.id === item.id ? { ...cue, start } : cue);
          else audio = audio.map((clip) => clip.id === item.id ? { ...clip, start } : clip);
        } else {
          const requestedEnd = Math.max(item.start + 0.01, item.end + moveDelta);
          const end = item.kind === "audio" && item.sourceDuration !== undefined
            ? clampAudioEnd(item.start, requestedEnd, item.sourceDuration)
            : requestedEnd;
          if (item.kind === "layer") layers = layers.map((layer) => layer.id === item.id ? { ...layer, endMode: "manual", end } : layer);
          else if (item.kind === "animation") {
            const owner = layers.find((layer) => layerAnimationClips(layer, value).some((clip) => clip.id === item.id));
            if (!owner || owner.locked) continue;
            const clips = layerAnimationClips(owner, value).map((clip) => clip.id === item.id ? { ...clip, endMode: "manual" as const, end } : clip);
            layers = layers.map((layer) => layer.id === owner.id ? { ...layer, animationClips: clips } : layer);
          } else if (item.kind === "color") {
            const owner = colorLayers.find((layer) => layer.clips.some((clip) => clip.id === item.id));
            if (!owner || owner.locked) continue;
            const clips = trimColorClipEnd(owner.clips, item.id, end);
            colorLayers = colorLayers.map((layer) => layer.id === owner.id ? { ...layer, clips } : layer);
          }
          else if (item.kind === "cue") subtitles = subtitles.map((cue) => cue.id === item.id ? { ...cue, end } : cue);
          else audio = audio.map((clip) => clip.id === item.id ? { ...clip, autoEnd: false, end } : clip);
        }
      }
      return extendTimelineDuration({ ...value, layers, colorLayers, subtitles, audio, sceneDuration, duration: Math.max(value.duration, ...layers.map((layer) => layer.end)) });
    }, false);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (trackLabelResizeRef.current?.pointerId === event.pointerId) {
      trackLabelResizeRef.current = null;
      setDragSnapFeedback(null);
      return;
    }
    if (dragRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragSnapFeedback(null);
  }

  function beginResizeTrackLabel(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    trackLabelResizeRef.current = { pointerId: event.pointerId, x: event.clientX, width: trackLabelWidth };
  }

  function resizeTrackLabelBy(delta: number) {
    setTrackLabelWidth((value) => Math.max(150, Math.min(360, value + delta)));
  }

  function seekFromEvent(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".timeline-cue, .timeline-layer-clip, .timeline-color-clip, .timeline-audio-clip")) return;
    if (event.button !== 0) return;
    event.preventDefault();
    setInspector("sequence");
    setPreviewUntil(null);
    setSelectedClips([]);
    setSelectedAudioId(null);
    updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null }), false);
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = event.pointerId;
    const rect = event.currentTarget.getBoundingClientRect();
    const value = (event.clientX - rect.left) / (TIMELINE_SCALE * zoom);
    setCurrentTime(snapTime(value, timeline?.snap ?? 0.1, duration));
    setPlaying(false);
  }

  function scrubMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (scrubRef.current !== event.pointerId) return;
    setPreviewUntil(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setCurrentTime(Math.max(0, Math.min(duration, (event.clientX - rect.left) / (TIMELINE_SCALE * zoom))));
  }

  function endScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (scrubRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    scrubRef.current = null;
  }

  function scrollTimeline(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const scroller = event.currentTarget;
      const rect = scroller.getBoundingClientRect();
      if (!rect.width) return;
      const next = zoomTimelineAtCursor(zoom, scroller.scrollLeft, event.clientX - rect.left, event.deltaY, event.deltaMode, scroller.clientHeight);
      if (next.zoom === zoom) return;
      scroller.scrollLeft = next.scrollLeft;
      setZoom(next.zoom);
      return;
    }
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    event.currentTarget.scrollLeft += delta;
    event.preventDefault();
  }

  function beginStagePan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".timeline-stage-controls"))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stagePanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setStagePanning(true);
  }

  function moveStagePan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = stagePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    if (deltaX === 0 && deltaY === 0) return;
    stagePanRef.current = { pointerId: pan.pointerId, x: event.clientX, y: event.clientY };
    setStageView((value) => panStageView(value, deltaX, deltaY));
  }

  function endStagePan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = stagePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    stagePanRef.current = null;
    setStagePanning(false);
  }

  function zoomStageAtCursor(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(".timeline-stage-controls")) return;
    const stage = event.currentTarget;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * rect.height : event.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    setStageView((value) => zoomStageView(value, value.scale * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: rect.width, height: rect.height }));
    event.preventDefault();
  }

  function zoomStageBy(factor: number) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setStageView((value) => zoomStageView(value, value.scale * factor, { x: rect.width / 2, y: rect.height / 2 }, { width: rect.width, height: rect.height }));
  }

  function resetStagePan() {
    setStageView((value) => ({ ...value, x: 0, y: 0 }));
  }

  function fitStage() {
    setStageView(resetStageView());
  }

  function duplicateCue() {
    if (!selectedCue) return;
    const length = selectedCue.end - selectedCue.start;
    const start = selectedCue.end;
    const cue = { ...selectedCue, id: crypto.randomUUID(), start, end: start + length, text: { ...selectedCue.text } };
    updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: [...value.subtitles, cue], selectedCueId: cue.id }));
    setSelectedClips([{ kind: "cue", id: cue.id }]);
    setInspector("cue");
  }

  function fitTimeline() { setZoom(Math.max(0.1, ((scrollRef.current?.clientWidth ?? 900) - trackLabelWidth - 8) / (duration * TIMELINE_SCALE))); }

  useEffect(() => {
    const frame = requestAnimationFrame(fitTimeline);
    return () => cancelAnimationFrame(frame);
  }, [directory, timeline?.sequenceId]);

  useEffect(() => {
    stagePanRef.current = null;
    setStagePanning(false);
    setStageView(resetStageView());
    setSelectedClips([]);
  }, [directory, timeline?.sequenceId]);

  timelineKeydownRef.current = (event: KeyboardEvent) => {
    if (isTextEditingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(key)) return;
    if ((event.ctrlKey || event.metaKey) && key === "s") { event.preventDefault(); void onSave(); }
    else if (key === " ") { event.preventDefault(); setPlaying((value) => !value); }
    else if (key === "arrowleft" || key === "arrowright") { event.preventDefault(); setPlaying(false); setCurrentTime((value) => Math.max(0, Math.min(duration, value + (key === "arrowright" ? 1 : -1) * (event.shiftKey ? 10 : 1) / 60))); }
    else if (key === "home" || key === "end") { event.preventDefault(); setPlaying(false); setCurrentTime(key === "home" ? 0 : duration); }
    else if (key === "delete" || key === "backspace") { event.preventDefault(); if (selectedClips.length > 0) deleteSelectedClips(); else if (inspector === "cue") deleteCue(); else if (inspector === "audio") deleteAudio(); }
    else if ((event.ctrlKey || event.metaKey) && key === "d") { event.preventDefault(); if (selectedColorClip) duplicateSelectedColorClip(); else if (selectedAnimationClip) duplicateSelectedAnimationClip(); else duplicateCue(); }
    else if (key === "s" && selectedCue) updateTimeline((value) => splitCue(value, selectedCue.id, currentTime));
    else if (key === "f") fitTimeline();
    else if (key === "escape") { setPlaying(false); clearTimelineSelection(); }
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => timelineKeydownRef.current(event);
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  if (!project || !timeline) return <div className="timeline-empty"><strong>Open a Spine asset folder first</strong><span>The timeline uses the selected character set plus matching <code>_bg</code> and <code>_scene</code> directories.</span></div>;

  const availableLayerDirectories = directories.filter((item) => !timeline.layers.some((layer) => layer.directory === item));
  const activeSubtitleTexts = timelineActiveSubtitleTexts(timeline, currentTime);
  const selectedClipDetails: SelectedClipDetail[] = [];
  for (const selection of selectedClips) {
    if (selection.kind === "layer") {
      const layer = timeline.layers.find((item) => item.id === selection.id);
      if (layer) selectedClipDetails.push({ ...selection, label: layer.name, start: layer.start, end: layerEnd(layer), enabled: layer.enabled, removable: layer.role !== "character" && !layer.locked });
    } else if (selection.kind === "color-layer") {
      const layer = timeline.colorLayers.find((item) => item.id === selection.id);
      if (layer) selectedClipDetails.push({ ...selection, label: layer.name, start: 0, end: duration, enabled: layer.enabled, removable: !layer.locked });
    } else if (selection.kind === "animation") {
      const found = findAnimationClip(selection.id);
      if (found) selectedClipDetails.push({ ...selection, label: found.clip.animation || "Animation", start: found.clip.start, end: animationClipEnd(found.clip, animationDurations[`${found.layer.id}:${found.clip.animation}`] ?? 0), enabled: found.clip.enabled !== false, removable: !found.layer.locked });
    } else if (selection.kind === "color") {
      const found = findColorClip(selection.id);
      if (found) selectedClipDetails.push({ ...selection, label: found.clip.name, start: found.clip.start, end: found.clip.end, enabled: found.clip.enabled, removable: !found.layer.locked });
    } else if (selection.kind === "cue") {
      const cue = timeline.subtitles.find((item) => item.id === selection.id);
      if (cue) selectedClipDetails.push({ ...selection, label: cueText(cue, timeline.language) || "Subtitle cue", start: cue.start, end: cue.end, enabled: cue.enabled, removable: true });
    } else {
      const clip = timeline.audio.find((item) => item.id === selection.id);
      if (clip) selectedClipDetails.push({ ...selection, label: clip.name, start: clip.start, end: clip.end, enabled: clip.enabled, removable: true });
    }
  }
  const selectedTypeSummary = ([
    ["layer", selectedClipDetails.filter((item) => item.kind === "layer").length, "layer"],
    ["color-layer", selectedClipDetails.filter((item) => item.kind === "color-layer").length, "color layer"],
    ["animation", selectedClipDetails.filter((item) => item.kind === "animation").length, "animation"],
    ["color", selectedClipDetails.filter((item) => item.kind === "color").length, "color clip"],
    ["cue", selectedClipDetails.filter((item) => item.kind === "cue").length, "subtitle"],
    ["audio", selectedClipDetails.filter((item) => item.kind === "audio").length, "audio"],
  ] as const).filter(([, count]) => count > 0).map(([, count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(" · ");
  const deletableSelectionCount = selectedClipDetails.filter((item) => item.removable).length;
  function reviewTimelineDiagnostic(diagnostic: TimelineDiagnostic) {
    const target = diagnostic.target;
    if (!target) return;
    let targetTime: number | null = null;
    if (target.kind === "layer") targetTime = timeline?.layers.find((item) => item.id === target.id)?.start ?? null;
    else if (target.kind === "animation") targetTime = findAnimationClip(target.id)?.clip.start ?? null;
    else if (target.kind === "color-layer") targetTime = 0;
    else if (target.kind === "color") targetTime = findColorClip(target.id)?.clip.start ?? null;
    else if (target.kind === "cue") targetTime = timeline?.subtitles.find((item) => item.id === target.id)?.start ?? null;
    else targetTime = timeline?.audio.find((item) => item.id === target.id)?.start ?? null;
    setPlaying(false);
    setSelectedClips([target]);
    focusTimelineClip(target);
    if (targetTime !== null && Number.isFinite(targetTime)) setCurrentTime(Math.min(duration, Math.max(0, targetTime)));
  }
  const selectedAudioDuration = selectedAudio ? audioDurations[selectedAudio.id] : undefined;
  const selectedAudioLinkedSubtitle = selectedAudio && timeline ? linkedSubtitleForAudio(timeline, selectedAudio) : null;
  const selectedAudioLinkCandidate = selectedAudioLinkedSubtitle ?? (selectedAudio && timeline
    ? [...timeline.subtitles].sort((a, b) => Math.abs(a.start - selectedAudio.start) - Math.abs(b.start - selectedAudio.start))[0] ?? null
    : null);
  const selectedAudioMaximumEnd = selectedAudio && selectedAudioDuration !== undefined
    ? clampAudioEnd(selectedAudio.start, Number.POSITIVE_INFINITY, selectedAudioDuration)
    : undefined;
  const selectedAudioMinimumStart = selectedAudio && selectedAudioDuration !== undefined
    ? clampAudioStart(selectedAudio.end, Number.NEGATIVE_INFINITY, selectedAudioDuration)
    : 0;

  return <>
    <div className="timeline-workspace" style={{ gridTemplateColumns: `${sequencePanelCollapsed ? "" : `${sequencePanelWidth}px 7px `}minmax(0, 1fr)${inspectorPanelCollapsed ? "" : ` 7px ${inspectorPanelWidth}px`}` }}>
      <aside id="timeline-sequence-browser" className="editor-panel sequence-browser" hidden={sequencePanelCollapsed}>
        <div className="editor-section">
          <div className="editor-section-title"><strong>Sequences</strong><span>{sequenceIds.length}</span></div>
          <div className="timeline-talk-playlist-actions">
            {talkAutoplayActive
              ? <button className="editor-preview-button danger" type="button" onClick={stopTalkAutoplay}>Stop Talk autoplay</button>
              : <button className="editor-button" type="button" disabled={!talkSequenceIds.length} onClick={startTalkAutoplay}><IconPlay /> Play Talk list</button>}
          </div>
          <div className="sequence-list">
            {sequenceIds.map((id) => <button key={id} className={`sequence-button${timeline.sequenceId === id ? " active" : ""}`} onClick={() => chooseSequence(id)}><strong>{id === "opening" ? "Opening" : `Talk ${id.replace("talk-", "").padStart(2, "0")}`}</strong></button>)}
            {(!timeline.sequenceId || timeline.sequenceId === "legacy") && <button className="sequence-button active"><strong>Recovered composition</strong></button>}
          </div>
        </div>
      </aside>
      {!sequencePanelCollapsed && <TimelinePanelResizer side="sequences" value={sequencePanelWidth} onChange={(sequencePanelWidth) => updateTimelineLayout({ sequencePanelWidth })} />}
       <section className="timeline-main">
           <div className="sequence-heading">
              <div><strong>{timeline.sequenceId === "opening" ? "Opening / Intro" : timeline.sequenceId?.startsWith("talk-") ? `Talk ${timeline.sequenceId.replace("talk-", "")}` : "Recovered composition"}</strong><small>{timeline.sequenceId === "opening" ? "Layered Spine and color composition." : "Synchronized Spine composition"}</small></div>
              <div className="sequence-heading-actions">
                <button type="button" className="editor-button timeline-panel-toggle" aria-controls="timeline-sequence-browser" aria-expanded={!sequencePanelCollapsed} onClick={() => updateTimelineLayout({ sequencePanelCollapsed: !sequencePanelCollapsed })}>{sequencePanelCollapsed ? "Show sequences" : "Hide sequences"}</button>
                {(timeline.sequenceId === "opening" || isTalkSequence) && <span className="opening-duration-badge">{timeline.durationMode === "auto" ? "AUTO" : "MANUAL"} · {seconds(duration)}</span>}
                 {timeline.sequenceId === "opening" && <><button className="editor-button" type="button" onClick={() => addColorLayer()}><IconPlus /> Color layer</button><button className="editor-button" type="button" onClick={() => setLayerPickerOpen(true)} disabled={!availableLayerDirectories.length}><IconPlus /> Spine layer</button></>}
                <button type="button" className="editor-button timeline-panel-toggle" aria-controls="timeline-inspector" aria-expanded={!inspectorPanelCollapsed} onClick={() => updateTimelineLayout({ inspectorPanelCollapsed: !inspectorPanelCollapsed })}>{inspectorPanelCollapsed ? "Show inspector" : "Hide inspector"}</button>
              </div>
           </div>
          <div className="timeline-stage-wrap" ref={stageWrapRef} style={{ flex: `${previewShare} 1 0` }}>
           <div
             ref={stageRef}
             className={`timeline-stage${stagePanning ? " is-panning" : ""}`}
             role="application"
             aria-label="Timeline preview canvas. Drag to pan and use the mouse wheel to zoom."
             onPointerDown={beginStagePan}
             onPointerMove={moveStagePan}
             onPointerUp={endStagePan}
             onPointerCancel={endStagePan}
             onWheel={zoomStageAtCursor}
             >
                <div className="timeline-stage-content" style={{ transform: `translate3d(${stageView.x}px, ${stageView.y}px, 0) scale(${stageView.scale})` }}>
                  <div className="timeline-visual-composition">
                      {displayVisualTracks.map((track) => track.kind === "spine"
                        ? <SpineTimelineLayerCanvas key={`spine-${track.layer.id}`} layer={track.layer} files={files[track.layer.directory] ?? null} currentTime={currentTime} mainAnimation={mainAnimation} mainAnimationTime={mainAnimationTime} mainAnimationLoop={mainAnimationLoop} sequenceId={timeline.sequenceId} openingMode={timeline.openingMode} talkMixDuration={talkMixDuration} talkBlendOutStart={talkBlendOutStart} characterHidden={characterHidden} preserveDrawingBuffer onMarkers={(next) => setMarkers((old) => old.join() === next.join() ? old : next)} sharedCameraPose={sharedCameraPose} referenceCamera={track.layer.id === referenceLayerId} onMeta={(id, meta) => setMetas((value) => ({ ...value, [id]: meta }))} onCameraPose={setSharedCameraPose} onAnimationDuration={onAnimationDuration} onRenderer={(id, renderer) => { if (renderer) spineRenderersRef.current.set(id, renderer); else spineRenderersRef.current.delete(id); }} onError={onError} />
                        : <TimelineColorLayerPreview key={`color-${track.layer.id}`} layer={track.layer} time={currentTime} />)}
                    {!displayVisualTracks.length && <div className="timeline-empty"><strong>No layers</strong><span>Add a Spine or Color layer from the Add menu.</span></div>}
                  </div>
                  {timeline.audio.map((clip) => <audio key={clip.id} ref={(element) => { audioElementsRef.current[clip.id] = element; }} src={audioUrls[clip.id]} preload="auto" onLoadedMetadata={(event) => applyDecodedAudioDuration(clip.id, event.currentTarget.duration)} onCanPlay={() => setAudioPreloadState(clip.id, "ready")} onError={() => { setMissingAudio((value) => value.includes(clip.path) ? value : [...value, clip.path]); setAudioPreloadState(clip.id, "missing"); }} />)}
                </div>
               {activeSubtitleTexts.length > 0 && <div className="timeline-subtitle-preview" aria-live="polite">
                 {activeSubtitleTexts.map((text, index) => <div key={`${index}-${text}`}>{text}</div>)}
               </div>}
               <div className="timeline-stage-controls" aria-label="Preview canvas controls" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" className="editor-icon-button" aria-label="Zoom out preview" title="Zoom out" onClick={() => zoomStageBy(0.8)}><IconMinus /></button>
               <output className="timeline-stage-scale" aria-label="Preview zoom">{Math.round(stageView.scale * 100)}%</output>
                <button type="button" className="editor-icon-button" aria-label="Zoom in preview" title="Zoom in" onClick={() => zoomStageBy(1.25)}><IconPlus /></button>
               <button type="button" className="editor-button" onClick={resetStagePan} title="Center the preview without changing zoom">Reset pan</button>
                <button type="button" className="editor-button" onClick={fitStage} title="Reset preview zoom and center the stage">Fit preview</button>
             </div>
             <span className="timeline-stage-hint" aria-live="polite">{stagePanning ? "Release to stop panning" : "Drag to pan · Wheel to zoom"}</span>
            </div>
         </div>

          <div className="timeline-transport">
              <button className="editor-icon-button" aria-label={playing ? "Pause sequence" : "Play sequence"} onClick={() => { setPreviewUntil(null); setPlaying((value) => !value); }}>{playing ? <IconPause /> : <IconPlay />}</button>
              <button className="editor-button" onClick={() => { setPreviewUntil(null); setCurrentTime(0); setPlaying(false); }}><IconSkipBack /> Start</button>
              {isTalkSequence && <>
                <button className="editor-button" onClick={replayTalkSequence} title="Restart this Talk from the beginning"><IconSkipBack /> Replay Talk</button>
                <button className="editor-preview-button danger" onClick={stopTalkAutoplay} title="Stop playback and cancel Talk autoplay">Stop</button>
              </>}
              {timeline.sequenceId === "opening" && <><button className="editor-button" onClick={() => stepSelectedTrackClip(-1)} disabled={selectedColorLayer ? !selectedColorLayer.clips.some((clip) => clip.enabled) : !selectedTrackAnimationClips()?.clips.length}><IconChevronLeft /> Track clip</button><button className="editor-button" onClick={() => stepSelectedTrackClip(1)} disabled={selectedColorLayer ? !selectedColorLayer.clips.some((clip) => clip.enabled) : !selectedTrackAnimationClips()?.clips.length}>Track clip <IconChevronRight /></button></>}
            <button className="editor-button" onClick={() => { setPreviewUntil(null); setCurrentTime(duration); setPlaying(false); }}>End <IconSkipForward /></button>
            <NumberField label="Speed" value={speed} min={0.1} max={3} step={0.1} precision={1} unit="×" scrub={false} compact onCommit={setSpeed} />
            <NumberField label="Playhead" value={Number(currentTime.toFixed(3))} min={0} max={duration} step={0.001} precision={3} unit="s" scrub={false} compact onCommit={(time) => { setPlaying(false); setPreviewUntil(null); setCurrentTime(Math.min(duration, Math.max(0, time))); }} />
            <label className="timeline-loop"><input type="checkbox" checked={timeline.loop} onChange={(event) => updateTimeline((value) => ({ ...value, loop: event.target.checked }))} /> Loop</label>
           <span className="editor-time">/ {seconds(duration)}</span>
         </div>

         <TimelineSplitHandle
           value={previewShare}
           onChange={(previewShare) => updateTimelineLayout({ previewShare })}
           getFlexibleHeight={() => (stageWrapRef.current?.getBoundingClientRect().height ?? 0) + (scrollRef.current?.getBoundingClientRect().height ?? 0)}
         />

          <div className="timeline-editor-scroll" ref={scrollRef} style={{ flex: `${100 - previewShare} 1 0` }} onWheel={scrollTimeline} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <div className="timeline-ruler-row" style={{ minWidth: trackWidth + trackLabelWidth, gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }}>
          <div className="timeline-track-label timeline-ruler-label">LAYERS<button type="button" className="timeline-track-resize" aria-label={`Resize layer column, ${trackLabelWidth} pixels`} title="Drag to resize; use left and right arrow keys" onPointerDown={beginResizeTrackLabel} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeTrackLabelBy(event.key === "ArrowRight" ? 8 : -8); } }} /></div>
           <div className="timeline-track timeline-ruler" style={{ width: trackWidth }} onPointerDown={seekFromEvent} onPointerMove={scrubMove} onPointerUp={endScrub} onPointerCancel={endScrub}>
            {Array.from({ length: Math.ceil(duration) + 1 }, (_, index) => <span key={index} style={{ left: index * TIMELINE_SCALE * zoom }}>{index}s</span>)}
            <i className="timeline-playhead" style={{ left: currentTime * TIMELINE_SCALE * zoom }} />
            {markers.map((time, index) => <i key={index} title={`Spine event ${time.toFixed(3)}s`} className="sequence-marker" style={{ left: time * TIMELINE_SCALE * zoom }} />)}
          </div>
        </div>
            <div className="timeline-track-rows" style={{ minWidth: trackWidth + trackLabelWidth }}>
                  {displayVisualTracks.map((track, trackIndex) => {
                    const key = visualTrackKey(track);
                    const selection: TimelineSelection = track.kind === "spine" ? { kind: "layer", id: track.layer.id } : { kind: "color-layer", id: track.layer.id };
                    const isSelected = track.kind === "spine"
                      ? selectedClips.some((item) => item.kind === "layer" && item.id === track.layer.id) || track.layer.id === timeline.selectedLayerId
                      : selectedClips.some((item) => (item.kind === "color-layer" || item.kind === "color") && (item.kind === "color-layer" ? item.id === track.layer.id : track.layer.clips.some((clip) => clip.id === item.id)));
                    const visibility = track.kind === "spine" ? track.layer.enabled : track.layer.enabled;
                    const locked = track.layer.locked === true;
                    const trackName = track.layer.name;
                    return <div key={key} style={{ gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }} className={`timeline-row visual-track-row${track.kind === "color" ? " is-color-track" : " is-spine-track"}${visibility ? "" : " is-hidden-track"}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/plain") || trackDragRef.current; if (source) reorderVisualTrack(source, key); trackDragRef.current = null; }}>
                      <div className={`timeline-track-label visual-track-label${isSelected ? " is-selected" : ""}`} title={trackName}>
                        <button type="button" className="timeline-track-reorder" draggable={!locked} aria-disabled={locked} aria-label={`Reorder ${trackName}`} title={locked ? "Unlock this layer before reordering" : "Drag to reorder; use arrow keys while focused"} onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => { if (locked) { event.preventDefault(); return; } trackDragRef.current = key; event.dataTransfer.setData("text/plain", key); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { trackDragRef.current = null; }} onKeyDown={(event) => { if (locked || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return; event.preventDefault(); const target = displayVisualTracks[trackIndex + (event.key === "ArrowUp" ? -1 : 1)]; if (target) reorderVisualTrack(key, visualTrackKey(target)); }}><span aria-hidden="true">⠿</span></button>
                        <span className={`timeline-track-type ${track.kind}`}>{track.kind === "spine" ? roleLabel(track.layer.role) : "COLOR"}</span>
                        <button type="button" className="timeline-track-name" onClick={() => { setSelectedClips([selection]); focusTimelineClip(selection); }}>{trackName}</button>
                        <button type="button" className="timeline-track-icon" aria-label={`${visibility ? "Hide" : "Show"} ${trackName}`} title={visibility ? "Hide layer" : "Show layer"} onClick={() => track.kind === "spine" ? updateLayer(track.layer.id, { enabled: !visibility }) : updateColorLayer(track.layer.id, { enabled: !visibility })}>{visibility ? <IconEye /> : <IconEyeOff />}</button>
                        <button type="button" className={`timeline-track-icon${locked ? " is-locked" : ""}`} aria-label={`${locked ? "Unlock" : "Lock"} ${trackName}`} title={locked ? "Unlock layer" : "Lock layer"} onClick={() => track.kind === "spine" ? updateLayer(track.layer.id, { locked: !locked }) : updateColorLayer(track.layer.id, { locked: !locked })}>{locked ? <IconLock /> : <IconUnlock />}</button>
                        <button type="button" className="timeline-track-resize" aria-label={`Resize layer column, ${trackLabelWidth} pixels`} title="Drag to resize; use left and right arrow keys" onPointerDown={beginResizeTrackLabel} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeTrackLabelBy(event.key === "ArrowRight" ? 8 : -8); } }} />
                      </div>
                      <div className={`timeline-track ${track.kind === "spine" ? "timeline-layer-track" : "timeline-color-track"}${isSelected ? " is-selected" : ""}`} onPointerDown={seekFromEvent}>
                        {track.kind === "spine" ? layerAnimationClips(track.layer).map((clip) => {
                          const end = animationClipEnd(clip, animationDurations[`${track.layer.id}:${clip.animation}`] ?? 0);
                          const selected = isClipSelected("animation", clip.id);
                          return <div key={clip.id} className={`timeline-layer-clip timeline-animation-clip${selected ? " is-selected" : ""}${clip.enabled === false ? " is-disabled" : ""}${clip.continueAfterOpening ? " is-continuing" : ""}`} title={`${clip.animation || "Animation"} · drag to move; drag an edge to trim${clip.continueAfterOpening ? " · continues after opening" : ""}`} style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(8, (end - clip.start) * TIMELINE_SCALE * zoom), zIndex: track.layer.order }} onPointerDown={(event) => { const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation", clip.id, clip.start, end, picked); }}>
                            <button type="button" className="timeline-clip-start-handle" aria-label={`Trim ${clip.animation} start`} title="Drag to trim the start" onPointerDown={(event) => { event.stopPropagation(); const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation-start", clip.id, clip.start, end, picked); }} />
                            <button type="button" className="timeline-clip-end-handle" aria-label={`Trim ${clip.animation} end`} title="Drag to trim the end" onPointerDown={(event) => { event.stopPropagation(); const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation-end", clip.id, clip.start, end, picked); }} />
                            <span className="timeline-layer-name">{track.layer.followMainAnimation ? `Follow · ${clip.animation || "main"}` : clip.animation || "Animation"}</span>
                          </div>;
                        }) : track.layer.clips.map((clip) => {
                          const duration = Math.max(0.01, clip.end - clip.start);
                          const fadeInPercent = Math.min(100, clip.fadeIn / duration * 100);
                          const fadeOutPercent = Math.min(100, clip.fadeOut / duration * 100);
                          const picked = { kind: "color" as const, id: clip.id };
                          return <div key={clip.id} className={`timeline-color-clip${isClipSelected("color", clip.id) ? " is-selected" : ""}${clip.enabled ? "" : " is-disabled"}`} title={`${clip.name} · drag to move; drag an edge to trim`} style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(12, duration * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color", clip.id, clip.start, clip.end, chosen); }}>
                            <button type="button" className="timeline-clip-start-handle" aria-label={`Trim ${clip.name} start`} onPointerDown={(event) => { event.stopPropagation(); const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color-start", clip.id, clip.start, clip.end, chosen); }} />
                            {clip.fadeIn > 0 && clip.fadeIn < duration && <button type="button" className="timeline-color-fade-handle" style={{ left: `${fadeInPercent}%` }} aria-label={`Adjust ${clip.name} fade in`} title="Drag to adjust fade-in duration" onPointerDown={(event) => { event.stopPropagation(); const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color-fade-in", clip.id, clip.start + clip.fadeIn, clip.end, [picked]); }} />}
                            <i className="timeline-color-clip-envelope" style={{ background: `linear-gradient(90deg, transparent 0%, ${clip.color} ${fadeInPercent}%, ${clip.color} ${100 - fadeOutPercent}%, transparent 100%)` }} />
                            <span>{clip.name}</span>
                            {clip.fadeOut > 0 && clip.fadeOut < duration && <button type="button" className="timeline-color-fade-handle is-fade-out" style={{ left: `${100 - fadeOutPercent}%` }} aria-label={`Adjust ${clip.name} fade out`} title="Drag to adjust fade-out duration" onPointerDown={(event) => { event.stopPropagation(); const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color-fade-out", clip.id, clip.end - clip.fadeOut, clip.end, [picked]); }} />}
                            <button type="button" className="timeline-clip-end-handle" aria-label={`Trim ${clip.name} end`} onPointerDown={(event) => { event.stopPropagation(); const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color-end", clip.id, clip.start, clip.end, chosen); }} />
                          </div>;
                        })}
                        <i className="timeline-playhead" style={{ left: currentTime * TIMELINE_SCALE * zoom }} />
                      </div>
                    </div>;
                  })}
            <div className="timeline-row subtitle-row" style={{ gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }}>
              <div className="timeline-track-label"><b>SUBS</b><span>{timeline.language.toUpperCase()}</span></div>
              <div className="timeline-track timeline-subtitle-track" onPointerDown={seekFromEvent}>
                 {timeline.subtitles.map((cue) => <div key={cue.id} className={`timeline-cue${isClipSelected("cue", cue.id) || cue.id === timeline.selectedCueId ? " is-selected" : ""}${cue.enabled ? "" : " is-disabled"}`} style={{ left: cue.start * TIMELINE_SCALE * zoom, width: Math.max(12, (cue.end - cue.start) * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const selection = selectTimelineClip({ kind: "cue", id: cue.id }, event); if (selection) beginDrag(event, "cue", cue.id, cue.start, cue.end, selection); }}>
                   <button className="timeline-cue-handle left" aria-label="Move subtitle start" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "cue", id: cue.id }, event); if (selection) beginDrag(event, "cue-start", cue.id, cue.start, cue.end, selection); }} />
                   <span>{cueText(cue, timeline.language)}</span>
                   <button className="timeline-cue-handle right" aria-label="Move subtitle end" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "cue", id: cue.id }, event); if (selection) beginDrag(event, "cue-end", cue.id, cue.start, cue.end, selection); }} />
                </div>)}
                <i className="timeline-playhead" style={{ left: currentTime * TIMELINE_SCALE * zoom }} />
              </div>
            </div>
             <div className="timeline-row audio-row" style={{ gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }}>
              <div className="timeline-track-label"><b>AUDIO</b><span>{timeline.audio.length} clip{timeline.audio.length === 1 ? "" : "s"}</span></div>
              <div className="timeline-track timeline-audio-track" onPointerDown={seekFromEvent}>
                   {timeline.audio.map((clip) => <div key={clip.id} className={`timeline-audio-clip${isClipSelected("audio", clip.id) || clip.id === selectedAudio?.id ? " is-selected" : ""}${clip.enabled ? "" : " is-disabled"}`} title="Drag to move the audio; drag an edge to change its timing. Shift/Ctrl-click to select multiple." style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(12, (clip.end - clip.start) * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio", clip.id, clip.start, clip.end, selection); }}><button type="button" className="timeline-clip-start-handle" aria-label={`Move ${clip.name} start`} title="Drag to change start time" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio-start", clip.id, clip.start, clip.end, selection); }} /><button type="button" className="timeline-clip-end-handle" aria-label={`Move ${clip.name} end`} title="Drag to change end time" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio-end", clip.id, clip.start, clip.end, selection); }} /><AudioWaveform url={audioUrls[clip.id]} onDuration={(value) => applyDecodedAudioDuration(clip.id, value)} /><span><IconSound /> {clip.name}</span></div>)}
                <i className="timeline-playhead" style={{ left: currentTime * TIMELINE_SCALE * zoom }} />
               </div>
             </div>
             {dragSnapFeedback && <div className={`timeline-snap-feedback is-${dragSnapFeedback.source}`} aria-hidden="true" style={{ left: trackLabelWidth + dragSnapFeedback.time * TIMELINE_SCALE * zoom }}>
               <span>{dragSnapFeedback.source === "target" ? "SNAP" : "GRID"} {seconds(dragSnapFeedback.time)} · Δ {dragSnapFeedback.delta < 0 ? "−" : "+"}{Math.abs(dragSnapFeedback.delta).toFixed(3)}s</span>
             </div>}
           </div>
         </div>
         <div className="timeline-bottom-tools">
           <label>Snap <select value={timeline.snap} onChange={(event) => updateTimeline((value) => ({ ...value, snap: Number(event.target.value) }))}><option value="0">Off</option><option value="0.01">10 ms</option><option value="0.1">100 ms</option><option value="0.25">250 ms</option><option value="0.5">500 ms</option></select></label>
             <BoundedSliderField label="Timeline scale" value={zoom} defaultValue={1} min={0.1} max={3} step={0.1} precision={2} unit="×" compact onCommit={setZoom} />
             <button className="editor-button" onClick={fitTimeline} title="Fit the full sequence in the timeline (F)"><IconExpand /> Fit timeline (F)</button>
             <details ref={addMenuRef} className="timeline-add-menu">
               <summary className="editor-button"><IconPlus /> Add <IconChevronDown /></summary>
               <div className="timeline-add-menu-popover">
                  <button className="editor-button" onClick={() => { closeAddMenu(); addAnimationClip(); }} disabled={!metas[selectedLayer?.id ?? characterLayer?.id ?? ""]}>Animation clip</button>
                  <button className="editor-button" onClick={() => { closeAddMenu(); addColorLayer(); }}>Color layer</button>
                  <button className="editor-button" onClick={() => { closeAddMenu(); addColorClip("solid"); }}>Color clip</button>
                  <button className="editor-button" onClick={() => { closeAddMenu(); addColorClip("fade-from-black"); }}>Fade from black</button>
                  <button className="editor-button" onClick={() => { closeAddMenu(); addColorClip("fade-to-black"); }}>Fade to black</button>
                  <button className="editor-button" onClick={() => { closeAddMenu(); addColorClip("white-flash"); }}>White flash</button>
                 <button className="editor-button" onClick={() => { closeAddMenu(); addCue(); }}>Subtitle cue</button>
                <button className="editor-button" onClick={() => { closeAddMenu(); void importAudio(); }}>Audio files</button>
                <button className="editor-button" onClick={() => { closeAddMenu(); void importSubtitles(); }}>Import subtitles</button>
                <button className="editor-button" onClick={() => { closeAddMenu(); setLayerPickerOpen(true); }} disabled={!availableLayerDirectories.length}>Choose Spine layer…</button>
              </div>
            </details>
          </div>
       </section>

      {!inspectorPanelCollapsed && <TimelinePanelResizer side="inspector" value={inspectorPanelWidth} onChange={(inspectorPanelWidth) => updateTimelineLayout({ inspectorPanelWidth })} />}
       <aside id="timeline-inspector" className="editor-panel timeline-inspector" hidden={inspectorPanelCollapsed}>
          <details className={`editor-section editor-validation timeline-diagnostics${timelineDiagnostics.length ? " has-warnings" : ""}`}>
            <summary>{timelineChecksPending ? "Checking timeline assets…" : timelineDiagnostics.length ? `${timelineDiagnostics.length} timeline checks to review` : "No current timeline warnings"}</summary>
            <div className="editor-section-title"><strong>Timeline diagnostics</strong><span>{timelineDiagnostics.length ? `${timelineDiagnostics.length} warning${timelineDiagnostics.length === 1 ? "" : "s"}` : "Ready"}</span></div>
            {timelineChecksPending && <p className="editor-muted" role="status">Checking manifest references and audio. Animation checks are added as Spine metadata loads.</p>}
            {timelineDiagnostics.length === 0 && !timelineChecksPending
              ? <p className="editor-muted">No current issues. Animation checks appear once Spine metadata is available.</p>
              : <div className="editor-validation-list">{timelineDiagnostics.map((diagnostic) => <button key={diagnostic.id} type="button" className="editor-validation-issue" onClick={() => reviewTimelineDiagnostic(diagnostic)} title={diagnostic.target ? "Select the affected timeline item" : diagnostic.message}><b>{diagnostic.kind.replaceAll("-", " ")}</b><span>{diagnostic.message}</span>{diagnostic.target && <small>Go to item →</small>}</button>)}</div>}
          </details>
          {inspector === "sequence" && <section className="editor-section editor-inspector">
          <div className="editor-section-title"><strong>Sequence settings</strong><span>{seconds(duration)}</span></div>
            <NumberField label={timeline.sequenceId === "opening" ? "Total duration" : isTalkSequence ? "Total Talk playback" : "Length"} value={Number(duration.toFixed(3))} min={1} step={0.1} precision={3} unit="s" disabled={(timeline.sequenceId === "opening" || isTalkSequence) && timeline.durationMode === "auto"} onCommit={(totalDuration) => updateTimeline((value) => ({ ...value, durationMode: value.sequenceId === "opening" || /^talk-\d+$/i.test(value.sequenceId ?? "") ? "manual" : value.durationMode, duration: Math.max(1, totalDuration - (isTalkSequence ? talkMixDuration : 0)) }))} />
            <label><span className="timeline-inline-check"><input type="checkbox" checked={timeline.loop} onChange={(event) => updateTimeline((value) => ({ ...value, loop: event.target.checked }))} /> Loop sequence</span></label>
            {isTalkSequence && <>
              <div className="editor-subheading">Talk playback</div>
              <label><span className="timeline-inline-check"><input type="checkbox" checked={timeline.durationMode === "auto"} onChange={(event) => updateTimeline((value) => ({ ...value, durationMode: event.target.checked ? "auto" : "manual", duration: Math.max(1, autoTalkDuration - talkMixDuration) }))} /> Automatic total duration</span><small className="editor-field-hint">{timeline.durationMode === "auto" ? `Fits enabled animation, voice, and subtitle endpoints: ${seconds(autoTalkDuration)}.` : "Manual override"}</small></label>
              <label><span className="timeline-inline-check"><input type="checkbox" checked={talkAutoplayActive} onChange={(event) => event.target.checked ? startTalkAutoplay() : stopTalkAutoplay()} /> Autoplay numbered Talks</span><small className="editor-field-hint">Waits for the animation, enabled voice clips, and subtitles to finish before advancing.</small></label>
              <div className="editor-two-fields">
                <NumberField label="Pause between Talks" value={pauseBetweenTalks} min={0} max={10} step={0.1} precision={1} unit="s" onCommit={setPauseBetweenTalks} />
                <label><span className="timeline-inline-check"><input type="checkbox" checked={loopTalkList} onChange={(event) => setLoopTalkList(event.target.checked)} /> Loop Talk list</span></label>
              </div>
              <div><NumberField label="Talk blend in / out" value={project?.talkMixDuration ?? DEFAULT_TALK_MIX_DURATION} min={0} max={2} step={0.05} precision={2} unit="s" onCommit={updateTalkMixDuration} /><small className="editor-field-hint">Shared by runtime Talk playback and the timeline preview.</small></div>
            </>}
              {timeline.sequenceId === "opening" && <label><span className="timeline-inline-check"><input type="checkbox" checked={timeline.durationMode === "auto"} onChange={(event) => updateTimeline((value) => ({ ...value, durationMode: event.target.checked ? "auto" : "manual", duration: event.target.checked ? openingAutoDuration : value.duration }))} /> Automatic opening duration</span><small className="editor-field-hint">{timeline.durationMode === "auto" ? `Fits enabled visual and dialogue endpoints: ${seconds(openingAutoDuration)}.` : "Manual duration is preserved."}</small></label>}
            {timeline.sequenceId === "opening" && <>
              <label>Opening behavior<select value={timeline.openingMode} onChange={(event) => updateTimeline((value) => ({ ...value, openingMode: event.target.value as EditorProject["timeline"]["openingMode"] }))}><option value="direct">Play intro at opening</option><option value="scene-first">Scene before character</option><option value="skip">Skip intro</option></select><small className="editor-field-hint">Scene-first timing follows the character track’s start time.</small></label>
              <div><NumberField label="Opening idle continuation" value={Number((timeline.openingIdleDuration ?? 3).toFixed(3))} min={0} step={0.1} precision={3} unit="s" onCommit={(openingIdleDuration) => updateTimeline((value) => ({ ...value, openingIdleDuration: Math.max(0, openingIdleDuration) }))} /><small className="editor-field-hint">How long the opening idle preview continues after the authored opening.</small></div>
            </>}
           <div className="timeline-context-summary"><span>Layers <b>{displayVisualTracks.length}</b></span><span>Subtitles <b>{timeline.subtitles.length}</b></span><span>Audio <b>{timeline.audio.length}</b></span></div>
           <p className="editor-muted">Select a clip in the timeline to edit its properties. Add content from the <b>Add</b> menu.</p>
          </section>}

          {inspector === "multi" && <section className="editor-section editor-inspector">
           <div className="editor-section-title"><strong>{selectedClipDetails.length} clips selected</strong><span>{selectedTypeSummary}</span></div>
           <p className="editor-muted">Drag any selected clip to move the group. Drag an edge to resize selected clips of the same type. Linked audio and subtitle timing moves together.</p>
           <div className="timeline-batch-actions">
             <button className="editor-button" onClick={() => setSelectedClipsEnabled(true)}>Enable all</button>
             <button className="editor-button" onClick={() => setSelectedClipsEnabled(false)}>Disable all</button>
           </div>
           <div className="timeline-batch-actions">
             <button className="editor-button" onClick={clearTimelineSelection}>Clear selection</button>
             <button className="editor-preview-button danger" disabled={!deletableSelectionCount} onClick={deleteSelectedClips}>Delete selected</button>
           </div>
           <div className="timeline-selection-list" aria-label="Selected clips">
               {selectedClipDetails.map((item) => <div key={`${item.kind}-${item.id}`}><span className={`timeline-selection-kind ${item.kind}`}>{item.kind === "cue" ? "SUB" : item.kind === "audio" ? "AUD" : item.kind === "animation" ? "ANIM" : item.kind === "color" || item.kind === "color-layer" ? "COLOR" : "SPN"}</span><span title={item.label}>{item.label}</span><small>{seconds(item.start)}–{seconds(item.end)}{!item.removable ? " · locked or main character" : ""}</small></div>)}
           </div>
          </section>}

          {inspector === "animation" && selectedAnimationClip && <section className="editor-section editor-inspector">
            <div className="editor-section-title"><strong>Animation clip</strong><span><i className={`timeline-role-dot ${selectedAnimationClip.layer.role}`} /> {selectedAnimationClip.layer.name}</span></div>
            <div className="editor-two-fields"><button className="editor-button" onClick={duplicateSelectedAnimationClip}>Duplicate</button><button className="editor-preview-button danger" onClick={deleteSelectedClips}>Delete clip</button></div>
            <label>Animation<select value={selectedAnimationClip.clip.animation} onChange={(event) => {
              const animation = event.target.value;
              const duration = animationDurations[`${selectedAnimationClip.layer.id}:${animation}`] ?? 0;
              updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, {
                animation,
                ...(selectedAnimationClip.clip.endMode !== "manual" && !selectedAnimationClip.clip.loop && duration > 0
                  ? { end: selectedAnimationClip.clip.start + Math.max(0.01, duration - selectedAnimationClip.clip.animationOffset) }
                  : {}),
              });
            }}><option value="">Auto fallback</option>{(metas[selectedAnimationClip.layer.id]?.animations ?? []).map((animation) => <option key={animation} value={animation}>{animation}</option>)}</select></label>
            <label>Face / secondary animation<select value={selectedAnimationClip.clip.faceAnimation ?? ""} onChange={(event) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { faceAnimation: event.target.value })}><option value="">Layer default / none</option>{(metas[selectedAnimationClip.layer.id]?.animations ?? []).map((animation) => <option key={animation} value={animation}>{animation}</option>)}</select></label>
            <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedAnimationClip.clip.start.toFixed(3))} min={0} step={0.001} precision={3} unit="s" onCommit={(value) => moveAnimationClipTo(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, value)} /><NumberField label="End" value={Number(animationClipEnd(selectedAnimationClip.clip, animationDurations[`${selectedAnimationClip.layer.id}:${selectedAnimationClip.clip.animation}`] ?? 0).toFixed(3))} min={selectedAnimationClip.clip.start + 0.01} step={0.001} precision={3} unit="s" onCommit={(value) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { endMode: "manual", end: Math.max(selectedAnimationClip.clip.start + 0.01, value) })} /></div>
            <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedAnimationClip.clip.endMode !== "manual"} onChange={(event) => {
              const duration = animationDurations[`${selectedAnimationClip.layer.id}:${selectedAnimationClip.clip.animation}`] ?? 0;
              updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { endMode: event.target.checked ? "auto" : "manual", ...(event.target.checked ? { end: animationClipEnd(selectedAnimationClip.clip, duration) } : {}) });
            }} /> Use Spine animation end</span></label>
            <div className="editor-two-fields"><NumberField label="Animation offset" value={Number(selectedAnimationClip.clip.animationOffset.toFixed(3))} min={0} step={0.001} precision={3} unit="s" onCommit={(animationOffset) => {
              const duration = animationDurations[`${selectedAnimationClip.layer.id}:${selectedAnimationClip.clip.animation}`] ?? 0;
              updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { animationOffset, ...(selectedAnimationClip.clip.endMode !== "manual" && !selectedAnimationClip.clip.loop && duration > 0 ? { end: selectedAnimationClip.clip.start + Math.max(0.01, duration - animationOffset) } : {}) });
            }} /><label><span>Playback</span><span className="timeline-inline-check"><input type="checkbox" checked={selectedAnimationClip.clip.loop} onChange={(event) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { loop: event.target.checked })} /> Loop</span></label></div>
            {timeline.sequenceId === "opening" && selectedAnimationClip.layer.role === "character" && <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedAnimationClip.clip.continueAfterOpening === true} onChange={(event) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { continueAfterOpening: event.target.checked })} /> Continue after opening</span><small className="editor-field-hint">Keeps this animation playing through the interaction-idle handoff.</small></label>}
            {timeline.sequenceId === "opening" && selectedAnimationClip.layer.role === "scene" && <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedAnimationClip.clip.hideCharacter === true} onChange={(event) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { hideCharacter: event.target.checked })} /> Hide character during this scene clip</span><small className="editor-field-hint">When unchecked, the scene and character play together.</small></label>}
            <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedAnimationClip.clip.enabled !== false} onChange={(event) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { enabled: event.target.checked })} /> Enabled</span></label>
            <div className="editor-two-fields subtitle-actions"><button className="editor-button" onClick={() => previewAnimationClip(selectedAnimationClip.layer, selectedAnimationClip.clip)}><IconPlay /> Preview clip</button><span className="editor-field-hint">Drag the body to move; drag either edge to trim.</span></div>
           </section>}

          {inspector === "color-layer" && selectedColorLayer && <section className="editor-section editor-inspector">
            <div className="editor-section-title"><strong>Color layer</strong><span>{selectedColorLayer.clips.length} clip{selectedColorLayer.clips.length === 1 ? "" : "s"}</span></div>
            <div className="editor-two-fields"><button className="editor-button" onClick={() => addColorClip("solid")} disabled={selectedColorLayer.locked}><IconPlus /> Add color clip</button><button className="editor-preview-button danger" onClick={deleteSelectedClips} disabled={selectedColorLayer.locked}>Delete layer</button></div>
            <label>Name<input value={selectedColorLayer.name} disabled={selectedColorLayer.locked} onChange={(event) => updateColorLayer(selectedColorLayer.id, { name: event.target.value })} /></label>
            <div className="editor-two-fields">
               <label>Order<input type="number" min="0" max={Math.max(0, displayVisualTracks.length - 1)} step="1" value={Math.max(0, displayVisualTracks.findIndex((track) => track.kind === "color" && track.layer.id === selectedColorLayer.id))} disabled={selectedColorLayer.locked} onChange={(event) => { const target = displayVisualTracks[Math.max(0, Math.min(displayVisualTracks.length - 1, Number(event.target.value) || 0))]; if (target) reorderVisualTrack(`color:${selectedColorLayer.id}`, visualTrackKey(target)); }} /></label>
              <label>Blend mode<select value={selectedColorLayer.blendMode} disabled={selectedColorLayer.locked} onChange={(event) => updateColorLayer(selectedColorLayer.id, { blendMode: event.target.value as EditorColorLayer["blendMode"] })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="additive">Additive</option></select></label>
            </div>
             <label>Layer opacity · {Math.round(selectedColorLayer.opacity * 100)}%<input type="range" min="0" max="1" step="0.01" value={selectedColorLayer.opacity} disabled={selectedColorLayer.locked} onChange={(event) => updateColorLayer(selectedColorLayer.id, { opacity: Number(event.target.value) })} /></label>
            <div className="editor-two-fields">
              <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedColorLayer.enabled} onChange={(event) => updateColorLayer(selectedColorLayer.id, { enabled: event.target.checked })} /> Visible</span></label>
              <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedColorLayer.locked} onChange={(event) => updateColorLayer(selectedColorLayer.id, { locked: event.target.checked })} /> Locked</span></label>
            </div>
          </section>}

          {inspector === "color-clip" && selectedColorClip && selectedColorLayer && <section className="editor-section editor-inspector">
            <div className="editor-section-title"><strong>Color clip</strong><span>{selectedColorLayer.name}</span></div>
            <div className="editor-two-fields"><button className="editor-button" onClick={duplicateSelectedColorClip} disabled={selectedColorLayer.locked}>Duplicate</button><button className="editor-preview-button danger" onClick={deleteSelectedClips} disabled={selectedColorLayer.locked}>Delete clip</button></div>
            <label>Name<input value={selectedColorClip.name} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { name: event.target.value })} /></label>
            <div className="editor-two-fields color-clip-color-fields">
              <label>Color<input aria-label="Color clip color" type="color" value={selectedColorClip.color} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { color: event.target.value.toUpperCase() })} /></label>
              <label>Hex<input aria-label="Color clip hex value" value={colorHexDraft ?? selectedColorClip.color} disabled={selectedColorLayer.locked} pattern="#[0-9A-Fa-f]{6}" onChange={(event) => { const value = event.target.value; setColorHexDraft(value); if (/^#[\da-f]{6}$/i.test(value)) updateColorClip(selectedColorClip.id, { color: value.toUpperCase() }); }} onBlur={() => setColorHexDraft(null)} /></label>
            </div>
            <div className="editor-two-fields">
              <label>Start (s)<input type="number" min="0" step="0.001" value={Number(selectedColorClip.start.toFixed(3))} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { start: Math.max(0, Number(event.target.value) || 0) })} /></label>
              <label>End (s)<input type="number" min={selectedColorClip.start + 0.01} step="0.001" value={Number(selectedColorClip.end.toFixed(3))} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { end: Math.max(selectedColorClip.start + 0.01, Number(event.target.value) || selectedColorClip.start + 0.01) })} /></label>
            </div>
             <label>Clip opacity · {Math.round(selectedColorClip.opacity * 100)}%<input type="range" min="0" max="1" step="0.01" value={selectedColorClip.opacity} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { opacity: Number(event.target.value) })} /></label>
            <div className="editor-two-fields">
              <label>Fade in (s)<input type="number" min="0" max={selectedColorClip.end - selectedColorClip.start} step="0.01" value={Number(selectedColorClip.fadeIn.toFixed(3))} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { fadeIn: Math.max(0, Number(event.target.value) || 0) })} /></label>
              <label>Fade out (s)<input type="number" min="0" max={selectedColorClip.end - selectedColorClip.start} step="0.01" value={Number(selectedColorClip.fadeOut.toFixed(3))} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { fadeOut: Math.max(0, Number(event.target.value) || 0) })} /></label>
            </div>
            <label>Preset<select value="custom" disabled={selectedColorLayer.locked} onChange={(event) => event.target.value !== "custom" && applyColorClipPreset(event.target.value as ColorClipPreset)}><option value="custom">Custom</option><option value="solid">Solid hold</option><option value="fade-from-black">Fade from black</option><option value="fade-to-black">Fade to black</option><option value="white-flash">White flash</option></select></label>
            <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedColorClip.enabled} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { enabled: event.target.checked })} /> Enabled</span></label>
            {selectedColorClip.fadeIn + selectedColorClip.fadeOut >= selectedColorClip.end - selectedColorClip.start - 0.001 && (selectedColorClip.fadeIn > 0 || selectedColorClip.fadeOut > 0) && <small className="editor-field-hint">Fades fill the clip duration; changing one scales both fades to fit.</small>}
          </section>}

           {inspector === "layer" && selectedLayer && <section className="editor-section editor-inspector">
           <div className="editor-section-title"><strong>Layer</strong><span><i className={`timeline-role-dot ${selectedLayer.role}`} /> {roleLabel(selectedLayer.role)} <button className="danger" onClick={removeLayer} disabled={selectedLayer.role === "character" || selectedLayer.locked}>Remove</button></span></div>
           <label>Name<input value={selectedLayer.name} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { name: event.target.value })} /></label>
           <div className="editor-two-fields"><label>Role<select value={selectedLayer.role} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { role: event.target.value as TimelineLayerRole })}><option value="background">Background</option><option value="scene">Scene</option><option value="character">Character</option><option value="overlay">Overlay</option></select></label><NumberField label="Order" value={Math.max(0, displayVisualTracks.findIndex((track) => track.kind === "spine" && track.layer.id === selectedLayer.id))} min={0} max={Math.max(0, displayVisualTracks.length - 1)} step={1} disabled={selectedLayer.locked} onCommit={(order) => { const target = displayVisualTracks[Math.max(0, Math.min(displayVisualTracks.length - 1, Math.round(order)))]; if (target) reorderVisualTrack(`spine:${selectedLayer.id}`, visualTrackKey(target)); }} /></div>
           <label>Blend mode<select value={selectedLayer.blendMode ?? "normal"} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { blendMode: event.target.value as EditorTimelineLayer["blendMode"] })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="additive">Additive</option></select></label>
           <label>{selectedLayer.followMainAnimation ? "Fallback animation" : "Animation"}<select disabled={selectedLayer.locked} value={selectedLayer.animation || metas[selectedLayer.id]?.idleAnimation || ""} onChange={(event) => updateLayer(selectedLayer.id, { animation: event.target.value })}><option value="">Auto idle</option>{(metas[selectedLayer.id]?.animations ?? []).map((animation) => <option key={animation} value={animation}>{animation}</option>)}</select></label>
           {selectedLayer.role !== "character" && <label><span className="timeline-inline-check"><input type="checkbox" disabled={selectedLayer.locked} checked={selectedLayer.followMainAnimation === true} onChange={(event) => updateLayer(selectedLayer.id, { followMainAnimation: event.target.checked })} /> Follow main character animation</span><small className="editor-field-hint">Uses a matching animation and clock when available.</small></label>}
           <label>Face / secondary animation<select disabled={selectedLayer.locked} value={selectedLayer.faceAnimation ?? ""} onChange={(event) => updateLayer(selectedLayer.id, { faceAnimation: event.target.value })}><option value="">None</option>{(metas[selectedLayer.id]?.animations ?? []).map((name) => <option key={name}>{name}</option>)}</select></label>
           <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedLayer.start.toFixed(3))} min={0} step={0.001} precision={3} unit="s" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { start: Math.max(0, value) })} /><NumberField label="End" value={Number(selectedLayer.end.toFixed(3))} min={selectedLayer.start + 0.01} step={0.001} precision={3} unit="s" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { endMode: "manual", end: Math.max(selectedLayer.start + 0.01, value) })} /></div>
           <label><span className="timeline-inline-check"><input type="checkbox" disabled={selectedLayer.locked} checked={selectedLayer.endMode !== "manual"} onChange={(event) => updateLayer(selectedLayer.id, { endMode: event.target.checked ? "auto" : "manual" })} /> Use Spine animation end</span></label>
           <div className="editor-two-fields"><NumberField label="Animation offset" value={Number(selectedLayer.animationOffset.toFixed(3))} min={0} step={0.001} precision={3} unit="s" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { animationOffset: Math.max(0, value) })} /><label><span>Playback</span><span className="timeline-inline-check"><input type="checkbox" disabled={selectedLayer.locked} checked={selectedLayer.loop} onChange={(event) => updateLayer(selectedLayer.id, { loop: event.target.checked })} /> Loop</span></label></div>
           <details><summary>Advanced transforms</summary><div className="editor-three-fields"><NumberField label="X" value={selectedLayer.x} step={1} precision={2} unit="units" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { x: value })} /><NumberField label="Y" value={selectedLayer.y} step={1} precision={2} unit="units" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { y: value })} /><NumberField label="Scale" value={selectedLayer.scale} min={0.01} step={0.01} precision={3} disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { scale: Math.max(0.01, value) })} /></div></details>
            <BoundedSliderField label="Opacity" value={selectedLayer.opacity * 100} defaultValue={100} min={0} max={100} step={0.1} precision={1} unit="%" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { opacity: value / 100 })} />
           <div className="editor-two-fields"><label><span className="timeline-inline-check"><input type="checkbox" checked={selectedLayer.enabled} onChange={(event) => updateLayer(selectedLayer.id, { enabled: event.target.checked })} /> Visible</span></label><label><span className="timeline-inline-check"><input type="checkbox" checked={selectedLayer.locked === true} onChange={(event) => updateLayer(selectedLayer.id, { locked: event.target.checked })} /> Locked</span></label></div>
        </section>}

        {inspector === "cue" && selectedCue && <section className="editor-section editor-inspector">
          <div className="editor-section-title"><strong>Subtitle #{selectedCueIndex + 1}</strong><span>{seconds(selectedCue.start)}–{seconds(selectedCue.end)}</span></div>
          <div className="editor-two-fields subtitle-actions"><button className="editor-button" onClick={() => updateCue(selectedCue.id, { start: Math.min(currentTime, selectedCue.end - 0.01) })}>Start at playhead</button><button className="editor-button" onClick={() => updateCue(selectedCue.id, { end: Math.max(currentTime, selectedCue.start + 0.01) })}>End at playhead</button></div>
           <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedCue.start.toFixed(3))} min={0} step={0.001} precision={3} unit="s" onCommit={(value) => updateCue(selectedCue.id, { start: Math.max(0, Math.min(selectedCue.end - 0.01, value)) })} /><NumberField label="End" value={Number(selectedCue.end.toFixed(3))} min={selectedCue.start + 0.01} step={0.001} precision={3} unit="s" onCommit={(value) => updateCue(selectedCue.id, { end: Math.max(selectedCue.start + 0.01, value) })} /></div>
           <SubtitleTextEditor
             cueNumber={selectedCueIndex + 1}
             language={timeline.language}
             text={selectedCue.text}
             onLanguageChange={(language) => updateTimeline((value) => ({ ...value, language }))}
             onTextChange={(language, text) => updateCue(selectedCue.id, { text: { ...selectedCue.text, [language]: text } })}
           />
          <div className="editor-two-fields subtitle-actions"><button className="editor-button" onClick={() => updateTimeline((value) => splitCue(value, selectedCue.id, currentTime))}>Split (S)</button><button className="editor-button" onClick={duplicateCue}>Duplicate</button><button className="editor-button" onClick={() => { setCurrentTime(selectedCue.start); setPreviewUntil(selectedCue.end); setPlaying(true); }}>Preview cue</button></div>
          <div className="editor-two-fields"><label><span className="timeline-inline-check"><input type="checkbox" checked={selectedCue.enabled} onChange={(event) => updateCue(selectedCue.id, { enabled: event.target.checked })} /> Visible</span></label><button className="editor-preview-button danger" onClick={deleteCue}>Delete cue</button></div>
        </section>}

        {inspector === "audio" && selectedAudio && <section className="editor-section editor-inspector">
          <div className="editor-section-title"><strong>Audio clip</strong><span>{seconds(selectedAudio.start)}–{seconds(selectedAudio.end)}</span></div>
          <label>Name<input value={selectedAudio.name} onChange={(event) => updateAudio(selectedAudio.id, { name: event.target.value })} /></label>
             <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedAudio.start.toFixed(3))} min={selectedAudioMinimumStart} step={0.001} precision={3} unit="s" onCommit={(value) => updateAudio(selectedAudio.id, { start: selectedAudioDuration !== undefined ? clampAudioStart(selectedAudio.end, value, selectedAudioDuration) : Math.min(selectedAudio.end - 0.01, Math.max(0, value)) })} /><NumberField label="End" value={Number(selectedAudio.end.toFixed(3))} min={selectedAudio.start + 0.01} max={selectedAudioMaximumEnd} step={0.001} precision={3} unit="s" onCommit={(value) => updateAudio(selectedAudio.id, { autoEnd: false, end: selectedAudioDuration !== undefined ? clampAudioEnd(selectedAudio.start, value, selectedAudioDuration) : Math.max(selectedAudio.start + 0.01, value) })} /></div>
             {selectedAudioDuration !== undefined && <small className="editor-field-hint">Source duration: {seconds(selectedAudioDuration)}. The clip cannot be extended past its source.</small>}
            <BoundedSliderField label="Volume" value={selectedAudio.volume * 100} defaultValue={100} min={0} max={100} step={0.1} precision={1} unit="%" onCommit={(value) => updateAudio(selectedAudio.id, { volume: value / 100 })} />
           <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedAudio.enabled} onChange={(event) => updateAudio(selectedAudio.id, { enabled: event.target.checked })} /> Enabled</span></label>
           <label>Linked subtitle<select aria-label="Linked subtitle" value={selectedAudio.subtitleId === null ? "__none__" : selectedAudio.subtitleId ?? selectedAudioLinkedSubtitle?.id ?? "__none__"} onChange={(event) => setAudioSubtitleLink(selectedAudio.id, event.target.value === "__none__" ? null : event.target.value)}>
             <option value="__none__">No linked subtitle</option>
             {timeline.subtitles.map((cue) => <option key={cue.id} value={cue.id}>{seconds(cue.start)} · {cueText(cue, timeline.language)}</option>)}
           </select><small className="editor-field-hint">{selectedAudio.subtitleId === undefined && selectedAudioLinkedSubtitle ? "Imported line link; Link subtitle saves an explicit relationship." : "Moving the audio moves its linked subtitle."}</small></label>
           <div className="timeline-audio-actions">
             <button className="editor-button" type="button" disabled={!selectedAudioLinkCandidate} onClick={() => selectedAudioLinkCandidate && setAudioSubtitleLink(selectedAudio.id, selectedAudioLinkCandidate.id)} title="Link the nearest subtitle, or make the current legacy link explicit"><IconLink /> {selectedAudioLinkedSubtitle ? "Link subtitle" : "Link nearest"}</button>
             <button className="editor-button" type="button" disabled={!selectedAudioLinkedSubtitle && selectedAudio.subtitleId == null} onClick={() => setAudioSubtitleLink(selectedAudio.id, null)} title="Remove the audio/subtitle relationship"><IconUnlink /> Unlink</button>
             <button className="editor-button" type="button" disabled={selectedAudioDuration === undefined} onClick={matchSelectedAudioLength} title="Set this clip and its linked subtitle to the decoded source duration"><IconSync /> Match source</button>
             <button className="editor-button" type="button" onClick={previewSelectedAudio} title="Preview this clip"><IconPlay /> Preview</button>
           </div>
           {selectedAudioLinkedSubtitle && <p className="editor-muted timeline-audio-link-note">Linked to “{cueText(selectedAudioLinkedSubtitle, timeline.language)}” · {seconds(selectedAudioLinkedSubtitle.start)}–{seconds(selectedAudioLinkedSubtitle.end)}</p>}
           {missingAudio.includes(selectedAudio.path) && <><p className="editor-error">Audio file is missing from the selected asset root.</p><button className="editor-button" onClick={() => void relinkAudio()}>Relink audio</button></>}
          <button className="editor-preview-button danger" onClick={deleteAudio}>Delete clip</button>
          <p className="editor-muted" title={selectedAudio.path}>{selectedAudio.path}</p>
        </section>}

        {((inspector === "layer" && !selectedLayer) || (inspector === "color-layer" && !selectedColorLayer) || (inspector === "color-clip" && !selectedColorClip) || (inspector === "animation" && !selectedAnimationClip) || (inspector === "cue" && !selectedCue) || (inspector === "audio" && !selectedAudio)) && <div className="timeline-empty timeline-inspector-empty"><strong>Select a clip</strong><span>Choose a Spine/color layer, animation, subtitle, or audio clip in the timeline.</span></div>}
      </aside>
    </div>
     <AssetPickerModal open={layerPickerOpen} title="Add Spine layer" eyebrow="TIMELINE LAYER" description="Search the loaded catalog and add another background, scene, character, or overlay set." directories={availableLayerDirectories} assetRoot={source?.rootPath ?? ""} directoryInfo={directoryInfo} emptyLabel="Every available asset set is already on this timeline." renderLabel={(item) => characterDirectoryLabel(item, directoryLabels)} getSearchText={(item) => characterDirectoryLabel(item, directoryLabels)} onClose={() => setLayerPickerOpen(false)} onSelect={(next) => { setLayerPickerOpen(false); addLayer(next); }} />
  </>;
}
