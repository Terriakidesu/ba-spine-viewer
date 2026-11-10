import {
  Animation,
  AtlasAttachmentLoader,
  AnimationState,
  AnimationStateData,
  Bone,
  EventTimeline,
  MeshAttachment,
  Physics,
  RegionAttachment,
  Skeleton,
  SkeletonBinary,
  TrackEntry,
  TextureAtlas,
  Vector2,
} from "@esotericsoftware/spine-core";
import {
  GLTexture,
  ManagedWebGLRenderingContext,
  ResizeMode,
  SceneRenderer,
  Vector3,
} from "@esotericsoftware/spine-webgl";
import { authoredViewport, behaviorRegionAtPoint, cameraPositionForZoomAnchor, fitScene, interactionTargetAtPoint, interactionZonesForDisplay, sceneBounds, type InteractionHitKind, type InteractionHitTarget, type SceneBounds, type SpineBehaviorHitRegion } from "./spineCamera";
import { findIdleAnimation } from "./spineAnimation";
import { createResourceQueue } from "./resourceQueue";
import { spineCanvasBackingSize } from "./spineCanvasResolution";
import { DEFAULT_EFFECTS_STRENGTH, drawWithEffectsStrength } from "./spineEffects";
import { authoredInteraction, authoredInteractionAction, authoredRegions, clearInteractionTrack, DEFAULT_INTERACTION_PHASE_MIX, DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, DEFAULT_TALK_MIX_DURATION, interactionKind, interactionPhaseAfterStart, interactionPressReady, lookFollowTarget, normalizeAnimationMixDuration, normalizeSpineLookFollowSettings, profileFromProject, queueInteractionFadeOut, setInteractionTrack, smoothLookFollowPoint, type SpineAnimationPair, type SpineInteractionAction, type SpineInteractionProfile, type SpineInteractionProject, type SpineAuthoredInteraction, type SpineAuthoredRegion, type SpineLookFollowSettings } from "./spineInteraction";
import { SpineBehaviorRuntime, type SpineBehaviorDebugMachine, type SpineBehaviorRuntimeContext } from "./spineBehaviorRuntime";
import { normalizeSpineBehaviorMachines, type SpineBehaviorAction, type SpineBehaviorEvent, type SpineBehaviorMachine, type SpineBehaviorState } from "./spineBehavior";
import {
  applyInteractionMotion,
  applyInteractionMotionReturn,
  beforeInteractionMotion,
  beginInteractionMotionReturn,
  beginInteractionMotion,
  createInteractionMotionState,
  interactionMotionReturnComplete,
  rebaseInteractionMotion,
  resetInteractionMotion,
  type SpineInteractionMotionState,
  type SpineMotionInteraction,
} from "./spineInteractionMotion";

export { findIdleAnimation };

export const INTRO_ANIMATION = "__intro__";
export const EYE_FOLLOW_DELAY = DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS.delay;
const MAX_CANVAS_RESOLUTION_SCALE = 20;
const MAX_EYE_FOLLOW_RANGE = 64;
const MIN_TOUCH_FOLLOW_X = 45;
const MIN_TOUCH_FOLLOW_Y = 35;
const MAX_TOUCH_FOLLOW_X = 90;
const MAX_TOUCH_FOLLOW_Y = 65;
const TOUCH_FOLLOW_SCENE_RATIO = 0.025;
export type SpineCameraMode = "fit" | "fill" | "game" | "authored" | "artwork";
export type SpineInteractionMode = "free" | "interaction";

export interface SpineCameraFrame {
  centerX: number;
  centerY: number;
  height: number;
}

export type SpineFiles = Map<string, File>;

export interface SpineMeta {
  animations: string[];
  defaultAnimation: string;
  introAnimation: string | null;
  idleAnimation: string | null;
  duration: number;
  hasGameCamera: boolean;
  interaction: SpineInteractionMeta;
}

export interface SpineProgress {
  time: number;
  duration: number;
  animation: string | null;
}

export interface SpineLoadProgress {
  stage: "files" | "atlas" | "textures" | "skeleton" | "finalizing" | "audio";
  loaded: number;
  total: number;
}

export interface SpineCameraPose {
  x: number;
  y: number;
  zoom: number;
}

export interface SpineEditorBone {
  path: string;
  name: string;
  parentPath: string | null;
  x: number;
  y: number;
  endX: number;
  endY: number;
  screenX: number;
  screenY: number;
  screenEndX: number;
  screenEndY: number;
  screenLocalXEndX: number;
  screenLocalXEndY: number;
  screenLocalYEndX: number;
  screenLocalYEndY: number;
  a: number;
  b: number;
  c: number;
  d: number;
  length: number;
  rotation: number;
  active: boolean;
}

export interface SpineEditorConstraint {
  type: "ik" | "transform" | "path" | "physics";
  name: string;
  bones: string[];
  target: string;
}

export interface SpineEditorFrame {
  animation: string | null;
  time: number;
  duration: number;
  canvasWidth: number;
  canvasHeight: number;
  screenOriginX: number;
  screenOriginY: number;
  screenUnitXEndX: number;
  screenUnitXEndY: number;
  screenUnitYEndX: number;
  screenUnitYEndY: number;
  bones: SpineEditorBone[];
  constraints: SpineEditorConstraint[];
  lookFollow?: SpineLookFollowGizmoFrame | null;
}

export interface SpineLookFollowGizmoFrame {
  targetBonePath: string;
  centerScreenX: number;
  centerScreenY: number;
  currentScreenX: number;
  currentScreenY: number;
  rangeX: number;
  rangeY: number;
  active: boolean;
}

export interface SpineInteractionMeta {
  hasEyeFollow: boolean;
  canPat: boolean;
  canPinch: boolean;
  canTouch: boolean;
  talkCount: number;
}

export interface SpineInteractionPoint {
  kind: InteractionHitKind;
  shape: "ellipse" | "rectangle";
  centerX: number;
  centerY: number;
  axisXEndX: number;
  axisXEndY: number;
  axisYEndX: number;
  axisYEndY: number;
}

export interface SpineInteractionOverlay {
  canvasWidth: number;
  canvasHeight: number;
  points: SpineInteractionPoint[];
}

export interface SpineRendererCallbacks {
  onMeta: (meta: SpineMeta | null) => void;
  onProgress: (progress: SpineProgress) => void;
  onLoading: (loading: boolean) => void;
  onLoadProgress?: (progress: SpineLoadProgress) => void;
  onError: (error: Error | null) => void;
  onCameraMode?: (mode: SpineCameraMode) => void;
  onInteractionPoints?: (overlay: SpineInteractionOverlay) => void;
  onTalk?: (index: number, animation: string, eventCount: number) => boolean;
  onTalkClip?: (index: number, clipIndex: number) => void;
  onIntro?: (animation: string, eventCount: number) => boolean;
  onIntroClip?: (clipIndex: number) => void;
  onEditorFrame?: (frame: SpineEditorFrame) => void;
  onBehaviorDebug?: (snapshot: SpineBehaviorDebugMachine[]) => void;
  onBehaviorAudio?: (machineId: string, audioId: string, volume: number, loop: boolean) => void | (() => void);
  onBehaviorSubtitle?: (machineId: string, cueId: string, visible: boolean) => void;
  /** Private authoring hooks. Not used by the published viewer. */
  onBeforeEditorUpdate?: (skeleton: Skeleton) => void;
  onEditorUpdate?: (delta: number, skeleton: Skeleton, state: AnimationState) => void;
}

interface LoadedBundle {
  atlas: TextureAtlas;
  images: Array<HTMLImageElement | ImageBitmap>;
  directory: string;
  skeleton: Skeleton;
  state: AnimationState;
  meta: SpineMeta;
  bounds: SceneBounds;
  artworkBounds: SceneBounds;
  viewport: SceneBounds;
  interaction: SpineInteractionProfile;
  project: SpineInteractionProject | null;
  behaviorRuntime: SpineBehaviorRuntime;
  lookFollow: SpineLookFollowSettings;
  authoredRegions: SpineAuthoredRegion[];
  behaviorHitRegions: SpineBehaviorHitRegion[];
  eyeTarget: EyeTarget | null;
  touchTarget: InteractionTarget | null;
}

interface BehaviorBoneControl {
  key: string;
  machineId: string;
  bone: Bone;
  action: Extract<SpineBehaviorAction, { type: "pointer-follow" | "drag-bone" | "rotate-bone" }>;
  baseX: number;
  baseY: number;
  baseRotation: number;
  currentWorldX: number;
  currentWorldY: number;
  currentRotation: number;
  originLocal: { x: number; y: number } | null;
  returning: boolean;
  returnElapsed: number;
  returnDuration: number;
  returnFromX: number;
  returnFromY: number;
  returnFromRotation: number;
}

const HEAD_BONE_NAME = /^(?:(?:pc|head)[ _-](?:[ab][ _-])?)?(?:head|face)(?:[ _-]?(?:root|rot|rotation|main|base|pos|ani|top))?(?:[ _-]?\d+[a-z]?)?$/i;
const FACE_ATTACHMENT_NAME = /(?:^|[\\/_ -])(?:face(?:base)?|head)(?:[\\/_ -]|\d|$)/i;
const FACE_DETAIL_NAME = /(?:^|[\\/_ -])(?:eye\w*|brow\w*|mouth\w*|lip\w*|ear\w*|hair\w*|shadow\w*|fx|effect\w*|mask\w*)(?:[\\/_ -]|\d|$)/i;

/** Bounds of explicitly named visible face/head art, not interaction controller bones. */
function headArtworkBounds(skeleton: Skeleton): SceneBounds | null {
  const candidates: SceneBounds[] = [];
  for (const slot of skeleton.slots) {
    if (!slot.bone.active || slot.color.a * skeleton.color.a <= 0.01) continue;
    const attachment = slot.getAttachment();
    if (!(attachment instanceof MeshAttachment || attachment instanceof RegionAttachment) || attachment.color.a <= 0.01) continue;
    const label = `${slot.data.name}/${attachment.name}`;
    if (!FACE_ATTACHMENT_NAME.test(label) || FACE_DETAIL_NAME.test(label)) continue;

    let headBone: Bone | null = slot.bone;
    while (headBone && !HEAD_BONE_NAME.test(headBone.data.name.trim())) headBone = headBone.parent;
    if (!headBone && attachment instanceof MeshAttachment && attachment.bones) {
      const weights = new Map<Bone, number>();
      let vertex = 0;
      for (let index = 0; index < attachment.bones.length;) {
        const count = attachment.bones[index++]!;
        for (let influenceIndex = 0; influenceIndex < count; influenceIndex++) {
          let influence: Bone | null = skeleton.bones[attachment.bones[index++]!] ?? null;
          const weight = attachment.vertices[vertex + 2] ?? 0;
          vertex += 3;
          while (influence && !HEAD_BONE_NAME.test(influence.data.name.trim())) influence = influence.parent;
          if (influence) weights.set(influence, (weights.get(influence) ?? 0) + weight);
        }
      }
      headBone = [...weights].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
    }
    if (!headBone) continue;

    const vertices = new Float32Array(attachment instanceof MeshAttachment ? attachment.worldVerticesLength : 8);
    if (attachment instanceof MeshAttachment) attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
    else attachment.computeWorldVertices(slot, vertices, 0, 2);
    let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
    for (let index = 0; index < vertices.length; index += 2) {
      left = Math.min(left, vertices[index]!); right = Math.max(right, vertices[index]!);
      bottom = Math.min(bottom, vertices[index + 1]!); top = Math.max(top, vertices[index + 1]!);
    }
    const width = right - left, height = top - bottom;
    if (![left, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width / height < 0.3 || width / height > 3) continue;
    candidates.push({ x: left, y: bottom, width, height });
  }
  return candidates.sort((left, right) => right.width * right.height - left.width * left.height)[0] ?? null;
}

interface InteractionTarget {
  bone: Bone;
  baseX: number;
  baseY: number;
  rangeX: number;
  rangeY: number;
}

interface EyeTarget extends InteractionTarget {
  rangeX: number;
  rangeY: number;
}

type GestureKind = "pat" | "pinch" | "touch";
type SpineInteractionState = "idle" | "look" | "lookRelease" | `${GestureKind}Start` | GestureKind | `${GestureKind}Release` | "talk";

interface CameraPose {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

function fileNamed(files: SpineFiles, wanted: string): File | undefined {
  const target = basename(wanted).toLowerCase();
  for (const [path, file] of files) {
    if (basename(path).toLowerCase() === target) return file;
  }
  return undefined;
}

function filesWithExtension(files: SpineFiles, extension: string): File[] {
  return [...files.entries()]
    .filter(([path]) => basename(path).toLowerCase().endsWith(extension))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([, file]) => file);
}

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Could not load the Spine asset.");
}

function talkNumber(animation: string): number | null {
  const match = basename(animation).match(/^talk[_ -]?(\d+)/i);
  return match ? Number(match[1]) : null;
}

function eventTimes(events: Array<{ time: number }>): number[] {
  const sorted = [...new Set(events.map((event) => event.time))].sort((a, b) => a - b);
  const result: number[] = [];
  for (const time of sorted) {
    // A few exports contain two event keys on adjacent frames for one clip.
    // Treat those as one marker instead of making the audio session wait for a
    // phantom clip at the end of the animation.
    if (result.length === 0 || time - result[result.length - 1]! > 0.05) result.push(time);
  }
  return result;
}

/** Talk markers identify voice clips; matching Sound markers disambiguate intro clips. */
export function talkEventTimes(animation: Animation | null, number?: number | null): number[] {
  if (!animation) return [];
  const events = animation.timelines
    .filter((timeline): timeline is EventTimeline => timeline instanceof EventTimeline)
    .flatMap((timeline) => timeline.events);
  const talk = events
    .filter((event) => event.data.name.toLocaleLowerCase() === "talk")
    .map((event) => event);
  const sound = events.filter((event) => /^sound\//i.test(event.data.name));
  const matchingSound = Number.isFinite(number)
    ? sound.filter((event) => new RegExp(`memoriallobby_${number}(?:_|$)`, "i").test(basename(event.data.name)))
    : sound;
  if (matchingSound.length > 0) {
    const soundTimes = eventTimes(matchingSound);
    const pairedTalk = talk.filter((event) => soundTimes.some((time) => Math.abs(time - event.time) <= 0.001));
    return eventTimes(pairedTalk.length > 0 ? pairedTalk : matchingSound);
  }
  if (talk.length > 0) return eventTimes(talk);
  return eventTimes(sound);
}

/** Pick the authored opening animation without relying on one exact suffix. */
export function findIntroAnimation(animations: string[]): string | null {
  return animations.find((name) => /^start[_ -]?idle(?:[_ -]?(?:0?1))?$/i.test(name)) ?? null;
}

/** Choose a playback default only when a real idle exists; never use animation order as an idle fallback. */
export function defaultSpineAnimation(animations: string[]): string {
  const intro = findIntroAnimation(animations);
  const idle = findIdleAnimation(animations);
  return intro && idle ? INTRO_ANIMATION : idle ?? "";
}

async function loadImage(file: File): Promise<HTMLImageElement | ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    // Normalize the atlas pages to premultiplied alpha before WebGL sees
    // them. The Spine PMA path is required by screen/additive VFX slots;
    // mixing straight pixels with that path creates white or hard-edged
    // rectangles around otherwise transparent effects.
    return createImageBitmap(file, { premultiplyAlpha: "premultiply", colorSpaceConversion: "none" });
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeImage(image: HTMLImageElement | ImageBitmap) {
  if ("close" in image && typeof image.close === "function") image.close();
}

function disposeBundle(bundle: LoadedBundle) {
  bundle.behaviorRuntime.dispose();
  bundle.atlas.dispose();
  for (const image of bundle.images) closeImage(image);
}

function findPreferredSkeleton(files: File[], directoryName: string): File[] {
  const wanted = `${directoryName}.skel`.toLowerCase();
  return [...files].sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aPreferred = aName === wanted || aName === `${directoryName.replace(/_home$/i, "")}_home.skel`.toLowerCase();
    const bPreferred = bName === wanted || bName === `${directoryName.replace(/_home$/i, "")}_home.skel`.toLowerCase();
    return Number(bPreferred) - Number(aPreferred) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function bonePath(bone: Bone): string {
  const names: string[] = [];
  for (let current: Bone | null = bone; current; current = current.parent) names.push(current.data.name);
  return names.reverse().join("/");
}

async function readSkeleton(
  files: SpineFiles,
  atlas: TextureAtlas,
  directoryName: string,
  signal?: AbortSignal,
): Promise<{ skeleton: Skeleton; animations: string[] }> {
  const candidates = findPreferredSkeleton(filesWithExtension(files, ".skel"), directoryName);
  if (candidates.length === 0) throw new Error("This set does not contain a .skel file.");

  const loader = new SkeletonBinary(new AtlasAttachmentLoader(atlas));
  const failures: string[] = [];
  let fallback: { skeleton: Skeleton; animations: string[] } | null = null;

  for (const file of candidates) {
    signal?.throwIfAborted();
    try {
      const bytes = await file.arrayBuffer();
      signal?.throwIfAborted();
      const data = loader.readSkeletonData(bytes);
      const animations = data.animations.map((animation) => animation.name);
      const parsed = { skeleton: new Skeleton(data), animations };
      // Lobby sets can carry a second scene/background skeleton. The lobby
      // skeleton is the one with Idle_01 or the intro-to-idle animation.
       if (findIdleAnimation(animations) || findIntroAnimation(animations)) return parsed;
      fallback ??= parsed;
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${file.name}: ${errorFrom(error).message}`);
    }
  }

  if (fallback) return fallback;
  throw new Error(`No usable lobby skeleton was found. ${failures.join(" ")}`);
}

function resolveEyeTargetBone(skeleton: Skeleton, requestedPath: string | null): Bone | null {
  if (requestedPath) {
    const configured = skeleton.bones.find((bone) => bonePath(bone) === requestedPath);
    if (configured) return configured;
  }
  const exact = ["Touch_Eye_Key", "Touch_Eye_key", "Touch_Eye"];
  for (const wanted of exact) {
    const found = skeleton.findBone(wanted);
    if (found) return found;
  }
  return skeleton.bones.find((bone) => /^touch[ _-]?eye(?:[ _-]?key)?$/i.test(bone.data.name)) ?? null;
}

function findTouchTarget(skeleton: Skeleton): Bone | null {
  const exact = ["Touch_Point_Key", "Touch_Point_key", "Touch_Point"];
  for (const wanted of exact) {
    const found = skeleton.findBone(wanted);
    if (found) return found;
  }
  return skeleton.bones.find((bone) => /^touch[ _-]?point(?:[ _-]?key)?$/i.test(bone.data.name)) ?? null;
}

function targetState(bone: Bone, rangeX = Infinity, rangeY = Infinity): InteractionTarget {
  return { bone, baseX: bone.x, baseY: bone.y, rangeX, rangeY };
}

function eyeTargetState(
  skeleton: Skeleton,
  touchTarget: InteractionTarget | null,
  settings: SpineLookFollowSettings,
  previous: EyeTarget | null = null,
): EyeTarget | null {
  const bone = resolveEyeTargetBone(skeleton, settings.targetBonePath);
  if (!bone) return null;
  const distance = touchTarget ? Math.hypot(bone.worldX - touchTarget.bone.worldX, bone.worldY - touchTarget.bone.worldY) : MAX_EYE_FOLLOW_RANGE;
  const defaultRangeX = Math.max(24, Math.min(MAX_EYE_FOLLOW_RANGE, distance * 0.4));
  const sameTarget = previous?.bone === bone;
  return {
    bone,
    baseX: sameTarget ? previous.baseX : bone.x,
    baseY: sameTarget ? previous.baseY : bone.y,
    rangeX: settings.rangeX ?? defaultRangeX,
    rangeY: settings.rangeY ?? defaultRangeX * 0.75,
  };
}

function touchTargetState(skeleton: Skeleton, bounds: SceneBounds | null): InteractionTarget | null {
  const bone = findTouchTarget(skeleton);
  if (!bone) return null;
  // Touch_Point is an IK/input target. Keep it responsive near the authored
  // point, but do not let a pointer at the edge of the canvas pull the rig
  // into an exaggerated pose. Scale the limit with the authored scene so
  // small variants do not get a disproportionately large deformation.
  const width = bounds && Number.isFinite(bounds.width) ? bounds.width : 2800;
  const height = bounds && Number.isFinite(bounds.height) ? bounds.height : 1800;
  return targetState(
    bone,
    Math.max(MIN_TOUCH_FOLLOW_X, Math.min(MAX_TOUCH_FOLLOW_X, width * TOUCH_FOLLOW_SCENE_RATIO)),
    Math.max(MIN_TOUCH_FOLLOW_Y, Math.min(MAX_TOUCH_FOLLOW_Y, height * TOUCH_FOLLOW_SCENE_RATIO)),
  );
}

function artworkBoundsAcrossAnimations(
  source: Skeleton,
  stateData: AnimationStateData,
  animationNames: readonly string[],
): SceneBounds {
  const skeleton = new Skeleton(source.data);
  const state = new AnimationState(stateData);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const collect = () => {
    skeleton.updateWorldTransform(Physics.reset);
    const bounds = skeleton.getBoundsRect();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return;
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  };

  skeleton.setToSetupPose();
  collect();
  for (const name of animationNames) {
    const animation = skeleton.data.findAnimation(name);
    if (!animation) continue;
    const steps = Math.max(1, Math.min(120, Math.ceil(Math.max(0, animation.duration) * 12)));
    for (let index = 0; index <= steps; index += 1) {
      const time = animation.duration * index / steps;
      skeleton.setToSetupPose();
      state.clearTracks();
      const entry = state.setAnimation(0, name, false);
      entry.trackTime = time;
      entry.trackLast = time;
      entry.animationLast = time;
      entry.nextTrackLast = time;
      entry.nextAnimationLast = time;
      state.apply(skeleton);
      collect();
    }
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return { x: minX - width * 0.06, y: minY - height * 0.06, width: width * 1.12, height: height * 1.12 };
}

function legacyExecutionProject(project?: SpineInteractionProject | null): SpineInteractionProject | null {
  if (!project) return null;
  const authoredMachineIds = new Set((project.behaviorMachines ?? [])
    .filter((machine) => machine.sourceLegacyInteractionId === null)
    .map((machine) => machine.id));
  if (authoredMachineIds.size === 0) return project;
  return { ...project, interactions: project.interactions.filter((interaction) => !authoredMachineIds.has(interaction.id)) };
}

function hasAuthoredLookFollow(project?: SpineInteractionProject | null): boolean {
  return Boolean(project?.behaviorMachines?.some((machine) => (machine.id === "look-follow" || /^look-follow-\d+$/.test(machine.id))
    && machine.sourceLegacyInteractionId === null));
}

const queueBundleLoad = createResourceQueue(2);

async function loadBundle(files: SpineFiles, directoryName: string, renderer: SceneRenderer, context: ManagedWebGLRenderingContext, project?: SpineInteractionProject | null, onLoadProgress?: (progress: SpineLoadProgress) => void, signal?: AbortSignal): Promise<LoadedBundle> {
  signal?.throwIfAborted();
  const atlasFile = filesWithExtension(files, ".atlas")[0];
  if (!atlasFile) throw new Error("This set does not contain an .atlas file.");

  onLoadProgress?.({ stage: "atlas", loaded: 0, total: 0 });
  const atlas = new TextureAtlas(await atlasFile.text());
  onLoadProgress?.({ stage: atlas.pages.length ? "textures" : "skeleton", loaded: 0, total: atlas.pages.length });
  const images: Array<HTMLImageElement | ImageBitmap> = [];
  try {
    signal?.throwIfAborted();
    for (const [index, page] of atlas.pages.entries()) {
      signal?.throwIfAborted();
      const imageFile = fileNamed(files, page.name);
      if (!imageFile) throw new Error(`The atlas page “${page.name}” is missing.`);
      const image = await loadImage(imageFile);
      // Own the decoded image before any upload/filter operation can fail.
      images.push(image);
      signal?.throwIfAborted();
      // ImageBitmap was premultiplied during decode. The fallback HTML
      // image is still straight-alpha, so ask WebGL to normalize that path
      // before uploading it as well.
      const imageIsBitmap = typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
      context.gl.pixelStorei(context.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !imageIsBitmap);
      const texture = new GLTexture(context, image);
      page.setTexture(texture);
      texture.setFilters(page.minFilter, page.magFilter);
      texture.setWraps(page.uWrap, page.vWrap);
      onLoadProgress?.({ stage: "textures", loaded: index + 1, total: atlas.pages.length });
    }

    onLoadProgress?.({ stage: "skeleton", loaded: 0, total: 0 });
    const { skeleton, animations } = await readSkeleton(files, atlas, directoryName, signal);
    signal?.throwIfAborted();
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform(Physics.update);
    // A bone named "camera" in these exports is usually an animated art/layer
    // parent, not a Unity Camera component. Keep setup pose as the fixed
    // authored viewport anchor while the animation moves the artwork through it.
    const setupSkeleton = new Skeleton(skeleton.data);
    setupSkeleton.setToSetupPose();
    setupSkeleton.updateWorldTransform(Physics.update);
    const stateData = new AnimationStateData(skeleton.data);
    // Draw-order timelines are discrete. Mixing intro and idle poses can
    // leave slots visually interleaved for a few frames, so switch between
    // lobby animations without a cross-fade.
    stateData.defaultMix = 0;
    const state = new AnimationState(stateData);
    const introAnimation = findIntroAnimation(animations);
    const idleAnimation = findIdleAnimation(animations);
    const legacyProject = legacyExecutionProject(project);
    const lookFollowSettings = normalizeSpineLookFollowSettings(project?.lookFollow);
    const lookFollow = { ...lookFollowSettings, enabled: lookFollowSettings.enabled && !hasAuthoredLookFollow(project) };
    const interaction = profileFromProject(animations, legacyProject);
    const configuredRegions = authoredRegions(legacyProject);
    const behaviorHitRegions: SpineBehaviorHitRegion[] = (project?.behaviorMachines ?? []).flatMap((machine) =>
      machine.activation.kind === "pointer-region"
        ? machine.activation.regions.map((region) => ({ machineId: machine.id, region }))
        : [],
    );
    const defaultAnimation = defaultSpineAnimation(animations);
    const meta: SpineMeta = {
      animations,
      defaultAnimation,
      introAnimation,
      idleAnimation,
      duration: 0,
      hasGameCamera: false,
      interaction: {
        hasEyeFollow: Boolean(resolveEyeTargetBone(skeleton, lookFollow.targetBonePath)),
        canPat: Boolean(interaction.pat),
        canPinch: Boolean(interaction.pinch),
        canTouch: Boolean(interaction.touch),
        talkCount: interaction.talks.length,
      },
    };

    // Start in the same pose the game uses when opening a lobby card.
    if (defaultAnimation === INTRO_ANIMATION) {
      const intro = state.setAnimation(0, introAnimation!, false);
      state.addAnimation(0, idleAnimation!, true, 0);
      meta.duration = intro.animation?.duration ?? 0;
    } else if (defaultAnimation) {
      const entry = state.setAnimation(0, defaultAnimation, true);
      meta.duration = entry.animation?.duration ?? 0;
    }
    // Keep game-camera metadata and interaction targets tied to the idle pose.
    // Authored-camera artwork bounds below separately cover intro, idle, and Talk.
    const framingSkeleton = new Skeleton(skeleton.data);
    const framingState = new AnimationState(stateData);
    const framingAnimation = idleAnimation;
    if (framingAnimation) {
      framingState.setAnimation(0, framingAnimation, false);
      framingState.apply(framingSkeleton);
    }
    framingSkeleton.updateWorldTransform(Physics.update);
    const bounds = sceneBounds(framingSkeleton);
    const artworkBounds = artworkBoundsAcrossAnimations(
      skeleton,
      stateData,
      [...new Set([introAnimation, idleAnimation, ...animations.filter((name) => /^talk(?:[_ -]|$)/i.test(name))].filter((name): name is string => Boolean(name)))],
    );
    const viewport = authoredViewport(framingSkeleton, setupSkeleton);
    meta.hasGameCamera = viewport.authored;
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.update);
    const touchTarget = touchTargetState(skeleton, bounds);
    const eyeTarget = eyeTargetState(skeleton, touchTarget, lookFollow);
    renderer.resize(ResizeMode.Expand);
    onLoadProgress?.({ stage: "finalizing", loaded: 0, total: 0 });
    return {
      atlas, images, directory: directoryName, skeleton, state, meta, bounds, artworkBounds, viewport, interaction,
      project: project ?? null,
      behaviorRuntime: new SpineBehaviorRuntime(project?.behaviorMachines ?? []),
      lookFollow, authoredRegions: configuredRegions, behaviorHitRegions, eyeTarget, touchTarget,
    };
  } catch (error) {
    atlas.dispose();
    for (const image of images) closeImage(image);
    throw error;
  }
}

export class SpineRenderer {
  private loadController: AbortController | null = null;
  private readonly context: ManagedWebGLRenderingContext;
  private readonly renderer: SceneRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: SpineRendererCallbacks;
  private bundle: LoadedBundle | null = null;
  private animationSelection = "";
  private playing = true;
  private loop = true;
  private speed = 1;
  private skipIntro = false;
  private effectsStrength = DEFAULT_EFFECTS_STRENGTH;
  private showInteractionPoints = false;
  private cameraMode: SpineCameraMode = "fill";
  private interactionMode: SpineInteractionMode = "free";
  private freeAnimationSelection = "";
  private freeCameraMode: SpineCameraMode = "fill";
  private interactionPointer: { x: number; y: number } | null = null;
  private interactionPointerId: number | null = null;
  private interactionPointerHeld = false;
  private interactionPressedTarget: InteractionHitTarget | null = null;
  private interactionPressedTrigger: SpineAuthoredInteraction["trigger"] = "hold";
  private interactionPressOrigin: { x: number; y: number } | null = null;
  private activeGestureInteractionId: string | null = null;
  private pointerInside = false;
  private interactionState: SpineInteractionState = "idle";
  private interactionTrackName: string | null = null;
  private interactionReady = false;
  private eyeFollowHold = 0;
  private lookFollowPreview = false;
  private talkIndex = 0;
  private activeTalkIndex = -1;
  private talkEventIndex = 0;
  private talkAudioPending = false;
  private talkFadeQueued = false;
  private introAudioEntry: TrackEntry | null = null;
  private introEventIndex = 0;
  private interactionFollowWorld: { x: number; y: number } | null = null;
  private touchPointerOrigin: { x: number; y: number } | null = null;
  private touchFollowOffset: { x: number; y: number } | null = null;
  private behaviorPointerHeldSeconds = 0;
  private behaviorDebugSignature = "";
  private behaviorMachinesSignature = "";
  private behaviorTestContext: { machineId: string; pointerHeld: boolean; regionId: string | null; heldSeconds: number; dragDistance: number } | null = null;
  private behaviorTestMachineIds = new Set<string>();
  private behaviorControls = new Map<string, BehaviorBoneControl>();
  private behaviorActionCleanups = new Map<string, { machineId: string; cleanup: () => void }>();
  private interactionPressedBehaviorRegionId: string | null = null;
  private behaviorPressDispatched = false;
  private sampledEditorFace = "";
  private sampledEditorSequenceId: string | null = null;
  private sampledEditorTalkSequence = false;
  private interactionMotionState: SpineInteractionMotionState = createInteractionMotionState();
  private fitCameraPose: CameraPose | null = null;
  private pendingCameraPose: SpineCameraPose | null = null;
  private authoredCameraFrame: SpineCameraFrame | null = null;
  private pendingFit = false;
  private raf = 0;
  private previousFrame = 0;
  private loadSerial = 0;
  private destroyed = false;
  private renderEnabled = true;
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private resolutionScale = 1;
  private canvasLimits: { width: number; height: number } | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, callbacks: SpineRendererCallbacks, options: { preserveDrawingBuffer?: boolean } = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.context = new ManagedWebGLRenderingContext(canvas, {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    this.renderer = new SceneRenderer(canvas, this.context, true);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bindCameraControls();
    this.raf = requestAnimationFrame(this.render);
  }

  async load(files: SpineFiles, directoryName: string, project?: SpineInteractionProject | null, options: { preserveMetadata?: boolean } = {}) {
    if (this.destroyed) return;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const serial = ++this.loadSerial;
    this.lookFollowPreview = false;
    this.disposeBundle();
    this.interactionPressedTarget = null;
    this.interactionPressedBehaviorRegionId = null;
    this.behaviorPressDispatched = false;
    this.behaviorPointerHeldSeconds = 0;
    this.behaviorDebugSignature = "";
    this.activeGestureInteractionId = null;
    this.fitCameraPose = null;
    this.pendingCameraPose = null;
    if (!options.preserveMetadata) this.callbacks.onMeta(null);
    this.callbacks.onError(null);
    this.callbacks.onLoading(true);
    this.callbacks.onLoadProgress?.({ stage: "files", loaded: 0, total: 0 });
    this.callbacks.onInteractionPoints?.({ canvasWidth: 0, canvasHeight: 0, points: [] });
    this.animationSelection = "";
    this.sampledEditorSequenceId = null;
    this.sampledEditorTalkSequence = false;
    this.talkIndex = 0;
    this.activeTalkIndex = -1;
    this.talkEventIndex = 0;
    this.talkAudioPending = false;
    this.talkFadeQueued = false;
    this.introAudioEntry = null;
    this.introEventIndex = 0;

    try {
      const bundle = await queueBundleLoad(() => loadBundle(files, directoryName, this.renderer, this.context, project, (progress) => {
        if (!controller.signal.aborted) this.callbacks.onLoadProgress?.(progress);
      }, controller.signal), controller.signal);
      if (serial !== this.loadSerial || this.destroyed) {
        disposeBundle(bundle);
        return;
      }
      this.bundle = bundle;
      bundle.behaviorRuntime.dispose();
      bundle.behaviorRuntime = this.createBehaviorRuntime(bundle, bundle.project?.behaviorMachines ?? []);
      this.behaviorMachinesSignature = JSON.stringify(bundle.project?.behaviorMachines ?? []);
      bundle.behaviorRuntime.start();
      const initialEntry = bundle.state.getCurrent(0);
      if (initialEntry) {
        if (initialEntry.animation?.name !== bundle.meta.introAnimation) initialEntry.loop = this.loop;
        if (initialEntry.next) initialEntry.next.loop = this.loop;
      }
      this.animationSelection = bundle.meta.defaultAnimation;
      this.pendingFit = true;
      if (this.interactionMode === "interaction") this.enterInteraction();
      else if (this.skipIntro && bundle.meta.idleAnimation) {
        this.animationSelection = bundle.meta.idleAnimation;
        this.applyBaseAnimation(bundle.meta.idleAnimation, true);
      }
      if (!options.preserveMetadata) this.callbacks.onMeta(bundle.meta);
      this.callbacks.onLoadProgress?.({ stage: "finalizing", loaded: 1, total: 1 });
      this.callbacks.onLoading(false);
    } catch (error) {
      if (serial !== this.loadSerial || this.destroyed) return;
      this.callbacks.onLoading(false);
      this.callbacks.onError(errorFrom(error));
    }
  }

  /** Release a hidden workspace's heavy resources without resetting authored UI state. */
  releaseAssets() {
    this.loadController?.abort();
    this.loadController = null;
    ++this.loadSerial;
    this.disposeBundle();
    this.callbacks.onLoading(false);
  }

  clear() {
    this.loadController?.abort();
    this.loadController = null;
    ++this.loadSerial;
    this.lookFollowPreview = false;
    this.resetInteractionTargets();
    this.disposeBundle();
    this.fitCameraPose = null;
    this.pendingCameraPose = null;
    this.callbacks.onMeta(null);
    this.callbacks.onProgress({ time: 0, duration: 0, animation: null });
    this.callbacks.onLoading(false);
    this.callbacks.onInteractionPoints?.({ canvasWidth: 0, canvasHeight: 0, points: [] });
    this.interactionPointer = null;
    this.interactionPointerId = null;
    this.interactionPointerHeld = false;
    this.behaviorPointerHeldSeconds = 0;
    this.interactionPressedTarget = null;
    this.interactionPressedBehaviorRegionId = null;
    this.behaviorPressDispatched = false;
    this.interactionPressedTrigger = "hold";
    this.interactionPressOrigin = null;
    this.activeGestureInteractionId = null;
    this.pointerInside = false;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.interactionReady = false;
    this.eyeFollowHold = 0;
    this.interactionFollowWorld = null;
    this.touchPointerOrigin = null;
    this.touchFollowOffset = null;
    this.talkIndex = 0;
    this.activeTalkIndex = -1;
    this.talkEventIndex = 0;
    this.talkAudioPending = false;
    this.talkFadeQueued = false;
    this.introAudioEntry = null;
    this.introEventIndex = 0;
    this.callbacks.onBehaviorDebug?.([]);
    this.behaviorDebugSignature = "";
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
  }

  /** Disable only WebGL painting while another workspace owns the preview. */
  setRenderEnabled(enabled: boolean) {
    if (this.renderEnabled === enabled) return;
    this.renderEnabled = enabled;
    if (enabled) {
      this.previousFrame = 0;
      this.pendingFit = true;
    }
  }

  /** Render the current paused pose synchronously so an editor preview can read the WebGL canvas. */
  renderFrameForCapture(): boolean {
    if (this.destroyed || !this.renderEnabled || !this.bundle) return false;
    if (this.context.gl.isContextLost()) return false;
    this.drawFrame(this.bundle);
    return true;
  }

  /** Reset the interaction renderer to the exact opening or idle sequence for offline export. */
  prepareRecordingPlayback(includeOpening: boolean) {
    const bundle = this.bundle;
    if (!bundle) return false;
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    this.skipIntro = !includeOpening;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.interactionReady = !includeOpening || !(bundle.meta.introAnimation && bundle.meta.idleAnimation);
    this.animationSelection = includeOpening && bundle.meta.introAnimation && bundle.meta.idleAnimation
      ? INTRO_ANIMATION
      : bundle.meta.idleAnimation ?? "";
    if (!this.animationSelection) return false;
    this.applyBaseAnimation(this.animationSelection, true);
    this.playing = false;
    return true;
  }

  /** Advance Spine by one fixed export timestep and draw that sampled pose immediately. */
  advanceRecordingFrame(deltaSeconds: number): boolean {
    const bundle = this.bundle;
    if (this.destroyed || !bundle || !Number.isFinite(deltaSeconds) || deltaSeconds < 0 || this.context.gl.isContextLost()) return false;
    this.playing = false;
    this.restoreInteractionPose();
    bundle.state.update(deltaSeconds);
    bundle.state.apply(bundle.skeleton);
    bundle.skeleton.updateWorldTransform(Physics.update);
    this.callbacks.onEditorUpdate?.(deltaSeconds, bundle.skeleton, bundle.state);
    if (this.interactionMode === "interaction") {
      const entry = bundle.state.getCurrent(0);
      if (!(bundle.meta.introAnimation && bundle.meta.idleAnimation) || entry?.animation?.name !== bundle.meta.introAnimation) this.interactionReady = true;
      this.finishInteractionState();
    }
    this.emitEditorFrame();
    this.drawFrame(bundle);
    return true;
  }

  /** Report readiness details for preview diagnostics without exposing renderer internals. */
  getPreviewDiagnostics() {
    const contextLost = this.context.gl.isContextLost();
    return {
      ready: !this.destroyed && Boolean(this.bundle) && !contextLost,
      contextLost,
      renderEnabled: this.renderEnabled,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      animation: this.animationSelection,
    };
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.1, Math.min(3, speed));
  }

  setSkipIntro(skip: boolean) {
    if (this.skipIntro === skip) return;
    this.skipIntro = skip;
    const bundle = this.bundle;
    if (!bundle?.meta.introAnimation || !bundle.meta.idleAnimation) return;

    if (this.interactionMode === "interaction") {
      this.enterInteraction();
      return;
    }

    const current = bundle.state.getCurrent(0)?.animation?.name;
    if (skip && (this.animationSelection === INTRO_ANIMATION || current === bundle.meta.introAnimation)) {
      this.animationSelection = bundle.meta.idleAnimation;
      this.applyBaseAnimation(bundle.meta.idleAnimation, true);
    }
  }

  setEffectsStrength(strength: number) {
    this.effectsStrength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : DEFAULT_EFFECTS_STRENGTH;
  }

  /** Render at additional backing resolution when the Editor magnifies this canvas with CSS. */
  setResolutionScale(scale: number) {
    const next = Number.isFinite(scale) ? Math.max(1, Math.min(MAX_CANVAS_RESOLUTION_SCALE, scale)) : 1;
    if (next === this.resolutionScale) return;
    this.resolutionScale = next;
    this.resize();
  }

  setShowInteractionPoints(show: boolean) {
    this.showInteractionPoints = show;
    if (!show) this.callbacks.onInteractionPoints?.({ canvasWidth: 0, canvasHeight: 0, points: [] });
  }

  setLookFollowSettings(value: unknown) {
    const bundle = this.bundle;
    if (!bundle) return;
    const settings = normalizeSpineLookFollowSettings(value);
    const oldSettings = bundle.lookFollow;
    const nextTarget = resolveEyeTargetBone(bundle.skeleton, settings.targetBonePath);
    const targetChanged = bundle.eyeTarget?.bone !== nextTarget;
    const phasesChanged = oldSettings.startAnimation !== settings.startAnimation
      || oldSettings.faceStartAnimation !== settings.faceStartAnimation
      || oldSettings.endAnimation !== settings.endAnimation
      || oldSettings.faceEndAnimation !== settings.faceEndAnimation;
    if (this.interactionState === "look" && (targetChanged || phasesChanged || !settings.enabled)) this.endLook();

    const project = {
      ...(bundle.project ?? { schemaVersion: 1, assetDirectory: bundle.directory, interactions: [] }),
      lookFollow: settings,
    };
    bundle.project = project;
    bundle.lookFollow = { ...settings, enabled: settings.enabled && !hasAuthoredLookFollow(project) };
    const legacyProject = legacyExecutionProject(project);
    bundle.interaction = profileFromProject(bundle.meta.animations, legacyProject);
    bundle.authoredRegions = authoredRegions(legacyProject);
    bundle.eyeTarget = eyeTargetState(bundle.skeleton, bundle.touchTarget, settings, bundle.eyeTarget);
    if (!bundle.lookFollow.enabled) this.eyeFollowHold = 0;
    this.emitEditorFrame();
  }

  /** Replace authored declarative machines in the live preview without reloading the Spine rig. */
  setBehaviorMachines(value: unknown) {
    const bundle = this.bundle;
    if (!bundle) return;
    const machines = normalizeSpineBehaviorMachines(value);
    const signature = JSON.stringify(machines);
    if (signature === this.behaviorMachinesSignature) return;
    this.behaviorMachinesSignature = signature;
    this.endGesture();
    this.endLook();
    this.behaviorTestContext = null;
    this.behaviorTestMachineIds.clear();
    bundle.behaviorRuntime.dispose();
    this.clearBehaviorSideEffects();
    bundle.behaviorRuntime = this.createBehaviorRuntime(bundle, machines);
    bundle.behaviorHitRegions = machines.flatMap((machine) => machine.activation.kind === "pointer-region"
      ? machine.activation.regions.map((region) => ({ machineId: machine.id, region }))
      : []);
    bundle.project = {
      ...(bundle.project ?? { schemaVersion: 1, assetDirectory: bundle.directory, interactions: [] }),
      behaviorMachines: machines,
    };
    const lookFollowSettings = normalizeSpineLookFollowSettings(bundle.project.lookFollow);
    bundle.lookFollow = { ...lookFollowSettings, enabled: lookFollowSettings.enabled && !hasAuthoredLookFollow(bundle.project) };
    const legacyProject = legacyExecutionProject(bundle.project);
    bundle.interaction = profileFromProject(bundle.meta.animations, legacyProject);
    bundle.authoredRegions = authoredRegions(legacyProject);
    bundle.eyeTarget = eyeTargetState(bundle.skeleton, bundle.touchTarget, lookFollowSettings, bundle.eyeTarget);
    bundle.behaviorRuntime.start();
    this.behaviorDebugSignature = "";
    this.emitBehaviorDebug(bundle);
  }

  /** Dispatch a deterministic test event from the Behavior Editor debugger. */
  testBehaviorEvent(machineId: string, event: SpineBehaviorEvent, regionId: string | null = null) {
    const bundle = this.bundle;
    if (!bundle) return;
    const activation = bundle.behaviorRuntime.getActivation(machineId);
    const pointerHeld = event === "pointer-press" || event === "pointer-drag"
      ? true
      : event === "pointer-release" || event === "pointer-cancel" || event === "pointer-leave"
        ? false
        : this.behaviorTestContext?.pointerHeld ?? false;
    this.behaviorTestMachineIds.add(machineId);
    this.behaviorTestContext = {
      machineId,
      pointerHeld,
      regionId,
      heldSeconds: pointerHeld ? 0 : this.behaviorTestContext?.heldSeconds ?? 0,
      dragDistance: activation?.trigger === "drag" ? activation.dragThreshold : 0,
    };
    const context = {
      ...this.behaviorRuntimeContext(regionId, this.behaviorTestContext.dragDistance),
      pointerHeld,
      heldSeconds: this.behaviorTestContext.heldSeconds,
      regionId,
    };
    bundle.behaviorRuntime.dispatch(event, context, [machineId], { bypassActivation: true });
    this.emitBehaviorDebug(bundle);
  }

  cancelBehaviorTest() {
    const bundle = this.bundle;
    if (this.behaviorTestContext) this.behaviorTestMachineIds.add(this.behaviorTestContext.machineId);
    const machineIds = [...this.behaviorTestMachineIds];
    this.behaviorTestMachineIds.clear();
    this.behaviorTestContext = null;
    if (!bundle || machineIds.length === 0) return;
    for (const machineId of machineIds) bundle.behaviorRuntime.cancel(machineId, "cancel");
    this.emitBehaviorDebug(bundle);
  }

  private createBehaviorRuntime(bundle: LoadedBundle, machines: readonly SpineBehaviorMachine[]): SpineBehaviorRuntime {
    return new SpineBehaviorRuntime(machines, {
      onActions: (machine, state, actions, phase) => this.applyBehaviorActions(bundle, machine, state, actions, phase),
      onOwnershipChange: (machine, state, owned) => {
        if (!owned) this.releaseBehaviorMachineResources(bundle, machine, state);
      },
    });
  }

  private applyBehaviorActions(
    bundle: LoadedBundle,
    machine: SpineBehaviorMachine,
    state: SpineBehaviorState,
    actions: readonly SpineBehaviorAction[],
    phase: "enter" | "update" | "exit" | "cancel",
  ) {
    // Compatibility-generated machines are mirrored for debugger visibility;
    // until their preset is edited, the parity-tested legacy executor owns them.
    if (machine.sourceLegacyInteractionId !== null || phase === "update") return;
    actions.forEach((action, index) => {
      const key = `${machine.id}/${state.id}/${index}`;
      if (phase === "enter") {
        switch (action.type) {
          case "play-animation": this.playBehaviorAnimation(bundle, action); break;
          case "pointer-follow":
          case "drag-bone":
          case "rotate-bone": this.beginBehaviorBoneControl(bundle, machine, state, key, action); break;
          case "play-audio": {
            try {
              const cleanup = this.callbacks.onBehaviorAudio?.(machine.id, action.audioId, action.volume, action.loop);
              if (cleanup) this.behaviorActionCleanups.set(key, { machineId: machine.id, cleanup });
            } catch (error) { this.callbacks.onError(errorFrom(error)); }
            break;
          }
          case "show-subtitle": {
            try {
              this.callbacks.onBehaviorSubtitle?.(machine.id, action.cueId, true);
              this.behaviorActionCleanups.set(key, { machineId: machine.id, cleanup: () => this.callbacks.onBehaviorSubtitle?.(machine.id, action.cueId, false) });
            } catch (error) { this.callbacks.onError(errorFrom(error)); }
            break;
          }
          case "set-variable": bundle.behaviorRuntime.setVariable(action.name, action.value); break;
          case "wait": break;
          case "restore-resource": break;
        }
        return;
      }

      switch (action.type) {
        case "play-animation": this.clearBehaviorAnimation(bundle, action); break;
        case "pointer-follow":
        case "drag-bone":
        case "rotate-bone": this.returnBehaviorBoneControl(key, action.type === "drag-bone" || action.type === "rotate-bone" ? action.returnDuration : 0.35); break;
        case "play-audio":
        case "show-subtitle": this.cleanupBehaviorAction(key); break;
        case "restore-resource": this.restoreBehaviorResource(bundle, machine, action.resource); break;
        case "set-variable":
        case "wait": break;
      }
    });
  }

  private behaviorAnimationPair(bundle: LoadedBundle, action: Extract<SpineBehaviorAction, { type: "play-animation" }>): { main: string | null; face: string | null } {
    const fallback = action.fallbackProfile === "look-start" ? bundle.interaction.look?.start
      : action.fallbackProfile === "look-end" ? bundle.interaction.look?.end
        : null;
    return {
      main: action.mainAnimation || fallback?.main || null,
      face: action.faceAnimation || fallback?.face || null,
    };
  }

  private playBehaviorAnimation(bundle: LoadedBundle, action: Extract<SpineBehaviorAction, { type: "play-animation" }>) {
    const pair = this.behaviorAnimationPair(bundle, action);
    if (pair.main && bundle.meta.animations.includes(pair.main)) setInteractionTrack(bundle.state, action.bodyTrack, pair.main, action.loop, action.mixDuration);
    else clearInteractionTrack(bundle.state, action.bodyTrack, true, action.mixDuration);
    if (pair.face && bundle.meta.animations.includes(pair.face)) setInteractionTrack(bundle.state, action.faceTrack, pair.face, action.loop, action.mixDuration);
    else clearInteractionTrack(bundle.state, action.faceTrack, true, action.mixDuration);
  }

  private clearBehaviorAnimation(bundle: LoadedBundle, action: Extract<SpineBehaviorAction, { type: "play-animation" }>) {
    clearInteractionTrack(bundle.state, action.bodyTrack, true, action.mixDuration);
    clearInteractionTrack(bundle.state, action.faceTrack, true, action.mixDuration);
  }

  private beginBehaviorBoneControl(
    bundle: LoadedBundle,
    machine: SpineBehaviorMachine,
    _state: SpineBehaviorState,
    key: string,
    action: Extract<SpineBehaviorAction, { type: "pointer-follow" | "drag-bone" | "rotate-bone" }>,
  ) {
    const targetPath = action.targetBonePath;
    const bone = targetPath
      ? bundle.skeleton.bones.find((candidate) => bonePath(candidate) === targetPath) ?? null
      : action.type === "pointer-follow"
        ? resolveEyeTargetBone(bundle.skeleton, bundle.lookFollow.targetBonePath)
        : null;
    if (!bone) return;
    const pointer = this.pointerWorld();
    const originLocal = pointer ? this.behaviorPointerToParentLocal(bundle, bone, pointer) : null;
    const baseWorld = bone.parent
      ? bone.parent.localToWorld(new Vector2(bone.x, bone.y))
      : new Vector2(bone.x + bundle.skeleton.x, bone.y + bundle.skeleton.y);
    this.behaviorControls.set(key, {
      key,
      machineId: machine.id,
      bone,
      action,
      baseX: bone.x,
      baseY: bone.y,
      baseRotation: bone.rotation,
      currentWorldX: baseWorld.x,
      currentWorldY: baseWorld.y,
      currentRotation: bone.rotation,
      originLocal,
      returning: false,
      returnElapsed: 0,
      returnDuration: 0.35,
      returnFromX: bone.x,
      returnFromY: bone.y,
      returnFromRotation: bone.rotation,
    });
  }

  private returnBehaviorBoneControl(key: string, duration: number) {
    const control = this.behaviorControls.get(key);
    if (!control) return;
    control.returning = true;
    control.returnElapsed = 0;
    control.returnDuration = Math.max(0.05, duration);
    control.returnFromX = control.bone.x;
    control.returnFromY = control.bone.y;
    control.returnFromRotation = control.bone.rotation;
  }

  private behaviorPointerToParentLocal(bundle: LoadedBundle, bone: Bone, point: { x: number; y: number }): { x: number; y: number } {
    if (bone.parent) {
      const local = bone.parent.worldToLocal(new Vector2(point.x, point.y));
      return { x: local.x, y: local.y };
    }
    return { x: point.x - bundle.skeleton.x, y: point.y - bundle.skeleton.y };
  }

  private applyBehaviorBoneControls(bundle: LoadedBundle, delta: number) {
    const pointer = this.pointerWorld();
    for (const [key, control] of this.behaviorControls) {
      if (!bundle.skeleton.bones.includes(control.bone)) {
        this.behaviorControls.delete(key);
        continue;
      }
      const bone = control.bone;
      if (control.returning) {
        control.returnElapsed += delta;
        const progress = Math.min(1, control.returnElapsed / control.returnDuration);
        const eased = 1 - (1 - progress) * (1 - progress);
        bone.x = control.returnFromX + (control.baseX - control.returnFromX) * eased;
        bone.y = control.returnFromY + (control.baseY - control.returnFromY) * eased;
        bone.rotation = control.returnFromRotation + (control.baseRotation - control.returnFromRotation) * eased;
        if (progress >= 1) {
          bone.x = control.baseX;
          bone.y = control.baseY;
          bone.rotation = control.baseRotation;
          this.behaviorControls.delete(key);
        }
        continue;
      }
      if (!pointer) continue;
      if (control.action.type === "pointer-follow") {
        const base = bone.parent
          ? bone.parent.localToWorld(new Vector2(control.baseX, control.baseY))
          : new Vector2(control.baseX + bundle.skeleton.x, control.baseY + bundle.skeleton.y);
        const automaticRange = this.bundle?.eyeTarget?.bone === bone
          ? this.bundle.eyeTarget
          : null;
        const rangeX = control.action.rangeX ?? automaticRange?.rangeX ?? Math.min(MAX_EYE_FOLLOW_RANGE, Math.max(MIN_TOUCH_FOLLOW_X, bundle.bounds.width * TOUCH_FOLLOW_SCENE_RATIO));
        const rangeY = control.action.rangeY ?? automaticRange?.rangeY ?? Math.min(MAX_EYE_FOLLOW_RANGE, Math.max(MIN_TOUCH_FOLLOW_Y, bundle.bounds.height * TOUCH_FOLLOW_SCENE_RATIO));
        const desired = lookFollowTarget(base, pointer, rangeX, rangeY, control.action.allowX, control.action.allowY);
        const smoothed = smoothLookFollowPoint({ x: control.currentWorldX, y: control.currentWorldY }, desired, delta, control.action.smoothing);
        control.currentWorldX = smoothed.x;
        control.currentWorldY = smoothed.y;
        const local = bone.parent
          ? bone.parent.worldToLocal(new Vector2(smoothed.x, smoothed.y))
          : new Vector2(smoothed.x - bundle.skeleton.x, smoothed.y - bundle.skeleton.y);
        bone.x = local.x;
        bone.y = local.y;
      } else if (control.originLocal) {
        const localPointer = this.behaviorPointerToParentLocal(bundle, bone, pointer);
        if (control.action.type === "drag-bone") {
          const dx = (localPointer.x - control.originLocal.x) * control.action.sensitivity;
          const dy = (localPointer.y - control.originLocal.y) * control.action.sensitivity;
          const desiredX = control.baseX + (control.action.allowX ? Math.max(-control.action.limitX, Math.min(control.action.limitX, dx)) : 0);
          const desiredY = control.baseY + (control.action.allowY ? Math.max(-control.action.limitY, Math.min(control.action.limitY, dy)) : 0);
          const factor = 1 - Math.exp(-delta * control.action.smoothing);
          bone.x = control.baseX + ((bone.x - control.baseX) + (desiredX - bone.x)) * factor;
          bone.y = control.baseY + ((bone.y - control.baseY) + (desiredY - bone.y)) * factor;
        } else {
          const distance = control.action.axis === "x" ? localPointer.x - control.originLocal.x : localPointer.y - control.originLocal.y;
          const offset = Math.max(control.action.minimum, Math.min(control.action.maximum, distance * 0.15));
          const desired = control.baseRotation + offset;
          const factor = 1 - Math.exp(-delta * 10);
          bone.rotation += (desired - bone.rotation) * factor;
        }
      }
    }
  }

  private releaseBehaviorMachineResources(bundle: LoadedBundle, machine: SpineBehaviorMachine, state: SpineBehaviorState) {
    for (const control of this.behaviorControls.values()) {
      if (control.machineId === machine.id) this.returnBehaviorBoneControl(control.key, control.action.type === "drag-bone" || control.action.type === "rotate-bone" ? control.action.returnDuration : 0.35);
    }
    for (const resource of [...machine.resourceClaims, ...state.resourceClaims]) {
      if (!resource.startsWith("track:")) continue;
      const track = Number(resource.slice("track:".length));
      if (Number.isInteger(track) && track > 0 && track <= 32) clearInteractionTrack(bundle.state, track, true);
    }
    for (const [key, entry] of this.behaviorActionCleanups) if (entry.machineId === machine.id) this.cleanupBehaviorAction(key);
  }

  private restoreBehaviorResource(bundle: LoadedBundle, machine: SpineBehaviorMachine, resource: string) {
    if (resource === "all" || resource === "controlled-bones" || resource === "interaction-motion") {
      for (const control of this.behaviorControls.values()) if (control.machineId === machine.id) this.returnBehaviorBoneControl(control.key, 0.35);
      if (resource === "interaction-motion") resetInteractionMotion(this.motionState());
    }
    if (resource === "all" || resource === "animation-tracks") {
      for (const claim of [...machine.resourceClaims, ...machine.states.flatMap((state) => state.resourceClaims)]) {
        if (!claim.startsWith("track:")) continue;
        const track = Number(claim.slice("track:".length));
        if (Number.isInteger(track) && track > 0 && track <= 32) clearInteractionTrack(bundle.state, track, true);
      }
    }
    if (resource === "all" || resource === "audio" || resource === "subtitle") {
      for (const [key, entry] of this.behaviorActionCleanups) {
        if (entry.machineId === machine.id) this.cleanupBehaviorAction(key);
      }
    }
  }

  private cleanupBehaviorAction(key: string) {
    const entry = this.behaviorActionCleanups.get(key);
    if (!entry) return;
    this.behaviorActionCleanups.delete(key);
    try { entry.cleanup(); } catch (error) { this.callbacks.onError(errorFrom(error)); }
  }

  private clearBehaviorSideEffects() {
    for (const entry of this.behaviorActionCleanups.values()) {
      try { entry.cleanup(); } catch (error) { this.callbacks.onError(errorFrom(error)); }
    }
    this.behaviorActionCleanups.clear();
    for (const control of this.behaviorControls.values()) {
      control.bone.x = control.baseX;
      control.bone.y = control.baseY;
      control.bone.rotation = control.baseRotation;
    }
    this.behaviorControls.clear();
    this.behaviorTestContext = null;
    this.behaviorTestMachineIds.clear();
  }

  private updateBehaviorAnimationCompletions(bundle: LoadedBundle) {
    for (const completion of bundle.behaviorRuntime.getAnimationCompletions()) {
      const complete = completion.tracks.every(({ track, channel, animation, fallbackProfile }) => {
        const fallback = fallbackProfile === "look-start" ? bundle.interaction.look?.start
          : fallbackProfile === "look-end" ? bundle.interaction.look?.end
            : null;
        const name = animation || (channel === "body" ? fallback?.main : fallback?.face) || null;
        if (!name) return true;
        if (!bundle.meta.animations.includes(name)) return true;
        const entry = bundle.state.getCurrent(track);
        if (!entry) return true;
        if (entry.animation?.name !== name) return false;
        return !entry.loop && entry.trackTime >= (entry.animation?.duration ?? 0);
      });
      if (complete) bundle.behaviorRuntime.notifyAnimationComplete(completion.machineId, this.behaviorRuntimeContext());
    }
  }

  /** Enables a pointer-driven look preview without activating hit-region gestures. */
  setLookFollowPreview(enabled: boolean) {
    this.lookFollowPreview = enabled;
    this.interactionPointer = null;
    this.eyeFollowHold = 0;
    if (!enabled) this.endLook();
  }

  setLookFollowPreviewPointer(clientX: number | null, clientY: number | null) {
    if (!this.lookFollowPreview || clientX === null || clientY === null) {
      this.interactionPointer = null;
      this.eyeFollowHold = 0;
      this.endLook();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    this.interactionPointer = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
    if (!this.interactionPointer) {
      this.eyeFollowHold = 0;
      this.endLook();
    }
  }

  setLoop(loop: boolean) {
    this.loop = loop;
    const entry = this.bundle?.state.getCurrent(0);
    if (entry) {
       if (entry.animation?.name !== this.bundle?.meta.introAnimation) entry.loop = loop;
      if (entry.next) entry.next.loop = loop;
    }
  }

  setCameraMode(mode: SpineCameraMode) {
    if (this.interactionMode === "interaction" && mode !== "fit" && mode !== "game" && mode !== "authored") return;
    if (this.cameraMode === mode) return;
    this.authoredCameraFrame = null;
    this.cameraMode = mode;
    this.pendingFit = true;
  }

  setInteractionMode(mode: SpineInteractionMode) {
    if (this.interactionMode === mode) {
      if (mode === "interaction" && this.cameraMode !== "fit" && this.cameraMode !== "game" && this.cameraMode !== "authored") {
        this.cameraMode = "fit";
        this.pendingFit = true;
        this.callbacks.onCameraMode?.("fit");
      }
      return;
    }

    this.interactionMode = mode;
    if (mode !== "interaction") this.bundle?.behaviorRuntime?.cancelAll("cancel");
    this.lookFollowPreview = false;
    this.resetInteractionTargets();
    this.interactionPointer = null;
    this.interactionPointerId = null;
    this.interactionPointerHeld = false;
    this.behaviorPointerHeldSeconds = 0;
    this.interactionPressedTarget = null;
    this.interactionPressedBehaviorRegionId = null;
    this.behaviorPressDispatched = false;
    this.interactionPressedTrigger = "hold";
    this.interactionPressOrigin = null;
    this.activeGestureInteractionId = null;
    this.pointerInside = false;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.activeTalkIndex = -1;
    this.talkEventIndex = 0;
    this.interactionReady = false;
    this.introAudioEntry = null;
    this.introEventIndex = 0;
    this.eyeFollowHold = 0;
    this.interactionFollowWorld = null;
    this.touchPointerOrigin = null;
    this.touchFollowOffset = null;
    if (mode === "interaction") {
      this.freeAnimationSelection = this.animationSelection;
      this.freeCameraMode = this.cameraMode;
      this.cameraMode = "fit";
      this.pendingFit = true;
      this.callbacks.onCameraMode?.("fit");
      this.enterInteraction();
    } else {
      this.activeTalkIndex = -1;
      this.talkEventIndex = 0;
      this.talkAudioPending = false;
      this.talkFadeQueued = false;
      this.clearInteractionTracks();
      this.cameraMode = this.freeCameraMode;
      this.pendingFit = true;
      this.callbacks.onCameraMode?.(this.cameraMode);
      const selection = this.freeAnimationSelection || this.animationSelection;
      this.animationSelection = selection;
      this.applyBaseAnimation(selection, true);
    }
  }

  triggerTalk(requestedAnimation?: string) {
    if (this.interactionMode !== "interaction" || !this.interactionReady || !this.bundle || this.bundle.interaction.talks.length === 0) return;
    // Do not let manual or programmatic Talk requests replace an active
    // dialogue; auto-play may replace it only after its voice has finished,
    // where the configured track mix blends the two Talk poses directly.
    const crossfadingFinishedTalk = this.interactionState === "talk" && !this.talkAudioPending && this.talkFadeQueued;
    if (this.interactionState !== "idle" && !crossfadingFinishedTalk) return;
    const requested = requestedAnimation
      ? this.bundle.interaction.talks.findIndex((talk) => {
        const wanted = basename(requestedAnimation).toLocaleLowerCase();
        const actual = basename(talk.main).toLocaleLowerCase();
        if (wanted === actual) return true;
        const wantedNumber = talkNumber(requestedAnimation);
        return wantedNumber !== null && talkNumber(talk.main) === wantedNumber;
      })
      : -1;
    if (requestedAnimation && requested < 0) return;
    const index = (requested >= 0 ? requested : this.talkIndex) % this.bundle.interaction.talks.length;
    const pair = this.bundle.interaction.talks[index]!;
    const eventTimes = talkEventTimes(this.bundle.skeleton.data.findAnimation(pair.main), talkNumber(pair.main));
    this.talkIndex = (this.talkIndex + 1) % this.bundle.interaction.talks.length;
    this.activeTalkIndex = index;
    this.talkEventIndex = 0;
    this.talkAudioPending = this.callbacks.onTalk?.(index, pair.main, eventTimes.length) === true;
    this.talkFadeQueued = !this.talkAudioPending;
    this.interactionState = "talk";
    this.interactionTrackName = pair.main;
    this.eyeFollowHold = 0;
    this.resetInteractionTargets();
    this.clearOverlay(3);
    this.clearOverlay(4);
    const talkMix = normalizeAnimationMixDuration(this.bundle.project?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
    const main = this.playOverlayPair(pair, 5, 6, false, !this.talkAudioPending, talkMix);
    if (this.talkAudioPending) {
      if (main) {
        main.listener = {
          event: (entry, event) => {
            const state = this.bundle?.state;
            if (this.interactionState !== "talk" || !state || entry !== state.getCurrent(5) || this.talkEventIndex >= eventTimes.length) return;
            const expectedTime = eventTimes[this.talkEventIndex]!;
            if (Math.abs(event.time - expectedTime) > 0.001) return;
            this.callbacks.onTalkClip?.(this.activeTalkIndex, this.talkEventIndex++);
          },
        };
      }
      if (!main || eventTimes.length === 0) this.callbacks.onTalkClip?.(index, 0);
    }
  }

  setTalkAudioPending(pending: boolean) {
    this.talkAudioPending = pending;
    if (pending || this.interactionState !== "talk") return;
    const state = this.bundle?.state;
    if (!state) return;
    if (!this.talkFadeQueued) {
      const mix = normalizeAnimationMixDuration(this.bundle?.project?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
      for (const track of [5, 6]) {
        const current = state.getCurrent(track);
        if (!current) continue;
        if (!current.loop && current.trackTime >= (current.animation?.duration ?? 0)) state.setEmptyAnimation(track, mix);
        else queueInteractionFadeOut(state, track, mix);
      }
      this.talkFadeQueued = true;
    }
    this.finishInteractionState();
  }

  isTalkActive(): boolean {
    return this.interactionState === "talk";
  }

  isInteractionBusy(): boolean {
    return this.interactionState !== "idle";
  }

  /** Attach the intro voice listener after the local voice catalog has loaded. */
  startIntroAudio() {
    this.attachIntroAudio();
  }

  setAnimation(animation: string, restart = false) {
    if (!this.bundle || !animation || (!restart && animation === this.animationSelection)) return;
    if (this.interactionMode === "interaction") return;
    this.animationSelection = animation;
    this.applyBaseAnimation(animation, restart);
  }

  private applyBaseAnimation(animation: string, _restart = false) {
    const bundle = this.bundle;
    if (!bundle || !animation) return;
    const { skeleton, state, meta } = bundle;
    this.resetInteractionTargets();
    skeleton.setToSetupPose();
    state.clearTracks();
    if (animation === INTRO_ANIMATION && meta.introAnimation && meta.idleAnimation) {
      const intro = state.setAnimation(0, meta.introAnimation, false);
      state.addAnimation(0, meta.idleAnimation, this.interactionMode === "interaction" ? true : this.loop, 0);
      meta.duration = intro.animation?.duration ?? 0;
      this.introAudioEntry = null;
      this.introEventIndex = 0;
      this.attachIntroAudio(intro);
    } else {
      const entry = state.setAnimation(0, animation, this.interactionMode === "interaction" ? true : this.loop);
      meta.duration = entry.animation?.duration ?? 0;
    }
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.update);
    if (bundle.eyeTarget) {
      bundle.eyeTarget.baseX = bundle.eyeTarget.bone.x;
      bundle.eyeTarget.baseY = bundle.eyeTarget.bone.y;
    }
    if (bundle.touchTarget) {
      bundle.touchTarget.baseX = bundle.touchTarget.bone.x;
      bundle.touchTarget.baseY = bundle.touchTarget.bone.y;
    }
    this.interactionFollowWorld = null;
    this.touchPointerOrigin = null;
    this.touchFollowOffset = null;
  }

  private attachIntroAudio(entry = this.bundle?.state.getCurrent(0) ?? null) {
    const bundle = this.bundle;
    if (!bundle || !entry || entry.animation?.name !== bundle.meta.introAnimation || this.introAudioEntry === entry) return;
    this.introEventIndex = 0;
    const eventTimes = talkEventTimes(entry.animation, 0);
    const pending = this.callbacks?.onIntro?.(entry.animation.name, eventTimes.length) === true;
    if (!pending) {
      // The voice catalog can arrive after the Spine set. Leave this entry
      // retryable so startIntroAudio() can attach the listener later.
      this.introAudioEntry = null;
      return;
    }
    this.introAudioEntry = entry;
    entry.listener = {
      event: (current, event) => {
        if (current !== this.introAudioEntry || this.bundle?.state.getCurrent(0) !== current || this.introEventIndex >= eventTimes.length) return;
        const expectedTime = eventTimes[this.introEventIndex]!;
        if (Math.abs(event.time - expectedTime) > 0.001) return;
        this.callbacks?.onIntroClip?.(this.introEventIndex++);
      },
    };
    if (eventTimes.length === 0) this.callbacks?.onIntroClip?.(0);
  }

  private enterInteraction() {
    const bundle = this.bundle;
    if (!bundle) return;
    this.playing = true;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.talkAudioPending = false;
    this.talkFadeQueued = false;
    this.eyeFollowHold = 0;
    this.interactionFollowWorld = null;
    this.interactionPressedTarget = null;
    this.interactionPressedTrigger = "hold";
    this.interactionPressOrigin = null;
    this.activeGestureInteractionId = null;
    this.interactionReady = this.skipIntro || !(bundle.meta.introAnimation && bundle.meta.idleAnimation);
    const selection = !this.skipIntro && bundle.meta.introAnimation && bundle.meta.idleAnimation
      ? INTRO_ANIMATION
      : bundle.meta.idleAnimation ?? "";
    this.animationSelection = selection;
    this.applyBaseAnimation(selection, true);
  }

  private clearInteractionTracks() {
    const state = this.bundle?.state;
    if (!state) return;
    for (const track of [1, 2, 3, 4, 5, 6]) state.clearTrack(track);
    if (this.bundle) {
      state.apply(this.bundle.skeleton);
      this.bundle.skeleton.updateWorldTransform(Physics.update);
    }
  }

  private resetInteractionTargets(resetBasePose = true) {
    const bundle = this.bundle;
    resetInteractionMotion(this.motionState());
    if (resetBasePose) {
      for (const target of [bundle?.eyeTarget, bundle?.touchTarget]) {
        if (!target) continue;
        target.bone.x = target.baseX;
        target.bone.y = target.baseY;
      }
    }
    this.interactionFollowWorld = null;
    this.touchPointerOrigin = null;
    this.touchFollowOffset = null;
    bundle?.skeleton.updateWorldTransform(Physics.pose);
  }

  /** Restore the previous frame's input offset before animation timelines run. */
  private restoreInteractionPose() {
    beforeInteractionMotion(this.motionState());
  }

  private motionState(): SpineInteractionMotionState {
    if (!this.interactionMotionState) this.interactionMotionState = createInteractionMotionState();
    return this.interactionMotionState;
  }

  private clearOverlay(track: number, smooth = false, mixDuration = DEFAULT_INTERACTION_PHASE_MIX) {
    const state = this.bundle?.state;
    if (!state) return;
    clearInteractionTrack(state, track, smooth, mixDuration);
  }

  private playOverlayPair(pair: SpineAnimationPair, mainTrack: number, faceTrack: number, loop: boolean, clearAfter: boolean, mixDuration = DEFAULT_INTERACTION_PHASE_MIX): TrackEntry | null {
    const bundle = this.bundle;
    if (!bundle) return null;
    const mix = normalizeAnimationMixDuration(mixDuration);
    const main = setInteractionTrack(bundle.state, mainTrack, pair.main, loop, mix);
    if (clearAfter && !loop) queueInteractionFadeOut(bundle.state, mainTrack, mix);
    if (pair.face) {
      setInteractionTrack(bundle.state, faceTrack, pair.face, loop, mix);
      if (clearAfter && !loop) queueInteractionFadeOut(bundle.state, faceTrack, mix);
    } else {
      clearInteractionTrack(bundle.state, faceTrack, true, mix);
    }
    // Keep the local variable meaningful for zero-duration authored poses.
    if (main) main.trackTime = Math.max(0, main.trackTime);
    return main;
  }

  private beginLook() {
    const bundle = this.bundle;
    if (!bundle?.lookFollow.enabled || !bundle.eyeTarget || this.interactionState !== "idle"
      || !this.compatibilityMachineCanExecute("$legacy-look-follow")) return;
    const profile = bundle.interaction.look;
    this.interactionState = "look";
    this.interactionTrackName = profile?.start.main ?? null;
    if (profile) this.playOverlayPair(profile.start, 1, 2, false, false);
  }

  private endLook() {
    const bundle = this.bundle;
    if (!bundle || this.interactionState !== "look") return;
    if (!this.compatibilityMachineCanExecute("$legacy-look-follow")) {
      this.abandonLegacyInteraction();
      return;
    }
    this.resetInteractionTargets();
    const end = bundle.interaction.look?.end;
    if (end) {
      this.interactionState = "lookRelease";
      this.interactionTrackName = end.main;
      this.playOverlayPair(end, 1, 2, false, true);
    } else {
      this.clearOverlay(1, true);
      this.clearOverlay(2, true);
      this.interactionState = "idle";
      this.interactionTrackName = null;
    }
  }

  private gestureKind(state: SpineInteractionState = this.interactionState): GestureKind | null {
    if (state.startsWith("pat")) return "pat";
    if (state.startsWith("pinch")) return "pinch";
    if (state.startsWith("touch")) return "touch";
    return null;
  }

  private gestureInteraction(kind: GestureKind, interactionId?: string | null): SpineAuthoredInteraction | null {
    const project = this.bundle?.project;
    if (!interactionId) return authoredInteraction(project, kind);
    return project?.interactions.find((item) => item.enabled && item.id === interactionId && interactionKind(item) === kind) ?? null;
  }

  private gestureAction(kind: GestureKind, interactionId: string | null = this.activeGestureInteractionId): SpineInteractionAction | null {
    const bundle = this.bundle;
    if (!bundle) return null;
    const authored = this.gestureInteraction(kind, interactionId);
    if (authored) return authoredInteractionAction(bundle.meta.animations, authored);
    const interaction = bundle.interaction;
    return kind === "pat" ? interaction?.pat ?? null : kind === "pinch" ? interaction?.pinch ?? null : interaction?.touch ?? null;
  }

  private playGestureRelease(kind: GestureKind) {
    const bundle = this.bundle;
    if (!bundle) return;
    if (this.activeGestureInteractionId && !this.compatibilityMachineCanExecute(this.activeGestureInteractionId)) {
      this.abandonLegacyInteraction();
      return;
    }
    beginInteractionMotionReturn(this.motionState());
    const release = this.gestureAction(kind)?.release;
    if (release) {
      this.interactionState = `${kind}Release` as `${GestureKind}Release`;
      this.interactionTrackName = release.main;
      this.playOverlayPair(release, 3, 4, false, true, this.interactionMixDuration(kind, "release", this.activeGestureInteractionId));
    } else {
      const mix = this.interactionMixDuration(kind, "release", this.activeGestureInteractionId);
      this.clearOverlay(3, true, mix);
      this.clearOverlay(4, true, mix);
      this.interactionState = `${kind}Release` as `${GestureKind}Release`;
      this.interactionTrackName = null;
    }
  }

  private beginGesture(target: InteractionHitTarget): boolean {
    const state = target.kind as GestureKind;
    if (target.interactionId && !this.compatibilityMachineCanExecute(target.interactionId)) return false;
    const authored = this.gestureInteraction(state, target.interactionId);
    const action = authored
      ? authoredInteractionAction(this.bundle?.meta.animations ?? [], authored)
      : this.gestureAction(state, null);
    if (!action || this.interactionState !== "idle") return false;
    const bundle = this.bundle;
    if (!bundle) return false;
    this.activeGestureInteractionId = authored?.id ?? null;
    this.interactionState = `${state}Start` as `${GestureKind}Start`;
    this.interactionTrackName = action.start.main;
    this.eyeFollowHold = 0;
    this.interactionFollowWorld = null;
    const pointer = this.pointerWorld();
    this.touchPointerOrigin = pointer ? { x: pointer.x, y: pointer.y } : null;
    this.touchFollowOffset = null;
    const motion: SpineMotionInteraction = authored ?? {
      startAnimation: action.start.main,
      followTargetBone: null,
      sensitivity: 0.25,
      limitX: bundle.touchTarget?.rangeX ?? MAX_TOUCH_FOLLOW_X,
      limitY: bundle.touchTarget?.rangeY ?? MAX_TOUCH_FOLLOW_Y,
      smoothing: 8,
    };
    beginInteractionMotion(this.motionState(), motion, state, this.touchPointerOrigin);
    this.clearOverlay(5);
    this.clearOverlay(6);
    this.playOverlayPair(action.start, 3, 4, false, false, this.interactionMixDuration(state, "start", this.activeGestureInteractionId));
    return true;
  }

  private interactionMixDuration(kind: GestureKind, phase: "start" | "follow" | "release", interactionId: string | null = this.activeGestureInteractionId): number {
    const interaction = this.gestureInteraction(kind, interactionId);
    const value = phase === "start" ? interaction?.startMixDuration
      : phase === "follow" ? interaction?.followMixDuration
        : interaction?.releaseMixDuration;
    return normalizeAnimationMixDuration(value, DEFAULT_INTERACTION_PHASE_MIX);
  }

  private endGesture() {
    const bundle = this.bundle;
    const kind = this.gestureKind();
    if (!bundle || !kind || this.interactionState === `${kind}Release`) return;
    if (this.activeGestureInteractionId && !this.compatibilityMachineCanExecute(this.activeGestureInteractionId)) {
      this.abandonLegacyInteraction();
      return;
    }
    this.playGestureRelease(kind);
  }

  private compatibilityMachineCanExecute(legacyId: string): boolean {
    const bundle = this.bundle;
    if (!bundle?.behaviorRuntime) return true;
    const mirror = bundle.behaviorRuntime.getActiveStates()
      .find(({ machine }) => machine.sourceLegacyInteractionId === legacyId);
    return !mirror || bundle.behaviorRuntime.canExecuteMachine(mirror.machine.id);
  }

  /** Stop legacy visual updates without clearing tracks that may now have a new owner. */
  private abandonLegacyInteraction() {
    this.resetInteractionTargets(false);
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.activeGestureInteractionId = null;
    this.eyeFollowHold = 0;
  }

  private interactionAnimationFinished(track: number): boolean {
    const current = this.bundle?.state.getCurrent(track);
    if (!current || current.animation?.name !== this.interactionTrackName) return true;
    return !current.loop && current.trackTime >= (current.animation?.duration ?? 0);
  }

  private finishInteractionState() {
    const bundle = this.bundle;
    if (!bundle) return;
    const kind = this.gestureKind();
    const gestureRelease = Boolean(kind && this.interactionState === `${kind}Release`);
    if (gestureRelease) {
      if (this.interactionTrackName && !this.interactionAnimationFinished(3)) return;
      if (!interactionMotionReturnComplete(this.motionState())) return;
      this.dispatchBehaviorEvent("animation-complete");
      this.interactionState = "idle";
      this.interactionTrackName = null;
      this.activeGestureInteractionId = null;
      this.activeTalkIndex = -1;
      this.talkEventIndex = 0;
      this.talkFadeQueued = false;
      this.eyeFollowHold = 0;
      this.resetInteractionTargets(false);
      return;
    }
    if (!this.interactionTrackName) return;
    if (kind && this.interactionState === `${kind}Start`) {
      if (!this.interactionAnimationFinished(3)) return;
      this.dispatchBehaviorEvent("animation-complete");
      if (interactionPhaseAfterStart(this.interactionPressedTrigger, this.interactionPointerHeld) === "releasing") {
        this.playGestureRelease(kind);
      } else if (this.interactionPointerHeld
        && this.interactionPressedTarget?.kind === kind
        && (!this.interactionPressedTarget.interactionId || this.interactionPressedTarget.interactionId === this.activeGestureInteractionId)) {
        const action = this.gestureAction(kind);
        if (!action) return;
        this.interactionState = kind;
        this.interactionTrackName = action.follow.main;
        this.playOverlayPair(action.follow, 3, 4, true, false, this.interactionMixDuration(kind, "follow", this.activeGestureInteractionId));
      } else {
        this.playGestureRelease(kind);
      }
      return;
    }
    const track = this.interactionState === "lookRelease"
      ? 1
      : ["patRelease", "pinchRelease", "touchRelease"].includes(this.interactionState)
        ? 3
        : this.interactionState === "talk"
          ? 5
          : -1;
    if (track < 0) return;
    if (this.interactionState === "talk" && this.talkAudioPending) return;
    if (!this.interactionAnimationFinished(track)) return;
    this.dispatchBehaviorEvent("animation-complete");
    if (this.interactionState === "talk" && this.talkFadeQueued
      && (bundle.state.getCurrent(5) || bundle.state.getCurrent(6))) return;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.activeGestureInteractionId = null;
    this.activeTalkIndex = -1;
    this.talkEventIndex = 0;
    this.talkFadeQueued = false;
    this.eyeFollowHold = 0;
    this.resetInteractionTargets();
  }

  restartPlayback() {
    if (!this.bundle) return;
    this.playing = true;
    if (this.interactionMode === "interaction") this.enterInteraction();
    else this.setAnimation(this.animationSelection, true);
  }

  replayIntro() {
    const bundle = this.bundle;
    const introAnimation = bundle?.meta.introAnimation;
    const idleAnimation = bundle?.meta.idleAnimation;
    if (!bundle || !introAnimation || !idleAnimation) return;
    this.playing = true;
    if (this.interactionMode === "interaction") {
      this.resetInteractionTargets();
      this.interactionState = "idle";
      this.interactionTrackName = null;
      this.interactionReady = false;
      this.interactionPressedTarget = null;
      this.interactionPressedTrigger = "hold";
      this.interactionPressOrigin = null;
      this.activeGestureInteractionId = null;
    }
    this.animationSelection = INTRO_ANIMATION;
    const { skeleton, state } = bundle;
    skeleton.setToSetupPose();
    state.clearTracks();
    state.setAnimation(0, introAnimation, false);
    state.addAnimation(0, idleAnimation, this.loop, 0);
    this.introAudioEntry = null;
    this.introEventIndex = 0;
    this.attachIntroAudio(state.getCurrent(0));
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.update);
    if (bundle.eyeTarget) {
      bundle.eyeTarget.baseX = bundle.eyeTarget.bone.x;
      bundle.eyeTarget.baseY = bundle.eyeTarget.bone.y;
    }
    this.pendingFit = true;
  }

  seek(time: number) {
    const entry = this.bundle?.state.getCurrent(0);
    if (!entry) return;
    entry.trackTime = Math.max(0, Math.min(entry.animation?.duration ?? 0, time));
    entry.trackLast = -1;
  }

  /** Deterministic authoring sample: idle under body/face tracks, with no event playback. */
  sampleEditorAnimation(animation: string, face: string, time: number, loop: boolean, idleUnderlay = false, preserveInteractions = false, animationAlpha = 1, faceAlpha = animationAlpha, idleTime = time, sequenceId = "legacy") {
    const bundle = this.bundle;
    if (!bundle) return;
    const sequenceChanged = preserveInteractions && sequenceId !== this.sampledEditorSequenceId;
    const openingIntro = Boolean(bundle.meta.introAnimation && bundle.meta.idleAnimation && animation === bundle.meta.introAnimation);
    if (preserveInteractions && (sequenceChanged || (openingIntro && this.interactionReady))) this.resetTimelineInteractionState();
    if (preserveInteractions) {
      this.sampledEditorSequenceId = sequenceId;
      this.sampledEditorTalkSequence = /^talk-\d+$/i.test(sequenceId);
      this.interactionReady = !openingIntro;
    }
    if (!preserveInteractions) this.playing = false;
    if (preserveInteractions) this.restoreInteractionPose();
    const previousBase = bundle.state.getCurrent(0);
    const previousAnimation = previousBase?.animation?.name ?? null;
    const sameAnimation = previousAnimation === animation;
    const previousTime = sameAnimation ? previousBase?.trackTime ?? null : null;
    const introListener = animation === bundle.meta.introAnimation && sameAnimation ? previousBase?.listener ?? null : null;
    if (previousAnimation === bundle.meta.introAnimation && !sameAnimation) this.introAudioEntry = null;
    bundle.skeleton.setToSetupPose();
    if (preserveInteractions) {
      bundle.state.clearTrack(0);
      bundle.state.clearTrack(7);
      bundle.state.clearTrack(8);
    }
    else bundle.state.clearTracks();
    const apply = (name: string, track: number, repeat = loop, sampleTime = time): TrackEntry | null => {
      const data = bundle.skeleton.data.findAnimation(name);
      if (!data) return null;
      const entry = bundle.state.setAnimation(track, name, repeat);
      entry.trackEnd = Number.POSITIVE_INFINITY;
      const clampedTime = Math.max(0, sampleTime);
      entry.trackTime = repeat && data.duration > 0 ? clampedTime % data.duration : Math.min(clampedTime, data.duration);
      if (track === 0) {
        const last = previousTime !== null && previousTime <= entry.trackTime ? previousTime : entry.trackTime;
        entry.animationLast = last;
        entry.trackLast = last;
        entry.nextAnimationLast = last;
        entry.nextTrackLast = last;
      }
      return entry;
    };
    let baseEntry: TrackEntry | null = null;
    if (preserveInteractions) {
      // Keep gesture tracks 1–6, but do not drop the authored idle underlay
      // or face. Timeline Talk uses isolated high-priority tracks so it can sit
      // over Idle without replacing it or mutating live interaction overlays.
      bundle.state.clearTrack(9);
      bundle.state.clearTrack(10);
      const underlay = idleUnderlay && bundle.meta.idleAnimation ? apply(bundle.meta.idleAnimation, 0, true, idleTime) : null;
      if (underlay) underlay.timeScale = 0;
      baseEntry = apply(animation, idleUnderlay ? 9 : 0);
      if (baseEntry) {
        baseEntry.timeScale = 0;
        if (idleUnderlay) baseEntry.alpha = animationAlpha;
      }
      const faceTrack = bundle.state.getCurrent(2);
      const authoredFaceActive = Boolean(this.sampledEditorFace && faceTrack?.animation?.name === this.sampledEditorFace);
      const interactionFaceActive = idleUnderlay
        ? Boolean(bundle.state.getCurrent(4))
        : Boolean(bundle.state.getCurrent(4) || bundle.state.getCurrent(6) || (faceTrack && !authoredFaceActive));
      if (face && !interactionFaceActive) {
        const faceEntry = apply(face, idleUnderlay ? 10 : 2);
        if (faceEntry) { faceEntry.timeScale = 0; faceEntry.alpha = faceAlpha; }
        if (!idleUnderlay) this.sampledEditorFace = face;
      } else if (!face && authoredFaceActive) {
        bundle.state.clearTrack(2);
        this.sampledEditorFace = "";
      }
    } else {
      if (idleUnderlay && bundle.meta.idleAnimation) apply(bundle.meta.idleAnimation, 0, true);
      baseEntry = apply(animation, idleUnderlay ? 1 : 0);
      if (baseEntry && idleUnderlay) baseEntry.alpha = animationAlpha;
      if (face) {
        const faceEntry = apply(face, 2);
        if (faceEntry) faceEntry.alpha = faceAlpha;
        this.sampledEditorFace = face;
      } else {
        this.sampledEditorFace = "";
      }
    }
    if (baseEntry && introListener) {
      baseEntry.listener = introListener;
      this.introAudioEntry = baseEntry;
    }
    bundle.state.apply(bundle.skeleton);
    bundle.skeleton.updateWorldTransform(Physics.reset);
    if (preserveInteractions) rebaseInteractionMotion(this.motionState());
  }

  private resetTimelineInteractionState() {
    const state = this.bundle?.state;
    this.bundle?.behaviorRuntime?.cancelAll("cancel");
    this.resetInteractionTargets();
    for (const track of [1, 2, 3, 4, 5, 6]) state?.clearTrack(track);
    this.interactionPointer = null;
    this.interactionPointerId = null;
    this.interactionPointerHeld = false;
    this.behaviorPointerHeldSeconds = 0;
    this.interactionPressedTarget = null;
    this.interactionPressedBehaviorRegionId = null;
    this.behaviorPressDispatched = false;
    this.interactionPressedTrigger = "hold";
    this.interactionPressOrigin = null;
    this.activeGestureInteractionId = null;
    this.pointerInside = false;
    this.interactionState = "idle";
    this.interactionTrackName = null;
    this.talkAudioPending = false;
    this.talkFadeQueued = false;
    this.activeTalkIndex = -1;
    this.talkEventIndex = 0;
    this.eyeFollowHold = 0;
    this.interactionFollowWorld = null;
    this.touchPointerOrigin = null;
    this.touchFollowOffset = null;
    this.sampledEditorFace = "";
  }

  /** Play an authored interaction phase over the idle pose in the private editor. */
  previewEditorPhase(animation: string, face: string, loop: boolean) {
    const bundle = this.bundle;
    if (!bundle) return;
    this.playing = true;
    // The phase preview uses separate body/face tracks. Clear the normal
    // animation selection so choosing the same animation from the timeline
    // afterward still restores a regular base-track preview.
    this.animationSelection = "";
    bundle.skeleton.setToSetupPose();
    bundle.state.clearTracks();
    const apply = (name: string | null | undefined, track: number, repeat: boolean) => {
      if (!name) return;
      const data = bundle.skeleton.data.findAnimation(name);
      if (!data) return;
      bundle.state.setAnimation(track, name, repeat);
    };
    apply(bundle.meta.idleAnimation, 0, true);
    apply(animation, 1, loop);
    apply(face, 2, loop);
    bundle.state.apply(bundle.skeleton);
    bundle.skeleton.updateWorldTransform(Physics.reset);
  }

  getEditorAnimationInfo(animation: string) {
    const data = this.bundle?.skeleton.data.findAnimation(animation);
    return { duration: data?.duration ?? 0, markers: talkEventTimes(data ?? null) };
  }

  getEditorFrame(): SpineEditorFrame | null {
    return this.editorFrame();
  }

  private editorFrame(): SpineEditorFrame | null {
    const bundle = this.bundle;
    if (!bundle || this.canvas.width <= 0 || this.canvas.height <= 0) return null;
    const screen = (x: number, y: number) => {
      const projected = this.renderer.camera.worldToScreen(new Vector3(x, y, 0), this.canvas.width, this.canvas.height);
      // Spine's WebGL projection reports screen Y from the bottom edge. The
      // editor overlay is an HTML/SVG layer whose origin is at the top edge.
      return { x: projected.x, y: this.canvas.height - projected.y };
    };
    const originScreen = screen(0, 0);
    const unitXScreen = screen(1, 0);
    const unitYScreen = screen(0, 1);
    const eyeTarget = bundle.eyeTarget;
    const lookBaseWorld = eyeTarget
      ? eyeTarget.bone.parent
        ? eyeTarget.bone.parent.localToWorld(new Vector2(eyeTarget.baseX, eyeTarget.baseY))
        : new Vector2(eyeTarget.baseX + bundle.skeleton.x, eyeTarget.baseY + bundle.skeleton.y)
      : null;
    const lookFollow = eyeTarget && lookBaseWorld
      ? {
        targetBonePath: bonePath(eyeTarget.bone),
        centerScreenX: screen(lookBaseWorld.x, lookBaseWorld.y).x,
        centerScreenY: screen(lookBaseWorld.x, lookBaseWorld.y).y,
        currentScreenX: screen(eyeTarget.bone.worldX, eyeTarget.bone.worldY).x,
        currentScreenY: screen(eyeTarget.bone.worldX, eyeTarget.bone.worldY).y,
        rangeX: eyeTarget.rangeX,
        rangeY: eyeTarget.rangeY,
        active: this.interactionState === "look",
      }
      : null;
    const bones = bundle.skeleton.bones.map((bone) => {
      const path = bonePath(bone);
      const end = bone.localToWorld(new Vector2(bone.data.length, 0));
      const localXEnd = bone.localToWorld(new Vector2(1, 0));
      const localYEnd = bone.localToWorld(new Vector2(0, 1));
      const startScreen = screen(bone.worldX, bone.worldY);
      const endScreen = screen(end.x, end.y);
      const localXScreen = screen(localXEnd.x, localXEnd.y);
      const localYScreen = screen(localYEnd.x, localYEnd.y);
      return {
        path,
        name: bone.data.name,
        parentPath: bone.parent ? bonePath(bone.parent) : null,
        x: bone.worldX,
        y: bone.worldY,
        endX: end.x,
        endY: end.y,
        screenX: startScreen.x,
        screenY: startScreen.y,
        screenEndX: endScreen.x,
        screenEndY: endScreen.y,
        screenLocalXEndX: localXScreen.x,
        screenLocalXEndY: localXScreen.y,
        screenLocalYEndX: localYScreen.x,
        screenLocalYEndY: localYScreen.y,
        a: bone.a,
        b: bone.b,
        c: bone.c,
        d: bone.d,
        length: bone.data.length,
        rotation: bone.getWorldRotationX(),
        active: bone.active,
      } satisfies SpineEditorBone;
    });
    const constraints: SpineEditorConstraint[] = [
      ...bundle.skeleton.data.ikConstraints.map((constraint) => ({
        type: "ik" as const,
        name: constraint.name,
        bones: constraint.bones.map((bone) => bone.name),
        target: constraint.target.name,
      })),
      ...bundle.skeleton.data.transformConstraints.map((constraint) => ({
        type: "transform" as const,
        name: constraint.name,
        bones: constraint.bones.map((bone) => bone.name),
        target: constraint.target.name,
      })),
      ...bundle.skeleton.data.pathConstraints.map((constraint) => ({
        type: "path" as const,
        name: constraint.name,
        bones: constraint.bones.map((bone) => bone.name),
        target: constraint.target.name,
      })),
      ...bundle.skeleton.data.physicsConstraints.map((constraint) => ({
        type: "physics" as const,
        name: constraint.name,
        bones: [],
        target: "",
      })),
    ];
    const entry = bundle.state.getCurrent(0);
    return {
      animation: entry?.animation?.name ?? null,
      time: entry?.trackTime ?? 0,
      duration: entry?.animation?.duration ?? bundle.meta.duration,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      screenOriginX: originScreen.x,
      screenOriginY: originScreen.y,
      screenUnitXEndX: unitXScreen.x,
      screenUnitXEndY: unitXScreen.y,
      screenUnitYEndX: unitYScreen.x,
      screenUnitYEndY: unitYScreen.y,
      bones,
      constraints,
      lookFollow,
    };
  }

  private emitEditorFrame() {
    if (!this.callbacks.onEditorFrame) return;
    const editorFrame = this.editorFrame();
    if (editorFrame) this.callbacks.onEditorFrame?.(editorFrame);
  }

  private interactionOverlay(): SpineInteractionOverlay {
    const bundle = this.bundle;
    if (!bundle || this.canvas.width <= 0 || this.canvas.height <= 0) return { canvasWidth: this.canvas.width, canvasHeight: this.canvas.height, points: [] };
    const kinds: InteractionHitKind[] = [];
    if (bundle.interaction.pat) kinds.push("pat");
    if (bundle.interaction.pinch) kinds.push("pinch");
    if (bundle.interaction.touch) kinds.push("touch");
    const screen = (x: number, y: number) => {
      const projected = this.renderer.camera.worldToScreen(new Vector3(x, y, 0), this.canvas.width, this.canvas.height);
      return { x: projected.x, y: this.canvas.height - projected.y };
    };
    const points = interactionZonesForDisplay(bundle.skeleton, kinds, bundle.authoredRegions).map((zone) => {
      const center = screen(zone.x, zone.y);
      const axisX = screen(zone.x + zone.axisX.x, zone.y + zone.axisX.y);
      const axisY = screen(zone.x + zone.axisY.x, zone.y + zone.axisY.y);
      return {
        kind: zone.kind,
        shape: zone.shape,
        centerX: center.x,
        centerY: center.y,
        axisXEndX: axisX.x,
        axisXEndY: axisX.y,
        axisYEndX: axisY.x,
        axisYEndY: axisY.y,
      } satisfies SpineInteractionPoint;
    });
    return { canvasWidth: this.canvas.width, canvasHeight: this.canvas.height, points };
  }

  resetCamera() {
    this.pendingFit = true;
  }

  /** Capture the current pose for a same-selection saved-file reload. */
  getCameraPose(): SpineCameraPose | null {
    if (!this.bundle || !Number.isFinite(this.renderer.camera.zoom)) return null;
    return {
      x: this.renderer.camera.position.x,
      y: this.renderer.camera.position.y,
      zoom: this.renderer.camera.zoom,
    };
  }

  getCameraFrame(): SpineCameraFrame | null {
    if (!this.bundle || !Number.isFinite(this.renderer.camera.zoom) || this.renderer.camera.viewportHeight <= 0) return null;
    return {
      centerX: this.renderer.camera.position.x,
      centerY: this.renderer.camera.position.y,
      height: this.renderer.camera.zoom * this.renderer.camera.viewportHeight,
    };
  }

  /** Canvas-pixel rectangle for detected face/head artwork in the current rendered pose. */
  getHeadCanvasRect(): SceneBounds | null {
    const bounds = this.bundle ? headArtworkBounds(this.bundle.skeleton) : null;
    const frame = this.getCameraFrame();
    const camera = this.renderer.camera;
    if (!bounds || !frame || camera.viewportWidth <= 0 || camera.viewportHeight <= 0 || this.canvas.width <= 0 || this.canvas.height <= 0) return null;
    const frameWidth = frame.height * camera.viewportWidth / camera.viewportHeight;
    const scaleX = this.canvas.width / frameWidth;
    const scaleY = this.canvas.height / frame.height;
    const rect = {
      x: (bounds.x - frame.centerX + frameWidth / 2) * scaleX,
      y: (frame.centerY + frame.height / 2 - (bounds.y + bounds.height)) * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    };
    return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 4 && rect.height >= 4 ? rect : null;
  }

  /** Stable full-artwork fallback framing for a requested output aspect ratio. */
  getArtworkCameraFrame(aspectRatio = 16 / 9): SpineCameraFrame | null {
    const bounds = this.bundle?.artworkBounds;
    if (!bounds || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return null;
    return {
      centerX: bounds.x + bounds.width / 2,
      centerY: bounds.y + bounds.height / 2,
      height: Math.max(bounds.height, bounds.width / aspectRatio),
    };
  }

  /** Camera frame in world units; unlike a camera pose this survives viewport resizes. */
  setCameraFrame(frame: SpineCameraFrame | null) {
    if (!frame) {
      this.authoredCameraFrame = null;
      if (this.cameraMode === "authored") this.pendingFit = true;
      return;
    }
    if (![frame.centerX, frame.centerY, frame.height].every(Number.isFinite) || frame.height <= 0) return;
    this.authoredCameraFrame = { ...frame };
    this.cameraMode = "authored";
    if (this.bundle && this.renderer.camera.viewportHeight > 0) this.applyCameraFrame(this.authoredCameraFrame);
  }

  /** Project world coordinates into CSS pixels relative to this renderer's canvas. */
  worldToCanvas(x: number, y: number): { x: number; y: number } | null {
    if (!this.bundle || ![x, y].every(Number.isFinite) || this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) return null;
    const projected = this.renderer.camera.worldToScreen(new Vector3(x, y, 0), this.canvas.width, this.canvas.height);
    const scaleX = this.canvas.clientWidth / this.canvas.width;
    const scaleY = this.canvas.clientHeight / this.canvas.height;
    return { x: projected.x * scaleX, y: (this.canvas.height - projected.y) * scaleY };
  }

  canvasClientSize(): { width: number; height: number } | null {
    if (this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) return null;
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  /** Reapply a saved pose after the next initial-fit pass has completed. */
  setCameraPose(pose: SpineCameraPose | null) {
    if (!pose || ![pose.x, pose.y, pose.zoom].every(Number.isFinite) || pose.zoom <= 0) return;
    if (!this.bundle || this.pendingFit || !this.fitCameraPose) {
      this.pendingCameraPose = { ...pose };
      return;
    }
    this.applyCameraPose(pose);
  }

  private applyCameraPose(pose: SpineCameraPose) {
    const camera = this.renderer.camera;
    camera.position.x = pose.x;
    camera.position.y = pose.y;
    camera.zoom = pose.zoom;
    camera.update();
  }

  private applyCameraFrame(frame: SpineCameraFrame) {
    const camera = this.renderer.camera;
    if (camera.viewportHeight <= 0) return;
    camera.position.x = frame.centerX;
    camera.position.y = frame.centerY;
    camera.zoom = frame.height / camera.viewportHeight;
    camera.update();
  }

  async toggleFullscreen(element: HTMLElement) {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (element.requestFullscreen) {
      await element.requestFullscreen();
    }
  }

  dispose() {
    if (this.destroyed) return;
    this.loadController?.abort();
    this.loadController = null;
    this.destroyed = true;
    ++this.loadSerial;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unbindCameraControls();
    this.disposeBundle();
    this.renderer.dispose();
    this.context.dispose();
  }

  private disposeBundle() {
    if (!this.bundle) return;
    resetInteractionMotion(this.motionState());
    this.bundle.behaviorRuntime.dispose();
    this.clearBehaviorSideEffects();
    disposeBundle(this.bundle);
    this.bundle = null;
  }

  private resize() {
    if (this.destroyed || this.renderEnabled === false) return;
    const oldWidth = this.renderer.camera.viewportWidth;
    const oldHeight = this.renderer.camera.viewportHeight;
    const oldFit = this.fitCameraPose;
    const camera = this.renderer.camera;
    const oldZoom = camera.zoom;
    const offsetX = oldFit ? camera.position.x - oldFit.x : 0;
    const offsetY = oldFit ? camera.position.y - oldFit.y : 0;
    // SceneRenderer.resize clamps to device DPR and would reset oversampling on every frame.
    if (this.resolutionScale > 1) this.resizeCanvasBacking();
    else this.renderer.resize(ResizeMode.Expand);
    const resized = oldWidth !== camera.viewportWidth || oldHeight !== camera.viewportHeight;
    if (this.bundle && (this.pendingFit || resized) && this.canvas.width > 0 && this.canvas.height > 0) {
      const preserveManual = resized && !this.pendingFit && oldFit && this.cameraMode !== "game";
      this.fitCamera();
      if (preserveManual && this.fitCameraPose) {
        const oldBaseZoom = Math.max(oldFit.scaleX, oldFit.scaleY);
        camera.zoom *= oldZoom / oldBaseZoom;
        camera.position.x += offsetX;
        camera.position.y += offsetY;
        camera.update();
      }
      this.pendingFit = false;
      if (this.pendingCameraPose) {
        const pose = this.pendingCameraPose;
        this.pendingCameraPose = null;
        this.applyCameraPose(pose);
      }
      if (this.authoredCameraFrame) this.applyCameraFrame(this.authoredCameraFrame);
    }
  }

  private resizeCanvasBacking() {
    const canvas = this.canvas;
    const gl = this.context.gl;
    const camera = this.renderer.camera;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) {
      if (canvas.width !== 0 || canvas.height !== 0) {
        canvas.width = 0;
        canvas.height = 0;
      }
      gl.viewport(0, 0, 0, 0);
      camera.setViewport(0, 0);
      camera.update();
      return;
    }

    if (!this.canvasLimits) {
      const renderbufferLimit = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 4096;
      const viewportLimits = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      this.canvasLimits = {
        width: Math.max(1, Math.min(renderbufferLimit, Number(viewportLimits[0]) || renderbufferLimit)),
        height: Math.max(1, Math.min(renderbufferLimit, Number(viewportLimits[1]) || renderbufferLimit)),
      };
    }

    const { width, height } = spineCanvasBackingSize(
      cssWidth,
      cssHeight,
      window.devicePixelRatio || 1,
      this.resolutionScale,
      this.canvasLimits.width,
      this.canvasLimits.height,
    );
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    camera.setViewport(width, height);
    camera.update();
  }

  private fitCamera() {
    const bundle = this.bundle;
    if (!bundle || this.renderer.camera.viewportWidth <= 0 || this.renderer.camera.viewportHeight <= 0) return;
    const camera = this.renderer.camera;
    const fitInteractionBoundary = this.cameraMode === "fit" && this.interactionMode === "interaction";
    const bounds = this.cameraMode === "artwork"
      ? bundle.artworkBounds
      : (this.cameraMode === "game" && bundle.meta.hasGameCamera) || fitInteractionBoundary ? bundle.viewport : bundle.bounds;
    const fill = this.cameraMode !== "fit" && this.cameraMode !== "artwork";
    const fit = fitScene(bounds, camera.viewportWidth, camera.viewportHeight, fill);
    this.fitCameraPose = {
      x: fit.x,
      y: fit.y,
      scaleX: fit.zoom,
      scaleY: fit.zoom,
    };
    camera.position.x = this.fitCameraPose.x;
    camera.position.y = this.fitCameraPose.y;
    camera.zoom = Math.max(this.fitCameraPose.scaleX, this.fitCameraPose.scaleY);
    camera.update();
  }

  private render = (now: number) => {
    if (this.destroyed) return;
    const delta = this.previousFrame ? Math.min((now - this.previousFrame) / 1000, 0.1) : 0;
    this.previousFrame = now;

    try {
      this.resize();
      const bundle = this.bundle;
      if (bundle) {
        if (this.interactionPointerHeld) this.behaviorPointerHeldSeconds += delta;
        if (this.behaviorTestContext?.pointerHeld) this.behaviorTestContext.heldSeconds += delta;
        const behaviorContext = this.behaviorRuntimeContext();
        if (this.behaviorTestContext) {
          behaviorContext.pointerHeld = this.behaviorTestContext.pointerHeld;
          behaviorContext.regionId = this.behaviorTestContext.regionId;
          behaviorContext.heldSeconds = this.behaviorTestContext.heldSeconds;
          behaviorContext.dragDistance = this.behaviorTestContext.dragDistance;
        }
        bundle.behaviorRuntime.update(delta, behaviorContext);
        if (this.activeGestureInteractionId && !this.compatibilityMachineCanExecute(this.activeGestureInteractionId)) this.abandonLegacyInteraction();
        if ((this.interactionState === "look" || this.interactionState === "lookRelease")
          && !this.compatibilityMachineCanExecute("$legacy-look-follow")) this.abandonLegacyInteraction();
        this.emitBehaviorDebug(bundle);
        this.callbacks.onBeforeEditorUpdate?.(bundle.skeleton);
        this.restoreInteractionPose();
        if (this.playing) bundle.state.update(delta * this.speed);
        bundle.state.apply(bundle.skeleton);
        bundle.skeleton.updateWorldTransform(Physics.update);
        this.callbacks.onEditorUpdate?.(this.playing ? delta * this.speed : 0, bundle.skeleton, bundle.state);
        this.applyBehaviorBoneControls(bundle, delta);
        bundle.skeleton.updateWorldTransform(Physics.update);
        this.updateBehaviorAnimationCompletions(bundle);
        if (this.interactionMode === "interaction") {
          const wasInteractionReady = this.interactionReady;
          const entry = bundle.state.getCurrent(0);
          if (!(bundle.meta.introAnimation && bundle.meta.idleAnimation) || entry?.animation?.name !== bundle.meta.introAnimation) this.interactionReady = true;
          if (!wasInteractionReady && this.interactionReady) {
            this.eyeFollowHold = 0;
            if (this.interactionPointerHeld) {
              this.dispatchBehaviorEvent("pointer-press", this.interactionPressedBehaviorRegionId);
              this.beginPressedGesture();
            }
          }
          this.finishInteractionState();
          if (this.interactionReady) {
            if (this.interactionState === "idle" && this.interactionPointer) {
              const delay = bundle.lookFollow.delay;
              this.eyeFollowHold = Math.min(delay, this.eyeFollowHold + delta);
              if (bundle.lookFollow.enabled && this.eyeFollowHold >= delay) {
                this.beginLook();
              }
            } else if (this.interactionState === "look") {
              this.applyEyeFollow(delta);
            } else if (["patStart", "pinchStart", "touchStart", "pat", "pinch", "touch"].includes(this.interactionState)) {
              this.applyTouchFollow(delta);
            } else if (["patRelease", "pinchRelease", "touchRelease"].includes(this.interactionState)) {
              this.applyTouchReturn(delta);
            } else if (this.interactionState === "idle") {
              this.eyeFollowHold = 0;
            }
          }
        } else if (this.lookFollowPreview) {
          this.finishInteractionState();
          if (this.interactionState === "idle" && this.interactionPointer && bundle.lookFollow.enabled) {
            const delay = bundle.lookFollow.delay;
            this.eyeFollowHold = Math.min(delay, this.eyeFollowHold + delta);
            if (this.eyeFollowHold >= delay) this.beginLook();
          } else if (this.interactionState === "look") {
            this.applyEyeFollow(delta);
          } else if (!this.interactionPointer) {
            this.eyeFollowHold = 0;
          }
        }
        this.emitEditorFrame();
        if (this.showInteractionPoints) this.callbacks.onInteractionPoints?.(this.interactionOverlay());
      }

      if (this.renderEnabled !== false) {
        this.drawFrame(bundle);
        if (bundle) {
          const entry = bundle.state.getCurrent(0);
          const duration = entry?.animation?.duration ?? bundle.meta.duration;
          this.callbacks.onProgress({
            time: Math.min(entry?.trackTime ?? 0, duration),
            duration,
            animation: entry?.animation?.name ?? null,
          });
        }
      }
    } catch (error) {
      // A malformed local asset should report an error instead of throwing from
      // requestAnimationFrame and taking down the whole React root.
      this.callbacks.onError(errorFrom(error));
      this.disposeBundle();
      this.callbacks.onMeta(null);
      this.callbacks.onProgress({ time: 0, duration: 0, animation: null });
    }

    this.raf = requestAnimationFrame(this.render);
  };

  private drawFrame(bundle: LoadedBundle | null) {
    const gl = this.context.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!bundle) return;
    this.renderer.begin();
    // Match the premultiplied atlas pixels and preserve Spine slot blend
    // modes, including the VFX layers used by lobby animations.
    drawWithEffectsStrength(bundle.skeleton, this.effectsStrength, () => this.renderer.drawSkeleton(bundle.skeleton, true));
    this.renderer.end();
  }

  private bindCameraControls() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerenter", this.onPointerEnter);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private unbindCameraControls() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerenter", this.onPointerEnter);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  private onPointerDown = (event: PointerEvent) => this.handlePointerDown(event);

  private handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (this.interactionMode === "interaction") {
      if (this.interactionPointerHeld) return;
      this.interactionPointerId = event.pointerId;
      this.interactionPointerHeld = true;
      this.behaviorPointerHeldSeconds = 0;
      this.pointerInside = true;
      this.updateInteractionPointer(event);
      this.interactionPressOrigin = this.interactionPointer ? { ...this.interactionPointer } : null;
      this.interactionPressedTarget = this.interactionTargetAtEvent(event);
      this.interactionPressedBehaviorRegionId = this.behaviorRegionAtEvent(event)?.regionId ?? this.interactionPressedTarget?.regionId ?? null;
      this.behaviorPressDispatched = false;
      this.interactionPressedTrigger = this.interactionPressedTarget
        ? this.gestureInteraction(this.interactionPressedTarget.kind, this.interactionPressedTarget.interactionId)?.trigger ?? "hold"
        : "hold";
      if (this.interactionReady && !this.sampledEditorTalkSequence) {
        this.dispatchBehaviorEvent("pointer-press", this.interactionPressedBehaviorRegionId);
      }
      this.canvas.setPointerCapture(event.pointerId);
      if (this.interactionReady) this.beginPressedGesture();
      return;
    }
    this.useManualCamera();
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.interactionMode === "interaction") {
      if (!this.interactionPointerHeld || this.interactionPointerId !== event.pointerId) return;
      this.updateInteractionPointer(event);
      const origin = this.interactionPressOrigin;
      const pointer = this.interactionPointer;
      const dragDistance = origin && pointer ? Math.hypot(pointer.x - origin.x, pointer.y - origin.y) : 0;
      this.dispatchBehaviorEvent("pointer-drag", this.interactionPressedBehaviorRegionId, undefined, dragDistance);
      this.beginPressedBehavior(dragDistance);
      if (this.interactionReady) this.beginPressedGesture();
      return;
    }
    if (!this.dragging || !this.bundle) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const unitsPerPixel = this.renderer.camera.zoom * dpr;
    this.renderer.camera.position.x -= dx * unitsPerPixel;
    this.renderer.camera.position.y += dy * unitsPerPixel;
    this.renderer.camera.update();
    this.emitEditorFrame();
  };

  private onPointerUp = (event: PointerEvent) => this.handlePointerUp(event);

  private handlePointerUp(event: PointerEvent) {
    if (this.interactionMode === "interaction") {
      if (this.interactionPointerId !== null && this.interactionPointerId !== event.pointerId) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pointerInside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      const regionId = this.interactionPressedBehaviorRegionId ?? this.interactionPressedTarget?.regionId ?? null;
      this.interactionPointer = null;
      this.interactionPointerHeld = false;
      this.dispatchBehaviorEvent(event.type === "pointercancel" ? "pointer-cancel" : "pointer-release", regionId);
      this.behaviorPointerHeldSeconds = 0;
      this.interactionPointerId = null;
      this.interactionPressedTarget = null;
      this.interactionPressedBehaviorRegionId = null;
      this.behaviorPressDispatched = false;
      this.interactionPressedTrigger = "hold";
      this.interactionPressOrigin = null;
      this.endGesture();
      this.endLook();
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      return;
    }
    this.dragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private onPointerEnter = (event: PointerEvent) => {
    if (this.interactionMode !== "interaction" || !this.interactionPointerHeld || this.interactionPointerId !== event.pointerId) return;
    this.updateInteractionPointer(event);
  };

  private onPointerLeave = (event: PointerEvent) => this.handlePointerLeave(event);

  private handlePointerLeave(event: PointerEvent) {
    if (this.interactionMode !== "interaction" || !this.interactionPointerHeld || this.interactionPointerId !== event.pointerId) return;
    this.pointerInside = false;
    this.interactionPointer = null;
    this.dispatchBehaviorEvent("pointer-leave", this.interactionPressedBehaviorRegionId);
    this.eyeFollowHold = 0;
    this.endLook();
    if (!this.canvas.hasPointerCapture(event.pointerId)) this.endGesture();
  };

  private updateInteractionPointer(event: PointerEvent) {
    if (!this.bundle || !this.interactionPointerHeld) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.pointerInside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    this.interactionPointer = this.pointerInside ? {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    } : null;
    if (!this.interactionReady) {
      this.eyeFollowHold = 0;
      return;
    }
    if (!this.interactionPointer) {
      this.eyeFollowHold = 0;
      this.endLook();
    }
  }

  private interactionTargetAtEvent(event: PointerEvent): InteractionHitTarget | null {
    const bundle = this.bundle;
    if (!bundle) return null;
    const point = this.pointerWorldFromEvent(event);
    if (!point) return null;
    const kinds: InteractionHitKind[] = [];
    if (bundle.interaction.pinch) kinds.push("pinch");
    if (bundle.interaction.touch) kinds.push("touch");
    if (bundle.interaction.pat) kinds.push("pat");
    return interactionTargetAtPoint(bundle.skeleton, point.x, point.y, kinds, bundle.authoredRegions);
  }

  private behaviorRegionAtEvent(event: PointerEvent) {
    const bundle = this.bundle;
    if (!bundle) return null;
    const point = this.pointerWorldFromEvent(event);
    return point ? behaviorRegionAtPoint(bundle.skeleton, point.x, point.y, bundle.behaviorHitRegions) : null;
  }

  private beginPressedGesture() {
    if (this.interactionState !== "idle" || !this.interactionReady || this.sampledEditorTalkSequence) return;
    const target = this.interactionPressedTarget;
    if (!target) return;
    const origin = this.interactionPressOrigin;
    const pointer = this.interactionPointer;
    const distance = origin && pointer ? Math.hypot(pointer.x - origin.x, pointer.y - origin.y) : 0;
    if (!interactionPressReady(this.interactionPressedTrigger, this.interactionPointerHeld, distance)) return;
    if (this.interactionPressedTrigger === "drag") this.beginPressedBehavior(distance);
    this.beginGesture(target);
  }

  private beginPressedBehavior(dragDistance: number) {
    if (this.behaviorPressDispatched || !this.interactionPointerHeld || !this.interactionReady || this.sampledEditorTalkSequence) return;
    const bundle = this.bundle;
    if (!bundle) return;
    const ids = bundle.behaviorRuntime.getActivationMachineIds("drag", this.interactionPressedBehaviorRegionId, dragDistance);
    if (ids.length === 0) return;
    this.dispatchBehaviorEvent("pointer-press", this.interactionPressedBehaviorRegionId, ids, dragDistance);
    this.behaviorPressDispatched = true;
  }

  private behaviorRuntimeContext(regionId = this.interactionPressedBehaviorRegionId ?? this.interactionPressedTarget?.regionId ?? null, dragDistance?: number): SpineBehaviorRuntimeContext {
    const origin = this.interactionPressOrigin;
    const pointer = this.interactionPointer;
    const distance = dragDistance ?? (origin && pointer ? Math.hypot(pointer.x - origin.x, pointer.y - origin.y) : 0);
    return {
      pointerHeld: this.interactionPointerHeld,
      regionId,
      heldSeconds: this.behaviorPointerHeldSeconds,
      dragDistance: distance,
      variables: {},
    };
  }

  private dispatchBehaviorEvent(event: "pointer-press" | "pointer-release" | "pointer-drag" | "pointer-cancel" | "pointer-leave" | "timer-elapsed" | "animation-complete" | "state-entered" | "manual", regionId = this.interactionPressedBehaviorRegionId ?? this.interactionPressedTarget?.regionId ?? null, machineIds?: readonly string[], dragDistance?: number) {
    const bundle = this.bundle;
    const runtime = bundle?.behaviorRuntime;
    if (!bundle || !runtime) return;
    let targetMachineIds = machineIds;
    if (event === "animation-complete" && !targetMachineIds) {
      targetMachineIds = runtime.getActiveStates()
        .filter(({ machine }) => machine.sourceLegacyInteractionId !== null)
        .map(({ machine }) => machine.id);
    }
    if (!targetMachineIds || targetMachineIds.length > 0) {
      runtime.dispatch(event, this.behaviorRuntimeContext(regionId, dragDistance), targetMachineIds);
    }
    this.emitBehaviorDebug(bundle);
  }

  private emitBehaviorDebug(bundle: LoadedBundle) {
    const onBehaviorDebug = this.callbacks.onBehaviorDebug;
    if (!onBehaviorDebug) return;
    const snapshot = bundle.behaviorRuntime.getDebugSnapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.behaviorDebugSignature) return;
    this.behaviorDebugSignature = signature;
    onBehaviorDebug(snapshot);
  }

  private pointerWorld(): Vector3 | null {
    const pointer = this.interactionPointer;
    const rect = this.canvas.getBoundingClientRect();
    if (!pointer || rect.width <= 0 || rect.height <= 0 || this.canvas.width <= 0 || this.canvas.height <= 0) return null;
    const dprX = this.canvas.width / rect.width;
    const dprY = this.canvas.height / rect.height;
    return this.renderer.camera.screenToWorld(new Vector3(pointer.x * dprX, pointer.y * dprY, 0), this.canvas.width, this.canvas.height);
  }

  private pointerWorldFromEvent(event: PointerEvent): Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.canvas.width <= 0 || this.canvas.height <= 0) return null;
    const dprX = this.canvas.width / rect.width;
    const dprY = this.canvas.height / rect.height;
    return this.renderer.camera.screenToWorld(new Vector3(
      (event.clientX - rect.left) * dprX,
      (event.clientY - rect.top) * dprY,
      0,
    ), this.canvas.width, this.canvas.height);
  }

  private applyEyeFollow(delta: number) {
    const bundle = this.bundle;
    const eyeTarget = bundle?.eyeTarget;
    if (!bundle || !eyeTarget) return;
    const base = eyeTarget.bone.parent
      ? eyeTarget.bone.parent.localToWorld(new Vector2(eyeTarget.baseX, eyeTarget.baseY))
      : new Vector2(eyeTarget.baseX + bundle.skeleton.x, eyeTarget.baseY + bundle.skeleton.y);
    const pointer = this.pointerWorld();
    const desired = lookFollowTarget(base, pointer, eyeTarget.rangeX, eyeTarget.rangeY, bundle.lookFollow.allowX, bundle.lookFollow.allowY);
    const current = this.interactionFollowWorld ?? { x: eyeTarget.bone.worldX, y: eyeTarget.bone.worldY };
    const smoothed = smoothLookFollowPoint(current, desired, delta, bundle.lookFollow.smoothing);
    this.interactionFollowWorld = smoothed;
    const local = eyeTarget.bone.parent
      ? eyeTarget.bone.parent.worldToLocal(new Vector2(smoothed.x, smoothed.y))
      : new Vector2(smoothed.x - bundle.skeleton.x, smoothed.y - bundle.skeleton.y);
    eyeTarget.bone.x = local.x;
    eyeTarget.bone.y = local.y;
    // The authored Touch_Eye constraints consume the target bone during the
    // world-transform pass. Re-run that pass after moving the target so the
    // eyes, brows and Touch_Point followers respond in the same frame.
    bundle.skeleton.updateWorldTransform(Physics.pose);
  }

  private applyTouchFollow(delta: number) {
    const bundle = this.bundle;
    const kind = this.gestureKind(this.interactionState ?? "touch");
    if (!bundle || !kind) return;
    const pointer = this.pointerWorld();
    if (!pointer) return;
    const motion = this.motionState();
    if (!motion.interaction) {
      const fallback: SpineMotionInteraction = {
        startAnimation: "",
        followTargetBone: null,
        sensitivity: 0.25,
        limitX: bundle.touchTarget?.rangeX ?? MAX_TOUCH_FOLLOW_X,
        limitY: bundle.touchTarget?.rangeY ?? MAX_TOUCH_FOLLOW_Y,
        smoothing: 8,
      };
      beginInteractionMotion(motion, fallback, kind, this.touchPointerOrigin ?? pointer);
    }
    applyInteractionMotion(motion, bundle.skeleton, pointer, delta, bundle.touchTarget?.bone ?? null, {
      x: bundle.touchTarget?.rangeX ?? MAX_TOUCH_FOLLOW_X,
      y: bundle.touchTarget?.rangeY ?? MAX_TOUCH_FOLLOW_Y,
    });
    this.touchFollowOffset = { ...motion.offset };
  }

  private applyTouchReturn(delta: number) {
    const bundle = this.bundle;
    if (!bundle) return;
    const motion = this.motionState();
    applyInteractionMotionReturn(motion, bundle.skeleton, delta);
    this.touchFollowOffset = { ...motion.offset };
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.bundle) return;
    event.preventDefault();
    if (this.interactionMode === "interaction") return;
    this.useManualCamera();
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.canvas.width <= 0 || this.canvas.height <= 0) return;
    const dprX = this.canvas.width / rect.width;
    const dprY = this.canvas.height / rect.height;
    const screenPoint = new Vector3((event.clientX - rect.left) * dprX, (event.clientY - rect.top) * dprY, 0);
    const camera = this.renderer.camera;
    const beforeZoom = camera.screenToWorld(screenPoint, this.canvas.width, this.canvas.height);
    camera.zoom = Math.max(0.02, Math.min(50, camera.zoom * Math.exp(event.deltaY * 0.001)));
    camera.update();
    const afterZoom = camera.screenToWorld(screenPoint, this.canvas.width, this.canvas.height);
    const position = cameraPositionForZoomAnchor(camera.position, beforeZoom, afterZoom);
    camera.position.x = position.x;
    camera.position.y = position.y;
    camera.update();
    this.emitEditorFrame();
  };

  private useManualCamera() {
    if (this.interactionMode === "interaction") return;
    if (this.cameraMode !== "game") return;
    this.cameraMode = "fit";
    this.callbacks.onCameraMode?.("fit");
  }
}
