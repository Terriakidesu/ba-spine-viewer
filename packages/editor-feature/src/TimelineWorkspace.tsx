import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SetStateAction, type WheelEvent as ReactWheelEvent } from "react";
import { ContextMenu, type ContextMenuAction, isContextMenuShortcut } from "@ba-spine/app-ui/ContextMenu";
import { type SpineCameraPose, type SpineFiles, type SpineMeta, type SpineRenderer } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { cameraAspectValue, cameraFrameHeightForBound, cameraKeyframeTimeAvailable, changeSpineCameraAspectRatio, evaluateSpineCameraTrack, moveSpineCameraBound, moveSpineCameraKeyframe, resizeSpineCameraBound, resizeSpineCameraKeyframe, retimeSpineCameraKeyframe, sampleSpineCameraTrackWithFallback, spineCameraBoundFromCanvasDrag, type CameraCanvasPoint, type SpineCameraAspectRatio, type SpineCameraBoundResizeHandle, type SpineCameraSafeBound, type SpineCameraTrack } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import { DEFAULT_TALK_MIX_DURATION, normalizeAnimationMixDuration } from "@ba-spine/spine-runtime/spine/spineInteraction";
import { DEFAULT_EFFECTS_STRENGTH } from "@ba-spine/spine-runtime/spine/spineEffects";
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
import { addTalkSequence, animationClipEnd, animationEndForLayer, authoredTimelineEnd, deleteAnimationClipRipple, deleteSequence, duplicateAnimationClipRipple, effectiveAnimationClips, extendTimelineDuration, insertAnimationClipRipple, linkAudioToSubtitle, linkedSubtitleForAudio, matchAudioAndSubtitleLength, matchedAnimationEndpoint, moveAnimationClipRipple, moveSequenceBy, moveSequenceId, nextTalkSequenceId, nextTalkSequenceIdForProject, openingTimelineDuration, replaceSubtitleImport, resolveTimelineSnap, sequenceDisplayName, sequenceIdsForProject, snapToTargets, splitCue, switchSequence } from "./sequenceModel";
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
import { clampStageScale, fitStageView, panStageView, resetStageView, stageViewSvgTransform, stageViewToContentPoint, STAGE_VIEW_MAX_SCALE, zoomStageView, type StageView } from "./stageView";
import { SubtitleTextEditor } from "./SubtitleTextEditor";
import { AnimationPicker } from "./AnimationPicker";
import { CameraContextMenu } from "./CameraContextMenu";
import { CameraKeyframeStrip } from "./CameraKeyframeStrip";
import { TimelinePanelResizer } from "./TimelinePanelResizer";
import { TimelineSplitHandle } from "./TimelineSplitHandle";
import { DEFAULT_TIMELINE_LAYOUT_PREFERENCES, normalizeTimelineLayoutPreferences, TIMELINE_LAYOUT_PREFERENCES_KEY, type TimelineLayoutPreferences } from "./timelineLayout";
import { advanceTimelineRangeLoop, fitTimelineToRange, zoomTimelineAtCursor, type TimelineRange } from "./timelineView";
import { AudioWaveform, type AudioWaveformMeasurement } from "./AudioWaveform";
import { missingManifestAssetFiles, validateTimeline, type TimelineDiagnostic } from "./timelineDiagnostics";
import { copyTimelineSelection, pasteTimelineSelection, type TimelineClipboard, type TimelineClipboardSelection } from "./timelineClipboard";
import { searchSubtitleCues, type SubtitleSearchLanguage } from "./subtitleCueSearch";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconEye, IconEyeOff, IconExpand, IconLink, IconLock, IconMinus, IconPause, IconPlay, IconPlus, IconSkipBack, IconSkipForward, IconSound, IconSync, IconUnlock, IconUnlink } from "@ba-spine/app-ui/icons";
import "./timelineSnapFeedback.css";

const TIMELINE_SCALE = 96;
const MIN_TIMELINE_DURATION = 1;
const TRACK_HEADER_WIDTH = 190;
const LAYER_DEFAULT_FACE_ANIMATION = "__layer_default__";

function emptyCameraTrack(): SpineCameraTrack {
  return { enabled: true, aspectRatio: "16:9", constraint: { mode: "automatic" }, safeBounds: [], keyframes: [] };
}

const CAMERA_STUDIO_PREFERENCES_KEY = "ba-spine-editor:camera-studio-preferences:v1";

interface CameraStudioPreferences {
  sceneShare: number;
  bounds: boolean;
  shots: boolean;
  centers: boolean;
  composition: boolean;
  aspectLocked: boolean;
}

function readCameraStudioPreferences(): CameraStudioPreferences {
  const fallback: CameraStudioPreferences = { sceneShare: 0.63, bounds: true, shots: true, centers: true, composition: false, aspectLocked: false };
  if (typeof window === "undefined") return fallback;
  try {
    const value = JSON.parse(window.localStorage.getItem(CAMERA_STUDIO_PREFERENCES_KEY) ?? "null") as Partial<CameraStudioPreferences> | null;
    return {
      sceneShare: typeof value?.sceneShare === "number" && Number.isFinite(value.sceneShare) ? Math.max(0.35, Math.min(0.8, value.sceneShare)) : fallback.sceneShare,
      bounds: typeof value?.bounds === "boolean" ? value.bounds : fallback.bounds,
      shots: typeof value?.shots === "boolean" ? value.shots : fallback.shots,
      centers: typeof value?.centers === "boolean" ? value.centers : fallback.centers,
      composition: typeof value?.composition === "boolean" ? value.composition : fallback.composition,
      aspectLocked: typeof value?.aspectLocked === "boolean" ? value.aspectLocked : fallback.aspectLocked,
    };
  } catch {
    return fallback;
  }
}

function writeCameraStudioPreferences(value: CameraStudioPreferences) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(CAMERA_STUDIO_PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Preferences are optional. */ }
}

function cameraItemId(prefix: string): string {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function cameraBoundPointAtHandle(bound: SpineCameraSafeBound, handle: SpineCameraBoundResizeHandle): CameraCanvasPoint {
  return {
    x: handle.includes("e") ? bound.x + bound.width : handle.includes("w") ? bound.x : bound.x + bound.width / 2,
    y: handle.includes("n") ? bound.y + bound.height : handle.includes("s") ? bound.y : bound.y + bound.height / 2,
  };
}

function cameraShotPointAtHandle(keyframe: SpineCameraTrack["keyframes"][number], handle: SpineCameraBoundResizeHandle, aspectRatio: number): CameraCanvasPoint {
  const width = keyframe.frameHeight * aspectRatio;
  return {
    x: handle.includes("e") ? keyframe.centerX + width / 2 : handle.includes("w") ? keyframe.centerX - width / 2 : keyframe.centerX,
    y: handle.includes("n") ? keyframe.centerY + keyframe.frameHeight / 2 : handle.includes("s") ? keyframe.centerY - keyframe.frameHeight / 2 : keyframe.centerY,
  };
}

interface CameraBoundTransform {
  pointerId: number;
  boundId: string;
  mode: "move" | "resize";
  handle?: SpineCameraBoundResizeHandle;
  last: CameraCanvasPoint;
  original: SpineCameraSafeBound;
  latest: SpineCameraSafeBound;
  edited: boolean;
}

interface CameraShotTransform {
  pointerId: number;
  keyframeId: string;
  mode: "move" | "resize";
  handle?: SpineCameraBoundResizeHandle;
  last: CameraCanvasPoint;
  original: SpineCameraTrack["keyframes"][number];
  latest: SpineCameraTrack["keyframes"][number];
  edited: boolean;
}

interface CameraShotSliderEdit {
  pointerId: number | null;
  keyframeId: string;
  field: "time" | "frameHeight";
  original: SpineCameraTrack["keyframes"][number];
  latest: SpineCameraTrack["keyframes"][number];
  edited: boolean;
}

interface CameraKeyframeDrag {
  pointerId: number;
  keyframeId: string;
  original: SpineCameraTrack["keyframes"][number];
  element: HTMLButtonElement;
  playhead: number;
  latestTime: number;
  edited: boolean;
}

type CameraContextTarget =
  | { kind: "empty" }
  | { kind: "timeline"; time: number }
  | { kind: "shot"; id: string }
  | { kind: "boundary"; id: string };

interface CameraContextMenuState {
  x: number;
  y: number;
  target: CameraContextTarget;
  returnFocusTo: HTMLElement | SVGElement | null;
}

interface ImportedSubtitleEntry {
  start: number;
  end?: number;
  text: Record<TimelineLanguage, string>;
  audio: string[];
}

interface TimelineWorkspaceProps {
  mode?: "timeline" | "camera";
  onWorkspaceChange?: (workspace: "interaction" | "timeline" | "camera") => void;
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
  onSelectProject?: (mutator: (current: EditorProject) => EditorProject) => void;
  onBeginEdit: () => void;
  onBeginCameraEdit?: () => void;
  onEndCameraEdit?: () => void;
  onCancelCameraEdit?: () => void;
  onSave: () => void | Promise<void>;
  onRegisterSave: (callback: ((getProject: () => EditorProject | null) => Promise<EditorSaveFile[]>) | null) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
  onRegisterMcp: (bridge: EditorMcpTimelineBridge | null) => void;
  onMcpSnapshot: (snapshot: EditorMcpTimelineSnapshot | null) => void;
  /** Optional in-memory diagnostics for explicit development waveform profiling builds. */
  onAudioWaveformProfile?: (clipId: string, measurement: AudioWaveformMeasurement) => void;
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
type TimelineContextTarget = { kind: "preview" } | { kind: "empty" } | { kind: "clip"; selection: TimelineSelection };
interface TimelineContextMenuState { x: number; y: number; target: TimelineContextTarget; returnFocusTo: HTMLElement | null }
type TimelineDragKind = TimelineClipKind | "layer-start" | "layer-end" | "animation-start" | "animation-end" | "color-start" | "color-end" | "color-fade-in" | "color-fade-out" | "cue-start" | "cue-end" | "audio-start" | "audio-end";
interface TimelineDragItem extends TimelineSelection { start: number; end: number; linked?: boolean; sourceDuration?: number; fadeIn?: number; fadeOut?: number }
interface TimelineDragState {
  kind: TimelineDragKind;
  id: string;
  x: number;
  start: number;
  end: number;
  items: TimelineDragItem[];
  colorLayerSnapshot?: EditorColorLayer[];
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

export function TimelineWorkspace({ mode = "timeline", onWorkspaceChange = () => undefined, source, directory, directories, directoryLabels = {}, directoryInfo = {}, project, initialHandoff, initialSubtitlePath, onSubtitleOpened, initialAudioPaths, onAudioOpened, onRecentFile, onMutate, onLive, onSelectProject, onBeginEdit, onBeginCameraEdit = () => undefined, onEndCameraEdit = () => undefined, onCancelCameraEdit = () => undefined, onSave, onRegisterSave, onStatus, onError, onRegisterMcp, onMcpSnapshot, onAudioWaveformProfile }: TimelineWorkspaceProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [subtitleSearchQuery, setSubtitleSearchQuery] = useState("");
  const [subtitleSearchLanguage, setSubtitleSearchLanguage] = useState<SubtitleSearchLanguage>("all");
  const [previewUntil, setPreviewUntilState] = useState<number | null>(null);
  const [selectionLoopRange, setSelectionLoopRange] = useState<TimelineRange | null>(null);
  function setPreviewUntil(value: number | null) {
    setSelectionLoopRange(null);
    setPreviewUntilState(value);
  }
  const [talkAutoplayActive, setTalkAutoplayActive] = useState(false);
  const [loopTalkList, setLoopTalkList] = useState(false);
  const [pauseBetweenTalks, setPauseBetweenTalks] = useState(0.35);
  const [pendingTalkSequence, setPendingTalkSequence] = useState<string | null>(null);
  const [metas, setMetas] = useState<Record<string, SpineMeta | null>>({});
  const [sharedCameraPose, setSharedCameraPose] = useState<SpineCameraPose | null>(null);
  const [selectedCameraKeyframeId, setSelectedCameraKeyframeId] = useState<string | null>(null);
  const [cameraInspectorTarget, setCameraInspectorTarget] = useState<"settings" | "boundary" | "shot">("settings");
  const [cameraKeyframeTimeIssue, setCameraKeyframeTimeIssue] = useState<string | null>(null);
  const [cameraContextMenu, setCameraContextMenu] = useState<CameraContextMenuState | null>(null);
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenuState | null>(null);
  const [cameraGuidesVisible, setCameraGuidesVisible] = useState(() => readCameraStudioPreferences().bounds);
  const [cameraShotGuidesVisible, setCameraShotGuidesVisible] = useState(() => readCameraStudioPreferences().shots);
  const [cameraCenterGuidesVisible, setCameraCenterGuidesVisible] = useState(() => readCameraStudioPreferences().centers);
  const [cameraCompositionGuidesVisible, setCameraCompositionGuidesVisible] = useState(() => readCameraStudioPreferences().composition);
  const [cameraAspectLocked, setCameraAspectLocked] = useState(() => readCameraStudioPreferences().aspectLocked);
  const [cameraTool, setCameraTool] = useState<"select" | "pan" | "draw">("select");
  const [cameraEditMode, setCameraEditMode] = useState<"boundaries" | "shots">("shots");
  const [selectedCameraBoundId, setSelectedCameraBoundId] = useState<string | null>(null);
  const [cameraBoundDrawing, setCameraBoundDrawing] = useState(false);
  const [cameraBoundDraft, setCameraBoundDraft] = useState<{ start: CameraCanvasPoint; end: CameraCanvasPoint } | null>(null);
  const [cameraGizmoDragging, setCameraGizmoDragging] = useState(false);
  const [cameraProjectionRevision, setCameraProjectionRevision] = useState(0);
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
  const [cameraSpacePanning, setCameraSpacePanning] = useState(false);
  const [cameraSceneShare, setCameraSceneShare] = useState(() => readCameraStudioPreferences().sceneShare);
  const [cameraZoomDraft, setCameraZoomDraft] = useState<string | null>(null);
  const [cameraSplitDragging, setCameraSplitDragging] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [inspector, setInspector] = useState<"sequence" | "layer" | "color-layer" | "animation" | "color-clip" | "cue" | "audio" | "multi">("sequence");
  const appliedHandoffIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraPreviewPairRef = useRef<HTMLDivElement>(null);
  const activeCameraBoundIdRef = useRef<{ sequenceId: string; boundId: string | null }>({ sequenceId: "", boundId: null });
  const cameraBoundDrawRef = useRef<{ pointerId: number; start: CameraCanvasPoint; end: CameraCanvasPoint } | null>(null);
  const cameraBoundTransformRef = useRef<CameraBoundTransform | null>(null);
  const cameraShotTransformRef = useRef<CameraShotTransform | null>(null);
  const cameraShotSliderEditRef = useRef<CameraShotSliderEdit | null>(null);
  const spineRenderersRef = useRef(new Map<string, SpineRenderer>());
  const stagePanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const cameraSpacePanRef = useRef(false);
  const cameraSplitPointerRef = useRef<number | null>(null);
  const stagePanMovedRef = useRef(false);
  const cameraKeyframeStripRef = useRef<HTMLDivElement>(null);
  const cameraKeyframeDragRef = useRef<CameraKeyframeDrag | null>(null);
  const cameraShotClipboardRef = useRef<SpineCameraTrack["keyframes"][number] | null>(null);
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  const scrubRef = useRef<number | null>(null);
  const [selectedClips, setSelectedClipsState] = useState<TimelineSelection[]>([]);
  function setSelectedClips(next: SetStateAction<TimelineSelection[]>) {
    setSelectionLoopRange(null);
    setSelectedClipsState(next);
  }
  const timelineClipboardRef = useRef<TimelineClipboard | null>(null);
  const [clipboardAvailable, setClipboardAvailable] = useState(false);
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
  const sequenceDragRef = useRef<string | null>(null);
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
  const mcpSubtitleChangeSetsRef = useRef(new Map<string, { project: EditorProject; sequenceId: string; path: string; policy: "replace-imported-cues" | "merge-missing-translations" | "update-text-only"; before: EditorSubtitleCue[]; after: EditorSubtitleCue[]; duration: number; report: Record<string, unknown> }>());
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
  const cameraTrack = timeline?.camera ?? null;
  const selectedCameraKeyframe = cameraTrack?.keyframes.find((keyframe) => keyframe.id === selectedCameraKeyframeId) ?? null;
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
  const cameraReferenceLayer = timeline?.layers.find((layer) => layer.id === referenceLayerId) ?? null;
  const cameraProjectionRenderer = useMemo(() => spineRenderersRef.current.get(referenceLayerId) ?? null, [cameraProjectionRevision, referenceLayerId]);
  const cameraProjectionSize = cameraProjectionRenderer?.canvasClientSize() ?? null;
  const cameraSequenceKey = timeline?.sequenceId ?? "legacy";
  const sampledCamera = cameraTrack
    ? sampleSpineCameraTrackWithFallback(cameraTrack, currentTime, cameraProjectionRenderer?.getArtworkCameraFrame(cameraAspectValue(cameraTrack.aspectRatio)) ?? null)
    : null;
  const solvedCamera = cameraTrack
    ? evaluateSpineCameraTrack(cameraTrack, currentTime, 1, 1, cameraProjectionRenderer?.getArtworkCameraFrame(cameraAspectValue(cameraTrack.aspectRatio)) ?? null, activeCameraBoundIdRef.current.sequenceId === cameraSequenceKey ? activeCameraBoundIdRef.current.boundId : null)
    : null;
  if (solvedCamera) activeCameraBoundIdRef.current = { sequenceId: cameraSequenceKey, boundId: solvedCamera.activeBoundId };
  const projectCameraPoint = (x: number, y: number) => {
    const point = cameraProjectionRenderer?.worldToCanvas(x, y);
    if (!point || !cameraProjectionSize || !cameraReferenceLayer) return point;
    return {
      x: cameraProjectionSize.width / 2 + cameraReferenceLayer.x + (point.x - cameraProjectionSize.width / 2) * cameraReferenceLayer.scale,
      y: cameraProjectionSize.height / 2 + cameraReferenceLayer.y + (point.y - cameraProjectionSize.height / 2) * cameraReferenceLayer.scale,
    };
  };
  const cameraBoundFrames = cameraTrack
    ? cameraTrack.safeBounds.filter((bound) => bound.visible !== false).map((bound) => {
      const topLeft = projectCameraPoint(bound.x, bound.y + bound.height);
      const bottomRight = projectCameraPoint(bound.x + bound.width, bound.y);
      return topLeft && bottomRight ? {
        id: bound.id,
        x: Math.min(topLeft.x, bottomRight.x),
        y: Math.min(topLeft.y, bottomRight.y),
        width: Math.abs(bottomRight.x - topLeft.x),
        height: Math.abs(bottomRight.y - topLeft.y),
        active: bound.id === solvedCamera?.activeBoundId,
        enabled: bound.enabled,
        selected: bound.id === selectedCameraBoundId && cameraEditMode === "boundaries",
      } : null;
    }).filter((bound): bound is NonNullable<typeof bound> => bound !== null)
    : [];
  const cameraOutputFrame = cameraTrack?.enabled ? solvedCamera?.frame : null;
  const cameraOutputRect = cameraOutputFrame ? (() => {
    const topLeft = projectCameraPoint(cameraOutputFrame.centerX - cameraOutputFrame.width / 2, cameraOutputFrame.centerY + cameraOutputFrame.height / 2);
    const bottomRight = projectCameraPoint(cameraOutputFrame.centerX + cameraOutputFrame.width / 2, cameraOutputFrame.centerY - cameraOutputFrame.height / 2);
    return topLeft && bottomRight ? {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    } : null;
  })() : null;
  const selectedCameraShotRect = selectedCameraKeyframe && cameraTrack ? (() => {
    const width = selectedCameraKeyframe.frameHeight * cameraAspectValue(cameraTrack.aspectRatio);
    const topLeft = projectCameraPoint(selectedCameraKeyframe.centerX - width / 2, selectedCameraKeyframe.centerY + selectedCameraKeyframe.frameHeight / 2);
    const bottomRight = projectCameraPoint(selectedCameraKeyframe.centerX + width / 2, selectedCameraKeyframe.centerY - selectedCameraKeyframe.frameHeight / 2);
    return topLeft && bottomRight ? {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    } : null;
  })() : null;
  const animations = characterMeta?.animations ?? [];
  const sequenceIds = useMemo(() => sequenceIdsForProject(project, animations), [animations, project]);
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
  const talkSequenceIds = useMemo(() => sequenceIds.filter((id) => /^talk-\d+$/i.test(id)), [sequenceIds]);
  sequenceContextRef.current = { animations, directories };
  const isTalkSequence = /^talk-\d+$/i.test(timeline?.sequenceId ?? "");

  useEffect(() => {
    activeCameraBoundIdRef.current = { sequenceId: cameraSequenceKey, boundId: null };
    setSelectedCameraKeyframeId(null);
    setSelectedCameraBoundId(null);
    setCameraInspectorTarget("settings");
    setCameraKeyframeTimeIssue(null);
    setCameraContextMenu(null);
    cameraKeyframeDragRef.current = null;
    setCameraGizmoDragging(false);
    setCameraBoundDrawing(false);
    setCameraBoundDraft(null);
    cameraBoundDrawRef.current = null;
    cameraBoundTransformRef.current = null;
  }, [directory, timeline?.sequenceId]);

  useEffect(() => {
    if (mode !== "camera") {
      cameraSpacePanRef.current = false;
      setCameraSpacePanning(false);
      return;
    }
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setCameraProjectionRevision((value) => value + 1);
        frame = requestAnimationFrame(() => {
          const pose = spineRenderersRef.current.get(referenceLayerId)?.getCameraPose();
          if (pose) setSharedCameraPose((current) => current
            && Math.abs(current.x - pose.x) < 1e-6
            && Math.abs(current.y - pose.y) < 1e-6
            && Math.abs(current.zoom - pose.zoom) < 1e-6
            ? current
            : pose);
        });
      });
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mode, referenceLayerId]);

  useEffect(() => {
    writeCameraStudioPreferences({
      sceneShare: cameraSceneShare,
      bounds: cameraGuidesVisible,
      shots: cameraShotGuidesVisible,
      centers: cameraCenterGuidesVisible,
      composition: cameraCompositionGuidesVisible,
      aspectLocked: cameraAspectLocked,
    });
  }, [cameraSceneShare, cameraGuidesVisible, cameraShotGuidesVisible, cameraCenterGuidesVisible, cameraCompositionGuidesVisible, cameraAspectLocked]);

  useEffect(() => {
    if (mode !== "camera") return;
    const releaseSpacePan = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      cameraSpacePanRef.current = false;
      setCameraSpacePanning(false);
    };
    const clearSpacePan = () => {
      cameraSpacePanRef.current = false;
      setCameraSpacePanning(false);
    };
    window.addEventListener("keyup", releaseSpacePan);
    window.addEventListener("blur", clearSpacePan);
    return () => {
      window.removeEventListener("keyup", releaseSpacePan);
      window.removeEventListener("blur", clearSpacePan);
      clearSpacePan();
    };
  }, [mode]);

  function updateCameraTrack(mutator: (value: SpineCameraTrack) => SpineCameraTrack, history = true) {
    updateTimeline((value) => ({
      ...value,
      camera: mutator(value.camera ?? {
        ...emptyCameraTrack(),
        ...(referenceLayerId ? { referenceLayerId } : {}),
      }),
    }), history);
  }

  function changeCameraAspectRatio(aspectRatio: SpineCameraAspectRatio) {
    updateCameraTrack((value) => changeSpineCameraAspectRatio(value, aspectRatio));
  }

  function selectCameraKeyframe(id: string) {
    const keyframe = cameraTrack?.keyframes.find((item) => item.id === id);
    if (!keyframe) return;
    setSelectedCameraKeyframeId(id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    if (keyframe.constraint?.mode === "manual") setSelectedCameraBoundId(keyframe.constraint.boundId);
    setPlaying(false);
    setPreviewUntil(null);
    setInspector("sequence");
    setCurrentTime(Math.min(duration, keyframe.time));
  }

  function stepCameraKeyframe(direction: -1 | 1) {
    const keyframes = cameraTrack?.keyframes ?? [];
    if (!keyframes.length) return;
    const target = direction < 0
      ? [...keyframes].reverse().find((item) => item.time < currentTime - 0.001) ?? keyframes[0]
      : keyframes.find((item) => item.time > currentTime + 0.001) ?? keyframes.at(-1);
    if (target) selectCameraKeyframe(target.id);
  }

  function addCameraKeyframeAt(requestedTime: number) {
    const existingTrack = cameraTrack ?? emptyCameraTrack();
    const time = Math.max(0, Math.min(duration, requestedTime));
    const existing = existingTrack.keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 0.001);
    if (existing) {
      selectCameraKeyframe(existing.id);
      onStatus(`A shot already exists at ${seconds(existing.time)}. It is selected; edit it instead of replacing it.`);
      return;
    }
    const renderer = spineRenderersRef.current.get(referenceLayerId);
    const artworkFrame = renderer?.getArtworkCameraFrame(cameraAspectValue(existingTrack.aspectRatio)) ?? null;
    const solved = evaluateSpineCameraTrack(existingTrack, time, 1, 1, artworkFrame, activeCameraBoundIdRef.current.boundId);
    const frame = solved?.frame ?? artworkFrame ?? { centerX: 0, centerY: 0, height: 600 };
    const selectedBound = existingTrack.safeBounds.find((bound) => bound.id === selectedCameraBoundId && bound.enabled);
    const keyframe = {
      id: cameraItemId("camera-key"),
      time,
      centerX: frame.centerX,
      centerY: frame.centerY,
      frameHeight: Math.max(0.01, frame.height),
      easing: "smooth" as const,
      ...(selectedBound ? { constraint: { mode: "manual" as const, boundId: selectedBound.id } } : {}),
    };
    updateCameraTrack((value) => ({
      ...value,
      enabled: true,
      keyframes: [...value.keyframes, keyframe].sort((a, b) => a.time - b.time),
    }));
    setSelectedCameraKeyframeId(keyframe.id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setCurrentTime(time);
    setCameraGuidesVisible(true);
  }

  function addCameraKeyframe() {
    addCameraKeyframeAt(currentTime);
  }

  function updateCameraKeyframe(id: string, patch: Partial<NonNullable<SpineCameraTrack["keyframes"]>[number]>, history = true): boolean {
    if (patch.time !== undefined && cameraTrack && !cameraKeyframeTimeAvailable(cameraTrack.keyframes, id, patch.time)) {
      setCameraKeyframeTimeIssue("Camera keyframes must have distinct times; choose a time at least 0.001 seconds away from another key.");
      return false;
    }
    setCameraKeyframeTimeIssue(null);
    updateCameraTrack((value) => ({
      ...value,
      keyframes: value.keyframes.map((keyframe) => keyframe.id === id ? { ...keyframe, ...patch } : keyframe)
        .sort((a, b) => a.time - b.time),
    }), history);
    return true;
  }

  function beginCameraShotSliderEdit(event: ReactPointerEvent<HTMLInputElement>, field: CameraShotSliderEdit["field"]) {
    if (event.button !== 0 || !selectedCameraKeyframe) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cameraShotSliderEditRef.current = { pointerId: event.pointerId, keyframeId: selectedCameraKeyframe.id, field, original: selectedCameraKeyframe, latest: selectedCameraKeyframe, edited: false };
    setPlaying(false);
  }

  function updateCameraShotSlider(field: CameraShotSliderEdit["field"], rawValue: number) {
    const selected = selectedCameraKeyframe;
    if (!selected || !Number.isFinite(rawValue)) return;
    const value = field === "time" ? Math.max(0, Math.min(duration, rawValue)) : Math.max(0.01, rawValue);
    const patch = field === "time" ? { time: value } : { frameHeight: value };
    if (field === "time" && !cameraKeyframeTimeAvailable(cameraTrack?.keyframes ?? [], selected.id, value)) {
      setCameraKeyframeTimeIssue("Camera keyframes must have distinct times; choose a time at least 0.001 seconds away from another key.");
      return;
    }
    const edit = cameraShotSliderEditRef.current;
    const changed = field === "time" ? value !== selected.time : value !== selected.frameHeight;
    if (!changed) return;
    if (edit?.keyframeId === selected.id && edit.field === field && edit.pointerId !== null) {
      if (!edit.edited) onBeginCameraEdit();
      if (!updateCameraKeyframe(selected.id, patch, false)) return;
      edit.latest = { ...edit.latest, ...patch };
      edit.edited = true;
    } else {
      if (!updateCameraKeyframe(selected.id, patch)) return;
    }
    if (field === "time") setCurrentTime(value);
  }

  function finishCameraShotSliderEdit(event: ReactPointerEvent<HTMLInputElement>, cancel = false) {
    const edit = cameraShotSliderEditRef.current;
    if (!edit || edit.pointerId !== event.pointerId) return;
    cameraShotSliderEditRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel) {
      if (edit.edited) {
        updateCameraKeyframe(edit.keyframeId, edit.original, false);
        if (edit.field === "time") setCurrentTime(edit.original.time);
        onCancelCameraEdit();
      }
      return;
    }
    if (!edit.edited) return;
    const same = edit.field === "time" ? edit.latest.time === edit.original.time : edit.latest.frameHeight === edit.original.frameHeight;
    if (same) onCancelCameraEdit();
    else onEndCameraEdit();
  }

  function cameraTimeFromClientX(clientX: number): number | null {
    const rect = cameraKeyframeStripRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return Math.max(0, Math.min(duration, (clientX - rect.left) / rect.width * duration));
  }

  function beginCameraKeyframeRetime(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    const keyframe = cameraTrack?.keyframes.find((item) => item.id === id);
    if (!keyframe) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cameraKeyframeDragRef.current = { pointerId: event.pointerId, keyframeId: id, original: keyframe, element: event.currentTarget, playhead: currentTime, latestTime: keyframe.time, edited: false };
    setSelectedCameraKeyframeId(id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setPreviewUntil(null);
    setCurrentTime(keyframe.time);
  }

  function moveCameraKeyframeRetime(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = cameraKeyframeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    let nextTime = cameraTimeFromClientX(event.clientX);
    const rect = cameraKeyframeStripRef.current?.getBoundingClientRect();
    if (nextTime === null || !rect) return;
    const keys = cameraTrack?.keyframes ?? [];
    if (!event.altKey) {
      const minimumGap = 0.001;
      const candidates = [
        0,
        duration,
        drag.playhead,
        ...keys.filter((item) => item.id !== drag.keyframeId).flatMap((item) => [item.time - minimumGap, item.time + minimumGap]),
      ].filter((time) => time >= 0 && time <= duration);
      const threshold = Math.max(0.025, duration * 9 / rect.width);
      const nearest = candidates.reduce<{ time: number; distance: number } | null>((best, time) => {
        const distance = Math.abs(time - nextTime!);
        return distance <= threshold && (!best || distance < best.distance) ? { time, distance } : best;
      }, null);
      if (nearest) nextTime = nearest.time;
    }
    const next = retimeSpineCameraKeyframe(drag.original, nextTime, duration);
    if (!next) return;
    if (!cameraKeyframeTimeAvailable(cameraTrack?.keyframes ?? [], drag.keyframeId, next.time)) {
      setCameraKeyframeTimeIssue("Camera keyframes must have distinct times; choose a time at least 0.001 seconds away from another key.");
      return;
    }
    if (next.time !== drag.original.time && !drag.edited) {
      onBeginCameraEdit();
      drag.edited = true;
    }
    if (updateCameraKeyframe(drag.keyframeId, { time: next.time }, false)) {
      drag.latestTime = next.time;
      setCurrentTime(next.time);
      setCameraKeyframeTimeIssue(null);
    }
  }

  function endCameraKeyframeRetime(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = cameraKeyframeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    cameraKeyframeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.edited) {
      if (drag.latestTime === drag.original.time) onCancelCameraEdit();
      else onEndCameraEdit();
    }
  }

  function cancelCameraKeyframeRetime(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = cameraKeyframeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    cameraKeyframeDragRef.current = null;
    updateCameraKeyframe(drag.keyframeId, drag.original, false);
    setCurrentTime(drag.original.time);
    setCameraKeyframeTimeIssue(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.edited) onCancelCameraEdit();
  }

  function assignCameraKeyframeBound(id: string, assignment: string) {
    updateCameraTrack((value) => ({
      ...value,
      keyframes: value.keyframes.map((keyframe) => {
        if (keyframe.id !== id) return keyframe;
        const inherited = { ...keyframe };
        delete inherited.constraint;
        if (assignment === "inherit") return inherited;
        if (assignment === "automatic") return { ...inherited, constraint: { mode: "automatic" as const } };
        if (assignment === "none") return { ...inherited, constraint: { mode: "none" as const } };
        return { ...inherited, constraint: { mode: "manual" as const, boundId: assignment } };
      }),
    }));
    if (assignment !== "inherit" && assignment !== "automatic" && assignment !== "none") setSelectedCameraBoundId(assignment);
  }

  function addCameraBound() {
    const value = cameraTrack ?? emptyCameraTrack();
    const rendererFrame = spineRenderersRef.current.get(referenceLayerId)?.getCameraFrame();
    const frame = rendererFrame ?? { centerX: 0, centerY: 0, height: 600 };
    const width = Math.max(1, frame.height * (value.aspectRatio === "16:9" ? 16 / 9 : value.aspectRatio === "4:3" ? 4 / 3 : 1) * 1.5);
    const height = Math.max(1, frame.height * 1.5);
    const bound: SpineCameraSafeBound = {
      id: cameraItemId("safe-bound"),
      name: `Safe bound ${value.safeBounds.length + 1}`,
      x: frame.centerX - width / 2,
      y: frame.centerY - height / 2,
      width,
      height,
      enabled: true,
      priority: value.safeBounds.length,
    };
    updateCameraTrack((track) => ({ ...track, enabled: true, safeBounds: [...track.safeBounds, bound] }));
    setSelectedCameraBoundId(bound.id);
    setCameraInspectorTarget("boundary");
    setCameraEditMode("boundaries");
    setCameraTool("select");
    setCameraGuidesVisible(true);
  }

  function updateCameraBound(id: string, patch: Partial<SpineCameraSafeBound>, history = true) {
    updateTimeline((value) => ({
      ...value,
      camera: (() => {
        const camera = value.camera ?? emptyCameraTrack();
        return { ...camera, safeBounds: camera.safeBounds.map((bound) => bound.id === id ? { ...bound, ...patch } : bound) };
      })(),
    }), history);
  }

  function duplicateCameraBound(id: string) {
    const bound = cameraTrack?.safeBounds.find((item) => item.id === id);
    if (!bound) return;
    const copy: SpineCameraSafeBound = {
      ...bound,
      id: cameraItemId("safe-bound"),
      name: `${bound.name} copy`,
      x: bound.x + bound.width * 0.05,
      y: bound.y - bound.height * 0.05,
      priority: cameraTrack?.safeBounds.length ?? 0,
    };
    updateCameraTrack((value) => ({ ...value, safeBounds: [...value.safeBounds, copy] }));
    setSelectedCameraBoundId(copy.id);
    setCameraInspectorTarget("boundary");
    setCameraEditMode("boundaries");
  }

  function duplicateCameraKeyframeAtTime(id: string, requestedTime: number) {
    const sourceKey = cameraTrack?.keyframes.find((item) => item.id === id);
    if (!sourceKey) return;
    const time = Math.max(0, Math.min(duration, requestedTime));
    const collision = cameraTrack?.keyframes.find((item) => Math.abs(item.time - time) < 0.001);
    if (collision) {
      selectCameraKeyframe(collision.id);
      onStatus(`Cannot duplicate here: a shot already exists at ${seconds(collision.time)}.`);
      return;
    }
    const duplicate = { ...sourceKey, id: cameraItemId("camera-key"), time };
    updateCameraTrack((value) => ({ ...value, keyframes: [...value.keyframes, duplicate].sort((a, b) => a.time - b.time) }));
    setSelectedCameraKeyframeId(duplicate.id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setCurrentTime(time);
    onStatus(`Duplicated shot to ${seconds(time)}.`);
  }

  function pasteCameraShotAtTime(requestedTime: number) {
    const copied = cameraShotClipboardRef.current;
    if (!copied) return;
    const track = cameraTrack ?? emptyCameraTrack();
    const time = Math.max(0, Math.min(duration, requestedTime));
    const collision = track.keyframes.find((item) => Math.abs(item.time - time) < 0.001);
    if (collision) {
      selectCameraKeyframe(collision.id);
      onStatus(`Cannot paste here: a shot already exists at ${seconds(collision.time)}.`);
      return;
    }
    const pasted = { ...copied, id: cameraItemId("camera-key"), time };
    updateCameraTrack((value) => ({ ...value, enabled: true, keyframes: [...value.keyframes, pasted].sort((a, b) => a.time - b.time) }));
    setSelectedCameraKeyframeId(pasted.id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setCurrentTime(time);
  }

  function deleteCameraKeyframe(id: string) {
    const keyframes = cameraTrack?.keyframes ?? [];
    if (!keyframes.some((item) => item.id === id)) return;
    const next = keyframes.filter((item) => item.id !== id);
    updateCameraTrack((value) => ({ ...value, keyframes: next }));
    if (selectedCameraKeyframeId === id) {
      const replacement = next[0] ?? null;
      setSelectedCameraKeyframeId(replacement?.id ?? null);
      setCameraInspectorTarget(replacement ? "shot" : "settings");
      if (replacement) setCameraEditMode("shots");
      if (replacement) setCurrentTime(replacement.time);
    }
  }

  function frameCameraShotInScene(id: string) {
    const shot = cameraTrack?.keyframes.find((item) => item.id === id);
    const stage = stageRef.current;
    if (!shot || !stage) return;
    const aspect = cameraAspectValue(cameraTrack?.aspectRatio ?? "16:9");
    const worldWidth = shot.frameHeight * aspect;
    const topLeft = projectCameraPoint(shot.centerX - worldWidth / 2, shot.centerY + shot.frameHeight / 2);
    const bottomRight = projectCameraPoint(shot.centerX + worldWidth / 2, shot.centerY - shot.frameHeight / 2);
    const viewport = stage.getBoundingClientRect();
    if (!topLeft || !bottomRight) return;
    setStageView(fitStageView({ width: viewport.width, height: viewport.height }, {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    }));
  }

  function cameraBoundaryForShot(shot: SpineCameraTrack["keyframes"][number]): string | null {
    const constraint = shot.constraint ?? cameraTrack?.constraint;
    if (constraint?.mode === "manual") return constraint.boundId;
    return selectedCameraBoundId ?? solvedCamera?.activeBoundId ?? null;
  }

  function openCameraContextMenuAt(x: number, y: number, target: CameraContextTarget, returnFocusTo: HTMLElement | SVGElement | null) {
    if (target.kind === "shot") {
      setSelectedCameraKeyframeId(target.id);
      setCameraInspectorTarget("shot");
      setCameraEditMode("shots");
    }
    if (target.kind === "boundary") {
      setSelectedCameraBoundId(target.id);
      setCameraInspectorTarget("boundary");
      setCameraEditMode("boundaries");
    }
    setCameraContextMenu({ x, y, target, returnFocusTo });
  }

  function openCameraContextMenu(event: React.MouseEvent<Element>, target: CameraContextTarget) {
    if (isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    openCameraContextMenuAt(event.clientX, event.clientY, target, event.currentTarget as HTMLElement | SVGElement);
  }

  function openCameraKeyboardContextMenu(event: ReactKeyboardEvent<HTMLElement>, target: CameraContextTarget) {
    if (!isContextMenuShortcut(event) || isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openCameraContextMenuAt(bounds.left, bounds.bottom, target, event.currentTarget);
  }

  function cameraContextActions(target: CameraContextTarget) {
    type Action = ContextMenuAction;
    const shot = target.kind === "shot" ? cameraTrack?.keyframes.find((item) => item.id === target.id) ?? null : null;
    const bound = target.kind === "boundary" ? cameraTrack?.safeBounds.find((item) => item.id === target.id) ?? null : null;
    const selectedShot = cameraTrack?.keyframes.find((item) => item.id === selectedCameraKeyframeId) ?? null;
    const selectedAt = target.kind === "timeline" ? target.time : currentTime;
    const occupiedAtSelected = cameraTrack?.keyframes.some((item) => Math.abs(item.time - selectedAt) < 0.001) ?? false;
    if (target.kind === "empty") return [
      { label: "Deselect", run: () => { setSelectedCameraBoundId(null); setSelectedCameraKeyframeId(null); setCameraInspectorTarget("settings"); } },
      { label: "Camera settings", run: () => setCameraInspectorTarget("settings") },
      { label: "Add shot at playhead", run: addCameraKeyframe },
      { label: "Draw boundary", run: () => { setCameraEditMode("boundaries"); setCameraTool("draw"); setCameraBoundDrawing(true); setCameraGuidesVisible(true); } },
      { label: "Fit scene", run: () => { setStageView(resetStageView()); spineRenderersRef.current.get(referenceLayerId)?.resetCamera(); } },
    ] satisfies Action[];
    if (target.kind === "timeline") return [
      { label: `Add shot at ${seconds(target.time)}`, disabled: occupiedAtSelected, reason: occupiedAtSelected ? "A shot already occupies this time." : undefined, run: () => addCameraKeyframeAt(target.time) },
      { label: `Duplicate selected shot here · ${seconds(target.time)}`, disabled: !selectedShot || occupiedAtSelected, reason: !selectedShot ? "Select a shot first." : occupiedAtSelected ? "A shot already occupies this time." : undefined, run: () => selectedShot && duplicateCameraKeyframeAtTime(selectedShot.id, target.time) },
      { label: "Paste copied shot here", disabled: !cameraShotClipboardRef.current || occupiedAtSelected, reason: !cameraShotClipboardRef.current ? "Copy a shot first." : occupiedAtSelected ? "A shot already occupies this time." : undefined, run: () => pasteCameraShotAtTime(target.time) },
      { label: "Delete selected shot", disabled: !selectedShot, reason: !selectedShot ? "Select a shot first." : undefined, run: () => selectedShot && deleteCameraKeyframe(selectedShot.id) },
    ] satisfies Action[];
    if (target.kind === "shot" && shot) {
      const boundId = cameraBoundaryForShot(shot);
      const assignedBound = boundId ? cameraTrack?.safeBounds.find((item) => item.id === boundId && item.enabled) : null;
      const collision = cameraTrack?.keyframes.some((item) => Math.abs(item.time - currentTime) < 0.001) ?? false;
      return [
       { label: "Edit properties", run: () => { setCameraInspectorTarget("shot"); setSelectedCameraKeyframeId(shot.id); setCameraEditMode("shots"); onWorkspaceChange("camera"); } },
        { label: "Seek to shot", run: () => { setPlaying(false); setCurrentTime(shot.time); } },
        { label: "Frame in scene", run: () => frameCameraShotInScene(shot.id) },
        { label: "Duplicate at playhead", disabled: collision, reason: collision ? "A shot already occupies the playhead." : undefined, run: () => duplicateCameraKeyframeAtTime(shot.id, currentTime) },
        { label: assignedBound ? `Fit to ${assignedBound.name}` : "Fit to selected boundary", disabled: !assignedBound, reason: !assignedBound ? "Select or assign an enabled boundary first." : undefined, run: () => assignedBound && fitSelectedCameraShotToBound(assignedBound.id) },
        { label: "Copy shot", run: () => { cameraShotClipboardRef.current = { ...shot }; onStatus(`Copied shot at ${seconds(shot.time)}.`); } },
        { label: "Delete shot", danger: true, separatorBefore: true, run: () => deleteCameraKeyframe(shot.id) },
      ] satisfies Action[];
    }
    if (target.kind === "boundary" && bound) return [
       { label: "Edit properties", run: () => { setCameraInspectorTarget("boundary"); setCameraEditMode("boundaries"); onWorkspaceChange("camera"); } },
      { label: "Frame in scene", run: () => frameCameraBoundInScene(bound.id) },
      { label: "Fit selected shot to boundary", disabled: !selectedShot || !bound.enabled, reason: !selectedShot ? "Select a shot first." : !bound.enabled ? "Enable this boundary first." : undefined, run: () => fitSelectedCameraShotToBound(bound.id) },
      { label: "Create fitted shot here", disabled: !bound.enabled || occupiedAtSelected, reason: !bound.enabled ? "Enable this boundary first." : occupiedAtSelected ? "A shot already occupies this time." : undefined, run: () => createCameraShotFittedToBound(bound.id) },
      { label: "Duplicate boundary", run: () => duplicateCameraBound(bound.id) },
      { label: bound.locked ? "Unlock boundary" : "Lock boundary", run: () => updateCameraBound(bound.id, { locked: !bound.locked }) },
      { label: bound.visible === false ? "Show guide" : "Hide guide", run: () => updateCameraBound(bound.id, { visible: bound.visible === false }) },
      { label: bound.enabled ? "Disable boundary" : "Enable boundary", run: () => updateCameraBound(bound.id, { enabled: !bound.enabled }) },
      { label: "Delete boundary", danger: true, separatorBefore: true, run: () => deleteCameraBound(bound.id) },
    ] satisfies Action[];
    return [] satisfies Action[];
  }

  function renderCameraContextMenu() {
    if (!cameraContextMenu) return null;
    const actions = cameraContextActions(cameraContextMenu.target);
    return <CameraContextMenu
      x={cameraContextMenu.x}
      y={cameraContextMenu.y}
      actions={actions}
      onClose={() => setCameraContextMenu(null)}
      onEscape={() => { setCameraContextMenu(null); stageRef.current?.focus(); }}
      returnFocusTo={cameraContextMenu.returnFocusTo}
    />;
  }

  function fitSelectedCameraShotToBound(id: string) {
    const bound = cameraTrack?.safeBounds.find((item) => item.id === id && item.enabled);
    const selected = cameraTrack?.keyframes.find((item) => item.id === selectedCameraKeyframeId);
    if (!bound || !selected) {
      onStatus("Select a camera shot first, then use Fit selected shot to boundary.");
      return;
    }
    const track = cameraTrack ?? emptyCameraTrack();
    updateCameraTrack((value) => ({
      ...value,
      enabled: true,
      keyframes: value.keyframes.map((keyframe) => keyframe.id === selected.id ? {
        ...keyframe,
        centerX: bound.x + bound.width / 2,
        centerY: bound.y + bound.height / 2,
        frameHeight: Math.max(0.01, cameraFrameHeightForBound(bound, track.aspectRatio)),
        constraint: { mode: "manual" as const, boundId: bound.id },
      } : keyframe),
    }));
    setSelectedCameraBoundId(bound.id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setCurrentTime(selected.time);
    setCameraGuidesVisible(true);
    onStatus(`Fitted selected shot at ${seconds(selected.time)} to ${bound.name}.`);
  }

  function createCameraShotFittedToBound(id: string) {
    const bound = cameraTrack?.safeBounds.find((item) => item.id === id && item.enabled);
    if (!bound || !cameraTrack) return;
    const time = Math.max(0, Math.min(duration, currentTime));
    const existing = cameraTrack.keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 0.001);
    if (existing) {
      selectCameraKeyframe(existing.id);
      onStatus(`A shot already exists at ${seconds(existing.time)}. Select another time or fit the selected shot.`);
      return;
    }
    const keyframe = {
      id: cameraItemId("camera-key"),
      time,
      centerX: bound.x + bound.width / 2,
      centerY: bound.y + bound.height / 2,
      frameHeight: Math.max(0.01, cameraFrameHeightForBound(bound, cameraTrack.aspectRatio)),
      easing: "smooth" as const,
      constraint: { mode: "manual" as const, boundId: bound.id },
    };
    updateCameraTrack((value) => ({ ...value, enabled: true, keyframes: [...value.keyframes, keyframe].sort((a, b) => a.time - b.time) }));
    setSelectedCameraKeyframeId(keyframe.id);
    setSelectedCameraBoundId(bound.id);
    setCameraInspectorTarget("shot");
    setCameraEditMode("shots");
    setPlaying(false);
    setCurrentTime(time);
    setCameraGuidesVisible(true);
  }

  function updateSelectedShotFromOutput() {
    const selected = cameraTrack?.keyframes.find((item) => item.id === selectedCameraKeyframeId);
    if (!selected || !solvedCamera) return;
    updateCameraKeyframe(selected.id, {
      centerX: solvedCamera.frame.centerX,
      centerY: solvedCamera.frame.centerY,
      frameHeight: solvedCamera.frame.height,
    });
    setCameraInspectorTarget("shot");
    onStatus(`Updated selected shot at ${seconds(selected.time)} from the current constrained output.`);
  }

  function frameCameraBoundInScene(id: string) {
    const bound = cameraTrack?.safeBounds.find((item) => item.id === id);
    const stage = stageRef.current;
    if (!bound || !stage) return;
    const viewport = stage.getBoundingClientRect();
    const topLeft = projectCameraPoint(bound.x, bound.y + bound.height);
    const bottomRight = projectCameraPoint(bound.x + bound.width, bound.y);
    if (!topLeft || !bottomRight) return;
    setStageView(fitStageView({ width: viewport.width, height: viewport.height }, {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    }));
  }

  function cameraBoundCanvasPoint(event: ReactPointerEvent<SVGElement>): CameraCanvasPoint | null {
    const size = cameraProjectionSize;
    const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement;
    const rect = svg?.getBoundingClientRect();
    if (!size || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const visiblePoint = {
      x: (event.clientX - rect.left) * size.width / rect.width,
      y: (event.clientY - rect.top) * size.height / rect.height,
    };
    const contentPoint = stageViewToContentPoint(stageView, visiblePoint, size);
    return {
      x: Math.max(0, Math.min(size.width, contentPoint.x)),
      y: Math.max(0, Math.min(size.height, contentPoint.y)),
    };
  }

  function cameraBoundWorldPoint(point: CameraCanvasPoint): CameraCanvasPoint | null {
    const renderer = cameraProjectionRenderer;
    const size = cameraProjectionSize;
    const frame = renderer?.getCameraFrame();
    if (!renderer || !size || !frame || size.width <= 0 || size.height <= 0) return null;
    const layer = cameraReferenceLayer;
    const scale = layer?.scale && Number.isFinite(layer.scale) ? layer.scale : 1;
    const localX = (point.x - size.width / 2 - (layer?.x ?? 0)) / scale + size.width / 2;
    const localY = (point.y - size.height / 2 - (layer?.y ?? 0)) / scale + size.height / 2;
    const frameWidth = frame.height * size.width / size.height;
    return {
      x: frame.centerX + (localX / size.width - 0.5) * frameWidth,
      y: frame.centerY + (0.5 - localY / size.height) * frame.height,
    };
  }

  function beginCameraBoundTransform(
    event: ReactPointerEvent<SVGElement>,
    boundId: string,
    transformMode: CameraBoundTransform["mode"],
    handle?: SpineCameraBoundResizeHandle,
  ) {
    if (mode !== "camera" || cameraEditMode !== "boundaries" || cameraTool !== "select" || cameraBoundDrawing || cameraSpacePanRef.current || event.button !== 0) return;
    const bound = cameraTrack?.safeBounds.find((item) => item.id === boundId);
    if (bound?.locked) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!bound || !svg) return;
    const canvasPoint = cameraBoundCanvasPoint(event);
    const worldPoint = canvasPoint ? cameraBoundWorldPoint(canvasPoint) : null;
    if (!worldPoint) return;
    event.preventDefault();
    event.stopPropagation();
    svg.setPointerCapture(event.pointerId);
    setCameraGizmoDragging(true);
    setSelectedCameraBoundId(boundId);
    setCameraInspectorTarget("boundary");
    cameraBoundTransformRef.current = { pointerId: event.pointerId, boundId, mode: transformMode, ...(handle ? { handle } : {}), last: worldPoint, original: bound, latest: bound, edited: false };
  }

  function moveCameraBoundTransform(event: ReactPointerEvent<SVGSVGElement>) {
    const active = cameraBoundTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const canvasPoint = cameraBoundCanvasPoint(event);
    const worldPoint = canvasPoint ? cameraBoundWorldPoint(canvasPoint) : null;
    if (!worldPoint) return true;
    const deltaX = worldPoint.x - active.last.x;
    const deltaY = worldPoint.y - active.last.y;
    const next = active.mode === "move"
      ? moveSpineCameraBound(active.latest, deltaX, deltaY)
      : (() => {
        const handlePoint = cameraBoundPointAtHandle(active.latest, active.handle!);
        const point = { x: handlePoint.x + deltaX, y: handlePoint.y + deltaY };
        const ratio = cameraAspectLocked
          ? event.shiftKey ? undefined : cameraAspectValue(cameraTrack?.aspectRatio ?? "16:9")
          : event.shiftKey ? active.original.width / active.original.height : undefined;
        return resizeSpineCameraBound(active.latest, active.handle!, point, 0.01, ratio, event.altKey);
      })();
    active.last = worldPoint;
    active.latest = next;
    if (!active.edited && (next.x !== active.original.x || next.y !== active.original.y || next.width !== active.original.width || next.height !== active.original.height)) {
      onBeginCameraEdit();
      active.edited = true;
    }
    updateCameraBound(active.boundId, next, false);
    return true;
  }

  function endCameraBoundTransform(event: ReactPointerEvent<SVGSVGElement>) {
    const active = cameraBoundTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    cameraBoundTransformRef.current = null;
    setCameraGizmoDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.edited) {
      const current = active.latest;
      if (current.x === active.original.x && current.y === active.original.y && current.width === active.original.width && current.height === active.original.height) onCancelCameraEdit();
      else onEndCameraEdit();
    }
    return true;
  }

  function beginCameraShotTransform(
    event: ReactPointerEvent<SVGElement>,
    transformMode: CameraShotTransform["mode"],
    handle?: SpineCameraBoundResizeHandle,
  ) {
    if (mode !== "camera" || cameraEditMode !== "shots" || cameraTool !== "select" || cameraBoundDrawing || cameraSpacePanRef.current || event.button !== 0) return;
    const keyframe = cameraTrack?.keyframes.find((item) => item.id === selectedCameraKeyframeId);
    const svg = event.currentTarget.ownerSVGElement;
    const canvasPoint = cameraBoundCanvasPoint(event);
    const worldPoint = canvasPoint ? cameraBoundWorldPoint(canvasPoint) : null;
    if (!keyframe || !svg || !worldPoint) return;
    event.preventDefault();
    event.stopPropagation();
    svg.setPointerCapture(event.pointerId);
    setCameraGizmoDragging(true);
    cameraShotTransformRef.current = { pointerId: event.pointerId, keyframeId: keyframe.id, mode: transformMode, ...(handle ? { handle } : {}), last: worldPoint, original: keyframe, latest: keyframe, edited: false };
    setCameraInspectorTarget("shot");
    setPlaying(false);
    setCurrentTime(keyframe.time);
  }

  function moveCameraShotTransform(event: ReactPointerEvent<SVGSVGElement>) {
    const active = cameraShotTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const canvasPoint = cameraBoundCanvasPoint(event);
    const worldPoint = canvasPoint ? cameraBoundWorldPoint(canvasPoint) : null;
    const track = cameraTrack;
    if (!worldPoint || !track) return true;
    const deltaX = worldPoint.x - active.last.x;
    const deltaY = worldPoint.y - active.last.y;
    const next = active.mode === "move"
      ? moveSpineCameraKeyframe(active.latest, deltaX, deltaY)
      : (() => {
        const aspect = cameraAspectValue(track.aspectRatio);
        const handlePoint = cameraShotPointAtHandle(active.latest, active.handle!, aspect);
        const point = { x: handlePoint.x + deltaX, y: handlePoint.y + deltaY };
        return resizeSpineCameraKeyframe(active.latest, active.handle!, point, aspect, 0.01, event.altKey);
      })();
    active.last = worldPoint;
    active.latest = next;
    if (!active.edited && (next.centerX !== active.original.centerX || next.centerY !== active.original.centerY || next.frameHeight !== active.original.frameHeight)) {
      onBeginCameraEdit();
      active.edited = true;
    }
    updateCameraKeyframe(active.keyframeId, { centerX: next.centerX, centerY: next.centerY, frameHeight: next.frameHeight }, false);
    return true;
  }

  function endCameraShotTransform(event: ReactPointerEvent<SVGSVGElement>) {
    const active = cameraShotTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    cameraShotTransformRef.current = null;
    setCameraGizmoDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.edited) {
      const current = active.latest;
      if (current.centerX === active.original.centerX && current.centerY === active.original.centerY && current.frameHeight === active.original.frameHeight) onCancelCameraEdit();
      else onEndCameraEdit();
    }
    return true;
  }

  function cancelCameraShotTransform(event: ReactPointerEvent<SVGSVGElement>) {
    const active = cameraShotTransformRef.current;
    if (!active || active.pointerId !== event.pointerId) return false;
    cameraShotTransformRef.current = null;
    setCameraGizmoDragging(false);
    updateCameraKeyframe(active.keyframeId, active.original, false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.edited) onCancelCameraEdit();
    return true;
  }

  function handleCameraOverlayLostPointerCapture(event: ReactPointerEvent<SVGSVGElement>) {
    const bound = cameraBoundTransformRef.current;
    if (bound?.pointerId === event.pointerId) {
      cameraBoundTransformRef.current = null;
      setCameraGizmoDragging(false);
      updateCameraBound(bound.boundId, bound.original, false);
      if (bound.edited) onCancelCameraEdit();
    }
    const shot = cameraShotTransformRef.current;
    if (shot?.pointerId === event.pointerId) {
      cameraShotTransformRef.current = null;
      setCameraGizmoDragging(false);
      updateCameraKeyframe(shot.keyframeId, shot.original, false);
      if (shot.edited) onCancelCameraEdit();
    }
    if (cameraBoundDrawRef.current?.pointerId === event.pointerId) cancelCameraBoundDraw();
  }

  function beginCameraBoundDraw(event: ReactPointerEvent<SVGSVGElement>) {
    if (mode !== "camera" || cameraTool !== "draw" || !cameraBoundDrawing || cameraSpacePanRef.current || event.button !== 0) return;
    const point = cameraBoundCanvasPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const draft = { pointerId: event.pointerId, start: point, end: point };
    cameraBoundDrawRef.current = draft;
    setCameraBoundDraft(draft);
  }

  function moveCameraBoundDraw(event: ReactPointerEvent<SVGSVGElement>) {
    if (moveCameraBoundTransform(event)) return;
    if (moveCameraShotTransform(event)) return;
    const active = cameraBoundDrawRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const end = cameraBoundCanvasPoint(event);
    if (!end) return;
    const draft = { ...active, end };
    cameraBoundDrawRef.current = draft;
    setCameraBoundDraft(draft);
  }

  function endCameraBoundDraw(event: ReactPointerEvent<SVGSVGElement>) {
    if (endCameraBoundTransform(event)) return;
    if (endCameraShotTransform(event)) return;
    const active = cameraBoundDrawRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const end = cameraBoundCanvasPoint(event) ?? active.end;
    cameraBoundDrawRef.current = null;
    setCameraBoundDraft(null);
    setCameraBoundDrawing(false);
    setCameraTool("select");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (Math.abs(end.x - active.start.x) < 4 || Math.abs(end.y - active.start.y) < 4) {
      onStatus("Drag at least 4 preview pixels in both directions to draw a camera bound.");
      return;
    }
    const renderer = spineRenderersRef.current.get(referenceLayerId);
    const frame = renderer?.getCameraFrame();
    const size = renderer?.canvasClientSize();
    if (!frame || !size) {
      onStatus("The scene preview is not ready to create a camera bound.");
      return;
    }
    const existingBounds = cameraTrack?.safeBounds ?? [];
    const bound = spineCameraBoundFromCanvasDrag(
      cameraItemId("safe-bound"),
      `Safe bound ${existingBounds.length + 1}`,
      active.start,
      end,
      frame,
      size.width,
      size.height,
      existingBounds.length,
      cameraAspectLocked ? cameraAspectValue(cameraTrack?.aspectRatio ?? "16:9") : undefined,
    );
    if (!bound) return;
    updateCameraTrack((value) => ({ ...value, enabled: true, safeBounds: [...value.safeBounds, bound] }));
    setSelectedCameraBoundId(bound.id);
    setCameraInspectorTarget("boundary");
    setCameraEditMode("boundaries");
    setCameraTool("select");
    setCameraGuidesVisible(true);
    onStatus(`Added ${bound.name}. Authored camera output will stay within this scene region.`);
  }

  function cancelCameraBoundDraw() {
    cameraBoundDrawRef.current = null;
    setCameraBoundDraft(null);
    setCameraBoundDrawing(false);
    setCameraTool("select");
  }

  function deleteCameraBound(id: string) {
    const value = cameraTrack;
    if (!value) return;
    const referenced = value.constraint.mode === "manual" && value.constraint.boundId === id
      || value.keyframes.some((keyframe) => keyframe.constraint?.mode === "manual" && keyframe.constraint.boundId === id);
    if (referenced && !window.confirm("This safe bound is assigned to a manual camera constraint. Delete it and switch those references to Automatic?")) return;
    updateCameraTrack((track) => ({
      ...track,
      safeBounds: track.safeBounds.filter((bound) => bound.id !== id),
      constraint: track.constraint.mode === "manual" && track.constraint.boundId === id ? { mode: "automatic" } : track.constraint,
      keyframes: track.keyframes.map((keyframe) => keyframe.constraint?.mode === "manual" && keyframe.constraint.boundId === id
        ? { ...keyframe, constraint: { mode: "automatic" } }
        : keyframe),
    }));
    if (selectedCameraBoundId === id) {
      setSelectedCameraBoundId(null);
      setCameraInspectorTarget("settings");
    }
  }

  function layerAnimation(layer: EditorTimelineLayer): string {
    const meta = metas[layer.id];
    if (!meta || !timeline) return layer.animation || meta?.idleAnimation || "";
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
        name: sequenceDisplayName(id),
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
      sequence: structuredClone(timeline),
      animationInfo: timeline.layers.map((layer) => ({
        layerId: layer.id,
        directory: layer.directory,
        animations: (metas[layer.id]?.animations ?? []).map((name) => ({ name, duration: animationDurations[`${layer.id}:${name}`] ?? null })),
      })),
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

  async function previewMcpSubtitleImport(command: Extract<EditorMcpCommand, { name: "preview_subtitle_import" }>) {
    if (!timeline || !project || !source) throw new Error("Load a project and open its timeline before previewing subtitle imports.");
    const sequenceId = timeline.sequenceId ?? "opening";
    const lineNumber = sequenceId === "opening" ? 0 : Number(sequenceId.match(/^talk-(\d+)$/i)?.[1]);
    if (!Number.isFinite(lineNumber)) throw new Error("Subtitle import preview supports the opening and numbered Talk sequences.");
    const content = await source.readText(command.path);
    if (content === null) throw new Error(`Subtitle source not found in the current asset root: ${command.path}`);
    if (projectRef.current !== project || (projectRef.current?.timeline.sequenceId ?? "opening") !== sequenceId) throw new Error("The project or active sequence changed while the subtitle source was being read. Preview the import again.");
    const raw = JSON.parse(content) as Record<string, unknown>;
    const sourceFile = Array.isArray(raw.characters)
      ? raw.characters.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).directory === directory) as Record<string, unknown> | undefined
      : raw;
    if (!sourceFile || !Array.isArray(sourceFile.lines)) throw new Error(`No subtitle lines were found for ${directory} in ${command.path}.`);
    const line = (sourceFile.lines as unknown[]).find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const id = String((entry as Record<string, unknown>).id ?? "");
      return Number(id.match(/(\d+)$/)?.[1]) === lineNumber;
    }) as Record<string, unknown> | undefined;
    if (!line) throw new Error(`No subtitle source line was found for ${sequenceId} in ${command.path}.`);
    const lineId = String(line.id ?? "");
    const existing = [...timeline.subtitles].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const imported = importedSubtitleCues({ lines: [line] }).cues;
    const matching = existing.filter((cue) => cue.lineId === lineId);
    const linkedCueIds = new Set(timeline.audio.flatMap((clip) => clip.subtitleId ? [clip.subtitleId] : []));
    let linkedPreserved = 0;
    const report = {
      sourcePath: command.path,
      sequenceId,
      lineId,
      policy: command.policy,
      audioClipCount: timeline.audio.length,
      audioUnchanged: true,
      availableTranslations: (Object.keys(imported[0]?.text ?? {}) as TimelineLanguage[]).filter((language) => imported.some((cue) => cue.text[language].trim())),
    };
    const replacements = imported.map((cue, index) => {
      const previous = matching[index];
      const id = previous?.id ?? `mcp-subtitle-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      if (command.policy === "merge-missing-translations" && previous) {
        return { ...previous, text: {
          en: previous.text.en.trim() ? previous.text.en : cue.text.en,
          ja: previous.text.ja.trim() ? previous.text.ja : cue.text.ja,
          ko: previous.text.ko.trim() ? previous.text.ko : cue.text.ko,
        }, lineId };
      }
      if (command.policy === "update-text-only" && previous) return { ...previous, text: cue.text, lineId };
      return { ...cue, id, enabled: previous?.enabled ?? true, lineId };
    });
    let after: EditorSubtitleCue[];
    if (command.policy === "replace-imported-cues") {
      const preservedLinked = matching.filter((cue) => linkedCueIds.has(cue.id) && !replacements.some((replacement) => replacement.id === cue.id));
      linkedPreserved = preservedLinked.length;
      after = [...existing.filter((cue) => cue.lineId !== lineId), ...replacements, ...preservedLinked].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    } else if (command.policy === "merge-missing-translations") {
      const translatedById = new Map(matching.map((cue, index) => [cue.id, replacements[index] ?? cue]));
      after = [...existing.map((cue) => translatedById.get(cue.id) ?? cue), ...replacements.slice(matching.length)].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    } else {
      const updated = new Map(matching.map((cue, index) => [cue.id, replacements[index] ?? cue]));
      after = existing.map((cue) => updated.get(cue.id) ?? cue);
    }
    const beforeById = new Map(existing.map((cue) => [cue.id, cue]));
    const afterById = new Map(after.map((cue) => [cue.id, cue]));
    const added = after.filter((cue) => !beforeById.has(cue.id)).length;
    const removed = existing.filter((cue) => !afterById.has(cue.id)).length;
    const updated = after.filter((cue) => {
      const previous = beforeById.get(cue.id);
      return previous && JSON.stringify(previous) !== JSON.stringify(cue);
    }).length;
    const changeSetId = `subtitle-import-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const duration = Math.max(0, ...replacements.map((cue) => cue.end));
    const changeReport = {
      ...report,
      changeSetId,
      counts: { added, updated, removed, unchanged: Math.max(0, after.length - added - updated), explicitAudioLinksPreserved: linkedPreserved },
      warnings: command.policy === "update-text-only" && imported.length > matching.length
        ? [`${imported.length - matching.length} source cue(s) have no existing imported cue; update-text-only does not add them.`]
        : linkedPreserved > 0 ? [`${linkedPreserved} cue(s) retained because audio clips have explicit links to them.`] : [],
      beforeCues: matching,
      afterCues: after.filter((cue) => cue.lineId === lineId),
    };
    const changeSets = mcpSubtitleChangeSetsRef.current;
    changeSets.set(changeSetId, { project, sequenceId, path: command.path, policy: command.policy, before: timeline.subtitles, after, duration, report: changeReport });
    while (changeSets.size > 20) changeSets.delete(changeSets.keys().next().value!);
    return changeReport;
  }

  async function executeMcpCommand(command: EditorMcpCommand): Promise<unknown> {
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
      case "add_animation_clip": {
        const layer = timeline.layers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Spine layer not found: ${command.layerId}`);
        if (layer.locked) throw new Error("The Spine layer is locked.");
        const meta = metas[layer.id];
        if (!meta?.animations.includes(command.animation)) throw new Error(`Animation ${command.animation} is not available on layer ${layer.name}.`);
        if (command.faceAnimation && !meta.animations.includes(command.faceAnimation)) throw new Error(`Secondary animation ${command.faceAnimation} is not available on layer ${layer.name}.`);
        const animationDuration = animationDurations[`${layer.id}:${command.animation}`] ?? 0;
        const end = command.end ?? command.start + Math.max(0.01, animationDuration || 2);
        if (end < command.start + 0.01) throw new Error("Animation clip end must be at least 0.01 seconds after its start.");
        const clip: EditorAnimationClip = {
          id: `animation-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          animation: command.animation,
          start: command.start,
          end,
          endMode: command.end === undefined ? "auto" : "manual",
          animationOffset: 0,
          loop: command.loop ?? false,
          enabled: true,
          ...(command.faceAnimation === undefined || command.faceAnimation === null ? {} : { faceAnimation: command.faceAnimation }),
          ...(command.continueAfterOpening === undefined ? {} : { continueAfterOpening: command.continueAfterOpening }),
        };
        const clips = insertAnimationClipRipple(layerAnimationClips(layer), clip);
        updateTimeline((value) => extendTimelineDuration({ ...value, layers: value.layers.map((item) => item.id === layer.id ? { ...item, animationClips: clips } : item), selectedLayerId: layer.id, selectedColorLayerId: null, selectedColorClipId: null }));
        setSelectedClips([{ kind: "animation", id: clip.id }]);
        setInspector("animation");
        return { clipId: clip.id, layerId: layer.id, start: clip.start, end: clip.end, endMode: clip.endMode, animationDuration: animationDuration || null };
      }
      case "update_animation_clip": {
        const found = findAnimationClip(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        const nextAnimation = command.patch.animation ?? found.clip.animation;
        if (!metas[found.layer.id]?.animations.includes(nextAnimation)) throw new Error(`Animation ${nextAnimation} is not available on layer ${found.layer.name}.`);
        const nextStart = command.patch.start ?? found.clip.start;
        const nextEnd = command.patch.end ?? found.clip.end;
        if (nextEnd < nextStart + 0.01) throw new Error("Animation clip end must be at least 0.01 seconds after its start.");
        if (command.patch.faceAnimation && !metas[found.layer.id]?.animations.includes(command.patch.faceAnimation)) throw new Error(`Secondary animation ${command.patch.faceAnimation} is not available on layer ${found.layer.name}.`);
        const { faceAnimation, ...clipPatch } = command.patch;
        const patch: Partial<EditorAnimationClip> = {
          ...clipPatch,
          ...(faceAnimation === null ? { faceAnimation: undefined } : faceAnimation === undefined ? {} : { faceAnimation }),
        };
        if (command.patch.end !== undefined && command.patch.endMode === undefined) patch.endMode = "manual";
        if (command.patch.animation && command.patch.animation !== found.clip.animation && command.patch.end === undefined && (command.patch.endMode ?? found.clip.endMode) !== "manual") {
          const duration = animationDurations[`${found.layer.id}:${command.patch.animation}`] ?? 0;
          if (duration > 0) patch.end = nextStart + Math.max(0.01, duration - (command.patch.animationOffset ?? found.clip.animationOffset));
        }
        updateAnimationClip(found.layer.id, command.clipId, patch);
        return { clipId: command.clipId, layerId: found.layer.id, updated: Object.keys(command.patch) };
      }
      case "move_animation_clip": {
        const found = findAnimationClip(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        if (command.ripple) moveAnimationClipTo(found.layer.id, command.clipId, command.start);
        else {
          const delta = command.start - found.clip.start;
          updateAnimationClip(found.layer.id, command.clipId, { start: command.start, end: Math.max(command.start + 0.01, found.clip.end + delta) });
        }
        return { clipId: command.clipId, layerId: found.layer.id, start: command.start, ripple: command.ripple };
      }
      case "delete_animation_clip": {
        const found = findAnimationClip(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        updateTimeline((value) => ({ ...value, layers: value.layers.map((layer) => {
          if (layer.id !== found.layer.id) return layer;
          const clips = layerAnimationClips(layer, value);
          const next = command.ripple ? deleteAnimationClipRipple(clips, command.clipId) : clips.filter((clip) => clip.id !== command.clipId);
          return { ...layer, animationClips: next };
        }) }));
        setSelectedClips((items) => items.filter((item) => item.id !== command.clipId));
        return { clipId: command.clipId, layerId: found.layer.id, ripple: command.ripple };
      }
      case "add_subtitle_cue": {
        const cue: EditorSubtitleCue = {
          id: `subtitle-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          start: command.start,
          end: command.end,
          enabled: true,
          text: { en: command.text.en ?? "", ja: command.text.ja ?? "", ko: command.text.ko ?? "" },
        };
        updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: [...value.subtitles, cue], selectedCueId: cue.id }));
        setSelectedClips([{ kind: "cue", id: cue.id }]);
        setInspector("cue");
        return { cueId: cue.id };
      }
      case "update_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        const start = command.patch.start ?? cue.start;
        const end = command.patch.end ?? cue.end;
        if (end < start + 0.01) throw new Error("Subtitle cue end must be at least 0.01 seconds after its start.");
        const { text, ...fields } = command.patch;
        updateCue(command.cueId, { ...fields, ...(text ? { text: { ...cue.text, ...text } } : {}) });
        return { cueId: command.cueId, updated: Object.keys(command.patch) };
      }
      case "delete_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        updateTimeline((value) => ({ ...value, subtitles: value.subtitles.filter((item) => item.id !== cue.id), audio: value.audio.map((clip) => clip.subtitleId === cue.id ? { ...clip, subtitleId: null } : clip), selectedCueId: value.selectedCueId === cue.id ? null : value.selectedCueId }));
        setSelectedClips((items) => items.filter((item) => item.id !== cue.id));
        return { cueId: cue.id, explicitAudioLinksCleared: timeline.audio.filter((clip) => clip.subtitleId === cue.id).length };
      }
      case "preview_subtitle_import":
        return previewMcpSubtitleImport(command);
      case "apply_subtitle_import": {
        const changeSet = mcpSubtitleChangeSetsRef.current.get(command.changeSetId);
        if (!changeSet) throw new Error("Subtitle change set is missing or expired; preview the import again.");
        if (changeSet.project !== projectRef.current || changeSet.sequenceId !== (timeline.sequenceId ?? "opening")) throw new Error("The project or active sequence changed after subtitle preview. Preview again before applying.");
        if (JSON.stringify(timeline.subtitles) !== JSON.stringify(changeSet.before)) throw new Error("Subtitle cues changed after preview. Preview again before applying.");
        updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: changeSet.after, duration: Math.max(value.duration, changeSet.duration) }));
        mcpSubtitleChangeSetsRef.current.delete(command.changeSetId);
        return { changeSetId: command.changeSetId, applied: true, sequenceId: changeSet.sequenceId, sourcePath: changeSet.path, policy: changeSet.policy, counts: changeSet.report.counts, audioUnchanged: true };
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
    const observer = new ResizeObserver(() => {
      setCameraProjectionRevision((value) => value + 1);
      mcpSnapshotCallbackLatestRef.current(createMcpSnapshotLatestRef.current());
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    stagePanRef.current = null;
    setStagePanning(false);
    setCameraBoundDrawing(false);
    setCameraBoundDraft(null);
    cameraBoundDrawRef.current = null;
    cameraBoundTransformRef.current = null;
    setCameraGizmoDragging(false);
    setCameraTool("select");
    if (mode !== "camera") return;
    setStageView(resetStageView());
  }, [mode]);

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

  function resetSequencePlayback() {
    if (talkAutoplayTimerRef.current !== null) window.clearTimeout(talkAutoplayTimerRef.current);
    talkAutoplayTimerRef.current = null;
    setPendingTalkSequence(null);
    setTalkAutoplayActive(false);
    currentTimeRef.current = 0;
    setCurrentTime(0); setPlaying(false); setPreviewUntil(null); setSelectedClips([]); setSelectedAudioId(null); setInspector("sequence");
  }

  function chooseSequence(id: string) {
    resetSequencePlayback();
    onMutate((current) => switchSequence(current, id, animations, directories));
  }

  function addTalkSequenceToProject() {
    if (!project) return;
    const id = nextTalkSequenceIdForProject(project, animations);
    resetSequencePlayback();
    onMutate((current) => addTalkSequence(current, animations, directories));
    onStatus(`Added ${sequenceDisplayName(id)}.`);
  }

  function deleteSequenceFromProject(id: string) {
    if (!project || id === "opening") return;
    const name = sequenceDisplayName(id);
    if (!window.confirm(`Delete ${name}? This can be undone with Undo.`)) return;
    const wasActive = timeline?.sequenceId === id;
    if (wasActive) resetSequencePlayback();
    onMutate((current) => deleteSequence(current, id, animations, directories));
    onStatus(`Deleted ${name}. Undo is available.`);
  }

  function setSequenceOrder(next: string[]) {
    if (next.length === sequenceIds.length && next.every((id, index) => id === sequenceIds[index])) return;
    onMutate((current) => ({ ...current, sequenceOrder: next }));
  }

  function moveSequenceEarlierOrLater(id: string, direction: -1 | 1) {
    setSequenceOrder(moveSequenceBy(sequenceIds, id, direction));
  }

  function beginSequenceReorder(event: ReactDragEvent<HTMLDivElement>, id: string) {
    if (id === "opening") {
      event.preventDefault();
      return;
    }
    sequenceDragRef.current = id;
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  }

  function dropSequenceReorder(event: ReactDragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || sequenceDragRef.current;
    sequenceDragRef.current = null;
    if (!sourceId || targetId === "opening") return;
    const sourceIndex = sequenceIds.indexOf(sourceId);
    const targetIndex = sequenceIds.indexOf(targetId);
    if (sourceIndex < 1 || targetIndex < 1) return;
    const targetBounds = event.currentTarget.getBoundingClientRect();
    const insertAfterTarget = event.clientY >= targetBounds.top + targetBounds.height / 2;
    const insertionIndex = targetIndex + (insertAfterTarget ? 1 : 0);
    const finalIndex = insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
    setSequenceOrder(moveSequenceId(sequenceIds, sourceId, finalIndex));
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
      const stopAt = selectionLoopRange?.end ?? (previewUntil === null ? duration : Math.min(duration, previewUntil));
      const advanced = selectionLoopRange
        ? advanceTimelineRangeLoop(currentTimeRef.current, delta, speed, selectionLoopRange)
        : advanceSpineTimeline(currentTimeRef.current, delta, speed, stopAt, previewUntil === null && Boolean(timeline?.loop) && !talkAutoplayActive);
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
  }, [audioPreloadsReady, duration, isTalkSequence, loopTalkList, playing, previewUntil, selectionLoopRange, speed, talkAutoplayActive, talkSequenceIds, timeline?.audio, timeline?.loop, timeline?.sequenceId]);

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

  useEffect(() => {
    if (mode !== "camera") setCameraContextMenu(null);
  }, [mode]);

  useEffect(() => {
    if (mode !== "camera" || cameraContextMenu) return;
    const escapeCameraInteraction = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelCameraOperationOrSelection();
      stageRef.current?.focus();
    };
    document.addEventListener("keydown", escapeCameraInteraction);
    return () => document.removeEventListener("keydown", escapeCameraInteraction);
  }, [mode, cameraContextMenu, cameraBoundDrawing]);

  function updateTimeline(mutator: (timeline: EditorProject["timeline"]) => EditorProject["timeline"], history = true) {
    const callback = history ? onMutate : onLive;
    callback((current) => ({ ...current, timeline: mutator(current.timeline) }));
  }

  function updateTimelineSelection(mutator: (timeline: EditorProject["timeline"]) => EditorProject["timeline"], contextSelection = false) {
    if (contextSelection) onSelectProject?.((current) => ({ ...current, timeline: mutator(current.timeline) }));
    else updateTimeline(mutator, false);
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

  function animationLengthMatchAnimation(layer: EditorTimelineLayer, requestedAnimation: string): string {
    return requestedAnimation || layer.animation || metas[layer.id]?.idleAnimation || "";
  }

  function animationLengthMatchInfo(layer: EditorTimelineLayer, requestedAnimation: string): { animation: string; duration: number } | null {
    if (layer.locked || layer.followMainAnimation) return null;
    const animation = animationLengthMatchAnimation(layer, requestedAnimation);
    if (!animation) return null;
    const duration = animationDurations[`${layer.id}:${animation}`] ?? 0;
    return Number.isFinite(duration) && duration > 0 ? { animation, duration } : null;
  }

  function matchAnimationLength(layer: EditorTimelineLayer, clip?: EditorAnimationClip) {
    const info = animationLengthMatchInfo(layer, clip?.animation ?? layer.animation);
    if (!info) return;
    const end = matchedAnimationEndpoint(clip ?? layer, info.duration);
    if (end === null) return;
    const legacyLayerClip = clip && !Array.isArray(layer.animationClips) && !clip.id.endsWith("-legacy-intro");
    if (clip && !legacyLayerClip) {
      updateAnimationClip(layer.id, clip.id, { endMode: "auto", end, loop: false });
    } else {
      updateLayer(layer.id, { endMode: "auto", end, loop: false });
    }
    onStatus(`Matched to Spine duration: ${seconds(info.duration)}.`);
  }

  function matchAnimationLengthButton(layer: EditorTimelineLayer, clip?: EditorAnimationClip) {
    const requestedAnimation = clip?.animation ?? layer.animation;
    const animation = animationLengthMatchAnimation(layer, requestedAnimation);
    const info = animationLengthMatchInfo(layer, requestedAnimation);
    let title = "Wait for the selected Spine animation duration to load.";
    if (layer.locked) title = "Unlock this layer to match its animation length.";
    else if (layer.followMainAnimation) title = "This layer follows the main animation; choose a fixed animation before matching its length.";
    else if (!animation) title = "Choose a Spine animation before matching its length.";
    else if (info) title = `Set End to the decoded ${info.animation} duration and disable looping.`;
    return <div className="timeline-batch-actions"><button className="editor-button" type="button" disabled={!info} title={title} onClick={() => matchAnimationLength(layer, clip)}><IconSync /> Match animation length</button></div>;
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
    const animation = layer.animation || meta.idleAnimation || "";
    if (!animation) {
      onStatus("No idle animation detected. Choose an animation explicitly on the layer before adding a clip.");
      return;
    }
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

  function duplicateAnimationClipById(clipId: string) {
    const found = findAnimationClip(clipId);
    if (!found || found.layer.locked) return;
    const id = `animation-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    updateTimeline((value) => {
      const layer = value.layers.find((item) => item.id === found.layer.id);
      if (!layer || layer.locked) return value;
      const clips = duplicateAnimationClipRipple(layerAnimationClips(layer, value), clipId, id);
      return { ...value, layers: value.layers.map((item) => item.id === layer.id ? { ...item, animationClips: clips } : item), selectedLayerId: layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null };
    });
    setSelectedClips([{ kind: "animation", id }]);
    setSelectedAudioId(null);
    setInspector("animation");
  }

  function duplicateSelectedAnimationClip() {
    if (selectedAnimationClip) duplicateAnimationClipById(selectedAnimationClip.clip.id);
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

  function focusTimelineClip(selection: TimelineSelection, contextSelection = false) {
    setPreviewUntil(null);
    if (selection.kind === "layer") {
      setSelectedAudioId(null);
      setInspector("layer");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: selection.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), contextSelection);
    } else if (selection.kind === "color-layer") {
      setSelectedAudioId(null);
      setInspector("color-layer");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: selection.id, selectedColorClipId: null }), contextSelection);
    } else if (selection.kind === "animation") {
      const found = findAnimationClip(selection.id);
      if (!found) return;
      setSelectedAudioId(null);
      setInspector("animation");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: found.layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), contextSelection);
    } else if (selection.kind === "color") {
      const found = findColorClip(selection.id);
      if (!found) return;
      setSelectedAudioId(null);
      setInspector("color-clip");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: found.clip.id }), contextSelection);
    } else if (selection.kind === "cue") {
      setSelectedAudioId(null);
      setInspector("cue");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: null, selectedCueId: selection.id, selectedColorLayerId: null, selectedColorClipId: null }), contextSelection);
    } else {
      setSelectedAudioId(selection.id);
      setInspector("audio");
      updateTimelineSelection((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), contextSelection);
    }
  }

  function jumpToSubtitleCue(cue: EditorSubtitleCue) {
    const selection: TimelineSelection = { kind: "cue", id: cue.id };
    setPlaying(false);
    setSelectedClips([selection]);
    focusTimelineClip(selection);
    setCurrentTime(Math.max(0, Math.min(duration, cue.start)));
    requestAnimationFrame(() => {
      document.getElementById(`timeline-subtitle-cue-${cue.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
  }

  function clearTimelineSelection(contextSelection = false) {
    setSelectionLoopRange(null);
    setSelectedClips([]);
    setSelectedAudioId(null);
    setInspector("sequence");
    updateTimelineSelection((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null }), contextSelection);
  }

  function selectTimelineClip(selection: TimelineSelection, event: ReactPointerEvent<HTMLElement>): TimelineSelection[] | null {
    event.stopPropagation();
    if (event.button !== 0) return null;
    if (selectionLoopRange) {
      setSelectionLoopRange(null);
      setPlaying(false);
    }
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
    setSelectionLoopRange(null);
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

  function duplicateColorClipById(clipId: string) {
    const found = findColorClip(clipId);
    if (!found || found.layer.locked) return;
    const id = `color-clip-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
    const clips = duplicateColorClip(found.layer.clips, clipId, id);
    updateColorLayer(found.layer.id, { clips });
    updateTimeline((value) => ({ ...value, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: id }), false);
    setSelectedClips([{ kind: "color", id }]);
    setSelectedAudioId(null);
    setInspector("color-clip");
  }

  function duplicateSelectedColorClip() {
    if (selectedColorClipFound) duplicateColorClipById(selectedColorClipFound.clip.id);
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
    if (event.button !== 0) return;
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
    dragRef.current = {
      kind,
      id,
      x: event.clientX,
      start,
      end,
      items,
      colorLayerSnapshot: clipKind === "color" && timeline
        ? timeline.colorLayers.map((layer) => ({ ...layer, clips: layer.clips.map((clip) => ({ ...clip })) }))
        : undefined,
    };
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
              layerId: owner.id,
              clips: drag.colorLayerSnapshot?.find((layer) => layer.id === owner.id)?.clips ?? owner.clips,
              ids: colorSelection.filter((candidate) => owner.clips.some((clip) => clip.id === candidate.id)).map((candidate) => candidate.id),
            }));
            const movedGroups = moveColorClipGroups(groups.map(({ clips, ids }) => ({ clips, ids })), moveDelta);
            colorLayers = colorLayers.map((layer) => {
              const groupIndex = groups.findIndex((group) => group.layerId === layer.id);
              if (groupIndex < 0) return layer;
              const group = groups[groupIndex]!;
              const selectedIds = new Set(group.ids);
              const movedById = new Map(movedGroups[groupIndex]!.filter((clip) => selectedIds.has(clip.id)).map((clip) => [clip.id, clip]));
              const clips = layer.clips
                .map((clip) => movedById.get(clip.id) ?? clip)
                .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
              return { ...layer, clips };
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
    if (event.button === 0 || event.button === 1) stagePanMovedRef.current = false;
    const middlePan = event.button === 1;
    const leftPan = event.button === 0 && (mode === "camera"
      ? cameraSpacePanRef.current || (cameraTool === "pan" && !cameraBoundDrawing)
      : !cameraBoundDrawing);
    if ((!middlePan && !leftPan) || (event.target instanceof Element && event.target.closest(".timeline-stage-controls"))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stagePanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    stagePanMovedRef.current = false;
    setStagePanning(true);
  }

  function moveStagePan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = stagePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    if (deltaX === 0 && deltaY === 0) return;
    stagePanMovedRef.current = true;
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

  function cancelCameraOperationOrSelection() {
    const stage = stageRef.current;
    if (cameraBoundDrawRef.current || cameraBoundDrawing) {
      const active = cameraBoundDrawRef.current;
      cameraBoundDrawRef.current = null;
      const svg = stage?.querySelector("svg.timeline-camera-overlay");
      if (active && svg instanceof SVGSVGElement && svg.hasPointerCapture(active.pointerId)) svg.releasePointerCapture(active.pointerId);
      cancelCameraBoundDraw();
      return;
    }
    const transform = cameraBoundTransformRef.current;
    if (transform) {
      cameraBoundTransformRef.current = null;
      setCameraGizmoDragging(false);
      updateCameraBound(transform.boundId, transform.original, false);
      if (transform.edited) onCancelCameraEdit();
      const svg = stage?.querySelector("svg.timeline-camera-overlay");
      if (svg instanceof SVGSVGElement && svg.hasPointerCapture(transform.pointerId)) svg.releasePointerCapture(transform.pointerId);
      return;
    }
    const shotTransform = cameraShotTransformRef.current;
    if (shotTransform) {
      cameraShotTransformRef.current = null;
      setCameraGizmoDragging(false);
      updateCameraKeyframe(shotTransform.keyframeId, shotTransform.original, false);
      if (shotTransform.edited) onCancelCameraEdit();
      const svg = stage?.querySelector("svg.timeline-camera-overlay");
      if (svg instanceof SVGSVGElement && svg.hasPointerCapture(shotTransform.pointerId)) svg.releasePointerCapture(shotTransform.pointerId);
      return;
    }
    const keyframeDrag = cameraKeyframeDragRef.current;
    if (keyframeDrag) {
      cameraKeyframeDragRef.current = null;
      updateCameraKeyframe(keyframeDrag.keyframeId, keyframeDrag.original, false);
      setCurrentTime(keyframeDrag.original.time);
      setCameraKeyframeTimeIssue(null);
      if (keyframeDrag.element.hasPointerCapture(keyframeDrag.pointerId)) keyframeDrag.element.releasePointerCapture(keyframeDrag.pointerId);
      if (keyframeDrag.edited) onCancelCameraEdit();
      return;
    }
    if (stagePanRef.current) {
      const pan = stagePanRef.current;
      stagePanRef.current = null;
      if (stage?.hasPointerCapture(pan.pointerId)) stage.releasePointerCapture(pan.pointerId);
      setStagePanning(false);
      return;
    }
    setSelectedCameraBoundId(null);
    setSelectedCameraKeyframeId(null);
    setCameraInspectorTarget("settings");
  }

  function handleCameraStageKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isContextMenuShortcut(event)) {
      const target: CameraContextTarget = selectedCameraBoundId
        ? { kind: "boundary", id: selectedCameraBoundId }
        : selectedCameraKeyframeId ? { kind: "shot", id: selectedCameraKeyframeId } : { kind: "empty" };
      openCameraKeyboardContextMenu(event, target);
      return;
    }
    if (isTextEditingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === "Space" || event.key === " ") return;
    if (event.repeat) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelCameraOperationOrSelection();
      return;
    }
    switch (event.key.toLocaleLowerCase()) {
      case "v":
        event.preventDefault(); event.stopPropagation();
        cancelCameraBoundDraw();
        break;
      case "h":
        event.preventDefault(); event.stopPropagation();
        cancelCameraBoundDraw(); setCameraTool("pan");
        break;
      case "b":
        event.preventDefault(); event.stopPropagation();
        setCameraEditMode("boundaries"); setCameraTool("draw"); setCameraBoundDrawing(true); setCameraGuidesVisible(true);
        break;
      case "f":
        event.preventDefault(); event.stopPropagation();
        setStageView(resetStageView()); spineRenderersRef.current.get(referenceLayerId)?.resetCamera();
        break;
    }
  }

  function clearCameraSceneSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || cameraBoundDrawing || cameraBoundDrawRef.current || stagePanning || cameraSpacePanRef.current) return;
    if (stagePanMovedRef.current) {
      stagePanMovedRef.current = false;
      return;
    }
    if (event.target instanceof Element && event.target.closest(".timeline-camera-bound, .timeline-camera-bound-handle, .timeline-camera-shot-frame, .timeline-camera-shot-handle")) return;
    setSelectedCameraBoundId(null);
    setSelectedCameraKeyframeId(null);
    setCameraInspectorTarget("settings");
  }

  function handleCameraStageKeyDownCapture(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isTextEditingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (event.code === "Space" || event.key === " ") {
      event.preventDefault();
      cameraSpacePanRef.current = true;
      setCameraSpacePanning(true);
    }
  }

  function beginCameraSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cameraSplitPointerRef.current = event.pointerId;
    setCameraSplitDragging(true);
  }

  function moveCameraSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (cameraSplitPointerRef.current !== event.pointerId) return;
    const pair = cameraPreviewPairRef.current;
    const rect = pair?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setCameraSceneShare(Math.max(0.35, Math.min(0.8, (event.clientX - rect.left) / rect.width)));
    event.preventDefault();
  }

  function endCameraSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (cameraSplitPointerRef.current !== event.pointerId) return;
    cameraSplitPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setCameraSplitDragging(false);
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

  function duplicateCueById(cueId: string) {
    const sourceCue = timeline?.subtitles.find((item) => item.id === cueId);
    if (!sourceCue) return;
    const length = sourceCue.end - sourceCue.start;
    const start = sourceCue.end;
    const cue = { ...sourceCue, id: crypto.randomUUID(), start, end: start + length, text: { ...sourceCue.text } };
    updateTimeline((value) => extendTimelineDuration({ ...value, subtitles: [...value.subtitles, cue], selectedLayerId: null, selectedCueId: cue.id, selectedColorLayerId: null, selectedColorClipId: null }));
    setSelectedClips([{ kind: "cue", id: cue.id }]);
    setSelectedAudioId(null);
    setInspector("cue");
  }

  function duplicateCue() {
    if (selectedCue) duplicateCueById(selectedCue.id);
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
    timelineClipboardRef.current = null;
    setClipboardAvailable(false);
    setSubtitleSearchQuery("");
    setSubtitleSearchLanguage("all");
  }, [directory, timeline?.sequenceId]);

  timelineKeydownRef.current = (event: KeyboardEvent) => {
    if (mode === "camera") return;
    if (isTextEditingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(key)) return;
    if ((event.ctrlKey || event.metaKey) && key === "s") { event.preventDefault(); void onSave(); }
    else if ((event.ctrlKey || event.metaKey) && key === "c" && selectedClips.some((item) => item.kind === "animation" || item.kind === "color" || item.kind === "cue" || item.kind === "audio")) { event.preventDefault(); copySelectedTimelineClips(); }
    else if ((event.ctrlKey || event.metaKey) && key === "v" && timelineClipboardRef.current) { event.preventDefault(); pasteTimelineClips(); }
    else if (key === " ") { event.preventDefault(); setPlaying((value) => !value); }
    else if (key === "arrowleft" || key === "arrowright") { event.preventDefault(); setPreviewUntil(null); setPlaying(false); setCurrentTime((value) => Math.max(0, Math.min(duration, value + (key === "arrowright" ? 1 : -1) * (event.shiftKey ? 10 : 1) / 60))); }
    else if (key === "home" || key === "end") { event.preventDefault(); setPreviewUntil(null); setPlaying(false); setCurrentTime(key === "home" ? 0 : duration); }
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
  const subtitleSearchResults = searchSubtitleCues(timeline.subtitles, subtitleSearchQuery, subtitleSearchLanguage);
  const copyableSelections = selectedClips.filter((selection): selection is TimelineClipboardSelection => selection.kind !== "layer" && selection.kind !== "color-layer");
  function copySelectedTimelineClips() {
    if (!timeline) return;
    const clipboard = copyTimelineSelection(timeline, copyableSelections, (layer, value) => layerAnimationClips(layer, value));
    if (!clipboard) {
      onStatus("No copyable timeline clips are selected.");
      return;
    }
    timelineClipboardRef.current = clipboard;
    setClipboardAvailable(true);
    onStatus(`Copied ${clipboard.entries.length} timeline clip${clipboard.entries.length === 1 ? "" : "s"}. Paste aligns the first clip to the playhead and preserves spacing.`);
  }
  function pasteTimelineClips() {
    if (!timeline || !timelineClipboardRef.current) return;
    const result = pasteTimelineSelection(timeline, timelineClipboardRef.current, currentTime, (layer, value) => layerAnimationClips(layer, value));
    if (result.pastedCount === 0) {
      onStatus("Paste skipped: the copied tracks are missing or locked.");
      return;
    }
    updateTimeline(() => result.timeline);
    setSelectedClips(result.selections);
    const lastSelection = result.selections.at(-1)!;
    setSelectedAudioId(lastSelection.kind === "audio" ? lastSelection.id : null);
    setInspector(result.selections.length > 1 ? "multi" : lastSelection.kind === "animation" ? "animation" : lastSelection.kind === "color" ? "color-clip" : lastSelection.kind);
    onStatus(`Pasted ${result.pastedCount} clip${result.pastedCount === 1 ? "" : "s"}${result.skippedCount ? `; skipped ${result.skippedCount} locked or unavailable` : ""}${result.adjustedCount ? `; repositioned ${result.adjustedCount} to avoid same-track overlap` : ""}.`);
  }
  const selectedPlaybackRange: TimelineRange | null = selectedClipDetails.length > 0 ? (() => {
    const start = Math.max(0, Math.min(duration, ...selectedClipDetails.map((item) => item.start)));
    const end = Math.min(duration, Math.max(...selectedClipDetails.map((item) => item.end)));
    return Number.isFinite(start) && Number.isFinite(end) && end - start >= 0.01 ? { start, end } : null;
  })() : null;
  function playSelectedRange(loop: boolean) {
    if (!selectedPlaybackRange) return;
    currentTimeRef.current = selectedPlaybackRange.start;
    setCurrentTime(selectedPlaybackRange.start);
    setSelectionLoopRange(loop ? selectedPlaybackRange : null);
    setPreviewUntilState(loop ? null : selectedPlaybackRange.end);
    setPlaying(true);
  }
  function toggleSelectionLoop() {
    if (selectionLoopRange) {
      setSelectionLoopRange(null);
      setPlaying(false);
      return;
    }
    playSelectedRange(true);
  }
  function fitTimelineToSelection() {
    const scroller = scrollRef.current;
    if (!scroller || selectedClipDetails.length === 0) return;
    const range = {
      start: Math.min(...selectedClipDetails.map((item) => item.start)),
      end: Math.max(...selectedClipDetails.map((item) => item.end)),
    };
    const fit = fitTimelineToRange(range, scroller.clientWidth, trackLabelWidth, TIMELINE_SCALE);
    if (!fit) return;
    setZoom(fit.zoom);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = fit.scrollLeft;
    }));
  }
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
    setSelectionLoopRange(null);
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
  const editableCameraTrack = cameraTrack ?? emptyCameraTrack();
  const selectedCameraBound = cameraTrack?.safeBounds.find((bound) => bound.id === selectedCameraBoundId) ?? null;
  const orderedCameraKeyframes = [...(cameraTrack?.keyframes ?? [])].sort((a, b) => a.time - b.time);
  const cameraShotFrameHeightMaximum = selectedCameraKeyframe && cameraTrack
    ? Math.max(500, selectedCameraKeyframe.frameHeight * 4, (cameraProjectionRenderer?.getArtworkCameraFrame(cameraAspectValue(cameraTrack.aspectRatio))?.height ?? 0) * 2, ...cameraTrack.safeBounds.map((bound) => cameraFrameHeightForBound(bound, cameraTrack.aspectRatio) * 2))
    : 1000;
  const cameraPlayheadOccupied = cameraTrack?.keyframes.some((keyframe) => Math.abs(keyframe.time - currentTime) < 0.001) ?? false;
  const cameraReferenceMissing = Boolean(cameraTrack?.referenceLayerId && !(timeline?.layers ?? []).some((layer) => layer.id === cameraTrack.referenceLayerId));

  function timelineSelectionFromElement(element: Element): TimelineSelection | null {
    const target = element.closest<HTMLElement>("[data-context-kind][data-context-id]");
    const kind = target?.dataset.contextKind;
    const id = target?.dataset.contextId;
    if (!id || !kind || !["layer", "color-layer", "animation", "color", "cue", "audio"].includes(kind)) return null;
    return { kind: kind as TimelineClipKind, id };
  }

  function openTimelineContextMenuAt(x: number, y: number, target: TimelineContextTarget, returnFocusTo: HTMLElement | null) {
    if (target.kind === "clip") {
      const selection = target.selection;
      if (!isClipSelected(selection.kind, selection.id)) setSelectedClips([selection]);
      setSelectedAudioId(selection.kind === "audio" ? selection.id : null);
      setSelectionLoopRange(null);
      focusTimelineClip(selection, true);
      if ((isClipSelected(selection.kind, selection.id) ? selectedClips.length : 1) > 1) setInspector("multi");
    }
    setTimelineContextMenu({ x, y, target, returnFocusTo });
  }

  function openTimelineContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (isTextEditingTarget(event.target)) return;
    const element = event.target instanceof Element ? event.target : event.currentTarget;
    const cameraKey = element.closest<HTMLElement>(".timeline-camera-key");
    if (cameraKey) {
      const id = cameraKey.dataset.cameraKeyframe;
      if (id) openCameraContextMenuAt(event.clientX, event.clientY, { kind: "shot", id }, cameraKey);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const cameraTrackElement = element.closest<HTMLElement>(".timeline-camera-track");
    if (cameraTrackElement) {
      const bounds = cameraTrackElement.getBoundingClientRect();
      const time = bounds.width > 0 ? Math.max(0, Math.min(duration, (event.clientX - bounds.left) / (TIMELINE_SCALE * zoom))) : currentTime;
      event.preventDefault();
      event.stopPropagation();
      openCameraContextMenuAt(event.clientX, event.clientY, { kind: "timeline", time }, cameraTrackElement);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = timelineSelectionFromElement(element);
    const target: TimelineContextTarget = selection ? { kind: "clip", selection } : { kind: "empty" };
    const focusTarget = selection ? element.closest<HTMLElement>("[data-context-kind][data-context-id]") : scrollRef.current;
    openTimelineContextMenuAt(event.clientX, event.clientY, target, focusTarget ?? event.currentTarget);
  }

  function openTimelineKeyboardContextMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isContextMenuShortcut(event) || isTextEditingTarget(event.target)) return;
    const element = event.target instanceof Element ? event.target : event.currentTarget;
    const cameraKey = element.closest<HTMLElement>(".timeline-camera-key");
    if (cameraKey?.dataset.cameraKeyframe) {
      event.preventDefault();
      event.stopPropagation();
      const bounds = cameraKey.getBoundingClientRect();
      openCameraContextMenuAt(bounds.left, bounds.bottom, { kind: "shot", id: cameraKey.dataset.cameraKeyframe }, cameraKey);
      return;
    }
    const cameraTrackElement = element.closest<HTMLElement>(".timeline-camera-track");
    if (cameraTrackElement) {
      event.preventDefault();
      event.stopPropagation();
      const bounds = cameraTrackElement.getBoundingClientRect();
      openCameraContextMenuAt(bounds.left, bounds.bottom, { kind: "timeline", time: currentTime }, cameraTrackElement);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = timelineSelectionFromElement(element);
    const target: TimelineContextTarget = selection ? { kind: "clip", selection } : { kind: "empty" };
    const focusTarget = selection ? element.closest<HTMLElement>("[data-context-kind][data-context-id]") : event.currentTarget;
    const bounds = (focusTarget ?? event.currentTarget).getBoundingClientRect();
    openTimelineContextMenuAt(bounds.left, bounds.bottom, target, focusTarget ?? event.currentTarget);
  }

  function timelineContextActions(target: TimelineContextTarget): readonly ContextMenuAction[] {
    if (target.kind === "preview") return [
      { label: playing ? "Pause sequence" : "Play sequence", run: () => setPlaying((value) => !value) },
      { label: "Reset preview pan", run: resetStagePan },
      { label: "Fit preview", run: fitStage },
    ];
    if (target.kind === "empty") return [
      { label: "Add subtitle cue at playhead", run: addCue },
      { label: "Add animation clip", disabled: !(selectedLayer ?? characterLayer), reason: "Add a Spine layer first.", run: addAnimationClip },
      { label: "Add color clip", run: () => addColorClip("solid") },
      { label: "Add audio files…", run: () => void importAudio() },
      { label: "Paste clips at playhead", disabled: !clipboardAvailable, reason: !clipboardAvailable ? "Copy timeline clips first." : undefined, run: pasteTimelineClips, separatorBefore: true },
      { label: "Fit full timeline", run: fitTimeline },
      { label: "Clear selection", disabled: selectedClips.length === 0, run: () => clearTimelineSelection(true) },
    ];
    if (!timeline) return [];
    const selection = target.selection;
    const selected = selectedClipDetails.some((item) => item.kind === selection.kind && item.id === selection.id);
    const selectedEnabled = selectedClipDetails.some((item) => item.enabled);
    const actions: ContextMenuAction[] = [
      { label: "Edit properties", run: () => focusTimelineClip(selection, true) },
    ];
    if (selection.kind === "layer") {
      const layer = timeline.layers.find((item) => item.id === selection.id);
      if (layer) actions.push(
        { label: layer.enabled ? "Hide layer" : "Show layer", run: () => updateLayer(layer.id, { enabled: !layer.enabled }) },
        { label: layer.locked ? "Unlock layer" : "Lock layer", run: () => updateLayer(layer.id, { locked: !layer.locked }), separatorBefore: true },
      );
    } else if (selection.kind === "color-layer") {
      const layer = timeline.colorLayers.find((item) => item.id === selection.id);
      if (layer) actions.push(
        { label: layer.enabled ? "Hide color layer" : "Show color layer", run: () => updateColorLayer(layer.id, { enabled: !layer.enabled }) },
        { label: layer.locked ? "Unlock layer" : "Lock layer", run: () => updateColorLayer(layer.id, { locked: !layer.locked }), separatorBefore: true },
      );
    }
    if (selection.kind === "animation" || selection.kind === "color" || selection.kind === "cue") actions.push({
      label: selection.kind === "cue" ? "Duplicate subtitle cue" : selection.kind === "color" ? "Duplicate color clip" : "Duplicate animation clip",
      disabled: selection.kind === "animation" ? Boolean(findAnimationClip(selection.id)?.layer.locked) : selection.kind === "color" ? Boolean(findColorClip(selection.id)?.layer.locked) : false,
      run: () => {
        if (selection.kind === "animation") duplicateAnimationClipById(selection.id);
        else if (selection.kind === "color") duplicateColorClipById(selection.id);
        else duplicateCueById(selection.id);
      },
    });
    if (selection.kind === "animation") {
      const targetClip = findAnimationClip(selection.id);
      actions.push({
        label: "Match animation length",
        disabled: !targetClip || targetClip.layer.locked || !animationLengthMatchInfo(targetClip.layer, targetClip.clip.animation),
        reason: "Choose an unlocked fixed animation and wait for its duration to load.",
        run: () => targetClip && matchAnimationLength(targetClip.layer, targetClip.clip),
      });
    }
    if (selection.kind === "audio") actions.push(
      { label: "Preview audio", run: previewSelectedAudio },
      { label: "Match source length", disabled: selectedAudioDuration === undefined, reason: selectedAudioDuration === undefined ? "Wait for the source audio to decode." : undefined, run: matchSelectedAudioLength },
      selectedAudioLinkedSubtitle
        ? { label: "Unlink subtitle", run: () => setAudioSubtitleLink(selection.id, null) }
        : { label: "Link nearest subtitle", disabled: !selectedAudioLinkCandidate, reason: !selectedAudioLinkCandidate ? "No nearby subtitle cue is available." : undefined, run: () => selectedAudioLinkCandidate && setAudioSubtitleLink(selection.id, selectedAudioLinkCandidate.id) },
    );
    if (selected) actions.push(
      { label: selectedEnabled ? "Disable selected" : "Enable selected", run: () => setSelectedClipsEnabled(!selectedEnabled), separatorBefore: true },
      { label: "Copy selected clips", disabled: !copyableSelections.length, reason: !copyableSelections.length ? "Layers cannot be copied as clips." : undefined, run: copySelectedTimelineClips },
      { label: "Fit selection", run: fitTimelineToSelection },
      { label: "Delete selected", disabled: !deletableSelectionCount, reason: !deletableSelectionCount ? "The selected main or locked layer cannot be removed." : undefined, danger: true, separatorBefore: true, run: deleteSelectedClips },
    );
    return actions;
  }

  function openTimelinePreviewContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    openTimelineContextMenuAt(event.clientX, event.clientY, { kind: "preview" }, event.currentTarget);
  }

  function openTimelinePreviewKeyboardMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isContextMenuShortcut(event) || isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openTimelineContextMenuAt(bounds.left, bounds.bottom, { kind: "preview" }, event.currentTarget);
  }

  function renderTimelineAudio() {
    return <div className="timeline-audio-host" aria-hidden="true">
      {(timeline?.audio ?? []).map((clip) => <audio key={clip.id} ref={(element) => { audioElementsRef.current[clip.id] = element; }} src={audioUrls[clip.id]} preload="auto" onLoadedMetadata={(event) => applyDecodedAudioDuration(clip.id, event.currentTarget.duration)} onCanPlay={() => setAudioPreloadState(clip.id, "ready")} onError={() => { setMissingAudio((value) => value.includes(clip.path) ? value : [...value, clip.path]); setAudioPreloadState(clip.id, "missing"); }} />)}
    </div>;
  }

  if (mode === "camera") return <>
    {renderTimelineAudio()}
    <div className="camera-workspace">
      <aside className="editor-panel camera-library" aria-label="Camera boundaries and shots">
        <section className="camera-library-section">
          <div className="editor-section-title"><strong>Named boundaries</strong><span>{cameraTrack?.safeBounds.length ?? 0}</span><button type="button" className="editor-button" onClick={addCameraBound} disabled={!cameraProjectionSize} title="Add a boundary around the current full-scene view"><IconPlus /></button></div>
          <div className="camera-item-list">
            {(cameraTrack?.safeBounds ?? []).map((bound) => <button key={bound.id} type="button" className={`camera-item${selectedCameraBoundId === bound.id ? " is-selected" : ""}${bound.enabled ? "" : " is-disabled"}`} aria-haspopup="menu" aria-pressed={selectedCameraBoundId === bound.id} onClick={() => { setSelectedCameraBoundId(bound.id); setCameraInspectorTarget("boundary"); setCameraEditMode("boundaries"); setCameraTool("select"); }} onContextMenu={(event) => openCameraContextMenu(event, { kind: "boundary", id: bound.id })} onKeyDown={(event) => openCameraKeyboardContextMenu(event, { kind: "boundary", id: bound.id })}>
              <span className="camera-item-marker boundary" />
              <span className="camera-item-copy"><strong>{bound.name}</strong><small>{bound.enabled ? "Enabled" : "Disabled"}{bound.id === solvedCamera?.activeBoundId ? " · active" : ""}</small></span>
            </button>)}
            {!cameraTrack?.safeBounds.length && <p className="editor-muted camera-list-empty">Draw or add a named boundary to constrain camera shots.</p>}
          </div>
          <div className="camera-library-actions">
             <button className="editor-button" type="button" onClick={() => { setCameraEditMode("boundaries"); setCameraTool("draw"); setCameraBoundDrawing(true); setCameraGuidesVisible(true); onStatus("Drag over the full scene to draw a camera boundary."); }} disabled={!cameraProjectionSize}><IconPlus /> Draw on scene</button>
          </div>
        </section>
        <section className="camera-library-section camera-shot-list-section">
          <div className="editor-section-title"><strong>Camera shots</strong><span>{orderedCameraKeyframes.length}</span><button type="button" className="editor-button" onClick={addCameraKeyframe} title="Add a shot at the shared playhead"><IconPlus /></button></div>
          <div className="camera-item-list">
            {orderedCameraKeyframes.map((keyframe, index) => {
              const constraint = keyframe.constraint;
              const bound = constraint?.mode === "manual" ? cameraTrack?.safeBounds.find((item) => item.id === constraint.boundId) : null;
              return <button key={keyframe.id} type="button" className={`camera-item${selectedCameraKeyframeId === keyframe.id ? " is-selected" : ""}`} aria-haspopup="menu" aria-pressed={selectedCameraKeyframeId === keyframe.id} onClick={() => selectCameraKeyframe(keyframe.id)} onContextMenu={(event) => openCameraContextMenu(event, { kind: "shot", id: keyframe.id })} onKeyDown={(event) => openCameraKeyboardContextMenu(event, { kind: "shot", id: keyframe.id })}>
                <span className="camera-item-marker shot">{index + 1}</span>
                <span className="camera-item-copy"><strong>{seconds(keyframe.time)}</strong><small>{bound?.name ?? (keyframe.constraint?.mode === "none" ? "Unconstrained" : "Track boundary")}</small></span>
              </button>;
            })}
            {!orderedCameraKeyframes.length && <p className="editor-muted camera-list-empty">Add a shot at the playhead to begin camera motion.</p>}
          </div>
        </section>
      </aside>

      <main className="camera-main">
        <header className="camera-heading">
          <div><strong>{timeline.sequenceId === "opening" ? "Opening / Intro" : timeline.sequenceId ? sequenceDisplayName(timeline.sequenceId) : "Recovered composition"}</strong><small>Full-scene authoring · {cameraTrack?.aspectRatio ?? "16:9"} constrained output</small></div>
          <label className="camera-sequence-picker">Sequence<select value={timeline.sequenceId ?? "legacy"} onChange={(event) => chooseSequence(event.target.value)}>{sequenceIds.map((id) => <option key={id} value={id}>{id === "opening" ? "Opening / Intro" : sequenceDisplayName(id)}</option>)}{(!timeline.sequenceId || timeline.sequenceId === "legacy") && <option value="legacy">Recovered composition</option>}</select></label>
          <button type="button" className={`editor-button${cameraTrack?.enabled ? " active" : ""}`} onClick={() => updateCameraTrack((value) => ({ ...value, enabled: !value.enabled }))} aria-pressed={cameraTrack?.enabled === true}>{cameraTrack?.enabled ? "Camera enabled" : "Enable camera"}</button>
          <button type="button" className={`editor-button${cameraInspectorTarget === "settings" ? " active" : ""}`} onClick={() => setCameraInspectorTarget("settings")} aria-pressed={cameraInspectorTarget === "settings"}>Camera settings</button>
          <button type="button" className="editor-button camera-add-shot" onClick={addCameraKeyframe}><IconPlus /> Add shot at playhead</button>
        </header>

        <div ref={cameraPreviewPairRef} className="camera-preview-pair" style={{ "--camera-scene-share": `${cameraSceneShare}fr`, "--camera-output-share": `${1 - cameraSceneShare}fr` } as CSSProperties}>
          <section className="camera-preview-panel camera-scene-panel" aria-label="Full scene editor">
            <header className="camera-preview-heading"><span><strong>Scene</strong><small>Full artwork · boundary coordinates stay in scene space</small></span>
              <div className="camera-tool-group" role="toolbar" aria-label="Camera scene tools">
              <button type="button" className={`editor-button${cameraTool === "select" ? " active" : ""}`} aria-pressed={cameraTool === "select"} onClick={() => { cancelCameraBoundDraw(); setCameraTool("select"); }} title="Select items in the active edit mode (V)">Select</button>
              <button type="button" className={`editor-button${cameraTool === "pan" ? " active" : ""}`} aria-pressed={cameraTool === "pan"} onClick={() => { cancelCameraBoundDraw(); setCameraTool("pan"); }} title="Pan the scene canvas (H)">Pan</button>
              <button type="button" className={`editor-button${cameraTool === "draw" ? " active" : ""}`} aria-pressed={cameraTool === "draw"} onClick={() => { setCameraEditMode("boundaries"); setCameraTool("draw"); setCameraBoundDrawing(true); setCameraGuidesVisible(true); }} title="Draw a named camera boundary (B)">Draw</button>
              <button type="button" className={`editor-button${cameraEditMode === "boundaries" ? " active" : ""}`} aria-pressed={cameraEditMode === "boundaries"} onClick={() => { setCameraEditMode("boundaries"); setCameraInspectorTarget(selectedCameraBound ? "boundary" : "settings"); }} title="Make boundaries selectable and editable">Edit boundaries</button>
              <button type="button" className={`editor-button${cameraEditMode === "shots" ? " active" : ""}`} aria-pressed={cameraEditMode === "shots"} onClick={() => { setCameraEditMode("shots"); setCameraInspectorTarget(selectedCameraKeyframe ? "shot" : "settings"); }} title="Make camera shots selectable and editable">Edit shots</button>
                <button type="button" className={`editor-button${cameraGuidesVisible ? " active" : ""}`} aria-pressed={cameraGuidesVisible} onClick={() => setCameraGuidesVisible((visible) => !visible)} title="Show or hide scene boundary guides">Guides</button>
                <button type="button" className={`editor-button${cameraShotGuidesVisible ? " active" : ""}`} aria-pressed={cameraShotGuidesVisible} onClick={() => setCameraShotGuidesVisible((visible) => !visible)} title="Show or hide camera shot frames">Shots</button>
                <button type="button" className={`editor-button${cameraCenterGuidesVisible ? " active" : ""}`} aria-pressed={cameraCenterGuidesVisible} onClick={() => setCameraCenterGuidesVisible((visible) => !visible)} title="Show or hide shot center guides">Centers</button>
                <button type="button" className={`editor-button${cameraCompositionGuidesVisible ? " active" : ""}`} aria-pressed={cameraCompositionGuidesVisible} onClick={() => setCameraCompositionGuidesVisible((visible) => !visible)} title="Show or hide thirds composition guides">Thirds</button>
                <button type="button" className={`editor-button${cameraAspectLocked ? " active" : ""}`} aria-pressed={cameraAspectLocked} onClick={() => setCameraAspectLocked((locked) => !locked)} title="Lock boundary drawing and resizing to the output aspect ratio">Lock ratio</button>
                <button type="button" className="editor-button" onClick={() => { setStageView(resetStageView()); spineRenderersRef.current.get(referenceLayerId)?.resetCamera(); }} title="Fit the entire artwork (F)">Fit scene</button>
                <span className="camera-scene-zoom" role="group" aria-label="Scene canvas zoom">
                  <button type="button" className="editor-icon-button" aria-label="Zoom out scene" title="Zoom out" disabled={stageView.scale <= 0.5} onClick={() => zoomStageBy(0.8)}><IconMinus /></button>
                  <input className="camera-zoom-percent" type="text" inputMode="numeric" value={cameraZoomDraft ?? String(Math.round(stageView.scale * 100))} aria-label="Scene zoom percentage" onFocus={() => setCameraZoomDraft(String(Math.round(stageView.scale * 100)))} onChange={(event) => setCameraZoomDraft(event.target.value.replace(/[^0-9]/g, ""))} onBlur={() => { if (cameraZoomDraft !== null && cameraZoomDraft.trim()) setStageView((value) => ({ ...value, scale: clampStageScale(Number(cameraZoomDraft) / 100) })); setCameraZoomDraft(null); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { setCameraZoomDraft(null); event.currentTarget.blur(); } }} />
                  <button type="button" className="editor-icon-button" aria-label="Zoom in scene" title="Zoom in" disabled={stageView.scale >= STAGE_VIEW_MAX_SCALE} onClick={() => zoomStageBy(1.25)}><IconPlus /></button>
                </span>
                <button type="button" className="editor-button camera-shortcut-help" title="V Select · H Pan · B Draw boundary · F Fit scene · Space-drag or middle-drag to pan · Escape cancels or deselects" aria-label="Camera workspace shortcuts">?</button>
              </div>
            </header>
            <div className="camera-scene-wrap">
              <div ref={stageRef} className={`timeline-stage camera-scene-stage tool-${cameraTool}${stagePanning ? " is-panning" : ""}${cameraSpacePanning ? " is-space-panning" : ""}${cameraBoundDrawing ? " is-drawing-camera-bound" : ""}`} role="application" tabIndex={0} aria-haspopup="menu" aria-keyshortcuts="Shift+F10 ContextMenu" aria-label={cameraBoundDrawing ? "Full scene. Drag to draw a camera boundary. Press V for Select, H for Pan, B for Draw, F to fit, or hold Space and drag to pan." : "Full scene camera editor. Middle-drag to pan; press V for Select, H for Pan, B for Draw, F to fit, or hold Space and drag to pan."} onKeyDownCapture={handleCameraStageKeyDownCapture} onKeyDown={handleCameraStageKeyDown} onClick={clearCameraSceneSelection} onContextMenu={(event) => openCameraContextMenu(event, { kind: "empty" })} onPointerDown={beginStagePan} onPointerMove={moveStagePan} onPointerUp={endStagePan} onPointerCancel={endStagePan} onLostPointerCapture={endStagePan} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }} onWheel={zoomStageAtCursor}>
                <div className="timeline-stage-content" style={{ transform: `translate3d(${stageView.x}px, ${stageView.y}px, 0) scale(${stageView.scale})` }}>
                  <div className="timeline-visual-composition">
                    {displayVisualTracks.map((track) => track.kind === "spine"
                       ? <SpineTimelineLayerCanvas key={`camera-scene-${track.layer.id}`} layer={track.layer} files={files[track.layer.directory] ?? null} currentTime={currentTime} mainAnimation={mainAnimation} mainAnimationTime={mainAnimationTime} mainAnimationLoop={mainAnimationLoop} sequenceId={timeline.sequenceId} openingMode={timeline.openingMode} talkMixDuration={talkMixDuration} talkBlendOutStart={talkBlendOutStart} effectsStrength={project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH} characterHidden={characterHidden} cameraMode="artwork" resolutionScale={stageView.scale} sharedCameraPose={sharedCameraPose} referenceCamera={track.layer.id === referenceLayerId} onMeta={(id, meta) => setMetas((value) => ({ ...value, [id]: meta }))} onCameraPose={setSharedCameraPose} onAnimationDuration={onAnimationDuration} onRenderer={(id, renderer) => { if (renderer) spineRenderersRef.current.set(id, renderer); else spineRenderersRef.current.delete(id); setCameraProjectionRevision((value) => value + 1); }} onError={onError} />
                      : <TimelineColorLayerPreview key={`camera-scene-color-${track.layer.id}`} layer={track.layer} time={currentTime} />)}
                    {!displayVisualTracks.length && <div className="timeline-empty"><strong>No layers</strong><span>Add a Spine layer in Timeline to preview this scene.</span></div>}
                  </div>
                  </div>
                  {cameraProjectionSize && (cameraGuidesVisible || cameraShotGuidesVisible && (cameraOutputRect || selectedCameraKeyframe) || cameraBoundDrawing || cameraBoundDraft) && <svg className={`timeline-camera-overlay camera-scene-overlay${cameraBoundDrawing ? " is-drawing" : ""}`} viewBox={`0 0 ${cameraProjectionSize.width} ${cameraProjectionSize.height}`} preserveAspectRatio="none" role="application" aria-label={cameraBoundDrawing ? "Drag over the full scene to draw a camera boundary" : "Full-scene camera boundaries and selected camera shot"} style={cameraBoundDrawing ? { pointerEvents: "all", touchAction: "none" } : undefined} onPointerDown={beginCameraBoundDraw} onPointerMove={moveCameraBoundDraw} onPointerUp={endCameraBoundDraw} onPointerCancel={(event) => {
                    event.stopPropagation();
                    const boundTransform = cameraBoundTransformRef.current;
                    if (boundTransform?.pointerId === event.pointerId) {
                      cameraBoundTransformRef.current = null;
                      setCameraGizmoDragging(false);
                      updateCameraBound(boundTransform.boundId, boundTransform.original, false);
                      if (boundTransform.edited) onCancelCameraEdit();
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                    } else if (cameraShotTransformRef.current?.pointerId === event.pointerId) cancelCameraShotTransform(event);
                    else if (cameraBoundDrawRef.current?.pointerId === event.pointerId) cancelCameraBoundDraw();
                   }} onLostPointerCapture={handleCameraOverlayLostPointerCapture}>
                    <g transform={stageViewSvgTransform(stageView, cameraProjectionSize)}>
                    {cameraBoundDrawing && <rect className="timeline-camera-draw-surface" x="0" y="0" width={cameraProjectionSize.width} height={cameraProjectionSize.height} />}
                    {cameraShotGuidesVisible && cameraOutputRect && <rect className="timeline-camera-shot-frame is-output" x={cameraOutputRect.x} y={cameraOutputRect.y} width={cameraOutputRect.width} height={cameraOutputRect.height} />}
                    {cameraShotGuidesVisible && selectedCameraShotRect && selectedCameraKeyframe && <g onContextMenu={(event) => openCameraContextMenu(event, { kind: "shot", id: selectedCameraKeyframe.id })}>
                      <rect className={`timeline-camera-shot-frame${cameraEditMode === "shots" ? " is-selected is-editable" : " is-secondary"}`} x={selectedCameraShotRect.x} y={selectedCameraShotRect.y} width={selectedCameraShotRect.width} height={selectedCameraShotRect.height} role={cameraEditMode === "shots" ? "button" : undefined} tabIndex={cameraTool === "select" && cameraEditMode === "shots" ? 0 : -1} aria-label={`Move selected camera shot at ${seconds(selectedCameraKeyframe.time)}`} onPointerDown={cameraEditMode === "shots" ? (event) => beginCameraShotTransform(event, "move") : undefined} onClick={cameraEditMode === "shots" ? (event) => event.stopPropagation() : undefined} onKeyDown={(event) => {
                        if (cameraEditMode !== "shots" || cameraTool !== "select") return;
                        const delta = event.shiftKey ? 10 : 1;
                        const move = event.key === "ArrowLeft" ? [-delta, 0] : event.key === "ArrowRight" ? [delta, 0] : event.key === "ArrowUp" ? [0, delta] : event.key === "ArrowDown" ? [0, -delta] : null;
                        if (move) { event.preventDefault(); event.stopPropagation(); updateCameraKeyframe(selectedCameraKeyframe.id, { centerX: selectedCameraKeyframe.centerX + move[0]!, centerY: selectedCameraKeyframe.centerY + move[1]! }); }
                        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectCameraKeyframe(selectedCameraKeyframe.id); }
                      }} />
                      {cameraCenterGuidesVisible && <circle className="timeline-camera-center-guide" cx={selectedCameraShotRect.x + selectedCameraShotRect.width / 2} cy={selectedCameraShotRect.y + selectedCameraShotRect.height / 2} r={4 / stageView.scale} />}
                      {cameraCompositionGuidesVisible && <g className="timeline-camera-composition-guides">
                        <line x1={selectedCameraShotRect.x + selectedCameraShotRect.width / 3} y1={selectedCameraShotRect.y} x2={selectedCameraShotRect.x + selectedCameraShotRect.width / 3} y2={selectedCameraShotRect.y + selectedCameraShotRect.height} />
                        <line x1={selectedCameraShotRect.x + selectedCameraShotRect.width * 2 / 3} y1={selectedCameraShotRect.y} x2={selectedCameraShotRect.x + selectedCameraShotRect.width * 2 / 3} y2={selectedCameraShotRect.y + selectedCameraShotRect.height} />
                        <line x1={selectedCameraShotRect.x} y1={selectedCameraShotRect.y + selectedCameraShotRect.height / 3} x2={selectedCameraShotRect.x + selectedCameraShotRect.width} y2={selectedCameraShotRect.y + selectedCameraShotRect.height / 3} />
                        <line x1={selectedCameraShotRect.x} y1={selectedCameraShotRect.y + selectedCameraShotRect.height * 2 / 3} x2={selectedCameraShotRect.x + selectedCameraShotRect.width} y2={selectedCameraShotRect.y + selectedCameraShotRect.height * 2 / 3} />
                      </g>}
                      {cameraTool === "select" && cameraEditMode === "shots" && cameraInspectorTarget === "shot" && (() => {
                        const cx = selectedCameraShotRect.x + selectedCameraShotRect.width / 2;
                        const cy = selectedCameraShotRect.y + selectedCameraShotRect.height / 2;
                        const handles: { id: SpineCameraBoundResizeHandle; x: number; y: number }[] = [
                          { id: "nw", x: selectedCameraShotRect.x, y: selectedCameraShotRect.y }, { id: "n", x: cx, y: selectedCameraShotRect.y }, { id: "ne", x: selectedCameraShotRect.x + selectedCameraShotRect.width, y: selectedCameraShotRect.y },
                          { id: "e", x: selectedCameraShotRect.x + selectedCameraShotRect.width, y: cy }, { id: "se", x: selectedCameraShotRect.x + selectedCameraShotRect.width, y: selectedCameraShotRect.y + selectedCameraShotRect.height },
                          { id: "s", x: cx, y: selectedCameraShotRect.y + selectedCameraShotRect.height }, { id: "sw", x: selectedCameraShotRect.x, y: selectedCameraShotRect.y + selectedCameraShotRect.height }, { id: "w", x: selectedCameraShotRect.x, y: cy },
                        ];
                        const size = 9 / stageView.scale;
                        return handles.map((handle) => <rect key={handle.id} className={`timeline-camera-shot-handle is-${handle.id}`} x={handle.x - size / 2} y={handle.y - size / 2} width={size} height={size} rx={2 / stageView.scale} aria-hidden="true" onPointerDown={(event) => beginCameraShotTransform(event, "resize", handle.id)} onClick={(event) => event.stopPropagation()} />);
                      })()}
                      {cameraEditMode === "shots" && !cameraGizmoDragging && <text className="timeline-camera-selection-label is-shot" x={selectedCameraShotRect.x + 5 / stageView.scale} y={selectedCameraShotRect.y > 18 / stageView.scale ? selectedCameraShotRect.y - 5 / stageView.scale : selectedCameraShotRect.y + 15 / stageView.scale} fontSize={11 / stageView.scale}>Shot · {seconds(selectedCameraKeyframe.time)}</text>}
                    </g>}
                    {cameraGuidesVisible && cameraBoundFrames.map((bound) => <g key={bound.id} onContextMenu={(event) => openCameraContextMenu(event, { kind: "boundary", id: bound.id })}>
                      <rect className={`timeline-camera-bound${bound.active ? " is-active" : ""}${bound.selected ? " is-selected" : ""}${bound.enabled ? "" : " is-disabled"}${cameraEditMode === "boundaries" ? " is-editable" : ""}`} x={bound.x} y={bound.y} width={bound.width} height={bound.height} role={cameraEditMode === "boundaries" ? "button" : undefined} tabIndex={cameraTool === "select" && cameraEditMode === "boundaries" ? 0 : -1} aria-pressed={bound.selected} aria-label={`Select ${cameraTrack?.safeBounds.find((item) => item.id === bound.id)?.name ?? "camera boundary"}`} onPointerDown={cameraEditMode === "boundaries" ? (event) => beginCameraBoundTransform(event, bound.id, "move") : undefined} onClick={cameraEditMode === "boundaries" ? (event) => { event.stopPropagation(); if (cameraTool === "select") { setSelectedCameraBoundId(bound.id); setCameraInspectorTarget("boundary"); setCameraEditMode("boundaries"); } } : undefined} onKeyDown={(event) => {
                        if (cameraEditMode !== "boundaries") return;
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setSelectedCameraBoundId(bound.id); setCameraInspectorTarget("boundary"); return; }
                        if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); deleteCameraBound(bound.id); return; }
                        const delta = event.shiftKey ? 10 : 1;
                        const move = event.key === "ArrowLeft" ? [-delta, 0] : event.key === "ArrowRight" ? [delta, 0] : event.key === "ArrowUp" ? [0, delta] : event.key === "ArrowDown" ? [0, -delta] : null;
                         const original = cameraTrack?.safeBounds.find((item) => item.id === bound.id);
                         if (original?.locked) return;
                        if (!move || !original) return;
                        event.preventDefault(); event.stopPropagation();
                        updateCameraBound(bound.id, moveSpineCameraBound(original, move[0]!, move[1]!));
                      }} />
                      {cameraTool === "select" && cameraEditMode === "boundaries" && bound.selected && !cameraBoundDrawing && !cameraTrack?.safeBounds.find((item) => item.id === bound.id)?.locked && (() => {
                        const handles: { id: SpineCameraBoundResizeHandle; x: number; y: number }[] = [
                          { id: "nw", x: bound.x, y: bound.y }, { id: "n", x: bound.x + bound.width / 2, y: bound.y }, { id: "ne", x: bound.x + bound.width, y: bound.y },
                          { id: "e", x: bound.x + bound.width, y: bound.y + bound.height / 2 }, { id: "se", x: bound.x + bound.width, y: bound.y + bound.height },
                          { id: "s", x: bound.x + bound.width / 2, y: bound.y + bound.height }, { id: "sw", x: bound.x, y: bound.y + bound.height }, { id: "w", x: bound.x, y: bound.y + bound.height / 2 },
                        ];
                        const size = 8 / stageView.scale;
                        return handles.map((handle) => <rect key={handle.id} className={`timeline-camera-bound-handle is-${handle.id}`} x={handle.x - size / 2} y={handle.y - size / 2} width={size} height={size} rx={2 / stageView.scale} aria-hidden="true" onPointerDown={(event) => beginCameraBoundTransform(event, bound.id, "resize", handle.id)} onClick={(event) => event.stopPropagation()} />);
                      })()}
                      {bound.selected && !cameraGizmoDragging && <text className="timeline-camera-selection-label is-boundary" x={bound.x + 5 / stageView.scale} y={bound.y > 18 / stageView.scale ? bound.y - 5 / stageView.scale : bound.y + 15 / stageView.scale} fontSize={11 / stageView.scale}>{cameraTrack?.safeBounds.find((item) => item.id === bound.id)?.name ?? "Camera boundary"}</text>}
                    </g>)}
                    {cameraBoundDraft && <rect className="timeline-camera-bound-draft" x={Math.min(cameraBoundDraft.start.x, cameraBoundDraft.end.x)} y={Math.min(cameraBoundDraft.start.y, cameraBoundDraft.end.y)} width={Math.abs(cameraBoundDraft.end.x - cameraBoundDraft.start.x)} height={Math.abs(cameraBoundDraft.end.y - cameraBoundDraft.start.y)} />}
                    </g>
                  </svg>}
                <span className="timeline-stage-hint">{cameraBoundDrawing ? "Drag a rectangle to create a boundary · middle-drag or Space-drag to pan" : cameraTool === "pan" ? "Pan tool · drag to move the full-scene canvas" : cameraTool === "draw" ? "Draw tool · drag a boundary · middle-drag or Space-drag to pan" : cameraEditMode === "boundaries" ? "Edit boundaries · Shift toggles aspect lock · Alt resizes around center · middle-drag or Space-drag to pan" : "Edit shots · Alt resizes around center · Shift+arrow nudges farther · middle-drag or Space-drag to pan"}</span>
              </div>
            </div>
          </section>

          <div
            className={`camera-preview-resizer${cameraSplitDragging ? " is-dragging" : ""}`}
            role="separator"
            aria-label="Resize scene and output preview panels"
            aria-orientation="vertical"
            aria-valuemin={35}
            aria-valuemax={80}
            aria-valuenow={Math.round(cameraSceneShare * 100)}
            tabIndex={0}
            onPointerDown={beginCameraSplitResize}
            onPointerMove={moveCameraSplitResize}
            onPointerUp={endCameraSplitResize}
            onPointerCancel={endCameraSplitResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setCameraSceneShare((value) => Math.max(0.35, Math.min(0.8, value + (event.key === "ArrowRight" ? 0.02 : -0.02))));
            }}
          />

          <section className="camera-preview-panel camera-output-panel" aria-label="Constrained camera output preview">
          <header className="camera-preview-heading"><span><strong>Output preview</strong><small>{cameraTrack?.enabled && sampledCamera?.constraint.mode === "none" ? "Unconstrained camera output" : cameraTrack?.enabled && solvedCamera?.activeBoundId ? `Constrained by ${cameraTrack.safeBounds.find((bound) => bound.id === solvedCamera.activeBoundId)?.name ?? "active boundary"}` : cameraTrack?.enabled ? orderedCameraKeyframes.length ? "Authored camera framing" : "No shots · full-artwork fit" : "Camera disabled · fit view"}</small></span><label className="camera-aspect-control">Aspect ratio<select aria-label="Output aspect ratio" value={editableCameraTrack.aspectRatio} onChange={(event) => changeCameraAspectRatio(event.target.value as SpineCameraAspectRatio)}><option value="16:9">16:9</option><option value="4:3">4:3</option></select></label></header>
            <div className="camera-output-wrap">
              <div className="camera-output-stage" style={{ "--camera-aspect": cameraAspectValue(editableCameraTrack.aspectRatio) } as CSSProperties}>
                <div className="timeline-visual-composition camera-output-composition">
                  {displayVisualTracks.map((track) => track.kind === "spine"
                       ? <SpineTimelineLayerCanvas key={`camera-output-${track.layer.id}`} layer={track.layer} files={files[track.layer.directory] ?? null} currentTime={currentTime} mainAnimation={mainAnimation} mainAnimationTime={mainAnimationTime} mainAnimationLoop={mainAnimationLoop} sequenceId={timeline.sequenceId} openingMode={timeline.openingMode} talkMixDuration={talkMixDuration} talkBlendOutStart={talkBlendOutStart} effectsStrength={project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH} characterHidden={characterHidden} cameraMode={cameraTrack?.enabled ? "authored" : "fit"} sharedCameraFrame={cameraTrack?.enabled ? solvedCamera?.frame ?? null : null} sharedCameraPose={null} referenceCamera={track.layer.id === referenceLayerId} onMeta={(id, meta) => setMetas((value) => ({ ...value, [id]: meta }))} onCameraPose={() => undefined} onAnimationDuration={onAnimationDuration} onError={onError} />
                    : <TimelineColorLayerPreview key={`camera-output-color-${track.layer.id}`} layer={track.layer} time={currentTime} />)}
                </div>
                {activeSubtitleTexts.length > 0 && <div className="timeline-subtitle-preview camera-output-subtitles" aria-live="polite">{activeSubtitleTexts.map((text, index) => <div key={`${index}-${text}`}>{text}</div>)}</div>}
              </div>
            </div>
            {!cameraTrack?.enabled && <small className="camera-preview-note">Camera disabled. Enable it to preview boundary-constrained framing.</small>}
            {cameraTrack?.enabled && !orderedCameraKeyframes.length && <small className="camera-preview-note">Previewing the full-artwork fit. Add a shot to author camera motion.</small>}
            {cameraReferenceMissing && <small className="camera-preview-note" role="status">Saved reference scene is missing; using {cameraReferenceLayer?.name ?? "the fallback scene"}.</small>}
            {solvedCamera?.diagnostic === "no-bounds" && <small className="camera-preview-note" role="status">No enabled boundaries; output is currently unconstrained.</small>}
            {solvedCamera?.diagnostic === "invalid-manual-bound" && <small className="camera-preview-note" role="status">The assigned boundary is missing or disabled; automatic selection is used.</small>}
            {cameraTrack?.enabled && sampledCamera?.constraint.mode === "none" && <small className="camera-preview-note">This shot explicitly ignores boundary constraints.</small>}
          </section>
        </div>

        <div className="camera-output-status" role="status" aria-live="polite">
          {solvedCamera?.constrained && <span className="camera-solve-status">Frame clamped to fit {solvedCamera.activeBoundId ? cameraTrack?.safeBounds.find((bound) => bound.id === solvedCamera.activeBoundId)?.name : "the assigned boundary"}.</span>}
        </div>

        <CameraKeyframeStrip
          ref={cameraKeyframeStripRef}
          keyframes={orderedCameraKeyframes}
          duration={duration}
          currentTime={currentTime}
          selectedId={selectedCameraKeyframeId}
          draggingId={cameraKeyframeDragRef.current?.keyframeId ?? null}
          timeIssue={cameraKeyframeTimeIssue}
          onSeek={(clientX) => {
            const time = cameraTimeFromClientX(clientX);
            if (time === null) return;
            setPlaying(false); setPreviewUntil(null); setCurrentTime(time);
          }}
          onSelect={selectCameraKeyframe}
          onRetimeStart={beginCameraKeyframeRetime}
          onRetimeMove={moveCameraKeyframeRetime}
          onRetimeEnd={endCameraKeyframeRetime}
          onRetimeCancel={cancelCameraKeyframeRetime}
          onTrackContextMenu={(event, time) => openCameraContextMenu(event, { kind: "timeline", time: time ?? 0 })}
          onTrackContextMenuKeyDown={(event) => openCameraKeyboardContextMenu(event, { kind: "timeline", time: currentTime })}
          onKeyframeContextMenu={(event, id) => openCameraContextMenu(event, { kind: "shot", id })}
          onKeyframeContextMenuKeyDown={(event, id) => openCameraKeyboardContextMenu(event, { kind: "shot", id })}
        />

        <div className="camera-transport" aria-label="Shared timeline playhead">
          <button className="editor-icon-button" type="button" aria-label={playing ? "Pause sequence" : "Play sequence"} onClick={() => setPlaying((value) => !value)}>{playing ? <IconPause /> : <IconPlay />}</button>
          <button className="editor-button" type="button" onClick={() => stepCameraKeyframe(-1)} disabled={!orderedCameraKeyframes.length} title="Select the previous camera shot"><IconChevronLeft /> Shot</button>
          <button className="editor-button" type="button" onClick={() => stepCameraKeyframe(1)} disabled={!orderedCameraKeyframes.length} title="Select the next camera shot">Shot <IconChevronRight /></button>
          <input aria-label="Shared timeline playhead" type="range" min="0" max={duration} step="0.001" value={Math.min(duration, currentTime)} onChange={(event) => { setPlaying(false); setPreviewUntil(null); setCurrentTime(Number(event.target.value)); }} />
          <output>{seconds(currentTime)} / {seconds(duration)}</output>
          <NumberField label="Speed" value={speed} min={0.1} max={3} step={0.1} precision={1} unit="×" scrub={false} compact onCommit={setSpeed} />
          <label className="timeline-loop"><input type="checkbox" checked={timeline.loop} onChange={(event) => updateTimeline((value) => ({ ...value, loop: event.target.checked }))} /> Loop</label>
        </div>
      </main>

      <aside className="editor-panel camera-inspector" aria-label="Camera properties">
        {cameraInspectorTarget === "boundary" && selectedCameraBound ? <section className="editor-section editor-inspector camera-property-section">
          <div className="editor-section-title"><strong>Boundary</strong><span>{selectedCameraBound.id === solvedCamera?.activeBoundId ? "Active" : "Named region"}</span></div>
          <label>Name<input value={selectedCameraBound.name} disabled={selectedCameraBound.locked} onChange={(event) => updateCameraBound(selectedCameraBound.id, { name: event.target.value })} /></label>
          <div className="camera-check-row"><label><input type="checkbox" checked={selectedCameraBound.enabled} onChange={(event) => updateCameraBound(selectedCameraBound.id, { enabled: event.target.checked })} /> Enabled</label><label><input type="checkbox" checked={selectedCameraBound.visible !== false} onChange={(event) => updateCameraBound(selectedCameraBound.id, { visible: event.target.checked })} /> Show guide</label><label><input type="checkbox" checked={selectedCameraBound.locked === true} onChange={(event) => updateCameraBound(selectedCameraBound.id, { locked: event.target.checked })} /> Locked</label></div>
          <div className="editor-two-fields"><NumberField label="X" value={selectedCameraBound.x} step={1} precision={2} unit="units" disabled={selectedCameraBound.locked} onCommit={(x) => updateCameraBound(selectedCameraBound.id, { x })} /><NumberField label="Y" value={selectedCameraBound.y} step={1} precision={2} unit="units" disabled={selectedCameraBound.locked} onCommit={(y) => updateCameraBound(selectedCameraBound.id, { y })} /></div>
          <div className="editor-two-fields"><NumberField label="Width" value={selectedCameraBound.width} min={0.01} step={1} precision={2} unit="units" disabled={selectedCameraBound.locked} onCommit={(width) => updateCameraBound(selectedCameraBound.id, { width: Math.max(0.01, width) })} /><NumberField label="Height" value={selectedCameraBound.height} min={0.01} step={1} precision={2} unit="units" disabled={selectedCameraBound.locked} onCommit={(height) => updateCameraBound(selectedCameraBound.id, { height: Math.max(0.01, height) })} /></div>
          <NumberField label="Priority" value={selectedCameraBound.priority ?? 0} step={1} precision={0} onCommit={(priority) => updateCameraBound(selectedCameraBound.id, { priority })} />
          <div className="camera-property-actions"><button className="editor-button" type="button" onClick={() => duplicateCameraBound(selectedCameraBound.id)}>Duplicate</button><button className="editor-button" type="button" onClick={() => frameCameraBoundInScene(selectedCameraBound.id)}>Frame in scene</button><button className="editor-button" type="button" disabled={!selectedCameraKeyframe || !selectedCameraBound.enabled} onClick={() => fitSelectedCameraShotToBound(selectedCameraBound.id)}>Fit selected shot to boundary</button><button className="editor-button" type="button" disabled={!selectedCameraBound.enabled} onClick={() => createCameraShotFittedToBound(selectedCameraBound.id)}>Create fitted shot here</button><button className="editor-preview-button danger" type="button" onClick={() => deleteCameraBound(selectedCameraBound.id)}>Delete</button></div>
          <p className="editor-muted">Allowable camera region in the reference scene’s world coordinates. The output frame fits entirely inside this rectangle.</p>
        </section> : cameraInspectorTarget === "shot" && selectedCameraKeyframe ? <section className="editor-section editor-inspector camera-property-section">
          <div className="editor-section-title"><strong>Camera shot</strong><span>{seconds(selectedCameraKeyframe.time)}</span></div>
          <label>Boundary for this shot<select value={selectedCameraKeyframe.constraint?.mode === "manual" ? selectedCameraKeyframe.constraint.boundId : selectedCameraKeyframe.constraint?.mode ?? "inherit"} onChange={(event) => assignCameraKeyframeBound(selectedCameraKeyframe.id, event.target.value)}>
            <option value="inherit">Use track setting</option><option value="automatic">Automatic boundary</option><option value="none">Unconstrained</option>
            {editableCameraTrack.safeBounds.map((bound) => <option key={bound.id} value={bound.id} disabled={!bound.enabled && !(selectedCameraKeyframe.constraint?.mode === "manual" && selectedCameraKeyframe.constraint.boundId === bound.id)}>{bound.name}{bound.enabled ? "" : " · disabled"}</option>)}
          </select></label>
          <div className="camera-shot-slider-grid">
            <label><span>Time slider · {seconds(selectedCameraKeyframe.time)}</span><input type="range" min={0} max={Math.max(duration, 0.001)} step={0.001} value={Math.min(duration, selectedCameraKeyframe.time)} aria-label="Camera shot time slider" onPointerDown={(event) => beginCameraShotSliderEdit(event, "time")} onPointerUp={(event) => finishCameraShotSliderEdit(event)} onPointerCancel={(event) => finishCameraShotSliderEdit(event, true)} onLostPointerCapture={(event) => finishCameraShotSliderEdit(event, true)} onChange={(event) => updateCameraShotSlider("time", Number(event.target.value))} />
            </label>
            <label><span>Frame height slider · {selectedCameraKeyframe.frameHeight.toFixed(1)}</span><input type="range" min={0.01} max={cameraShotFrameHeightMaximum} step={0.1} value={Math.min(cameraShotFrameHeightMaximum, selectedCameraKeyframe.frameHeight)} aria-label="Camera shot frame height slider" onPointerDown={(event) => beginCameraShotSliderEdit(event, "frameHeight")} onPointerUp={(event) => finishCameraShotSliderEdit(event)} onPointerCancel={(event) => finishCameraShotSliderEdit(event, true)} onLostPointerCapture={(event) => finishCameraShotSliderEdit(event, true)} onChange={(event) => updateCameraShotSlider("frameHeight", Number(event.target.value))} />
            </label>
          </div>
          <small className="camera-shot-scrub-hint">Drag the slider icons horizontally · Shift fine-tunes · Alt coarse-tunes · Arrow keys adjust numeric values.</small>
          <div className="editor-three-fields"><NumberField label="Time" value={selectedCameraKeyframe.time} min={0} max={duration} step={0.001} precision={4} unit="s" shiftMultiplier={0.1} altMultiplier={10} scrubLabel={false} scrubHint="Drag horizontally · Shift: fine · Alt: coarse" onCommit={(time) => updateCameraShotSlider("time", time)} /><NumberField label="Center X" value={selectedCameraKeyframe.centerX} step={1} precision={2} unit="units" shiftMultiplier={0.1} altMultiplier={10} scrubLabel={false} scrubHint="Drag horizontally · Shift: fine · Alt: coarse" onCommit={(centerX) => updateCameraKeyframe(selectedCameraKeyframe.id, { centerX })} /><NumberField label="Center Y" value={selectedCameraKeyframe.centerY} step={1} precision={2} unit="units" shiftMultiplier={0.1} altMultiplier={10} scrubLabel={false} scrubHint="Drag horizontally · Shift: fine · Alt: coarse" onCommit={(centerY) => updateCameraKeyframe(selectedCameraKeyframe.id, { centerY })} /></div>
          <div className="editor-two-fields"><NumberField label="Frame height" value={selectedCameraKeyframe.frameHeight} min={0.01} step={1} precision={2} unit="units" shiftMultiplier={0.1} altMultiplier={10} scrubLabel={false} scrubHint="Drag horizontally · Shift: fine · Alt: coarse" onCommit={(frameHeight) => updateCameraKeyframe(selectedCameraKeyframe.id, { frameHeight: Math.max(0.01, frameHeight) })} /><label>Interpolation<select value={selectedCameraKeyframe.easing ?? "linear"} onChange={(event) => updateCameraKeyframe(selectedCameraKeyframe.id, { easing: event.target.value as "linear" | "smooth" | "hold" })}><option value="linear">Linear</option><option value="smooth">Smooth</option><option value="hold">Hold</option></select></label></div>
          {cameraKeyframeTimeIssue && <small className="editor-field-hint" role="status">{cameraKeyframeTimeIssue}</small>}
           <div className="camera-property-actions"><button className="editor-button" type="button" onClick={() => updateSelectedShotFromOutput()} disabled={!solvedCamera}>Update selected shot from output</button><button className="editor-button" type="button" onClick={() => selectedCameraBoundId && fitSelectedCameraShotToBound(selectedCameraBoundId)} disabled={!selectedCameraBoundId || !cameraTrack?.safeBounds.some((bound) => bound.id === selectedCameraBoundId && bound.enabled)}>Fit selected shot to boundary</button><button className="editor-button" type="button" onClick={() => duplicateCameraKeyframeAtTime(selectedCameraKeyframe.id, currentTime)} disabled={cameraPlayheadOccupied} title={cameraPlayheadOccupied ? "A shot already occupies the playhead." : "Duplicate the selected shot at the playhead"}>Duplicate at playhead</button><button className="editor-button" type="button" onClick={() => stepCameraKeyframe(-1)} disabled={orderedCameraKeyframes[0]?.id === selectedCameraKeyframe.id}>Previous shot</button><button className="editor-button" type="button" onClick={() => stepCameraKeyframe(1)} disabled={orderedCameraKeyframes.at(-1)?.id === selectedCameraKeyframe.id}>Next shot</button><button className="editor-preview-button danger" type="button" onClick={() => deleteCameraKeyframe(selectedCameraKeyframe.id)}>Delete shot</button></div>
          <p className="editor-muted">The output preview shows this shot after its assigned boundary has constrained the frame.</p>
        </section> : <section className="editor-section editor-inspector camera-property-section">
          <div className="editor-section-title"><strong>Camera settings</strong><span>{cameraTrack?.enabled ? "Enabled" : "Disabled"}</span></div>
          <label><span className="timeline-inline-check"><input type="checkbox" checked={cameraTrack?.enabled === true} onChange={(event) => updateCameraTrack((value) => ({ ...value, enabled: event.target.checked }))} /> Enable authored camera</span></label>
          <label>Output aspect ratio<select value={editableCameraTrack.aspectRatio} onChange={(event) => changeCameraAspectRatio(event.target.value as SpineCameraAspectRatio)}><option value="16:9">16:9</option><option value="4:3">4:3</option></select><small className="editor-field-hint">This ratio applies to the output camera only. The scene editor remains full-frame.</small></label>
           <label>Reference scene<select value={editableCameraTrack.referenceLayerId && timeline.layers.some((layer) => layer.id === editableCameraTrack.referenceLayerId) ? editableCameraTrack.referenceLayerId : referenceLayerId} onChange={(event) => updateCameraTrack((value) => ({ ...value, referenceLayerId: event.target.value }))}>
            {displayLayers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name} · {layer.role}</option>)}
           </select><small className="editor-field-hint">Shot coordinates and boundaries use this scene’s stable world coordinates.</small></label>
           {cameraReferenceMissing && <small className="editor-field-hint" role="status">The saved reference layer is missing. Preview and edits currently use {cameraReferenceLayer?.name ?? "the first available layer"}; choose a reference scene to update the track.</small>}
          <label>Default boundary behavior<select value={editableCameraTrack.constraint.mode} onChange={(event) => {
            const next = event.target.value;
            updateCameraTrack((value) => ({ ...value, constraint: next === "none" ? { mode: "none" } : next === "manual" ? { mode: "manual", boundId: value.safeBounds.find((bound) => bound.enabled)?.id ?? "" } : { mode: "automatic" } }));
          }}><option value="automatic">Automatic</option><option value="manual" disabled={!editableCameraTrack.safeBounds.some((bound) => bound.enabled)}>Named boundary</option><option value="none">Unconstrained</option></select></label>
          {editableCameraTrack.constraint.mode === "manual" && <label>Default named boundary<select value={editableCameraTrack.constraint.boundId} onChange={(event) => updateCameraTrack((value) => ({ ...value, constraint: { mode: "manual", boundId: event.target.value } }))}>{editableCameraTrack.safeBounds.filter((bound) => bound.enabled).map((bound) => <option key={bound.id} value={bound.id}>{bound.name}</option>)}</select></label>}
           {cameraTrack?.constraint.mode !== "none" && cameraTrack?.safeBounds.every((bound) => !bound.enabled) && <small className="editor-field-hint" role="status">No enabled boundaries yet. Automatic mode is unconstrained until a boundary is enabled.</small>}
           {cameraTrack?.constraint.mode === "automatic" && <small className="editor-field-hint">Automatic mode keeps the current boundary while it contains the shot; otherwise it chooses a containing boundary by priority, or the nearest boundary if none contains it.</small>}
          {solvedCamera?.diagnostic === "invalid-manual-bound" && <small className="editor-field-hint" role="status">The assigned boundary is missing or disabled; automatic selection is used in the preview.</small>}
        </section>}
      </aside>
    </div>
    {renderCameraContextMenu()}
    <AssetPickerModal open={layerPickerOpen} title="Add Spine layer" eyebrow="TIMELINE LAYER" description="Search the loaded catalog and add another background, scene, character, or overlay set." directories={availableLayerDirectories} assetRoot={source?.rootPath ?? ""} directoryInfo={directoryInfo} emptyLabel="Every available asset set is already on this timeline." renderLabel={(item) => characterDirectoryLabel(item, directoryLabels)} getSearchText={(item) => characterDirectoryLabel(item, directoryLabels)} onClose={() => setLayerPickerOpen(false)} onSelect={(next) => { setLayerPickerOpen(false); addLayer(next); }} />
  </>;

  return <>
    {renderTimelineAudio()}
    <div className="timeline-workspace" style={{ gridTemplateColumns: `${sequencePanelCollapsed ? "" : `${sequencePanelWidth}px 7px `}minmax(0, 1fr)${inspectorPanelCollapsed ? "" : ` 7px ${inspectorPanelWidth}px`}` }}>
      <aside id="timeline-sequence-browser" className="editor-panel sequence-browser" hidden={sequencePanelCollapsed}>
        <div className="editor-section">
          <div className="editor-section-title"><strong>Sequences</strong><span>{sequenceIds.length}</span></div>
          <div className="timeline-talk-playlist-actions">
            <button className="editor-button" type="button" disabled={!project} onClick={addTalkSequenceToProject}><IconPlus /> Add Talk</button>
            {talkAutoplayActive
              ? <button className="editor-preview-button danger" type="button" onClick={stopTalkAutoplay}>Stop Talk autoplay</button>
              : <button className="editor-button" type="button" disabled={!talkSequenceIds.length} onClick={startTalkAutoplay}><IconPlay /> Play Talk list</button>}
          </div>
          <div className="sequence-list">
            {sequenceIds.map((id, index) => <div
              key={id}
              className={`sequence-list-item${timeline.sequenceId === id ? " active" : ""}${id === "opening" ? " is-required" : ""}`}
              draggable={id !== "opening"}
              onDragStart={(event) => beginSequenceReorder(event, id)}
              onDragOver={(event) => { if (sequenceDragRef.current && id !== "opening") event.preventDefault(); }}
              onDrop={(event) => dropSequenceReorder(event, id)}
              onDragEnd={() => { sequenceDragRef.current = null; }}
            >
              <button type="button" className="sequence-button" aria-current={timeline.sequenceId === id ? "page" : undefined} onClick={() => chooseSequence(id)}>
                <strong>{sequenceDisplayName(id)}</strong>
                {id === "opening" && <small>Required · fixed first</small>}
              </button>
              {id !== "opening" && <div className="sequence-reorder-actions">
                <button type="button" aria-label={`Move ${sequenceDisplayName(id)} earlier`} title="Move earlier" disabled={index <= 1} onClick={() => moveSequenceEarlierOrLater(id, -1)}>↑</button>
                <button type="button" aria-label={`Move ${sequenceDisplayName(id)} later`} title="Move later" disabled={index === sequenceIds.length - 1} onClick={() => moveSequenceEarlierOrLater(id, 1)}>↓</button>
                <button type="button" className="is-delete" aria-label={`Delete ${sequenceDisplayName(id)}`} title="Delete sequence" onClick={() => deleteSequenceFromProject(id)}>×</button>
              </div>}
            </div>)}
            {(!timeline.sequenceId || timeline.sequenceId === "legacy") && <button className="sequence-button active"><strong>Recovered composition</strong></button>}
          </div>
        </div>
      </aside>
      {!sequencePanelCollapsed && <TimelinePanelResizer side="sequences" value={sequencePanelWidth} onChange={(sequencePanelWidth) => updateTimelineLayout({ sequencePanelWidth })} />}
       <section className="timeline-main">
           <div className="sequence-heading">
              <div><strong>{timeline.sequenceId === "opening" ? "Opening / Intro" : timeline.sequenceId ? sequenceDisplayName(timeline.sequenceId) : "Recovered composition"}</strong><small>{timeline.sequenceId === "opening" ? "Layered Spine and color composition." : "Synchronized Spine composition"}</small></div>
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
              className={`timeline-stage${stagePanning ? " is-panning" : ""}${cameraBoundDrawing ? " is-drawing-camera-bound" : ""}`}
               role="application"
               aria-label={cameraBoundDrawing ? "Timeline preview. Drag over the scene to draw a camera safe bound." : "Timeline preview canvas. Drag to pan and use the mouse wheel to zoom."}
               aria-haspopup="menu"
               aria-keyshortcuts="Shift+F10 ContextMenu"
              tabIndex={0}
              onPointerDown={beginStagePan}
              onPointerMove={moveStagePan}
              onPointerUp={endStagePan}
              onPointerCancel={endStagePan}
              onContextMenu={openTimelinePreviewContextMenu}
              onKeyDown={openTimelinePreviewKeyboardMenu}
              onWheel={zoomStageAtCursor}
             >
                <div className="timeline-stage-content" style={{ transform: `translate3d(${stageView.x}px, ${stageView.y}px, 0) scale(${stageView.scale})` }}>
                  <div className="timeline-visual-composition">
                      {displayVisualTracks.map((track) => track.kind === "spine"
                       ? <SpineTimelineLayerCanvas key={`spine-${track.layer.id}`} layer={track.layer} files={files[track.layer.directory] ?? null} currentTime={currentTime} mainAnimation={mainAnimation} mainAnimationTime={mainAnimationTime} mainAnimationLoop={mainAnimationLoop} sequenceId={timeline.sequenceId} openingMode={timeline.openingMode} talkMixDuration={talkMixDuration} talkBlendOutStart={talkBlendOutStart} effectsStrength={project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH} characterHidden={characterHidden} preserveDrawingBuffer onMarkers={(next) => setMarkers((old) => old.join() === next.join() ? old : next)} sharedCameraPose={sharedCameraPose} referenceCamera={track.layer.id === referenceLayerId} onMeta={(id, meta) => setMetas((value) => ({ ...value, [id]: meta }))} onCameraPose={setSharedCameraPose} onAnimationDuration={onAnimationDuration} onRenderer={(id, renderer) => { if (renderer) spineRenderersRef.current.set(id, renderer); else spineRenderersRef.current.delete(id); setCameraProjectionRevision((value) => value + 1); }} onError={onError} />
                        : <TimelineColorLayerPreview key={`color-${track.layer.id}`} layer={track.layer} time={currentTime} />)}
                    {!displayVisualTracks.length && <div className="timeline-empty"><strong>No layers</strong><span>Add a Spine or Color layer from the Add menu.</span></div>}
                   </div>
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
                  <span className="timeline-stage-hint" aria-live="polite">{stagePanning ? "Release to stop panning" : "Drag to pan and use the mouse wheel to zoom"}</span>
            </div>
         </div>

          <div className="timeline-transport">
              <button className="editor-icon-button" aria-label={playing ? "Pause sequence" : "Play sequence"} onClick={() => setPlaying((value) => !value)}>{playing ? <IconPause /> : <IconPlay />}</button>
              <button className="editor-button" type="button" disabled={!selectedPlaybackRange} onClick={() => playSelectedRange(false)} title="Play from the start of the selected range to its end"><IconPlay /> Play selection</button>
              <button className={`editor-button${selectionLoopRange ? " active" : ""}`} type="button" aria-pressed={selectionLoopRange !== null} disabled={!selectedPlaybackRange} onClick={toggleSelectionLoop} title="Loop playback between the start and end of the selected range"><IconSync /> Loop selection</button>
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

           <div className="timeline-editor-scroll" ref={scrollRef} tabIndex={0} aria-label="Timeline tracks" aria-haspopup="menu" aria-keyshortcuts="Shift+F10 ContextMenu" style={{ flex: `${100 - previewShare} 1 0` }} onContextMenu={openTimelineContextMenu} onKeyDown={openTimelineKeyboardContextMenu} onWheel={scrollTimeline} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
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
                     return <div key={key} style={{ gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }} className={`timeline-row visual-track-row${track.kind === "color" ? " is-color-track" : " is-spine-track"}${visibility ? "" : " is-hidden-track"}`} data-context-kind={selection.kind} data-context-id={selection.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/plain") || trackDragRef.current; if (source) reorderVisualTrack(source, key); trackDragRef.current = null; }}>
                      <div className={`timeline-track-label visual-track-label${isSelected ? " is-selected" : ""}`} title={trackName}>
                        <button type="button" className="timeline-track-reorder" draggable={!locked} aria-disabled={locked} aria-label={`Reorder ${trackName}`} title={locked ? "Unlock this layer before reordering" : "Drag to reorder; use arrow keys while focused"} onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => { if (locked) { event.preventDefault(); return; } trackDragRef.current = key; event.dataTransfer.setData("text/plain", key); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { trackDragRef.current = null; }} onKeyDown={(event) => { if (locked || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return; event.preventDefault(); const target = displayVisualTracks[trackIndex + (event.key === "ArrowUp" ? -1 : 1)]; if (target) reorderVisualTrack(key, visualTrackKey(target)); }}><span aria-hidden="true">⠿</span></button>
                        <span className={`timeline-track-type ${track.kind}`}>{track.kind === "spine" ? roleLabel(track.layer.role) : "COLOR"}</span>
                         <button type="button" className="timeline-track-name" aria-haspopup="menu" onClick={() => { setSelectedClips([selection]); focusTimelineClip(selection); }}>{trackName}</button>
                        <button type="button" className="timeline-track-icon" aria-label={`${visibility ? "Hide" : "Show"} ${trackName}`} title={visibility ? "Hide layer" : "Show layer"} onClick={() => track.kind === "spine" ? updateLayer(track.layer.id, { enabled: !visibility }) : updateColorLayer(track.layer.id, { enabled: !visibility })}>{visibility ? <IconEye /> : <IconEyeOff />}</button>
                        <button type="button" className={`timeline-track-icon${locked ? " is-locked" : ""}`} aria-label={`${locked ? "Unlock" : "Lock"} ${trackName}`} title={locked ? "Unlock layer" : "Lock layer"} onClick={() => track.kind === "spine" ? updateLayer(track.layer.id, { locked: !locked }) : updateColorLayer(track.layer.id, { locked: !locked })}>{locked ? <IconLock /> : <IconUnlock />}</button>
                        <button type="button" className="timeline-track-resize" aria-label={`Resize layer column, ${trackLabelWidth} pixels`} title="Drag to resize; use left and right arrow keys" onPointerDown={beginResizeTrackLabel} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeTrackLabelBy(event.key === "ArrowRight" ? 8 : -8); } }} />
                      </div>
                      <div className={`timeline-track ${track.kind === "spine" ? "timeline-layer-track" : "timeline-color-track"}${isSelected ? " is-selected" : ""}`} data-context-kind={selection.kind} data-context-id={selection.id} tabIndex={0} aria-haspopup="menu" onPointerDown={seekFromEvent}>
                        {track.kind === "spine" ? layerAnimationClips(track.layer).map((clip) => {
                          const end = animationClipEnd(clip, animationDurations[`${track.layer.id}:${clip.animation}`] ?? 0);
                          const selected = isClipSelected("animation", clip.id);
                           return <div key={clip.id} className={`timeline-layer-clip timeline-animation-clip${selected ? " is-selected" : ""}${clip.enabled === false ? " is-disabled" : ""}${clip.continueAfterOpening ? " is-continuing" : ""}`} data-context-kind="animation" data-context-id={clip.id} tabIndex={0} aria-haspopup="menu" aria-label={`${clip.animation || "Animation"} animation clip`} title={`${clip.animation || "Animation"} · drag to move; drag an edge to trim${clip.continueAfterOpening ? " · continues after opening" : ""}`} style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(8, (end - clip.start) * TIMELINE_SCALE * zoom), zIndex: track.layer.order }} onPointerDown={(event) => { const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation", clip.id, clip.start, end, picked); }}>
                            <button type="button" className="timeline-clip-start-handle" aria-label={`Trim ${clip.animation} start`} title="Drag to trim the start" onPointerDown={(event) => { event.stopPropagation(); const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation-start", clip.id, clip.start, end, picked); }} />
                            <button type="button" className="timeline-clip-end-handle" aria-label={`Trim ${clip.animation} end`} title="Drag to trim the end" onPointerDown={(event) => { event.stopPropagation(); const picked = selectTimelineClip({ kind: "animation", id: clip.id }, event); if (picked) beginDrag(event, "animation-end", clip.id, clip.start, end, picked); }} />
                            <span className="timeline-layer-name">{track.layer.followMainAnimation ? `Follow · ${clip.animation || "main"}` : clip.animation || "Animation"}</span>
                          </div>;
                        }) : track.layer.clips.map((clip) => {
                          const duration = Math.max(0.01, clip.end - clip.start);
                          const fadeInPercent = Math.min(100, clip.fadeIn / duration * 100);
                          const fadeOutPercent = Math.min(100, clip.fadeOut / duration * 100);
                          const picked = { kind: "color" as const, id: clip.id };
                           return <div key={clip.id} className={`timeline-color-clip${isClipSelected("color", clip.id) ? " is-selected" : ""}${clip.enabled ? "" : " is-disabled"}`} data-context-kind="color" data-context-id={clip.id} tabIndex={0} aria-haspopup="menu" aria-label={`${clip.name} color clip`} title={`${clip.name} · drag to move; drag an edge to trim`} style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(12, duration * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const chosen = selectTimelineClip(picked, event); if (chosen) beginDrag(event, "color", clip.id, clip.start, clip.end, chosen); }}>
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
                  {timeline.subtitles.map((cue) => <div key={cue.id} id={`timeline-subtitle-cue-${cue.id}`} className={`timeline-cue${isClipSelected("cue", cue.id) || cue.id === timeline.selectedCueId ? " is-selected" : ""}${cue.enabled ? "" : " is-disabled"}`} data-context-kind="cue" data-context-id={cue.id} tabIndex={0} aria-haspopup="menu" aria-label="Subtitle cue" style={{ left: cue.start * TIMELINE_SCALE * zoom, width: Math.max(12, (cue.end - cue.start) * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const selection = selectTimelineClip({ kind: "cue", id: cue.id }, event); if (selection) beginDrag(event, "cue", cue.id, cue.start, cue.end, selection); }}>
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
                    {timeline.audio.map((clip) => <div key={clip.id} className={`timeline-audio-clip${isClipSelected("audio", clip.id) || clip.id === selectedAudio?.id ? " is-selected" : ""}${clip.enabled ? "" : " is-disabled"}`} data-context-kind="audio" data-context-id={clip.id} tabIndex={0} aria-haspopup="menu" aria-label={`${clip.name} audio clip`} title="Drag to move the audio; drag an edge to change its timing. Shift/Ctrl-click to select multiple." style={{ left: clip.start * TIMELINE_SCALE * zoom, width: Math.max(12, (clip.end - clip.start) * TIMELINE_SCALE * zoom) }} onPointerDown={(event) => { const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio", clip.id, clip.start, clip.end, selection); }}><button type="button" className="timeline-clip-start-handle" aria-label={`Move ${clip.name} start`} title="Drag to change start time" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio-start", clip.id, clip.start, clip.end, selection); }} /><button type="button" className="timeline-clip-end-handle" aria-label={`Move ${clip.name} end`} title="Drag to change end time" onPointerDown={(event) => { event.stopPropagation(); const selection = selectTimelineClip({ kind: "audio", id: clip.id }, event); if (selection) beginDrag(event, "audio-end", clip.id, clip.start, clip.end, selection); }} /><AudioWaveform url={audioUrls[clip.id]} onDuration={(value) => applyDecodedAudioDuration(clip.id, value)} onProfile={onAudioWaveformProfile ? (measurement) => onAudioWaveformProfile(clip.id, measurement) : undefined} /><span><IconSound /> {clip.name}</span></div>)}
                <i className="timeline-playhead" style={{ left: currentTime * TIMELINE_SCALE * zoom }} />
                </div>
              </div>
              <div className="timeline-row camera-row" style={{ gridTemplateColumns: `${trackLabelWidth}px minmax(0, 1fr)` }}>
                <div className="timeline-track-label camera-track-label"><b>CAMERA</b><span>{cameraTrack?.keyframes.length ?? 0} key{cameraTrack?.keyframes.length === 1 ? "" : "s"}</span><button type="button" className="timeline-camera-open" onClick={() => onWorkspaceChange("camera")} title="Open the Camera workspace">Edit</button><button type="button" className="timeline-camera-add-key" onClick={addCameraKeyframe} title="Add or replace a camera keyframe at the playhead">＋</button></div>
                 <div className="timeline-track timeline-camera-track" aria-haspopup="menu" onPointerDown={seekFromEvent}>
                   {cameraTrack?.keyframes.map((keyframe) => <button key={keyframe.id} type="button" className={`timeline-camera-key${keyframe.id === selectedCameraKeyframeId ? " is-selected" : ""}`} data-camera-keyframe={keyframe.id} aria-haspopup="menu" style={{ left: keyframe.time * TIMELINE_SCALE * zoom }} title={`Camera key at ${seconds(keyframe.time)} · ${keyframe.easing ?? "linear"}`} aria-label={`Select camera keyframe at ${seconds(keyframe.time)}`} aria-pressed={keyframe.id === selectedCameraKeyframeId} onPointerDown={(event) => event.stopPropagation()} onClick={() => selectCameraKeyframe(keyframe.id)} />)}
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
           <button className="editor-button" type="button" disabled={!selectedClipDetails.length} onClick={fitTimelineToSelection} title="Fit the selected clips in the timeline">Fit selection</button>
           <button className="editor-button" type="button" disabled={!copyableSelections.length} onClick={copySelectedTimelineClips} title="Copy selected clips (Ctrl+C / Cmd+C)">Copy</button>
           <button className="editor-button" type="button" disabled={!clipboardAvailable} onClick={pasteTimelineClips} title="Paste clips at the playhead (Ctrl+V / Cmd+V)">Paste</button>
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
                  <button className="editor-button" onClick={() => { closeAddMenu(); updateCameraTrack((value) => ({ ...value, enabled: true })); setInspector("sequence"); }}>Camera track</button>
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
           <section className="editor-section timeline-subtitle-search" aria-label="Find subtitle cue">
             <div className="editor-section-title"><strong>Find subtitle cue</strong><span>{timeline.subtitles.length} cue{timeline.subtitles.length === 1 ? "" : "s"}</span></div>
             <div className="timeline-subtitle-search-controls">
               <label>Text<input type="search" aria-label="Search subtitle text" placeholder="Search translations…" value={subtitleSearchQuery} onChange={(event) => setSubtitleSearchQuery(event.target.value)} /></label>
               <label>Language<select aria-label="Subtitle search language" value={subtitleSearchLanguage} onChange={(event) => setSubtitleSearchLanguage(event.target.value as SubtitleSearchLanguage)}><option value="all">All</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label>
             </div>
             {subtitleSearchQuery.trim() ? subtitleSearchResults.length > 0
               ? <>
                   <div className="timeline-subtitle-search-results" aria-label="Matching subtitle cues">
                     {subtitleSearchResults.slice(0, 100).map(({ cue, matches }) => {
                       const cueNumber = timeline.subtitles.findIndex((item) => item.id === cue.id) + 1;
                       return <button key={cue.id} type="button" className="timeline-subtitle-search-result" onClick={() => jumpToSubtitleCue(cue)} aria-label={`Jump to subtitle ${cueNumber} at ${seconds(cue.start)}: ${matches.map(({ language, text }) => `${language.toUpperCase()} ${text}`).join("; ")}`}>
                         <span className="timeline-subtitle-search-time">{seconds(cue.start)}</span>
                         <span className="timeline-subtitle-search-match">
                           <span className="timeline-subtitle-search-languages">{matches.map(({ language }) => language.toUpperCase()).join(" · ")}</span>
                           <span className="timeline-subtitle-search-excerpt" title={matches.map(({ language, text }) => `${language.toUpperCase()}: ${text}`).join(" / ")}>{matches.map(({ language, text }) => <span key={language}><b>{language.toUpperCase()}</b> {text}</span>)}</span>
                         </span>
                       </button>;
                     })}
                   </div>
                   <small className="editor-field-hint" role="status">{subtitleSearchResults.length > 100 ? `Showing first 100 of ${subtitleSearchResults.length} matches.` : `${subtitleSearchResults.length} matching cue${subtitleSearchResults.length === 1 ? "" : "s"}. Select one to jump to it.`}</small>
                 </>
               : <p className="editor-muted timeline-subtitle-search-empty" role="status">No subtitle cues match this search.</p>
               : <p className="editor-muted timeline-subtitle-search-empty">Search English, Japanese, and Korean text, then select a result to jump to its cue.</p>}
           </section>
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
              <div className="editor-subheading">Camera motion</div>
              <section className="timeline-camera-link">
                <strong>{cameraTrack?.keyframes.length ?? 0} camera shot{cameraTrack?.keyframes.length === 1 ? "" : "s"} · {cameraTrack?.safeBounds.length ?? 0} named bound{cameraTrack?.safeBounds.length === 1 ? "" : "s"}</strong>
                <span>Author camera framing, boundaries, and shot constraints in the dedicated Camera workspace.</span>
                {selectedCameraKeyframe && <small>Selected shot at {seconds(selectedCameraKeyframe.time)}.</small>}
                <button className="editor-button" type="button" onClick={() => onWorkspaceChange("camera")}>{selectedCameraKeyframe ? "Edit in Camera" : "Open Camera workspace"}</button>
              </section>
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
              <button className="editor-button" onClick={() => clearTimelineSelection()}>Clear selection</button>
             <button className="editor-preview-button danger" disabled={!deletableSelectionCount} onClick={deleteSelectedClips}>Delete selected</button>
           </div>
           <div className="timeline-selection-list" aria-label="Selected clips">
               {selectedClipDetails.map((item) => <div key={`${item.kind}-${item.id}`}><span className={`timeline-selection-kind ${item.kind}`}>{item.kind === "cue" ? "SUB" : item.kind === "audio" ? "AUD" : item.kind === "animation" ? "ANIM" : item.kind === "color" || item.kind === "color-layer" ? "COLOR" : "SPN"}</span><span title={item.label}>{item.label}</span><small>{seconds(item.start)}–{seconds(item.end)}{!item.removable ? " · locked or main character" : ""}</small></div>)}
           </div>
          </section>}

          {inspector === "animation" && selectedAnimationClip && <section className="editor-section editor-inspector">
            <div className="editor-section-title"><strong>Animation clip</strong><span><i className={`timeline-role-dot ${selectedAnimationClip.layer.role}`} /> {selectedAnimationClip.layer.name}</span></div>
            <div className="editor-two-fields"><button className="editor-button" onClick={duplicateSelectedAnimationClip}>Duplicate</button><button className="editor-preview-button danger" onClick={deleteSelectedClips}>Delete clip</button></div>
            <div className="editor-animation-field"><span>Animation</span><AnimationPicker ariaLabel="Animation clip" value={selectedAnimationClip.clip.animation} options={[{ value: "", label: "Auto fallback" }, ...(metas[selectedAnimationClip.layer.id]?.animations ?? []).map((animation) => ({ value: animation, label: animation }))]} onChange={(animation) => {
              const duration = animationDurations[`${selectedAnimationClip.layer.id}:${animation}`] ?? 0;
              updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, {
                animation,
                ...(selectedAnimationClip.clip.endMode !== "manual" && !selectedAnimationClip.clip.loop && duration > 0
                  ? { end: selectedAnimationClip.clip.start + Math.max(0.01, duration - selectedAnimationClip.clip.animationOffset) }
                  : {}),
              });
            }} /></div>
            <div className="editor-animation-field"><span>Face / secondary animation</span><AnimationPicker ariaLabel="Face or secondary animation" value={selectedAnimationClip.clip.faceAnimation === undefined ? LAYER_DEFAULT_FACE_ANIMATION : selectedAnimationClip.clip.faceAnimation} options={[{ value: LAYER_DEFAULT_FACE_ANIMATION, label: "Layer default" }, { value: "", label: "None" }, ...(metas[selectedAnimationClip.layer.id]?.animations ?? []).map((animation) => ({ value: animation, label: animation }))]} onChange={(value) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { faceAnimation: value === LAYER_DEFAULT_FACE_ANIMATION ? undefined : value })} /></div>
            <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedAnimationClip.clip.start.toFixed(3))} min={0} step={0.001} precision={3} unit="s" onCommit={(value) => moveAnimationClipTo(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, value)} /><NumberField label="End" value={Number(animationClipEnd(selectedAnimationClip.clip, animationDurations[`${selectedAnimationClip.layer.id}:${selectedAnimationClip.clip.animation}`] ?? 0).toFixed(3))} min={selectedAnimationClip.clip.start + 0.01} step={0.001} precision={3} unit="s" onCommit={(value) => updateAnimationClip(selectedAnimationClip.layer.id, selectedAnimationClip.clip.id, { endMode: "manual", end: Math.max(selectedAnimationClip.clip.start + 0.01, value) })} /></div>
            {matchAnimationLengthButton(selectedAnimationClip.layer, selectedAnimationClip.clip)}
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
             <div className="timeline-color-fade-controls">
               <BoundedSliderField label="Fade in" value={selectedColorClip.fadeIn} defaultValue={0} min={0} max={selectedColorClip.end - selectedColorClip.start} step={0.01} precision={2} unit="s" disabled={selectedColorLayer.locked} onCommit={(fadeIn) => updateColorClip(selectedColorClip.id, { fadeIn })} />
               <BoundedSliderField label="Fade out" value={selectedColorClip.fadeOut} defaultValue={0} min={0} max={selectedColorClip.end - selectedColorClip.start} step={0.01} precision={2} unit="s" disabled={selectedColorLayer.locked} onCommit={(fadeOut) => updateColorClip(selectedColorClip.id, { fadeOut })} />
             </div>
             <small className="editor-field-hint">Adjust with the sliders or values, or drag the fade markers on the timeline.</small>
             <label>Preset<select value="custom" disabled={selectedColorLayer.locked} onChange={(event) => event.target.value !== "custom" && applyColorClipPreset(event.target.value as ColorClipPreset)}><option value="custom">Custom</option><option value="solid">Solid hold</option><option value="fade-from-black">Fade from black</option><option value="fade-to-black">Fade to black</option><option value="white-flash">White flash</option></select></label>
            <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedColorClip.enabled} disabled={selectedColorLayer.locked} onChange={(event) => updateColorClip(selectedColorClip.id, { enabled: event.target.checked })} /> Enabled</span></label>
            {selectedColorClip.fadeIn + selectedColorClip.fadeOut >= selectedColorClip.end - selectedColorClip.start - 0.001 && (selectedColorClip.fadeIn > 0 || selectedColorClip.fadeOut > 0) && <small className="editor-field-hint">Fades fill the clip duration; changing one scales both fades to fit.</small>}
          </section>}

           {inspector === "layer" && selectedLayer && <section className="editor-section editor-inspector">
           <div className="editor-section-title"><strong>Layer</strong><span><i className={`timeline-role-dot ${selectedLayer.role}`} /> {roleLabel(selectedLayer.role)} <button className="danger" onClick={removeLayer} disabled={selectedLayer.role === "character" || selectedLayer.locked}>Remove</button></span></div>
           <label>Name<input value={selectedLayer.name} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { name: event.target.value })} /></label>
           <div className="editor-two-fields"><label>Role<select value={selectedLayer.role} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { role: event.target.value as TimelineLayerRole })}><option value="background">Background</option><option value="scene">Scene</option><option value="character">Character</option><option value="overlay">Overlay</option></select></label><NumberField label="Order" value={Math.max(0, displayVisualTracks.findIndex((track) => track.kind === "spine" && track.layer.id === selectedLayer.id))} min={0} max={Math.max(0, displayVisualTracks.length - 1)} step={1} disabled={selectedLayer.locked} onCommit={(order) => { const target = displayVisualTracks[Math.max(0, Math.min(displayVisualTracks.length - 1, Math.round(order)))]; if (target) reorderVisualTrack(`spine:${selectedLayer.id}`, visualTrackKey(target)); }} /></div>
           <label>Blend mode<select value={selectedLayer.blendMode ?? "normal"} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { blendMode: event.target.value as EditorTimelineLayer["blendMode"] })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="additive">Additive</option></select></label>
            <div className="editor-animation-field"><span>{selectedLayer.followMainAnimation ? "Fallback animation" : "Animation"}</span><AnimationPicker ariaLabel={selectedLayer.followMainAnimation ? "Fallback animation" : "Layer animation"} disabled={selectedLayer.locked} value={selectedLayer.animation || metas[selectedLayer.id]?.idleAnimation || ""} options={[{ value: "", label: metas[selectedLayer.id]?.idleAnimation ? "Auto idle" : "No idle detected · choose animation" }, ...(metas[selectedLayer.id]?.animations ?? []).map((animation) => ({ value: animation, label: animation }))]} onChange={(animation) => updateLayer(selectedLayer.id, { animation })} /></div>
           {selectedLayer.role !== "character" && <label><span className="timeline-inline-check"><input type="checkbox" disabled={selectedLayer.locked} checked={selectedLayer.followMainAnimation === true} onChange={(event) => updateLayer(selectedLayer.id, { followMainAnimation: event.target.checked })} /> Follow main character animation</span><small className="editor-field-hint">Uses a matching animation and clock when available.</small></label>}
            <div className="editor-animation-field"><span>Face / secondary animation</span><AnimationPicker ariaLabel="Layer face or secondary animation" disabled={selectedLayer.locked} value={selectedLayer.faceAnimation ?? ""} options={[{ value: "", label: "None" }, ...(metas[selectedLayer.id]?.animations ?? []).map((name) => ({ value: name, label: name }))]} onChange={(faceAnimation) => updateLayer(selectedLayer.id, { faceAnimation })} /></div>
           <div className="editor-two-fields"><NumberField label="Start" value={Number(selectedLayer.start.toFixed(3))} min={0} step={0.001} precision={3} unit="s" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { start: Math.max(0, value) })} /><NumberField label="End" value={Number(selectedLayer.end.toFixed(3))} min={selectedLayer.start + 0.01} step={0.001} precision={3} unit="s" disabled={selectedLayer.locked} onCommit={(value) => updateLayer(selectedLayer.id, { endMode: "manual", end: Math.max(selectedLayer.start + 0.01, value) })} /></div>
           {!Array.isArray(selectedLayer.animationClips) && matchAnimationLengthButton(selectedLayer)}
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
     {renderCameraContextMenu()}
     {timelineContextMenu && <ContextMenu
      x={timelineContextMenu.x}
      y={timelineContextMenu.y}
      label={timelineContextMenu.target.kind === "preview" ? "Timeline preview actions" : "Timeline actions"}
      actions={timelineContextActions(timelineContextMenu.target)}
      onClose={() => setTimelineContextMenu(null)}
      returnFocusTo={timelineContextMenu.returnFocusTo}
    />}
  </>;
}
