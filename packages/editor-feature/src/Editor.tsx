import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  SpineRenderer,
  type SpineEditorFrame,
  type SpineFiles,
  type SpineLoadProgress,
  type SpineMeta,
  type SpineProgress,
} from "@ba-spine/spine-runtime/spine/spineRuntime";
import { DEFAULT_EFFECTS_STRENGTH } from "@ba-spine/spine-runtime/spine/spineEffects";
import { hasLegacySquareCameraAspectRatio } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import {
  blankInteraction,
  blankRegion,
  cloneProject,
  createProject,
  DEFAULT_EDITOR_VIEW_SETTINGS,
  EDITOR_VIEW_SETTINGS_KEY,
  normalizeProject,
  normalizeViewSettings,
  LEGACY_EDITOR_SCHEMA_VERSION,
  repairPinchRegions,
  validateProject,
  type EditorValidationWarning,
  type EditorInteraction,
  type EditorProject,
  type EditorRegion,
  type EditorViewSettings,
} from "./editorModel";
import "./editor.css";
import { InteractionPreview, type InteractionPreviewDebug } from "./preview";
import { hitRegion, inversePoint, regionMatrix, screenToWorld } from "./geometry";
import { detectHeadRegion, repairPatRegions, type HeadRegion } from "./headRegion";
import { TimelineWorkspace } from "./TimelineWorkspace";
import { acknowledgeDesktopHandoff, chooseDesktopProject, chooseDesktopSource, chooseDesktopSourceAt, DesktopSaveConflictError, isDesktopHost, publishDesktopDraft, publishDesktopEditorSaveState, receiveDesktopHandoffs, revokeDesktopDraft, sendDesktopHandoff, type DesktopAssetSource, type DesktopSaveFile } from "./desktopSource";
import { libraryIdentityForPath, type SpineDraftSnapshot } from "@ba-spine/platform-contracts/handoff";
import { normalizeRecentFiles, RECENT_FILES_KEY, rememberRecentFile, removeRecentFile, type RecentFile, type RecentFileKind } from "./recentFiles";
import { AssetPickerModal } from "./AssetPickerModal";
import { BonePicker } from "./BonePicker";
import { BoneNavigator, type BoneRevealRequest } from "./BoneNavigator";
import { CommandPalette, type EditorCommand } from "./CommandPalette";
import { AnimationPicker } from "./AnimationPicker";
import { AnimationPhaseEditor } from "./components/AnimationPhaseEditor";
import { BoundedSliderField } from "./components/BoundedSliderField";
import { InteractionSummary } from "./components/InteractionSummary";
import { NumberField } from "./components/NumberField";
import { SaveStatus } from "./components/SaveStatus";
import { WorkspacePresetMenu } from "./components/WorkspacePresetMenu";
import { suggestInteractionPhases } from "./interactionSuggestions";
import { characterDirectoryLabel, parseCharacterDirectoryCatalog, type CharacterDirectoryInfo, type CharacterDirectoryLabels } from "./characterCatalog";
import { captureEditorProjectBaseline, editorProjectDraftValue, pendingProjectForDirectory, prepareEditorProjectSave, readSavedEditorProject, type EditorSaveFile } from "./editorProject";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";
import { persistRecoverySnapshot, readLegacyRecoveryRecord, readRecoveryRecord, validRecoveryProject } from "./recoverySnapshots";
import { confirmProjectReplacement } from "./projectReplacement";
import { isCommandPaletteShortcut, isTextEditingTarget } from "./editorKeyboard";
import "./validationIssues.css";
import type { EditorMcpCommand, EditorMcpState, EditorMcpTimelineBridge, EditorMcpTimelineSnapshot } from "./editorMcp";
import { WaveformProfileRecorder } from "./waveformProfileDiagnostics";
import type { AudioWaveformMeasurement } from "./AudioWaveform";
import { DEFAULT_EDITOR_LAYOUT_PREFERENCES, EDITOR_LAYOUT_PREFERENCES_KEY, normalizeEditorLayoutPreferences, type WorkspaceLayoutPreset } from "./editorLayout";
import { IconAlert, IconCheck, IconChevronDown, IconClose, IconEye, IconExpand, IconFile, IconFolder, IconHand, IconHelp, IconMenu, IconMessage, IconMore, IconPause, IconPlay, IconPlus, IconSave, IconSearch, IconSliders, IconSound, IconTarget } from "@ba-spine/app-ui/icons";
import { AboutPage } from "@ba-spine/app-ui/AboutPage";
import { useReleaseUpdates } from "@ba-spine/app-ui/releaseUpdates";
import { usePortableSuiteUpdates } from "@ba-spine/app-ui/portableSuiteUpdates";

declare const __EDITOR_WAVEFORM_PROFILE__: boolean;

function displayName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function nativePath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replaceAll("/", separator)}`;
}

function readStoredViewSettings(): EditorViewSettings {
  try {
    const stored = localStorage.getItem(EDITOR_VIEW_SETTINGS_KEY);
    return (stored ? normalizeViewSettings(JSON.parse(stored) as unknown) : null) ?? DEFAULT_EDITOR_VIEW_SETTINGS;
  } catch {
    return DEFAULT_EDITOR_VIEW_SETTINGS;
  }
}

function readStoredLayoutPreferences() {
  try {
    const stored = localStorage.getItem(EDITOR_LAYOUT_PREFERENCES_KEY);
    return (stored ? normalizeEditorLayoutPreferences(JSON.parse(stored) as unknown) : null) ?? DEFAULT_EDITOR_LAYOUT_PREFERENCES;
  } catch {
    return DEFAULT_EDITOR_LAYOUT_PREFERENCES;
  }
}

function readRecentFiles(): RecentFile[] {
  try {
    const stored = localStorage.getItem(RECENT_FILES_KEY);
    return normalizeRecentFiles(stored ? JSON.parse(stored) as unknown : null);
  } catch {
    return [];
  }
}

function recentKindLabel(kind: RecentFileKind): string {
  return kind === "folder" ? "ASSET ROOT" : kind === "project" ? "PROJECT" : kind === "subtitle" ? "SUBTITLE" : "AUDIO";
}

interface BoneOverlayProps {
  frame: SpineEditorFrame | null;
  project: EditorProject | null;
  viewSettings: EditorViewSettings;
  motionLimits: MotionLimitOverlay | null;
  onSelectBone: (path: string) => void;
  onSelectRegion: (interactionId: string, regionId: string) => void;
  onBeginRegionDrag: () => void;
  onDragRegion: (interactionId: string, regionId: string, x: number, y: number) => void;
  tool: "select" | "pan" | "draw";
  onChangeRegion: (interactionId: string, regionId: string, patch: Partial<EditorRegion>) => void;
}

interface MotionLimitOverlay {
  targetBonePath: string | null;
  limitX: number;
  limitY: number;
  offsetX: number;
  offsetY: number;
  allowX: boolean;
  allowY: boolean;
  rotationEnabled: boolean;
  rotationMin: number;
  rotationMax: number;
}

interface RegionGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
}

interface RegionAnchor {
  screenX: number;
  screenY: number;
  screenLocalXEndX: number;
  screenLocalXEndY: number;
  screenLocalYEndX: number;
  screenLocalYEndY: number;
}

function regionAnchor(frame: SpineEditorFrame, region: EditorRegion): RegionAnchor {
  const bone = frame.bones.find((item) => item.path === region.anchorBone);
  if (bone) return bone;
  return {
    screenX: frame.screenOriginX,
    screenY: frame.screenOriginY,
    screenLocalXEndX: frame.screenUnitXEndX,
    screenLocalXEndY: frame.screenUnitXEndY,
    screenLocalYEndX: frame.screenUnitYEndX,
    screenLocalYEndY: frame.screenUnitYEndY,
  };
}

function regionGeometry(frame: SpineEditorFrame, region: EditorRegion): RegionGeometry {
  const anchor = regionAnchor(frame, region);
  const xAxis = { x: anchor.screenLocalXEndX - anchor.screenX, y: anchor.screenLocalXEndY - anchor.screenY };
  const yAxis = { x: anchor.screenLocalYEndX - anchor.screenX, y: anchor.screenLocalYEndY - anchor.screenY };
  return {
    cx: anchor.screenX + xAxis.x * region.offsetX + yAxis.x * region.offsetY,
    cy: anchor.screenY + xAxis.y * region.offsetX + yAxis.y * region.offsetY,
    rx: Math.max(3, Math.hypot(xAxis.x, xAxis.y) * region.radiusX),
    ry: Math.max(3, Math.hypot(yAxis.x, yAxis.y) * region.radiusY),
    rotation: Math.atan2(xAxis.y, xAxis.x) * 180 / Math.PI + region.rotation,
  };
}

function motionLimitGeometry(frame: SpineEditorFrame, overlay: MotionLimitOverlay) {
  const target = frame.bones.find((bone) => bone.path === overlay.targetBonePath);
  if (!target) return null;
  const parent = frame.bones.find((bone) => bone.path === target.parentPath);
  const xAxis = parent
    ? { x: parent.screenLocalXEndX - parent.screenX, y: parent.screenLocalXEndY - parent.screenY }
    : { x: frame.screenUnitXEndX - frame.screenOriginX, y: frame.screenUnitXEndY - frame.screenOriginY };
  const yAxis = parent
    ? { x: parent.screenLocalYEndX - parent.screenX, y: parent.screenLocalYEndY - parent.screenY }
    : { x: frame.screenUnitYEndX - frame.screenOriginX, y: frame.screenUnitYEndY - frame.screenOriginY };
  const currentX = target.screenX;
  const currentY = target.screenY;
  return {
    centerX: currentX - xAxis.x * overlay.offsetX - yAxis.x * overlay.offsetY,
    centerY: currentY - xAxis.y * overlay.offsetX - yAxis.y * overlay.offsetY,
    currentX,
    currentY,
    radiusX: Math.max(8, Math.hypot(xAxis.x, xAxis.y) * Math.max(1, overlay.limitX)),
    radiusY: Math.max(8, Math.hypot(yAxis.x, yAxis.y) * Math.max(1, overlay.limitY)),
    rotation: Math.atan2(xAxis.y, xAxis.x) * 180 / Math.PI,
    boneEndX: target.screenEndX,
    boneEndY: target.screenEndY,
    boneRotation: Math.atan2(target.screenEndY - target.screenY, target.screenEndX - target.screenX) * 180 / Math.PI,
    rotationRadius: Math.max(18, Math.min(48, Math.max(Math.hypot(xAxis.x, xAxis.y) * Math.max(1, overlay.limitX), Math.hypot(yAxis.x, yAxis.y) * Math.max(1, overlay.limitY)) * 0.35)),
  };
}

function arcPath(cx: number, cy: number, radius: number, startDegrees: number, endDegrees: number): string {
  const point = (degrees: number) => {
    const radians = degrees * Math.PI / 180;
    return { x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius };
  };
  const start = point(startDegrees);
  const end = point(endDegrees);
  const largeArc = Math.abs(endDegrees - startDegrees) > 180 ? 1 : 0;
  const sweep = endDegrees >= startDegrees ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
}

function BoneOverlay({ frame, project, viewSettings, motionLimits, tool, onSelectBone, onSelectRegion, onBeginRegionDrag, onDragRegion, onChangeRegion }: BoneOverlayProps) {
  const drag = useRef<{ interactionId: string; regionId: string; startX: number; startY: number; offsetX: number; offsetY: number; frame: SpineEditorFrame } | null>(null);
  const handleDrag = useRef<{ interactionId: string; region: EditorRegion; frame: SpineEditorFrame; kind: "resize" | "rotate" } | null>(null);
  if (!frame || !project) return null;
  const bones = frame.bones.filter((bone) => viewSettings.showInactiveBones || bone.active);
  const selectedBone = project.selectedBonePath;
  const regions = project.interactions.flatMap((interaction) => interaction.regions.map((region) => ({ interaction, region })));
  const motion = motionLimits ? motionLimitGeometry(frame, motionLimits) : null;

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const handle = handleDrag.current;
    if (handle) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) * frame.canvasWidth / rect.width;
      const y = (event.clientY - rect.top) * frame.canvasHeight / rect.height;
      const point = inversePoint(regionMatrix(handle.frame, handle.region), x, y);
      if (!point) return;
      onChangeRegion(handle.interactionId, handle.region.id, handle.kind === "resize"
        ? { radiusX: Math.max(1, Math.abs(point.x)), radiusY: Math.max(1, Math.abs(point.y)) }
        : { rotation: Math.round(handle.region.rotation + Math.atan2(point.y, point.x) * 180 / Math.PI - 90) });
      return;
    }
    const current = drag.current;
    if (!current) return;
    const region = project.interactions.flatMap((item) => item.regions).find((item) => item.id === current.regionId);
    if (!region) return;
    const target = regionAnchor(current.frame, region);
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - current.startX) * frame.canvasWidth / rect.width;
    const dy = (event.clientY - current.startY) * frame.canvasHeight / rect.height;
    const ax = target.screenLocalXEndX - target.screenX;
    const ay = target.screenLocalXEndY - target.screenY;
    const bx = target.screenLocalYEndX - target.screenX;
    const by = target.screenLocalYEndY - target.screenY;
    const determinant = ax * by - bx * ay;
    if (Math.abs(determinant) < 0.0001) return;
    const localX = current.offsetX + (dx * by - bx * dy) / determinant;
    const localY = current.offsetY + (ax * dy - dx * ay) / determinant;
    onDragRegion(current.interactionId, current.regionId, localX, localY);
  };

  return (
    <svg
      className={`editor-overlay tool-${tool}`}
      viewBox={`0 0 ${frame.canvasWidth} ${frame.canvasHeight}`}
      preserveAspectRatio="none"
      onPointerMove={move}
      onPointerUp={() => { drag.current = null; handleDrag.current = null; }}
      onPointerCancel={() => { drag.current = null; handleDrag.current = null; }}
      aria-label="Spine editing overlay"
    >
      <defs>
        <marker id="editor-motion-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto" markerUnits="strokeWidth">
          <path d="M 0 0 L 7 3.5 L 0 7 z" fill="var(--editor-pink)" />
        </marker>
      </defs>
      {motion && <g className="editor-motion-gizmo" aria-label="Local movement and rotation limits">
        <g className="editor-motion-translation" transform={`rotate(${motion.rotation} ${motion.centerX} ${motion.centerY})`}>
          <ellipse cx={motion.centerX} cy={motion.centerY} rx={motion.radiusX} ry={motion.radiusY} />
          <line className={motionLimits?.allowX ? "is-enabled" : "is-locked"} x1={motion.centerX - motion.radiusX} y1={motion.centerY} x2={motion.centerX + motion.radiusX} y2={motion.centerY} />
          <line className={motionLimits?.allowY ? "is-enabled" : "is-locked"} x1={motion.centerX} y1={motion.centerY - motion.radiusY} x2={motion.centerX} y2={motion.centerY + motion.radiusY} />
          <circle className={motionLimits?.allowX ? "is-enabled" : "is-locked"} cx={motion.centerX + motion.radiusX} cy={motion.centerY} r={4} />
          <circle className={motionLimits?.allowY ? "is-enabled" : "is-locked"} cx={motion.centerX} cy={motion.centerY - motion.radiusY} r={4} />
          <text className="editor-motion-label x" x={motion.centerX + motion.radiusX + 7} y={motion.centerY + 4}>X</text>
          <text className="editor-motion-label y" x={motion.centerX + 5} y={motion.centerY - motion.radiusY - 6}>Y</text>
        </g>
        <line className="editor-motion-displacement" x1={motion.centerX} y1={motion.centerY} x2={motion.currentX} y2={motion.currentY} />
        <circle className="editor-motion-origin" cx={motion.centerX} cy={motion.centerY} r={4} />
        <circle className="editor-motion-current" cx={motion.currentX} cy={motion.currentY} r={5} />
        <line className="editor-motion-bone" x1={motion.centerX} y1={motion.centerY} x2={motion.boneEndX} y2={motion.boneEndY} />
        {motionLimits?.rotationEnabled && <path className="editor-motion-rotation" d={arcPath(motion.centerX, motion.centerY, motion.rotationRadius, motion.boneRotation - motionLimits.rotationMax, motion.boneRotation - motionLimits.rotationMin)} />}
        <circle className={motionLimits?.rotationEnabled ? "editor-motion-rotation-handle is-enabled" : "editor-motion-rotation-handle is-locked"} cx={motion.centerX} cy={motion.centerY} r={6} />
        <text className="editor-motion-label rotation" x={motion.centerX + motion.rotationRadius + 5} y={motion.centerY - 5}>R</text>
      </g>}
      {viewSettings.showBones && bones.map((bone) => (
        <g key={bone.path} className={`editor-bone${bone.path === selectedBone ? " is-selected" : ""}`}>
          <line x1={bone.screenX} y1={bone.screenY} x2={bone.screenEndX} y2={bone.screenEndY} onClick={() => onSelectBone(bone.path)} />
          <circle cx={bone.screenX} cy={bone.screenY} r={bone.path === selectedBone ? 6 : 3} onClick={() => onSelectBone(bone.path)} />
          {viewSettings.showBoneNames && <text x={bone.screenX + 7} y={bone.screenY - 5}>{bone.name}</text>}
        </g>
      ))}
      {viewSettings.showConstraints && frame.constraints.map((constraint) => {
        const target = bones.find((bone) => bone.name === constraint.target);
        if (!target) return null;
        return constraint.bones.map((boneName) => {
          const bone = bones.find((item) => item.name === boneName);
          if (!bone) return null;
          return <line key={`${constraint.name}-${bone.path}`} className="editor-constraint" x1={target.screenX} y1={target.screenY} x2={bone.screenX} y2={bone.screenY} />;
        });
      })}
      {regions.filter(({ region }) => region.enabled).map(({ interaction, region }) => {
        const geometry = regionGeometry(frame, region);
        const matrix = regionMatrix(frame, region);
        const transform = `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
        const selected = project.selectedInteractionId === interaction.id && project.selectedRegionId === region.id;
        const startDrag = (event: ReactPointerEvent<SVGElement>) => {
          event.stopPropagation();
          (event.currentTarget as SVGElement & { setPointerCapture: (pointerId: number) => void }).setPointerCapture(event.pointerId);
          onSelectRegion(interaction.id, region.id);
          onBeginRegionDrag();
          drag.current = { interactionId: interaction.id, regionId: region.id, startX: event.clientX, startY: event.clientY, offsetX: region.offsetX, offsetY: region.offsetY, frame };
        };
        const shape = region.shape === "rectangle"
          ? <rect
              x={-region.radiusX}
              y={-region.radiusY}
              width={region.radiusX * 2}
              height={region.radiusY * 2}
              transform={transform}
              vectorEffect="non-scaling-stroke"
              onPointerDown={startDrag}
              onClick={(event) => { event.stopPropagation(); onSelectRegion(interaction.id, region.id); }}
            />
          : <ellipse
              cx={0}
              cy={0}
              rx={region.radiusX}
              ry={region.radiusY}
              transform={transform}
              vectorEffect="non-scaling-stroke"
              onPointerDown={startDrag}
              onClick={(event) => { event.stopPropagation(); onSelectRegion(interaction.id, region.id); }}
            />;
        return (
          <g key={`${interaction.id}-${region.id}`} className={`editor-region${selected ? " is-selected" : ""}`} style={{ color: interaction.color }}>
            {shape}
            {selected && <text x={geometry.cx} y={geometry.cy}>{region.name}</text>}
            {selected && tool === "select" && (["resize", "rotate"] as const).map((kind) => {
              const localX = kind === "resize" ? region.radiusX : 0;
              const localY = region.radiusY + (kind === "rotate" ? 35 : 0);
              return <circle key={kind} className={`editor-handle ${kind}`} cx={matrix.e + matrix.a * localX + matrix.c * localY} cy={matrix.f + matrix.b * localX + matrix.d * localY} r={7} onPointerDown={(event) => {
                event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); onBeginRegionDrag();
                handleDrag.current = { interactionId: interaction.id, region: { ...region }, frame, kind };
              }}><title>{kind === "resize" ? "Drag to resize" : "Drag to rotate"}</title></circle>;
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function Editor() {
  useEffect(() => {
    const preventWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    const preventGestureZoom = (event: Event) => event.preventDefault();
    const preventTouchPinchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const preventKeyboardZoom = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "_", "0"].includes(event.key)) event.preventDefault();
    };
    const nonPassiveCapture: AddEventListenerOptions = { capture: true, passive: false };
    document.addEventListener("wheel", preventWheelZoom, nonPassiveCapture);
    document.addEventListener("gesturestart", preventGestureZoom, nonPassiveCapture);
    document.addEventListener("gesturechange", preventGestureZoom, nonPassiveCapture);
    document.addEventListener("touchmove", preventTouchPinchZoom, nonPassiveCapture);
    document.addEventListener("keydown", preventKeyboardZoom, true);
    return () => {
      document.removeEventListener("wheel", preventWheelZoom, true);
      document.removeEventListener("gesturestart", preventGestureZoom, true);
      document.removeEventListener("gesturechange", preventGestureZoom, true);
      document.removeEventListener("touchmove", preventTouchPinchZoom, true);
      document.removeEventListener("keydown", preventKeyboardZoom, true);
    };
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineRenderer | null>(null);
  const metaRef = useRef<SpineMeta | null>(null);
  const directoryRef = useRef("");
  const projectRef = useRef<EditorProject | null>(null);
  const initializedAssetRef = useRef("");
  const loadedAssetRef = useRef<{ source: DesktopAssetSource | null; directory: string }>({ source: null, directory: "" });
  const previewRef = useRef(new InteractionPreview());
  const stageRef = useRef<HTMLDivElement>(null);
  const testPointerRef = useRef<number | null>(null);
  const headRegionRef = useRef<HeadRegion | null>(null);
  const headDetectionDone = useRef(false);
  const drawRef = useRef<{ x: number; y: number } | null>(null);
  const editorKeydownRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const [drawBox, setDrawBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const panelDragRef = useRef<{ side: "left" | "right"; x: number; width: number } | null>(null);
  const [storedLayoutPreferences] = useState(() => readStoredLayoutPreferences());
  const [leftWidth, setLeftWidth] = useState(storedLayoutPreferences.leftWidth);
  const [rightWidth, setRightWidth] = useState(storedLayoutPreferences.rightWidth);
  const [layoutPreset, setLayoutPreset] = useState<WorkspaceLayoutPreset>(storedLayoutPreferences.preset);
  const [testing, setTesting] = useState(false);
  const [tool, setTool] = useState<"select" | "pan" | "draw">("select");
  const [inspectorTab, setInspectorTab] = useState<"region" | "animation" | "movement">("region");
  const [showTestRegions, setShowTestRegions] = useState(true);
  const [previewDebug, setPreviewDebug] = useState<InteractionPreviewDebug>(() => previewRef.current.debug);
  const [leftHidden, setLeftHidden] = useState(storedLayoutPreferences.leftHidden);
  const [rightHidden, setRightHidden] = useState(storedLayoutPreferences.rightHidden);
  const [help, setHelp] = useState(false);
  const [aboutPage, setAboutPage] = useState(false);
  const releaseUpdates = useReleaseUpdates(__APP_VERSION__);
  const suiteUpdates = usePortableSuiteUpdates(
    releaseUpdates.state.latestRelease,
    __APP_VERSION__,
    releaseUpdates.automaticChecks && releaseUpdates.state.status === "available",
  );
  const closeAboutPage = useCallback(() => setAboutPage(false), []);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const validationDetailsRef = useRef<HTMLDetailsElement>(null);
  const [workspace, setWorkspace] = useState<"interaction" | "timeline" | "camera">("interaction");
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [initialTimelineHandoff, setInitialTimelineHandoff] = useState<{ requestId: string; sequenceId: string; playheadSeconds?: number } | null>(null);
  const [companionStatus, setCompanionStatus] = useState<string | null>(null);
  const [draftPreviewSessionId, setDraftPreviewSessionId] = useState<string | null>(null);
  const draftPreviewSessionRef = useRef<{ sessionId: string; rootPath: string; lobbyId: string; revision: number } | null>(null);
  const [previewStatus, setPreviewStatus] = useState("Idle");
  const [source, setSource] = useState<DesktopAssetSource | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [directoryLabels, setDirectoryLabels] = useState<CharacterDirectoryLabels>({});
  const [directoryInfo, setDirectoryInfo] = useState<Record<string, CharacterDirectoryInfo>>({});
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<SpineFiles | null>(null);
  const [meta, setMeta] = useState<SpineMeta | null>(null);
  const [frame, setFrame] = useState<SpineEditorFrame | null>(null);
  const [progress, setProgress] = useState<SpineProgress>({ time: 0, duration: 0, animation: null });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [selectedAnimation, setSelectedAnimation] = useState("");
  const [animationSelectionOrigin, setAnimationSelectionOrigin] = useState<"automatic" | "explicit">("automatic");
  const [project, setProject] = useState<EditorProject | null>(null);
  const timelineSaveRef = useRef<((getProject: () => EditorProject | null) => Promise<EditorSaveFile[]>) | null>(null);
  const workspaceRef = useRef<"interaction" | "timeline" | "camera">(workspace);
  const sourceRef = useRef<DesktopAssetSource | null>(source);
  const saveBaselineRef = useRef<{ rootPath: string; directory: string; versions: Record<string, string> } | null>(null);
  const projectSaveQueueRef = useRef(Promise.resolve());
  const pendingProjectRef = useRef<EditorProject | null>(null);
  const handledHandoffIdsRef = useRef(new Set<string>());
  const [viewSettings, setViewSettings] = useState<EditorViewSettings>(() => readStoredViewSettings());
  const [undo, setUndo] = useState<EditorProject[]>([]);
  const [redo, setRedo] = useState<EditorProject[]>([]);
  const [boneRevealRequest, setBoneRevealRequest] = useState<BoneRevealRequest | null>(null);
  const boneRevealRevisionRef = useRef(0);
  const [interactionSearch, setInteractionSearch] = useState("");
  const [status, setStatus] = useState("Open a Spine asset folder to begin.");
  const [error, setError] = useState<string | null>(null);
  const [legacyAspectRatioNotice, setLegacyAspectRatioNotice] = useState(false);
  const [assetLoading, setAssetLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<SpineLoadProgress>({ stage: "files", loaded: 0, total: 0 });
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const editorUpdateStateWriteRef = useRef<Promise<void>>(Promise.resolve());
  const [recoveryPrompt, setRecoveryPrompt] = useState<{ rootPath: string; directory: string; current: EditorProject | null; backups: EditorProject[]; savedAt: number; legacyCurrent: boolean; legacyBackups: boolean[] } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => readRecentFiles());
  const [pendingSubtitlePath, setPendingSubtitlePath] = useState<string | null>(null);
  const [pendingAudioPaths, setPendingAudioPaths] = useState<string[] | null>(null);
  const recentFilesRef = useRef<RecentFile[]>(recentFiles);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [waveformProfileRecording, setWaveformProfileRecording] = useState(false);
  const waveformProfileRef = useRef<WaveformProfileRecorder | null>(null);
  const mcpEnabledRef = useRef(false);
  const mcpCommandRef = useRef<(command: EditorMcpCommand, expectedDocumentRevision?: number) => Promise<unknown>>(async () => { throw new Error("The editor MCP bridge is not ready."); });
  const mcpTimelineRef = useRef<EditorMcpTimelineBridge | null>(null);
  const mcpTimelineSnapshotRef = useRef<EditorMcpTimelineSnapshot | null>(null);
  const mcpSnapshotRef = useRef<EditorMcpState | null>(null);
  const mcpPublishTimerRef = useRef<number | null>(null);
  const mcpRuntimeErrorsRef = useRef<Array<{ time: string; message: string }>>([]);
  const saveStateRef = useRef(saveState);
  const cameraEditTransactionRef = useRef<{ project: EditorProject; redo: EditorProject[]; saveState: typeof saveState } | null>(null);
  const saveResultRef = useRef<{ ok: boolean; error: string | null; savedDocumentRevision?: number; writtenPaths?: string[]; verifiedVersions?: Record<string, string> } | null>(null);
  const recoveryPromptRef = useRef<{ rootPath: string; directory: string; current: EditorProject | null; backups: EditorProject[]; savedAt: number; legacyCurrent: boolean; legacyBackups: boolean[] } | null>(null);
  const mcpDocumentFingerprintRef = useRef<string | null>(null);
  const mcpDocumentRevisionRef = useRef(0);

  projectRef.current = project;
  directoryRef.current = directory;
  metaRef.current = meta;
  sourceRef.current = source;
  workspaceRef.current = workspace;
  recentFilesRef.current = recentFiles;
  saveStateRef.current = saveState;
  mcpEnabledRef.current = mcpEnabled;
  const viewSettingsRef = useRef<EditorViewSettings>(viewSettings);
  viewSettingsRef.current = viewSettings;
  function currentMcpDocumentRevision(): number {
    const current = projectRef.current;
    if (!current) {
      if (mcpDocumentFingerprintRef.current !== null) {
        mcpDocumentFingerprintRef.current = null;
        mcpDocumentRevisionRef.current += 1;
      }
      return mcpDocumentRevisionRef.current;
    }
    const fingerprint = JSON.stringify(current);
    if (fingerprint !== mcpDocumentFingerprintRef.current) {
      mcpDocumentFingerprintRef.current = fingerprint;
      mcpDocumentRevisionRef.current += 1;
    }
    return mcpDocumentRevisionRef.current;
  }
  mcpSnapshotRef.current = {
    documentRevision: currentMcpDocumentRevision(),
    workspace,
    assetRoot: source?.rootPath ?? null,
    assetSets: directories,
    directory: directory || null,
    assetLoading,
    loadProgress: { stage: loadProgress.stage, loaded: loadProgress.loaded, total: loadProgress.total },
    status,
    error,
    saveState,
    animations: meta?.animations ?? [],
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    runtimeErrors: [...mcpRuntimeErrorsRef.current],
    timeline: mcpTimelineSnapshotRef.current,
    waveformProfile: __EDITOR_WAVEFORM_PROFILE__ ? waveformProfileRef.current?.snapshot(performance.now()) ?? null : null,
  };

  function refreshMcpSnapshot(): EditorMcpState | null {
    const current = mcpSnapshotRef.current;
    if (!current) return null;
    const timeline = mcpTimelineRef.current?.snapshot() ?? mcpTimelineSnapshotRef.current;
    const next = {
      ...current,
      documentRevision: currentMcpDocumentRevision(),
      timeline,
      waveformProfile: __EDITOR_WAVEFORM_PROFILE__ ? waveformProfileRef.current?.snapshot(performance.now()) ?? null : null,
    };
    mcpTimelineSnapshotRef.current = timeline;
    mcpSnapshotRef.current = next;
    return next;
  }

  async function publishMcpSnapshotNow() {
    if (!mcpEnabledRef.current) return;
    const snapshot = refreshMcpSnapshot();
    if (!snapshot) return;
    await fetch("/__spine/mcp/ui-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }).catch(() => undefined);
  }

  function publishMcpSnapshot() {
    if (!mcpEnabledRef.current || mcpPublishTimerRef.current !== null) return;
    mcpPublishTimerRef.current = window.setTimeout(() => {
      mcpPublishTimerRef.current = null;
      const snapshot = refreshMcpSnapshot();
      if (!snapshot || !mcpEnabledRef.current) return;
      void fetch("/__spine/mcp/ui-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }).catch(() => undefined);
    }, 100);
  }

  function registerMcpTimeline(bridge: EditorMcpTimelineBridge | null) {
    mcpTimelineRef.current = bridge;
    const snapshot = bridge?.snapshot() ?? null;
    mcpTimelineSnapshotRef.current = snapshot;
    if (mcpSnapshotRef.current) mcpSnapshotRef.current = { ...mcpSnapshotRef.current, timeline: snapshot };
    publishMcpSnapshot();
  }

  function publishTimelineMcpSnapshot(snapshot: EditorMcpTimelineSnapshot | null) {
    mcpTimelineSnapshotRef.current = snapshot;
    if (mcpSnapshotRef.current) mcpSnapshotRef.current = { ...mcpSnapshotRef.current, timeline: snapshot };
    publishMcpSnapshot();
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/__spine/mcp/ui-enabled", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ enabled?: unknown }> : { enabled: false })
      .then((value) => { if (!cancelled) setMcpEnabled(value.enabled === true); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!mcpEnabled) return;
    publishMcpSnapshot();
    const heartbeat = window.setInterval(publishMcpSnapshot, 1000);
    return () => window.clearInterval(heartbeat);
  }, [mcpEnabled]);

  useEffect(() => {
    if (!__EDITOR_WAVEFORM_PROFILE__ || !waveformProfileRecording) return;
    const recorder = waveformProfileRef.current;
    if (!recorder?.recording) return;
    let previousFrame: number | null = null;
    let frameRequest = 0;
    let observer: PerformanceObserver | null = null;
    const onVisibilityChange = () => recorder.recordVisibility(document.visibilityState === "visible");
    const sampleFrame = (timestamp: number) => {
      if (!recorder.recording) return;
      if (previousFrame !== null) recorder.recordFrameGap(timestamp - previousFrame);
      previousFrame = timestamp;
      frameRequest = window.requestAnimationFrame(sampleFrame);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) recorder.recordLongTask(entry.duration);
        });
        observer = longTaskObserver;
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        observer?.disconnect();
        observer = null;
      }
    }
    frameRequest = window.requestAnimationFrame(sampleFrame);
    return () => {
      window.cancelAnimationFrame(frameRequest);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      observer?.disconnect();
    };
  }, [waveformProfileRecording]);

  useEffect(() => {
    publishMcpSnapshot();
  }, [assetLoading, directories, directory, error, loadProgress, meta, saveState, source, status, workspace]);

  useEffect(() => {
    if (!mcpEnabled) return;
    const remember = (message: string) => {
      mcpRuntimeErrorsRef.current = [...mcpRuntimeErrorsRef.current.slice(-19), { time: new Date().toISOString(), message }];
      if (mcpSnapshotRef.current) mcpSnapshotRef.current = { ...mcpSnapshotRef.current, runtimeErrors: [...mcpRuntimeErrorsRef.current] };
      publishMcpSnapshot();
    };
    const onError = (event: ErrorEvent) => remember(event.error instanceof Error ? `${event.message}: ${event.error.message}` : event.message);
    const onRejection = (event: PromiseRejectionEvent) => remember(event.reason instanceof Error ? event.reason.message : String(event.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [mcpEnabled]);

  useEffect(() => {
    if (!mcpEnabled) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const response = await fetch("/__spine/mcp/ui-command", { cache: "no-store" });
        if (response.ok) {
          const item = await response.json() as { id?: unknown; command?: unknown; expiresAt?: unknown; expectedDocumentRevision?: unknown } | null;
          if (item && typeof item.id === "string" && item.command && typeof item.command === "object" && (typeof item.expiresAt !== "number" || item.expiresAt > Date.now())) {
            let result: unknown;
            let error: string | undefined;
            const expectedDocumentRevision = Number.isInteger(item.expectedDocumentRevision) && (item.expectedDocumentRevision as number) >= 0 ? item.expectedDocumentRevision as number : undefined;
            try { result = await mcpCommandRef.current(item.command as EditorMcpCommand, expectedDocumentRevision); }
            catch (value) { error = value instanceof Error ? value.message : String(value); }
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            await publishMcpSnapshotNow();
            await fetch("/__spine/mcp/ui-result", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: item.id, result, error }),
            }).catch(() => undefined);
          }
        }
      } catch {
        // The private bridge is optional and should not interrupt editor work.
      } finally {
        if (!cancelled) timer = window.setTimeout(() => { void poll(); }, 120);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mcpEnabled]);

  function withCurrentViewSettings(next: EditorProject): EditorProject {
    return { ...next, ...viewSettingsRef.current };
  }

  const callbacksRef = useRef({
    onMeta: (value: SpineMeta | null) => {},
    onFrame: (value: SpineEditorFrame) => {},
  });
  callbacksRef.current.onMeta = (value) => {
    metaRef.current = value;
    setMeta(value);
    if (!value) {
      headRegionRef.current = null;
      headDetectionDone.current = false;
      setFrame(null);
      setProject(null);
      initializedAssetRef.current = "";
      return;
    }
    const initialAnimation = value.idleAnimation ?? value.defaultAnimation;
    setSelectedAnimation(initialAnimation);
    setAnimationSelectionOrigin("automatic");
    if (initialAnimation) rendererRef.current?.setAnimation(initialAnimation, true);
  };
  callbacksRef.current.onFrame = (value) => {
    const timelineMode = workspaceRef.current !== "interaction";
    if (!timelineMode) setFrame(value);
    const preview = previewRef.current;
    if (!timelineMode) setProgress(preview.phase !== "idle" ? { ...preview.progress, animation: preview.phase } : { time: value.duration > 0 ? value.time % value.duration : 0, duration: value.duration, animation: value.animation });
    if (loadedAssetRef.current.source !== sourceRef.current || loadedAssetRef.current.directory !== directoryRef.current) return;
    const loadedMeta = metaRef.current;
    const key = `${directoryRef.current}:${loadedMeta?.animations.join("|") ?? ""}`;
    if (timelineMode && (!projectRef.current || projectRef.current.assetDirectory !== directoryRef.current || initializedAssetRef.current !== key)) setFrame(value);
    if (loadedMeta && key !== initializedAssetRef.current) {
      initializedAssetRef.current = key;
      let recovery: ReturnType<typeof readRecoveryRecord> = null;
      try {
        recovery = readRecoveryRecord(localStorage, directoryRef.current)
          ?? readLegacyRecoveryRecord(localStorage, `shittim-spine-editor:v${LEGACY_EDITOR_SCHEMA_VERSION}:${directoryRef.current}`);
      } catch {
        recovery = null;
      }
      const original = createProject(directoryRef.current, loadedMeta.animations, value.bones);
      const pending = pendingProjectForDirectory(pendingProjectRef.current, directoryRef.current);
      if (pending) pendingProjectRef.current = null;
      const loadedProject = pending ?? original;
      const repair = repairPatRegions(loadedProject, headRegionRef.current);
      const pinchRepair = repairPinchRegions(repair.project, value.bones);
      const next = withCurrentViewSettings(pinchRepair.project);
      const recoveryProject = recovery && validRecoveryProject(recovery.current.project, directoryRef.current)
        ? normalizeProject(recovery.current.project, directoryRef.current)
        : null;
      const recoveryBackupEntries = recovery?.backups.flatMap((item) => {
        if (!validRecoveryProject(item.project, directoryRef.current)) return [];
        const normalized = normalizeProject(item.project, directoryRef.current);
        return normalized ? [{ project: normalized, legacy: hasLegacySquareCameraAspectRatio(item.project) }] : [];
      }) ?? [];
      const recoveryBackups = recoveryBackupEntries.map((item) => item.project);
      const differsFromLoaded = recoveryProject && JSON.stringify(recoveryProject) !== JSON.stringify(next);
      const prompt = differsFromLoaded || recoveryBackups.length > 0
        ? {
          rootPath: sourceRef.current?.rootPath ?? "",
          directory: directoryRef.current,
          current: recoveryProject,
          backups: recoveryBackups,
          savedAt: recovery?.current.savedAt ?? 0,
          legacyCurrent: Boolean(recovery && hasLegacySquareCameraAspectRatio(recovery.current.project)),
          legacyBackups: recoveryBackupEntries.map((item) => item.legacy),
        }
        : null;
      recoveryPromptRef.current = prompt;
      setRecoveryPrompt(prompt);
      projectRef.current = next;
      setProject(next);
      setUndo(repair.repaired ? [loadedProject] : []);
      setRedo([]);
      setStatus(repair.repaired ? `${pending ? "Loaded project; repaired" : "Detected"} ${repair.repaired} head region(s). Custom regions kept.` : repair.unresolved ? "Head detection needs review. Uncertain default patting regions were disabled, not guessed." : pending ? "Loaded saved project." : "Created detected interaction presets.");
    }
  };

  useEffect(() => {
    // The interaction canvas stays mounted so it can continue loading the
    // selected asset and rebuilding the editor project while the timeline is
    // open. Its WebGL draw path is disabled separately in timeline mode, so
    // only the timeline layer renderers paint the visible preview.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new SpineRenderer(canvas, {
      onBeforeEditorUpdate: () => { if (workspaceRef.current === "interaction") previewRef.current.beforeUpdate(); },
      onEditorUpdate: (delta, skeleton, state) => {
        if (!headDetectionDone.current) {
          headRegionRef.current = detectHeadRegion(skeleton);
          headDetectionDone.current = true;
        }
        if (workspaceRef.current !== "interaction") return;
        previewRef.current.update(delta, skeleton, state);
        const preview = previewRef.current;
        const debug = preview.debug;
        setPreviewDebug(debug);
        setPreviewStatus(debug.phase === "idle" ? "Idle" : `${debug.phase} · ${debug.interactionName} · ${debug.regionName}`);
      },
      onMeta: (value) => callbacksRef.current.onMeta(value),
      onProgress: () => {},
      onLoading: (value) => {
        setAssetLoading(value);
        if (value) setStatus("Loading Spine asset…");
      },
      onLoadProgress: (value) => setLoadProgress(value),
      onError: (value) => {
        setAssetLoading(false);
        setError(value?.message ?? null);
      },
      onEditorFrame: (value) => callbacksRef.current.onFrame(value),
    });
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setRenderEnabled(workspace === "interaction");
  }, [workspace]);

  useEffect(() => {
    loadedAssetRef.current = { source: null, directory: "" };
    initializedAssetRef.current = "";
    metaRef.current = null;
    if (!source || !directory) return;
    let cancelled = false;
    setTesting(false);
    previewRef.current.reset();
    rendererRef.current?.clear();
    setAssetLoading(true);
    setLoadProgress({ stage: "files", loaded: 0, total: 0 });
    setFiles(null);
    void source.getSetFiles(directory).then((value) => { if (!cancelled) setFiles(value); }).catch((value) => {
      if (!cancelled) {
        setAssetLoading(false);
        setError(value instanceof Error ? value.message : String(value));
      }
    });
    return () => { cancelled = true; };
  }, [source, directory]);

  useEffect(() => {
    if (!files || !directory) return;
    loadedAssetRef.current = { source, directory };
    rendererRef.current?.load(files, directory);
    rendererRef.current?.setCameraMode("fit");
  }, [files]);

  useEffect(() => {
    rendererRef.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    rendererRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    rendererRef.current?.setEffectsStrength(project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH);
  }, [project?.effectsStrength]);

  useEffect(() => { resetPreview(); }, [testing]);

  useEffect(() => {
    if (selectedAnimation) rendererRef.current?.setAnimation(selectedAnimation);
  }, [selectedAnimation]);

  useEffect(() => {
    // Directory selection commits before the new asset/project finishes loading.
    // Never autosave the previous student's project under the new student's key.
    if (!project || !directory || project.assetDirectory !== directory) return;
    const pendingRecovery = recoveryPromptRef.current;
    if (pendingRecovery && pendingRecovery.rootPath === source?.rootPath && pendingRecovery.directory === directory) return;
    const timer = window.setTimeout(() => {
      try { persistRecoverySnapshot(localStorage, project); }
      catch { setError("Local recovery storage is unavailable or full. Save files to keep your changes."); }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [project, directory, recoveryPrompt, source?.rootPath]);

  useEffect(() => {
    if (!viewSettings) return;
    try { localStorage.setItem(EDITOR_VIEW_SETTINGS_KEY, JSON.stringify(viewSettings)); }
    catch { /* Display preferences are still useful for this session. */ }
  }, [viewSettings]);

  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_LAYOUT_PREFERENCES_KEY, JSON.stringify({ preset: layoutPreset, leftWidth, rightWidth, leftHidden, rightHidden }));
    } catch { /* Workspace layout is still useful for this session. */ }
  }, [layoutPreset, leftWidth, rightWidth, leftHidden, rightHidden]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState !== "dirty" && saveState !== "error" && saveState !== "saving") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saveState]);

  useEffect(() => {
    const dirty = recoveryPrompt !== null || saveState === "dirty" || saveState === "error" || saveState === "saving";
    editorUpdateStateWriteRef.current = editorUpdateStateWriteRef.current
      .catch(() => undefined)
      .then(() => publishDesktopEditorSaveState(dirty))
      .catch(() => { /* A failed native dirty-state notification must not block editing or save recovery. */ });
  }, [recoveryPrompt, saveState]);

  editorKeydownRef.current = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (aboutPage) {
      if (key === "escape") { event.preventDefault(); setAboutPage(false); }
      return;
    }
    if (isCommandPaletteShortcut(event)) { event.preventDefault(); setCommandPaletteOpen(true); return; }
    if (key === "escape" && commandPaletteOpen) { event.preventDefault(); setCommandPaletteOpen(false); return; }
    if (isTextEditingTarget(event.target)) return;
    if (workspace !== "interaction" && key !== "?" && key !== "escape" && !(modifier && ["z", "y"].includes(key))) return;
    if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? redoProject() : undoProject(); }
    else if (modifier && key === "y") { event.preventDefault(); redoProject(); }
    else if (modifier && key === "s") { event.preventDefault(); void saveProject(); }
    else if (modifier && key === "d") { event.preventDefault(); duplicateRegion(); }
    else if (key === "escape") { resetPreview(); setTesting(false); setTool("select"); setHelp(false); }
    else if (key === "t") toggleTest();
    else if (key === "v") { setTesting(false); setTool("select"); }
    else if (key === "h") { setTesting(false); setTool("pan"); }
    else if (key === "r") { setTesting(false); setTool("draw"); }
    else if (key === "f") rendererRef.current?.resetCamera();
    else if (key === "b") updateViewSetting("showBones", !(viewSettingsRef.current ?? DEFAULT_EDITOR_VIEW_SETTINGS).showBones);
    else if (key === " ") { event.preventDefault(); if (!testing) setPlaying((value) => !value); }
    else if (key === "?") setHelp((value) => !value);
    else if ((key === "delete" || key === "backspace") && !testing && projectRef.current?.selectedRegionId) { event.preventDefault(); deleteRegion(); }
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => editorKeydownRef.current(event);
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    const release = () => { previewRef.current.release(); testPointerRef.current = null; drawRef.current = null; setDrawBox(null); };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!testing || testPointerRef.current !== event.pointerId || !frame) return;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return;
      const point = { x: (event.clientX - rect.left) * frame.canvasWidth / rect.width, y: (event.clientY - rect.top) * frame.canvasHeight / rect.height };
      const world = screenToWorld(frame, point.x, point.y);
      if (world) previewRef.current.move(world.x, world.y);
    };
    const finish = (event: PointerEvent) => {
      if (testPointerRef.current !== event.pointerId) return;
      testPointerRef.current = null;
      previewRef.current.release();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [frame, testing]);

  function recordRecentFile(item: Omit<RecentFile, "lastOpened"> & { lastOpened?: number }) {
    const next = rememberRecentFile(recentFilesRef.current, item);
    recentFilesRef.current = next;
    setRecentFiles(next);
    try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next)); }
    catch { /* Recent files are a convenience, never a reason to block opening. */ }
  }

  function forgetRecentFile(item: Pick<RecentFile, "kind" | "rootPath" | "path">) {
    const next = removeRecentFile(recentFilesRef.current, item);
    recentFilesRef.current = next;
    setRecentFiles(next);
    try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next)); }
    catch { /* Recent files are a convenience, never a reason to block opening. */ }
  }

  async function confirmOpen(): Promise<boolean> {
    return confirmProjectReplacement(saveState, () => window.confirm("This project has unsaved changes. Open another file without saving?"));
  }

  async function useSource(next: DesktopAssetSource, preferredDirectory?: string) {
    setLegacyAspectRatioNotice(false);
    const [found, characterCatalog] = await Promise.all([
      next.getDirectories(),
      (async () => {
        for (const path of ["catalog.json", "characters.json", "character.json"]) {
          const content = await next.readText(path).catch(() => null);
          if (!content) continue;
          try {
            const info = parseCharacterDirectoryCatalog(JSON.parse(content) as unknown);
            if (Object.keys(info).length) return { info, labels: Object.fromEntries(Object.entries(info).map(([directory, item]) => [directory, item.label])) };
          } catch { /* Try the next supported character catalog filename. */ }
        }
        return { info: {}, labels: {} };
      })(),
    ]);
    if (found.length === 0) throw new Error("No Spine asset directories were found.");
    if (preferredDirectory && !found.includes(preferredDirectory)) throw new Error(`The project references missing Spine set “${preferredDirectory}”.`);
    const selectedDirectory = preferredDirectory && found.includes(preferredDirectory) ? preferredDirectory : found[0]!;
    const pending = pendingProjectRef.current;
    if (!pending || pending.assetDirectory !== selectedDirectory) {
      pendingProjectRef.current = await readSavedEditorProject(next, selectedDirectory, (message) => setError(message), () => setLegacyAspectRatioNotice(true));
    }
    const baselineProject = pendingProjectRef.current ?? createProject(selectedDirectory, [], []);
    saveBaselineRef.current = {
      rootPath: next.rootPath,
      directory: selectedDirectory,
      versions: await captureEditorProjectBaseline(next, baselineProject),
    };
    timelineSaveRef.current = null;
    setSource(next);
    setDirectories(found);
    setDirectoryLabels(characterCatalog.labels);
    setDirectoryInfo(characterCatalog.info);
    setDirectory(selectedDirectory);
    recordRecentFile({ kind: "folder", path: next.rootPath, rootPath: next.rootPath, label: displayName(next.rootPath), directory: selectedDirectory });
    setError(null);
    setSaveState("idle");
    setSavedAt(null);
  }

  function stopDraftPreview(status?: string) {
    const active = draftPreviewSessionRef.current;
    draftPreviewSessionRef.current = null;
    setDraftPreviewSessionId(null);
    if (active) void revokeDesktopDraft(active.sessionId).catch(() => undefined);
    if (status) setCompanionStatus(status);
  }

  async function previewSavedInViewer() {
    if (!source || !directory) return;
    if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || saveStateRef.current === "error") {
      setCompanionStatus("Save the project before previewing saved files.");
      return;
    }
    try {
      const timelineSnapshot = mcpTimelineSnapshotRef.current;
      const sequenceId = timelineSnapshot?.sequenceId ?? project?.timeline.sequenceId ?? undefined;
      await sendDesktopHandoff({
        protocolVersion: 1,
        requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        targetApp: "viewer",
        library: { identity: await libraryIdentityForPath(source.rootPath), path: source.rootPath },
        lobbyId: directory,
        ...(sequenceId ? { sequenceId } : {}),
        ...(timelineSnapshot && Number.isFinite(timelineSnapshot.currentTime) ? { playheadSeconds: Math.max(0, timelineSnapshot.currentTime) } : {}),
      });
      setCompanionStatus("Saved files sent to BA Spine Viewer.");
    } catch (reason) {
      setCompanionStatus(`Viewer preview failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  async function previewUnsavedDraftInViewer() {
    const current = projectRef.current;
    const currentSource = sourceRef.current;
    const currentDirectory = directoryRef.current;
    if (!current || !currentSource || !currentDirectory || current.assetDirectory !== currentDirectory || saveStateRef.current === "saving") return;
    if (saveStateRef.current !== "dirty" && saveStateRef.current !== "error") {
      setCompanionStatus("Make an unsaved project change before previewing a draft.");
      return;
    }
    const sessionId = `draft_${globalThis.crypto.randomUUID()}`;
    const revision = 1;
    try {
      stopDraftPreview();
      const snapshot: SpineDraftSnapshot = {
        protocolVersion: 1,
        sessionId,
        library: {
          identity: await libraryIdentityForPath(currentSource.rootPath),
          path: currentSource.rootPath,
        },
        lobbyId: currentDirectory,
        revision,
        project: editorProjectDraftValue(current),
      };
      await publishDesktopDraft(snapshot);
      draftPreviewSessionRef.current = { sessionId, rootPath: currentSource.rootPath, lobbyId: currentDirectory, revision };
      setDraftPreviewSessionId(sessionId);
      const timelineSnapshot = mcpTimelineSnapshotRef.current;
      const sequenceId = timelineSnapshot?.sequenceId ?? current.timeline.sequenceId ?? undefined;
      await sendDesktopHandoff({
        protocolVersion: 1,
        requestId: globalThis.crypto.randomUUID(),
        targetApp: "viewer",
        library: snapshot.library,
        lobbyId: currentDirectory,
        ...(sequenceId ? { sequenceId } : {}),
        ...(timelineSnapshot && Number.isFinite(timelineSnapshot.currentTime) ? { playheadSeconds: Math.max(0, timelineSnapshot.currentTime) } : {}),
        draft: { sessionId },
      });
      setCompanionStatus("Unsaved draft sent to BA Spine Viewer. It is read-only and remains in memory only.");
    } catch (reason) {
      if (draftPreviewSessionRef.current?.sessionId === sessionId) stopDraftPreview();
      else void revokeDesktopDraft(sessionId).catch(() => undefined);
      setCompanionStatus(`Viewer draft preview failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  useEffect(() => {
    if (!draftPreviewSessionId) return;
    const session = draftPreviewSessionRef.current;
    if (!session) return;
    if (session.rootPath !== source?.rootPath || session.lobbyId !== directory) {
      stopDraftPreview("Draft preview ended because the Editor selection changed.");
      return;
    }
    const timer = window.setTimeout(() => {
      const active = draftPreviewSessionRef.current;
      const current = projectRef.current;
      if (!active || !current || active.sessionId !== draftPreviewSessionId || current.assetDirectory !== active.lobbyId) return;
      const revision = active.revision + 1;
      active.revision = revision;
      void (async () => {
        const snapshot: SpineDraftSnapshot = {
          protocolVersion: 1,
          sessionId: active.sessionId,
          library: { identity: await libraryIdentityForPath(active.rootPath), path: active.rootPath },
          lobbyId: active.lobbyId,
          revision,
          project: editorProjectDraftValue(current),
        };
        await publishDesktopDraft(snapshot);
      })().catch((reason: unknown) => {
        if (draftPreviewSessionRef.current?.sessionId === draftPreviewSessionId) {
          stopDraftPreview("Draft preview update failed and was stopped.");
        }
        setCompanionStatus(`Draft preview update failed: ${reason instanceof Error ? reason.message : String(reason)}`);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [directory, draftPreviewSessionId, project, source]);

  useEffect(() => () => {
    const active = draftPreviewSessionRef.current;
    draftPreviewSessionRef.current = null;
    if (active) void revokeDesktopDraft(active.sessionId).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isDesktopHost()) return;
    let live = true;
    let polling = false;
    const poll = async () => {
      if (!live || polling) return;
      polling = true;
      try {
        const messages = await receiveDesktopHandoffs();
        if (!live) return;
        setCompanionStatus((current) => current?.startsWith("Viewer connection issue:") ? null : current);
        for (const message of messages) {
          if (!live) continue;
          if (handledHandoffIdsRef.current.has(message.requestId)) {
            await acknowledgeDesktopHandoff(message.requestId).catch(() => undefined);
            break;
          }
          try {
            if (!(await confirmOpen())) {
              setStatus("Handoff canceled; the current project was kept.");
              continue;
            }
            const next = await chooseDesktopSourceAt(message.library.path);
            if (!next) continue;
            if (await libraryIdentityForPath(next.rootPath) !== message.library.identity) {
              throw new Error("The library identity does not match the handoff path.");
            }
            if (draftPreviewSessionRef.current) stopDraftPreview("Draft preview ended because the Editor opened another selection.");
            pendingProjectRef.current = null;
            setPendingSubtitlePath(null);
            setPendingAudioPaths(null);
            await useSource(next, message.lobbyId);
            setInitialTimelineHandoff(message.sequenceId
              ? { requestId: message.requestId, sequenceId: message.sequenceId, ...(message.playheadSeconds !== undefined ? { playheadSeconds: message.playheadSeconds } : {}) }
              : null);
            setWorkspace(message.sequenceId ? "timeline" : "interaction");
            setStatus(`Opened ${message.lobbyId} from the companion app.`);
          } catch (reason) {
            if (live) setError(`Could not apply the received handoff: ${reason instanceof Error ? reason.message : String(reason)}`);
          } finally {
            handledHandoffIdsRef.current.add(message.requestId);
            await acknowledgeDesktopHandoff(message.requestId).catch(() => undefined);
          }
          break;
        }
      } catch (reason) {
        if (live) setCompanionStatus(`Viewer connection issue: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 800);
    return () => { live = false; window.clearInterval(timer); };
  }, [saveState]);

  async function openFolder() {
    if (!(await confirmOpen())) return;
    try {
      const next = await chooseDesktopSource();
      if (next) {
        pendingProjectRef.current = null;
        setPendingSubtitlePath(null);
        setPendingAudioPaths(null);
        await useSource(next);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function openProjectFile() {
    if (!(await confirmOpen())) return;
    try {
      const selected = await chooseDesktopProject();
      if (!selected) return;
      const raw = JSON.parse(selected.file.content) as Record<string, unknown>;
      const assetDirectory = typeof raw.assetDirectory === "string" ? raw.assetDirectory : "";
      if (!assetDirectory) throw new Error("This project file does not identify an asset set.");
      const restored = normalizeProject(raw, assetDirectory);
      if (!restored) throw new Error("The selected file is not a compatible Spine editor project.");
      const containsLegacySquareCamera = hasLegacySquareCameraAspectRatio(raw);
      pendingProjectRef.current = restored;
      setPendingSubtitlePath(null);
      setPendingAudioPaths(null);
      recordRecentFile({ kind: "project", path: selected.file.path, rootPath: selected.source.rootPath, label: displayName(selected.file.path), directory: restored.assetDirectory });
      await useSource(selected.source, restored.assetDirectory);
      setLegacyAspectRatioNotice(containsLegacySquareCamera);
      setWorkspace("interaction");
      setStatus(`Opened project ${displayName(selected.file.path)}.`);
    } catch (value) {
      pendingProjectRef.current = null;
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function openRecentFile(item: RecentFile) {
    if (!(await confirmOpen())) return;
    try {
      const next = await chooseDesktopSourceAt(item.rootPath);
      if (!next) return;
      if (item.kind === "project") {
        const content = await next.readText(item.path);
        if (!content) throw new Error(`Recent project file is missing: ${item.path}`);
        const raw = JSON.parse(content) as Record<string, unknown>;
        const assetDirectory = typeof raw.assetDirectory === "string" ? raw.assetDirectory : item.directory ?? "";
        const restored = normalizeProject(raw, assetDirectory);
        if (!restored) throw new Error("The recent file is not a compatible Spine editor project.");
        const containsLegacySquareCamera = hasLegacySquareCameraAspectRatio(raw);
        pendingProjectRef.current = restored;
        setPendingSubtitlePath(null);
        setPendingAudioPaths(null);
        recordRecentFile({ ...item, directory: restored.assetDirectory });
        await useSource(next, restored.assetDirectory);
        setLegacyAspectRatioNotice(containsLegacySquareCamera);
        setWorkspace("interaction");
        setStatus(`Reopened project ${item.label}.`);
      } else {
        pendingProjectRef.current = null;
        setPendingSubtitlePath(null);
        setPendingAudioPaths(null);
        await useSource(next, item.directory);
        recordRecentFile(item);
        if (item.kind === "subtitle") {
          setPendingSubtitlePath(item.path);
          setPendingAudioPaths(null);
          setWorkspace("timeline");
          setStatus(`Ready to import ${item.label} into the timeline.`);
        } else if (item.kind === "audio") {
          setPendingAudioPaths([item.path]);
          setWorkspace("timeline");
          setStatus(`Loading ${item.label} into the timeline…`);
        } else {
          setPendingAudioPaths(null);
           setStatus(`Reopened ${item.label}. Use Add, then Audio files, to place it on the timeline.`);
        }
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function changeDirectory(next: string) {
    if (!next || next === directory) return;
    if (!(await confirmOpen())) return;
    try {
      setLegacyAspectRatioNotice(false);
      pendingProjectRef.current = source ? await readSavedEditorProject(source, next, (message) => setError(message), () => setLegacyAspectRatioNotice(true)) : null;
      if (source) {
        const baselineProject = pendingProjectRef.current ?? createProject(next, [], []);
        saveBaselineRef.current = {
          rootPath: source.rootPath,
          directory: next,
          versions: await captureEditorProjectBaseline(source, baselineProject),
        };
      }
      timelineSaveRef.current = null;
      setDirectory(next);
      setSaveState("idle");
      setSavedAt(null);
      setError(null);
      setPendingSubtitlePath(null);
      setPendingAudioPaths(null);
      setStatus(`Loading ${displayName(next)}…`);
    } catch (value) {
      pendingProjectRef.current = null;
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  function mutate(mutator: (current: EditorProject) => EditorProject) {
    const current = projectRef.current;
    if (!current) return;
    const next = mutator(cloneProject(current));
    setUndo((items) => [...items.slice(-49), current]);
    setRedo([]);
    projectRef.current = next;
    setProject(next);
    setSaveState("dirty");
  }

  function live(mutator: (current: EditorProject) => EditorProject) {
    const current = projectRef.current;
    if (!current) return;
    const next = mutator(cloneProject(current));
    projectRef.current = next;
    setProject(next);
    setSaveState("dirty");
  }

  function beginTimelineEdit() {
    if (!projectRef.current) return;
    setUndo((items) => [...items.slice(-49), projectRef.current!]);
    setRedo([]);
  }

  function beginCameraEdit() {
    const current = projectRef.current;
    if (!current || cameraEditTransactionRef.current) return;
    cameraEditTransactionRef.current = { project: current, redo, saveState: saveStateRef.current };
    setUndo((items) => [...items.slice(-49), current]);
    setRedo([]);
  }

  function endCameraEdit() {
    cameraEditTransactionRef.current = null;
  }

  function cancelCameraEdit() {
    const transaction = cameraEditTransactionRef.current;
    if (!transaction) return;
    cameraEditTransactionRef.current = null;
    setUndo((items) => items.at(-1) === transaction.project ? items.slice(0, -1) : items);
    setRedo(transaction.redo);
    setSaveState(transaction.saveState);
  }

  function updateViewSetting(field: keyof EditorViewSettings, value: boolean) {
    const nextSettings = { ...(viewSettingsRef.current ?? DEFAULT_EDITOR_VIEW_SETTINGS), [field]: value };
    viewSettingsRef.current = nextSettings;
    setViewSettings(nextSettings);
    live((current) => ({ ...current, ...nextSettings }));
  }

  function undoProject() {
    const current = projectRef.current;
    const previous = undo.at(-1);
    if (!current || !previous) return;
    setRedo((items) => [...items.slice(-49), current]);
    setUndo((items) => items.slice(0, -1));
    const next = withCurrentViewSettings(previous);
    projectRef.current = next;
    setProject(next);
    setSaveState("dirty");
  }

  function redoProject() {
    const current = projectRef.current;
    const next = redo.at(-1);
    if (!current || !next) return;
    setUndo((items) => [...items.slice(-49), current]);
    setRedo((items) => items.slice(0, -1));
    const applied = withCurrentViewSettings(next);
    projectRef.current = applied;
    setProject(applied);
    setSaveState("dirty");
  }

  async function saveProject(options: { rejectExternalChanges?: boolean } = {}) {
    const save = async () => {
      const current = projectRef.current ?? project;
      const saveSource = sourceRef.current;
      const saveDirectory = directoryRef.current;
      saveResultRef.current = null;
      if (!current || !saveSource || current.assetDirectory !== saveDirectory) {
        saveResultRef.current = { ok: false, error: "There is no loaded project to save." };
        return;
      }
      setSaveState("saving");
      setError(null);
      try {
        const getCurrentProject = () => projectRef.current ?? current;
        const subtitleWrites = await timelineSaveRef.current?.(getCurrentProject) ?? [];
        const latest = getCurrentProject();
        const savedDocumentRevision = currentMcpDocumentRevision();
        if (sourceRef.current !== saveSource || directoryRef.current !== saveDirectory || latest.assetDirectory !== saveDirectory) return;
        const prepared = await prepareEditorProjectSave(saveSource, latest);
        const writesByPath = new Map<string, EditorSaveFile>();
        for (const file of [...prepared.files, ...subtitleWrites]) {
          const prior = writesByPath.get(file.path);
          if (prior && prior.content !== file.content) throw new Error(`The save plan contains conflicting output for ${file.path}.`);
          writesByPath.set(file.path, prior ?? file);
        }
        const baseline = saveBaselineRef.current?.rootPath === saveSource.rootPath && saveBaselineRef.current.directory === saveDirectory
          ? saveBaselineRef.current.versions
          : await captureEditorProjectBaseline(saveSource, latest);
        const writes: DesktopSaveFile[] = [...writesByPath.values()].map((file) => ({
          path: file.path,
          content: file.content,
          expectedVersion: baseline[file.path]
            ?? (file.baselineContent !== undefined ? contentVersion(file.baselineContent) : contentVersion(null)),
        }));
        let saveResult: { backupPath: string | null };
        try {
          saveResult = await saveSource.saveBatch(writes);
        } catch (value) {
          if (!(value instanceof DesktopSaveConflictError)) throw value;
          const changedPaths = Object.keys(value.currentVersions);
          if (options.rejectExternalChanges) throw new Error(`Save refused because files changed outside the Editor: ${changedPaths.join(", ")}. Re-read the project and review the conflict before saving.`);
          const decision = window.confirm(
            `These project files changed outside the Editor:\n\n${changedPaths.join("\n")}\n\nOverwrite exactly the versions detected now? Choose Cancel to keep your files unchanged.`,
          );
          if (!decision) throw new Error("Save canceled; external changes were preserved.");
          saveResult = await saveSource.saveBatch(writes, value.currentVersions);
        }
        const verifiedVersions: Record<string, string> = {};
        for (const file of writes) {
          const written = await saveSource.readText(file.path);
          const expectedVersion = contentVersion(file.content);
          if (written === null || contentVersion(written) !== expectedVersion) throw new Error(`Save verification failed for ${file.path}; the written file does not match the reviewed project.`);
          verifiedVersions[file.path] = expectedVersion;
        }
        const projectPath = prepared.manifestSave?.manifestPath ?? prepared.files[0]?.path ?? "";
        recordRecentFile({ kind: "project", path: projectPath, rootPath: saveSource.rootPath, label: displayName(projectPath), directory: saveDirectory });
        const nextBaseline = { ...baseline };
        for (const file of writes) nextBaseline[file.path] = contentVersion(file.content);
        saveBaselineRef.current = { rootPath: saveSource.rootPath, directory: saveDirectory, versions: nextBaseline };
        const unchangedSinceSave = projectRef.current === latest;
        setSaveState(unchangedSinceSave ? "saved" : "dirty");
        setLegacyAspectRatioNotice(false);
        if (unchangedSinceSave) setSavedAt(Date.now());
        saveResultRef.current = { ok: true, error: null, savedDocumentRevision, writtenPaths: writes.map((file) => file.path), verifiedVersions };
        if (unchangedSinceSave && draftPreviewSessionRef.current) stopDraftPreview("Draft preview ended after saving; Viewer will return to saved files.");
        const subtitlePaths = subtitleWrites.map((file) => file.path);
        const subtitleMessage = subtitlePaths.length > 0
          ? ` · Linked subtitles: ${[...new Set(subtitlePaths)].map((path) => nativePath(saveSource.rootPath, path)).join(", ")}`
          : " · No linked subtitle files";
        const backupMessage = saveResult.backupPath ? ` · Backup: ${saveResult.backupPath}` : " · No prior files needed backup";
        setStatus(`${prepared.manifestSave ? "Saved manifest project" : "Saved project"}: ${nativePath(saveSource.rootPath, projectPath)}${subtitleMessage}${backupMessage}${unchangedSinceSave ? "" : " · Newer edits remain unsaved"}`);
      } catch (value) {
        const message = value instanceof Error ? value.message : String(value);
        saveResultRef.current = { ok: false, error: message };
        if (message.startsWith("Save canceled;")) {
          setSaveState("dirty");
          setError(null);
          setStatus(message);
        } else {
          setSaveState("error");
          setError(message);
        }
      }
    };
    const queued = projectSaveQueueRef.current.then(save, save);
    projectSaveQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function dismissRecoveryPrompt() {
    recoveryPromptRef.current = null;
    setRecoveryPrompt(null);
  }

  function restoreRecoveryProject(candidate: EditorProject, label: string, legacyAspectRatio = false) {
    if (candidate.assetDirectory !== directoryRef.current || recoveryPromptRef.current?.rootPath !== sourceRef.current?.rootPath) return;
    const restored = withCurrentViewSettings(cloneProject(candidate));
    recoveryPromptRef.current = null;
    setRecoveryPrompt(null);
    projectRef.current = restored;
    setProject(restored);
    setUndo([]);
    setRedo([]);
    setSaveState("dirty");
    setLegacyAspectRatioNotice(legacyAspectRatio);
    setSavedAt(null);
    setStatus(`${label} restored as an unsaved draft. Save explicitly to write it to the library.`);
  }

  mcpCommandRef.current = async (command, expectedDocumentRevision) => {
    if (expectedDocumentRevision !== undefined) {
      const actual = currentMcpDocumentRevision();
      if (actual !== expectedDocumentRevision) throw new Error(`MCP_STALE_DOCUMENT_REVISION: expected document revision ${expectedDocumentRevision}, but the Editor is now at ${actual}. Re-read editor_state and review the change before retrying.`);
    }
    switch (command.name) {
      case "start_waveform_profile": {
        if (!__EDITOR_WAVEFORM_PROFILE__) throw new Error("Waveform profiling is not enabled in this Editor build.");
        if (waveformProfileRef.current?.recording) throw new Error("A waveform profile is already recording; stop it before starting another.");
        const recorder = new WaveformProfileRecorder(performance.now(), new Date().toISOString(), document.visibilityState === "visible");
        waveformProfileRef.current = recorder;
        setWaveformProfileRecording(true);
        return { startedAt: recorder.startedAt, visibleAtStart: recorder.visibleAtStart };
      }
      case "stop_waveform_profile": {
        if (!__EDITOR_WAVEFORM_PROFILE__) throw new Error("Waveform profiling is not enabled in this Editor build.");
        const recorder = waveformProfileRef.current;
        if (!recorder) throw new Error("Start a waveform profile before stopping it.");
        recorder.stop(performance.now());
        setWaveformProfileRecording(false);
        return recorder.snapshot(performance.now());
      }
      case "open_asset_root": {
        if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || saveStateRef.current === "error") throw new Error("Save the current project before opening another asset root.");
        const next = await chooseDesktopSourceAt(command.rootPath);
        if (!next) throw new Error("The asset root could not be opened.");
        pendingProjectRef.current = null;
        setPendingSubtitlePath(null);
        setPendingAudioPaths(null);
        setWorkspace("interaction");
        setAssetLoading(true);
        await useSource(next);
        return { assetRoot: next.rootPath, status: "Loading asset root." };
      }
      case "select_asset_set": {
        if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || saveStateRef.current === "error") throw new Error("Save the current project before switching asset sets.");
        if (!sourceRef.current) throw new Error("Open an asset root first.");
        if (!directories.includes(command.directory)) throw new Error(`Asset set not found: ${command.directory}`);
        setAssetLoading(true);
        await changeDirectory(command.directory);
        return { directory: command.directory, status: "Loading asset set." };
      }
      case "set_workspace":
        if (command.workspace !== "interaction" && (!projectRef.current || !metaRef.current || !directoryRef.current)) throw new Error("Load a Spine asset before opening the timeline or camera workspace.");
        setWorkspace(command.workspace);
        return { workspace: command.workspace };
      case "save": {
        await saveProject({ rejectExternalChanges: true });
        const saved = saveResultRef.current;
        if (!saved?.ok) throw new Error(saved?.error ?? "The project could not be saved.");
        return { ok: true, status: "saved", savedDocumentRevision: saved.savedDocumentRevision ?? currentMcpDocumentRevision(), writtenPaths: saved.writtenPaths ?? [], verifiedVersions: saved.verifiedVersions ?? {} };
      }
      default: {
        const timeline = mcpTimelineRef.current;
        if (!timeline) throw new Error("Open the timeline workspace first.");
        return timeline.execute(command);
      }
    }
  };

  const selectedInteraction = project?.interactions.find((item) => item.id === project.selectedInteractionId) ?? null;
  const phaseSuggestion = selectedInteraction && meta
    ? suggestInteractionPhases(meta.animations, selectedInteraction.startAnimation)
    : null;
  const selectedRegion = selectedInteraction?.regions.find((item) => item.id === project?.selectedRegionId) ?? null;
  const displaySettings = viewSettings;
  const interactionTargetPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const interaction of project?.interactions ?? []) {
      if (interaction.followTargetBone) paths.add(interaction.followTargetBone);
      for (const region of interaction.regions) if (region.anchorBone) paths.add(region.anchorBone);
    }
    return [...paths].sort();
  }, [project?.interactions]);
  const visibleInteractions = project?.interactions.filter((item) => !interactionSearch.trim() || item.name.toLocaleLowerCase().includes(interactionSearch.trim().toLocaleLowerCase())) ?? [];
  const validationWarnings = useMemo(() => project && meta && frame ? validateProject(project, meta.animations, frame.bones) : [], [frame, meta, project]);
  const renderedViewSettings = testing ? { ...displaySettings, showBones: false, showConstraints: false } : displaySettings;

  function revealBonePath(path: string, select = true) {
    if (select) live((current) => ({ ...current, selectedBonePath: path }));
    setBoneRevealRequest({ path, revision: ++boneRevealRevisionRef.current });
  }

  function updateInteraction(field: keyof EditorInteraction, value: string | number | boolean | null) {
    if (!selectedInteraction) return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return;
      if (field === "smoothing") value = Math.max(0.1, value);
      else if (field === "returnDuration") value = Math.min(2, Math.max(0.05, value));
      else if (field === "startMixDuration" || field === "followMixDuration" || field === "releaseMixDuration") value = Math.min(2, Math.max(0, value));
      else if (field === "rotationMin") value = Math.min(0, Math.max(-180, value));
      else if (field === "rotationMax") value = Math.max(0, Math.min(180, value));
      else value = Math.max(0, value);
    }
    mutate((current) => ({
      ...current,
      interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, [field]: value } : item),
    }));
  }

  function updateRegion(field: keyof EditorRegion, value: string | number | boolean | null) {
    if (!selectedInteraction || !selectedRegion) return;
    mutate((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) => interaction.id !== selectedInteraction.id ? interaction : {
        ...interaction,
        regions: interaction.regions.map((region) => region.id === selectedRegion.id ? { ...region, [field]: value, placement: "manual" } : region),
      }),
    }));
  }

  function selectInteraction(id: string) {
    mutate((current) => {
      const item = current.interactions.find((interaction) => interaction.id === id);
      return { ...current, selectedInteractionId: id, selectedRegionId: item?.regions[0]?.id ?? null };
    });
  }

  function addInteraction() {
    if (!project || !frame || !meta) return;
    const item = blankInteraction(meta.animations, frame.bones, project.interactions.length);
    mutate((current) => ({ ...current, interactions: [...current.interactions, item], selectedInteractionId: item.id, selectedRegionId: item.regions[0]?.id ?? null }));
  }

  function deleteInteraction() {
    if (!selectedInteraction) return;
    mutate((current) => {
      const remaining = current.interactions.filter((item) => item.id !== selectedInteraction.id);
      const next = remaining[0];
      return { ...current, interactions: remaining, selectedInteractionId: next?.id ?? null, selectedRegionId: next?.regions[0]?.id ?? null };
    });
  }

  function addRegion() {
    if (!selectedInteraction || !frame || !project) return;
    const anchor = frame.bones.find((bone) => bone.path === project.selectedBonePath) ?? frame.bones[0];
    const item = blankRegion(anchor, selectedInteraction.regions.length);
    mutate((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) => interaction.id === selectedInteraction.id ? { ...interaction, regions: [...interaction.regions, item] } : interaction),
      selectedRegionId: item.id,
    }));
  }

  function deleteRegion() {
    if (!selectedInteraction || !selectedRegion) return;
    mutate((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) => interaction.id === selectedInteraction.id ? { ...interaction, regions: interaction.regions.filter((region) => region.id !== selectedRegion.id) } : interaction),
      selectedRegionId: null,
    }));
  }

  function playAnimation(name: string) {
    if (!name) return;
    rendererRef.current?.setAnimation(name, true);
    setSelectedAnimation(name);
    setAnimationSelectionOrigin("explicit");
    setPlaying(true);
  }

  function previewPhase(label: string, body: string, face: string, loop: boolean) {
    if (!body && !face) {
      setStatus(`${label} has no animation assigned.`);
      return;
    }
    rendererRef.current?.previewEditorPhase(body, face, loop);
    setPlaying(true);
    setStatus(`Previewing ${label}: ${body || "no body track"}${face ? ` + ${face}` : ""}.`);
  }

  function resetPreview() {
    previewRef.current.reset();
    setPreviewDebug(previewRef.current.debug);
    const idle = metaRef.current?.idleAnimation ?? metaRef.current?.defaultAnimation;
    if (idle) { rendererRef.current?.setAnimation(idle, true); setSelectedAnimation(idle); setAnimationSelectionOrigin("automatic"); }
    setPlaying(true);
  }

  function startSelectedTest() {
    if (!selectedInteraction || !frame) return;
    const testRegion = selectedRegion?.enabled && selectedInteraction.regions.some((region) => region.id === selectedRegion.id)
      ? selectedRegion
      : selectedInteraction.regions.find((region) => region.enabled) ?? null;
    const center = testRegion
      ? regionMatrix(frame, testRegion)
      : { e: frame.canvasWidth / 2, f: frame.canvasHeight / 2 };
    const origin = screenToWorld(frame, center.e, center.f);
    if (!origin) return;
    resetPreview();
    previewRef.current.press(selectedInteraction, testRegion?.name ?? "Direct test", origin.x, origin.y);
    setPreviewDebug(previewRef.current.debug);
    setPreviewStatus(`starting · ${selectedInteraction.name}`);
    setTesting(true);
    setTool("select");
    setStatus(`Testing ${selectedInteraction.name} directly. Drag on the stage, or release with the test controls.`);
  }

  function releaseTest() {
    previewRef.current.release();
    testPointerRef.current = null;
    setPreviewDebug(previewRef.current.debug);
    setPreviewStatus("releasing · returning to pose");
    setStatus("Released interaction test. The follow target is easing back to its animated pose.");
  }

  function replayTest() {
    if (selectedInteraction && frame) {
      startSelectedTest();
      return;
    }
    setStatus("Select an interaction and load its Spine asset to replay the test.");
  }

  function toggleTest() {
    if (testing) {
      testPointerRef.current = null;
      previewRef.current.release();
      resetPreview();
      setTesting(false);
      return;
    }
    resetPreview();
    setTesting(true);
    setStatus("Test mode is ready. Press an enabled hit region or use Test selected for a direct test.");
  }

  function duplicateRegion() {
    if (!selectedRegion || !selectedInteraction) return;
    const copy = { ...selectedRegion, id: crypto.randomUUID(), name: `${selectedRegion.name} copy`, offsetX: selectedRegion.offsetX + 20, placement: "manual" as const };
    mutate((current) => ({ ...current, selectedRegionId: copy.id, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: [...item.regions, copy] } : item) }));
  }

  function duplicateInteraction() {
    if (!selectedInteraction) return;
    const copy = structuredClone(selectedInteraction);
    copy.id = crypto.randomUUID(); copy.name += " copy";
    copy.regions = copy.regions.map((region) => ({ ...region, id: crypto.randomUUID(), placement: "manual" }));
    mutate((current) => ({ ...current, interactions: [...current.interactions, copy], selectedInteractionId: copy.id, selectedRegionId: copy.regions[0]?.id ?? null }));
  }

  function detectPhases() {
    if (!meta || !selectedInteraction) return;
    if (!phaseSuggestion) { setStatus("Choose a press animation that matches a local Pat, Touch, or Pinch profile to see a suggestion."); return; }
    mutate((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? {
      ...item,
      startAnimation: phaseSuggestion.startAnimation,
      followAnimation: phaseSuggestion.followAnimation,
      endAnimation: phaseSuggestion.endAnimation,
      faceStartAnimation: phaseSuggestion.faceStartAnimation,
      faceFollowAnimation: phaseSuggestion.faceFollowAnimation,
      faceEndAnimation: phaseSuggestion.faceEndAnimation,
    } : item) }));
    setStatus(`${phaseSuggestion.kind} phase suggestion applied. Regions, movement, and blend durations were kept.`);
  }

  function navigateToValidationIssue(warning: EditorValidationWarning) {
    const current = projectRef.current;
    if (!current) return;
    const interaction = current.interactions.find((item) => item.id === warning.interactionId);
    if (!interaction) return;
    const regionId = warning.regionId && interaction.regions.some((region) => region.id === warning.regionId)
      ? warning.regionId
      : interaction.regions[0]?.id ?? null;
    const next = { ...current, selectedInteractionId: interaction.id, selectedRegionId: regionId };
    projectRef.current = next;
    setProject(next);
    setWorkspace("interaction");
    setLayoutPreset("custom");
    setRightHidden(false);
    setInspectorTab(warning.kind === "missing-animation" ? "animation" : warning.kind === "missing-bone" && !warning.regionId ? "movement" : "region");
    setStatus(`Reviewing ${warning.kind.replaceAll("-", " ")}: ${warning.message}`);
  }

  function showProjectIssues() {
    setWorkspace("interaction");
    setRightHidden(false);
    requestAnimationFrame(() => {
      const details = validationDetailsRef.current;
      if (!details) return;
      details.open = true;
      details.scrollIntoView({ block: "nearest" });
    });
  }

  function stagePoint(event: ReactPointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!frame || !rect.width || !rect.height) return null;
    return { x: (event.clientX - rect.left) * frame.canvasWidth / rect.width, y: (event.clientY - rect.top) * frame.canvasHeight / rect.height };
  }

  function stagePress(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !frame || !project) return;
    if (testing && (testPointerRef.current !== null || previewRef.current.held)) return;
    const point = stagePoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const world = screenToWorld(frame, point.x, point.y);
    if (!world) return;
    if (testing) {
      const hit = hitRegion(frame, project, point.x, point.y);
      if (hit) {
        testPointerRef.current = event.pointerId;
        previewRef.current.press(hit.interaction, hit.region.name, world.x, world.y);
        setStatus(`Testing ${hit.interaction.name}. Release to return to idle.`);
      } else setStatus("No enabled region here. Turn on hit regions or draw one in Edit mode.");
    } else { drawRef.current = world; setDrawBox({ x: point.x, y: point.y, width: 0, height: 0 }); setStatus("Drag out a region, then release."); }
  }

  function stageMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!frame) return;
    const point = stagePoint(event);
    const world = point && screenToWorld(frame, point.x, point.y);
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerInside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (testing) {
      if (world && pointerInside) previewRef.current.move(world.x, world.y);
      else previewRef.current.leave();
    }
    if (!testing && drawRef.current && point) {
      const start = drawRef.current;
      const x = frame.screenOriginX + (frame.screenUnitXEndX - frame.screenOriginX) * start.x + (frame.screenUnitYEndX - frame.screenOriginX) * start.y;
      const y = frame.screenOriginY + (frame.screenUnitXEndY - frame.screenOriginY) * start.x + (frame.screenUnitYEndY - frame.screenOriginY) * start.y;
      setDrawBox({ x: Math.min(x, point.x), y: Math.min(y, point.y), width: Math.abs(point.x - x), height: Math.abs(point.y - y) });
    }
  }

  function stageRelease(event: ReactPointerEvent<HTMLDivElement>) {
    if (testing && testPointerRef.current === event.pointerId) {
      testPointerRef.current = null;
      previewRef.current.release();
    }
    const start = drawRef.current;
    drawRef.current = null;
    setDrawBox(null);
    if (!testing && start && frame && selectedInteraction) {
      const point = stagePoint(event);
      const end = point && screenToWorld(frame, point.x, point.y);
      if (end && Math.hypot(end.x - start.x, end.y - start.y) > 5) {
        const region = { ...blankRegion(undefined, selectedInteraction.regions.length), placement: "manual" as const, offsetX: (start.x + end.x) / 2, offsetY: (start.y + end.y) / 2, radiusX: Math.max(5, Math.abs(end.x - start.x) / 2), radiusY: Math.max(5, Math.abs(end.y - start.y) / 2) };
        mutate((current) => ({ ...current, selectedRegionId: region.id, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: [...item.regions, region] } : item) }));
        setTool("select"); setInspectorTab("region"); setStatus("Region drawn. Drag to move; use the handles to resize or rotate.");
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function anchorToSelected() {
    if (!selectedRegion || !selectedInteraction || !frame || !project?.selectedBonePath) return;
    const center = regionMatrix(frame, selectedRegion);
    const next = { ...selectedRegion, anchorBone: project.selectedBonePath, offsetX: 0, offsetY: 0, rotation: 0 };
    const offset = inversePoint(regionMatrix(frame, next), center.e, center.f);
    if (!offset) return;
    mutate((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: item.regions.map((region) => region.id === selectedRegion.id ? { ...region, anchorBone: next.anchorBone, offsetX: offset.x, offsetY: offset.y, placement: "manual" } : region) } : item) }));
  }

  function snapRegionToHead() {
    if (!selectedRegion || !selectedInteraction || !headRegionRef.current) return;
    const head = headRegionRef.current;
    mutate((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: item.regions.map((region) => region.id === selectedRegion.id ? { ...region, ...head, enabled: true, placement: "manual" } : region) } : item) }));
    setStatus("Region fitted to detected head artwork. Movement target was not changed.");
  }

  const assetLoaded = Boolean(source && directory && files && frame && project);
  const loadPercent = Math.round(Math.max(0, Math.min(1, loadProgress.total > 0 ? loadProgress.loaded / loadProgress.total : 0)) * 100);
  const loadStageLabel = {
    files: "Reading asset files",
    atlas: "Reading atlas",
    textures: "Loading textures",
    skeleton: "Parsing skeleton",
    finalizing: "Finalizing asset",
    audio: "Loading audio",
  }[loadProgress.stage];
  function recentPath(item: RecentFile): string {
    return item.kind === "folder" ? item.rootPath : nativePath(item.rootPath, item.path);
  }

  function closeHeaderMenu(event: ReactMouseEvent<HTMLElement>) {
    const menu = event.currentTarget.closest("details");
    if (menu) menu.open = false;
  }

  function recentList(limit = 6) {
    if (recentFiles.length === 0) return <p className="editor-muted editor-recent-empty">No recent files yet.</p>;
    return <div className="editor-recent-list">
      {recentFiles.slice(0, limit).map((item) => <div className="editor-recent-item" key={`${item.kind}:${item.rootPath}:${item.path}`}>
        <button className="editor-recent-open" title={recentPath(item)} onClick={(event) => { closeHeaderMenu(event); void openRecentFile(item); }}>
           <span className={`editor-recent-icon kind-${item.kind}`}>{item.kind === "folder" ? <IconFolder /> : item.kind === "project" ? <IconFile /> : item.kind === "subtitle" ? <IconMessage /> : <IconSound />}</span>
          <span><b>{item.label}</b><small>{recentKindLabel(item.kind)} · {displayName(item.rootPath)}</small></span>
        </button>
         <button className="editor-recent-remove" aria-label={`Remove ${item.label} from recent files`} title="Remove from recent files" onClick={() => forgetRecentFile(item)}><IconClose /></button>
      </div>)}
      {recentFiles.length > limit && <span className="editor-recent-more">{recentFiles.length - limit} more in Open menu</span>}
    </div>;
  }

  function applyWorkspacePreset(preset: Exclude<WorkspaceLayoutPreset, "custom">) {
    setLayoutPreset(preset);
    if (preset === "timeline-focus") {
      setLeftHidden(false);
      setRightHidden(false);
      setWorkspace("timeline");
      return;
    }
    setWorkspace("interaction");
    setLeftHidden(preset === "canvas-focus");
    setRightHidden(preset === "canvas-focus");
    setLeftWidth(DEFAULT_EDITOR_LAYOUT_PREFERENCES.leftWidth);
    setRightWidth(DEFAULT_EDITOR_LAYOUT_PREFERENCES.rightWidth);
  }

  const commandPaletteCommands: EditorCommand[] = [
    { id: "workspace-interactions", title: "Switch to Interactions", description: "Open the interaction authoring workspace", group: "Workspace", keywords: ["edit", "studio"], run: () => setWorkspace("interaction") },
    { id: "workspace-timeline", title: "Switch to Timeline", description: "Open the sequence composer", group: "Workspace", keywords: ["sequence", "composer"], disabled: !assetLoaded, run: () => setWorkspace("timeline") },
    { id: "workspace-camera", title: "Switch to Camera", description: "Author camera boundaries and shots", group: "Workspace", keywords: ["camera", "bounds", "shots"], disabled: !assetLoaded, run: () => setWorkspace("camera") },
    { id: "choose-asset-set", title: "Choose character or asset set", description: directory ? `Current set: ${characterDirectoryLabel(directory, directoryLabels)}` : "Open a local set from the loaded catalog", group: "Assets", keywords: ["character", "switch"], disabled: !directories.length, run: () => setAssetPickerOpen(true) },
    { id: "open-asset-folder", title: "Open asset folder…", description: "Choose a local Spine asset root", group: "Assets", keywords: ["browse", "root"], run: () => { void openFolder(); } },
    { id: "open-project-file", title: "Open project file…", description: "Load a saved editor project", group: "Project", keywords: ["interaction", "timeline", "json"], run: () => { void openProjectFile(); } },
    { id: "layout-balanced", title: "Layout: Balanced", description: "Show navigation, canvas, and inspector", group: "Layout", keywords: ["workspace preset"], run: () => applyWorkspacePreset("balanced") },
    { id: "layout-canvas", title: "Layout: Canvas focus", description: "Hide both side panels", group: "Layout", keywords: ["workspace preset", "preview"], run: () => applyWorkspacePreset("canvas-focus") },
    { id: "layout-timeline", title: "Layout: Timeline focus", description: "Open the sequence timeline", group: "Layout", keywords: ["workspace preset", "sequence"], disabled: !assetLoaded, run: () => applyWorkspacePreset("timeline-focus") },
    { id: "toggle-navigation", title: "Toggle interaction navigator", description: "Show or hide the left-side bone and constraint panels", group: "Layout", keywords: ["left panel", "bones"], run: () => { setWorkspace("interaction"); setLayoutPreset("custom"); setLeftHidden((value) => !value); } },
    { id: "toggle-inspector", title: "Toggle inspector panel", description: "Show or hide the right-side properties panel", group: "Layout", keywords: ["right panel", "properties"], run: () => { setWorkspace("interaction"); setLayoutPreset("custom"); setRightHidden((value) => !value); } },
    { id: "fit-canvas", title: "Fit canvas", description: "Frame the loaded artwork in the preview", group: "View", keywords: ["zoom", "preview"], disabled: !assetLoaded, run: () => { setWorkspace("interaction"); rendererRef.current?.resetCamera(); } },
    { id: "save-project", title: "Save to asset root", description: "Write the project and linked subtitles to disk", group: "Project", keywords: ["persist", "save files"], disabled: !assetLoaded || saveState === "saving", run: () => { void saveProject(); } },
    { id: "undo", title: "Undo", description: "Undo the last project edit", group: "Edit", keywords: ["revert"], disabled: undo.length === 0, run: undoProject },
    { id: "redo", title: "Redo", description: "Redo the last undone project edit", group: "Edit", keywords: ["repeat"], disabled: redo.length === 0, run: redoProject },
    { id: "test-interaction", title: testing ? "Exit interaction test" : "Test selected interaction", description: "Preview the selected interaction without saving", group: "Preview", keywords: ["play", "hit region"], disabled: !selectedInteraction || !frame, run: toggleTest },
    { id: "add-interaction", title: "Add interaction", description: "Create a new local interaction", group: "Edit", keywords: ["new", "hit target"], disabled: !project || !frame || !meta, run: addInteraction },
    { id: "add-region", title: "Add hit region", description: "Add a region to the selected interaction", group: "Edit", keywords: ["new", "target"], disabled: !selectedInteraction || !frame, run: addRegion },
    { id: "project-issues", title: "Show project checks", description: validationWarnings.length ? `${validationWarnings.length} items need review` : "No current validation warnings", group: "Project", keywords: ["issues", "warnings", "validation"], disabled: !assetLoaded, run: showProjectIssues },
    { id: "keyboard-help", title: "Show keyboard shortcuts", description: "Open editor shortcut help", group: "Help", keywords: ["shortcuts", "keys"], run: () => setHelp(true) },
    { id: "about", title: "About BA Spine Editor", description: "View version, release notes, and update settings", group: "Help", keywords: ["version", "update", "release"], run: () => setAboutPage(true) },
  ];

  const companionStatusIsError = Boolean(companionStatus && /(failed|error|could not|did not|unavailable|issue)/i.test(companionStatus));

  return (
    <>
    <div className={`editor-app${testing ? " is-testing" : ""}`} inert={aboutPage}>
      <header className="editor-header">
        <div className="editor-brand">
          <span className="editor-kicker">BA SPINE SUITE · SPINE 4.2</span>
          <h1>{workspace === "timeline" ? "Timeline Composer" : workspace === "camera" ? "Camera Studio" : "Interaction Studio"}</h1>
        </div>
        <div className="editor-header-context">
          <div className="editor-workspace-tabs suite-tabs" role="tablist" aria-label="Editor workspace">
            <button className={`editor-button suite-tab${workspace === "interaction" ? " active" : ""}`} role="tab" aria-selected={workspace === "interaction"} onClick={() => setWorkspace("interaction")}>Interactions</button>
            <button className={`editor-button suite-tab${workspace === "timeline" ? " active" : ""}`} role="tab" aria-selected={workspace === "timeline"} onClick={() => setWorkspace("timeline")} disabled={!assetLoaded}>Timeline</button>
            <button className={`editor-button suite-tab${workspace === "camera" ? " active" : ""}`} role="tab" aria-selected={workspace === "camera"} onClick={() => setWorkspace("camera")} disabled={!assetLoaded}>Camera</button>
          </div>
          <div className="editor-asset-picker"><span>Set</span><button className="editor-asset-picker-button" type="button" aria-label="Choose character or asset set" aria-haspopup="dialog" aria-expanded={assetPickerOpen} onClick={() => setAssetPickerOpen(true)} disabled={!directories.length} title={directory || "Open a folder first"}><span>{directory ? characterDirectoryLabel(directory, directoryLabels) : "Open a folder…"}</span><IconChevronDown /></button></div>
          <label className="editor-light-fx-control" title="Saved with this project and used in Editor and Viewer previews.">
            <span>Light FX</span>
            <input type="range" min="0" max="1" step="0.05" value={project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH} aria-label="Light FX strength" disabled={!project} onChange={(event) => live((current) => ({ ...current, effectsStrength: Number(event.target.value) }))} />
            <output>{Math.round((project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH) * 100)}%</output>
          </label>
        </div>
        <div className="editor-actions">
          <button className="suite-icon-button editor-button editor-icon-button editor-command-trigger" type="button" aria-label="Search commands" aria-keyshortcuts="Control+K Meta+K" title="Search commands (Ctrl/⌘ K)" onClick={() => setCommandPaletteOpen(true)}><IconSearch /></button>
          <WorkspacePresetMenu compact selected={layoutPreset} timelineDisabled={!assetLoaded} onSelect={applyWorkspacePreset} />
          <details className="editor-open-menu editor-header-menu" name="editor-toolbar-menu">
            <summary className="editor-button editor-icon-button" aria-label="Open files and folders" title="Open files and folders"><IconFolder /><IconChevronDown /></summary>
            <div className="editor-open-menu-popover">
              <button className="suite-button editor-button" type="button" onClick={(event) => { closeHeaderMenu(event); void openFolder(); }}><IconFolder /> Open asset folder…</button>
              <button className="suite-button editor-button" type="button" onClick={(event) => { closeHeaderMenu(event); void openProjectFile(); }}><IconFile /> Open project file…</button>
              <div className="editor-open-menu-heading"><span>Recently opened</span>{recentFiles.length > 0 && <button onClick={() => { recentFilesRef.current = []; setRecentFiles([]); try { localStorage.removeItem(RECENT_FILES_KEY); } catch { /* optional */ } }}>Clear</button>}</div>
              {recentList(8)}
            </div>
          </details>
          {isDesktopHost() && source && <details className="editor-header-menu editor-preview-menu" name="editor-toolbar-menu">
            <summary className="suite-button editor-button editor-preview-trigger" aria-label="Preview in Viewer" title="Preview in BA Spine Viewer"><IconEye /><span>Preview</span><IconChevronDown /></summary>
            <div className="editor-header-menu-popover" role="group" aria-label="Viewer preview options">
              <button className="editor-header-menu-item" type="button" onClick={(event) => { closeHeaderMenu(event); void previewSavedInViewer(); }} disabled={!assetLoaded || saveState === "saving"} title="Preview the last saved library files">
                <IconFile /><span><strong>Preview saved</strong><small>Open the saved project in Viewer</small></span>
              </button>
              <button className="editor-header-menu-item" type="button" onClick={(event) => { closeHeaderMenu(event); void previewUnsavedDraftInViewer(); }} disabled={!assetLoaded || (saveState !== "dirty" && saveState !== "error")} title="Send a read-only, in-memory snapshot to Viewer">
                <IconEye /><span><strong>Preview unsaved draft</strong><small>Send the current in-memory project</small></span>
              </button>
              {draftPreviewSessionId && <button className="editor-header-menu-item is-danger" type="button" onClick={(event) => { closeHeaderMenu(event); stopDraftPreview("Draft preview ended; Viewer will return to saved files."); }}>
                <IconClose /><span><strong>Stop draft preview</strong><small>Return Viewer to saved files</small></span>
              </button>}
            </div>
          </details>}
          {companionStatus && <details className={`editor-header-menu editor-notice-menu${companionStatusIsError ? " has-error" : ""}`} name="editor-toolbar-menu">
            <summary className="editor-button editor-icon-button editor-notice-trigger" aria-label={companionStatusIsError ? "Viewer connection issue" : "Viewer status"} title={companionStatus}>{companionStatusIsError ? <IconAlert /> : <IconEye />}</summary>
            <div className="editor-header-menu-popover editor-notice-popover" role="status">
              <div className="editor-notice-heading"><strong>{companionStatusIsError ? "Viewer connection issue" : "Viewer status"}</strong><button className="editor-icon-button" type="button" aria-label="Dismiss Viewer notice" title="Dismiss" onClick={(event) => { closeHeaderMenu(event); setCompanionStatus(null); }}><IconClose /></button></div>
              <p>{companionStatus}</p>
            </div>
          </details>}
          <SaveStatus state={saveState} savedAt={savedAt} hasProject={Boolean(project)} />
          <button className="suite-icon-button editor-button editor-icon-button editor-save-button" type="button" aria-label="Save to root" onClick={() => void saveProject()} disabled={!assetLoaded || saveState === "saving"} title="Save the project and linked subtitles to this asset root"><IconSave /></button>
          <details className="editor-header-menu editor-more-menu" name="editor-toolbar-menu">
            <summary className="editor-button editor-icon-button" aria-label="More editor actions" title="More editor actions"><IconMore /></summary>
            <div className="editor-header-menu-popover editor-more-popover" role="group" aria-label="More editor actions">
              <button className="editor-header-menu-item" type="button" onClick={(event) => { closeHeaderMenu(event); setHelp((value) => !value); }}>
                <IconHelp /><span><strong>Help & shortcuts</strong><small>View keyboard shortcuts</small></span>
              </button>
              <button className="editor-header-menu-item" type="button" onClick={(event) => { closeHeaderMenu(event); setAboutPage(true); }}>
                <IconHelp /><span><strong>About BA Spine Editor</strong><small>Version and update information</small></span>
              </button>
            </div>
          </details>
        </div>
      </header>
      {recoveryPrompt && recoveryPrompt.rootPath === source?.rootPath && recoveryPrompt.directory === directory && <section className="editor-recovery-prompt" role="region" aria-label="Project recovery">
        <div><strong>Local recovery snapshots found</strong><span>Nothing was restored automatically. Choose a snapshot to restore as an unsaved draft, or dismiss.</span></div>
        <div className="editor-recovery-actions">
          {recoveryPrompt.current && <button type="button" onClick={() => restoreRecoveryProject(recoveryPrompt.current!, "Latest recovery snapshot", recoveryPrompt.legacyCurrent)}>Restore latest ({recoveryPrompt.savedAt ? new Date(recoveryPrompt.savedAt).toLocaleString() : "legacy snapshot"})</button>}
          {recoveryPrompt.backups[0] && <button type="button" onClick={() => restoreRecoveryProject(recoveryPrompt.backups[0]!, "Previous recovery backup", recoveryPrompt.legacyBackups[0])}>Restore previous backup</button>}
          <button type="button" onClick={dismissRecoveryPrompt}>Dismiss</button>
        </div>
      </section>}
      <AssetPickerModal open={assetPickerOpen} title="Switch character or asset set" eyebrow="CHARACTER / ASSET SET" description="Search the loaded Spine catalog, then choose the set to edit." directories={directories} selected={directory} assetRoot={source?.rootPath ?? ""} directoryInfo={directoryInfo} renderLabel={(item) => characterDirectoryLabel(item, directoryLabels)} getSearchText={(item) => characterDirectoryLabel(item, directoryLabels)} onClose={() => setAssetPickerOpen(false)} onSelect={(next) => { setAssetPickerOpen(false); void changeDirectory(next); }} />
      <CommandPalette open={commandPaletteOpen} commands={commandPaletteCommands} onClose={() => setCommandPaletteOpen(false)} />

        {help && <div className="editor-help" role="region" aria-label="Editor help"><strong>Shortcuts</strong>{workspace === "camera" ? <><span>Camera: use Select, Pan, or Draw tools on the full-scene canvas. Edit selected boundaries and shots in the right inspector.</span><span>Ctrl/⌘ K Commands · Space Play/pause · Use the shared playhead to sync with Timeline · Ctrl/⌘ S Save</span></> : workspace === "timeline" ? <span>Ctrl/⌘ K Commands · Space Play/pause · Left/right Frame · Shift+Left/right 10 frames · Home/End · S Split subtitle · Ctrl/⌘ C/V Copy/paste · Ctrl/⌘ D Duplicate · Ctrl/⌘ Z Undo · Ctrl/⌘ Shift+Z or Y Redo · Delete Remove · F Fit timeline · Select a camera key, then Edit in Camera · Ctrl/⌘ S Save</span> : <><span>Draw a hit region, choose animations, then test it with press, hold, drag, and release.</span><span>Ctrl/⌘ K Commands · V Select · H Pan · R Draw · T Test · F Fit canvas · B Bones · Space Play/pause · Esc Idle/Edit</span><span>Ctrl/⌘ Z Undo · Ctrl/⌘ Shift+Z or Y Redo · Ctrl/⌘ D Duplicate · Delete Remove region · Ctrl/⌘ S Save</span></>}<button className="editor-button" onClick={() => setHelp(false)}><IconClose /> Close</button></div>}
        <main className={`editor-layout${leftHidden ? " hide-left" : ""}${rightHidden ? " hide-right" : ""}${!assetLoaded ? " is-loading" : ""}`} style={{ position: workspace !== "interaction" ? "absolute" : undefined, visibility: workspace !== "interaction" ? "hidden" : undefined, inset: workspace !== "interaction" ? "100px 0 40px" : undefined, pointerEvents: workspace !== "interaction" ? "none" : undefined, gridTemplateColumns: `${leftHidden ? "" : `${leftWidth}px `}minmax(180px, 1fr)${rightHidden ? "" : ` ${rightWidth}px`}` }}>
        {assetLoaded && (["left", "right"] as const).filter((side) => side === "left" ? !leftHidden : !rightHidden).map((side) => <div key={side} className={`editor-panel-resizer ${side}`} role="separator" aria-label={`Resize ${side} panel`} aria-orientation="vertical" tabIndex={0} style={side === "left" ? { left: leftWidth + 7 } : { right: rightWidth + 7 }} onDoubleClick={() => { setLayoutPreset("custom"); side === "left" ? setLeftWidth(220) : setRightWidth(320); }} onKeyDown={(event) => {
           if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
           event.preventDefault(); setLayoutPreset("custom"); const delta = event.key === "ArrowRight" ? 10 : -10;
          side === "left" ? setLeftWidth((value) => Math.max(160, Math.min(380, value + delta))) : setRightWidth((value) => Math.max(260, Math.min(460, value - delta)));
        }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); panelDragRef.current = { side, x: event.clientX, width: side === "left" ? leftWidth : rightWidth }; }} onPointerMove={(event) => {
          const drag = panelDragRef.current;
          if (!drag) return;
           const dx = event.clientX - drag.x;
           setLayoutPreset("custom");
          drag.side === "left" ? setLeftWidth(Math.max(160, Math.min(380, drag.width + dx))) : setRightWidth(Math.max(260, Math.min(460, drag.width - dx)));
        }} onPointerUp={() => { panelDragRef.current = null; }} onPointerCancel={() => { panelDragRef.current = null; }} />)}
        <aside className="editor-panel editor-left-panel" hidden={!assetLoaded || leftHidden}>
          <BoneNavigator
            assetRoot={source?.rootPath ?? ""}
            directory={directory}
            bones={frame?.bones ?? []}
            selectedPath={project?.selectedBonePath ?? null}
            interactionTargetPaths={interactionTargetPaths}
            showInactive={displaySettings.showInactiveBones}
            revealRequest={boneRevealRequest}
            onSelect={(path) => live((current) => ({ ...current, selectedBonePath: path }))}
          />
           <details className="editor-section editor-constraints">
             <summary className="editor-section-title"><strong>Constraints</strong><span>{frame?.constraints.length ?? 0}</span><IconPlus className="editor-details-icon" /></summary>
            <div className="editor-constraint-list">
              {frame?.constraints.map((constraint) => <div key={`${constraint.type}-${constraint.name}`}><b>{constraint.type}</b> {constraint.name}<small>{constraint.target || "physics"}</small></div>)}
              {!frame?.constraints.length && <p className="editor-muted">No constraints in this skeleton.</p>}
            </div>
          </details>
        </aside>

        <section className="editor-center">
          {!assetLoaded && <div className="editor-start editor-start-overlay" aria-live="polite">
            <div className="editor-start-card">
              <span className="editor-kicker">DESKTOP WORKSPACE</span>
              <strong>{error && source && directory ? "Could not load asset set" : source && directory ? "Loading asset set…" : "Open a Spine asset folder"}</strong>
              <span>{error && source && directory ? error : source && directory ? "Reading the selected .atlas, .skel, and texture files." : "Choose the local folder containing your Spine lobby assets to begin."}</span>
              {source && directory && !error && <div className="editor-load-progress" role="progressbar" aria-label="Asset loading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loadPercent}>
                <progress value={loadPercent} max={100} />
                <span>{loadStageLabel} · {loadPercent}%</span>
              </div>}
              <div className="editor-start-actions">
                <button className="editor-button editor-start-button" onClick={() => void openFolder()}>{source && directory ? "Choose another folder" : "Open asset folder"}</button>
                <button className="editor-button editor-start-secondary" onClick={() => void openProjectFile()}>Open project file</button>
              </div>
              {recentFiles.length > 0 && <section className="editor-recent-start"><div className="editor-section-title"><strong>Recently opened</strong><button onClick={() => { recentFilesRef.current = []; setRecentFiles([]); try { localStorage.removeItem(RECENT_FILES_KEY); } catch { /* optional */ } }}>Clear</button></div>{recentList(5)}</section>}
            </div>
          </div>}
          <div className="editor-toolbar" role="toolbar" aria-label="Canvas tools">
              <button className="editor-button" onClick={() => { setLayoutPreset("custom"); setLeftHidden((value) => !value); }} title="Toggle bone panel"><IconMenu /> Bones</button>
             <button className={`editor-button${!testing && tool === "select" ? " active" : ""}`} onClick={() => { setTesting(false); setTool("select"); }} title="Select and transform regions (V)"><IconTarget /> Select</button>
             <button className={`editor-button${!testing && tool === "pan" ? " active" : ""}`} onClick={() => { setTesting(false); setTool("pan"); }} title="Drag canvas to pan; wheel to zoom (H)"><IconHand /> Pan</button>
             <button className={`editor-button${!testing && tool === "draw" ? " active" : ""}`} disabled={!selectedInteraction} onClick={() => { setTesting(false); setTool("draw"); setStatus("Click and drag on the canvas to draw a hit region."); }} title="Draw a hit region (R)"><IconPlus /> Draw region</button>
             <button className={`editor-button${testing ? " active test" : ""}`} onClick={toggleTest} disabled={!project} title="Run the full authored interaction (T)">{testing ? <><IconPause /> Test</> : <><IconPlay /> Test</>}</button>
              <button className="editor-button" onClick={() => rendererRef.current?.resetCamera()} title="Fit artwork to the canvas (F)"><IconExpand /> Fit canvas</button>
             <details className="editor-overlay-menu">
               <summary className="editor-button"><IconSliders /> Overlays <IconChevronDown /></summary>
              <div className="editor-overlay-menu-popover">
                <label><input type="checkbox" checked={displaySettings.showBones} onChange={(event) => updateViewSetting("showBones", event.target.checked)} /> Bones</label>
                <label><input type="checkbox" checked={displaySettings.showBoneNames} onChange={(event) => updateViewSetting("showBoneNames", event.target.checked)} /> Names</label>
                <label><input type="checkbox" checked={displaySettings.showConstraints} onChange={(event) => updateViewSetting("showConstraints", event.target.checked)} /> Constraints</label>
                <label><input type="checkbox" checked={displaySettings.showInactiveBones} onChange={(event) => updateViewSetting("showInactiveBones", event.target.checked)} /> Inactive bones</label>
              </div>
            </details>
            <button className="editor-button" onClick={resetPreview} disabled={!meta}>Reset idle</button>
              <button className="editor-button" onClick={() => { setLayoutPreset("custom"); setRightHidden((value) => !value); }} title="Toggle inspector">Inspector <IconMenu /></button>
          </div>
          <div className="editor-stage" ref={stageRef} onDoubleClick={(event) => { if (!testing && event.target === canvasRef.current) rendererRef.current?.resetCamera(); }}>
            <canvas ref={canvasRef} aria-label="Spine editor canvas" />
            <BoneOverlay
                frame={frame}
                project={testing && project ? { ...project, selectedRegionId: null, ...(showTestRegions ? {} : { interactions: project.interactions.map((interaction) => ({ ...interaction, regions: [] })) }) } : project}
                viewSettings={renderedViewSettings}
                motionLimits={(testing || inspectorTab === "movement") && selectedInteraction ? {
                  targetBonePath: testing ? previewDebug.targetBonePath ?? selectedInteraction.followTargetBone : selectedInteraction.followTargetBone,
                  limitX: selectedInteraction.limitX,
                  limitY: selectedInteraction.limitY,
                  offsetX: testing ? previewDebug.offsetX : 0,
                  offsetY: testing ? previewDebug.offsetY : 0,
                  allowX: selectedInteraction.allowX,
                  allowY: selectedInteraction.allowY,
                  rotationEnabled: selectedInteraction.rotationEnabled,
                  rotationMin: selectedInteraction.rotationMin,
                  rotationMax: selectedInteraction.rotationMax,
                } : null}
                tool={testing ? "pan" : tool}
              onSelectBone={(path) => live((current) => ({ ...current, selectedBonePath: path }))}
              onSelectRegion={(interactionId, regionId) => live((current) => ({ ...current, selectedInteractionId: interactionId, selectedRegionId: regionId }))}
              onBeginRegionDrag={() => { if (projectRef.current) setUndo((items) => [...items.slice(-49), projectRef.current!]); setRedo([]); }}
              onChangeRegion={(interactionId, regionId, patch) => live((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === interactionId ? { ...item, regions: item.regions.map((region) => region.id === regionId ? { ...region, ...patch, placement: "manual" } : region) } : item) }))}
              onDragRegion={(interactionId, regionId, x, y) => live((current) => ({
                ...current,
                interactions: current.interactions.map((interaction) => interaction.id !== interactionId ? interaction : {
                  ...interaction,
                   regions: interaction.regions.map((region) => region.id === regionId ? { ...region, offsetX: x, offsetY: y, placement: "manual" } : region),
                }),
              }))}
             />
            {(testing || tool === "draw") && <div className={`editor-input-surface${testing ? " testing" : " drawing"}`} aria-label={testing ? "Interaction test surface" : "Draw region surface"} onPointerDown={stagePress} onPointerMove={stageMove} onPointerLeave={(event) => { if (testing && testPointerRef.current === event.pointerId) previewRef.current.leave(); }} onPointerUp={stageRelease} onPointerCancel={(event) => { if (testing && testPointerRef.current === event.pointerId) { testPointerRef.current = null; previewRef.current.release(); } drawRef.current = null; setDrawBox(null); }} />}
            {drawBox && frame && <svg className="editor-draw-ghost" viewBox={`0 0 ${frame.canvasWidth} ${frame.canvasHeight}`} preserveAspectRatio="none"><ellipse cx={drawBox.x + drawBox.width / 2} cy={drawBox.y + drawBox.height / 2} rx={drawBox.width / 2} ry={drawBox.height / 2} /></svg>}
            {!frame && <div className="editor-empty"><strong>Open a Spine asset folder</strong><span>The desktop editor reads .atlas, .skel, and local texture files from the selected root.</span></div>}
            {frame && <div className="editor-canvas-badge">{frame.animation ?? "No animation"} · {frame.bones.length} bones</div>}
             {(testing || tool !== "select") && <div className="editor-stage-hint">{testing ? `${previewStatus} · Press a region, hold/drag, release` : tool === "draw" ? "Drag to draw a new region" : "Drag to pan · Wheel to zoom · F to fit"}</div>}
          </div>
           {testing && <div className="editor-testbar">
              <div className="editor-debug-status"><strong aria-live="polite" title={previewStatus}>{previewStatus}</strong><span>{previewDebug.held ? "Held" : previewDebug.phase === "idle" ? "Ready" : "Released"}</span></div>
              <div className="editor-debug-grid" aria-label="Interaction debugger">
                <span>Interaction <b title={previewDebug.interactionName || undefined}>{previewDebug.interactionName || "—"}</b></span>
                <span>Region <b title={previewDebug.regionName || undefined}>{previewDebug.regionName || "—"}</b></span>
                <span title={previewDebug.returning ? `Phase ${previewDebug.phase}, return ${Math.round(previewDebug.returnProgress * 100)}%` : `Phase ${previewDebug.phase}`}>Phase <b>{previewDebug.phase}{previewDebug.returning ? ` · return ${Math.round(previewDebug.returnProgress * 100)}%` : ""}</b></span>
                <span>Body <b title={previewDebug.bodyAnimation || undefined}>{previewDebug.bodyAnimation || "—"}</b></span>
                <span>Face <b title={previewDebug.faceAnimation || undefined}>{previewDebug.faceAnimation || "—"}</b></span>
               <span>Target <b title={previewDebug.targetBonePath ?? ""}>{previewDebug.targetBonePath?.split("/").pop() ?? "—"}</b></span>
               <span>Offset <b>{previewDebug.offsetX.toFixed(1)}, {previewDebug.offsetY.toFixed(1)}</b></span>
               <span>Rotation <b>{previewDebug.rotation.toFixed(1)}°</b></span>
              </div>
              <div className="editor-test-controls">
                <button className="editor-preview-button" disabled={!selectedInteraction || !frame} onClick={startSelectedTest}><IconPlay /> Test selected</button>
                <button className="editor-preview-button" disabled={previewDebug.phase === "idle" || previewDebug.phase === "releasing"} onClick={releaseTest}>Release</button>
                <button className="editor-preview-button" disabled={!selectedInteraction || !frame} onClick={replayTest}>Replay</button>
              </div>
              <label><input type="checkbox" checked={showTestRegions} onChange={(event) => setShowTestRegions(event.target.checked)} /> Hit regions</label>
           </div>}
          <div className="editor-timeline">
            <div className="editor-timeline-top">
               <button className="editor-icon-button" title="Play/pause (Space)" onClick={() => { const next = !playing; setPlaying(next); rendererRef.current?.setPlaying(next); }} disabled={!frame || testing}>{playing ? <IconPause /> : <IconPlay />}</button>
               <AnimationPicker ariaLabel="Preview animation" placeholder={meta && !meta.idleAnimation ? "No idle detected · choose animation" : "Choose animation…"} value={selectedAnimation} options={(meta?.animations ?? []).map((animation) => ({ value: animation, label: animation }))} onChange={(animation) => { setSelectedAnimation(animation); setAnimationSelectionOrigin("explicit"); rendererRef.current?.setAnimation(animation, true); }} disabled={!meta || testing} />
                {animationSelectionOrigin === "automatic" && meta?.idleAnimation && <small className="editor-field-hint">{selectedAnimation === "__intro__" ? `Automatically playing the detected intro, then ${meta.idleAnimation}.` : selectedAnimation === meta.idleAnimation ? `Automatically selected ${meta.idleAnimation} as the detected idle.` : `Detected idle: ${meta.idleAnimation}. Choose an animation explicitly.`}</small>}
              <NumberField label="Speed" value={speed} min={0.1} max={3} step={0.1} precision={1} unit="×" scrub={false} compact onCommit={setSpeed} />
              <span className="editor-time">{progress.time.toFixed(2)} / {progress.duration.toFixed(2)}s</span>
            </div>
            <input aria-label="Animation position" className="editor-range" type="range" min="0" max={Math.max(0.001, progress.duration)} step="0.001" value={Math.min(progress.time, progress.duration)} onChange={(event) => { setPlaying(false); rendererRef.current?.seek(Number(event.target.value)); }} disabled={!frame || testing} />
          </div>
        </section>

        <aside className={`editor-panel editor-right-panel tab-${inspectorTab}`} hidden={!assetLoaded || rightHidden}>
           <nav className="editor-tabs" aria-label="Inspector sections">{(["region", "animation", "movement"] as const).map((tab) => <button key={tab} aria-pressed={inspectorTab === tab} onClick={(event) => { setInspectorTab(tab); event.currentTarget.closest("aside")?.scrollTo({ top: 0 }); }}>{tab === "region" ? "Region" : tab === "animation" ? "Animation" : "Movement"}</button>)}</nav>
          <section className="editor-section editor-interactions-section">
             <div className="editor-section-title"><strong>Interactions</strong><button onClick={addInteraction} disabled={!project || !frame}><IconPlus /> Add</button></div>
            <input className="editor-search" value={interactionSearch} onChange={(event) => setInteractionSearch(event.target.value)} placeholder="Filter interactions…" />
            <div className="editor-interaction-list">
              {visibleInteractions.map((item) => <button key={item.id} className={item.id === project?.selectedInteractionId ? "is-selected" : ""} onClick={() => selectInteraction(item.id)}><i style={{ background: item.color }} />{item.name}<small>{item.regions.length} region{item.regions.length === 1 ? "" : "s"}</small></button>)}
            </div>
          </section>
          <details ref={validationDetailsRef} className={`editor-section editor-validation${validationWarnings.length ? " has-warnings" : ""}`}>
             <summary>{validationWarnings.length ? `${validationWarnings.length} checks to review` : <><IconCheck /> Project checks passed</>}</summary>
            <div className="editor-section-title"><strong>Validation</strong><span>{validationWarnings.length ? `${validationWarnings.length} warning${validationWarnings.length === 1 ? "" : "s"}` : "Ready"}</span></div>
            {validationWarnings.length === 0
              ? <p className="editor-muted">No missing animations, bones, or overlapping regions.</p>
              : <div className="editor-validation-list">{validationWarnings.map((warning) => <button key={warning.id} type="button" className="editor-validation-issue" onClick={() => navigateToValidationIssue(warning)} title="Select this interaction and open the relevant inspector section"><b>{warning.kind.replaceAll("-", " ")}</b><span>{warning.message}</span><small>Go to issue →</small></button>)}</div>}
          </details>
            {selectedInteraction && <section className="editor-section editor-inspector">
              <div className="editor-section-title"><strong>Interaction</strong><span><button onClick={duplicateInteraction} title="Duplicate interaction and its regions">Duplicate</button> <button className="danger" onClick={() => { if (confirm("Delete this interaction and all its regions?")) deleteInteraction(); }}>Delete</button></span></div>
              <InteractionSummary name={selectedInteraction.name} trigger={selectedInteraction.trigger} color={selectedInteraction.color} enabled={selectedInteraction.enabled} onEnabledChange={(enabled) => updateInteraction("enabled", enabled)} />
              <details className="editor-interaction-settings" open={inspectorTab !== "region"}>
                <summary>Interaction settings</summary>
                <div className="editor-settings-body">
              <label>Name<input value={selectedInteraction.name} onChange={(event) => updateInteraction("name", event.target.value)} /></label>
              <div className="editor-two-fields"><label>Trigger<select value={selectedInteraction.trigger} onChange={(event) => updateInteraction("trigger", event.target.value)}><option value="press">Press</option><option value="hold">Hold</option><option value="drag">Drag</option></select></label><label>Color<input type="color" value={selectedInteraction.color} onChange={(event) => updateInteraction("color", event.target.value)} /></label></div>
               <div className="editor-animation-fields">
               <div className="editor-subheading">Press, hold, and release</div>
               <p className="editor-muted">Body and face tracks play together. The hold phase loops; blend duration controls each transition.</p>
               <div className={`editor-phase-suggestion${phaseSuggestion ? " has-suggestion" : ""}`}>
                 <span aria-hidden="true"><IconTarget /></span>
                 <p>{phaseSuggestion ? <><b>{phaseSuggestion.kind} profile detected.</b> {phaseSuggestion.reason} Applying fills the phase tracks only.</> : "No local profile matches this press animation. Choose a detected Pat, Touch, or Pinch press to preview a mapping."}</p>
                 <button type="button" className="editor-preview-button" disabled={!phaseSuggestion} onClick={detectPhases}>Apply suggestion</button>
               </div>
               <AnimationPhaseEditor
                 animations={meta?.animations ?? []}
                 press={selectedInteraction.startAnimation}
                 hold={selectedInteraction.followAnimation}
                 release={selectedInteraction.endAnimation}
                 facePress={selectedInteraction.faceStartAnimation}
                 faceHold={selectedInteraction.faceFollowAnimation}
                 faceRelease={selectedInteraction.faceEndAnimation}
                 mixPress={selectedInteraction.startMixDuration}
                 mixHold={selectedInteraction.followMixDuration}
                 mixRelease={selectedInteraction.releaseMixDuration}
                 activePhase={testing && previewDebug.interactionName === selectedInteraction.name ? previewDebug.phase : ""}
                 disabled={testing}
                 onAnimationChange={(field, value) => updateInteraction(field, value)}
                 onMixChange={(field, value) => updateInteraction(field, value)}
                 onPreview={previewPhase}
               />
               <button className="editor-preview-button" onClick={toggleTest}>{testing ? "Exit test" : "Test full interaction"}</button>
               </div>
              <div className="editor-movement-fields">
               <div className="editor-subheading">Drag response</div>
               <p className="editor-muted">Movement is relative to the initial press. Limits are in the target bone's parent space.</p>
              <BonePicker
                label="Movement target"
                bones={frame?.bones ?? []}
                value={selectedInteraction.followTargetBone}
                noneLabel="No target bone"
                selectedPath={project?.selectedBonePath ?? null}
                onChange={(path) => updateInteraction("followTargetBone", path)}
                onReveal={(path) => revealBonePath(path)}
              />
                <BoundedSliderField label="Sensitivity" value={selectedInteraction.sensitivity} defaultValue={0.25} min={0} max={2} step={0.05} precision={2} onCommit={(value) => updateInteraction("sensitivity", value)} />
                <div className="editor-two-fields"><NumberField label="Limit X" value={selectedInteraction.limitX} min={0} step={1} unit="units" onCommit={(value) => updateInteraction("limitX", value)} /><NumberField label="Limit Y" value={selectedInteraction.limitY} min={0} step={1} unit="units" onCommit={(value) => updateInteraction("limitY", value)} /></div>
              <div className="editor-subheading">Local bone constraints</div>
              <p className="editor-muted">Translation uses the target parent’s local axes. Rotation is relative to the animated bone pose.</p>
              <div className="editor-axis-checks" aria-label="Translation axes">
                <span>Translation axes</span>
                <label><input type="checkbox" checked={selectedInteraction.allowX} onChange={(event) => updateInteraction("allowX", event.target.checked)} /> Local X</label>
                <label><input type="checkbox" checked={selectedInteraction.allowY} onChange={(event) => updateInteraction("allowY", event.target.checked)} /> Local Y</label>
              </div>
              <div className="editor-two-fields">
                <label><span className="timeline-inline-check"><input type="checkbox" checked={selectedInteraction.rotationEnabled} onChange={(event) => updateInteraction("rotationEnabled", event.target.checked)} /> Local rotation</span><small className="editor-field-hint">The R gizmo shows the active range.</small></label>
                <label>Rotation input<select value={selectedInteraction.rotationAxis} disabled={!selectedInteraction.rotationEnabled} onChange={(event) => updateInteraction("rotationAxis", event.target.value)}><option value="x">Local X drag</option><option value="y">Local Y drag</option></select></label>
              </div>
              <div className="editor-two-fields"><NumberField label="Min rotation" value={selectedInteraction.rotationMin} min={-180} max={0} step={1} unit="°" disabled={!selectedInteraction.rotationEnabled} onCommit={(value) => updateInteraction("rotationMin", value)} /><NumberField label="Max rotation" value={selectedInteraction.rotationMax} min={0} max={180} step={1} unit="°" disabled={!selectedInteraction.rotationEnabled} onCommit={(value) => updateInteraction("rotationMax", value)} /></div>
                <div><BoundedSliderField label="Follow smoothing" value={selectedInteraction.smoothing} defaultValue={8} min={1} max={24} step={0.5} precision={1} onCommit={(value) => updateInteraction("smoothing", value)} /><small className="editor-field-hint">Higher values follow the target faster.</small></div>
               <div className="editor-subheading">Release return</div>
               <p className="editor-muted">When released, the target eases from its current offset back to the animated bone pose while the End phase plays.</p>
                 <div className="editor-two-fields"><NumberField label="Return duration" value={selectedInteraction.returnDuration} min={0.05} max={2} step={0.05} unit="s" onCommit={(value) => updateInteraction("returnDuration", value)} /><label>Return easing<select aria-label="Return easing" value={selectedInteraction.returnEasing} onChange={(event) => updateInteraction("returnEasing", event.target.value as EditorInteraction["returnEasing"])}><option value="linear">Linear</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in / out</option></select></label></div>
               </div>
               </div>
             </details>
              <div className="editor-region-fields">
              <div className="editor-subheading editor-region-heading"><span>Hit regions</span><button onClick={addRegion}><IconPlus /> Add region</button></div>
            <div className="editor-region-list">
              {selectedInteraction.regions.map((region) => <button key={region.id} className={region.id === project?.selectedRegionId ? "is-selected" : ""} onClick={() => live((current) => ({ ...current, selectedRegionId: region.id }))}><i style={{ background: selectedInteraction.color }} />{region.name}<small>{region.shape}</small></button>)}
              {!selectedInteraction.regions.length && <p className="editor-muted">No hit regions. Add one to make this interaction clickable.</p>}
             </div>
              </div>
           </section>}
           {inspectorTab === "region" && selectedRegion && selectedInteraction && <section className="editor-section editor-inspector">
             <div className="editor-section-title"><strong>Region</strong><span><button onClick={duplicateRegion}>Duplicate</button> <button className="danger" onClick={deleteRegion}>Delete</button></span></div>
            <label>Name<input value={selectedRegion.name} onChange={(event) => updateRegion("name", event.target.value)} /></label>
             <div className="editor-two-fields">
               <label>Shape<select value={selectedRegion.shape} onChange={(event) => updateRegion("shape", event.target.value)}><option value="ellipse">Ellipse</option><option value="rectangle">Rectangle</option></select></label>
               <BonePicker
                 label="Anchor"
                 bones={frame?.bones ?? []}
                 value={selectedRegion.anchorBone}
                 noneLabel="World (canvas)"
                 selectedPath={project?.selectedBonePath ?? null}
                 useSelectedLabel="Anchor selected · keep position"
                 onChange={(path) => updateRegion("anchorBone", path)}
                 onUseSelected={anchorToSelected}
                 onReveal={(path) => revealBonePath(path)}
               />
             </div>
              <details><summary>Position & size (advanced)</summary><div className="editor-three-fields"><NumberField label="Offset X" value={selectedRegion.offsetX} step={1} precision={2} unit="units" onCommit={(value) => updateRegion("offsetX", value)} /><NumberField label="Offset Y" value={selectedRegion.offsetY} step={1} precision={2} unit="units" onCommit={(value) => updateRegion("offsetY", value)} /><NumberField label="Rotation" value={selectedRegion.rotation} step={1} precision={1} unit="°" onCommit={(value) => updateRegion("rotation", value)} /></div>
              <div className="editor-two-fields"><NumberField label="Radius X" value={selectedRegion.radiusX} min={1} step={1} precision={2} unit="units" onCommit={(value) => updateRegion("radiusX", value)} /><NumberField label="Radius Y" value={selectedRegion.radiusY} min={1} step={1} precision={2} unit="units" onCommit={(value) => updateRegion("radiusY", value)} /></div></details>
            <label><input type="checkbox" checked={selectedRegion.enabled} onChange={(event) => updateRegion("enabled", event.target.checked)} /> Enabled</label>
              <button className="editor-preview-button" disabled={!headRegionRef.current} onClick={snapRegionToHead}>Fit region to detected head</button>
             <button className="editor-preview-button" onClick={() => mutate((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: item.regions.map((region) => region.id === selectedRegion.id ? { ...region, offsetX: 0, offsetY: 0 } : region) } : item) }))}>Center on anchor</button>
              <p className="editor-muted">Choose an anchor, or use the selected bone to preserve the region’s canvas position. Resize and rotate using canvas handles.</p>
          </section>}
        </aside>
      </main>
      {workspace !== "interaction" && assetLoaded && <TimelineWorkspace mode={workspace} onWorkspaceChange={setWorkspace} source={source} directory={directory} directories={directories} directoryLabels={directoryLabels} directoryInfo={directoryInfo} project={project} initialHandoff={initialTimelineHandoff} initialSubtitlePath={pendingSubtitlePath} onSubtitleOpened={() => setPendingSubtitlePath(null)} initialAudioPaths={pendingAudioPaths} onAudioOpened={() => setPendingAudioPaths(null)} onRecentFile={recordRecentFile} onMutate={mutate} onLive={live} onBeginEdit={beginTimelineEdit} onBeginCameraEdit={beginCameraEdit} onEndCameraEdit={endCameraEdit} onCancelCameraEdit={cancelCameraEdit} onSave={() => saveProject()} onRegisterSave={(callback) => { timelineSaveRef.current = callback; }} onStatus={setStatus} onError={setError} onRegisterMcp={registerMcpTimeline} onMcpSnapshot={publishTimelineMcpSnapshot} onAudioWaveformProfile={__EDITOR_WAVEFORM_PROFILE__ ? (clipId: string, measurement: AudioWaveformMeasurement) => waveformProfileRef.current?.recordStage(clipId, measurement) : undefined} />}
      <footer className="editor-statusbar">
        <span className={error ? "editor-error" : legacyAspectRatioNotice ? "editor-compatibility-warning" : ""} role={legacyAspectRatioNotice && !error ? "status" : undefined}>{error ?? (legacyAspectRatioNotice ? "Legacy 1:1 camera framing is shown as 16:9. Save to update the project." : status)}</span>
        <span>{directory ? `${displayName(directory)} · ${files?.size ?? 0} files` : "No asset loaded"} · {testing ? "TEST MODE" : workspace === "camera" ? "CAMERA" : workspace === "timeline" ? "TIMELINE" : "EDIT MODE"}</span>
        <button className={`editor-version${releaseUpdates.state.status === "available" ? " is-update-available" : ""}`} type="button" aria-label={`About BA Spine Editor, version ${__APP_VERSION__}${releaseUpdates.state.status === "available" ? ", update available" : ""}`} title="About BA Spine Editor" onClick={() => setAboutPage(true)}>
          v{__APP_VERSION__}{releaseUpdates.state.status === "available" && <i aria-hidden="true" />}
        </button>
      </footer>
    </div>
    {aboutPage && <AboutPage
      appName="BA Spine Editor"
      version={__APP_VERSION__}
      update={releaseUpdates.state}
      automaticChecks={releaseUpdates.automaticChecks}
      onAutomaticChecksChange={releaseUpdates.setAutomaticChecks}
      onCheckNow={releaseUpdates.checkNow}
      onSkipLatest={releaseUpdates.skipLatest}
      onShowSkipped={releaseUpdates.showSkipped}
      onBack={closeAboutPage}
      suiteUpdate={suiteUpdates.state}
      onDownloadSuiteUpdate={suiteUpdates.download}
      onInstallSuiteUpdate={suiteUpdates.install}
      canInstallSuiteUpdate={recoveryPrompt === null && saveState !== "dirty" && saveState !== "saving" && saveState !== "error"}
    />}
    </>
  );
}
