import { Physics, type Skeleton } from "@esotericsoftware/spine-core";
import type { SpineCameraTrack } from "./spineCameraMotion";

/** The first versioned, workspace-independent authored composition contract. */
export const SPINE_COMPOSITION_SCHEMA_VERSION = 1;

export type CompositionClock =
  | { kind: "composition" }
  | { kind: "transport" }
  | { kind: "section-instance"; sectionId: string };
export type CompositionSourceClock = { kind: "clip-source" } | CompositionClock;

export type CompositionLayerRole = "character" | "scene" | "background" | "overlay" | "color";
export type CompositionValue = number | string | boolean | CompositionColor;

/** Color channels are linear-light sRGB values in [0, 1]. */
export interface CompositionColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type CompositionTarget =
  | { kind: "layer"; layerId: string }
  | { kind: "camera" }
  | { kind: "clip"; clipId: string }
  | { kind: "bone"; layerId: string; path: string; assetIdentity: string }
  | { kind: "constraint"; layerId: string; type: CompositionConstraintType; name: string; assetIdentity: string }
  | { kind: "slot"; layerId: string; name: string; assetIdentity: string }
  | { kind: "audio"; audioId: string };

export type CompositionConstraintType = "ik" | "transform" | "path" | "physics";
export type CompositionInterpolation = "step" | "linear" | "bezier";
export type CompositionBlendMode = "override" | "additive";
export type CompositionTangent = { time: number; value: number };

export interface CompositionKeyframe {
  id: string;
  time: number;
  value: CompositionValue;
  interpolation: CompositionInterpolation;
  inTangent?: CompositionTangent;
  outTangent?: CompositionTangent;
}

export interface CompositionPropertyTrack {
  id: string;
  target: CompositionTarget;
  property: string;
  clock: CompositionClock;
  enabled: boolean;
  priority: number;
  blendMode: CompositionBlendMode;
  weight: number;
  /** Value used before the first key and when a track has no keys. */
  baseValue?: CompositionValue;
  holdBefore: boolean;
  holdAfter: boolean;
  rotationMode?: "shortest" | "continuous";
  keys: CompositionKeyframe[];
}

export interface CompositionLayer {
  id: string;
  name: string;
  role: CompositionLayerRole;
  order: number;
  assetDirectory: string;
  /** Stable identity supplied by the asset index when available, not a display name. */
  assetIdentity: string;
  transformParentId: string | null;
  /** Name binding is independent from transform inheritance and both clip clocks. */
  animationBinding?: { sourceLayerId: string; fallback: "authored-animation" | "layer-base" };
  baseProperties: Record<string, CompositionValue>;
  enabled: boolean;
  locked: boolean;
}

export interface CompositionAnimationClip {
  id: string;
  layerId: string;
  animation: string;
  faceAnimation?: string;
  /** Activation window clock. This never controls the source-time clock implicitly. */
  clock: CompositionClock;
  /** Source clock is independent from transform parenting and animation-name binding. */
  sourceClock: CompositionSourceClock;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  /** Global source-clock origin; used to preserve phase across explicit clip boundaries. */
  sourceOriginTime: number;
  sourceOffset: number;
  speed: number;
  loop: boolean;
  endBehavior: "clear" | "hold";
  blendIn: number;
  blendOut: number;
  mixingMode: "replace" | "add";
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface CompositionSectionRoute {
  role: "talk" | "idle" | "opening" | "other";
  returnToSectionId: string | null;
  ownedChannels: Array<"body" | "face" | "audio" | "subtitles" | "camera" | "effects" | "scene" | "skeletal-overrides">;
  duplicateTrigger: "ignore" | "restart" | "queue" | "replace";
  interruption: "ignore" | "replace" | "finish-current";
  blendIn: number;
  blendOut: number;
  cameraReturn: "blend" | "hold" | "persistent";
}

export interface CompositionSection {
  id: string;
  name: string;
  start: number;
  end: number;
  route?: CompositionSectionRoute;
}

export interface CompositionMarker {
  id: string;
  name: string;
  time: number;
  /** Marker metadata is descriptive; it does not execute code. */
  eventId?: string;
}

export interface CompositionAudioClip {
  id: string;
  name: string;
  path: string;
  start: number;
  end: number;
  sourceOffset: number;
  volume: number;
  enabled: boolean;
  sectionId?: string;
}

export interface CompositionSubtitleCue {
  id: string;
  start: number;
  end: number;
  enabled: boolean;
  text: Record<"en" | "ja" | "ko", string>;
  sectionId?: string;
}

export interface CompositionColorClip {
  id: string;
  name: string;
  start: number;
  end: number;
  color: CompositionColor;
  opacity: number;
  fadeIn: number;
  fadeOut: number;
  enabled: boolean;
}

export interface CompositionColorLayer {
  id: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  opacity: number;
  order: number;
  blendMode: "normal" | "multiply" | "screen" | "additive";
  clips: CompositionColorClip[];
}

export interface CompositionClipDefinition {
  id: string;
  name: string;
  /** Definitions are references only; nesting another composition is not required. */
  sourceCompositionId: string;
}

export interface CompositionClipInstance {
  id: string;
  definitionId: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  loop: boolean;
  overrides: Record<string, CompositionValue>;
}

export interface SpineComposition {
  schemaVersion: typeof SPINE_COMPOSITION_SCHEMA_VERSION;
  id: string;
  name: string;
  duration: number;
  frameRate: number;
  finalFramePolicy: "exclusive" | "include-endpoint";
  layers: CompositionLayer[];
  sections: CompositionSection[];
  markers: CompositionMarker[];
  propertyTracks: CompositionPropertyTrack[];
  animationClips: CompositionAnimationClip[];
  audio: CompositionAudioClip[];
  subtitles: CompositionSubtitleCue[];
  colorLayers: CompositionColorLayer[];
  camera?: SpineCameraTrack;
  clipDefinitions: CompositionClipDefinition[];
  clipInstances: CompositionClipInstance[];
  idleSectionId: string | null;
  entrySectionId: string | null;
  /** Persisted physics sampling contract; fixed step is independent of renderer frame rate. */
  physicsSampling: { mode: "fixed-step-preroll"; stepSeconds: number; maxSteps: number };
  /** Unknown source fields are retained by migration adapters rather than discarded. */
  migrationMetadata?: Record<string, unknown>;
}

export const DEFAULT_COMPOSITION_PHYSICS_SAMPLING: SpineComposition["physicsSampling"] = {
  mode: "fixed-step-preroll",
  stepSeconds: 1 / 60,
  maxSteps: 36_000,
};

/** Agreed first-release defaults; callers persist the returned route on the section. */
export function defaultTalkSectionRoute(idleSectionId: string): CompositionSectionRoute {
  return {
    role: "talk",
    returnToSectionId: idleSectionId,
    ownedChannels: ["body", "face", "audio", "subtitles", "camera", "effects", "skeletal-overrides"],
    duplicateTrigger: "ignore",
    interruption: "replace",
    blendIn: 0.14,
    blendOut: 0.14,
    cameraReturn: "blend",
  };
}

export function createEmptySpineComposition(id: string, name: string, duration = 1, frameRate = 30): SpineComposition {
  return {
    schemaVersion: SPINE_COMPOSITION_SCHEMA_VERSION,
    id,
    name,
    duration: Math.max(0.01, Number.isFinite(duration) ? duration : 1),
    frameRate: Math.max(1, Number.isFinite(frameRate) ? frameRate : 30),
    finalFramePolicy: "exclusive",
    layers: [],
    sections: [],
    markers: [],
    propertyTracks: [],
    animationClips: [],
    audio: [],
    subtitles: [],
    colorLayers: [],
    clipDefinitions: [],
    clipInstances: [],
    idleSectionId: null,
    entrySectionId: null,
    physicsSampling: { ...DEFAULT_COMPOSITION_PHYSICS_SAMPLING },
  };
}

export interface CompositionPropertyDefinition {
  id: string;
  label: string;
  valueType: "number" | "boolean" | "string" | "color";
  targetKinds: readonly CompositionTarget["kind"][];
  defaultValue: CompositionValue;
  unit?: string;
  min?: number;
  max?: number;
  enumValues?: readonly string[];
  interpolations: readonly CompositionInterpolation[];
  additive: "sum" | "multiply" | null;
  stage: "layer" | "animation" | "camera" | "audio" | "skeleton-local" | "constraint" | "slot";
  capability?: string;
}

const numeric = (id: string, label: string, targetKinds: readonly CompositionTarget["kind"][], stage: CompositionPropertyDefinition["stage"], options: Partial<CompositionPropertyDefinition> = {}): CompositionPropertyDefinition => ({
  id,
  label,
  valueType: "number",
  targetKinds,
  defaultValue: 0,
  interpolations: ["step", "linear", "bezier"],
  additive: "sum",
  stage,
  ...options,
});

const discrete = (id: string, label: string, targetKinds: readonly CompositionTarget["kind"][], stage: CompositionPropertyDefinition["stage"], defaultValue: string | boolean, enumValues?: readonly string[], capability?: string): CompositionPropertyDefinition => ({
  id,
  label,
  valueType: typeof defaultValue === "boolean" ? "boolean" : "string",
  targetKinds,
  defaultValue,
  ...(enumValues ? { enumValues } : {}),
  interpolations: ["step"],
  additive: null,
  stage,
  ...(capability ? { capability } : {}),
});

const layerTarget = ["layer"] as const;
const boneTarget = ["bone"] as const;
const constraintTarget = ["constraint"] as const;
const slotTarget = ["slot"] as const;

/** Shared registry: schema validation, evaluators, inspectors and MCP use these same identifiers. */
export const COMPOSITION_PROPERTY_REGISTRY: readonly CompositionPropertyDefinition[] = [
  numeric("layer.position.x", "Position X", layerTarget, "layer", { unit: "px" }),
  numeric("layer.position.y", "Position Y", layerTarget, "layer", { unit: "px" }),
  numeric("layer.rotation", "Rotation", layerTarget, "layer", { unit: "degrees" }),
  numeric("layer.scale.x", "Scale X", layerTarget, "layer", { defaultValue: 1, min: 0.001, additive: "multiply" }),
  numeric("layer.scale.y", "Scale Y", layerTarget, "layer", { defaultValue: 1, min: 0.001, additive: "multiply" }),
  numeric("layer.opacity", "Opacity", layerTarget, "layer", { defaultValue: 1, min: 0, max: 1, additive: null }),
  discrete("layer.visible", "Visible", layerTarget, "layer", true),
  discrete("layer.blendMode", "Blend mode", layerTarget, "layer", "normal", ["normal", "multiply", "screen", "additive"]),
  numeric("camera.centerX", "Camera center X", ["camera"], "camera", { unit: "px" }),
  numeric("camera.centerY", "Camera center Y", ["camera"], "camera", { unit: "px" }),
  numeric("camera.frameHeight", "Camera frame height", ["camera"], "camera", { defaultValue: 1, min: 0.001, unit: "px", additive: "multiply" }),
  discrete("animation.selection", "Animation", ["clip"], "animation", ""),
  numeric("animation.speed", "Animation speed", ["clip"], "animation", { defaultValue: 1, min: 0, max: 8, additive: null, interpolations: ["step", "linear"] }),
  numeric("animation.weight", "Animation weight", ["clip"], "animation", { defaultValue: 1, min: 0, max: 1, additive: null }),
  numeric("audio.volume", "Audio volume", ["audio"], "audio", { defaultValue: 1, min: 0, max: 1, additive: null }),
  numeric("bone.x", "Bone X", boneTarget, "skeleton-local", { unit: "px", capability: "bone-local-transform" }),
  numeric("bone.y", "Bone Y", boneTarget, "skeleton-local", { unit: "px", capability: "bone-local-transform" }),
  numeric("bone.rotation", "Bone rotation", boneTarget, "skeleton-local", { unit: "degrees", capability: "bone-local-transform" }),
  numeric("bone.scaleX", "Bone scale X", boneTarget, "skeleton-local", { defaultValue: 1, additive: "multiply", capability: "bone-local-transform" }),
  numeric("bone.scaleY", "Bone scale Y", boneTarget, "skeleton-local", { defaultValue: 1, additive: "multiply", capability: "bone-local-transform" }),
  numeric("bone.shearX", "Bone shear X", boneTarget, "skeleton-local", { unit: "degrees", capability: "bone-local-transform" }),
  numeric("bone.shearY", "Bone shear Y", boneTarget, "skeleton-local", { unit: "degrees", capability: "bone-local-transform" }),
  numeric("constraint.ik.mix", "IK mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.ik" }),
  numeric("constraint.ik.softness", "IK softness", constraintTarget, "constraint", { min: 0, additive: null, capability: "constraint.ik" }),
  numeric("constraint.ik.bendDirection", "IK bend direction", constraintTarget, "constraint", { defaultValue: 1, min: -1, max: 1, interpolations: ["step"], additive: null, capability: "constraint.ik" }),
  discrete("constraint.ik.compress", "IK compress", constraintTarget, "constraint", false, undefined, "constraint.ik"),
  discrete("constraint.ik.stretch", "IK stretch", constraintTarget, "constraint", false, undefined, "constraint.ik"),
  numeric("constraint.transform.mixRotate", "Transform rotation mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.transform.mixX", "Transform X mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.transform.mixY", "Transform Y mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.transform.mixScaleX", "Transform scale X mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.transform.mixScaleY", "Transform scale Y mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.transform.mixShearY", "Transform shear Y mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.transform" }),
  numeric("constraint.path.position", "Path position", constraintTarget, "constraint", { additive: null, capability: "constraint.path" }),
  numeric("constraint.path.spacing", "Path spacing", constraintTarget, "constraint", { additive: null, capability: "constraint.path" }),
  numeric("constraint.path.mixRotate", "Path rotation mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.path" }),
  numeric("constraint.path.mixX", "Path X mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.path" }),
  numeric("constraint.path.mixY", "Path Y mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.path" }),
  numeric("constraint.physics.inertia", "Physics inertia", constraintTarget, "constraint", { min: 0, additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.strength", "Physics strength", constraintTarget, "constraint", { min: 0, additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.damping", "Physics damping", constraintTarget, "constraint", { min: 0, additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.massInverse", "Physics inverse mass", constraintTarget, "constraint", { min: 0, additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.wind", "Physics wind", constraintTarget, "constraint", { additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.gravity", "Physics gravity", constraintTarget, "constraint", { additive: null, capability: "constraint.physics" }),
  numeric("constraint.physics.mix", "Physics mix", constraintTarget, "constraint", { min: 0, max: 1, additive: null, capability: "constraint.physics" }),
  discrete("slot.attachment", "Attachment", slotTarget, "slot", "", undefined, "slot-attachment"),
  discrete("skeleton.skin", "Skin", ["layer"], "slot", "", undefined, "skeleton-skin"),
  { id: "color.value", label: "Color", valueType: "color", targetKinds: ["clip"], defaultValue: { r: 1, g: 1, b: 1, a: 1 }, interpolations: ["step", "linear", "bezier"], additive: null, stage: "layer" },
  numeric("color.opacity", "Color opacity", ["clip"], "layer", { defaultValue: 1, min: 0, max: 1, additive: null }),
  ...(["r", "g", "b", "a"] as const).map((channel) => numeric(`slot.color.${channel}`, `Slot color ${channel.toUpperCase()}`, slotTarget, "slot", {
    defaultValue: 1,
    min: 0,
    max: 1,
    additive: null,
    capability: "slot-color",
  })),
];

const PROPERTY_BY_ID = new Map(COMPOSITION_PROPERTY_REGISTRY.map((property) => [property.id, property]));

export function compositionPropertyDefinition(id: string): CompositionPropertyDefinition | null {
  return PROPERTY_BY_ID.get(id) ?? null;
}

export interface CompositionDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  targetId?: string;
}

export interface CompositionCapabilities {
  /** Spine runtime currently loaded by the app. */
  spineRuntime: "4.2";
  layers?: Record<string, {
    assetIdentity: string;
    bones?: string[];
    constraints?: Array<{ type: CompositionConstraintType; name: string }>;
    slots?: string[];
    skins?: string[];
  }>;
}

export function validateComposition(composition: SpineComposition, capabilities?: CompositionCapabilities): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = [];
  const report = (severity: CompositionDiagnostic["severity"], code: string, message: string, targetId?: string) => diagnostics.push({ severity, code, message, ...(targetId ? { targetId } : {}) });
  if (composition.schemaVersion !== SPINE_COMPOSITION_SCHEMA_VERSION) report("error", "schema-version", `Unsupported composition schema version ${composition.schemaVersion}.`);
  if (!Number.isFinite(composition.duration) || composition.duration <= 0) report("error", "duration", "Composition duration must be a positive finite number.");
  if (!Number.isFinite(composition.frameRate) || composition.frameRate <= 0) report("error", "frame-rate", "Composition frame rate must be positive.");
  if (!Number.isFinite(composition.physicsSampling.stepSeconds) || composition.physicsSampling.stepSeconds <= 0 || !Number.isInteger(composition.physicsSampling.maxSteps) || composition.physicsSampling.maxSteps < 1) {
    report("error", "physics-policy", "Physics preroll requires a positive fixed step and positive integer step limit.");
  }

  const uniqueIds = (items: Array<{ id: string }>, kind: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id || seen.has(item.id)) report("error", "duplicate-id", `${kind} ID “${item.id}” is empty or duplicated.`, item.id);
      seen.add(item.id);
    }
  };
  uniqueIds(composition.layers, "Layer");
  uniqueIds(composition.sections, "Section");
  uniqueIds(composition.markers, "Marker");
  uniqueIds(composition.propertyTracks, "Track");
  uniqueIds(composition.animationClips, "Animation clip");
  uniqueIds(composition.audio, "Audio clip");
  uniqueIds(composition.subtitles, "Subtitle cue");
  uniqueIds(composition.colorLayers, "Color layer");
  uniqueIds(composition.colorLayers.flatMap((layer) => layer.clips), "Color clip");
  uniqueIds(composition.clipDefinitions, "Clip definition");
  uniqueIds(composition.clipInstances, "Clip instance");

  const layerIds = new Set(composition.layers.map((layer) => layer.id));
  const sectionIds = new Set(composition.sections.map((section) => section.id));
  const sectionById = new Map(composition.sections.map((section) => [section.id, section]));
  const sectionForClock = (
    clock: CompositionClock | CompositionSourceClock,
    description: string,
    targetId: string,
  ): CompositionSection | null => {
    if (clock.kind !== "section-instance") return null;
    const section = sectionById.get(clock.sectionId);
    if (!section) {
      report("error", "missing-section-clock", `${description} references missing section “${clock.sectionId}”.`, targetId);
      return null;
    }
    return section;
  };
  const validateSectionLocalCueRange = (
    section: CompositionSection,
    start: number,
    end: number,
    description: string,
    targetId: string,
  ) => {
    const sectionDuration = section.end - section.start;
    if (!Number.isFinite(sectionDuration) || sectionDuration <= 0) return;
    if (start >= sectionDuration) {
      report("warning", "section-local-range", `${description} starts at or beyond the end of section “${section.id}” and is unreachable.`, targetId);
    } else if (end > sectionDuration) {
      report("warning", "section-local-range", `${description} extends past the end of section “${section.id}” and will be truncated.`, targetId);
    }
  };
  for (const layer of composition.layers) {
    if (!layer.assetDirectory.trim() || !layer.assetIdentity.trim()) report("error", "layer-asset", `Layer “${layer.name}” has no stable asset binding.`, layer.id);
    if (!Number.isFinite(layer.order)) report("error", "layer-order", `Layer “${layer.id}” has an invalid compositing order.`, layer.id);
    if (layer.transformParentId && !layerIds.has(layer.transformParentId)) report("error", "missing-parent", `Layer “${layer.id}” references missing parent “${layer.transformParentId}”.`, layer.id);
    for (const [property, value] of Object.entries(layer.baseProperties)) {
      const definition = compositionPropertyDefinition(property);
      if (!definition) continue;
      if (!definition.targetKinds.includes("layer")) report("error", "base-target-kind", `Property “${property}” cannot be a layer base value.`, layer.id);
      const invalid = validatePropertyValue(definition, value);
      if (invalid) report("error", "invalid-base-value", `Layer “${layer.id}” ${property}: ${invalid}`, layer.id);
    }
  }
  const parentById = new Map(composition.layers.map((layer) => [layer.id, layer.transformParentId]));
  for (const layer of composition.layers) {
    const visited = new Set<string>();
    let current: string | null | undefined = layer.id;
    while (current) {
      if (visited.has(current)) {
        report("error", "parent-cycle", `Transform parenting contains a cycle involving “${current}”.`, layer.id);
        break;
      }
      visited.add(current);
      current = parentById.get(current);
    }
  }
  for (const layer of composition.layers) {
    const sourceLayerId = layer.animationBinding?.sourceLayerId;
    if (!sourceLayerId) continue;
    if (!layerIds.has(sourceLayerId)) report("error", "missing-animation-binding", `Layer “${layer.id}” binds animation names from missing layer “${sourceLayerId}”.`, layer.id);
    const visited = new Set<string>();
    let current: string | null | undefined = layer.id;
    while (current) {
      if (visited.has(current)) {
        report("error", "animation-binding-cycle", `Animation-name bindings contain a cycle involving “${current}”.`, layer.id);
        break;
      }
      visited.add(current);
      current = composition.layers.find((item) => item.id === current)?.animationBinding?.sourceLayerId;
    }
  }

  const ranges = <T extends { id: string; start: number; end: number }>(items: T[], kind: string, allowZero = false) => {
    for (const item of items) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || (allowZero ? item.end < item.start : item.end <= item.start)) {
        report("error", "invalid-range", `${kind} “${item.id}” has an invalid half-open range.`, item.id);
      }
    }
  };
  ranges(composition.sections, "Section");
  ranges(composition.animationClips, "Animation clip");
  ranges(composition.audio, "Audio clip");
  ranges(composition.subtitles, "Subtitle cue");
  ranges(composition.colorLayers.flatMap((layer) => layer.clips), "Color clip");
  for (const section of composition.sections) {
    if (section.end > composition.duration + 1e-6) report("warning", "section-outside-composition", `Section “${section.id}” extends past the composition endpoint.`, section.id);
    if (section.route?.returnToSectionId && !sectionIds.has(section.route.returnToSectionId)) report("error", "missing-return-section", `Section “${section.id}” returns to missing section “${section.route.returnToSectionId}”.`, section.id);
    if (section.route && (section.route.blendIn < 0 || section.route.blendOut < 0 || !Number.isFinite(section.route.blendIn + section.route.blendOut))) report("error", "invalid-route-transition", `Section “${section.id}” has an invalid transition duration.`, section.id);
  }
  for (const ref of [["idle", composition.idleSectionId], ["entry", composition.entrySectionId]] as const) {
    if (ref[1] && !sectionIds.has(ref[1])) report("error", `missing-${ref[0]}-section`, `Composition ${ref[0]} section “${ref[1]}” does not exist.`, ref[1]);
  }

  for (const track of composition.propertyTracks) {
    const clockSection = sectionForClock(track.clock, `Track “${track.id}” clock`, track.id);
    if (clockSection) {
      const sectionDuration = clockSection.end - clockSection.start;
      if (Number.isFinite(sectionDuration) && sectionDuration > 0
        && track.keys.some((key) => Number.isFinite(key.time) && key.time > sectionDuration)) {
        report("warning", "section-local-key-range", `Track “${track.id}” has keys beyond the end of section “${clockSection.id}”; those keys are unreachable.`, track.id);
      }
    }
    const definition = compositionPropertyDefinition(track.property);
    if (!definition) {
      report("warning", "unsupported-property", `Property “${track.property}” is not registered; its authored keys are retained but cannot be evaluated.`, track.id);
      continue;
    }
    if (!definition.targetKinds.includes(track.target.kind)) report("error", "target-kind", `Property “${track.property}” cannot target ${track.target.kind}.`, track.id);
    if (track.target.kind === "constraint" && !track.property.startsWith(`constraint.${track.target.type}.`)) report("error", "constraint-property-type", `Property “${track.property}” does not match ${track.target.type} target “${track.target.name}”.`, track.id);
    if (track.blendMode === "additive" && definition.additive === null) report("error", "unsupported-blend", `Property “${track.property}” does not support additive blending.`, track.id);
    if (!Number.isFinite(track.weight) || track.weight < 0 || track.weight > 1) report("error", "track-weight", `Track “${track.id}” weight must be in [0, 1].`, track.id);
    const seenKeyIds = new Set<string>();
    for (const key of track.keys) {
      if (!key.id || seenKeyIds.has(key.id)) report("error", "duplicate-key-id", `Track “${track.id}” contains an empty or duplicate key ID.`, track.id);
      seenKeyIds.add(key.id);
      if (!Number.isFinite(key.time) || key.time < 0) report("error", "key-time", `Track “${track.id}” contains an invalid key time.`, track.id);
      if (!definition.interpolations.includes(key.interpolation)) report("error", "key-interpolation", `Property “${track.property}” does not support ${key.interpolation} interpolation.`, track.id);
      const valueDiagnostic = validatePropertyValue(definition, key.value);
      if (valueDiagnostic) report("error", "key-value", `Track “${track.id}”: ${valueDiagnostic}`, track.id);
    }
    if (track.target.kind === "layer" && !layerIds.has(track.target.layerId)) report("error", "missing-track-layer", `Track “${track.id}” references missing layer “${track.target.layerId}”.`, track.id);
    if (track.target.kind === "layer" && track.property === "skeleton.skin") {
      const asset = capabilities?.layers?.[track.target.layerId];
      if (!asset) report("warning", "unresolved-skin-target", `Track “${track.id}” targets a skeleton whose skins are not loaded; authored keys are retained.`, track.id);
      else if (track.keys.some((key) => typeof key.value === "string" && key.value && asset.skins && !asset.skins.includes(key.value))) report("warning", "unsupported-skin", `Track “${track.id}” selects a skin that is not present in the loaded skeleton.`, track.id);
    }
    if ((track.target.kind === "bone" || track.target.kind === "constraint" || track.target.kind === "slot") && !layerIds.has(track.target.layerId)) report("error", "missing-skeleton-layer", `Track “${track.id}” references missing layer “${track.target.layerId}”.`, track.id);
    if (track.target.kind === "bone" || track.target.kind === "constraint" || track.target.kind === "slot") {
      const asset = capabilities?.layers?.[track.target.layerId];
      if (!asset) report("warning", "unresolved-skeleton-target", `Track “${track.id}” targets a skeleton asset that is not currently loaded; authored keys are retained.`, track.id);
      else {
        if (asset.assetIdentity !== track.target.assetIdentity) report("warning", "asset-identity-mismatch", `Track “${track.id}” target belongs to another skeleton asset; editing is disabled until resolved.`, track.id);
        const target = track.target;
        const exists = target.kind === "bone"
          ? asset.bones?.includes(target.path)
          : target.kind === "slot"
            ? asset.slots?.includes(target.name)
            : asset.constraints?.some((constraint) => constraint.type === target.type && constraint.name === target.name);
        if (exists === false) report("warning", "unsupported-target", `Track “${track.id}” target is not present in the loaded skeleton; authored keys are retained.`, track.id);
      }
    }
  }
  for (const clip of composition.animationClips) {
    const activationSection = sectionForClock(clip.clock, `Animation clip “${clip.id}” activation clock`, clip.id);
    sectionForClock(clip.sourceClock, `Animation clip “${clip.id}” source clock`, clip.id);
    if (activationSection) validateSectionLocalCueRange(activationSection, clip.start, clip.end, `Animation clip “${clip.id}”`, clip.id);
    if (!layerIds.has(clip.layerId)) report("error", "missing-animation-layer", `Animation clip “${clip.id}” references missing layer “${clip.layerId}”.`, clip.id);
    if (clip.sourceStart < 0 || clip.sourceEnd <= clip.sourceStart || !Number.isFinite(clip.sourceEnd)) report("error", "source-range", `Animation clip “${clip.id}” has an invalid source range.`, clip.id);
    if (!Number.isFinite(clip.sourceOriginTime) || clip.sourceOriginTime < 0) report("error", "source-origin", `Animation clip “${clip.id}” has an invalid source-clock origin.`, clip.id);
    if (!Number.isFinite(clip.sourceOffset) || clip.sourceOffset < 0) report("error", "source-offset", `Animation clip “${clip.id}” has an invalid source offset.`, clip.id);
    if (!Number.isFinite(clip.speed) || clip.speed < 0 || clip.speed > 8) report("error", "clip-speed", `Animation clip “${clip.id}” speed must be in [0, 8]; reverse playback is not supported.`, clip.id);
    if (clip.weight < 0 || clip.weight > 1 || clip.blendIn < 0 || clip.blendOut < 0) report("error", "clip-mix", `Animation clip “${clip.id}” has invalid mix values.`, clip.id);
  }
  for (const audio of composition.audio) {
    if (audio.sectionId) {
      const section = sectionById.get(audio.sectionId);
      if (!section) report("error", "missing-audio-section", `Audio clip “${audio.id}” references missing section “${audio.sectionId}”.`, audio.id);
      else validateSectionLocalCueRange(section, audio.start, audio.end, `Audio clip “${audio.id}”`, audio.id);
    }
    if (audio.volume < 0 || audio.volume > 1 || audio.sourceOffset < 0) report("error", "audio-values", `Audio clip “${audio.id}” has invalid source offset or volume.`, audio.id);
  }
  for (const cue of composition.subtitles) {
    if (!cue.sectionId) continue;
    const section = sectionById.get(cue.sectionId);
    if (!section) report("error", "missing-subtitle-section", `Subtitle cue “${cue.id}” references missing section “${cue.sectionId}”.`, cue.id);
    else validateSectionLocalCueRange(section, cue.start, cue.end, `Subtitle cue “${cue.id}”`, cue.id);
  }
  for (const layer of composition.colorLayers) {
    if (layer.opacity < 0 || layer.opacity > 1) report("error", "color-layer-opacity", `Color layer “${layer.id}” opacity must be in [0, 1].`, layer.id);
    for (const clip of layer.clips) {
      if (clip.opacity < 0 || clip.opacity > 1 || clip.fadeIn < 0 || clip.fadeOut < 0) report("error", "color-clip-values", `Color clip “${clip.id}” has invalid opacity or fades.`, clip.id);
      if (![clip.color.r, clip.color.g, clip.color.b, clip.color.a].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) report("error", "color-clip-color", `Color clip “${clip.id}” has invalid linear-light color channels.`, clip.id);
    }
  }
  for (const marker of composition.markers) {
    if (!Number.isFinite(marker.time) || marker.time < 0) report("error", "marker-time", `Marker “${marker.id}” has an invalid time.`, marker.id);
  }
  for (const instance of composition.clipInstances) {
    if (!composition.clipDefinitions.some((definition) => definition.id === instance.definitionId)) report("error", "missing-clip-definition", `Clip instance “${instance.id}” references missing definition “${instance.definitionId}”.`, instance.id);
    if (instance.start < 0 || instance.end <= instance.start || instance.sourceStart < 0 || instance.sourceEnd <= instance.sourceStart || instance.speed < 0) report("error", "invalid-clip-instance", `Clip instance “${instance.id}” has invalid placement or source mapping.`, instance.id);
  }
  return diagnostics;
}

/**
 * Validate the versioned document envelope before retaining authored composition data.
 * Semantic diagnostics do not discard a supported-schema document; callers can present
 * those diagnostics while keeping unresolved or unsupported authored content intact.
 */
export function normalizeSpineComposition(value: unknown): SpineComposition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== SPINE_COMPOSITION_SCHEMA_VERSION) return null;
  const requiredArrays = ["layers", "sections", "markers", "propertyTracks", "animationClips", "audio", "subtitles", "colorLayers", "clipDefinitions", "clipInstances"];
  if (requiredArrays.some((field) => !Array.isArray(raw[field]))) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.duration !== "number" || typeof raw.frameRate !== "number") return null;
  if (raw.finalFramePolicy !== "exclusive" && raw.finalFramePolicy !== "include-endpoint") return null;
  if (!raw.physicsSampling || typeof raw.physicsSampling !== "object" || Array.isArray(raw.physicsSampling)) return null;
  try {
    // Run the validator defensively for malformed nested structures, but preserve a
    // valid v1 envelope even when semantic errors need author review.
    validateComposition(raw as unknown as SpineComposition);
    const composition = structuredClone(raw) as unknown as SpineComposition;
    composition.layers = composition.layers.map((layer, index) => ({
      ...layer,
      order: Number.isFinite(layer.order) ? layer.order : index,
    }));
    return composition;
  } catch {
    return null;
  }
}

function validatePropertyValue(definition: CompositionPropertyDefinition, value: CompositionValue): string | null {
  if (definition.valueType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "expected a finite number.";
    if (definition.min !== undefined && value < definition.min) return `value ${value} is below ${definition.min}.`;
    if (definition.max !== undefined && value > definition.max) return `value ${value} is above ${definition.max}.`;
    if (definition.id === "constraint.ik.bendDirection" && value !== 1 && value !== -1) return "bend direction must be 1 or -1.";
  } else if (definition.valueType === "boolean") {
    if (typeof value !== "boolean") return "expected a boolean.";
  } else if (definition.valueType === "string") {
    if (typeof value !== "string") return "expected a string.";
    if (definition.enumValues && !definition.enumValues.includes(value)) return `value “${value}” is not supported.`;
  } else if (!isCompositionColor(value) || ![value.r, value.g, value.b, value.a].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
    return "expected linear-light color channels in [0, 1].";
  }
  return null;
}

function isCompositionColor(value: CompositionValue): value is CompositionColor {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value && "a" in value;
}

function sortedKeys(track: CompositionPropertyTrack): CompositionKeyframe[] {
  const sorted = track.keys.filter((key) => Number.isFinite(key.time)).map((key, index) => ({ key, index }))
    .sort((a, b) => a.key.time - b.key.time || a.key.id.localeCompare(b.key.id) || a.index - b.index);
  const unique: CompositionKeyframe[] = [];
  for (const entry of sorted) {
    const previous = unique.at(-1);
    if (previous?.time === entry.key.time) unique[unique.length - 1] = entry.key;
    else unique.push(entry.key);
  }
  return unique;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function curveValue(t: number, out?: CompositionTangent, input?: CompositionTangent): number {
  const x1 = clamp01(out?.time ?? 1 / 3);
  const x2 = 1 - clamp01(input?.time ?? 1 / 3);
  const y0 = 0;
  const y1 = out?.value ?? 1 / 3;
  const y2 = input?.value ?? 2 / 3;
  const y3 = 1;
  const cubic = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const v = 1 - u;
    return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
  };
  let low = 0;
  let high = 1;
  let u = t;
  for (let i = 0; i < 24; i += 1) {
    const x = cubic(0, x1, x2, 1, u);
    if (Math.abs(x - t) < 1e-7) break;
    if (x < t) low = u;
    else high = u;
    u = (low + high) / 2;
  }
  return cubic(y0, y1, y2, y3, u);
}

function shortestDelta(from: number, to: number): number {
  return ((to - from + 180) % 360 + 360) % 360 - 180;
}

function interpolateValues(track: CompositionPropertyTrack, left: CompositionKeyframe, right: CompositionKeyframe, amount: number): CompositionValue {
  if (left.interpolation === "step" || typeof left.value === "boolean" || typeof left.value === "string") return left.value;
  const t = clamp01(amount);
  if (isCompositionColor(left.value) && isCompositionColor(right.value)) {
    const colorAmount = left.interpolation === "bezier" ? curveValue(t, left.outTangent, right.inTangent) : t;
    return {
      r: left.value.r + (right.value.r - left.value.r) * colorAmount,
      g: left.value.g + (right.value.g - left.value.g) * colorAmount,
      b: left.value.b + (right.value.b - left.value.b) * colorAmount,
      a: left.value.a + (right.value.a - left.value.a) * colorAmount,
    };
  }
  if (typeof left.value !== "number" || typeof right.value !== "number") return left.value;
  const isRotation = track.property === "layer.rotation" || track.property === "bone.rotation";
  const delta = isRotation && track.rotationMode !== "continuous" ? shortestDelta(left.value, right.value) : right.value - left.value;
  if (left.interpolation === "bezier") {
    const curve = curveValue(t, left.outTangent, right.inTangent);
    return left.value + delta * curve;
  }
  return left.value + delta * t;
}

/** Pure track sampler. Same-time keys resolve to the lexicographically greatest stable key ID. */
export function sampleCompositionTrack(track: CompositionPropertyTrack, time: number): CompositionValue | undefined {
  if (!track.enabled || !Number.isFinite(time)) return undefined;
  const keys = sortedKeys(track);
  if (keys.length === 0) return track.baseValue;
  const first = keys[0]!;
  const last = keys.at(-1)!;
  if (time < first.time) return track.holdBefore ? first.value : track.baseValue;
  if (time >= last.time) return time === last.time || track.holdAfter ? last.value : undefined;
  let low = 0;
  let high = keys.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle]!.time <= time) low = middle;
    else high = middle;
  }
  const left = keys[low]!;
  const right = keys[high]!;
  if (time === left.time) return left.value;
  return interpolateValues(track, left, right, (time - left.time) / (right.time - left.time));
}

function blendValue(base: CompositionValue | undefined, value: CompositionValue, definition: CompositionPropertyDefinition, mode: CompositionBlendMode, weight: number): CompositionValue {
  if (base === undefined || weight >= 1 && mode === "override") return value;
  if (definition.valueType === "color" && isCompositionColor(base) && isCompositionColor(value)) {
    if (mode === "additive") return base;
    return {
      r: base.r + (value.r - base.r) * weight,
      g: base.g + (value.g - base.g) * weight,
      b: base.b + (value.b - base.b) * weight,
      a: base.a + (value.a - base.a) * weight,
    };
  }
  if (definition.valueType !== "number" || typeof base !== "number" || typeof value !== "number") return weight >= 0.5 ? value : base;
  if (mode === "additive") {
    if (definition.additive === "multiply") return base * (1 + (value - 1) * weight);
    return base + value * weight;
  }
  const delta = definition.id.endsWith("rotation") ? shortestDelta(base, value) : value - base;
  return base + delta * weight;
}

export function compositionTargetKey(target: CompositionTarget, property: string): string {
  switch (target.kind) {
    case "layer": return `layer:${target.layerId}:${property}`;
    case "camera": return `camera:${property}`;
    case "clip": return `clip:${target.clipId}:${property}`;
    case "bone": return `bone:${target.layerId}:${target.assetIdentity}:${target.path}:${property}`;
    case "constraint": return `constraint:${target.layerId}:${target.assetIdentity}:${target.type}:${target.name}:${property}`;
    case "slot": return `slot:${target.layerId}:${target.assetIdentity}:${target.name}:${property}`;
    case "audio": return `audio:${target.audioId}:${property}`;
  }
}

export interface CompositionEvaluationContext {
  compositionTime: number;
  transportTime?: number;
  /** Optional arrangement clock for persistent scene/background content. */
  persistentTime?: number;
  sectionInstanceTimes?: Readonly<Record<string, number>>;
  /** Optional live section owner used by the interactive Viewer. */
  activeSectionId?: string;
  activeSectionChannels?: readonly CompositionSectionRoute["ownedChannels"][number][];
  activeSectionWeight?: number;
}

/** Build canonical linear-playback clocks for every section covering a timestamp. */
export function compositionEvaluationContextAt(
  composition: SpineComposition,
  compositionTime: number,
  transportTime = compositionTime,
): CompositionEvaluationContext {
  const sectionInstanceTimes = Object.fromEntries(composition.sections.flatMap((section) => {
    const includesEndpoint = composition.finalFramePolicy === "include-endpoint"
      && compositionTime === composition.duration && section.end === composition.duration;
    return compositionTime >= section.start && (compositionTime < section.end || includesEndpoint)
      ? [[section.id, compositionTime - section.start]]
      : [];
  }));
  return { compositionTime, transportTime, sectionInstanceTimes };
}

export interface EvaluatedComposition {
  time: number;
  properties: ReadonlyMap<string, CompositionValue>;
  /** Uncollapsed typed contributions for runtime adapters that own their base pose (bones/constraints). */
  propertyContributions: Array<{ target: CompositionTarget; property: string; value: CompositionValue; blendMode: CompositionBlendMode; weight: number; priority: number; trackId: string }>;
  activeSectionIds: string[];
  activeAnimationClips: Array<{ clip: CompositionAnimationClip; sourceTime: number; weight: number }>;
  activeAudio: CompositionAudioClip[];
  activeSubtitles: CompositionSubtitleCue[];
  activeColorClips: Array<{ layer: CompositionColorLayer; clip: CompositionColorClip; opacity: number; color: CompositionColor }>;
  diagnostics: CompositionDiagnostic[];
}

export function compositionClockTime(clock: CompositionClock, context: CompositionEvaluationContext): number | null {
  if (clock.kind === "composition") return context.compositionTime;
  if (clock.kind === "transport") return context.transportTime ?? null;
  return context.sectionInstanceTimes?.[clock.sectionId] ?? null;
}

function compositionClockTimeForLayer(
  clock: CompositionClock,
  layer: CompositionLayer | null,
  context: CompositionEvaluationContext,
): number | null {
  if (clock.kind === "composition" && context.persistentTime !== undefined
    && (layer?.role === "background" || layer?.role === "scene")) return context.persistentTime;
  return compositionClockTime(clock, context);
}

function targetLayer(composition: SpineComposition, target: CompositionTarget): CompositionLayer | null {
  const layerId = target.kind === "layer" || target.kind === "bone" || target.kind === "constraint" || target.kind === "slot"
    ? target.layerId
    : target.kind === "clip"
      ? composition.animationClips.find((clip) => clip.id === target.clipId)?.layerId
      : null;
  return layerId ? composition.layers.find((layer) => layer.id === layerId) ?? null : null;
}

function targetRouteChannel(composition: SpineComposition, target: CompositionTarget, definition: CompositionPropertyDefinition): CompositionSectionRoute["ownedChannels"][number] {
  if (definition.stage === "audio") return "audio";
  if (definition.stage === "camera") return "camera";
  if (definition.stage === "skeleton-local" || definition.stage === "constraint" || definition.stage === "slot") return "skeletal-overrides";
  if (definition.stage === "animation") return "body";
  const role = targetLayer(composition, target)?.role;
  return role === "character" ? "body" : role === "scene" || role === "background" ? "scene" : "effects";
}

function routedCompositionTime(
  composition: SpineComposition,
  context: CompositionEvaluationContext,
  target: CompositionTarget,
  definition: CompositionPropertyDefinition,
): { time: number; weight: number; routed: boolean } | null {
  const section = context.activeSectionId ? composition.sections.find((item) => item.id === context.activeSectionId) : null;
  const elapsed = section ? context.sectionInstanceTimes?.[section.id] : undefined;
  if (section && elapsed !== undefined && context.activeSectionChannels) {
    const channel = targetRouteChannel(composition, target, definition);
    if (context.activeSectionChannels.includes(channel)) {
      return { time: section.start + elapsed, weight: clamp01(context.activeSectionWeight ?? 1), routed: true };
    }
    if (channel === "body" && context.activeSectionChannels.includes("face")) {
      return { time: section.start + elapsed, weight: clamp01(context.activeSectionWeight ?? 1), routed: true };
    }
  }
  return null;
}

function compositionActive(start: number, end: number, time: number, duration: number, policy: SpineComposition["finalFramePolicy"]): boolean {
  if (time >= start && time < end) return true;
  return policy === "include-endpoint" && time === duration && end === duration && time >= start;
}

/** Shared random-access composition evaluation, independent of UI selection and renderer order. */
export function evaluateComposition(composition: SpineComposition, context: CompositionEvaluationContext): EvaluatedComposition {
  const diagnostics: CompositionDiagnostic[] = [];
  const properties = new Map<string, CompositionValue>();
  for (const layer of composition.layers) {
    for (const [property, value] of Object.entries(layer.baseProperties)) properties.set(compositionTargetKey({ kind: "layer", layerId: layer.id }, property), value);
  }
  for (const clip of composition.animationClips) {
    properties.set(compositionTargetKey({ kind: "clip", clipId: clip.id }, "animation.speed"), clip.speed);
    properties.set(compositionTargetKey({ kind: "clip", clipId: clip.id }, "animation.weight"), clip.weight);
  }
  for (const audio of composition.audio) properties.set(compositionTargetKey({ kind: "audio", audioId: audio.id }, "audio.volume"), audio.volume);
  for (const layer of composition.colorLayers) {
    for (const clip of layer.clips) {
      const target = { kind: "clip", clipId: clip.id } as const;
      properties.set(compositionTargetKey(target, "color.value"), clip.color);
      properties.set(compositionTargetKey(target, "color.opacity"), clip.opacity);
    }
  }
  const propertyContributions: EvaluatedComposition["propertyContributions"] = [];
  const tracks = [...composition.propertyTracks].filter((track) => track.enabled)
    .sort((a, b) => a.priority - b.priority || compositionTargetKey(a.target, a.property).localeCompare(compositionTargetKey(b.target, b.property)) || a.id.localeCompare(b.id));
  for (const track of tracks) {
    const definition = compositionPropertyDefinition(track.property);
    if (!definition) continue;
    const sectionId = track.clock.kind === "section-instance" ? track.clock.sectionId : null;
    const sectionClock = sectionId !== null;
    if (sectionId && context.activeSectionId && sectionId !== context.activeSectionId) continue;
    const channel = targetRouteChannel(composition, track.target, definition);
    if (sectionClock && context.activeSectionChannels && !context.activeSectionChannels.includes(channel)
      && !(channel === "body" && context.activeSectionChannels.includes("face"))) continue;
    const mapped = track.clock.kind === "composition" ? routedCompositionTime(composition, context, track.target, definition) : null;
    const layer = targetLayer(composition, track.target);
    const clockTime = mapped?.time ?? compositionClockTimeForLayer(track.clock, layer, context);
    if (clockTime === null) continue;
    const value = sampleCompositionTrack(track, clockTime);
    if (value === undefined) continue;
    const invalid = validatePropertyValue(definition, value);
    if (invalid) {
      diagnostics.push({ severity: "warning", code: "invalid-evaluated-value", message: `Track “${track.id}” produced ${invalid}`, targetId: track.id });
      continue;
    }
    const weight = clamp01(track.weight) * (sectionClock || mapped?.routed ? clamp01(context.activeSectionWeight ?? 1) : 1);
    propertyContributions.push({ target: track.target, property: track.property, value, blendMode: track.blendMode, weight, priority: track.priority, trackId: track.id });
    const key = compositionTargetKey(track.target, track.property);
    const base = properties.get(key) ?? track.baseValue ?? definition.defaultValue;
    properties.set(key, blendValue(base, value, definition, track.blendMode, weight));
  }
  const activeSectionIds = composition.sections.filter((section) => compositionActive(section.start, section.end, context.compositionTime, composition.duration, composition.finalFramePolicy)).map((section) => section.id);
  const activeAnimationClips = composition.animationClips.flatMap((clip) => {
    if (!clip.enabled) return [];
    if (clip.clock.kind === "section-instance" && context.activeSectionId && clip.clock.sectionId !== context.activeSectionId) return [];
    const clipLayer = composition.layers.find((layer) => layer.id === clip.layerId);
    const section = context.activeSectionId ? composition.sections.find((item) => item.id === context.activeSectionId) : null;
    const sectionElapsed = section ? context.sectionInstanceTimes?.[section.id] : undefined;
    const channel = clipLayer?.role === "character" ? "body" : clipLayer?.role === "scene" || clipLayer?.role === "background" ? "scene" : "effects";
    if (clip.clock.kind === "section-instance" && context.activeSectionChannels
      && !context.activeSectionChannels.includes(channel)
      && !(channel === "body" && context.activeSectionChannels.includes("face"))) return [];
    const mapped = clip.clock.kind === "composition" && section && sectionElapsed !== undefined
      && clip.start >= section.start - 1e-6 && clip.end <= section.end + 1e-6
      && context.activeSectionChannels?.includes(channel)
      ? { time: section.start + sectionElapsed, weight: clamp01(context.activeSectionWeight ?? 1) }
      : null;
    const time = mapped?.time ?? compositionClockTimeForLayer(clip.clock, clipLayer ?? null, context);
    if (time === null || time < clip.start || (time >= clip.end && clip.endBehavior !== "hold")) return [];
    const clipActive = clip.clock.kind === "composition"
      ? compositionActive(clip.start, clip.end, time, composition.duration, composition.finalFramePolicy)
      : time < clip.end || (composition.finalFramePolicy === "include-endpoint" && context.compositionTime === composition.duration && time === clip.end);
    if (!clipActive && time < clip.end) return [];
    const rateClock = clip.sourceClock.kind === "clip-source" ? clip.clock : clip.sourceClock;
    const speedTracks = composition.propertyTracks.filter((track) => track.enabled && track.target.kind === "clip" && track.target.clipId === clip.id && track.property === "animation.speed" && sameClock(track.clock, rateClock))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const rateTrack = speedTracks.at(-1);
    const sourceClockTime = clip.sourceClock.kind === "clip-source"
      ? Math.max(0, Math.min(time, clip.end) - clip.start)
      : compositionClockTimeForLayer(clip.sourceClock, clipLayer ?? null, context);
    if (sourceClockTime === null) return [];
    const rateStart = clip.sourceClock.kind === "clip-source" ? clip.start : clip.sourceOriginTime;
    const rateEnd = clip.sourceClock.kind === "clip-source" ? Math.min(time, clip.end) : sourceClockTime;
    const elapsed = rateTrack
      ? integrateCompositionRate({ ...rateTrack, baseValue: rateTrack.baseValue ?? clip.speed }, rateStart, rateEnd)
      : (clip.sourceClock.kind === "clip-source" ? sourceClockTime : sourceClockTime - clip.sourceOriginTime) * clip.speed;
    if (elapsed === null) {
      diagnostics.push({ severity: "warning", code: "unsupported-rate-curve", message: `Animation clip “${clip.id}” has a rate curve that cannot be integrated exactly.`, targetId: clip.id });
      return [];
    }
    const sourceSpan = clip.sourceEnd - clip.sourceStart;
    const sourcePosition = clip.sourceStart + clip.sourceOffset + elapsed;
    const sourceTime = clip.loop ? clip.sourceStart + ((sourcePosition - clip.sourceStart) % sourceSpan) : Math.min(clip.sourceEnd, sourcePosition);
    const remaining = Math.max(0, clip.end - time);
    const inWeight = clip.blendIn > 0 ? clamp01((time - clip.start) / clip.blendIn) : 1;
    const outWeight = clip.endBehavior === "hold" && time >= clip.end ? 1 : clip.blendOut > 0 ? clamp01(remaining / clip.blendOut) : 1;
    const target = { kind: "clip", clipId: clip.id } as const;
    const animation = properties.get(compositionTargetKey(target, "animation.selection"));
    const weight = properties.get(compositionTargetKey(target, "animation.weight"));
    const evaluatedClip = typeof animation === "string" && animation !== clip.animation ? { ...clip, animation } : clip;
    const routeWeight = clip.clock.kind === "section-instance" || mapped ? clamp01(context.activeSectionWeight ?? 1) : 1;
    return [{ clip: evaluatedClip, sourceTime, weight: (typeof weight === "number" ? clamp01(weight) : clip.weight) * Math.min(inWeight, outWeight) * routeWeight }];
  }).sort((a, b) => a.clip.priority - b.clip.priority || a.clip.id.localeCompare(b.clip.id));
  const activeClipByLayer = new Map<string, typeof activeAnimationClips[number]>();
  for (const active of activeAnimationClips) activeClipByLayer.set(active.clip.layerId, active);
  const selectedAnimation = (layerId: string, visiting = new Set<string>()): string | null => {
    if (visiting.has(layerId)) return null;
    visiting.add(layerId);
    const layer = composition.layers.find((item) => item.id === layerId);
    if (!layer) return null;
    const binding = layer.animationBinding;
    if (!binding) return activeClipByLayer.get(layerId)?.clip.animation ?? null;
    const source = selectedAnimation(binding.sourceLayerId, visiting);
    if (source) return source;
    if (binding.fallback === "layer-base") {
      const base = layer.baseProperties["animation.selection"];
      if (typeof base === "string" && base) return base;
    }
    return activeClipByLayer.get(layerId)?.clip.animation ?? null;
  };
  const boundAnimationClips = activeAnimationClips.map((active) => {
    const layer = composition.layers.find((item) => item.id === active.clip.layerId);
    if (!layer?.animationBinding) return active;
    const animation = selectedAnimation(active.clip.layerId);
    return animation && animation !== active.clip.animation ? { ...active, clip: { ...active.clip, animation } } : active;
  });
  const activeAudio = composition.audio.filter((clip) => {
    if (!clip.enabled) return false;
    if (clip.sectionId) {
      if (context.activeSectionId && context.activeSectionId !== clip.sectionId || context.activeSectionChannels && !context.activeSectionChannels.includes("audio")) return false;
      const section = composition.sections.find((item) => item.id === clip.sectionId);
      const sectionTime = context.sectionInstanceTimes?.[clip.sectionId]
        ?? (section ? context.compositionTime - section.start : undefined);
      return sectionTime !== undefined && sectionTime >= 0 && compositionActive(clip.start, clip.end, sectionTime, section ? section.end - section.start : composition.duration, composition.finalFramePolicy);
    }
    return compositionActive(clip.start, clip.end, context.compositionTime, composition.duration, composition.finalFramePolicy);
  });
  const activeSubtitles = composition.subtitles.filter((cue) => {
    if (!cue.enabled) return false;
    if (cue.sectionId) {
      if (context.activeSectionId && context.activeSectionId !== cue.sectionId || context.activeSectionChannels && !context.activeSectionChannels.includes("subtitles")) return false;
      const section = composition.sections.find((item) => item.id === cue.sectionId);
      const sectionTime = context.sectionInstanceTimes?.[cue.sectionId]
        ?? (section ? context.compositionTime - section.start : undefined);
      return sectionTime !== undefined && sectionTime >= 0 && compositionActive(cue.start, cue.end, sectionTime, section ? section.end - section.start : composition.duration, composition.finalFramePolicy);
    }
    return compositionActive(cue.start, cue.end, context.compositionTime, composition.duration, composition.finalFramePolicy);
  });
  const activeColorClips = composition.colorLayers.flatMap((layer) => layer.clips.flatMap((clip) => {
    if (!layer.enabled || !clip.enabled || !compositionActive(clip.start, clip.end, context.compositionTime, composition.duration, composition.finalFramePolicy)) return [];
    const elapsed = context.compositionTime - clip.start;
    const remaining = clip.end - context.compositionTime;
    const fade = Math.min(clip.fadeIn > 0 ? clamp01(elapsed / clip.fadeIn) : 1, clip.fadeOut > 0 ? clamp01(remaining / clip.fadeOut) : 1);
    const target = { kind: "clip", clipId: clip.id } as const;
    const color = properties.get(compositionTargetKey(target, "color.value"));
    const opacity = properties.get(compositionTargetKey(target, "color.opacity"));
    return [{ layer, clip, color: isCompositionColor(color ?? clip.color) ? color as CompositionColor : clip.color, opacity: layer.opacity * (typeof opacity === "number" ? clamp01(opacity) : clip.opacity) * fade }];
  }));
  return { time: context.compositionTime, properties, propertyContributions, activeSectionIds, activeAnimationClips: boundAnimationClips, activeAudio, activeSubtitles, activeColorClips, diagnostics };
}

export interface CompositionLayerTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

interface AffineTransform { a: number; b: number; c: number; d: number; x: number; y: number; opacity: number }

/** Resolve stable parent transforms. Validation rejects cycles; this function is defensive for unvalidated input. */
export function evaluateLayerTransforms(composition: SpineComposition, evaluation: EvaluatedComposition): Map<string, CompositionLayerTransform> {
  const byId = new Map(composition.layers.map((layer) => [layer.id, layer]));
  const resolved = new Map<string, AffineTransform>();
  const visiting = new Set<string>();
  const resolve = (id: string): AffineTransform | null => {
    const cached = resolved.get(id);
    if (cached) return cached;
    const layer = byId.get(id);
    if (!layer || visiting.has(id)) return null;
    visiting.add(id);
    const value = (property: string) => evaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: id }, property)) ?? layer.baseProperties[property] ?? compositionPropertyDefinition(property)?.defaultValue;
    const x = numberValue(value("layer.position.x"), 0);
    const y = numberValue(value("layer.position.y"), 0);
    const rotation = numberValue(value("layer.rotation"), 0) * Math.PI / 180;
    const scaleX = numberValue(value("layer.scale.x"), 1);
    const scaleY = numberValue(value("layer.scale.y"), 1);
    const visible = value("layer.visible");
    const opacity = layer.enabled && visible !== false ? clamp01(numberValue(value("layer.opacity"), 1)) : 0;
    const local: AffineTransform = { a: Math.cos(rotation) * scaleX, b: Math.sin(rotation) * scaleX, c: -Math.sin(rotation) * scaleY, d: Math.cos(rotation) * scaleY, x, y, opacity };
    const parent = layer.transformParentId ? resolve(layer.transformParentId) : null;
    visiting.delete(id);
    const world = parent ? {
      a: parent.a * local.a + parent.c * local.b,
      b: parent.b * local.a + parent.d * local.b,
      c: parent.a * local.c + parent.c * local.d,
      d: parent.b * local.c + parent.d * local.d,
      x: parent.a * local.x + parent.c * local.y + parent.x,
      y: parent.b * local.x + parent.d * local.y + parent.y,
      opacity: parent.opacity * local.opacity,
    } : local;
    resolved.set(id, world);
    return world;
  };
  const output = new Map<string, CompositionLayerTransform>();
  for (const layer of composition.layers) {
    const matrix = resolve(layer.id);
    if (!matrix) continue;
    output.set(layer.id, {
      x: matrix.x,
      y: matrix.y,
      rotation: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
      scaleX: Math.hypot(matrix.a, matrix.b),
      scaleY: Math.hypot(matrix.c, matrix.d),
      opacity: matrix.opacity,
    });
  }
  return output;
}

function numberValue(value: CompositionValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sameClock(left: CompositionClock, right: CompositionClock): boolean {
  return left.kind === right.kind && (left.kind !== "section-instance" || right.kind === "section-instance" && left.sectionId === right.sectionId);
}

export interface CompositionAnimationTimeMapping {
  clipStart: number;
  clipEnd: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  loop: boolean;
}

/** Maps a positive constant rate; reverse playback is deliberately unsupported in schema v1. */
export function mapCompositionClipTime(mapping: CompositionAnimationTimeMapping, clockTime: number): number | null {
  if (![mapping.clipStart, mapping.clipEnd, mapping.sourceStart, mapping.sourceEnd, mapping.speed, clockTime].every(Number.isFinite)
    || mapping.clipEnd <= mapping.clipStart || mapping.sourceEnd <= mapping.sourceStart || mapping.speed < 0) return null;
  if (clockTime < mapping.clipStart || clockTime >= mapping.clipEnd) return null;
  const span = mapping.sourceEnd - mapping.sourceStart;
  const sourceElapsed = (clockTime - mapping.clipStart) * mapping.speed;
  return mapping.loop ? mapping.sourceStart + sourceElapsed % span : Math.min(mapping.sourceEnd, mapping.sourceStart + sourceElapsed);
}

/** Exact integral for step/linear non-negative speed automation; Bézier rate keys are rejected. */
export function integrateCompositionRate(track: CompositionPropertyTrack, start: number, end: number): number | null {
  if (track.property !== "animation.speed" || !Number.isFinite(start + end) || end < start) return null;
  const keys = sortedKeys(track);
  if (keys.some((key) => key.interpolation === "bezier" || typeof key.value !== "number" || key.value < 0)) return null;
  const boundaries = [...new Set([start, end, ...keys.map((key) => key.time).filter((time) => time > start && time < end)])].sort((a, b) => a - b);
  if (boundaries.length === 1) return 0;
  let total = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const a = boundaries[index]!;
    const b = boundaries[index + 1]!;
    const left = sampleCompositionTrack(track, a) ?? (track.baseValue ?? 1);
    const right = sampleCompositionTrack(track, b) ?? (track.baseValue ?? 1);
    const leftRate = typeof left === "number" ? left : 0;
    const rightRate = typeof right === "number" ? right : leftRate;
    const activeKey = keys.filter((item) => item.time <= a).at(-1);
    total += (activeKey?.interpolation === "step" ? leftRate : (leftRate + rightRate) / 2) * (b - a);
  }
  return total;
}

export interface FixedStepPrerollPolicy {
  stepSeconds: number;
  maxSteps: number;
}

export interface FixedStepPrerollCheckpoint<State> {
  nearestStep(maxStepIndex: number): { stepIndex: number; state: State } | null;
  restore(state: State, stepIndex: number): void;
  shouldCapture(stepIndex: number): boolean;
  capture(stepIndex: number): void;
}

export function combineFixedStepPrerollCheckpoints<State>(
  checkpoints: readonly FixedStepPrerollCheckpoint<State>[],
): FixedStepPrerollCheckpoint<State[]> | undefined {
  if (checkpoints.length === 0) return undefined;
  return {
    nearestStep: (maxStepIndex) => {
      let stepIndex = maxStepIndex;
      while (stepIndex >= 0) {
        const candidates = checkpoints.map((checkpoint) => checkpoint.nearestStep(stepIndex));
        if (candidates.some((candidate) => candidate === null)) return null;
        const commonStep = Math.min(...candidates.map((candidate) => candidate!.stepIndex));
        if (candidates.every((candidate) => candidate!.stepIndex === commonStep)) {
          return { stepIndex: commonStep, state: candidates.map((candidate) => candidate!.state) };
        }
        if (commonStep === stepIndex) return null;
        stepIndex = commonStep;
      }
      return null;
    },
    restore: (states, stepIndex) => checkpoints.forEach((checkpoint, index) => checkpoint.restore(states[index]!, stepIndex)),
    shouldCapture: (stepIndex) => checkpoints.every((checkpoint) => checkpoint.shouldCapture(stepIndex)),
    capture: (stepIndex) => checkpoints.forEach((checkpoint) => checkpoint.capture(stepIndex)),
  };
}

/**
 * Deterministic stateful-constraint sampling contract. Callers reset the skeleton/runtime,
 * sample the complete pose at each fixed simulation step, then sample the requested residual.
 */
export function runFixedStepPreroll<State = unknown>(
  targetTime: number,
  policy: FixedStepPrerollPolicy,
  reset: () => void,
  evaluateStep: (time: number, deltaSeconds: number, final: boolean, physics: Physics) => void,
  checkpoint?: FixedStepPrerollCheckpoint<State>,
): { steps: number; sampledTime: number } | null {
  if (!Number.isFinite(targetTime) || targetTime < 0 || !Number.isFinite(policy.stepSeconds) || policy.stepSeconds <= 0 || !Number.isInteger(policy.maxSteps) || policy.maxSteps < 1) return null;
  const steps = Math.ceil(targetTime / policy.stepSeconds);
  if (steps > policy.maxSteps) return null;

  // Preserve the same exact timestamp sequence as a reset-based preroll. The
  // last full grid step may be just below targetTime due to floating-point
  // representation (for example, 0.3 / 0.1), in which case targetTime remains
  // a final residual sample.
  let fullStepCount = Math.floor(targetTime / policy.stepSeconds);
  while (fullStepCount > 0 && fullStepCount * policy.stepSeconds > targetTime) fullStepCount -= 1;
  while ((fullStepCount + 1) * policy.stepSeconds <= targetTime) fullStepCount += 1;

  const cached = targetTime > 0 ? checkpoint?.nearestStep(fullStepCount) ?? null : null;
  let currentStep = 0;
  if (cached && cached.stepIndex >= 0 && cached.stepIndex <= fullStepCount) {
    checkpoint!.restore(cached.state, cached.stepIndex);
    currentStep = cached.stepIndex;
    const time = currentStep * policy.stepSeconds;
    if (time === targetTime && currentStep === fullStepCount) evaluateStep(time, 0, true, Physics.pose);
  } else {
    reset();
    evaluateStep(0, 0, targetTime === 0, Physics.reset);
    checkpoint?.capture(0);
  }

  for (let index = currentStep + 1; index <= fullStepCount; index += 1) {
    const time = index * policy.stepSeconds;
    const delta = time - (index - 1) * policy.stepSeconds;
    evaluateStep(time, delta, time === targetTime && index === fullStepCount, Physics.update);
    if (checkpoint && (index === fullStepCount || checkpoint.shouldCapture(index))) checkpoint.capture(index);
  }

  const gridTime = fullStepCount * policy.stepSeconds;
  if (gridTime !== targetTime) evaluateStep(targetTime, targetTime - gridTime, true, Physics.update);

  return { steps: Math.max(1, steps), sampledTime: targetTime };
}

export interface SpineSkeletalOverride {
  target: Extract<CompositionTarget, { kind: "layer" | "bone" | "constraint" | "slot" }>;
  property: string;
  value: CompositionValue;
  mode: CompositionBlendMode;
  weight: number;
  priority?: number;
}

export function skeletalOverridesFromEvaluation(evaluation: EvaluatedComposition, layerId: string, assetIdentity: string): SpineSkeletalOverride[] {
  return evaluation.propertyContributions.flatMap<SpineSkeletalOverride>((contribution) => {
    const target = contribution.target;
    if (target.kind === "layer") {
      if (target.layerId !== layerId || contribution.property !== "skeleton.skin") return [];
      return [{ target, property: contribution.property, value: contribution.value, mode: contribution.blendMode, weight: contribution.weight, priority: contribution.priority }];
    }
    if ((target.kind !== "bone" && target.kind !== "constraint" && target.kind !== "slot") || target.layerId !== layerId || target.assetIdentity !== assetIdentity) return [];
    return [{ target, property: contribution.property, value: contribution.value, mode: contribution.blendMode, weight: contribution.weight, priority: contribution.priority }];
  });
}

export interface EvaluatedCompositionLayer {
  layer: CompositionLayer;
  transform: CompositionLayerTransform;
  visible: boolean;
  blendMode: "normal" | "multiply" | "screen" | "additive";
  animationClips: EvaluatedComposition["activeAnimationClips"];
  skeletalOverrides: SpineSkeletalOverride[];
}

export interface EvaluatedCompositionFrame {
  evaluation: EvaluatedComposition;
  layers: EvaluatedCompositionLayer[];
}

/** Resolve the renderer-facing layer state from the same shared frame evaluation. */
export function evaluateCompositionFrame(composition: SpineComposition, context: CompositionEvaluationContext): EvaluatedCompositionFrame {
  const evaluation = evaluateComposition(composition, context);
  const transforms = evaluateLayerTransforms(composition, evaluation);
  const layers = composition.layers.flatMap<EvaluatedCompositionLayer>((layer) => {
    const transform = transforms.get(layer.id);
    if (!transform) return [];
    const visible = evaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: layer.id }, "layer.visible"));
    const blendMode = evaluation.properties.get(compositionTargetKey({ kind: "layer", layerId: layer.id }, "layer.blendMode"));
    return [{
      layer,
      transform,
      visible: layer.enabled && visible !== false,
      blendMode: blendMode === "multiply" || blendMode === "screen" || blendMode === "additive" ? blendMode : "normal",
      animationClips: evaluation.activeAnimationClips.filter((active) => active.clip.layerId === layer.id),
      skeletalOverrides: skeletalOverridesFromEvaluation(evaluation, layer.id, layer.assetIdentity),
    }];
  });
  return { evaluation, layers };
}

function blendSkeletalNumber(base: number, value: number, property: string, mode: CompositionBlendMode, weight: number): number {
  const w = clamp01(weight);
  if (mode === "additive") return property.endsWith("scaleX") || property.endsWith("scaleY") ? base * (1 + (value - 1) * w) : base + value * w;
  return base + (value - base) * w;
}

function spineBonePath(bone: NonNullable<ReturnType<Skeleton["findBone"]>>): string {
  const names: string[] = [];
  let current: typeof bone | null = bone;
  while (current) {
    names.push(current.data.name);
    current = current.parent;
  }
  return names.reverse().join("/");
}

/** Apply authored skeletal values after animation sampling and before the caller's world/constraint solve. */
export function applySpineSkeletalOverrides(skeleton: Skeleton, layerId: string, assetIdentity: string, overrides: readonly SpineSkeletalOverride[]): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = [];
  const orderedOverrides = overrides.map((override, index) => ({ override, index })).sort((a, b) => {
    const stage = (item: SpineSkeletalOverride) => item.target.kind === "layer" && item.property === "skeleton.skin"
      ? 0
      : item.target.kind === "slot"
        ? 2
        : 1;
    return stage(a.override) - stage(b.override) || (a.override.priority ?? 0) - (b.override.priority ?? 0) || a.index - b.index;
  });
  for (const { override } of orderedOverrides) {
    const { target, property, value, mode, weight } = override;
    if (target.layerId !== layerId) continue;
    if (target.kind === "layer") {
      if (property !== "skeleton.skin" || typeof value !== "string" || weight < 0.5) continue;
      const skin = value ? skeleton.data.findSkin(value) : null;
      if (value && !skin) {
        diagnostics.push({ severity: "warning", code: "missing-skin", message: `Skin “${value}” is unavailable in the loaded skeleton.`, targetId: value });
        continue;
      }
      skeleton.setSkin(skin);
      continue;
    }
    if (target.assetIdentity !== assetIdentity) continue;
    if (target.kind === "bone") {
      const bone = skeleton.bones.find((candidate) => spineBonePath(candidate) === target.path);
      if (!bone) {
        diagnostics.push({ severity: "warning", code: "missing-bone", message: `Bone path “${target.path}” is unavailable in the loaded skeleton.`, targetId: target.path });
        continue;
      }
      const fields = {
        "bone.x": "x", "bone.y": "y", "bone.rotation": "rotation", "bone.scaleX": "scaleX", "bone.scaleY": "scaleY", "bone.shearX": "shearX", "bone.shearY": "shearY",
      } as const;
      const field = fields[property as keyof typeof fields];
      if (!field || typeof value !== "number" || !Number.isFinite(value)) continue;
      bone[field] = blendSkeletalNumber(bone[field], value, property, mode, weight);
      continue;
    }
    if (target.kind === "constraint") {
      if (target.type === "ik") {
        const constraint = skeleton.ikConstraints.find((item) => item.data.name === target.name);
        if (!constraint) { diagnostics.push({ severity: "warning", code: "missing-constraint", message: `IK constraint “${target.name}” is unavailable.`, targetId: target.name }); continue; }
        if (property === "constraint.ik.mix" && typeof value === "number") constraint.mix = blendSkeletalNumber(constraint.mix, value, property, mode, weight);
        else if (property === "constraint.ik.softness" && typeof value === "number") constraint.softness = blendSkeletalNumber(constraint.softness, value, property, mode, weight);
        else if (property === "constraint.ik.bendDirection" && typeof value === "number") constraint.bendDirection = weight >= 0.5 ? Math.sign(value) : constraint.bendDirection;
        else if (property === "constraint.ik.compress" && typeof value === "boolean") constraint.compress = weight >= 0.5 ? value : constraint.compress;
        else if (property === "constraint.ik.stretch" && typeof value === "boolean") constraint.stretch = weight >= 0.5 ? value : constraint.stretch;
      } else if (target.type === "transform") {
        const constraint = skeleton.transformConstraints.find((item) => item.data.name === target.name);
        if (!constraint) { diagnostics.push({ severity: "warning", code: "missing-constraint", message: `Transform constraint “${target.name}” is unavailable.`, targetId: target.name }); continue; }
        const fields = { "constraint.transform.mixRotate": "mixRotate", "constraint.transform.mixX": "mixX", "constraint.transform.mixY": "mixY", "constraint.transform.mixScaleX": "mixScaleX", "constraint.transform.mixScaleY": "mixScaleY", "constraint.transform.mixShearY": "mixShearY" } as const;
        const field = fields[property as keyof typeof fields];
        if (field && typeof value === "number") constraint[field] = blendSkeletalNumber(constraint[field], value, property, mode, weight);
      } else if (target.type === "path") {
        const constraint = skeleton.pathConstraints.find((item) => item.data.name === target.name);
        if (!constraint) { diagnostics.push({ severity: "warning", code: "missing-constraint", message: `Path constraint “${target.name}” is unavailable.`, targetId: target.name }); continue; }
        const fields = { "constraint.path.position": "position", "constraint.path.spacing": "spacing", "constraint.path.mixRotate": "mixRotate", "constraint.path.mixX": "mixX", "constraint.path.mixY": "mixY" } as const;
        const field = fields[property as keyof typeof fields];
        if (field && typeof value === "number") constraint[field] = blendSkeletalNumber(constraint[field], value, property, mode, weight);
      } else {
        const constraint = skeleton.physicsConstraints.find((item) => item.data.name === target.name);
        if (!constraint) { diagnostics.push({ severity: "warning", code: "missing-constraint", message: `Physics constraint “${target.name}” is unavailable.`, targetId: target.name }); continue; }
        const fields = { "constraint.physics.inertia": "inertia", "constraint.physics.strength": "strength", "constraint.physics.damping": "damping", "constraint.physics.massInverse": "massInverse", "constraint.physics.wind": "wind", "constraint.physics.gravity": "gravity", "constraint.physics.mix": "mix" } as const;
        const field = fields[property as keyof typeof fields];
        if (field && typeof value === "number") constraint[field] = blendSkeletalNumber(constraint[field], value, property, mode, weight);
      }
      continue;
    }
    const slot = skeleton.findSlot(target.name);
    if (!slot) { diagnostics.push({ severity: "warning", code: "missing-slot", message: `Slot “${target.name}” is unavailable.`, targetId: target.name }); continue; }
    if (property === "slot.attachment" && typeof value === "string") {
      if (weight >= 0.5) {
        if (value) skeleton.setAttachment(target.name, value);
        else slot.setAttachment(null);
      }
    } else if (property.startsWith("slot.color.") && typeof value === "number") {
      const channel = property.slice("slot.color.".length) as "r" | "g" | "b" | "a";
      if (channel in slot.color) slot.color[channel] = blendSkeletalNumber(slot.color[channel], value, property, mode, weight);
    }
  }
  return diagnostics;
}

/** A small wrapper makes the Spine 4.2 solve stage explicit at call sites. */
export function solveSpineCompositionPose(skeleton: Skeleton, physics: Physics = Physics.pose): void {
  skeleton.updateWorldTransform(physics);
}
