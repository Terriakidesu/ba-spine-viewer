import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ContextMenu, type ContextMenuAction, isContextMenuShortcut } from "@ba-spine/app-ui/ContextMenu";
import {
  SpineRenderer,
  type SpineEditorFrame,
  type SpineFiles,
  type SpineLoadProgress,
  type SpineMeta,
  type SpineProgress,
} from "@ba-spine/spine-runtime/spine/spineRuntime";
import { DEFAULT_EFFECTS_STRENGTH } from "@ba-spine/spine-runtime/spine/spineEffects";
import { normalizeSpineLookFollowSettings, type SpineLookFollowSettings } from "@ba-spine/spine-runtime/spine/spineInteraction";
import type { SpineBehaviorDebugMachine } from "@ba-spine/spine-runtime/spine/spineBehaviorRuntime";
import { behaviorMachineWithLegacyInteraction, behaviorMachineWithLookFollowSettings, findLookFollowBehaviorMachine, projectBehaviorMachinesToLegacyInteractions, spineLookFollowSettingsFromBehaviorMachines, synchronizeLegacyBehaviorMachines, type SpineBehaviorEvent } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { spineAudioPathCandidates } from "@ba-spine/spine-runtime/spine/spineAudio";
import { evaluateComposition, evaluateLayerTransforms, validateComposition } from "@ba-spine/spine-runtime/spine/spineComposition";
import { hasLegacySquareCameraAspectRatio } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import {
  blankInteraction,
  blankRegion,
  cloneProject,
  compositionDirectories,
  createTimelineLayer,
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
  type EditorAnimationClip,
  type EditorColorLayer,
  type EditorProject,
  type EditorRegion,
  type EditorSubtitleCue,
  type EditorTimelineLayer,
  type TimelineLayerRole,
  type EditorViewSettings,
} from "./editorModel";
import { normalizeBehaviorGraphLayouts } from "./behaviorGraph";
import { addTalkSequence, deleteAnimationClipRipple, deleteSequence, duplicateAnimationClipRipple, extendTimelineDuration, insertAnimationClipRipple, linkAudioToSubtitle, moveAnimationClipRipple, sequenceIdsForProject, splitCue, switchSequence } from "./sequenceModel";
import { colorClipPreset, deleteColorClip, duplicateColorClip, moveColorClip, trimColorClipEnd, trimColorClipStart, type ColorClipPreset } from "./colorLayerModel";
import { normalizeColorClipFades, timelineLayerAnimationClips } from "@ba-spine/spine-runtime/spine/spineTimeline";
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
import { BehaviorEditor } from "./components/BehaviorEditor";
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
import { isEditorAssetSetReady } from "./editorAssetSet";
import { assertMcpTimelineLocksPreserved, editorDocumentFingerprint, editorDocumentSaveState, editorMcpErrorMessage, type EditorMcpCommand, type EditorMcpState, type EditorMcpTimelineBridge, type EditorMcpTimelineSnapshot } from "./editorMcp";
import { WaveformProfileRecorder } from "./waveformProfileDiagnostics";
import { migrateEditorProjectComposition } from "./editorCompositionMigration";
import type { AudioWaveformMeasurement } from "./AudioWaveform";
import { DEFAULT_EDITOR_LAYOUT_PREFERENCES, EDITOR_LAYOUT_PREFERENCES_KEY, normalizeEditorLayoutPreferences, type WorkspaceLayoutPreset } from "./editorLayout";
import { IconAlert, IconAxis, IconBone, IconCheck, IconChevronDown, IconClose, IconEye, IconEyeOff, IconExpand, IconFile, IconFolder, IconHand, IconHelp, IconLink, IconMenu, IconMessage, IconMore, IconPause, IconPlay, IconPlus, IconSave, IconSearch, IconSliders, IconSound, IconTarget, IconText } from "@ba-spine/app-ui/icons";
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
  lookFollowVisible: boolean;
  onSelectBone: (path: string) => void;
  onSelectRegion: (interactionId: string, regionId: string) => void;
  onRegionContextMenu: (x: number, y: number, interactionId: string, regionId: string, returnFocusTo: HTMLElement | SVGElement | null) => void;
  onBeginRegionDrag: () => void;
  onBeginLookFollowEdit: () => void;
  onChangeLookFollowRange: (axis: "x" | "y", value: number) => void;
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

type InteractionContextTarget =
  | { kind: "canvas" }
  | { kind: "interaction"; interactionId: string }
  | { kind: "region"; interactionId: string; regionId: string };

interface InteractionContextMenuState {
  x: number;
  y: number;
  target: InteractionContextTarget;
  returnFocusTo: HTMLElement | SVGElement | null;
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

function lookFollowGeometry(frame: SpineEditorFrame, settings: SpineLookFollowSettings) {
  const look = frame.lookFollow;
  if (!look) return null;
  const ux = { x: frame.screenUnitXEndX - frame.screenOriginX, y: frame.screenUnitXEndY - frame.screenOriginY };
  const uy = { x: frame.screenUnitYEndX - frame.screenOriginX, y: frame.screenUnitYEndY - frame.screenOriginY };
  const point = (x: number, y: number) => ({
    x: look.centerScreenX + ux.x * look.rangeX * x + uy.x * look.rangeY * y,
    y: look.centerScreenY + ux.y * look.rangeX * x + uy.y * look.rangeY * y,
  });
  const corners = [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)];
  const path = corners.map((item, index) => `${index === 0 ? "M" : "L"} ${item.x} ${item.y}`).join(" ") + " Z";
  const target = frame.bones.find((bone) => bone.path === look.targetBonePath);
  const axis = target
    ? Math.hypot(target.screenEndX - target.screenX, target.screenEndY - target.screenY) > 0.001
      ? { x: target.screenEndX - target.screenX, y: target.screenEndY - target.screenY }
      : { x: target.screenLocalXEndX - target.screenX, y: target.screenLocalXEndY - target.screenY }
    : { x: 1, y: 0 };
  const boneRotation = Math.atan2(axis.y, axis.x) * 180 / Math.PI + look.rotationOffset;
  const rotationRadius = Math.max(18, Math.min(42, Math.max(Math.hypot(ux.x, ux.y) * look.rangeX, Math.hypot(uy.x, uy.y) * look.rangeY) * 0.25));
  return {
    path,
    rotationPath: settings.rotationEnabled
      ? arcPath(look.centerScreenX, look.centerScreenY, rotationRadius, boneRotation - settings.rotationMax, boneRotation - settings.rotationMin)
      : null,
    rotationEnabled: settings.rotationEnabled,
    rotationRadius,
    centerX: look.centerScreenX,
    centerY: look.centerScreenY,
    currentX: look.currentScreenX,
    currentY: look.currentScreenY,
    xHandleX: look.centerScreenX + ux.x * look.rangeX,
    xHandleY: look.centerScreenY + ux.y * look.rangeX,
    yHandleX: look.centerScreenX + uy.x * look.rangeY,
    yHandleY: look.centerScreenY + uy.y * look.rangeY,
    ux,
    uy,
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
  if (Math.abs(endDegrees - startDegrees) >= 359.999) {
    const midpoint = point(startDegrees + (endDegrees - startDegrees) / 2);
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 ${sweep} ${midpoint.x} ${midpoint.y} A ${radius} ${radius} 0 1 ${sweep} ${end.x} ${end.y}`;
  }
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
}

function BoneOverlay({ frame, project, viewSettings, motionLimits, lookFollowVisible, tool, onSelectBone, onSelectRegion, onRegionContextMenu, onBeginRegionDrag, onBeginLookFollowEdit, onChangeLookFollowRange, onDragRegion, onChangeRegion }: BoneOverlayProps) {
  const drag = useRef<{ interactionId: string; regionId: string; startX: number; startY: number; offsetX: number; offsetY: number; frame: SpineEditorFrame } | null>(null);
  const handleDrag = useRef<{ interactionId: string; region: EditorRegion; frame: SpineEditorFrame; kind: "resize" | "rotate" } | null>(null);
  const lookRangeDrag = useRef<"x" | "y" | null>(null);
  if (!frame || !project) return null;
  const bones = frame.bones.filter((bone) => viewSettings.showInactiveBones || bone.active);
  const selectedBone = project.selectedBonePath;
  const regions = viewSettings.showInteractionRegions
    ? project.interactions.flatMap((interaction) => interaction.regions.map((region) => ({ interaction, region })))
    : [];
  const motion = motionLimits && viewSettings.showMotionGizmo ? motionLimitGeometry(frame, motionLimits) : null;
  const look = lookFollowVisible && viewSettings.showLookFollowGizmo ? lookFollowGeometry(frame, project.lookFollow) : null;

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const lookAxis = lookRangeDrag.current;
    const lookFrame = frame.lookFollow;
    if (lookAxis && look && lookFrame) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) * frame.canvasWidth / rect.width - look.centerX;
      const y = (event.clientY - rect.top) * frame.canvasHeight / rect.height - look.centerY;
      const determinant = look.ux.x * look.uy.y - look.uy.x * look.ux.y;
      if (Math.abs(determinant) < 0.0001) return;
      const local = lookAxis === "x"
        ? (x * look.uy.y - look.uy.x * y) / determinant
        : (look.ux.x * y - x * look.ux.y) / determinant;
      onChangeLookFollowRange(lookAxis, Math.min(512, Math.max(0, Math.abs(local))));
      return;
    }
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
      onPointerUp={() => { drag.current = null; handleDrag.current = null; lookRangeDrag.current = null; }}
      onPointerCancel={() => { drag.current = null; handleDrag.current = null; lookRangeDrag.current = null; }}
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
      {look && <g className={`editor-look-follow-gizmo${frame.lookFollow?.active ? " is-active" : ""}${project.lookFollow.enabled ? "" : " is-disabled"}`} aria-label="Look-follow range and rotation gizmo">
        <path className="editor-look-follow-range" d={look.path} />
        {look.rotationPath && <path className="editor-look-follow-rotation" d={look.rotationPath} />}
        <circle className={`editor-look-follow-rotation-handle${look.rotationEnabled ? " is-enabled" : " is-locked"}`} cx={look.centerX} cy={look.centerY} r={5} />
        <text className="editor-look-follow-label rotation" x={look.centerX + look.rotationRadius + 5} y={look.centerY - 5}>R</text>
        <line className="editor-look-follow-vector" x1={look.centerX} y1={look.centerY} x2={look.currentX} y2={look.currentY} />
        <circle className="editor-look-follow-origin" cx={look.centerX} cy={look.centerY} r={5} />
        <circle className="editor-look-follow-current" cx={look.currentX} cy={look.currentY} r={5} />
        <circle
          className="editor-look-follow-handle axis-x"
          cx={look.xHandleX}
          cy={look.xHandleY}
          r={7}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            (event.currentTarget as SVGCircleElement & { setPointerCapture: (pointerId: number) => void }).setPointerCapture(event.pointerId);
            onBeginLookFollowEdit();
            lookRangeDrag.current = "x";
          }}
        />
        <circle
          className="editor-look-follow-handle axis-y"
          cx={look.yHandleX}
          cy={look.yHandleY}
          r={7}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            (event.currentTarget as SVGCircleElement & { setPointerCapture: (pointerId: number) => void }).setPointerCapture(event.pointerId);
            onBeginLookFollowEdit();
            lookRangeDrag.current = "y";
          }}
        />
        <text className="editor-look-follow-label" x={look.xHandleX + 8} y={look.xHandleY}>X</text>
        <text className="editor-look-follow-label" x={look.yHandleX + 8} y={look.yHandleY}>Y</text>
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
          if (event.button !== 0) return;
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
              tabIndex={0}
              role="button"
              aria-haspopup="menu"
              aria-label={`${region.name}, ${interaction.name} hit region`}
              onPointerDown={startDrag}
              onClick={(event) => { event.stopPropagation(); onSelectRegion(interaction.id, region.id); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onRegionContextMenu(event.clientX, event.clientY, interaction.id, region.id, event.currentTarget); }}
              onKeyDown={(event) => { if (!isContextMenuShortcut(event)) return; event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); onRegionContextMenu(bounds.left, bounds.bottom, interaction.id, region.id, event.currentTarget); }}
            />
          : <ellipse
              cx={0}
              cy={0}
              rx={region.radiusX}
              ry={region.radiusY}
              transform={transform}
              vectorEffect="non-scaling-stroke"
              tabIndex={0}
              role="button"
              aria-haspopup="menu"
              aria-label={`${region.name}, ${interaction.name} hit region`}
              onPointerDown={startDrag}
              onClick={(event) => { event.stopPropagation(); onSelectRegion(interaction.id, region.id); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onRegionContextMenu(event.clientX, event.clientY, interaction.id, region.id, event.currentTarget); }}
              onKeyDown={(event) => { if (!isContextMenuShortcut(event)) return; event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); onRegionContextMenu(bounds.left, bounds.bottom, interaction.id, region.id, event.currentTarget); }}
            />;
        return (
          <g key={`${interaction.id}-${region.id}`} className={`editor-region${selected ? " is-selected" : ""}`} style={{ color: interaction.color }}>
            {shape}
            {selected && <text x={geometry.cx} y={geometry.cy}>{region.name}</text>}
            {selected && tool === "select" && (["resize", "rotate"] as const).map((kind) => {
              const localX = kind === "resize" ? region.radiusX : 0;
              const localY = region.radiusY + (kind === "rotate" ? 35 : 0);
              return <circle key={kind} className={`editor-handle ${kind}`} cx={matrix.e + matrix.a * localX + matrix.c * localY} cy={matrix.f + matrix.b * localX + matrix.d * localY} r={7} onPointerDown={(event) => {
                if (event.button !== 0) return;
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
  const lookTestingRef = useRef(false);
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
  const [lookTesting, setLookTesting] = useState(false);
  const [behaviorMode, setBehaviorMode] = useState(false);
  const [tool, setTool] = useState<"select" | "pan" | "draw">("select");
  const [lookSettingsOpen, setLookSettingsOpen] = useState(false);
  const [movementSettingsOpen, setMovementSettingsOpen] = useState(false);
  const [interactionSettingsOpen, setInteractionSettingsOpen] = useState(true);
  lookTestingRef.current = lookTesting;
  const [showTestRegions, setShowTestRegions] = useState(true);
  const [previewDebug, setPreviewDebug] = useState<InteractionPreviewDebug>(() => previewRef.current.debug);
  const [behaviorDebug, setBehaviorDebug] = useState<SpineBehaviorDebugMachine[]>([]);
  const [behaviorActionFeedback, setBehaviorActionFeedback] = useState<Record<string, string>>({});
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
  const [interactionContextMenu, setInteractionContextMenu] = useState<InteractionContextMenuState | null>(null);
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
  const loadedFilesRef = useRef<{ source: DesktopAssetSource; directory: string; files: SpineFiles } | null>(null);
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
  const savedDocumentFingerprintRef = useRef<{ rootPath: string; directory: string; fingerprint: string } | null>(null);
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
  const mcpTimelineAnimationInfoRef = useRef<{ rootPath: string | null; directory: string | null; animationInfo: EditorMcpTimelineSnapshot["animationInfo"] } | null>(null);
  const mcpSnapshotRef = useRef<EditorMcpState | null>(null);
  const mcpPublishTimerRef = useRef<number | null>(null);
  const mcpRuntimeErrorsRef = useRef<Array<{ time: string; message: string }>>([]);
  const saveStateRef = useRef(saveState);
  const cameraEditTransactionRef = useRef<{ project: EditorProject; redo: EditorProject[]; saveState: typeof saveState } | null>(null);
  const saveResultRef = useRef<{ ok: boolean; error: string | null; savedDocumentRevision?: number; writtenPaths?: string[]; verifiedVersions?: Record<string, string> } | null>(null);
  const recoveryPromptRef = useRef<{ rootPath: string; directory: string; current: EditorProject | null; backups: EditorProject[]; savedAt: number; legacyCurrent: boolean; legacyBackups: boolean[] } | null>(null);
  const mcpDocumentFingerprintRef = useRef<string | null>(null);
  const mcpDocumentRevisionRef = useRef(0);
  const mcpChangeSetsRef = useRef(new Map<string, { rootPath: string; directory: string; documentRevision: number; expiresAt: number; operations: EditorMcpCommand[]; project: EditorProject; warnings: string[] }>());

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
    const fingerprint = editorDocumentFingerprint(current);
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
    projectName: project?.name ?? null,
    assetLoading,
    loadProgress: { stage: loadProgress.stage, loaded: loadProgress.loaded, total: loadProgress.total },
    status,
    error,
    saveState,
    animations: meta?.animations ?? [],
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    runtimeErrors: [...mcpRuntimeErrorsRef.current],
    timeline: mcpTimelineSnapshotRef.current,
    waveformProfilingAvailable: __EDITOR_WAVEFORM_PROFILE__,
    behaviorRuntime: {
      debug: [...behaviorDebug],
      feedback: Object.values(behaviorActionFeedback),
      interaction: previewRef.current.debug,
      interactionTesting: testing,
      lookFollowTesting: lookTesting,
    },
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
    if (snapshot) mcpTimelineAnimationInfoRef.current = { rootPath: sourceRef.current?.rootPath ?? null, directory: directoryRef.current || null, animationInfo: snapshot.animationInfo };
    if (mcpSnapshotRef.current) mcpSnapshotRef.current = { ...mcpSnapshotRef.current, timeline: snapshot };
    publishMcpSnapshot();
  }

  function publishTimelineMcpSnapshot(snapshot: EditorMcpTimelineSnapshot | null) {
    mcpTimelineSnapshotRef.current = snapshot;
    if (snapshot) mcpTimelineAnimationInfoRef.current = { rootPath: sourceRef.current?.rootPath ?? null, directory: directoryRef.current || null, animationInfo: snapshot.animationInfo };
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
            catch (value) { error = editorMcpErrorMessage(value); }
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            await publishMcpSnapshotNow();
            await fetch("/__spine/mcp/ui-result", {
              method: "POST",
              headers: { "content-type": "application/json", "x-ba-spine-command-id": item.id },
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
      savedDocumentFingerprintRef.current = {
        rootPath: sourceRef.current?.rootPath ?? "",
        directory: directoryRef.current,
        fingerprint: editorDocumentFingerprint(next),
      };
      projectRef.current = next;
      setProject(next);
      setUndo(repair.repaired ? [loadedProject] : []);
      setRedo([]);
      setStatus(repair.repaired ? `${pending ? "Loaded project; repaired" : "Detected"} ${repair.repaired} head region(s). Custom regions kept.` : repair.unresolved ? "Head detection needs review. Uncertain default patting regions were disabled, not guessed." : pending ? "Loaded saved project." : "Created detected interaction presets.");
    }
  };

  useEffect(() => {
    // Keep the canvas mounted for initial project reconstruction. Once that
    // finishes, hidden workspaces release its bundle and reload it on demand.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new SpineRenderer(canvas, {
      onBeforeEditorUpdate: () => { if (workspaceRef.current === "interaction" && !lookTestingRef.current) previewRef.current.beforeUpdate(); },
      onEditorUpdate: (delta, skeleton, state) => {
        if (!headDetectionDone.current) {
          headRegionRef.current = detectHeadRegion(skeleton);
          headDetectionDone.current = true;
        }
        if (workspaceRef.current !== "interaction" || lookTestingRef.current) return;
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
      onBehaviorDebug: (value) => setBehaviorDebug(value),
      onBehaviorAudio: (machineId, audioId, volume, loop) => {
        const key = `${machineId}:audio:${audioId}`;
        const activeSource = sourceRef.current;
        let live = true;
        let audio: HTMLAudioElement | null = null;
        let objectUrl: string | null = null;
        const cleanup = () => {
          live = false;
          if (audio) {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            audio = null;
          }
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
          setBehaviorActionFeedback((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        };
        setBehaviorActionFeedback((current) => ({ ...current, [key]: `Audio: ${audioId}` }));
        const currentProject = projectRef.current;
        const timelines = [
          ...(currentProject ? [currentProject.timeline] : []),
          ...Object.values(currentProject?.sequences ?? {}),
        ];
        const clip = timelines.flatMap((timeline) => timeline.audio).find((item) => item.id === audioId || item.path === audioId || item.name === audioId);
        const candidates = spineAudioPathCandidates(clip?.path ?? audioId);
        void (async () => {
          if (!activeSource) return;
          let file: File | null = null;
          for (const path of candidates) {
            try {
              file = await activeSource.getFile(path);
              if (file) break;
            } catch {
              // Try the remaining path spellings for this authored audio resource.
            }
          }
          if (!live || !file) return;
          objectUrl = URL.createObjectURL(file);
          audio = new Audio(objectUrl);
          audio.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
          audio.loop = loop;
          audio.onended = () => { if (!loop) cleanup(); };
          audio.onerror = cleanup;
          try { await audio.play(); } catch { cleanup(); }
        })().catch(cleanup);
        return cleanup;
      },
      onBehaviorSubtitle: (machineId, cueId, visible) => {
        const key = `${machineId}:subtitle:${cueId}`;
        if (!visible) {
          setBehaviorActionFeedback((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          return;
        }
        const currentProject = projectRef.current;
        const timelines = [
          ...(currentProject ? [currentProject.timeline] : []),
          ...Object.values(currentProject?.sequences ?? {}),
        ];
        const cue = timelines.flatMap((timeline) => timeline.subtitles).find((item) => item.id === cueId);
        setBehaviorActionFeedback((current) => ({ ...current, [key]: `Subtitle: ${cue?.text.en || cueId}` }));
      },
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
    if (workspace !== "interaction") stopLookFollowTest();
  }, [workspace]);

  useEffect(() => {
    rendererRef.current?.setLookFollowSettings(project?.lookFollow);
  }, [project?.lookFollow]);

  useEffect(() => {
    if (!project) return;
    rendererRef.current?.setBehaviorMachines(synchronizeLegacyBehaviorMachines(project.interactions, project.lookFollow, project.behaviorMachines));
  }, [project?.behaviorMachines, project?.interactions, project?.lookFollow]);

  useEffect(() => {
    if (!behaviorMode) rendererRef.current?.cancelBehaviorTest();
  }, [behaviorMode]);

  useEffect(() => {
    if (!project?.lookFollow.enabled && lookTestingRef.current) stopLookFollowTest();
  }, [project?.lookFollow.enabled]);

  useEffect(() => {
    loadedAssetRef.current = { source: null, directory: "" };
    initializedAssetRef.current = "";
    metaRef.current = null;
    if (!source || !directory) return;
    let cancelled = false;
    const controller = new AbortController();
    setTesting(false);
    stopLookFollowTest();
    previewRef.current.reset();
    rendererRef.current?.clear();
    setAssetLoading(true);
    setLoadProgress({ stage: "files", loaded: 0, total: 0 });
    setFiles(null);
    void source.getSetFiles(directory, controller.signal).then((value) => {
      if (!cancelled) {
        loadedFilesRef.current = { source, directory, files: value };
        setFiles(value);
      }
    }).catch((value) => {
      if (!cancelled) {
        setAssetLoading(false);
        setError(value instanceof Error ? value.message : String(value));
      }
    });
    return () => { cancelled = true; controller.abort(); };
  }, [source, directory]);

  const interactionAssetsRef = useRef<{ files: SpineFiles; suspended: boolean } | null>(null);
  const resumeAnimationRef = useRef(selectedAnimation);
  resumeAnimationRef.current = selectedAnimation;
  useEffect(() => {
    if (!files || !directory) {
      interactionAssetsRef.current = null;
      loadedFilesRef.current = null;
      return;
    }
    const identity = loadedFilesRef.current;
    if (identity?.files !== files || identity.directory !== directory || identity.source !== source) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const resident = interactionAssetsRef.current;
    if (resident?.files !== files) {
      interactionAssetsRef.current = { files, suspended: false };
      loadedAssetRef.current = { source, directory };
      void renderer.load(files, directory);
      renderer.setCameraMode("fit");
    } else if (workspace !== "interaction" && project?.assetDirectory === directory
      && initializedAssetRef.current.startsWith(`${directory}:`) && !resident.suspended) {
      // Initialization still runs in this renderer, but hidden workspaces must
      // not retain another copy of every decoded atlas page and GPU texture.
      resident.suspended = true;
      renderer.releaseAssets();
    } else if (workspace === "interaction" && resident.suspended) {
      resident.suspended = false;
      // Keep the initialized project, recovery state and undo history on resume.
      void renderer.load(files, directory, undefined, { preserveMetadata: true }).then(() => {
        if (interactionAssetsRef.current !== resident || resident.suspended) return;
        const current = projectRef.current;
        if (!current) return;
        if (resumeAnimationRef.current) renderer.setAnimation(resumeAnimationRef.current, true);
        renderer.setLookFollowSettings(current.lookFollow);
        renderer.setBehaviorMachines(synchronizeLegacyBehaviorMachines(current.interactions, current.lookFollow, current.behaviorMachines));
      });
    }
  }, [files, directory, source, workspace, project?.assetDirectory]);

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
    else if (key === "escape") { resetPreview(); setTesting(false); stopLookFollowTest(); setTool("select"); setHelp(false); }
    else if (key === "t") toggleTest();
    else if (key === "v") { setTesting(false); stopLookFollowTest(); setTool("select"); }
    else if (key === "h") { setTesting(false); stopLookFollowTest(); setTool("pan"); }
    else if (key === "r") { setTesting(false); stopLookFollowTest(); setTool("draw"); }
    else if (key === "f") rendererRef.current?.resetCamera();
    else if (key === "b") updateViewSetting("showBones", !(viewSettingsRef.current ?? DEFAULT_EDITOR_VIEW_SETTINGS).showBones);
    else if (key === " ") { event.preventDefault(); if (!testing && !lookTesting) setPlaying((value) => !value); }
    else if (key === "?") setHelp((value) => !value);
    else if ((key === "delete" || key === "backspace") && !testing && projectRef.current?.selectedRegionId) { event.preventDefault(); deleteRegion(); }
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => editorKeydownRef.current(event);
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    const release = () => {
      previewRef.current.release();
      rendererRef.current?.setLookFollowPreviewPointer(null, null);
      testPointerRef.current = null;
      drawRef.current = null;
      setDrawBox(null);
    };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (testPointerRef.current !== event.pointerId) return;
      if (lookTesting) {
        rendererRef.current?.setLookFollowPreviewPointer(event.clientX, event.clientY);
        return;
      }
      if (!testing || !frame) return;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return;
      const point = { x: (event.clientX - rect.left) * frame.canvasWidth / rect.width, y: (event.clientY - rect.top) * frame.canvasHeight / rect.height };
      const world = screenToWorld(frame, point.x, point.y);
      if (world) previewRef.current.move(world.x, world.y);
    };
    const finish = (event: PointerEvent) => {
      if (testPointerRef.current !== event.pointerId) return;
      testPointerRef.current = null;
      if (lookTesting) rendererRef.current?.setLookFollowPreviewPointer(null, null);
      else previewRef.current.release();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [frame, lookTesting, testing]);

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
    savedDocumentFingerprintRef.current = null;
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

  async function changeDirectory(next: string, options: { skipConfirmation?: boolean; throwOnError?: boolean } = {}) {
    if (!next || next === directory) return;
    if (!options.skipConfirmation && !(await confirmOpen())) return;
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
      savedDocumentFingerprintRef.current = null;
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
      const message = editorMcpErrorMessage(value);
      setError(message);
      setAssetLoading(false);
      if (options.throwOnError) throw new Error(message);
    }
  }

  async function waitForAssetSetLoaded(next: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const snapshot = mcpSnapshotRef.current;
      const error = snapshot?.directory === next ? snapshot.error : null;
      if (error) throw new Error(error);
      if (isEditorAssetSetReady({
        directory: snapshot?.directory ?? null,
        projectDirectory: projectRef.current?.assetDirectory ?? null,
        assetLoading: snapshot?.assetLoading ?? true,
        hasMeta: metaRef.current !== null,
        initialized: initializedAssetRef.current.startsWith(`${next}:`),
        error,
      }, next)) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    }
    throw new Error(`Timed out while loading Spine asset set ${next}.`);
  }

  async function waitForWorkspaceMounted(next: "interaction" | "timeline" | "camera") {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (workspaceRef.current === next && (next !== "timeline" || mcpTimelineRef.current !== null)) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error(`The ${next} workspace did not finish mounting.`);
  }

  function synchronizeProjectAuthoring(previous: EditorProject, next: EditorProject): EditorProject {
    const behaviorChanged = JSON.stringify(previous.behaviorMachines) !== JSON.stringify(next.behaviorMachines);
    const interactionsChanged = JSON.stringify(previous.interactions) !== JSON.stringify(next.interactions);
    const lookChanged = JSON.stringify(previous.lookFollow) !== JSON.stringify(next.lookFollow);
    if (behaviorChanged) {
      const lookFollow = normalizeSpineLookFollowSettings(spineLookFollowSettingsFromBehaviorMachines(next.lookFollow, next.behaviorMachines ?? []));
      const nextMachineIds = new Set((next.behaviorMachines ?? []).map((machine) => machine.id));
      const removedInteractionIds = new Set(previous.interactions
        .filter((interaction) => previous.behaviorMachines?.some((machine) => machine.id === interaction.id) && !nextMachineIds.has(interaction.id))
        .map((interaction) => interaction.id));
      const baseInteractions = next.interactions.filter((interaction) => !removedInteractionIds.has(interaction.id));
      const interactions = projectBehaviorMachinesToLegacyInteractions(baseInteractions, next.behaviorMachines ?? []);
      const behaviorMachines = synchronizeLegacyBehaviorMachines(interactions, lookFollow, next.behaviorMachines);
      const selectedInteractionId = interactions.some((interaction) => interaction.id === next.selectedInteractionId)
        ? next.selectedInteractionId
        : interactions[0]?.id ?? null;
      const selectedInteraction = interactions.find((interaction) => interaction.id === selectedInteractionId);
      return {
        ...next,
        lookFollow: normalizeSpineLookFollowSettings(spineLookFollowSettingsFromBehaviorMachines(lookFollow, behaviorMachines)),
        interactions: projectBehaviorMachinesToLegacyInteractions(interactions, behaviorMachines),
        behaviorMachines,
        selectedInteractionId,
        selectedRegionId: selectedInteraction?.regions.some((region) => region.id === next.selectedRegionId)
          ? next.selectedRegionId
          : selectedInteraction?.regions[0]?.id ?? null,
      };
    }
    if (lookChanged) {
      const machine = findLookFollowBehaviorMachine(next.behaviorMachines ?? []);
      const machines = machine
        ? next.behaviorMachines!.map((item) => item.id === machine.id ? behaviorMachineWithLookFollowSettings(item, next.lookFollow) : item)
        : next.behaviorMachines;
      return { ...next, behaviorMachines: synchronizeLegacyBehaviorMachines(next.interactions, next.lookFollow, machines) };
    }
    if (interactionsChanged) {
      const removedInteractionIds = new Set(previous.interactions
        .filter((interaction) => !next.interactions.some((item) => item.id === interaction.id))
        .map((interaction) => interaction.id));
      const machines = (next.behaviorMachines ?? []).filter((machine) => !removedInteractionIds.has(machine.id)).map((machine) => {
        const interaction = next.interactions.find((item) => item.id === machine.id);
        return interaction && machine.sourceLegacyInteractionId === null
          ? behaviorMachineWithLegacyInteraction(machine, interaction)
          : machine;
      });
      return { ...next, behaviorMachines: synchronizeLegacyBehaviorMachines(next.interactions, next.lookFollow, machines) };
    }
    return next;
  }

  function mutate(mutator: (current: EditorProject) => EditorProject) {
    const current = projectRef.current;
    if (!current) return;
    const next = synchronizeProjectAuthoring(current, mutator(cloneProject(current)));
    setUndo((items) => [...items.slice(-49), current]);
    setRedo([]);
    projectRef.current = next;
    setProject(next);
    updateSaveStateForDocumentChange(current, next);
  }

  function live(mutator: (current: EditorProject) => EditorProject) {
    const current = projectRef.current;
    if (!current) return;
    const next = synchronizeProjectAuthoring(current, mutator(cloneProject(current)));
    projectRef.current = next;
    setProject(next);
    updateSaveStateForDocumentChange(current, next);
  }

  function updateSaveStateForDocumentChange(previous: EditorProject, next: EditorProject) {
    const previousFingerprint = editorDocumentFingerprint(previous);
    const nextFingerprint = editorDocumentFingerprint(next);
    if (previousFingerprint === nextFingerprint) return;
    const baseline = savedDocumentFingerprintRef.current;
    if (!baseline || baseline.rootPath !== sourceRef.current?.rootPath || baseline.directory !== directoryRef.current) return;
    const nextState = editorDocumentSaveState(next, baseline.fingerprint);
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }

  function updateProjectSelection(mutator: (current: EditorProject) => EditorProject) {
    const current = projectRef.current;
    if (!current) return;
    const next = mutator(cloneProject(current));
    projectRef.current = next;
    setProject(next);
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
    updateSaveStateForDocumentChange(current, next);
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
    updateSaveStateForDocumentChange(current, applied);
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
        const savedFingerprint = editorDocumentFingerprint(latest);
        savedDocumentFingerprintRef.current = { rootPath: saveSource.rootPath, directory: saveDirectory, fingerprint: savedFingerprint };
        const currentProject = projectRef.current;
        const unchangedSinceSave = currentProject !== null && editorDocumentFingerprint(currentProject) === savedFingerprint;
        saveStateRef.current = unchangedSinceSave ? "saved" : "dirty";
        setSaveState(saveStateRef.current);
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

  function updateMcpProjectSequence(projectValue: EditorProject, sequenceId: string, update: (timeline: EditorProject["timeline"]) => EditorProject["timeline"]): EditorProject {
    const activeId = projectValue.timeline.sequenceId ?? "legacy";
    if (activeId === sequenceId) return { ...projectValue, timeline: update(projectValue.timeline) };
    const cached = projectValue.sequences?.[sequenceId];
    if (cached) return { ...projectValue, sequences: { ...(projectValue.sequences ?? {}), [sequenceId]: update(cached) } };
    const loadedMeta = metaRef.current;
    if (!loadedMeta || !sequenceIdsForProject(projectValue, loadedMeta.animations).includes(sequenceId)) throw new Error(`Sequence not found: ${sequenceId}`);
    const switched = switchSequence(projectValue, sequenceId, loadedMeta.animations, directories);
    return { ...projectValue, sequences: { ...(switched.sequences ?? {}), [sequenceId]: update(switched.timeline) } };
  }

  function executeWorkspaceIndependentTimelineEdit(command: EditorMcpCommand): unknown | undefined {
    const current = projectRef.current;
    if (!current) throw new Error("Load a project before editing timeline data.");
    const timeline = current.timeline;
    const sequenceId = timeline.sequenceId ?? "legacy";
    const commit = (next: EditorProject["timeline"]) => {
      if (next !== timeline) mutate((value) => updateMcpProjectSequence(value, sequenceId, () => next));
    };
    const selection = (next: EditorProject["timeline"]) => {
      if (next !== timeline) updateProjectSelection((value) => updateMcpProjectSequence(value, sequenceId, () => next));
    };
    const infoForLayer = (layer: EditorTimelineLayer) => {
      const snapshot = mcpTimelineSnapshotRef.current;
      if (snapshot && (snapshot.sequence.sequenceId ?? "legacy") === sequenceId) {
        const found = snapshot.animationInfo.find((item) => item.layerId === layer.id);
        if (found) return found;
      }
      const cached = mcpTimelineAnimationInfoRef.current;
      if (cached?.rootPath === (sourceRef.current?.rootPath ?? null) && cached.directory === (directoryRef.current || null)) return cached.animationInfo.find((item) => item.layerId === layer.id);
      return undefined;
    };
    const animationsForLayer = (layer: EditorTimelineLayer): string[] | null => {
      if (layer.directory === directoryRef.current && metaRef.current) return metaRef.current.animations;
      const info = infoForLayer(layer);
      return info ? info.animations.map((item) => item.name) : null;
    };
    const clipsForLayer = (layer: EditorTimelineLayer): EditorAnimationClip[] => {
      if (Array.isArray(layer.animationClips)) return layer.animationClips;
      const meta = layer.directory === directoryRef.current ? metaRef.current : null;
      if (meta) {
        const info = infoForLayer(layer);
        const introDuration = meta.introAnimation ? info?.animations.find((item) => item.name === meta.introAnimation)?.duration ?? 0 : 0;
        return timelineLayerAnimationClips(layer, meta, sequenceId, timeline.openingMode ?? "direct", introDuration) as EditorAnimationClip[];
      }
      if (!layer.animation) return [];
      return [{
        id: sequenceId === "opening" && layer.role === "character" ? `${layer.id}-legacy-opening` : `${layer.id}-legacy`,
        animation: layer.animation,
        start: layer.start,
        end: Math.max(layer.start + 0.01, layer.end),
        endMode: layer.endMode,
        animationOffset: layer.animationOffset,
        loop: layer.loop,
      }];
    };
    const findAnimation = (clipId: string) => {
      for (const layer of timeline.layers) {
        const clip = clipsForLayer(layer).find((item) => item.id === clipId);
        if (clip) return { layer, clip };
      }
      return null;
    };
    const findColor = (clipId: string) => {
      for (const layer of timeline.colorLayers) {
        const clip = layer.clips.find((item) => item.id === clipId);
        if (clip) return { layer, clip };
      }
      return null;
    };

    switch (command.name) {
      case "select_visual": {
        if (command.kind === "spine-layer") {
          if (!timeline.layers.some((item) => item.id === command.id)) throw new Error(`Spine layer not found: ${command.id}`);
          selection({ ...timeline, selectedLayerId: command.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null });
        } else if (command.kind === "color-layer") {
          if (!timeline.colorLayers.some((item) => item.id === command.id)) throw new Error(`Color layer not found: ${command.id}`);
          selection({ ...timeline, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: command.id, selectedColorClipId: null });
        } else {
          const found = findColor(command.id);
          if (!found) throw new Error(`Color clip not found: ${command.id}`);
          selection({ ...timeline, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: command.id });
        }
        return { kind: command.kind, id: command.id, selected: true };
      }
      case "update_spine_layer": {
        const layer = timeline.layers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Spine layer not found: ${command.layerId}`);
        if (layer.locked && Object.keys(command.patch).some((key) => key !== "locked" && key !== "enabled")) throw new Error("The Spine layer is locked.");
        if (command.patch.animation) {
          const available = animationsForLayer(layer);
          if (!available) throw new Error(`Animation metadata for layer ${layer.name} is not loaded. Open the Timeline workspace before changing its animation.`);
          if (!available.includes(command.patch.animation)) throw new Error(`Animation ${command.patch.animation} is not available on layer ${layer.name}.`);
        }
        if (command.patch.faceAnimation) {
          const available = animationsForLayer(layer);
          if (!available) throw new Error(`Animation metadata for layer ${layer.name} is not loaded. Open the Timeline workspace before changing its secondary animation.`);
          if (!available.includes(command.patch.faceAnimation)) throw new Error(`Secondary animation ${command.patch.faceAnimation} is not available on layer ${layer.name}.`);
        }
        const start = command.patch.start ?? layer.start;
        const end = command.patch.end ?? layer.end;
        if (end < start + 0.01) throw new Error("Spine layer end must be at least 0.01 seconds after its start.");
        const patch = { ...command.patch, ...(command.patch.end !== undefined && command.patch.endMode === undefined ? { endMode: "manual" as const } : {}) };
        const layers = timeline.layers.map((item) => item.id === layer.id ? { ...item, ...patch } : item);
        commit({ ...timeline, layers, duration: Math.max(timeline.duration, end), ...(sequenceId === "opening" && layer.role === "character" && command.patch.start !== undefined && timeline.openingMode === "scene-first" ? { sceneDuration: start } : {}) });
        return { layerId: layer.id, updated: Object.keys(patch) };
      }
      case "create_spine_layer": {
        if (!directories.includes(command.directory)) throw new Error(`Spine layer asset set not found: ${command.directory}`);
        if (timeline.layers.some((item) => item.directory === command.directory)) throw new Error(`Spine layer asset set already exists in this sequence: ${command.directory}`);
        const composition = compositionDirectories(directoryRef.current, directories);
        const role: TimelineLayerRole = composition.find((item) => item.directory === command.directory)?.role
          ?? (/_scene$/i.test(command.directory) ? "scene" : /_bg$/i.test(command.directory) ? "background" : "overlay");
        const layer = createTimelineLayer(command.directory, role, Math.max(-1, ...timeline.layers.map((item) => item.order), ...timeline.colorLayers.map((item) => item.order)) + 1, timeline.duration);
        commit({ ...timeline, layers: [...timeline.layers, layer], selectedLayerId: layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null });
        return { layerId: layer.id, directory: layer.directory, role };
      }
      case "delete_spine_layer": {
        const layer = timeline.layers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Spine layer not found: ${command.layerId}`);
        if (layer.role === "character") throw new Error("The main character layer cannot be deleted.");
        if (layer.locked) throw new Error("The Spine layer is locked.");
        const layers = timeline.layers.filter((item) => item.id !== layer.id);
        const selectedLayerId = timeline.selectedLayerId === layer.id ? layers.at(-1)?.id ?? null : timeline.selectedLayerId;
        commit({ ...timeline, layers, selectedLayerId });
        return { layerId: layer.id, deleted: true, nextSelectedLayerId: selectedLayerId };
      }
      case "add_animation_clip": {
        const layer = timeline.layers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Spine layer not found: ${command.layerId}`);
        if (layer.locked) throw new Error("The Spine layer is locked.");
        const available = animationsForLayer(layer);
        if (!available) throw new Error(`Animation metadata for layer ${layer.name} is not loaded. Open the Timeline workspace to load this layer before authoring its clips.`);
        if (!available.includes(command.animation)) throw new Error(`Animation ${command.animation} is not available on layer ${layer.name}.`);
        if (command.faceAnimation && !available.includes(command.faceAnimation)) throw new Error(`Secondary animation ${command.faceAnimation} is not available on layer ${layer.name}.`);
        const duration = infoForLayer(layer)?.animations.find((item) => item.name === command.animation)?.duration ?? null;
        const start = command.start;
        const end = command.end ?? start + Math.max(0.01, duration && duration > 0 ? duration : 2);
        if (end < start + 0.01) throw new Error("Animation clip end must be at least 0.01 seconds after its start.");
        const clip: EditorAnimationClip = {
          id: `animation-${crypto.randomUUID()}`, animation: command.animation, start, end,
          endMode: command.end === undefined ? "auto" : "manual", animationOffset: 0, loop: command.loop ?? false, enabled: true,
          ...(command.faceAnimation == null ? {} : { faceAnimation: command.faceAnimation }),
          ...(command.continueAfterOpening === undefined ? {} : { continueAfterOpening: command.continueAfterOpening }),
        };
        const clips = insertAnimationClipRipple(clipsForLayer(layer), clip);
        const layers = timeline.layers.map((item) => item.id === layer.id ? { ...item, animationClips: clips } : item);
        const next = extendTimelineDuration({ ...timeline, layers, selectedLayerId: layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null, duration: Math.max(timeline.duration, ...clips.map((item) => item.end)) });
        commit(next);
        return { clipId: clip.id, layerId: layer.id, start: clip.start, end: clip.end, endMode: clip.endMode, animationDuration: duration };
      }
      case "duplicate_animation_clip": {
        const found = findAnimation(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        const id = `animation-${crypto.randomUUID()}`;
        const clips = duplicateAnimationClipRipple(clipsForLayer(found.layer), command.clipId, id);
        commit(extendTimelineDuration({ ...timeline, layers: timeline.layers.map((layer) => layer.id === found.layer.id ? { ...layer, animationClips: clips } : layer), selectedLayerId: found.layer.id, selectedCueId: null, selectedColorLayerId: null, selectedColorClipId: null, duration: Math.max(timeline.duration, ...clips.map((item) => item.end)) }));
        return { sourceClipId: command.clipId, clipId: id, layerId: found.layer.id };
      }
      case "update_animation_clip": {
        const found = findAnimation(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        const available = animationsForLayer(found.layer);
        const animation = command.patch.animation ?? found.clip.animation;
        if (!available) throw new Error(`Animation metadata for layer ${found.layer.name} is not loaded. Open the Timeline workspace before editing this clip.`);
        if (!available.includes(animation)) throw new Error(`Animation ${animation} is not available on layer ${found.layer.name}.`);
        if (command.patch.faceAnimation && !available.includes(command.patch.faceAnimation)) throw new Error(`Secondary animation ${command.patch.faceAnimation} is not available on layer ${found.layer.name}.`);
        const start = command.patch.start ?? found.clip.start;
        const end = command.patch.end ?? found.clip.end;
        if (end < start + 0.01) throw new Error("Animation clip end must be at least 0.01 seconds after its start.");
        const { faceAnimation, ...fields } = command.patch;
        const patch: Partial<EditorAnimationClip> = { ...fields, ...(faceAnimation === null ? { faceAnimation: undefined } : faceAnimation === undefined ? {} : { faceAnimation }) };
        if (command.patch.end !== undefined && command.patch.endMode === undefined) patch.endMode = "manual";
        const duration = infoForLayer(found.layer)?.animations.find((item) => item.name === animation)?.duration ?? null;
        if (command.patch.animation && command.patch.animation !== found.clip.animation && command.patch.end === undefined && (command.patch.endMode ?? found.clip.endMode) !== "manual" && duration && duration > 0) {
          patch.end = start + Math.max(0.01, duration - (command.patch.animationOffset ?? found.clip.animationOffset));
        }
        const clips = clipsForLayer(found.layer).map((item) => item.id === command.clipId ? { ...item, ...patch } : item);
        const next = extendTimelineDuration({ ...timeline, layers: timeline.layers.map((layer) => layer.id === found.layer.id ? { ...layer, animationClips: clips } : layer), duration: Math.max(timeline.duration, ...clips.map((item) => item.end)) });
        commit(next);
        return { clipId: command.clipId, layerId: found.layer.id, updated: Object.keys(command.patch) };
      }
      case "move_animation_clip":
      case "delete_animation_clip": {
        const found = findAnimation(command.clipId);
        if (!found) throw new Error(`Animation clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The Spine layer is locked.");
        const currentClips = clipsForLayer(found.layer);
        const clips = command.name === "move_animation_clip"
          ? command.ripple
            ? moveAnimationClipRipple(currentClips, command.clipId, command.start, timeline.snap)
            : currentClips.map((item) => item.id === command.clipId ? { ...item, start: command.start, end: command.start + Math.max(0.01, found.clip.end - found.clip.start) } : item)
          : command.ripple ? deleteAnimationClipRipple(currentClips, command.clipId) : currentClips.filter((item) => item.id !== command.clipId);
        commit(extendTimelineDuration({ ...timeline, layers: timeline.layers.map((layer) => layer.id === found.layer.id ? { ...layer, animationClips: clips } : layer), duration: Math.max(timeline.duration, ...clips.map((item) => item.end)) }));
        return command.name === "move_animation_clip"
          ? { clipId: command.clipId, layerId: found.layer.id, start: command.start, ripple: command.ripple }
          : { clipId: command.clipId, layerId: found.layer.id, ripple: command.ripple, deleted: true };
      }
      case "add_subtitle_cue": {
        const cue: EditorSubtitleCue = { id: `subtitle-${crypto.randomUUID()}`, start: command.start, end: command.end, enabled: true, text: { en: command.text.en ?? "", ja: command.text.ja ?? "", ko: command.text.ko ?? "" } };
        commit(extendTimelineDuration({ ...timeline, subtitles: [...timeline.subtitles, cue], selectedCueId: cue.id, selectedLayerId: null, selectedColorLayerId: null, selectedColorClipId: null }));
        return { cueId: cue.id };
      }
      case "update_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        const start = command.patch.start ?? cue.start;
        const end = command.patch.end ?? cue.end;
        if (end < start + 0.01) throw new Error("Subtitle cue end must be at least 0.01 seconds after its start.");
        const { text, ...fields } = command.patch;
        commit(extendTimelineDuration({ ...timeline, subtitles: timeline.subtitles.map((item) => item.id === cue.id ? { ...item, ...fields, ...(text ? { text: { ...cue.text, ...text } } : {}) } : item) }));
        return { cueId: cue.id, updated: Object.keys(command.patch) };
      }
      case "delete_subtitle_cue": {
        if (!timeline.subtitles.some((item) => item.id === command.cueId)) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        const cleared = timeline.audio.filter((item) => item.subtitleId === command.cueId).length;
        commit({ ...timeline, subtitles: timeline.subtitles.filter((item) => item.id !== command.cueId), audio: timeline.audio.map((item) => item.subtitleId === command.cueId ? { ...item, subtitleId: null } : item), selectedCueId: timeline.selectedCueId === command.cueId ? null : timeline.selectedCueId });
        return { cueId: command.cueId, explicitAudioLinksCleared: cleared };
      }
      case "duplicate_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        const id = `subtitle-${crypto.randomUUID()}`;
        const copy = { ...cue, id, start: cue.end, end: cue.end + Math.max(0.01, cue.end - cue.start), text: { ...cue.text } };
        commit(extendTimelineDuration({ ...timeline, subtitles: [...timeline.subtitles, copy], selectedCueId: id }));
        return { sourceCueId: cue.id, cueId: id };
      }
      case "select_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        selection({ ...timeline, selectedLayerId: null, selectedCueId: cue.id, selectedColorLayerId: null, selectedColorClipId: null });
        return { cueId: cue.id, selected: true };
      }
      case "split_subtitle_cue": {
        const cue = timeline.subtitles.find((item) => item.id === command.cueId);
        if (!cue) throw new Error(`Subtitle cue not found: ${command.cueId}`);
        if (command.at <= cue.start || command.at >= cue.end) throw new Error("Subtitle split time must be strictly inside the cue.");
        const secondCueId = `subtitle-${crypto.randomUUID()}`;
        commit({ ...splitCue(timeline, cue.id, command.at, secondCueId), selectedCueId: secondCueId });
        return { cueId: cue.id, secondCueId, splitAt: command.at };
      }
      case "reorder_visual_layer": {
        const tracks = [...timeline.layers.map((layer) => ({ id: layer.id, kind: "spine" as const, order: layer.order, locked: Boolean(layer.locked) })), ...timeline.colorLayers.map((layer) => ({ id: layer.id, kind: "color" as const, order: layer.order, locked: layer.locked }))].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const sourceIndex = tracks.findIndex((item) => item.id === command.layerId);
        const targetIndex = tracks.findIndex((item) => item.id === command.targetLayerId);
        if (sourceIndex < 0 || targetIndex < 0) throw new Error("Both visual layer IDs must exist in the active sequence.");
        const [start, end] = [Math.min(sourceIndex, targetIndex), Math.max(sourceIndex, targetIndex)];
        if (tracks.slice(start, end + 1).some((item) => item.locked)) throw new Error("A visual layer in the requested reorder range is locked.");
        const [moved] = tracks.splice(sourceIndex, 1);
        tracks.splice(targetIndex, 0, moved!);
        const orders = new Map(tracks.map((item, index) => [item.id, index]));
        commit({ ...timeline, layers: timeline.layers.map((item) => ({ ...item, order: orders.get(item.id) ?? item.order })), colorLayers: timeline.colorLayers.map((item) => ({ ...item, order: orders.get(item.id) ?? item.order })) });
        return { moved: command.layerId, target: command.targetLayerId };
      }
      case "add_color_layer": {
        if (sequenceId !== "opening") throw new Error("Color layers can only be added to the Opening sequence.");
        const layer: EditorColorLayer = { id: `color-layer-${crypto.randomUUID()}`, name: command.nameHint?.trim() || `Color ${timeline.colorLayers.length + 1}`, enabled: true, locked: false, opacity: 1, order: Math.max(-1, ...timeline.layers.map((item) => item.order), ...timeline.colorLayers.map((item) => item.order)) + 1, blendMode: "normal", clips: [] };
        commit({ ...timeline, colorLayers: [...timeline.colorLayers, layer], selectedLayerId: null, selectedCueId: null, selectedColorLayerId: layer.id, selectedColorClipId: null });
        return { layerId: layer.id };
      }
      case "add_color_clip": {
        if (sequenceId !== "opening") throw new Error("Color clips can only be added to the Opening sequence.");
        const requested = command.layerId ? timeline.colorLayers.find((item) => item.id === command.layerId) : undefined;
        if (command.layerId && (!requested || requested.locked)) throw new Error("Choose an existing unlocked color layer.");
        let layer = requested ?? timeline.colorLayers.find((item) => item.id === timeline.selectedColorLayerId && !item.locked) ?? [...timeline.colorLayers].reverse().find((item) => !item.locked);
        const createLayer = !layer;
        if (!layer) layer = { id: `color-layer-${crypto.randomUUID()}`, name: `Color ${timeline.colorLayers.length + 1}`, enabled: true, locked: false, opacity: 1, order: Math.max(-1, ...timeline.layers.map((item) => item.order), ...timeline.colorLayers.map((item) => item.order)) + 1, blendMode: "normal", clips: [] };
        const clipId = `color-clip-${crypto.randomUUID()}`;
        const playhead = mcpTimelineSnapshotRef.current?.sequence.sequenceId === sequenceId ? mcpTimelineSnapshotRef.current.currentTime : 0;
        const start = timeline.snap > 0 ? Math.max(0, Number((Math.round(playhead / timeline.snap) * timeline.snap).toFixed(3))) : Math.max(0, playhead);
        const clip = colorClipPreset(clipId, command.preset ?? "solid" as ColorClipPreset, start);
        const clips = moveColorClip([...layer.clips, clip], clip.id, clip.start);
        const colorLayers = createLayer ? [...timeline.colorLayers, { ...layer, clips }] : timeline.colorLayers.map((item) => item.id === layer!.id ? { ...item, clips } : item);
        commit(extendTimelineDuration({ ...timeline, colorLayers, selectedLayerId: null, selectedCueId: null, selectedColorLayerId: layer.id, selectedColorClipId: clipId }));
        return { layerId: layer.id, clipId };
      }
      case "duplicate_color_clip": {
        const found = findColor(command.clipId);
        if (!found) throw new Error(`Color clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The color layer is locked.");
        const clipId = `color-clip-${crypto.randomUUID()}`;
        const clips = duplicateColorClip(found.layer.clips, found.clip.id, clipId);
        commit(extendTimelineDuration({ ...timeline, colorLayers: timeline.colorLayers.map((item) => item.id === found.layer.id ? { ...item, clips } : item), selectedLayerId: null, selectedCueId: null, selectedColorLayerId: found.layer.id, selectedColorClipId: clipId }));
        return { sourceClipId: found.clip.id, clipId, layerId: found.layer.id };
      }
      case "delete_color_clip": {
        const found = findColor(command.clipId);
        if (!found) throw new Error(`Color clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The color layer is locked.");
        commit({ ...timeline, colorLayers: timeline.colorLayers.map((item) => item.id === found.layer.id ? { ...item, clips: deleteColorClip(item.clips, found.clip.id) } : item), selectedColorClipId: timeline.selectedColorClipId === found.clip.id ? null : timeline.selectedColorClipId });
        return { clipId: found.clip.id, layerId: found.layer.id, deleted: true };
      }
      case "delete_color_layer": {
        const layer = timeline.colorLayers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Color layer not found: ${command.layerId}`);
        if (layer.locked) throw new Error("The color layer is locked.");
        commit({ ...timeline, colorLayers: timeline.colorLayers.filter((item) => item.id !== layer.id), selectedColorLayerId: timeline.selectedColorLayerId === layer.id ? null : timeline.selectedColorLayerId, selectedColorClipId: layer.clips.some((clip) => clip.id === timeline.selectedColorClipId) ? null : timeline.selectedColorClipId });
        return { layerId: layer.id, deleted: true };
      }
      case "update_color_layer": {
        const layer = timeline.colorLayers.find((item) => item.id === command.layerId);
        if (!layer) throw new Error(`Color layer not found: ${command.layerId}`);
        if (layer.locked && Object.keys(command.patch).some((key) => key !== "locked" && key !== "enabled")) throw new Error("The color layer is locked.");
        commit({ ...timeline, colorLayers: timeline.colorLayers.map((item) => item.id === layer.id ? { ...item, ...command.patch } : item) });
        return { layerId: layer.id, updated: Object.keys(command.patch) };
      }
      case "update_color_clip": {
        const found = findColor(command.clipId);
        if (!found) throw new Error(`Color clip not found: ${command.clipId}`);
        if (found.layer.locked) throw new Error("The color layer is locked.");
        const { start: requestedStart, end: requestedEnd, ...fields } = command.patch;
        const colorLayers = timeline.colorLayers.map((layer) => {
          if (layer.id !== found.layer.id) return layer;
          let clips = layer.clips;
          if (requestedStart !== undefined) clips = trimColorClipStart(clips, found.clip.id, requestedStart);
          if (requestedEnd !== undefined) clips = trimColorClipEnd(clips, found.clip.id, requestedEnd);
          return { ...layer, clips: clips.map((item) => item.id === found.clip.id ? normalizeColorClipFades({ ...item, ...fields }) : item) };
        });
        commit(extendTimelineDuration({ ...timeline, colorLayers }));
        return { clipId: found.clip.id, updated: Object.keys(command.patch) };
      }
      default:
        return undefined;
    }
  }

  function prepareMcpChangeSet(current: EditorProject, operations: EditorMcpCommand[]): { project: EditorProject; warnings: string[]; diff: Array<{ domain: string; before: unknown; after: unknown }> } {
    let draft = cloneProject(current);
    const warnings: string[] = [];
    const loadedMeta = metaRef.current;
    const assertKnownSequence = (sequenceId: string) => {
      if (!sequenceIdsForProject(draft, loadedMeta?.animations ?? []).includes(sequenceId)) throw new Error(`Sequence not found: ${sequenceId}`);
    };
    for (const operation of operations) {
      let next = draft;
      switch (operation.name) {
        case "add_interaction": {
          if (!loadedMeta) throw new Error("Load a Spine skeleton before adding interactions in a change set.");
          const interaction = blankInteraction(loadedMeta.animations, frame?.bones ?? [], draft.interactions.length);
          next = { ...draft, interactions: [...draft.interactions, interaction], selectedInteractionId: interaction.id, selectedRegionId: interaction.regions[0]?.id ?? null };
          break;
        }
        case "update_interaction": {
          if (!draft.interactions.some((item) => item.id === operation.interactionId)) throw new Error(`Interaction not found: ${operation.interactionId}`);
          next = { ...draft, interactions: draft.interactions.map((item) => item.id === operation.interactionId ? { ...item, ...operation.patch } : item) };
          break;
        }
        case "duplicate_interaction": {
          const source = draft.interactions.find((item) => item.id === operation.interactionId);
          if (!source) throw new Error(`Interaction not found: ${operation.interactionId}`);
          const copy = structuredClone(source);
          copy.id = crypto.randomUUID();
          copy.name = `${copy.name} copy`;
          copy.regions = copy.regions.map((region) => ({ ...region, id: crypto.randomUUID(), placement: "manual" }));
          next = { ...draft, interactions: [...draft.interactions, copy], selectedInteractionId: copy.id, selectedRegionId: copy.regions[0]?.id ?? null };
          break;
        }
        case "delete_interaction": {
          if (!draft.interactions.some((item) => item.id === operation.interactionId)) throw new Error(`Interaction not found: ${operation.interactionId}`);
          const interactions = draft.interactions.filter((item) => item.id !== operation.interactionId);
          next = { ...draft, interactions, selectedInteractionId: interactions[0]?.id ?? null, selectedRegionId: interactions[0]?.regions[0]?.id ?? null };
          break;
        }
        case "add_region": {
          const interaction = draft.interactions.find((item) => item.id === operation.interactionId);
          if (!interaction) throw new Error(`Interaction not found: ${operation.interactionId}`);
          const requestedPath = operation.anchorBonePath === undefined ? draft.selectedBonePath : operation.anchorBonePath;
          const anchor = requestedPath ? frame?.bones.find((bone) => bone.path === requestedPath) : frame?.bones[0];
          if (requestedPath && !anchor) throw new Error(`Bone not found in the loaded skeleton: ${requestedPath}`);
          const region = blankRegion(anchor, interaction.regions.length);
          next = { ...draft, interactions: draft.interactions.map((item) => item.id === interaction.id ? { ...item, regions: [...item.regions, region] } : item), selectedInteractionId: interaction.id, selectedRegionId: region.id };
          break;
        }
        case "update_region": {
          const interaction = draft.interactions.find((item) => item.id === operation.interactionId);
          if (!interaction?.regions.some((item) => item.id === operation.regionId)) throw new Error(`Region not found: ${operation.regionId}`);
          next = { ...draft, interactions: draft.interactions.map((item) => item.id !== interaction.id ? item : { ...item, regions: item.regions.map((region) => region.id === operation.regionId ? { ...region, ...operation.patch } : region) }) };
          break;
        }
        case "duplicate_region": {
          const interaction = draft.interactions.find((item) => item.id === operation.interactionId);
          const region = interaction?.regions.find((item) => item.id === operation.regionId);
          if (!interaction || !region) throw new Error(`Region not found: ${operation.regionId}`);
          const copy = { ...region, id: crypto.randomUUID(), name: `${region.name} copy`, offsetX: region.offsetX + 20, placement: "manual" as const };
          next = { ...draft, interactions: draft.interactions.map((item) => item.id === interaction.id ? { ...item, regions: [...item.regions, copy] } : item), selectedInteractionId: interaction.id, selectedRegionId: copy.id };
          break;
        }
        case "delete_region": {
          const interaction = draft.interactions.find((item) => item.id === operation.interactionId);
          if (!interaction?.regions.some((item) => item.id === operation.regionId)) throw new Error(`Region not found: ${operation.regionId}`);
          next = { ...draft, interactions: draft.interactions.map((item) => item.id === interaction.id ? { ...item, regions: item.regions.filter((region) => region.id !== operation.regionId) } : item), selectedRegionId: draft.selectedRegionId === operation.regionId ? null : draft.selectedRegionId };
          break;
        }
        case "update_look_follow":
          next = { ...draft, lookFollow: { ...draft.lookFollow, ...operation.patch } };
          break;
        case "replace_behavior_machines":
          next = { ...draft, behaviorMachines: operation.machines, ...(operation.graphLayouts ? { behaviorGraphLayouts: operation.graphLayouts } : {}) };
          break;
        case "update_project_settings":
          if (operation.patch.entrySequence) assertKnownSequence(operation.patch.entrySequence);
          next = { ...draft, ...operation.patch };
          break;
        case "create_talk_sequence":
          if (!loadedMeta) throw new Error("Load a Spine skeleton before adding sequences in a change set.");
          next = addTalkSequence(draft, loadedMeta.animations, directories);
          break;
        case "migrate_legacy_composition": {
          if (draft.composition) throw new Error("This project already has a unified composition. Migration does not replace existing composition data.");
          const knownSequenceIds = new Set([draft.timeline.sequenceId ?? "legacy", ...Object.keys(draft.sequences ?? {})]);
          for (const entry of operation.schedule) {
            if (entry.sequenceId && !knownSequenceIds.has(entry.sequenceId)) throw new Error(`Migration schedule references unknown sequence ${entry.sequenceId}.`);
          }
          const migrated = migrateEditorProjectComposition(draft, operation);
          const errors = migrated.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
          if (errors.length > 0) throw new Error(`Composition migration schedule is invalid: ${errors.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
          next = { ...draft, composition: migrated.composition };
          warnings.push(...migrated.report.assumptions.map((assumption) => `Migration assumption: ${assumption}`));
          warnings.push(...migrated.report.diagnostics.filter((item) => item.severity === "warning").map((item) => `${item.code}: ${item.message}`));
          break;
        }
        case "delete_sequence":
          if (!loadedMeta) throw new Error("Load a Spine skeleton before deleting sequences in a change set.");
          assertKnownSequence(operation.sequenceId);
          if (operation.sequenceId === "opening") throw new Error("The Opening sequence cannot be deleted.");
          next = deleteSequence(draft, operation.sequenceId, loadedMeta.animations, directories);
          break;
        case "reorder_sequences": {
          const existing = sequenceIdsForProject(draft, loadedMeta?.animations ?? []);
          if (operation.sequenceIds.length !== existing.length || existing.some((id) => !operation.sequenceIds.includes(id))) throw new Error("Sequence order must include every available sequence exactly once.");
          next = { ...draft, sequenceOrder: operation.sequenceIds };
          break;
        }
        case "replace_sequence":
          assertKnownSequence(operation.sequenceId);
          next = updateMcpProjectSequence(draft, operation.sequenceId, () => ({ ...operation.sequence, sequenceId: operation.sequenceId }));
          break;
        case "update_camera_track":
          assertKnownSequence(operation.sequenceId);
          next = updateMcpProjectSequence(draft, operation.sequenceId, (timeline) => {
            const { camera: _previousCamera, ...rest } = timeline;
            return operation.camera ? { ...rest, camera: operation.camera } : rest;
          });
          break;
        default:
          throw new Error(`The ${operation.name} operation is not supported inside reviewed atomic change sets.`);
      }
      draft = synchronizeProjectAuthoring(draft, next);
      for (const machine of draft.behaviorMachines ?? []) {
        for (const transition of machine.transitions) for (const condition of transition.conditions) {
          if (condition.type !== "machine-state") continue;
          const target = (draft.behaviorMachines ?? []).find((item) => item.id === condition.machineId);
          if (!target?.states.some((state) => state.id === condition.stateId)) throw new Error(`Change set leaves an invalid cross-machine state reference: ${condition.machineId}/${condition.stateId}.`);
        }
      }
    }

    const domainSnapshots = (value: EditorProject) => {
      const authored = cloneProject(value);
      const clearSelection = (timeline: EditorProject["timeline"]) => {
        timeline.selectedLayerId = null;
        timeline.selectedCueId = null;
        timeline.selectedColorLayerId = null;
        timeline.selectedColorClipId = null;
      };
      clearSelection(authored.timeline);
      const sequences = { ...(authored.sequences ?? {}), [authored.timeline.sequenceId ?? "legacy"]: authored.timeline };
      const { timeline: _timeline, sequences: _sequences, ...settings } = authored;
      return {
        settings: { name: settings.name, entrySequence: settings.entrySequence ?? null, talkMixDuration: settings.talkMixDuration, effectsStrength: settings.effectsStrength },
        composition: settings.composition ?? null,
        interactions: authored.interactions,
        lookFollow: authored.lookFollow,
        behaviors: { machines: authored.behaviorMachines ?? [], graphLayouts: authored.behaviorGraphLayouts },
        sequenceOrder: authored.sequenceOrder ?? [],
        sequences: Object.fromEntries(Object.entries(sequences).sort(([left], [right]) => left.localeCompare(right))),
      };
    };
    const before = domainSnapshots(current);
    const after = domainSnapshots(draft);
    const diff = Object.keys(before).flatMap((domain) => JSON.stringify(before[domain as keyof typeof before]) === JSON.stringify(after[domain as keyof typeof after])
      ? []
      : [{ domain, before: before[domain as keyof typeof before], after: after[domain as keyof typeof after] }]);
    if (current.entrySequence && current.entrySequence !== draft.entrySequence && !sequenceIdsForProject(draft, loadedMeta?.animations ?? []).includes(current.entrySequence)) warnings.push(`Entry sequence ${current.entrySequence} was removed; the project model selected ${draft.entrySequence ?? "runtime intro"} instead.`);
    const removedMachineIds = (current.behaviorMachines ?? []).filter((machine) => !(draft.behaviorMachines ?? []).some((candidate) => candidate.id === machine.id)).map((machine) => machine.id);
    if (removedMachineIds.length) warnings.push(`Behavior machines removed by the reviewed changes: ${removedMachineIds.join(", ")}.`);
    if (new TextEncoder().encode(JSON.stringify(diff)).byteLength > 900_000) throw new Error("The proposed change set is too large to return as a reviewable diff. Split it into smaller batches.");
    return { project: draft, warnings, diff };
  }

    mcpCommandRef.current = async (command, expectedDocumentRevision) => {
    if (expectedDocumentRevision !== undefined) {
      const actual = currentMcpDocumentRevision();
      if (actual !== expectedDocumentRevision) throw new Error(`MCP_STALE_DOCUMENT_REVISION: expected document revision ${expectedDocumentRevision}, but the Editor is now at ${actual}. Re-read editor_state and review the change before retrying.`);
    }
    switch (command.name) {
      case "evaluate_composition": {
        const current = projectRef.current;
        if (!current?.composition) throw new Error("This project has no unified composition. Run an explicit legacy migration first.");
        const evaluation = evaluateComposition(current.composition, { compositionTime: command.seconds });
        const transforms = evaluateLayerTransforms(current.composition, evaluation);
        return {
          seconds: command.seconds,
          activeSectionIds: evaluation.activeSectionIds,
          properties: Object.fromEntries(evaluation.properties),
          layerTransforms: Object.fromEntries(transforms),
          activeAnimationClips: evaluation.activeAnimationClips.map(({ clip, sourceTime, weight }) => ({ clipId: clip.id, layerId: clip.layerId, animation: clip.animation, faceAnimation: clip.faceAnimation ?? null, sourceTime, weight })),
          activeAudioIds: evaluation.activeAudio.map((clip) => clip.id),
          activeSubtitleIds: evaluation.activeSubtitles.map((cue) => cue.id),
          activeColorClipIds: evaluation.activeColorClips.map(({ clip }) => clip.id),
          diagnostics: evaluation.diagnostics,
        };
      }
      case "preview_change_set": {
        const current = projectRef.current;
        const currentSource = sourceRef.current;
        const currentDirectory = directoryRef.current;
        if (!current || !currentSource || !currentDirectory) throw new Error("Load a project before preparing an authored change set.");
        const now = Date.now();
        for (const [id, changeSet] of mcpChangeSetsRef.current) if (changeSet.expiresAt <= now) mcpChangeSetsRef.current.delete(id);
        if (mcpChangeSetsRef.current.size >= 20) throw new Error("The Editor already has 20 pending reviewed change sets. Apply or let them expire before previewing another.");
        const prepared = prepareMcpChangeSet(current, command.operations);
        if (prepared.diff.length === 0) throw new Error("The proposed operations do not change authored project data.");
        const changeSetId = crypto.randomUUID();
        const documentRevision = currentMcpDocumentRevision();
        const expiresAt = now + 60_000;
        mcpChangeSetsRef.current.set(changeSetId, {
          rootPath: currentSource.rootPath,
          directory: currentDirectory,
          documentRevision,
          expiresAt,
          operations: command.operations,
          project: prepared.project,
          warnings: prepared.warnings,
        });
        return { changeSetId, projectName: current.name, assetDirectory: currentDirectory, documentRevision, expiresAt: new Date(expiresAt).toISOString(), operationNames: command.operations.map((item) => item.name), diff: prepared.diff, warnings: prepared.warnings };
      }
      case "apply_change_set": {
        const changeSet = mcpChangeSetsRef.current.get(command.changeSetId);
        if (!changeSet) throw new Error("The reviewed change set is missing or expired; preview the changes again.");
        const currentRevision = currentMcpDocumentRevision();
        if (changeSet.expiresAt <= Date.now()) {
          mcpChangeSetsRef.current.delete(command.changeSetId);
          throw new Error("The reviewed change set expired; preview the changes again.");
        }
        if (changeSet.rootPath !== sourceRef.current?.rootPath || changeSet.directory !== directoryRef.current || changeSet.documentRevision !== currentRevision) {
          mcpChangeSetsRef.current.delete(command.changeSetId);
          throw new Error("The Editor host, project, or document revision changed after review. Preview the changes again.");
        }
        mutate(() => changeSet.project);
        mcpChangeSetsRef.current.delete(command.changeSetId);
        return { changeSetId: command.changeSetId, applied: true, beforeDocumentRevision: changeSet.documentRevision, afterDocumentRevision: currentMcpDocumentRevision(), operationNames: changeSet.operations.map((item) => item.name), warnings: changeSet.warnings, saveState: saveStateRef.current };
      }
      case "add_interaction": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before adding an interaction.");
        const interaction = blankInteraction(loadedMeta.animations, frame?.bones ?? [], current.interactions.length);
        mutate((value) => ({ ...value, interactions: [...value.interactions, interaction], selectedInteractionId: interaction.id, selectedRegionId: interaction.regions[0]?.id ?? null }));
        return { interactionId: interaction.id, regionIds: interaction.regions.map((region) => region.id) };
      }
      case "update_interaction": {
        const current = projectRef.current;
        const interaction = current?.interactions.find((item) => item.id === command.interactionId);
        if (!current || !interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id === command.interactionId ? { ...item, ...command.patch } : item) }));
        return { interactionId: command.interactionId, updated: Object.keys(command.patch) };
      }
      case "duplicate_interaction": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        if (!interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        const copy = structuredClone(interaction);
        copy.id = crypto.randomUUID();
        copy.name = `${copy.name} copy`;
        copy.regions = copy.regions.map((region) => ({ ...region, id: crypto.randomUUID(), placement: "manual" }));
        mutate((value) => ({ ...value, interactions: [...value.interactions, copy], selectedInteractionId: copy.id, selectedRegionId: copy.regions[0]?.id ?? null }));
        return { interactionId: copy.id, sourceInteractionId: command.interactionId, regionIds: copy.regions.map((region) => region.id) };
      }
      case "delete_interaction": {
        const current = projectRef.current;
        if (!current?.interactions.some((item) => item.id === command.interactionId)) throw new Error(`Interaction not found: ${command.interactionId}`);
        let nextSelection: string | null = null;
        mutate((value) => {
          const remaining = value.interactions.filter((item) => item.id !== command.interactionId);
          nextSelection = remaining[0]?.id ?? null;
          return { ...value, interactions: remaining, selectedInteractionId: nextSelection, selectedRegionId: remaining[0]?.regions[0]?.id ?? null };
        });
        return { interactionId: command.interactionId, deleted: true, nextSelectedInteractionId: nextSelection };
      }
      case "select_interaction": {
        const current = projectRef.current;
        const interaction = current?.interactions.find((item) => item.id === command.interactionId);
        if (!current || !interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        updateProjectSelection((value) => ({ ...value, selectedInteractionId: interaction.id, selectedRegionId: interaction.regions[0]?.id ?? null }));
        return { interactionId: interaction.id, selectedRegionId: interaction.regions[0]?.id ?? null };
      }
      case "add_region": {
        const current = projectRef.current;
        const interaction = current?.interactions.find((item) => item.id === command.interactionId);
        if (!current || !interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        const requestedPath = command.anchorBonePath === undefined ? current.selectedBonePath : command.anchorBonePath;
        const anchor = requestedPath ? frame?.bones.find((bone) => bone.path === requestedPath) : frame?.bones[0];
        if (requestedPath && !anchor) throw new Error(`Bone not found in the loaded skeleton: ${requestedPath}`);
        const region = blankRegion(anchor, interaction.regions.length);
        mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id === interaction.id ? { ...item, regions: [...item.regions, region] } : item), selectedInteractionId: interaction.id, selectedRegionId: region.id }));
        return { interactionId: interaction.id, regionId: region.id, anchorBone: region.anchorBone };
      }
      case "update_region": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        const region = interaction?.regions.find((item) => item.id === command.regionId);
        if (!interaction || !region) throw new Error(`Region ${command.regionId} was not found in interaction ${command.interactionId}.`);
        mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id !== interaction.id ? item : { ...item, regions: item.regions.map((candidate) => candidate.id === region.id ? { ...candidate, ...command.patch } : candidate) }) }));
        return { interactionId: interaction.id, regionId: region.id, updated: Object.keys(command.patch) };
      }
      case "duplicate_region": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        const region = interaction?.regions.find((item) => item.id === command.regionId);
        if (!interaction || !region) throw new Error(`Region ${command.regionId} was not found in interaction ${command.interactionId}.`);
        const copy = { ...region, id: crypto.randomUUID(), name: `${region.name} copy`, offsetX: region.offsetX + 20, placement: "manual" as const };
        mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id === interaction.id ? { ...item, regions: [...item.regions, copy] } : item), selectedInteractionId: interaction.id, selectedRegionId: copy.id }));
        return { interactionId: interaction.id, regionId: copy.id, sourceRegionId: region.id };
      }
      case "delete_region": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        if (!interaction?.regions.some((item) => item.id === command.regionId)) throw new Error(`Region ${command.regionId} was not found in interaction ${command.interactionId}.`);
        mutate((value) => ({
          ...value,
          interactions: value.interactions.map((item) => item.id === interaction.id ? { ...item, regions: item.regions.filter((region) => region.id !== command.regionId) } : item),
          selectedInteractionId: interaction.id,
          selectedRegionId: value.selectedRegionId === command.regionId ? null : value.selectedRegionId,
        }));
        return { interactionId: interaction.id, regionId: command.regionId, deleted: true };
      }
      case "select_region": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        if (!interaction?.regions.some((item) => item.id === command.regionId)) throw new Error(`Region ${command.regionId} was not found in interaction ${command.interactionId}.`);
        updateProjectSelection((value) => ({ ...value, selectedInteractionId: interaction.id, selectedRegionId: command.regionId }));
        return { interactionId: interaction.id, regionId: command.regionId };
      }
      case "update_look_follow":
        if (!projectRef.current) throw new Error("Load a Spine asset before editing Look-follow settings.");
        mutate((value) => ({ ...value, lookFollow: { ...value.lookFollow, ...command.patch } }));
        return { updated: Object.keys(command.patch) };
      case "replace_behavior_machines": {
        const current = projectRef.current;
        if (!current) throw new Error("Load a Spine asset before editing behavior machines.");
        const priorIds = new Set((current.behaviorMachines ?? []).map((machine) => machine.id));
        mutate((value) => ({
          ...value,
          behaviorMachines: command.machines,
          ...(command.graphLayouts ? { behaviorGraphLayouts: command.graphLayouts } : {}),
        }));
        return { machineIds: command.machines.map((machine) => machine.id), removedMachineIds: [...priorIds].filter((id) => !command.machines.some((machine) => machine.id === id)), graphLayoutsUpdated: command.graphLayouts !== undefined };
      }
      case "create_talk_sequence": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before adding a sequence.");
        const next = addTalkSequence(current, loadedMeta.animations, directories);
        const createdId = next.timeline.sequenceId ?? "";
        mutate(() => next);
        return { sequenceId: createdId, sequenceOrder: next.sequenceOrder ?? [] };
      }
      case "migrate_legacy_composition": {
        const current = projectRef.current;
        if (!current) throw new Error("Load a project before migrating its legacy timelines.");
        if (current.composition) throw new Error("This project already has a unified composition. Migration does not replace existing composition data.");
        const migrated = migrateEditorProjectComposition(current, command);
        const errors = migrated.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) throw new Error(`Composition migration was not applied because the explicit schedule is invalid: ${errors.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
        mutate((value) => ({ ...value, composition: migrated.composition }));
        return {
          compositionId: migrated.composition.id,
          compositionDuration: migrated.composition.duration,
          sectionCount: migrated.composition.sections.length,
          layerCount: migrated.composition.layers.length,
          report: migrated.report,
          applied: true,
          saved: false,
        };
      }
      case "delete_sequence": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before deleting a sequence.");
        if (command.sequenceId === "opening") throw new Error("The Opening sequence cannot be deleted.");
        if (!sequenceIdsForProject(current, loadedMeta.animations).includes(command.sequenceId)) throw new Error(`Sequence not found: ${command.sequenceId}`);
        const next = deleteSequence(current, command.sequenceId, loadedMeta.animations, directories);
        mutate(() => next);
        return { sequenceId: command.sequenceId, deleted: true, activeSequenceId: next.timeline.sequenceId ?? "legacy", sequenceOrder: next.sequenceOrder ?? [] };
      }
      case "reorder_sequences": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before reordering sequences.");
        const existingIds = sequenceIdsForProject(current, loadedMeta.animations);
        if (command.sequenceIds.length !== existingIds.length || existingIds.some((id) => !command.sequenceIds.includes(id))) throw new Error("sequenceIds must contain every available sequence exactly once.");
        if (command.sequenceIds[0] !== "opening") throw new Error("The Opening sequence must remain first.");
        mutate((value) => ({ ...value, sequenceOrder: command.sequenceIds }));
        return { sequenceOrder: command.sequenceIds };
      }
      case "replace_sequence": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before editing a sequence.");
        if (!sequenceIdsForProject(current, loadedMeta.animations).includes(command.sequenceId)) throw new Error(`Sequence not found: ${command.sequenceId}`);
        const previous = current.timeline.sequenceId === command.sequenceId
          ? current.timeline
          : current.sequences?.[command.sequenceId] ?? switchSequence(current, command.sequenceId, loadedMeta.animations, directories).timeline;
        const sequence = { ...command.sequence, sequenceId: command.sequenceId };
        assertMcpTimelineLocksPreserved(previous, sequence);
        mutate((value) => value.timeline.sequenceId === command.sequenceId
          ? { ...value, timeline: sequence }
          : { ...value, sequences: { ...(value.sequences ?? {}), [command.sequenceId]: sequence } });
        return { sequenceId: command.sequenceId, replaced: true, layerCount: sequence.layers.length, audioClipCount: sequence.audio.length, subtitleCueCount: sequence.subtitles.length };
      }
      case "update_camera_track": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta) throw new Error("Load a Spine asset before editing camera tracks.");
        if (!sequenceIdsForProject(current, loadedMeta.animations).includes(command.sequenceId)) throw new Error(`Sequence not found: ${command.sequenceId}`);
        const targetTimeline = current.timeline.sequenceId === command.sequenceId
          ? current.timeline
          : current.sequences?.[command.sequenceId] ?? switchSequence(current, command.sequenceId, loadedMeta.animations, directories).timeline;
        if (command.camera?.referenceLayerId && !targetTimeline.layers.some((layer) => layer.id === command.camera!.referenceLayerId)) throw new Error(`Camera reference layer not found in sequence ${command.sequenceId}: ${command.camera.referenceLayerId}`);
        assertMcpTimelineLocksPreserved(targetTimeline, { ...targetTimeline, ...(command.camera ? { camera: command.camera } : { camera: undefined }) });
        mutate((value) => {
          const update = (timeline: EditorProject["timeline"]) => {
            const { camera: _camera, ...rest } = timeline;
            return command.camera ? { ...rest, camera: command.camera } : rest;
          };
          if (value.timeline.sequenceId === command.sequenceId) return { ...value, timeline: update(value.timeline) };
          const switched = switchSequence(value, command.sequenceId, loadedMeta.animations, directories);
          return { ...value, sequences: { ...(switched.sequences ?? {}), [command.sequenceId]: update(switched.timeline) } };
        });
        return { sequenceId: command.sequenceId, cameraUpdated: command.camera !== null, safeBoundCount: command.camera?.safeBounds.length ?? 0, keyframeCount: command.camera?.keyframes.length ?? 0 };
      }
      case "update_project_settings": {
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current) throw new Error("Load a Spine asset before editing project settings.");
        if (command.patch.entrySequence && !sequenceIdsForProject(current, loadedMeta?.animations ?? []).includes(command.patch.entrySequence)) throw new Error(`Entry sequence not found: ${command.patch.entrySequence}`);
        mutate((value) => ({ ...value, ...command.patch }));
        return { updated: Object.keys(command.patch), entrySequence: command.patch.entrySequence ?? current.entrySequence ?? null };
      }
      case "add_audio_clip": {
        const current = projectRef.current;
        const source = sourceRef.current;
        if (!current || !source) throw new Error("Load an asset root before adding audio.");
        if (!/\.(?:ogg|wav|mp3|m4a|flac|aac|opus)$/i.test(command.audio.path)) throw new Error("Audio path must use a supported audio file extension.");
        if (!(await source.getFile(command.audio.path))) throw new Error(`Audio asset not found inside the selected asset root: ${command.audio.path}`);
        if (command.audio.end < command.audio.start + 0.01) throw new Error("Audio clip end must be at least 0.01 seconds after its start.");
        const target = current.timeline.sequenceId === command.sequenceId ? current.timeline : current.sequences?.[command.sequenceId];
        if (target?.audio.some((clip) => clip.id === command.audio.id)) throw new Error(`Audio clip ID already exists: ${command.audio.id}`);
        if (command.audio.subtitleId && !target?.subtitles.some((cue) => cue.id === command.audio.subtitleId)) throw new Error(`Subtitle cue not found: ${command.audio.subtitleId}`);
        mutate((value) => updateMcpProjectSequence(value, command.sequenceId, (timeline) => {
          const added = extendTimelineDuration({ ...timeline, audio: [...timeline.audio, command.audio] });
          return command.audio.subtitleId ? linkAudioToSubtitle(added, command.audio.id, command.audio.subtitleId) : added;
        }));
        return { sequenceId: command.sequenceId, audioId: command.audio.id, path: command.audio.path };
      }
      case "duplicate_audio_clip": {
        const current = projectRef.current;
        const timeline = current?.timeline.sequenceId === command.sequenceId ? current.timeline : current?.sequences?.[command.sequenceId];
        const clip = timeline?.audio.find((item) => item.id === command.audioId);
        if (!current || !timeline || !clip) throw new Error(`Audio clip not found: ${command.audioId} in sequence ${command.sequenceId}.`);
        const { lineId: _lineId, subtitleId: _subtitleId, ...fields } = clip;
        const id = `audio-${crypto.randomUUID()}`;
        const length = Math.max(0.01, clip.end - clip.start);
        const duplicate = { ...fields, id, start: clip.end, end: clip.end + length };
        mutate((value) => updateMcpProjectSequence(value, command.sequenceId, (sequence) => extendTimelineDuration({ ...sequence, audio: [...sequence.audio, duplicate] })));
        return { sequenceId: command.sequenceId, sourceAudioId: clip.id, audioId: id, start: duplicate.start, end: duplicate.end, subtitleLink: null };
      }
      case "update_audio_clip": {
        const current = projectRef.current;
        const source = sourceRef.current;
        if (!current || !source) throw new Error("Load an asset root before editing audio.");
        const timeline = current.timeline.sequenceId === command.sequenceId ? current.timeline : current.sequences?.[command.sequenceId];
        const clip = timeline?.audio.find((item) => item.id === command.audioId);
        if (!timeline || !clip) throw new Error(`Audio clip not found: ${command.audioId} in sequence ${command.sequenceId}.`);
        if (command.patch.path !== undefined) {
          if (!/\.(?:ogg|wav|mp3|m4a|flac|aac|opus)$/i.test(command.patch.path)) throw new Error("Audio path must use a supported audio file extension.");
          if (!(await source.getFile(command.patch.path))) throw new Error(`Audio asset not found inside the selected asset root: ${command.patch.path}`);
        }
        const start = command.patch.start ?? clip.start;
        const end = command.patch.end ?? clip.end;
        if (end < start + 0.01) throw new Error("Audio clip end must be at least 0.01 seconds after its start.");
        mutate((value) => updateMcpProjectSequence(value, command.sequenceId, (sequence) => extendTimelineDuration({ ...sequence, audio: sequence.audio.map((item) => item.id === clip.id ? { ...item, ...command.patch } : item) })));
        return { sequenceId: command.sequenceId, audioId: clip.id, updated: Object.keys(command.patch) };
      }
      case "delete_audio_clip": {
        const current = projectRef.current;
        const timeline = current?.timeline.sequenceId === command.sequenceId ? current.timeline : current?.sequences?.[command.sequenceId];
        if (!current || !timeline?.audio.some((item) => item.id === command.audioId)) throw new Error(`Audio clip not found: ${command.audioId} in sequence ${command.sequenceId}.`);
        mutate((value) => updateMcpProjectSequence(value, command.sequenceId, (sequence) => ({ ...sequence, audio: sequence.audio.filter((item) => item.id !== command.audioId) })));
        return { sequenceId: command.sequenceId, audioId: command.audioId, deleted: true };
      }
      case "link_audio_subtitle": {
        const current = projectRef.current;
        const timeline = current?.timeline.sequenceId === command.sequenceId ? current.timeline : current?.sequences?.[command.sequenceId];
        if (!current || !timeline?.audio.some((item) => item.id === command.audioId)) throw new Error(`Audio clip not found: ${command.audioId} in sequence ${command.sequenceId}.`);
        if (command.subtitleId !== null && !timeline.subtitles.some((cue) => cue.id === command.subtitleId)) throw new Error(`Subtitle cue not found: ${command.subtitleId}`);
        mutate((value) => updateMcpProjectSequence(value, command.sequenceId, (sequence) => linkAudioToSubtitle(sequence, command.audioId, command.subtitleId)));
        return { sequenceId: command.sequenceId, audioId: command.audioId, subtitleId: command.subtitleId };
      }
      case "set_timeline_items_enabled":
      case "delete_timeline_items": {
        const current = projectRef.current;
        if (!current) throw new Error("Load a project before editing timeline items.");
        const timeline = current.timeline;
        const selected = new Set(command.items.map((item) => `${item.kind}:${item.id}`));
        const cachedAnimationInfo = mcpTimelineAnimationInfoRef.current?.rootPath === (sourceRef.current?.rootPath ?? null)
          && mcpTimelineAnimationInfoRef.current.directory === (directoryRef.current || null)
          ? mcpTimelineAnimationInfoRef.current.animationInfo
          : [];
        const getClips = (layer: EditorTimelineLayer): EditorAnimationClip[] => {
          if (Array.isArray(layer.animationClips)) return layer.animationClips;
          const meta = layer.directory === directoryRef.current ? metaRef.current : null;
          const info = cachedAnimationInfo.find((item) => item.layerId === layer.id);
          const introDuration = meta?.introAnimation ? info?.animations.find((item) => item.name === meta.introAnimation)?.duration ?? 0 : 0;
          return timelineLayerAnimationClips(layer, meta, timeline.sequenceId ?? "legacy", timeline.openingMode ?? "direct", introDuration) as EditorAnimationClip[];
        };
        const allAnimations = timeline.layers.flatMap((layer) => getClips(layer).map((clip) => ({ layer, clip })));
        const exists = (item: typeof command.items[number]) => {
          switch (item.kind) {
            case "layer": return timeline.layers.some((layer) => layer.id === item.id);
            case "color-layer": return timeline.colorLayers.some((layer) => layer.id === item.id);
            case "animation": return allAnimations.some(({ clip }) => clip.id === item.id);
            case "color": return timeline.colorLayers.some((layer) => layer.clips.some((clip) => clip.id === item.id));
            case "cue": return timeline.subtitles.some((cue) => cue.id === item.id);
            case "audio": return timeline.audio.some((clip) => clip.id === item.id);
          }
        };
        const missing = command.items.find((item) => !exists(item));
        if (missing) throw new Error(`Timeline ${missing.kind} not found: ${missing.id}`);
        if (command.name === "set_timeline_items_enabled") {
          let changedCount = 0;
          let skippedLockedCount = 0;
          const enabled = command.enabled;
          const layers = timeline.layers.map((layer) => {
            const selectedLayer = selected.has(`layer:${layer.id}`);
            const clips = getClips(layer);
            const selectedClips = clips.some((clip) => selected.has(`animation:${clip.id}`));
            if (!selectedLayer && !selectedClips) return layer;
            if (layer.locked) { skippedLockedCount += Number(selectedLayer) + Number(selectedClips); return layer; }
            if (selectedLayer && layer.enabled !== enabled) changedCount++;
            if (selectedClips) for (const clip of clips) if (selected.has(`animation:${clip.id}`) && clip.enabled !== enabled) changedCount++;
            return {
              ...layer,
              ...(selectedLayer ? { enabled } : {}),
              ...(selectedClips ? { animationClips: clips.map((clip) => selected.has(`animation:${clip.id}`) ? { ...clip, enabled } : clip) } : {}),
            };
          });
          const colorLayers = timeline.colorLayers.map((layer) => {
            const selectedLayer = selected.has(`color-layer:${layer.id}`);
            const selectedClips = layer.clips.some((clip) => selected.has(`color:${clip.id}`));
            if (!selectedLayer && !selectedClips) return layer;
            if (layer.locked) { skippedLockedCount += Number(selectedLayer) + Number(selectedClips); return layer; }
            if (selectedLayer && layer.enabled !== enabled) changedCount++;
            if (selectedClips) for (const clip of layer.clips) if (selected.has(`color:${clip.id}`) && clip.enabled !== enabled) changedCount++;
            return { ...layer, ...(selectedLayer ? { enabled } : {}), ...(selectedClips ? { clips: layer.clips.map((clip) => selected.has(`color:${clip.id}`) ? { ...clip, enabled } : clip) } : {}) };
          });
          const subtitles = timeline.subtitles.map((cue) => {
            if (!selected.has(`cue:${cue.id}`)) return cue;
            if (cue.enabled !== enabled) changedCount++;
            return { ...cue, enabled };
          });
          const audio = timeline.audio.map((clip) => {
            if (!selected.has(`audio:${clip.id}`)) return clip;
            if (clip.enabled !== enabled) changedCount++;
            return { ...clip, enabled };
          });
          if (changedCount > 0) mutate((value) => updateMcpProjectSequence(value, timeline.sequenceId ?? "legacy", (sequence) => ({ ...sequence, layers, colorLayers, subtitles, audio })));
          return { enabled, requestedCount: command.items.length, changedCount, skippedLockedCount };
        }

        const removableLayers = new Set(timeline.layers.filter((layer) => selected.has(`layer:${layer.id}`) && layer.role !== "character" && !layer.locked).map((layer) => layer.id));
        const removableColorLayers = new Set(timeline.colorLayers.filter((layer) => selected.has(`color-layer:${layer.id}`) && !layer.locked).map((layer) => layer.id));
        const selectedAnimationIds = new Set(command.items.filter((item) => item.kind === "animation").map((item) => item.id));
        const selectedColorIds = new Set(command.items.filter((item) => item.kind === "color").map((item) => item.id));
        const selectedCueIds = new Set(command.items.filter((item) => item.kind === "cue").map((item) => item.id));
        const selectedAudioIds = new Set(command.items.filter((item) => item.kind === "audio").map((item) => item.id));
        let skippedLockedCount = timeline.layers.filter((layer) => layer.locked && getClips(layer).some((clip) => selectedAnimationIds.has(clip.id))).length
          + timeline.colorLayers.filter((layer) => layer.locked && layer.clips.some((clip) => selectedColorIds.has(clip.id))).length;
        skippedLockedCount += timeline.layers.filter((layer) => selected.has(`layer:${layer.id}`) && (layer.role === "character" || layer.locked) && !removableLayers.has(layer.id)).length;
        skippedLockedCount += timeline.colorLayers.filter((layer) => selected.has(`color-layer:${layer.id}`) && layer.locked && !removableColorLayers.has(layer.id)).length;
        const layers = timeline.layers.filter((layer) => !removableLayers.has(layer.id)).map((layer) => {
          if (layer.locked) return layer;
          const clips = getClips(layer);
          const ids = clips.filter((clip) => selectedAnimationIds.has(clip.id)).map((clip) => clip.id);
          return ids.length ? { ...layer, animationClips: ids.reduce((value, id) => deleteAnimationClipRipple(value, id), clips) } : layer;
        });
        const colorLayers = timeline.colorLayers.filter((layer) => !removableColorLayers.has(layer.id)).map((layer) => layer.locked ? layer : { ...layer, clips: layer.clips.filter((clip) => !selectedColorIds.has(clip.id)) });
        const subtitles = timeline.subtitles.filter((cue) => !selectedCueIds.has(cue.id));
        const audio = timeline.audio.filter((clip) => !selectedAudioIds.has(clip.id)).map((clip) => clip.subtitleId && selectedCueIds.has(clip.subtitleId) ? { ...clip, subtitleId: null } : clip);
        const deletedCount = removableLayers.size + removableColorLayers.size
          + allAnimations.filter(({ layer, clip }) => !layer.locked && selectedAnimationIds.has(clip.id) && !removableLayers.has(layer.id)).length
          + timeline.colorLayers.filter((layer) => !layer.locked).reduce((count, layer) => count + layer.clips.filter((clip) => selectedColorIds.has(clip.id)).length, 0)
          + timeline.subtitles.filter((cue) => selectedCueIds.has(cue.id)).length
          + timeline.audio.filter((clip) => selectedAudioIds.has(clip.id)).length;
        if (deletedCount > 0) mutate((value) => updateMcpProjectSequence(value, timeline.sequenceId ?? "legacy", (sequence) => ({
          ...sequence,
          layers,
          colorLayers,
          subtitles,
          audio,
          selectedLayerId: removableLayers.has(sequence.selectedLayerId ?? "") ? null : sequence.selectedLayerId,
          selectedCueId: selectedCueIds.has(sequence.selectedCueId ?? "") ? null : sequence.selectedCueId,
          selectedColorLayerId: null,
          selectedColorClipId: null,
        })));
        return { requestedCount: command.items.length, deletedCount, skippedLockedCount };
      }
      case "list_audio_assets": {
        const source = sourceRef.current;
        if (!source) throw new Error("Open an asset root before listing audio assets.");
        if (!source.listAudioAssets) throw new Error("Audio asset discovery is unavailable from this asset source.");
        return source.listAudioAssets();
      }
      case "inspect_recovery": {
        const prompt = recoveryPromptRef.current;
        if (!prompt || prompt.rootPath !== sourceRef.current?.rootPath || prompt.directory !== directoryRef.current) return { available: false, candidates: [] };
        const summarize = (candidate: EditorProject, slot: string) => ({
          slot,
          name: candidate.name,
          assetDirectory: candidate.assetDirectory,
          sequenceCount: 1 + Object.keys(candidate.sequences ?? {}).length,
          interactionCount: candidate.interactions.length,
          behaviorMachineCount: candidate.behaviorMachines?.length ?? 0,
        });
        const candidates = [
          ...(prompt.current ? [summarize(prompt.current, "latest")] : []),
          ...prompt.backups.map((candidate, backupIndex) => summarize(candidate, `backup:${backupIndex}`)),
        ];
        return { available: candidates.length > 0, rootPath: prompt.rootPath, directory: prompt.directory, savedAt: prompt.savedAt || null, candidates };
      }
      case "restore_recovery": {
        const prompt = recoveryPromptRef.current;
        if (!prompt || prompt.rootPath !== sourceRef.current?.rootPath || prompt.directory !== directoryRef.current) throw new Error("There is no recovery snapshot for the loaded project.");
        const candidate = command.candidate === "latest" ? prompt.current : prompt.backups[command.backupIndex ?? -1];
        if (!candidate) throw new Error("The requested recovery snapshot is unavailable.");
        const legacyAspectRatio = command.candidate === "latest"
          ? prompt.legacyCurrent
          : prompt.legacyBackups[command.backupIndex ?? -1] ?? false;
        restoreRecoveryProject(candidate, command.candidate === "latest" ? "Latest recovery snapshot" : `Recovery backup ${command.backupIndex ?? 0}`, legacyAspectRatio);
        return { restored: true, candidate: command.candidate, ...(command.backupIndex === undefined ? {} : { backupIndex: command.backupIndex }), projectName: candidate.name, saveState: "dirty" };
      }
      case "open_project_file": {
        const currentSaveState = saveStateRef.current;
        if (currentSaveState === "dirty" || currentSaveState === "saving" || currentSaveState === "error") throw new Error("Save the current project before opening another project file. MCP never discards unsaved work.");
        if (recoveryPromptRef.current) throw new Error("Resolve or dismiss the pending recovery prompt before opening another project file. MCP never discards recovery data.");
        const currentSource = sourceRef.current;
        if (!currentSource) throw new Error("Open an asset root before opening a project file.");
        if (!command.path.toLocaleLowerCase().endsWith(".json")) throw new Error("Project files must use the .json extension.");
        const content = await currentSource.readText(command.path);
        if (!content) throw new Error(`Project file not found inside the selected asset root: ${command.path}`);
        const raw = JSON.parse(content) as Record<string, unknown>;
        const assetDirectory = typeof raw.assetDirectory === "string" ? raw.assetDirectory : "";
        if (!assetDirectory) throw new Error("This project file does not identify an asset set.");
        const restored = normalizeProject(raw, assetDirectory);
        if (!restored) throw new Error("The selected file is not a compatible Spine Editor project.");
        const nextSource = await chooseDesktopSourceAt(currentSource.rootPath);
        if (!nextSource) throw new Error("The project asset root could not be reopened.");
        pendingProjectRef.current = restored;
        setPendingSubtitlePath(null);
        setPendingAudioPaths(null);
        setAssetLoading(true);
        recordRecentFile({ kind: "project", path: command.path, rootPath: nextSource.rootPath, label: displayName(command.path), directory: restored.assetDirectory });
        await useSource(nextSource, restored.assetDirectory);
        setLegacyAspectRatioNotice(hasLegacySquareCameraAspectRatio(raw));
        setWorkspace("interaction");
        setStatus(`Opened project ${displayName(command.path)}.`);
        return { opened: true, path: command.path, directory: restored.assetDirectory, projectName: restored.name };
      }
      case "preview_interaction_phase": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        if (!interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        const phase = command.phase === "start"
          ? [interaction.startAnimation, interaction.faceStartAnimation]
          : command.phase === "follow"
            ? [interaction.followAnimation, interaction.faceFollowAnimation]
            : [interaction.endAnimation, interaction.faceEndAnimation];
        if (!phase[0] && !phase[1]) throw new Error(`The ${command.phase} phase has no animation assigned.`);
        previewPhase(`${interaction.name} ${command.phase}`, phase[0], phase[1], command.phase === "follow");
        return { interactionId: interaction.id, phase: command.phase, bodyAnimation: phase[0], faceAnimation: phase[1] };
      }
      case "start_interaction_test": {
        const interaction = projectRef.current?.interactions.find((item) => item.id === command.interactionId);
        if (!interaction) throw new Error(`Interaction not found: ${command.interactionId}`);
        if (!frame) throw new Error("The interaction preview renderer is not ready.");
        if (command.regionId && !interaction.regions.some((region) => region.id === command.regionId && region.enabled)) throw new Error(`Enabled region not found: ${command.regionId}`);
        updateProjectSelection((value) => ({ ...value, selectedInteractionId: interaction.id, selectedRegionId: command.regionId ?? interaction.regions[0]?.id ?? null }));
        startSelectedTest(interaction, command.regionId);
        return { interactionId: interaction.id, regionId: command.regionId ?? interaction.regions.find((region) => region.enabled)?.id ?? null, testing: true };
      }
      case "move_interaction_test":
        if (!testing) throw new Error("Start an interaction test before moving its pointer.");
        previewRef.current.move(command.worldX, command.worldY);
        setPreviewDebug(previewRef.current.debug);
        return { worldX: command.worldX, worldY: command.worldY, preview: previewRef.current.debug };
      case "release_interaction_test":
        if (!testing) throw new Error("There is no active interaction test to release.");
        releaseTest();
        return { released: true, preview: previewRef.current.debug };
      case "cancel_interaction_test":
        if (!testing) throw new Error("There is no active interaction test to cancel.");
        previewRef.current.release();
        testPointerRef.current = null;
        resetPreview();
        setTesting(false);
        setPreviewStatus("cancelled");
        return { cancelled: true, preview: previewRef.current.debug };
      case "test_look_follow":
        if (command.enabled && (!projectRef.current?.lookFollow.enabled || !frame?.lookFollow)) throw new Error("Look-follow testing requires enabled settings and a loaded Look-follow controller.");
        if (command.enabled !== lookTesting) toggleLookFollowTest();
        return { lookFollowTesting: command.enabled && projectRef.current?.lookFollow.enabled === true && Boolean(frame?.lookFollow) };
      case "inject_behavior_event": {
        const machine = projectRef.current?.behaviorMachines?.find((item) => item.id === command.machineId);
        if (!machine) throw new Error(`Behavior machine not found: ${command.machineId}`);
        if (command.regionId && !machine.activation.regions.some((region) => region.id === command.regionId)) throw new Error(`Activation region not found: ${command.regionId}`);
        const renderer = rendererRef.current;
        if (!renderer) throw new Error("The behavior runtime renderer is not ready.");
        setWorkspace("interaction");
        setBehaviorMode(true);
        renderer.testBehaviorEvent(command.machineId, command.event, command.regionId ?? null);
        return { machineId: command.machineId, event: command.event, regionId: command.regionId ?? null, injected: true };
      }
      case "cancel_behavior_test":
        if (!rendererRef.current) throw new Error("The behavior runtime renderer is not ready.");
        rendererRef.current.cancelBehaviorTest();
        return { cancelled: true };
      case "get_project": {
        const current = projectRef.current;
        if (!current) throw new Error("Load a Spine asset before inspecting the project.");
        return {
          project: cloneProject(current),
          assetRoot: sourceRef.current?.rootPath ?? null,
          directory: directoryRef.current,
          workspace: workspaceRef.current,
          saveState: saveStateRef.current,
          undoAvailable: undo.length > 0,
          redoAvailable: redo.length > 0,
          documentRevision: currentMcpDocumentRevision(),
          animations: metaRef.current?.animations ?? [],
          skeleton: frame ? {
            bones: frame.bones.map(({ path, name, parentPath, length, rotation, active }) => ({ path, name, parentPath, length, rotation, active })),
            constraints: frame.constraints,
          } : null,
        };
      }
      case "validate_project": {
        const current = projectRef.current;
        const currentSource = sourceRef.current;
        if (!current || !currentSource) throw new Error("Load a project before running whole-project validation.");
        const validationRevision = currentMcpDocumentRevision();
        const activeId = current.timeline.sequenceId ?? "legacy";
        const sequences = new Map(Object.entries(current.sequences ?? {}));
        sequences.set(activeId, current.timeline);
        const findings: Array<{ code: string; severity: "error" | "warning"; message: string; sequenceId?: string; entityId?: string }> = [];
        const maximumFindings = 500;
        let truncated = false;
        const addFinding = (finding: typeof findings[number]) => {
          if (findings.length >= maximumFindings) { truncated = true; return; }
          findings.push(finding);
        };
        if (current.composition) {
          for (const diagnostic of validateComposition(current.composition)) addFinding({
            code: `composition_${diagnostic.code.replaceAll("-", "_")}`,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.targetId ? { entityId: diagnostic.targetId } : {}),
          });
        }
        const sequenceIds = new Set(sequences.keys());
        if (current.entrySequence && !sequenceIds.has(current.entrySequence)) addFinding({ code: "missing_entry_sequence", severity: "error", message: `Entry sequence ${current.entrySequence} does not exist.` });
        const ordered = current.sequenceOrder ?? [];
        if (ordered[0] !== "opening") addFinding({ code: "opening_order", severity: "error", message: "Opening must be first in the authored sequence order." });
        if (new Set(ordered).size !== ordered.length) addFinding({ code: "duplicate_sequence_order", severity: "error", message: "Sequence order contains duplicate IDs." });
        for (const id of ordered) if (!sequenceIds.has(id)) addFinding({ code: "missing_ordered_sequence", severity: "error", message: `Sequence order references missing sequence ${id}.`, sequenceId: id });

        const allCueIds = new Set<string>();
        const allAudioIds = new Set<string>();
        const availableDirectories = new Set(directories);
        const animationInfo = new Map((mcpTimelineSnapshotRef.current?.animationInfo ?? []).map((layer) => [layer.layerId, new Set(layer.animations.map((animation) => animation.name))]));
        for (const [sequenceId, timeline] of sequences) {
          if (timeline.sequenceId && timeline.sequenceId !== sequenceId) addFinding({ code: "sequence_id_mismatch", severity: "error", message: `Timeline identifies itself as ${timeline.sequenceId}, but is stored as ${sequenceId}.`, sequenceId });
          if (!Number.isFinite(timeline.duration) || timeline.duration <= 0) addFinding({ code: "invalid_duration", severity: "error", message: "Sequence duration must be finite and positive.", sequenceId });
          const localIds = new Set<string>();
          const checkId = (id: string, kind: string) => {
            if (localIds.has(id)) addFinding({ code: "duplicate_entity_id", severity: "error", message: `Duplicate ${kind} ID ${id} in this sequence.`, sequenceId, entityId: id });
            localIds.add(id);
          };
          for (const layer of timeline.layers) {
            checkId(layer.id, "visual layer");
            if (!availableDirectories.has(layer.directory)) addFinding({ code: "missing_layer_asset", severity: "error", message: `Spine layer ${layer.name} references unavailable asset set ${layer.directory}.`, sequenceId, entityId: layer.id });
            if (sequenceId === activeId) {
              const available = animationInfo.get(layer.id);
              const clips = layer.animationClips ?? [];
              for (const clip of clips) if (clip.animation && available && !available.has(clip.animation)) addFinding({ code: "missing_animation", severity: "error", message: `Animation ${clip.animation} is unavailable on layer ${layer.name}.`, sequenceId, entityId: clip.id });
            }
          }
          for (const layer of timeline.colorLayers) {
            checkId(layer.id, "color layer");
            for (const clip of layer.clips) checkId(clip.id, "color clip");
          }
          for (const cue of timeline.subtitles) {
            checkId(cue.id, "subtitle cue");
            if (cue.end < cue.start + 0.01) addFinding({ code: "invalid_subtitle_timing", severity: "error", message: `Subtitle cue ${cue.id} ends before its start plus 0.01 seconds.`, sequenceId, entityId: cue.id });
            allCueIds.add(cue.id);
          }
          const linkedCueIds = new Set<string>();
          for (const clip of timeline.audio) {
            checkId(clip.id, "audio clip");
            allAudioIds.add(clip.id);
            if (clip.end < clip.start + 0.01) addFinding({ code: "invalid_audio_timing", severity: "error", message: `Audio clip ${clip.id} has invalid timing.`, sequenceId, entityId: clip.id });
            if (clip.subtitleId) {
              if (!timeline.subtitles.some((cue) => cue.id === clip.subtitleId)) addFinding({ code: "missing_subtitle_link", severity: "error", message: `Audio clip ${clip.id} links to missing subtitle cue ${clip.subtitleId}.`, sequenceId, entityId: clip.id });
              if (linkedCueIds.has(clip.subtitleId)) addFinding({ code: "duplicate_subtitle_link", severity: "error", message: `Subtitle cue ${clip.subtitleId} is linked to more than one audio clip.`, sequenceId, entityId: clip.id });
              linkedCueIds.add(clip.subtitleId);
            }
          }
          if (timeline.camera) {
            const camera = timeline.camera;
            const boundIds = new Set(camera.safeBounds.map((bound) => bound.id));
            const referenceLayer = camera.referenceLayerId;
            if (referenceLayer && !timeline.layers.some((layer) => layer.id === referenceLayer)) addFinding({ code: "missing_camera_reference_layer", severity: "error", message: `Camera references missing layer ${referenceLayer}.`, sequenceId, entityId: referenceLayer });
            for (const constraint of [camera.constraint, ...camera.keyframes.flatMap((keyframe) => keyframe.constraint ? [keyframe.constraint] : [])]) {
              if (constraint.mode === "manual" && !boundIds.has(constraint.boundId)) addFinding({ code: "missing_camera_bound", severity: "error", message: `Camera constraint references missing safe bound ${constraint.boundId}.`, sequenceId, entityId: constraint.boundId });
            }
            for (const keyframe of camera.keyframes) if (keyframe.time > timeline.duration) addFinding({ code: "camera_keyframe_after_duration", severity: "warning", message: `Camera keyframe ${keyframe.id} is after the sequence duration.`, sequenceId, entityId: keyframe.id });
          }
        }
        const loadedBonePaths = new Set(frame?.bones.map((bone) => bone.path) ?? []);
        if (current.lookFollow.targetBonePath && loadedBonePaths.size && !loadedBonePaths.has(current.lookFollow.targetBonePath)) addFinding({ code: "missing_look_follow_bone", severity: "error", message: `Look-follow target bone ${current.lookFollow.targetBonePath} is unavailable.`, entityId: current.lookFollow.targetBonePath });
        for (const interaction of current.interactions) {
          if (interaction.followTargetBone && loadedBonePaths.size && !loadedBonePaths.has(interaction.followTargetBone)) addFinding({ code: "missing_interaction_bone", severity: "error", message: `Interaction ${interaction.name} targets missing bone ${interaction.followTargetBone}.`, entityId: interaction.id });
          for (const region of interaction.regions) if (region.anchorBone && loadedBonePaths.size && !loadedBonePaths.has(region.anchorBone)) addFinding({ code: "missing_region_bone", severity: "error", message: `Region ${region.name} is anchored to missing bone ${region.anchorBone}.`, entityId: region.id });
        }
        const machines = current.behaviorMachines ?? [];
        for (const machine of machines) {
          const stateIds = new Set(machine.states.map((state) => state.id));
          if (!stateIds.has(machine.initialStateId)) addFinding({ code: "missing_initial_state", severity: "error", message: `Behavior machine ${machine.name} has no valid initial state.`, entityId: machine.id });
          for (const transition of machine.transitions) {
            if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) addFinding({ code: "invalid_behavior_transition", severity: "error", message: `Transition ${transition.id} references a missing local state.`, entityId: transition.id });
            for (const condition of transition.conditions) if (condition.type === "machine-state") {
              const target = machines.find((candidate) => candidate.id === condition.machineId);
              if (!target?.states.some((state) => state.id === condition.stateId)) addFinding({ code: "invalid_cross_machine_condition", severity: "error", message: `Condition references missing machine state ${condition.machineId}/${condition.stateId}.`, entityId: transition.id });
            }
          }
          for (const state of machine.states) for (const action of [...state.actions, ...state.exitActions, ...state.cancelActions]) {
            if (action.type === "pointer-follow" || action.type === "drag-bone" || action.type === "rotate-bone") {
              if (action.targetBonePath && loadedBonePaths.size && !loadedBonePaths.has(action.targetBonePath)) addFinding({ code: "missing_behavior_bone", severity: "error", message: `Behavior action targets missing bone ${action.targetBonePath}.`, entityId: machine.id });
            } else if (action.type === "play-audio" && !allAudioIds.has(action.audioId)) addFinding({ code: "missing_behavior_audio", severity: "warning", message: `Behavior action references audio clip ${action.audioId} not found in authored sequences.`, entityId: machine.id });
            else if (action.type === "show-subtitle" && !allCueIds.has(action.cueId)) addFinding({ code: "missing_behavior_subtitle", severity: "warning", message: `Behavior action references subtitle cue ${action.cueId} not found in authored sequences.`, entityId: machine.id });
          }
        }
        const sourceFilePaths = [...new Set([...sequences.values()].flatMap((timeline) => timeline.audio.map((clip) => clip.path)))].slice(0, 200);
        if (sourceFilePaths.length < new Set([...sequences.values()].flatMap((timeline) => timeline.audio.map((clip) => clip.path))).size) truncated = true;
        const missingFiles = await Promise.all(sourceFilePaths.map(async (path) => ({ path, exists: Boolean(await currentSource.getFile(path).catch(() => null)) })));
        for (const file of missingFiles) if (!file.exists) addFinding({ code: "missing_audio_asset", severity: "error", message: `Audio asset is missing or outside the selected root: ${file.path}.`, entityId: file.path });
        const revisionAfter = currentMcpDocumentRevision();
        if (revisionAfter !== validationRevision) addFinding({ code: "project_changed_during_validation", severity: "warning", message: `The authored project changed during validation (revision ${validationRevision} to ${revisionAfter}). Re-run validation for the latest document.` });
        return { scope: "project", assetRoot: currentSource.rootPath, directory: current.assetDirectory, documentRevision: validationRevision, documentRevisionAfter: revisionAfter, scannedSequenceCount: sequences.size, scannedInteractionCount: current.interactions.length, scannedBehaviorMachineCount: machines.length, compositionPresent: Boolean(current.composition), checkedAudioPaths: sourceFilePaths.length, count: findings.length, truncated, findings };
      }
      case "undo":
        if (undo.length === 0) throw new Error("There is no project edit to undo.");
        undoProject();
        return { undone: true, documentRevision: currentMcpDocumentRevision(), undoAvailable: undo.length > 1, redoAvailable: true };
      case "redo":
        if (redo.length === 0) throw new Error("There is no project edit to redo.");
        redoProject();
        return { redone: true, documentRevision: currentMcpDocumentRevision(), undoAvailable: true, redoAvailable: redo.length > 1 };
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
        if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || saveStateRef.current === "error" || recoveryPromptRef.current) throw new Error("Save the current project and resolve recovery before opening another asset root.");
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
        if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || saveStateRef.current === "error" || recoveryPromptRef.current) throw new Error("Save the current project and resolve recovery before switching asset sets.");
        if (!sourceRef.current) throw new Error("Open an asset root first.");
        if (!directories.includes(command.directory)) throw new Error(`Asset set not found: ${command.directory}`);
        const previousWorkspace = workspaceRef.current;
        if (command.directory === directoryRef.current) {
          await waitForAssetSetLoaded(command.directory);
          return { directory: command.directory, status: "Asset set is already loaded." };
        }
        // The interaction renderer owns Spine asset initialization and project
        // reconstruction. Stage the switch there, then restore the user's
        // workspace only after the new set and its timeline renderer are ready.
        if (previousWorkspace !== "interaction") {
          setWorkspace("interaction");
          await waitForWorkspaceMounted("interaction");
        }
        setAssetLoading(true);
        // The MCP command already rejects unsaved/error/recovery states above; do not
        // re-run the UI's discard confirmation using a potentially stale render closure.
        await changeDirectory(command.directory, { skipConfirmation: true, throwOnError: true });
        await waitForAssetSetLoaded(command.directory);
        if (previousWorkspace !== "interaction") {
          setWorkspace(previousWorkspace);
          await waitForWorkspaceMounted(previousWorkspace);
        }
        return { directory: command.directory, status: "Asset set loaded.", workspace: previousWorkspace };
      }
      case "set_workspace":
        if (command.workspace !== "interaction" && (!projectRef.current || !metaRef.current || !directoryRef.current)) throw new Error("Load a Spine asset before opening the timeline or camera workspace.");
        if (command.workspace !== "interaction") setBehaviorMode(false);
        setWorkspace(command.workspace);
        return { workspace: command.workspace };
      case "select_sequence": {
        const timeline = mcpTimelineRef.current;
        if (timeline) return timeline.execute(command);
        const current = projectRef.current;
        const loadedMeta = metaRef.current;
        if (!current || !loadedMeta || !sequenceIdsForProject(current, loadedMeta.animations).includes(command.sequenceId)) throw new Error(`Sequence not found: ${command.sequenceId}`);
        const next = switchSequence(current, command.sequenceId, loadedMeta.animations, directories);
        updateProjectSelection(() => next);
        return { sequenceId: command.sequenceId, workspace: workspaceRef.current };
      }
      case "save": {
        await saveProject({ rejectExternalChanges: true });
        const saved = saveResultRef.current;
        if (!saved?.ok) throw new Error(saved?.error ?? "The project could not be saved.");
        return { ok: true, status: "saved", savedDocumentRevision: saved.savedDocumentRevision ?? currentMcpDocumentRevision(), writtenPaths: saved.writtenPaths ?? [], verifiedVersions: saved.verifiedVersions ?? {} };
      }
      default: {
        const timeline = mcpTimelineRef.current;
        if (!timeline) {
          const result = executeWorkspaceIndependentTimelineEdit(command);
          if (result !== undefined) return result;
          if (command.name === "match_audio_length") throw new Error("Audio duration matching requires decoded media metadata. Open the Timeline workspace and wait for the audio clip to decode first.");
          if (command.name === "preview_audio_clip" || command.name === "stop_audio_preview" || command.name === "capture_preview") throw new Error(`${command.name} requires the Timeline preview workspace to be mounted.`);
          throw new Error("This operation requires the Timeline workspace. Call editor_set_workspace first and verify timelineWorkspaceMounted in editor_capabilities.");
        }
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

  function updateLookFollow<K extends keyof SpineLookFollowSettings>(field: K, value: SpineLookFollowSettings[K]) {
    mutate((current) => ({ ...current, lookFollow: { ...current.lookFollow, [field]: value } }));
  }

  function beginLookFollowEdit() {
    if (!projectRef.current) return;
    setUndo((items) => [...items.slice(-49), projectRef.current!]);
    setRedo([]);
  }

  function changeLookFollowRange(axis: "x" | "y", value: number) {
    live((current) => ({
      ...current,
      lookFollow: { ...current.lookFollow, [axis === "x" ? "rangeX" : "rangeY"]: value },
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

  function selectInteractionRegion(interactionId: string, regionId: string) {
    live((current) => ({ ...current, selectedInteractionId: interactionId, selectedRegionId: regionId }));
  }

  function contextSelectInteraction(interactionId: string) {
    updateProjectSelection((current) => {
      const item = current.interactions.find((interaction) => interaction.id === interactionId);
      return { ...current, selectedInteractionId: interactionId, selectedRegionId: item?.regions[0]?.id ?? null };
    });
  }

  function contextSelectInteractionRegion(interactionId: string, regionId: string) {
    updateProjectSelection((current) => ({ ...current, selectedInteractionId: interactionId, selectedRegionId: regionId }));
  }

  function addInteraction() {
    if (!project || !frame || !meta) return;
    const item = blankInteraction(meta.animations, frame.bones, project.interactions.length);
    mutate((current) => ({ ...current, interactions: [...current.interactions, item], selectedInteractionId: item.id, selectedRegionId: item.regions[0]?.id ?? null }));
  }

  function deleteInteraction() {
    if (!selectedInteraction) return;
    deleteInteractionById(selectedInteraction.id);
  }

  function deleteInteractionById(interactionId: string) {
    mutate((current) => {
      const remaining = current.interactions.filter((item) => item.id !== interactionId);
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
    deleteRegionById(selectedInteraction.id, selectedRegion.id);
  }

  function deleteRegionById(interactionId: string, regionId: string) {
    mutate((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) => interaction.id === interactionId ? { ...interaction, regions: interaction.regions.filter((region) => region.id !== regionId) } : interaction),
      selectedRegionId: current.selectedRegionId === regionId ? null : current.selectedRegionId,
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

  function stopLookFollowTest() {
    testPointerRef.current = null;
    rendererRef.current?.setLookFollowPreview(false);
    setLookTesting(false);
  }

  function toggleLookFollowTest() {
    if (lookTesting) {
      stopLookFollowTest();
      resetPreview();
      setStatus("Look-follow preview stopped.");
      return;
    }
    if (!project?.lookFollow.enabled || !frame?.lookFollow) return;
    testPointerRef.current = null;
    previewRef.current.reset();
    setPreviewDebug(previewRef.current.debug);
    const idle = metaRef.current?.idleAnimation ?? metaRef.current?.defaultAnimation;
    if (idle) { rendererRef.current?.setAnimation(idle, true); setSelectedAnimation(idle); setAnimationSelectionOrigin("automatic"); }
    rendererRef.current?.setLookFollowSettings(project.lookFollow);
    rendererRef.current?.setLookFollowPreview(true);
    setTesting(false);
    setLookTesting(true);
    setTool("select");
    setLookSettingsOpen(true);
    setPlaying(true);
    setStatus("Look-follow test is ready. Press and hold the canvas, then move the pointer to preview gaze and limits.");
  }

  function startSelectedTest(interactionOverride?: EditorInteraction, regionIdOverride?: string) {
    const interaction = interactionOverride ?? selectedInteraction;
    if (!interaction || !frame) return;
    if (lookTesting) stopLookFollowTest();
    const testRegion = regionIdOverride
      ? interaction.regions.find((region) => region.id === regionIdOverride) ?? null
      : !interactionOverride && selectedRegion?.enabled && interaction.regions.some((region) => region.id === selectedRegion.id)
        ? selectedRegion
        : interaction.regions.find((region) => region.enabled) ?? null;
    const center = testRegion
      ? regionMatrix(frame, testRegion)
      : { e: frame.canvasWidth / 2, f: frame.canvasHeight / 2 };
    const origin = screenToWorld(frame, center.e, center.f);
    if (!origin) return;
    resetPreview();
    previewRef.current.press(interaction, testRegion?.name ?? "Direct test", origin.x, origin.y);
    setPreviewDebug(previewRef.current.debug);
    setPreviewStatus(`starting · ${interaction.name}`);
    setTesting(true);
    setTool("select");
    setStatus(`Testing ${interaction.name} directly. Drag on the stage, or release with the test controls.`);
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
    if (lookTesting) {
      stopLookFollowTest();
      return;
    }
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
    duplicateRegionById(selectedInteraction.id, selectedRegion.id);
  }

  function duplicateRegionById(interactionId: string, regionId: string) {
    const currentInteraction = projectRef.current?.interactions.find((item) => item.id === interactionId);
    const selected = currentInteraction?.regions.find((item) => item.id === regionId);
    if (!currentInteraction || !selected) return;
    const copy = { ...selected, id: crypto.randomUUID(), name: `${selected.name} copy`, offsetX: selected.offsetX + 20, placement: "manual" as const };
    mutate((current) => ({ ...current, selectedInteractionId: interactionId, selectedRegionId: copy.id, interactions: current.interactions.map((item) => item.id === interactionId ? { ...item, regions: [...item.regions, copy] } : item) }));
  }

  function duplicateInteraction() {
    if (!selectedInteraction) return;
    duplicateInteractionById(selectedInteraction.id);
  }

  function duplicateInteractionById(interactionId: string) {
    const selected = projectRef.current?.interactions.find((item) => item.id === interactionId);
    if (!selected) return;
    const copy = structuredClone(selected);
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
    if (warning.kind === "missing-bone" && !warning.regionId) setMovementSettingsOpen(true);
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

  function openInteractionContextMenuAt(
    x: number,
    y: number,
    target: InteractionContextTarget,
    returnFocusTo: HTMLElement | SVGElement | null,
  ) {
    if (target.kind === "interaction") contextSelectInteraction(target.interactionId);
    if (target.kind === "region") {
      contextSelectInteractionRegion(target.interactionId, target.regionId);
    }
    setInteractionContextMenu({ x, y, target, returnFocusTo });
  }

  function openInteractionContextMenu(event: ReactMouseEvent<Element>, target: InteractionContextTarget) {
    if (isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    openInteractionContextMenuAt(event.clientX, event.clientY, target, event.currentTarget as HTMLElement | SVGElement);
  }

  function openInteractionKeyboardMenu(event: ReactKeyboardEvent<HTMLElement>, target: InteractionContextTarget) {
    if (!isContextMenuShortcut(event) || isTextEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openInteractionContextMenuAt(bounds.left, bounds.bottom, target, event.currentTarget);
  }

  function interactionContextActions(target: InteractionContextTarget): readonly ContextMenuAction[] {
    const current = projectRef.current;
    if (target.kind === "canvas") return [
      { label: "Add interaction", disabled: !current || !frame || !meta, run: addInteraction },
      { label: "Add hit region", disabled: !selectedInteraction || !frame, reason: !selectedInteraction ? "Select an interaction first." : undefined, run: addRegion },
      { label: "Fit artwork", disabled: !frame, run: () => rendererRef.current?.resetCamera(), separatorBefore: true },
      { label: "Reset idle preview", disabled: !frame, run: resetPreview },
      { label: testing ? "Exit interaction test" : "Test selected interaction", disabled: !selectedInteraction || !frame, run: toggleTest },
    ];
    const interaction = current?.interactions.find((item) => item.id === target.interactionId);
    if (!interaction) return [];
    if (target.kind === "interaction") return [
      { label: "Edit interaction properties", run: () => contextSelectInteraction(interaction.id) },
      { label: interaction.enabled ? "Disable interaction" : "Enable interaction", run: () => mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id === interaction.id ? { ...item, enabled: !item.enabled } : item) })) },
      { label: "Duplicate interaction", run: () => duplicateInteractionById(interaction.id) },
      { label: "Test interaction", disabled: !frame, run: () => startSelectedTest(interaction) },
      { label: "Delete interaction…", danger: true, separatorBefore: true, run: () => { if (confirm("Delete this interaction and all its regions?")) deleteInteractionById(interaction.id); } },
    ];
    const region = interaction.regions.find((item) => item.id === target.regionId);
    if (!region) return [];
    return [
      { label: "Edit region properties", run: () => contextSelectInteractionRegion(interaction.id, region.id) },
      { label: region.enabled ? "Disable region" : "Enable region", run: () => mutate((value) => ({ ...value, interactions: value.interactions.map((item) => item.id === interaction.id ? { ...item, regions: item.regions.map((entry) => entry.id === region.id ? { ...entry, enabled: !entry.enabled } : entry) } : item) })) },
      { label: "Duplicate region", run: () => duplicateRegionById(interaction.id, region.id) },
      { label: "Delete region", danger: true, separatorBefore: true, run: () => deleteRegionById(interaction.id, region.id) },
    ];
  }

  function handleInteractionStageContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    openInteractionContextMenu(event, { kind: "canvas" });
  }

  function handleInteractionStageKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    openInteractionKeyboardMenu(event, { kind: "canvas" });
  }

  function stagePress(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !frame || !project) return;
    if ((testing || lookTesting) && (testPointerRef.current !== null || previewRef.current.held)) return;
    const point = stagePoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (lookTesting) {
      testPointerRef.current = event.pointerId;
      rendererRef.current?.setLookFollowPreviewPointer(event.clientX, event.clientY);
      setStatus("Following pointer. Move it to preview the authored look range; release to return.");
      return;
    }
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
    if (lookTesting) {
      if (testPointerRef.current === event.pointerId) rendererRef.current?.setLookFollowPreviewPointer(event.clientX, event.clientY);
      return;
    }
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
    if (lookTesting && testPointerRef.current === event.pointerId) {
      testPointerRef.current = null;
      rendererRef.current?.setLookFollowPreviewPointer(null, null);
    }
    if (testing && testPointerRef.current === event.pointerId) {
      testPointerRef.current = null;
      previewRef.current.release();
    }
    const start = drawRef.current;
    drawRef.current = null;
    setDrawBox(null);
    if (!testing && !lookTesting && start && frame && selectedInteraction) {
      const point = stagePoint(event);
      const end = point && screenToWorld(frame, point.x, point.y);
      if (end && Math.hypot(end.x - start.x, end.y - start.y) > 5) {
        const region = { ...blankRegion(undefined, selectedInteraction.regions.length), placement: "manual" as const, offsetX: (start.x + end.x) / 2, offsetY: (start.y + end.y) / 2, radiusX: Math.max(5, Math.abs(end.x - start.x) / 2), radiusY: Math.max(5, Math.abs(end.y - start.y) / 2) };
        mutate((current) => ({ ...current, selectedRegionId: region.id, interactions: current.interactions.map((item) => item.id === selectedInteraction.id ? { ...item, regions: [...item.regions, region] } : item) }));
        setTool("select"); setStatus("Region drawn. Drag to move; use the handles to resize or rotate.");
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
          <h1>{workspace === "timeline" ? "Timeline Composer" : workspace === "camera" ? "Camera Studio" : behaviorMode ? "Behavior Studio" : "Interaction Studio"}</h1>
        </div>
        <div className="editor-header-context">
          <div className="editor-workspace-tabs suite-tabs" role="tablist" aria-label="Editor workspace">
            <button className={`editor-button suite-tab${workspace === "interaction" && !behaviorMode ? " active" : ""}`} role="tab" aria-selected={workspace === "interaction" && !behaviorMode} onClick={() => { rendererRef.current?.cancelBehaviorTest(); setWorkspace("interaction"); setBehaviorMode(false); }}>Interactions</button>
            <button className={`editor-button suite-tab${workspace === "interaction" && behaviorMode ? " active" : ""}`} role="tab" aria-selected={workspace === "interaction" && behaviorMode} onClick={() => { setWorkspace("interaction"); setBehaviorMode(true); }} disabled={!assetLoaded}>Behaviors</button>
            <button className={`editor-button suite-tab${workspace === "timeline" ? " active" : ""}`} role="tab" aria-selected={workspace === "timeline"} onClick={() => setWorkspace("timeline")} disabled={!assetLoaded}>Timeline</button>
            <button className={`editor-button suite-tab${workspace === "camera" ? " active" : ""}`} role="tab" aria-selected={workspace === "camera"} onClick={() => setWorkspace("camera")} disabled={!assetLoaded}>Camera</button>
          </div>
          <div className="editor-asset-picker"><span>Set</span><button className="editor-asset-picker-button" type="button" aria-label="Choose character or asset set" aria-haspopup="dialog" aria-expanded={assetPickerOpen} onClick={() => setAssetPickerOpen(true)} disabled={!directories.length} title={directory || "Open a folder first"}><span>{directory ? characterDirectoryLabel(directory, directoryLabels) : "Open a folder…"}</span><IconChevronDown /></button></div>
        </div>
        <div className="editor-actions">
          <button className="suite-icon-button editor-button editor-icon-button editor-command-trigger" type="button" aria-label="Search commands" aria-keyshortcuts="Control+K Meta+K" title="Search commands (Ctrl/⌘ K)" onClick={() => setCommandPaletteOpen(true)}><IconSearch /></button>
          <WorkspacePresetMenu compact selected={layoutPreset} timelineDisabled={!assetLoaded} onSelect={applyWorkspacePreset} />
          <details className="editor-header-menu editor-preview-settings-menu" name="editor-toolbar-menu">
            <summary className="editor-button editor-icon-button" aria-label="Preview settings" title="Preview settings"><IconSliders /></summary>
            <div className="editor-header-menu-popover editor-preview-settings-popover" role="group" aria-label="Preview settings">
              <strong>Preview settings</strong>
              <label className="editor-light-fx-control" title="Saved with this project and used in Editor and Viewer previews.">
                <span>Light FX</span>
                <input type="range" min="0" max="1" step="0.05" value={project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH} aria-label="Light FX strength" disabled={!project} onChange={(event) => live((current) => ({ ...current, effectsStrength: Number(event.target.value) }))} />
                <output>{Math.round((project?.effectsStrength ?? DEFAULT_EFFECTS_STRENGTH) * 100)}%</output>
              </label>
            </div>
          </details>
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
      {interactionContextMenu && <ContextMenu
        x={interactionContextMenu.x}
        y={interactionContextMenu.y}
        label="Interaction studio actions"
        actions={interactionContextActions(interactionContextMenu.target)}
        onClose={() => setInteractionContextMenu(null)}
        returnFocusTo={interactionContextMenu.returnFocusTo}
      />}

        {help && <div className="editor-help" role="region" aria-label="Editor help"><strong>Shortcuts</strong>{workspace === "camera" ? <><span>Camera: use Select, Pan, or Draw tools on the full-scene canvas. Edit selected boundaries and shots in the right inspector.</span><span>Ctrl/⌘ K Commands · Space Play/pause · Use the shared playhead to sync with Timeline · Ctrl/⌘ S Save</span></> : workspace === "timeline" ? <span>Ctrl/⌘ K Commands · Space Play/pause · Left/right Frame · Shift+Left/right 10 frames · Home/End · S Split subtitle · Ctrl/⌘ C/V Copy/paste · Ctrl/⌘ D Duplicate · Ctrl/⌘ Z Undo · Ctrl/⌘ Shift+Z or Y Redo · Delete Remove · F Fit timeline · Select a camera key, then Edit in Camera · Ctrl/⌘ S Save</span> : <><span>Draw a hit region, choose animations, then test it with press, hold, drag, and release.</span><span>Ctrl/⌘ K Commands · V Select · H Pan · R Draw · T Test · F Fit canvas · B Bones · Space Play/pause · Esc Idle/Edit</span><span>Ctrl/⌘ Z Undo · Ctrl/⌘ Shift+Z or Y Redo · Ctrl/⌘ D Duplicate · Delete Remove region · Ctrl/⌘ S Save</span></>}<button className="editor-button" onClick={() => setHelp(false)}><IconClose /> Close</button></div>}
        <main className={`editor-layout${leftHidden ? " hide-left" : ""}${rightHidden ? " hide-right" : ""}${!assetLoaded ? " is-loading" : ""}`} style={{ display: workspace !== "interaction" || behaviorMode ? "none" : undefined, position: workspace !== "interaction" ? "absolute" : undefined, visibility: workspace !== "interaction" ? "hidden" : undefined, inset: workspace !== "interaction" ? "100px 0 40px" : undefined, pointerEvents: workspace !== "interaction" ? "none" : undefined, gridTemplateColumns: `${leftHidden ? "" : `${leftWidth}px `}minmax(180px, 1fr)${rightHidden ? "" : ` ${rightWidth}px`}` }}>
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
              <button className={`editor-button${!testing && !lookTesting && tool === "select" ? " active" : ""}`} onClick={() => { setTesting(false); stopLookFollowTest(); setTool("select"); }} title="Select and transform regions (V)"><IconTarget /> Select</button>
              <button className={`editor-button${!testing && !lookTesting && tool === "pan" ? " active" : ""}`} onClick={() => { setTesting(false); stopLookFollowTest(); setTool("pan"); }} title="Drag canvas to pan; wheel to zoom (H)"><IconHand /> Pan</button>
              <button className={`editor-button${!testing && !lookTesting && tool === "draw" ? " active" : ""}`} disabled={!selectedInteraction} onClick={() => { setTesting(false); stopLookFollowTest(); setTool("draw"); setStatus("Click and drag on the canvas to draw a hit region."); }} title="Draw a hit region (R)"><IconPlus /> Draw region</button>
              <button className={`editor-button${testing ? " active test" : ""}`} onClick={toggleTest} disabled={!project} title="Run the full authored interaction (T)">{testing ? <><IconPause /> Test</> : <><IconPlay /> Test</>}</button>
              <button className={`editor-button${lookTesting ? " active test" : ""}`} onClick={toggleLookFollowTest} disabled={lookTesting ? false : !project?.lookFollow.enabled || !frame?.lookFollow} title="Preview look-follow behavior"><IconEye /> Look</button>
              <button className="editor-button" onClick={() => rendererRef.current?.resetCamera()} title="Fit artwork to the canvas (F)"><IconExpand /> Fit canvas</button>
             <details className="editor-overlay-menu">
               <summary className="editor-button"><IconSliders /> Overlays <IconChevronDown /></summary>
              <div className="editor-overlay-menu-popover">
                <div className="editor-overlay-menu-group" role="group" aria-label="Skeleton overlays">
                  <strong className="editor-overlay-menu-heading">Skeleton</strong>
                  <label className="editor-overlay-menu-option" title="Show bone joints and links"><input type="checkbox" checked={displaySettings.showBones} onChange={(event) => updateViewSetting("showBones", event.target.checked)} /><IconBone /><span>Bones</span></label>
                  <label className="editor-overlay-menu-option" title="Show bone names on the canvas"><input type="checkbox" checked={displaySettings.showBoneNames} onChange={(event) => updateViewSetting("showBoneNames", event.target.checked)} /><IconText /><span>Names</span></label>
                  <label className="editor-overlay-menu-option" title="Show skeleton constraints"><input type="checkbox" checked={displaySettings.showConstraints} onChange={(event) => updateViewSetting("showConstraints", event.target.checked)} /><IconLink /><span>Constraints</span></label>
                  <label className="editor-overlay-menu-option" title="Include inactive bones in the bone overlay"><input type="checkbox" checked={displaySettings.showInactiveBones} onChange={(event) => updateViewSetting("showInactiveBones", event.target.checked)} /><IconEyeOff /><span>Inactive bones</span></label>
                </div>
                <div className="editor-overlay-menu-group" role="group" aria-label="Interaction overlays">
                  <strong className="editor-overlay-menu-heading">Interaction</strong>
                  <label className="editor-overlay-menu-option" title="Show and edit interaction regions on the canvas"><input type="checkbox" checked={displaySettings.showInteractionRegions} onChange={(event) => updateViewSetting("showInteractionRegions", event.target.checked)} /><IconTarget /><span>Hit regions</span></label>
                  <label className="editor-overlay-menu-option" title="Show the Look gizmo while editing or previewing Look follow"><input type="checkbox" checked={displaySettings.showLookFollowGizmo} onChange={(event) => updateViewSetting("showLookFollowGizmo", event.target.checked)} /><IconEye /><span>Look gizmo</span></label>
                  <label className="editor-overlay-menu-option" title="Show movement limits while editing or testing an interaction"><input type="checkbox" checked={displaySettings.showMotionGizmo} onChange={(event) => updateViewSetting("showMotionGizmo", event.target.checked)} /><IconAxis /><span>Movement gizmo</span></label>
                </div>
              </div>
            </details>
            <button className="editor-button" onClick={resetPreview} disabled={!meta}>Reset idle</button>
              <button className="editor-button" onClick={() => { setLayoutPreset("custom"); setRightHidden((value) => !value); }} title="Toggle inspector">Inspector <IconMenu /></button>
          </div>
          <div className="editor-stage" ref={stageRef} role="group" aria-label="Interaction canvas" aria-haspopup="menu" aria-keyshortcuts="Shift+F10 ContextMenu" tabIndex={0} onContextMenu={handleInteractionStageContextMenu} onKeyDown={handleInteractionStageKeyDown} onDoubleClick={(event) => { if (!testing && !lookTesting && event.target === canvasRef.current) rendererRef.current?.resetCamera(); }}>
            <canvas ref={canvasRef} aria-label="Spine editor canvas" />
            <BoneOverlay
                frame={frame}
                project={testing && project ? { ...project, selectedRegionId: null, ...(showTestRegions ? {} : { interactions: project.interactions.map((interaction) => ({ ...interaction, regions: [] })) }) } : project}
                viewSettings={renderedViewSettings}
                lookFollowVisible={lookSettingsOpen || lookTesting}
                motionLimits={(testing || movementSettingsOpen) && selectedInteraction ? {
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
                tool={testing || lookTesting ? "pan" : tool}
               onSelectBone={(path) => live((current) => ({ ...current, selectedBonePath: path }))}
                onSelectRegion={selectInteractionRegion}
                onRegionContextMenu={(x, y, interactionId, regionId, returnFocusTo) => openInteractionContextMenuAt(x, y, { kind: "region", interactionId, regionId }, returnFocusTo)}
               onBeginRegionDrag={() => { if (projectRef.current) setUndo((items) => [...items.slice(-49), projectRef.current!]); setRedo([]); }}
               onBeginLookFollowEdit={beginLookFollowEdit}
               onChangeLookFollowRange={changeLookFollowRange}
              onChangeRegion={(interactionId, regionId, patch) => live((current) => ({ ...current, interactions: current.interactions.map((item) => item.id === interactionId ? { ...item, regions: item.regions.map((region) => region.id === regionId ? { ...region, ...patch, placement: "manual" } : region) } : item) }))}
              onDragRegion={(interactionId, regionId, x, y) => live((current) => ({
                ...current,
                interactions: current.interactions.map((interaction) => interaction.id !== interactionId ? interaction : {
                  ...interaction,
                   regions: interaction.regions.map((region) => region.id === regionId ? { ...region, offsetX: x, offsetY: y, placement: "manual" } : region),
                }),
              }))}
             />
            {(testing || lookTesting || tool === "draw") && <div className={`editor-input-surface${testing || lookTesting ? " testing" : " drawing"}`} aria-label={lookTesting ? "Look-follow test surface" : testing ? "Interaction test surface" : "Draw region surface"} onPointerDown={stagePress} onPointerMove={stageMove} onPointerLeave={(event) => {
              if (lookTesting && testPointerRef.current === event.pointerId) rendererRef.current?.setLookFollowPreviewPointer(null, null);
              if (testing && testPointerRef.current === event.pointerId) previewRef.current.leave();
            }} onPointerUp={stageRelease} onPointerCancel={(event) => {
              if (lookTesting && testPointerRef.current === event.pointerId) { testPointerRef.current = null; rendererRef.current?.setLookFollowPreviewPointer(null, null); }
              if (testing && testPointerRef.current === event.pointerId) { testPointerRef.current = null; previewRef.current.release(); }
              drawRef.current = null; setDrawBox(null);
            }} />}
            {drawBox && frame && <svg className="editor-draw-ghost" viewBox={`0 0 ${frame.canvasWidth} ${frame.canvasHeight}`} preserveAspectRatio="none"><ellipse cx={drawBox.x + drawBox.width / 2} cy={drawBox.y + drawBox.height / 2} rx={drawBox.width / 2} ry={drawBox.height / 2} /></svg>}
            {!frame && <div className="editor-empty"><strong>Open a Spine asset folder</strong><span>The desktop editor reads .atlas, .skel, and local texture files from the selected root.</span></div>}
            {frame && <div className="editor-canvas-badge">{frame.animation ?? "No animation"} · {frame.bones.length} bones</div>}
              {(testing || lookTesting || tool !== "select") && <div className="editor-stage-hint">{lookTesting ? "Press and hold, then move to preview gaze · Release to return" : testing ? `${previewStatus} · Press a region, hold/drag, release` : tool === "draw" ? "Drag to draw a new region" : "Drag to pan · Wheel to zoom · F to fit"}</div>}
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
                 <button className="editor-preview-button" disabled={!selectedInteraction || !frame} onClick={() => startSelectedTest()}><IconPlay /> Test selected</button>
                <button className="editor-preview-button" disabled={previewDebug.phase === "idle" || previewDebug.phase === "releasing"} onClick={releaseTest}>Release</button>
                <button className="editor-preview-button" disabled={!selectedInteraction || !frame} onClick={replayTest}>Replay</button>
              </div>
              <label><input type="checkbox" checked={showTestRegions} onChange={(event) => setShowTestRegions(event.target.checked)} /> Hit regions</label>
           </div>}
          <div className="editor-timeline">
            <div className="editor-timeline-top">
                <button className="editor-icon-button" title="Play/pause (Space)" onClick={() => { const next = !playing; setPlaying(next); rendererRef.current?.setPlaying(next); }} disabled={!frame || testing || lookTesting}>{playing ? <IconPause /> : <IconPlay />}</button>
                <AnimationPicker ariaLabel="Preview animation" placeholder={meta && !meta.idleAnimation ? "No idle detected · choose animation" : "Choose animation…"} value={selectedAnimation} options={(meta?.animations ?? []).map((animation) => ({ value: animation, label: animation }))} onChange={(animation) => { setSelectedAnimation(animation); setAnimationSelectionOrigin("explicit"); rendererRef.current?.setAnimation(animation, true); }} disabled={!meta || testing || lookTesting} />
                {animationSelectionOrigin === "automatic" && meta?.idleAnimation && <small className="editor-field-hint">{selectedAnimation === "__intro__" ? `Automatically playing the detected intro, then ${meta.idleAnimation}.` : selectedAnimation === meta.idleAnimation ? `Automatically selected ${meta.idleAnimation} as the detected idle.` : `Detected idle: ${meta.idleAnimation}. Choose an animation explicitly.`}</small>}
              <NumberField label="Speed" value={speed} min={0.1} max={3} step={0.1} precision={1} unit="×" scrub={false} compact onCommit={setSpeed} />
              <span className="editor-time">{progress.time.toFixed(2)} / {progress.duration.toFixed(2)}s</span>
            </div>
              <input aria-label="Animation position" className="editor-range" type="range" min="0" max={Math.max(0.001, progress.duration)} step="0.001" value={Math.min(progress.time, progress.duration)} onChange={(event) => { setPlaying(false); rendererRef.current?.seek(Number(event.target.value)); }} disabled={!frame || testing || lookTesting} />
          </div>
        </section>

        <aside className="editor-panel editor-right-panel" hidden={!assetLoaded || rightHidden}>
          <section className="editor-section editor-interactions-section">
             <div className="editor-section-title"><strong>Interactions</strong><button onClick={addInteraction} disabled={!project || !frame}><IconPlus /> Add</button></div>
            <input className="editor-search" value={interactionSearch} onChange={(event) => setInteractionSearch(event.target.value)} placeholder="Filter interactions…" />
             <div className="editor-interaction-list">
              {visibleInteractions.map((item) => <button key={item.id} className={item.id === project?.selectedInteractionId ? "is-selected" : ""} aria-haspopup="menu" onClick={() => selectInteraction(item.id)} onContextMenu={(event) => openInteractionContextMenu(event, { kind: "interaction", interactionId: item.id })} onKeyDown={(event) => openInteractionKeyboardMenu(event, { kind: "interaction", interactionId: item.id })}><i style={{ background: item.color }} />{item.name}<small>{item.regions.length} region{item.regions.length === 1 ? "" : "s"}</small></button>)}
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
              <details className="editor-interaction-settings" open={interactionSettingsOpen} onToggle={(event) => setInteractionSettingsOpen(event.currentTarget.open)}>
                <summary>Animation and movement</summary>
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
               <details className="editor-movement-settings" open={movementSettingsOpen} onToggle={(event) => setMovementSettingsOpen(event.currentTarget.open)}>
                <summary>Movement response</summary>
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
               </details>
                </div>
              </details>
              <div className="editor-region-fields">
              <div className="editor-subheading editor-region-heading"><span>Hit regions</span><button onClick={addRegion}><IconPlus /> Add region</button></div>
             <div className="editor-region-list">
              {selectedInteraction.regions.map((region) => <button key={region.id} className={region.id === project?.selectedRegionId ? "is-selected" : ""} aria-haspopup="menu" onClick={() => live((current) => ({ ...current, selectedRegionId: region.id }))} onContextMenu={(event) => openInteractionContextMenu(event, { kind: "region", interactionId: selectedInteraction.id, regionId: region.id })} onKeyDown={(event) => openInteractionKeyboardMenu(event, { kind: "region", interactionId: selectedInteraction.id, regionId: region.id })}><i style={{ background: selectedInteraction.color }} />{region.name}<small>{region.shape}</small></button>)}
              {!selectedInteraction.regions.length && <p className="editor-muted">No hit regions. Add one to make this interaction clickable.</p>}
             </div>
              </div>
            </section>}
            {project && <details className="editor-section editor-look-settings" open={lookSettingsOpen} onToggle={(event) => setLookSettingsOpen(event.currentTarget.open)}>
              <summary>Look-follow</summary>
              <section className="editor-look-inspector">
              <div className="editor-section-title">
                <strong>Look-follow</strong>
                <label className="timeline-inline-check"><input type="checkbox" checked={project.lookFollow.enabled} onChange={(event) => updateLookFollow("enabled", event.target.checked)} /> Enabled</label>
              </div>
              <p className="editor-muted">When the pointer is held, the selected rig controller follows within its range. Null ranges use the runtime’s rig-scaled defaults.</p>
              <BonePicker
                label="Look target"
                bones={frame?.bones ?? []}
                value={project.lookFollow.targetBonePath}
                noneLabel="Automatic Touch_Eye target"
                selectedPath={project.selectedBonePath}
                onChange={(path) => updateLookFollow("targetBonePath", path)}
                onReveal={revealBonePath}
              />
              {!frame?.lookFollow && <p className="editor-field-hint">No look controller is currently resolved. Choose a target bone above, or use a rig with a Touch_Eye bone.</p>}
              <div className="editor-subheading">Pointer response</div>
              <div className="editor-two-fields">
                <BoundedSliderField label="Hold delay" value={project.lookFollow.delay} defaultValue={0.3} min={0} max={2} step={0.05} precision={2} unit="s" onCommit={(value) => updateLookFollow("delay", value)} />
                <BoundedSliderField label="Smoothing" value={project.lookFollow.smoothing} defaultValue={14} min={1} max={30} step={0.5} precision={1} onCommit={(value) => updateLookFollow("smoothing", value)} />
              </div>
              <small className="editor-field-hint">Higher smoothing values follow the pointer faster.</small>
              <div className="editor-axis-checks" aria-label="Look-follow axes">
                <span>Follow axes</span>
                <label><input type="checkbox" checked={project.lookFollow.allowX} onChange={(event) => updateLookFollow("allowX", event.target.checked)} /> X</label>
                <label><input type="checkbox" checked={project.lookFollow.allowY} onChange={(event) => updateLookFollow("allowY", event.target.checked)} /> Y</label>
              </div>
              <div className="editor-subheading">Movement range</div>
              <p className="editor-field-hint">Drag the gizmo handles on the canvas or enter explicit limits. Reset a limit to return to automatic scaling.</p>
              <div className="editor-look-range-row">
                <NumberField label={`Range X${project.lookFollow.rangeX === null ? " · auto" : ""}`} value={project.lookFollow.rangeX ?? frame?.lookFollow?.rangeX ?? 0} min={0} max={512} step={1} precision={1} unit="units" onCommit={(value) => updateLookFollow("rangeX", value)} />
                <button type="button" className="editor-preview-button" disabled={project.lookFollow.rangeX === null} onClick={() => updateLookFollow("rangeX", null)}>Use auto</button>
              </div>
              <div className="editor-look-range-row">
                <NumberField label={`Range Y${project.lookFollow.rangeY === null ? " · auto" : ""}`} value={project.lookFollow.rangeY ?? frame?.lookFollow?.rangeY ?? 0} min={0} max={512} step={1} precision={1} unit="units" onCommit={(value) => updateLookFollow("rangeY", value)} />
                <button type="button" className="editor-preview-button" disabled={project.lookFollow.rangeY === null} onClick={() => updateLookFollow("rangeY", null)}>Use auto</button>
              </div>
              <div className="editor-subheading">Local rotation</div>
              <p className="editor-field-hint">Rotate the same Look target using pointer displacement on its parent-local X or Y axis.</p>
              <div className="editor-axis-checks" aria-label="Look-follow rotation">
                <span>Rotation input</span>
                <label><input type="checkbox" checked={project.lookFollow.rotationEnabled} onChange={(event) => updateLookFollow("rotationEnabled", event.target.checked)} /> Enabled</label>
                <label>Axis<select value={project.lookFollow.rotationAxis} disabled={!project.lookFollow.rotationEnabled} onChange={(event) => updateLookFollow("rotationAxis", event.target.value as "x" | "y")}><option value="x">X</option><option value="y">Y</option></select></label>
              </div>
              <div className="editor-two-fields">
                <NumberField label="Minimum rotation" value={project.lookFollow.rotationMin} min={-180} max={0} step={1} precision={1} unit="°" disabled={!project.lookFollow.rotationEnabled} onCommit={(value) => updateLookFollow("rotationMin", value)} />
                <NumberField label="Maximum rotation" value={project.lookFollow.rotationMax} min={0} max={180} step={1} precision={1} unit="°" disabled={!project.lookFollow.rotationEnabled} onCommit={(value) => updateLookFollow("rotationMax", value)} />
              </div>
              <div className="editor-subheading">Animation overrides</div>
              <p className="editor-field-hint">Leave these on automatic to detect Look and LookEnd animation names from the Spine asset.</p>
              {([
                ["startAnimation", "Look main"],
                ["faceStartAnimation", "Look face"],
                ["endAnimation", "Look-end main"],
                ["faceEndAnimation", "Look-end face"],
              ] as const).map(([field, label]) => <label key={field}>{label}
                <select value={project.lookFollow[field]} onChange={(event) => updateLookFollow(field, event.target.value)}>
                  <option value="">Automatic</option>
                  {project.lookFollow[field] && !meta?.animations.includes(project.lookFollow[field]) && <option value={project.lookFollow[field]}>Missing: {project.lookFollow[field]}</option>}
                  {(meta?.animations ?? []).map((animation) => <option key={animation} value={animation}>{animation}</option>)}
                </select>
              </label>)}
              <button type="button" className="editor-preview-button" disabled={lookTesting ? false : !project.lookFollow.enabled || !frame?.lookFollow} onClick={toggleLookFollowTest}>
                <IconEye /> {lookTesting ? "Stop look preview" : "Preview look-follow"}
              </button>
              </section>
            </details>}
            {selectedRegion && selectedInteraction && <section className="editor-section editor-inspector">
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
      {workspace === "interaction" && behaviorMode && assetLoaded && project && <BehaviorEditor
        machines={project.behaviorMachines ?? []}
        graphLayouts={project.behaviorGraphLayouts}
        animations={meta?.animations ?? []}
        debug={behaviorDebug}
        testFeedback={Object.values(behaviorActionFeedback)}
        onChange={(behaviorMachines) => mutate((current) => ({
          ...current,
          behaviorMachines,
          behaviorGraphLayouts: normalizeBehaviorGraphLayouts(current.behaviorGraphLayouts, behaviorMachines),
        }))}
        onGraphLayoutChange={(machineId, layout) => mutate((current) => ({
          ...current,
          behaviorGraphLayouts: { ...current.behaviorGraphLayouts, [machineId]: layout },
        }))}
        onShowCharacterPreview={() => setBehaviorMode(false)}
        onTestEvent={(machineId, event, regionId) => rendererRef.current?.testBehaviorEvent(machineId, event, regionId)}
        onCancelTest={() => rendererRef.current?.cancelBehaviorTest()}
      />}
      {workspace !== "interaction" && assetLoaded && <TimelineWorkspace mode={workspace} onWorkspaceChange={setWorkspace} source={source} directory={directory} directories={directories} directoryLabels={directoryLabels} directoryInfo={directoryInfo} project={project} initialHandoff={initialTimelineHandoff} initialSubtitlePath={pendingSubtitlePath} onSubtitleOpened={() => setPendingSubtitlePath(null)} initialAudioPaths={pendingAudioPaths} onAudioOpened={() => setPendingAudioPaths(null)} onRecentFile={recordRecentFile} onMutate={mutate} onLive={live} onSelectProject={updateProjectSelection} onBeginEdit={beginTimelineEdit} onBeginCameraEdit={beginCameraEdit} onEndCameraEdit={endCameraEdit} onCancelCameraEdit={cancelCameraEdit} onSave={() => saveProject()} onRegisterSave={(callback) => { timelineSaveRef.current = callback; }} onStatus={setStatus} onError={setError} onRegisterMcp={registerMcpTimeline} onMcpSnapshot={publishTimelineMcpSnapshot} onAudioWaveformProfile={__EDITOR_WAVEFORM_PROFILE__ ? (clipId: string, measurement: AudioWaveformMeasurement) => waveformProfileRef.current?.recordStage(clipId, measurement) : undefined} />}
      <footer className="editor-statusbar">
        <span className={error ? "editor-error" : legacyAspectRatioNotice ? "editor-compatibility-warning" : ""} role={legacyAspectRatioNotice && !error ? "status" : undefined}>{error ?? (legacyAspectRatioNotice ? "Legacy 1:1 camera framing is shown as 16:9. Save to update the project." : status)}</span>
         <span>{directory ? `${displayName(directory)} · ${files?.size ?? 0} files` : "No asset loaded"} · {testing ? "TEST MODE" : workspace === "camera" ? "CAMERA" : workspace === "timeline" ? "TIMELINE" : behaviorMode ? "BEHAVIOR GRAPH" : "EDIT MODE"}</span>
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
