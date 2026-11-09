import { normalizeSpineColorLayers, type SpineTimelineAnimationClip, type SpineTimelineColorLayer } from "@ba-spine/spine-runtime/spine/spineTimeline";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { DEFAULT_INTERACTION_PHASE_MIX, DEFAULT_INTERACTION_RETURN_DURATION, DEFAULT_INTERACTION_RETURN_EASING, DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, DEFAULT_TALK_MIX_DURATION, findInteractionProfile, normalizeSpineLookFollowSettings, type SpineInteractionReturnEasing, type SpineLookFollowSettings } from "@ba-spine/spine-runtime/spine/spineInteraction";
import { cheekControlNames } from "@ba-spine/spine-runtime/spine/spinePinch";
import { normalizeSpineCameraTrack, type SpineCameraTrack } from "@ba-spine/spine-runtime/spine/spineCameraMotion";
import { DEFAULT_EFFECTS_STRENGTH } from "@ba-spine/spine-runtime/spine/spineEffects";
import { migrateLegacyInteractionsToBehaviors, normalizeSpineBehaviorMachines, type SpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { normalizeBehaviorGraphLayouts, type BehaviorGraphLayouts } from "./behaviorGraph";

export const EDITOR_SCHEMA_VERSION = 8;
export const LEGACY_EDITOR_SCHEMA_VERSION = 1;

export type EditorTrigger = "press" | "hold" | "drag";
export type EditorShape = "ellipse" | "rectangle";

export interface EditorRegion {
  id: string;
  name: string;
  enabled: boolean;
  shape: EditorShape;
  anchorBone: string | null;
  offsetX: number;
  offsetY: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
  placement?: "head-v1" | "cheek-v1" | "needs-head" | "manual";
}

export interface EditorInteraction {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
  trigger: EditorTrigger;
  startAnimation: string;
  followAnimation: string;
  endAnimation: string;
  faceStartAnimation: string;
  faceFollowAnimation: string;
  faceEndAnimation: string;
  followTargetBone: string | null;
  sensitivity: number;
  limitX: number;
  limitY: number;
  smoothing: number;
  returnDuration: number;
  returnEasing: SpineInteractionReturnEasing;
  startMixDuration: number;
  followMixDuration: number;
  releaseMixDuration: number;
  allowX: boolean;
  allowY: boolean;
  rotationEnabled: boolean;
  rotationAxis: "x" | "y";
  rotationMin: number;
  rotationMax: number;
  regions: EditorRegion[];
}

export type TimelineLayerRole = "character" | "scene" | "background" | "overlay";
export type TimelineLanguage = "en" | "ja" | "ko";

export interface EditorAnimationClip extends SpineTimelineAnimationClip {}

export interface EditorTimelineLayer {
  endMode?: "auto" | "manual";
  faceAnimation?: string;
  followMainAnimation?: boolean;
  id: string;
  name: string;
  role: TimelineLayerRole;
  directory: string;
  enabled: boolean;
  locked?: boolean;
  blendMode?: "normal" | "multiply" | "screen" | "additive";
  animation: string;
  animationClips?: EditorAnimationClip[];
  start: number;
  end: number;
  animationOffset: number;
  loop: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  order: number;
}

export interface EditorColorLayer extends SpineTimelineColorLayer {}

export interface EditorSubtitleCue {
  lineId?: string;
  id: string;
  start: number;
  end: number;
  enabled: boolean;
  text: Record<TimelineLanguage, string>;
}

export interface EditorAudioClip {
  autoEnd?: boolean;
  lineId?: string;
  /** Explicit one-to-one subtitle link; null disables the legacy lineId link. */
  subtitleId?: string | null;
  id: string;
  name: string;
  path: string;
  start: number;
  end: number;
  enabled: boolean;
  volume: number;
}

export interface EditorTimeline {
  sequenceId?: string;
  subtitlePath?: string;
  openingMode?: "scene-first" | "direct" | "skip";
  sceneDuration?: number;
  openingIdleDuration?: number;
  durationMode?: "auto" | "manual";
  /** Once true, a missing discovered layer is an intentional deletion. */
  layersInitialized: boolean;
  duration: number;
  loop: boolean;
  /** Root-relative Spine set directories for every layer in this sequence. */
  assetPaths?: Record<string, string>;
  layers: EditorTimelineLayer[];
  colorLayers: EditorColorLayer[];
  subtitles: EditorSubtitleCue[];
  audio: EditorAudioClip[];
  selectedLayerId: string | null;
  selectedCueId: string | null;
  selectedColorLayerId: string | null;
  selectedColorClipId: string | null;
  language: TimelineLanguage;
  snap: number;
  camera?: SpineCameraTrack;
}

export interface EditorProject {
  sequences?: Record<string, EditorTimeline>;
  /** Authored display/playback order; Opening is always normalized to index zero. */
  sequenceOrder?: string[];
  /** Prevent animation-discovered sequences from reappearing after intentional deletion. */
  deletedSequenceIds?: string[];
  talkMixDuration: number;
  effectsStrength: number;
  schemaVersion: number;
  name: string;
  assetDirectory: string;
  /** Explicit authored entry sequence; null means the runtime intro is used. */
  entrySequence?: string | null;
  lookFollow: SpineLookFollowSettings;
  interactions: EditorInteraction[];
  /** Canonical behavior-machine model; generated legacy machines remain linked until edited. */
  behaviorMachines?: SpineBehaviorMachine[];
  /** Editor-only graph placement; kept separate from executable behavior data. */
  behaviorGraphLayouts: BehaviorGraphLayouts;
  selectedInteractionId: string | null;
  selectedRegionId: string | null;
  selectedBonePath: string | null;
  showBones: boolean;
  showBoneNames: boolean;
  showConstraints: boolean;
  showInactiveBones: boolean;
  timeline: EditorTimeline;
}

export type EditorViewSettings = Pick<EditorProject, "showBones" | "showBoneNames" | "showConstraints" | "showInactiveBones">;

export const DEFAULT_EDITOR_VIEW_SETTINGS: EditorViewSettings = {
  showBones: false,
  showBoneNames: false,
  showConstraints: false,
  showInactiveBones: false,
};

export const EDITOR_VIEW_SETTINGS_KEY = "shittim-spine-editor:view-settings:v3";

export const LEGACY_PROJECT_STORAGE_PREFIX = `shittim-spine-editor:v${LEGACY_EDITOR_SCHEMA_VERSION}:`;

export function viewSettingsFromProject(project: Pick<EditorProject, keyof EditorViewSettings>): EditorViewSettings {
  return {
    showBones: project.showBones,
    showBoneNames: project.showBoneNames,
    showConstraints: project.showConstraints,
    showInactiveBones: project.showInactiveBones,
  };
}

export function normalizeViewSettings(value: unknown): EditorViewSettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Partial<EditorViewSettings>;
  return {
    showBones: settings.showBones === true,
    showBoneNames: settings.showBoneNames === true,
    showConstraints: settings.showConstraints === true,
    showInactiveBones: settings.showInactiveBones === true,
  };
}

export type EditorValidationKind = "missing-animation" | "missing-bone" | "overlap" | "head-detection";

export interface EditorValidationWarning {
  id: string;
  kind: EditorValidationKind;
  interactionId: string;
  regionId: string | null;
  otherInteractionId?: string;
  otherRegionId?: string;
  message: string;
}

const COLORS = ["#28c7ed", "#ff668f", "#ffc857", "#a78bfa", "#61d095", "#ff9f43"];

function id(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function exact(animations: string[], name: string): string {
  return animations.find((animation) => animation.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? "";
}

function faceVariant(animations: string[], main: string): string {
  if (!main) return "";
  const candidates = [main.replace(/_m(?=_|$)/i, "_A"), `${main}_A`].filter((candidate) => candidate !== main);
  return candidates.map((candidate) => exact(animations, candidate)).find(Boolean) ?? "";
}

function first(animations: string[], pattern: RegExp): string {
  return animations.find((animation) => pattern.test(animation)) ?? "";
}

function nextAnimation(animations: string[], start: string): string {
  if (!start) return "";
  const match = start.match(/^(.*?)(\d+)(?=_[A-Za-z]+$|$)/);
  if (!match) return start;
  const next = `${match[1]}${String(Number(match[2]) + 1).padStart(match[2].length, "0")}${start.slice(match[0].length)}`;
  return exact(animations, next) || start;
}

function endAnimation(animations: string[], start: string, kind: string): string {
  if (!start) return "";
  const base = start.split("/").pop() ?? start;
  const directory = start.includes("/") ? `${start.slice(0, start.lastIndexOf("/") + 1)}` : "";
  const variants = kind === "touch"
    ? [base.replace(/^touch/i, "TouchEnd"), base.replace(/^touch/i, "Touch_End")]
    : kind === "pinch"
      ? [base.replace(/^pinch/i, "PinchEnd"), base.replace(/^pinch/i, "Pinch_End")]
      : [base.replace(/^pat2/i, "Pat2End"), base.replace(/^pat/i, "PatEnd"), base.replace(/^pat2/i, "PatEnd2")];
  return variants
    .filter((candidate) => candidate !== base)
    .map((candidate) => exact(animations, candidate) || exact(animations, `${directory}${candidate}`))
    .find(Boolean) ?? "";
}

function findBone(bones: SpineEditorBone[], pattern: RegExp): SpineEditorBone | undefined {
  return bones.find((bone) => pattern.test(bone.name));
}

function findTouchTargetBone(bones: SpineEditorBone[]): SpineEditorBone | undefined {
  return bones.find((bone) => /^touch[ _-]?point[ _-]?key$/i.test(bone.name))
    ?? bones.find((bone) => /^touch[ _-]?point$/i.test(bone.name))
    ?? findBone(bones, /^touch[ _-]?point(?:[ _-]?key)?$/i);
}

/** Prefer the named left/right cheek controls, including rigs that call them chin bones. */
export function cheekRegionBones(bones: SpineEditorBone[]): SpineEditorBone[] {
  const names = cheekControlNames(bones.map((bone) => ({ name: bone.name, parentName: bone.parentPath?.split("/").pop() ?? null })));
  return names.map((name) => bones.find((bone) => bone.name === name)!);
}

function region(name: string, anchorBone: SpineEditorBone | undefined): EditorRegion {
  return {
    id: id("region"),
    name,
    enabled: true,
    shape: "ellipse",
    anchorBone: anchorBone?.path ?? null,
    offsetX: 0,
    offsetY: 0,
    radiusX: 120,
    radiusY: 90,
    rotation: 0,
  };
}

function interaction(
  name: string,
  kind: string,
  animations: string[],
  bones: SpineEditorBone[],
  colorIndex: number,
): EditorInteraction {
  const detected = kind === "touch" || kind === "pinch" || kind === "pat" ? findInteractionProfile(animations)[kind] : null;
  const start = kind === "custom" ? "" : detected?.start.main ?? (kind === "touch"
    ? exact(animations, "Touch_01_M") || first(animations, /^touch[_ -]?\d+_m/i)
    : kind === "pinch"
      ? exact(animations, "Pinch_01_M") || exact(animations, "Pinch_01") || first(animations, /^pinch[_ -]?\d+/i)
       : exact(animations, "Pat_01_M") || first(animations, /(?:^|\/)pat(?:2)?[_ -]?\d+_m/i));
  const anchor = findTouchTargetBone(bones) ?? bones[0];
  const cheekBones = cheekRegionBones(bones);
  const regions = kind === "pinch"
    ? (cheekBones.length > 0 ? cheekBones.map((bone, index) => ({ ...region(cheekBones.length === 1 ? "Cheek area" : index === 0 ? "Left cheek" : "Right cheek", bone), placement: "cheek-v1" as const })) : [region("Cheek area", anchor)])
    : [region(kind === "touch" ? "Touch area" : "Patting area", anchor)];
  return {
    id: id("interaction"),
    name,
    color: COLORS[colorIndex % COLORS.length]!,
    enabled: true,
    trigger: "hold",
    startAnimation: start,
    followAnimation: detected?.follow.main ?? nextAnimation(animations, start),
    endAnimation: detected?.release?.main ?? endAnimation(animations, start, kind),
    faceStartAnimation: detected?.start.face ?? faceVariant(animations, start),
    faceFollowAnimation: detected?.follow.face ?? faceVariant(animations, nextAnimation(animations, start)),
    faceEndAnimation: detected?.release?.face ?? faceVariant(animations, endAnimation(animations, start, kind)),
    followTargetBone: anchor?.path ?? null,
    sensitivity: 0.25,
    limitX: 90,
    limitY: 65,
    smoothing: 8,
    returnDuration: DEFAULT_INTERACTION_RETURN_DURATION,
    returnEasing: DEFAULT_INTERACTION_RETURN_EASING,
    startMixDuration: DEFAULT_INTERACTION_PHASE_MIX,
    followMixDuration: DEFAULT_INTERACTION_PHASE_MIX,
    releaseMixDuration: DEFAULT_INTERACTION_PHASE_MIX,
    allowX: true,
    allowY: true,
    rotationEnabled: false,
    rotationAxis: "x",
    rotationMin: -15,
    rotationMax: 15,
    regions,
  };
}

function compositionStem(directory: string): string {
  return directory
    .replace(/(?:_home)?_(?:bg|scene)$/i, "")
    .replace(/_home$/i, "")
    .toLocaleLowerCase();
}

function roleForCompositionDirectory(directory: string): TimelineLayerRole | null {
  if (/_scene$/i.test(directory)) return "scene";
  if (/_bg$/i.test(directory)) return "background";
  return null;
}

function layerId(role: TimelineLayerRole, directory: string): string {
  return `timeline-${role}-${directory.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function defaultLayerOrder(role: TimelineLayerRole): number {
  return role === "background" ? 0 : role === "scene" ? 1 : role === "character" ? 2 : 3;
}

export function createTimelineLayer(directory: string, role: TimelineLayerRole, order: number, duration = 12): EditorTimelineLayer {
  return {
    id: layerId(role, directory),
    name: directory,
    role,
    directory,
    enabled: true,
    locked: false,
    blendMode: "normal",
    animation: "",
    followMainAnimation: role === "background",
    start: 0,
    end: Math.max(1, duration),
    endMode: "auto",
    animationOffset: 0,
    loop: true,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    order,
  };
}

/** Find the sibling Spine sets that make up a lobby composition. */
export function compositionDirectories(directory: string, directories: string[]): Array<{ directory: string; role: TimelineLayerRole }> {
  const stem = compositionStem(directory);
  const matching = directories.filter((candidate) => compositionStem(candidate) === stem);
  const selectedRole = roleForCompositionDirectory(directory);
  const character = selectedRole === null
    ? directory
    : matching.find((candidate) => roleForCompositionDirectory(candidate) === null && /_home$/i.test(candidate))
      ?? matching.find((candidate) => roleForCompositionDirectory(candidate) === null)
      ?? directory;
  const result: Array<{ directory: string; role: TimelineLayerRole }> = [{ directory: character, role: "character" }];
  const siblings = matching
    .filter((candidate) => candidate !== character)
    .flatMap((candidate) => {
      const role = roleForCompositionDirectory(candidate);
      return role ? [{ directory: candidate, role }] : [];
    });
  return [...result, ...siblings].sort((a, b) => defaultLayerOrder(a.role) - defaultLayerOrder(b.role) || a.directory.localeCompare(b.directory));
}

export function ensureTimelineLayers(timeline: EditorTimeline, directory: string, directories: string[]): EditorTimeline {
  if (timeline.layersInitialized) return timeline;
  const discovered = compositionDirectories(directory, directories);
  const layers = [...timeline.layers];
  for (const item of discovered) {
    if (layers.some((layer) => layer.directory === item.directory)) continue;
    const usedOrders = new Set([...layers.map((layer) => layer.order), ...timeline.colorLayers.map((layer) => layer.order)]);
    let order = defaultLayerOrder(item.role);
    while (usedOrders.has(order)) order += 1;
    layers.push(createTimelineLayer(item.directory, item.role, order, timeline.duration));
  }
  return { ...timeline, layers, layersInitialized: true };
}

function createTimeline(directory: string): EditorTimeline {
  const duration = 12;
  const character = createTimelineLayer(directory, "character", defaultLayerOrder("character"), duration);
  return {
    duration,
    openingMode: "direct",
    sceneDuration: 3,
    openingIdleDuration: 3,
    durationMode: "manual",
    layersInitialized: false,
    loop: true,
    layers: [character],
    colorLayers: [],
    subtitles: [],
    audio: [],
    selectedLayerId: character.id,
    selectedCueId: null,
    selectedColorLayerId: null,
    selectedColorClipId: null,
    language: "en",
    snap: 0.1,
  };
}

export function createProject(directory: string, animations: string[], bones: SpineEditorBone[]): EditorProject {
  const interactions: EditorInteraction[] = [];
  const profile = findInteractionProfile(animations);
  if (profile.touch) interactions.push(interaction("Touch", "touch", animations, bones, interactions.length));
  if (profile.pinch) interactions.push(interaction("Cheek pinch", "pinch", animations, bones, interactions.length));
  if (profile.pat) interactions.push(interaction("Patting", "pat", animations, bones, interactions.length));
  if (interactions.length === 0) interactions.push(interaction("New interaction", "custom", animations, bones, 0));
  const behaviorMachines = migrateLegacyInteractionsToBehaviors(interactions, DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS);
  return {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    deletedSequenceIds: [],
    talkMixDuration: DEFAULT_TALK_MIX_DURATION,
    effectsStrength: DEFAULT_EFFECTS_STRENGTH,
    name: `${directory} interactions`,
    assetDirectory: directory,
    lookFollow: { ...DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS },
    interactions,
    behaviorMachines,
    behaviorGraphLayouts: normalizeBehaviorGraphLayouts(null, behaviorMachines),
    selectedInteractionId: interactions[0]?.id ?? null,
    selectedRegionId: interactions[0]?.regions[0]?.id ?? null,
    selectedBonePath: bones[0]?.path ?? null,
    ...DEFAULT_EDITOR_VIEW_SETTINGS,
    timeline: createTimeline(directory),
  };
}

export function blankInteraction(animations: string[], bones: SpineEditorBone[], index: number): EditorInteraction {
  return interaction(`Interaction ${index + 1}`, "custom", animations, bones, index);
}

export function blankRegion(anchorBone: SpineEditorBone | undefined, index: number): EditorRegion {
  return { ...region(`Region ${index + 1}`, anchorBone), radiusX: 100, radiusY: 75 };
}

function timelineRole(value: unknown): TimelineLayerRole {
  return value === "scene" || value === "background" || value === "overlay" ? value : "character";
}

function timelineLanguage(value: unknown): TimelineLanguage {
  return value === "ja" || value === "ko" ? value : "en";
}

function normalizeText(value: unknown): Record<TimelineLanguage, string> {
  if (!value || typeof value !== "object") return { en: "", ja: "", ko: "" };
  const text = value as Record<string, unknown>;
  const stringValueFor = (key: string, fallback = "") => typeof text[key] === "string" ? text[key] as string : fallback;
  return {
    en: stringValueFor("en", stringValueFor("EN")),
    ja: stringValueFor("ja", stringValueFor("JA", stringValueFor("JR"))),
    ko: stringValueFor("ko", stringValueFor("KO", stringValueFor("KR"))),
  };
}

function normalizeTimelineLayer(value: Partial<EditorTimelineLayer>, index: number, duration: number): EditorTimelineLayer | null {
  const directory = stringValue(value.directory, "");
  if (!directory) return null;
  const role = timelineRole(value.role);
  const start = finiteNumber(value.start, 0, 0);
  const end = Math.max(start + 0.01, finiteNumber(value.end, duration, 0));
  return {
    id: stringValue(value.id, id("timeline-layer")),
    name: stringValue(value.name, directory),
    role,
    directory,
    enabled: value.enabled !== false,
    locked: value.locked === true,
    blendMode: value.blendMode === "multiply" || value.blendMode === "screen" || value.blendMode === "additive" ? value.blendMode : "normal",
    animation: stringValue(value.animation, ""),
    ...(Array.isArray(value.animationClips) ? { animationClips: value.animationClips.filter((clip) => Boolean(clip && typeof clip === "object")).map((clip, clipIndex) => normalizeAnimationClip(clip, index, clipIndex)) } : {}),
    faceAnimation: stringValue(value.faceAnimation, ""),
    followMainAnimation: value.followMainAnimation === undefined ? role === "background" : value.followMainAnimation === true,
    start,
    end,
    endMode: value.endMode === "manual" ? "manual" : "auto",
    animationOffset: finiteNumber(value.animationOffset, 0, 0),
    loop: value.loop !== false,
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    scale: finiteNumber(value.scale, 1, 0.01),
    opacity: Math.max(0, Math.min(1, finiteNumber(value.opacity, 1, 0))),
    order: finiteNumber(value.order, index, 0),
  };
}

function normalizeAnimationClip(value: unknown, layerIndex: number, clipIndex: number): EditorAnimationClip {
  const clip = value as Partial<EditorAnimationClip>;
  const start = finiteNumber(clip.start, 0, 0);
  return {
    id: stringValue(clip.id, `timeline-layer-${layerIndex + 1}-clip-${clipIndex + 1}`),
    animation: stringValue(clip.animation, ""),
    ...(typeof clip.faceAnimation === "string" ? { faceAnimation: clip.faceAnimation } : {}),
    start,
    end: Math.max(start + 0.01, finiteNumber(clip.end, start + 1, 0)),
    endMode: clip.endMode === "manual" ? "manual" : "auto",
    animationOffset: finiteNumber(clip.animationOffset, 0, 0),
    loop: clip.loop === true,
    ...(typeof clip.enabled === "boolean" ? { enabled: clip.enabled } : {}),
    ...(typeof clip.continueAfterOpening === "boolean" ? { continueAfterOpening: clip.continueAfterOpening } : {}),
    ...(typeof clip.hideCharacter === "boolean" ? { hideCharacter: clip.hideCharacter } : {}),
  };
}

function normalizeSubtitleCue(value: Partial<EditorSubtitleCue>, index: number, duration: number): EditorSubtitleCue {
  const start = Math.max(0, finiteNumber(value.start, Math.min(index * 2, duration), 0));
  return {
    id: stringValue(value.id, id("subtitle")),
    start,
    end: Math.max(start + 0.01, finiteNumber(value.end, Math.min(duration, start + 2), 0)),
    enabled: value.enabled !== false,
    text: normalizeText(value.text),
    lineId: typeof value.lineId === "string" ? value.lineId : undefined,
  };
}

function normalizeAudioClip(value: Partial<EditorAudioClip>, index: number, duration: number): EditorAudioClip | null {
  const path = stringValue(value.path, "");
  if (!path) return null;
  const start = Math.max(0, finiteNumber(value.start, 0, 0));
  return {
    id: stringValue(value.id, id("audio")),
    name: stringValue(value.name, path.split("/").pop() ?? path),
    path,
    autoEnd: value.autoEnd === true,
    lineId: typeof value.lineId === "string" ? value.lineId : undefined,
    ...(typeof value.subtitleId === "string" || value.subtitleId === null ? { subtitleId: value.subtitleId } : {}),
    start,
    end: Math.max(start + 0.01, finiteNumber(value.end, Math.min(duration, start + 2), 0)),
    enabled: value.enabled !== false,
    volume: Math.max(0, Math.min(1, finiteNumber(value.volume, 1, 0))),
  };
}

function collapseDuplicateSubtitles(cues: EditorSubtitleCue[]): EditorSubtitleCue[] {
  const result: EditorSubtitleCue[] = [];
  const indexes = new Map<string, number>();
  for (const cue of cues) {
    if (!cue.lineId) {
      result.push(cue);
      continue;
    }
    const key = `${cue.lineId}\u0000${cue.start.toFixed(6)}\u0000${cue.text.en}\u0000${cue.text.ja}\u0000${cue.text.ko}`;
    const previousIndex = indexes.get(key);
    if (previousIndex === undefined) {
      indexes.set(key, result.length);
      result.push(cue);
    } else if (cue.end > result[previousIndex]!.end) {
      result[previousIndex] = cue;
    }
  }
  return result;
}

function collapseDuplicateAudio(clips: EditorAudioClip[]): EditorAudioClip[] {
  const result: EditorAudioClip[] = [];
  const indexes = new Map<string, number>();
  for (const clip of clips) {
    if (!clip.lineId) {
      result.push(clip);
      continue;
    }
    const key = `${clip.lineId}\u0000${clip.start.toFixed(6)}`;
    const previousIndex = indexes.get(key);
    if (previousIndex === undefined) {
      indexes.set(key, result.length);
      result.push(clip);
    } else if (clip.end > result[previousIndex]!.end) {
      result[previousIndex] = clip;
    }
  }
  return result;
}

export function normalizeTimeline(value: unknown, directory: string): EditorTimeline {
  if (!value || typeof value !== "object") return createTimeline(directory);
  const raw = value as Partial<EditorTimeline>;
  const duration = Math.max(1, finiteNumber(raw.duration, 12, 0));
  const layers = (Array.isArray(raw.layers) ? raw.layers as unknown[] : [])
    .filter((item) => Boolean(item && typeof item === "object"))
    .map((item, index) => normalizeTimelineLayer(item as Partial<EditorTimelineLayer>, index, duration))
    .filter((item): item is EditorTimelineLayer => item !== null);
  const subtitles = collapseDuplicateSubtitles((Array.isArray(raw.subtitles) ? raw.subtitles as unknown[] : [])
    .filter((item) => Boolean(item && typeof item === "object"))
    .map((item, index) => normalizeSubtitleCue(item as Partial<EditorSubtitleCue>, index, duration)));
  const colorLayers = normalizeSpineColorLayers(raw.colorLayers);
  const audio = collapseDuplicateAudio((Array.isArray(raw.audio) ? raw.audio as unknown[] : [])
    .filter((item) => Boolean(item && typeof item === "object"))
    .map((item, index) => normalizeAudioClip(item as Partial<EditorAudioClip>, index, duration))
    .filter((item): item is EditorAudioClip => item !== null))
    .map((clip) => clip.subtitleId && !subtitles.some((cue) => cue.id === clip.subtitleId) ? { ...clip, subtitleId: null } : clip);
  const selectedColorClipLayer = typeof raw.selectedColorClipId === "string"
    ? colorLayers.find((layer) => layer.clips.some((clip) => clip.id === raw.selectedColorClipId))
    : undefined;
  const selectedColorLayer = selectedColorClipLayer
    ?? colorLayers.find((layer) => layer.id === raw.selectedColorLayerId);
  const selectedLayer = selectedColorLayer
    ? null
    : typeof raw.selectedLayerId === "string" && layers.some((layer) => layer.id === raw.selectedLayerId) ? raw.selectedLayerId : layers[0]?.id ?? null;
  const selectedCue = selectedColorLayer
    ? null
    : typeof raw.selectedCueId === "string" && subtitles.some((cue) => cue.id === raw.selectedCueId) ? raw.selectedCueId : subtitles[0]?.id ?? null;
  return {
    duration,
    loop: raw.loop !== false,
    ...(raw.assetPaths && typeof raw.assetPaths === "object" && !Array.isArray(raw.assetPaths)
      ? { assetPaths: Object.fromEntries(Object.entries(raw.assetPaths).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0)) }
      : {}),
    sequenceId: typeof raw.sequenceId === "string" ? raw.sequenceId : "legacy",
    subtitlePath: typeof raw.subtitlePath === "string" ? raw.subtitlePath : undefined,
    openingMode: raw.openingMode === "scene-first" || raw.openingMode === "skip" ? raw.openingMode : "direct",
    sceneDuration: finiteNumber(raw.sceneDuration, 3, 0),
    openingIdleDuration: finiteNumber(raw.openingIdleDuration, 3, 0),
    durationMode: raw.durationMode === "auto" ? "auto" : "manual",
    layersInitialized: raw.layersInitialized === true,
    layers,
    colorLayers,
    subtitles,
    audio,
    selectedLayerId: selectedLayer,
    selectedCueId: selectedCue,
    selectedColorLayerId: selectedColorLayer?.id ?? null,
    selectedColorClipId: selectedColorClipLayer && typeof raw.selectedColorClipId === "string" ? raw.selectedColorClipId : null,
    language: timelineLanguage(raw.language),
    snap: Math.max(0, finiteNumber(raw.snap, 0.1, 0)),
    ...(raw.camera ? { camera: normalizeSpineCameraTrack(raw.camera, duration) ?? undefined } : {}),
  };
}

export function normalizeProject(value: unknown, directory: string): EditorProject | null {
  if (!value || typeof value !== "object") return null;
  const project = value as Partial<EditorProject> & { schemaVersion?: unknown };
  if (!Array.isArray(project.interactions)) return null;
  const schemaVersion = Number(project.schemaVersion);
  if (Number.isFinite(schemaVersion) && schemaVersion > EDITOR_SCHEMA_VERSION) return null;
  // Talk auto-duration was introduced in schema 3. Do not re-migrate schema 3
  // projects when later editor schema versions add unrelated timeline fields.
  const migrateTalkDurationMode = !Number.isFinite(schemaVersion) || schemaVersion < 3;
  const normalizeProjectTimeline = (value: unknown): EditorTimeline => {
    const timeline = normalizeTimeline(value, directory);
    return migrateTalkDurationMode && /^talk-\d+$/i.test(timeline.sequenceId ?? "")
      ? { ...timeline, durationMode: "auto" }
      : timeline;
  };
  const interactions = (project.interactions as unknown[])
    .filter((item) => Boolean(item && typeof item === "object"))
    .map((item, index) => normalizeInteraction(item as Partial<EditorInteraction>, index))
    .filter((item): item is EditorInteraction => item !== null);
  const lookFollow = normalizeSpineLookFollowSettings(project.lookFollow);
  const behaviorMachines = Array.isArray(project.behaviorMachines)
    ? normalizeSpineBehaviorMachines(project.behaviorMachines)
    : migrateLegacyInteractionsToBehaviors(interactions, lookFollow);
  const behaviorGraphLayouts = normalizeBehaviorGraphLayouts(project.behaviorGraphLayouts, behaviorMachines);
  const requestedInteraction = typeof project.selectedInteractionId === "string" ? project.selectedInteractionId : "";
  const selectedInteractionId = interactions.some((item) => item.id === requestedInteraction) ? requestedInteraction : interactions[0]?.id ?? null;
  const selectedInteraction = interactions.find((item) => item.id === selectedInteractionId);
  const requestedRegion = typeof project.selectedRegionId === "string" ? project.selectedRegionId : "";
  const selectedRegionId = selectedInteraction?.regions.some((item) => item.id === requestedRegion)
    ? requestedRegion
    : selectedInteraction?.regions[0]?.id ?? null;
  return {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    name: typeof project.name === "string" ? project.name : `${directory} interactions`,
    assetDirectory: directory,
    talkMixDuration: Math.min(2, finiteNumber(project.talkMixDuration, DEFAULT_TALK_MIX_DURATION, 0)),
    effectsStrength: Math.max(0, Math.min(1, finiteNumber(project.effectsStrength, DEFAULT_EFFECTS_STRENGTH))),
    ...(project.entrySequence === null || typeof project.entrySequence === "string" ? { entrySequence: project.entrySequence } : {}),
    lookFollow,
    interactions,
    behaviorMachines,
    behaviorGraphLayouts,
    ...(Array.isArray(project.sequenceOrder)
      ? { sequenceOrder: ["opening", ...new Set(project.sequenceOrder.filter((id): id is string => typeof id === "string" && id !== "opening" && id !== "legacy"))] }
      : {}),
    deletedSequenceIds: [...new Set((Array.isArray(project.deletedSequenceIds) ? project.deletedSequenceIds : [])
      .filter((id): id is string => typeof id === "string" && id !== "opening" && id !== "legacy"))],
    selectedInteractionId,
    selectedRegionId,
    selectedBonePath: typeof project.selectedBonePath === "string" ? project.selectedBonePath : null,
    showBones: project.showBones !== false,
    showBoneNames: project.showBoneNames === true,
    showConstraints: project.showConstraints !== false,
    showInactiveBones: project.showInactiveBones === true,
    timeline: normalizeProjectTimeline(project.timeline),
    sequences: project.sequences && typeof project.sequences === "object"
      ? Object.fromEntries(Object.entries(project.sequences).map(([key, value]) => [key, normalizeProjectTimeline(value)])) : {},
  };
}

/** Detect the original single Touch_Point pinch default, not authored regions. */
export function isLegacyPinchRegion(project: EditorProject, region: EditorRegion): boolean {
  const interaction = project.interactions.find((item) => item.regions.some((candidate) => candidate.id === region.id));
  return Boolean(interaction && /(?:^|\/)(?:s_)?pinch[_ -]?\d+(?:_|$)/i.test(interaction.startAnimation)
    && region.name === "Cheek area" && region.shape === "ellipse" && region.rotation === 0
    && region.offsetX === 0 && region.offsetY === 0 && region.radiusX === 120 && region.radiusY === 90
    && region.enabled && !region.placement
    && region.anchorBone === interaction.followTargetBone);
}

/** Move untouched legacy pinch defaults onto the rig's actual left/right cheek controls. */
export function repairPinchRegions(project: EditorProject, bones: SpineEditorBone[]) {
  const cheekBones = cheekRegionBones(bones);
  if (cheekBones.length === 0) return { project, repaired: 0 };
  const touchTarget = findTouchTargetBone(bones);
  const legacyTouchTarget = bones.find((bone) => /^touch[ _-]?point$/i.test(bone.name));
  let repaired = 0;
  const next: EditorProject = {
    ...project,
    interactions: project.interactions.map((interaction) => {
      const legacy = interaction.regions.find((region) => isLegacyPinchRegion(project, region));
      if (!legacy) return interaction;
      repaired++;
      const replacements = cheekBones.map((bone, index) => ({
        ...legacy,
        id: index === 0 ? legacy.id : id("region"),
        name: cheekBones.length > 1 ? (index === 0 ? "Left cheek" : "Right cheek") : "Cheek area",
        anchorBone: bone.path,
        placement: "cheek-v1" as const,
      }));
      return {
        ...interaction,
        followTargetBone: interaction.followTargetBone === legacyTouchTarget?.path && touchTarget
          ? touchTarget.path
          : interaction.followTargetBone,
        regions: interaction.regions.flatMap((region) => region.id === legacy.id ? replacements : [region]),
      };
    }),
  };
  return { project: next, repaired };
}

function finiteNumber(value: unknown, fallback: number, minimum = -Infinity): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeRegion(value: Partial<EditorRegion>, index: number): EditorRegion {
  const shape = value.shape === "rectangle" ? "rectangle" : "ellipse";
  return {
    id: stringValue(value.id, id("region")),
    name: stringValue(value.name, `Region ${index + 1}`),
    enabled: value.enabled !== false,
    shape,
    anchorBone: typeof value.anchorBone === "string" && value.anchorBone ? value.anchorBone : null,
    offsetX: finiteNumber(value.offsetX, 0),
    offsetY: finiteNumber(value.offsetY, 0),
    radiusX: finiteNumber(value.radiusX, 100, 1),
    radiusY: finiteNumber(value.radiusY, 75, 1),
    rotation: finiteNumber(value.rotation, 0),
     placement: value.placement === "head-v1" || value.placement === "cheek-v1" || value.placement === "needs-head" || value.placement === "manual" ? value.placement : undefined,
  };
}

function normalizeInteraction(value: Partial<EditorInteraction>, index: number): EditorInteraction | null {
  const rawRegions = Array.isArray(value.regions) ? value.regions as unknown[] : [];
  const regions = rawRegions
    .filter((item) => Boolean(item && typeof item === "object"))
    .map((item, regionIndex) => normalizeRegion(item as Partial<EditorRegion>, regionIndex));
  const trigger: EditorTrigger = value.trigger === "press" || value.trigger === "drag" ? value.trigger : "hold";
  return {
    id: stringValue(value.id, id("interaction")),
    name: stringValue(value.name, `Interaction ${index + 1}`),
    color: stringValue(value.color, COLORS[index % COLORS.length]!),
    enabled: value.enabled !== false,
    trigger,
    startAnimation: stringValue(value.startAnimation, ""),
    followAnimation: stringValue(value.followAnimation, ""),
    endAnimation: stringValue(value.endAnimation, ""),
    faceStartAnimation: stringValue(value.faceStartAnimation, ""),
    faceFollowAnimation: stringValue(value.faceFollowAnimation, ""),
    faceEndAnimation: stringValue(value.faceEndAnimation, ""),
    followTargetBone: typeof value.followTargetBone === "string" && value.followTargetBone ? value.followTargetBone : null,
    sensitivity: finiteNumber(value.sensitivity, 0.25, 0),
    limitX: finiteNumber(value.limitX, 90, 0),
    limitY: finiteNumber(value.limitY, 65, 0),
    smoothing: finiteNumber(value.smoothing, 8, 0.1),
    returnDuration: Math.min(2, finiteNumber(value.returnDuration, DEFAULT_INTERACTION_RETURN_DURATION, 0.05)),
    returnEasing: value.returnEasing === "linear" || value.returnEasing === "ease-in-out" ? value.returnEasing : DEFAULT_INTERACTION_RETURN_EASING,
    startMixDuration: Math.min(2, finiteNumber(value.startMixDuration, DEFAULT_INTERACTION_PHASE_MIX, 0)),
    followMixDuration: Math.min(2, finiteNumber(value.followMixDuration, DEFAULT_INTERACTION_PHASE_MIX, 0)),
    releaseMixDuration: Math.min(2, finiteNumber(value.releaseMixDuration, DEFAULT_INTERACTION_PHASE_MIX, 0)),
    allowX: value.allowX !== false,
    allowY: value.allowY !== false,
    rotationEnabled: value.rotationEnabled === true,
    rotationAxis: value.rotationAxis === "y" ? "y" : "x",
    rotationMin: Math.min(0, Math.max(-180, finiteNumber(value.rotationMin, -15))),
    rotationMax: Math.max(0, Math.min(180, finiteNumber(value.rotationMax, 15))),
    regions,
  };
}

function regionWorldCircle(region: EditorRegion, bones: Map<string, SpineEditorBone>) {
  const bone = region.anchorBone ? bones.get(region.anchorBone) : undefined;
  if (!bone) {
    return { x: region.offsetX, y: region.offsetY, radius: Math.max(region.radiusX, region.radiusY) };
  }
  const scaleX = Math.hypot(bone.a, bone.c);
  const scaleY = Math.hypot(bone.b, bone.d);
  return {
    x: bone.x + bone.a * region.offsetX + bone.b * region.offsetY,
    y: bone.y + bone.c * region.offsetX + bone.d * region.offsetY,
    radius: Math.max(region.radiusX * scaleX, region.radiusY * scaleY),
  };
}

/** Return authoring issues that would make a runtime project incomplete or ambiguous. */
export function validateProject(project: EditorProject, animations: string[], bones: SpineEditorBone[]): EditorValidationWarning[] {
  const warnings: EditorValidationWarning[] = [];
  const animationNames = new Set(animations.map((animation) => animation.toLocaleLowerCase()));
  const boneMap = new Map(bones.map((bone) => [bone.path, bone]));
  const regions: Array<{ interaction: EditorInteraction; region: EditorRegion }> = [];

  for (const interaction of project.interactions) {
    for (const field of ["startAnimation", "followAnimation", "endAnimation", "faceStartAnimation", "faceFollowAnimation", "faceEndAnimation"] as const) {
      const animation = interaction[field];
      if (animation && !animationNames.has(animation.toLocaleLowerCase())) {
        warnings.push({
          id: `animation:${interaction.id}:${field}`,
          kind: "missing-animation",
          interactionId: interaction.id,
          regionId: null,
          message: `${interaction.name}: ${field.replace(/Animation$/, "")} animation “${animation}” is missing from this asset.`,
        });
      }
    }
    if (interaction.followTargetBone && !boneMap.has(interaction.followTargetBone)) {
      warnings.push({
        id: `bone:${interaction.id}:target`,
        kind: "missing-bone",
        interactionId: interaction.id,
        regionId: null,
        message: `${interaction.name}: follow target bone “${interaction.followTargetBone}” is missing from this asset.`,
      });
    }
    for (const region of interaction.regions) {
      if (region.placement === "needs-head") warnings.push({ id: `head:${interaction.id}:${region.id}`, kind: "head-detection", interactionId: interaction.id, regionId: region.id, message: `${interaction.name}: no reliable head artwork was detected. Default region is disabled; draw or position it before enabling.` });
      regions.push({ interaction, region });
      if (region.anchorBone && !boneMap.has(region.anchorBone)) {
        warnings.push({
          id: `bone:${interaction.id}:${region.id}`,
          kind: "missing-bone",
          interactionId: interaction.id,
          regionId: region.id,
          message: `${interaction.name} / ${region.name}: anchor bone “${region.anchorBone}” is missing from this asset.`,
        });
      }
    }
  }

  for (let firstIndex = 0; firstIndex < regions.length; firstIndex += 1) {
    const firstRegion = regions[firstIndex]!;
    if (!firstRegion.region.enabled || (firstRegion.region.anchorBone && !boneMap.has(firstRegion.region.anchorBone))) continue;
    const firstCircle = regionWorldCircle(firstRegion.region, boneMap);
    for (let secondIndex = firstIndex + 1; secondIndex < regions.length; secondIndex += 1) {
      const secondRegion = regions[secondIndex]!;
      if (!secondRegion.region.enabled || (secondRegion.region.anchorBone && !boneMap.has(secondRegion.region.anchorBone))) continue;
      const secondCircle = regionWorldCircle(secondRegion.region, boneMap);
      if (Math.hypot(firstCircle.x - secondCircle.x, firstCircle.y - secondCircle.y) >= firstCircle.radius + secondCircle.radius) continue;
      warnings.push({
        id: `overlap:${firstRegion.interaction.id}:${firstRegion.region.id}:${secondRegion.interaction.id}:${secondRegion.region.id}`,
        kind: "overlap",
        interactionId: firstRegion.interaction.id,
        regionId: firstRegion.region.id,
        otherInteractionId: secondRegion.interaction.id,
        otherRegionId: secondRegion.region.id,
        message: `${firstRegion.interaction.name} / ${firstRegion.region.name} overlaps ${secondRegion.interaction.name} / ${secondRegion.region.name}.`,
      });
    }
  }
  return warnings;
}

export function cloneProject(project: EditorProject): EditorProject {
  return JSON.parse(JSON.stringify(project)) as EditorProject;
}

export function projectStorageKey(directory: string): string {
  return `shittim-spine-editor:v${EDITOR_SCHEMA_VERSION}:${directory}`;
}
