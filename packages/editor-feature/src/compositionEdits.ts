import {
  compositionPropertyDefinition,
  validateComposition,
  type CompositionAnimationClip,
  type CompositionColorLayer,
  type CompositionKeyframe,
  type CompositionLayer,
  type CompositionPropertyTrack,
  type CompositionSection,
  type CompositionSubtitleCue,
  type CompositionAudioClip,
  type SpineComposition,
} from "@ba-spine/spine-runtime/spine/spineComposition";
import { normalizeSpineCameraTrack, type SpineCameraTrack } from "@ba-spine/spine-runtime/spine/spineCameraMotion";

export type CompositionEditOperation =
  | { kind: "set_duration"; duration: number }
  | { kind: "set_idle_section"; sectionId: string | null }
  | { kind: "set_entry_section"; sectionId: string | null }
  | { kind: "upsert_section"; section: CompositionSection }
  | { kind: "remove_section"; sectionId: string }
  | { kind: "upsert_layer"; layer: CompositionLayer }
  | { kind: "remove_layer"; layerId: string }
  | { kind: "set_layer_base_property"; layerId: string; property: string; value: CompositionLayer["baseProperties"][string] }
  | { kind: "set_animation_binding"; layerId: string; binding: CompositionLayer["animationBinding"] | null }
  | { kind: "upsert_animation_clip"; clip: CompositionAnimationClip }
  | { kind: "remove_animation_clip"; clipId: string }
  | { kind: "upsert_property_track"; track: CompositionPropertyTrack }
  | { kind: "remove_property_track"; trackId: string }
  | { kind: "upsert_keyframe"; trackId: string; key: CompositionKeyframe }
  | { kind: "remove_keyframe"; trackId: string; keyId: string }
  | { kind: "upsert_audio_clip"; clip: CompositionAudioClip }
  | { kind: "remove_audio_clip"; clipId: string }
  | { kind: "upsert_subtitle_cue"; cue: CompositionSubtitleCue }
  | { kind: "remove_subtitle_cue"; cueId: string }
  | { kind: "upsert_color_layer"; layer: CompositionColorLayer }
  | { kind: "remove_color_layer"; layerId: string }
  | { kind: "set_camera"; camera: SpineCameraTrack | null };

export interface CompositionEditResult {
  composition: SpineComposition;
  affectedEntityIds: string[];
  createdEntityIds: string[];
  warnings: string[];
}

function record(value: unknown, label: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  const unexpected = Object.keys(result).find((key) => !allowed.includes(key));
  const missing = required.find((key) => !(key in result));
  if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}.`);
  if (missing) throw new Error(`${label} requires ${missing}.`);
  return result;
}

function text(value: unknown, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
}

function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
}

function bool(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
}

function valueShape(value: unknown, label: string): void {
  if (typeof value === "number") return finite(value, label);
  if (typeof value === "string" || typeof value === "boolean") return;
  const color = record(value, label, ["r", "g", "b", "a"], ["r", "g", "b", "a"]);
  for (const channel of ["r", "g", "b", "a"]) finite(color[channel], `${label}.${channel}`);
}

function validateClock(value: unknown, label: string, source = false): void {
  const raw = record(value, label, ["kind", "sectionId"], ["kind"]);
  if (raw.kind === "composition" || raw.kind === "transport") {
    if ("sectionId" in raw) throw new Error(`${label} does not accept sectionId for ${raw.kind}.`);
    return;
  }
  if (raw.kind === "section-instance") {
    text(raw.sectionId, `${label}.sectionId`);
    return;
  }
  if (source && raw.kind === "clip-source" && !("sectionId" in raw)) return;
  throw new Error(`${label}.kind is unsupported.`);
}

function validateTarget(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a typed target object.`);
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case "layer":
      text(record(raw, label, ["kind", "layerId"], ["kind", "layerId"]).layerId, `${label}.layerId`);
      return;
    case "camera":
      record(raw, label, ["kind"], ["kind"]);
      return;
    case "clip":
      text(record(raw, label, ["kind", "clipId"], ["kind", "clipId"]).clipId, `${label}.clipId`);
      return;
    case "bone": {
      const target = record(raw, label, ["kind", "layerId", "path", "assetIdentity"], ["kind", "layerId", "path", "assetIdentity"]);
      text(target.layerId, `${label}.layerId`); text(target.path, `${label}.path`); text(target.assetIdentity, `${label}.assetIdentity`); return;
    }
    case "constraint": {
      const target = record(raw, label, ["kind", "layerId", "type", "name", "assetIdentity"], ["kind", "layerId", "type", "name", "assetIdentity"]);
      text(target.layerId, `${label}.layerId`); text(target.name, `${label}.name`); text(target.assetIdentity, `${label}.assetIdentity`);
      if (!["ik", "transform", "path", "physics"].includes(String(target.type))) throw new Error(`${label}.type is unsupported.`); return;
    }
    case "slot": {
      const target = record(raw, label, ["kind", "layerId", "name", "assetIdentity"], ["kind", "layerId", "name", "assetIdentity"]);
      text(target.layerId, `${label}.layerId`); text(target.name, `${label}.name`); text(target.assetIdentity, `${label}.assetIdentity`); return;
    }
    case "audio":
      text(record(raw, label, ["kind", "audioId"], ["kind", "audioId"]).audioId, `${label}.audioId`);
      return;
    default:
      throw new Error(`${label}.kind is unsupported.`);
  }
}

function validateEntity(kind: string, value: unknown, label: string): void {
  switch (kind) {
    case "section": {
      const section = record(value, label, ["id", "name", "start", "end", "route"], ["id", "name", "start", "end"]);
      text(section.id, `${label}.id`); text(section.name, `${label}.name`); finite(section.start, `${label}.start`); finite(section.end, `${label}.end`);
      if (section.route !== undefined) {
        const route = record(section.route, `${label}.route`, ["role", "returnToSectionId", "ownedChannels", "duplicateTrigger", "interruption", "blendIn", "blendOut", "cameraReturn"], ["role", "returnToSectionId", "ownedChannels", "duplicateTrigger", "interruption", "blendIn", "blendOut", "cameraReturn"]);
        if (!["talk", "idle", "opening", "other"].includes(String(route.role))) throw new Error(`${label}.route.role is unsupported.`);
        if (route.returnToSectionId !== null) text(route.returnToSectionId, `${label}.route.returnToSectionId`);
        if (!Array.isArray(route.ownedChannels) || route.ownedChannels.some((channel) => !["body", "face", "audio", "subtitles", "camera", "effects", "scene", "skeletal-overrides"].includes(String(channel)))) throw new Error(`${label}.route.ownedChannels is invalid.`);
        if (!["ignore", "restart", "queue", "replace"].includes(String(route.duplicateTrigger))) throw new Error(`${label}.route.duplicateTrigger is unsupported.`);
        if (!["ignore", "replace", "finish-current"].includes(String(route.interruption))) throw new Error(`${label}.route.interruption is unsupported.`);
        if (!["blend", "hold", "persistent"].includes(String(route.cameraReturn))) throw new Error(`${label}.route.cameraReturn is unsupported.`);
        finite(route.blendIn, `${label}.route.blendIn`); finite(route.blendOut, `${label}.route.blendOut`);
      }
      return;
    }
    case "layer": {
      const layer = record(value, label, ["id", "name", "role", "order", "assetDirectory", "assetIdentity", "transformParentId", "animationBinding", "baseProperties", "enabled", "locked"], ["id", "name", "role", "order", "assetDirectory", "assetIdentity", "transformParentId", "baseProperties", "enabled", "locked"]);
      for (const field of ["id", "name", "assetDirectory", "assetIdentity"]) text(layer[field], `${label}.${field}`);
      if (!["character", "scene", "background", "overlay", "color"].includes(String(layer.role))) throw new Error(`${label}.role is unsupported.`);
      finite(layer.order, `${label}.order`); bool(layer.enabled, `${label}.enabled`); bool(layer.locked, `${label}.locked`);
      if (layer.transformParentId !== null) text(layer.transformParentId, `${label}.transformParentId`);
      const props = record(layer.baseProperties, `${label}.baseProperties`, Object.keys((layer.baseProperties ?? {}) as object), []);
      for (const [property, propertyValue] of Object.entries(props)) { text(property, `${label}.baseProperties key`); valueShape(propertyValue, `${label}.baseProperties.${property}`); }
      if (layer.animationBinding !== undefined) {
        if (layer.animationBinding === null) throw new Error(`${label}.animationBinding must be omitted or an object.`);
        const binding = record(layer.animationBinding, `${label}.animationBinding`, ["sourceLayerId", "fallback"], ["sourceLayerId", "fallback"]);
        text(binding.sourceLayerId, `${label}.animationBinding.sourceLayerId`);
        if (!["authored-animation", "layer-base"].includes(String(binding.fallback))) throw new Error(`${label}.animationBinding.fallback is unsupported.`);
      }
      return;
    }
    case "animation clip": {
      const clip = record(value, label, ["id", "layerId", "animation", "faceAnimation", "clock", "sourceClock", "start", "end", "sourceStart", "sourceEnd", "sourceOriginTime", "sourceOffset", "speed", "loop", "endBehavior", "blendIn", "blendOut", "mixingMode", "weight", "priority", "enabled"], ["id", "layerId", "animation", "clock", "sourceClock", "start", "end", "sourceStart", "sourceEnd", "sourceOriginTime", "sourceOffset", "speed", "loop", "endBehavior", "blendIn", "blendOut", "mixingMode", "weight", "priority", "enabled"]);
      for (const field of ["id", "layerId", "animation"]) text(clip[field], `${label}.${field}`);
      if (clip.faceAnimation !== undefined) text(clip.faceAnimation, `${label}.faceAnimation`, true);
      validateClock(clip.clock, `${label}.clock`); validateClock(clip.sourceClock, `${label}.sourceClock`, true);
      for (const field of ["start", "end", "sourceStart", "sourceEnd", "sourceOriginTime", "sourceOffset", "speed", "blendIn", "blendOut", "weight", "priority"]) finite(clip[field], `${label}.${field}`);
      bool(clip.loop, `${label}.loop`); bool(clip.enabled, `${label}.enabled`);
      if (!["clear", "hold"].includes(String(clip.endBehavior)) || !["replace", "add"].includes(String(clip.mixingMode))) throw new Error(`${label} has unsupported endBehavior or mixingMode.`);
      return;
    }
    case "property track": {
      const track = record(value, label, ["id", "target", "property", "clock", "enabled", "priority", "blendMode", "weight", "baseValue", "holdBefore", "holdAfter", "rotationMode", "keys"], ["id", "target", "property", "clock", "enabled", "priority", "blendMode", "weight", "holdBefore", "holdAfter", "keys"]);
      text(track.id, `${label}.id`); text(track.property, `${label}.property`); validateTarget(track.target, `${label}.target`); validateClock(track.clock, `${label}.clock`);
      bool(track.enabled, `${label}.enabled`); bool(track.holdBefore, `${label}.holdBefore`); bool(track.holdAfter, `${label}.holdAfter`);
      finite(track.priority, `${label}.priority`); finite(track.weight, `${label}.weight`);
      if (!["override", "additive"].includes(String(track.blendMode))) throw new Error(`${label}.blendMode is unsupported.`);
      if (track.rotationMode !== undefined && !["shortest", "continuous"].includes(String(track.rotationMode))) throw new Error(`${label}.rotationMode is unsupported.`);
      if (track.baseValue !== undefined) valueShape(track.baseValue, `${label}.baseValue`);
      if (!Array.isArray(track.keys)) throw new Error(`${label}.keys must be an array.`);
      for (const [index, item] of track.keys.entries()) {
        const keyLabel = `${label}.keys[${index}]`;
        const key = record(item, keyLabel, ["id", "time", "value", "interpolation", "inTangent", "outTangent"], ["id", "time", "value", "interpolation"]);
        text(key.id, `${keyLabel}.id`); finite(key.time, `${keyLabel}.time`); valueShape(key.value, `${keyLabel}.value`);
        if (!["step", "linear", "bezier"].includes(String(key.interpolation))) throw new Error(`${keyLabel}.interpolation is unsupported.`);
        for (const tangentField of ["inTangent", "outTangent"]) if (key[tangentField] !== undefined) {
          const tangent = record(key[tangentField], `${keyLabel}.${tangentField}`, ["time", "value"], ["time", "value"]);
          finite(tangent.time, `${keyLabel}.${tangentField}.time`); finite(tangent.value, `${keyLabel}.${tangentField}.value`);
        }
      }
      return;
    }
    case "audio clip": {
      const clip = record(value, label, ["id", "name", "path", "start", "end", "sourceOffset", "volume", "enabled", "sectionId"], ["id", "name", "path", "start", "end", "sourceOffset", "volume", "enabled"]);
      for (const field of ["id", "name", "path"]) text(clip[field], `${label}.${field}`, field === "name");
      for (const field of ["start", "end", "sourceOffset", "volume"]) finite(clip[field], `${label}.${field}`);
      bool(clip.enabled, `${label}.enabled`); if (clip.sectionId !== undefined) text(clip.sectionId, `${label}.sectionId`); return;
    }
    case "subtitle cue": {
      const cue = record(value, label, ["id", "start", "end", "enabled", "text", "sectionId"], ["id", "start", "end", "enabled", "text"]);
      text(cue.id, `${label}.id`); finite(cue.start, `${label}.start`); finite(cue.end, `${label}.end`); bool(cue.enabled, `${label}.enabled`);
      const translations = record(cue.text, `${label}.text`, ["en", "ja", "ko"], ["en", "ja", "ko"]);
      for (const language of ["en", "ja", "ko"]) text(translations[language], `${label}.text.${language}`, true);
      if (cue.sectionId !== undefined) text(cue.sectionId, `${label}.sectionId`); return;
    }
    case "color layer": {
      const layer = record(value, label, ["id", "name", "enabled", "locked", "opacity", "order", "blendMode", "clips"], ["id", "name", "enabled", "locked", "opacity", "order", "blendMode", "clips"]);
      text(layer.id, `${label}.id`); text(layer.name, `${label}.name`); bool(layer.enabled, `${label}.enabled`); bool(layer.locked, `${label}.locked`);
      finite(layer.opacity, `${label}.opacity`); finite(layer.order, `${label}.order`);
      if (!["normal", "multiply", "screen", "additive"].includes(String(layer.blendMode))) throw new Error(`${label}.blendMode is unsupported.`);
      if (!Array.isArray(layer.clips)) throw new Error(`${label}.clips must be an array.`);
      for (const [index, rawClip] of layer.clips.entries()) {
        const clipLabel = `${label}.clips[${index}]`;
        const clip = record(rawClip, clipLabel, ["id", "name", "start", "end", "color", "opacity", "fadeIn", "fadeOut", "enabled"], ["id", "name", "start", "end", "color", "opacity", "fadeIn", "fadeOut", "enabled"]);
        text(clip.id, `${clipLabel}.id`); text(clip.name, `${clipLabel}.name`); finite(clip.start, `${clipLabel}.start`); finite(clip.end, `${clipLabel}.end`);
        finite(clip.opacity, `${clipLabel}.opacity`); finite(clip.fadeIn, `${clipLabel}.fadeIn`); finite(clip.fadeOut, `${clipLabel}.fadeOut`); bool(clip.enabled, `${clipLabel}.enabled`);
        const color = record(clip.color, `${clipLabel}.color`, ["r", "g", "b", "a"], ["r", "g", "b", "a"]);
        for (const channel of ["r", "g", "b", "a"]) finite(color[channel], `${clipLabel}.color.${channel}`);
      }
      return;
    }
    default:
      throw new Error(`Unsupported composition entity kind: ${kind}`);
  }
}

/** Strictly parse the operation envelope crossing the Editor MCP bridge. */
export function normalizeCompositionEditOperation(value: unknown): CompositionEditOperation {
  const op = record(value, "Composition operation", ["kind", "duration", "section", "sectionId", "layer", "layerId", "property", "value", "binding", "clip", "clipId", "track", "trackId", "key", "keyId", "cue", "cueId", "camera"], ["kind"]);
  const kind = op.kind;
  const fieldsByKind: Record<string, { allowed: string[]; required: string[] }> = {
    set_duration: { allowed: ["kind", "duration"], required: ["duration"] },
    set_idle_section: { allowed: ["kind", "sectionId"], required: ["sectionId"] },
    set_entry_section: { allowed: ["kind", "sectionId"], required: ["sectionId"] },
    upsert_section: { allowed: ["kind", "section"], required: ["section"] }, remove_section: { allowed: ["kind", "sectionId"], required: ["sectionId"] },
    upsert_layer: { allowed: ["kind", "layer"], required: ["layer"] }, remove_layer: { allowed: ["kind", "layerId"], required: ["layerId"] },
    set_layer_base_property: { allowed: ["kind", "layerId", "property", "value"], required: ["layerId", "property", "value"] },
    set_animation_binding: { allowed: ["kind", "layerId", "binding"], required: ["layerId", "binding"] },
    upsert_animation_clip: { allowed: ["kind", "clip"], required: ["clip"] }, remove_animation_clip: { allowed: ["kind", "clipId"], required: ["clipId"] },
    upsert_property_track: { allowed: ["kind", "track"], required: ["track"] }, remove_property_track: { allowed: ["kind", "trackId"], required: ["trackId"] },
    upsert_keyframe: { allowed: ["kind", "trackId", "key"], required: ["trackId", "key"] }, remove_keyframe: { allowed: ["kind", "trackId", "keyId"], required: ["trackId", "keyId"] },
    upsert_audio_clip: { allowed: ["kind", "clip"], required: ["clip"] }, remove_audio_clip: { allowed: ["kind", "clipId"], required: ["clipId"] },
    upsert_subtitle_cue: { allowed: ["kind", "cue"], required: ["cue"] }, remove_subtitle_cue: { allowed: ["kind", "cueId"], required: ["cueId"] },
    upsert_color_layer: { allowed: ["kind", "layer"], required: ["layer"] }, remove_color_layer: { allowed: ["kind", "layerId"], required: ["layerId"] },
    set_camera: { allowed: ["kind", "camera"], required: ["camera"] },
  };
  const fieldSpec = typeof kind === "string" ? fieldsByKind[kind] : undefined;
  if (!fieldSpec) throw new Error(`Unsupported composition operation kind: ${String(kind)}`);
  record(value, `${String(kind)} operation`, fieldSpec.allowed, fieldSpec.required);
  const requireId = (field: string) => { text(op[field], `Composition operation ${field}`); return op[field] as string; };
  switch (kind) {
    case "set_duration":
      if (Object.keys(op).some((key) => !["kind", "duration"].includes(key)) || !("duration" in op)) throw new Error("set_duration requires only duration.");
      finite(op.duration, "duration"); return { kind, duration: op.duration as number };
    case "set_idle_section":
    case "set_entry_section":
      if (op.sectionId !== null) requireId("sectionId");
      return { kind, sectionId: op.sectionId as string | null };
    case "upsert_section":
      validateEntity("section", op.section, "section"); return { kind, section: structuredClone(op.section) as CompositionSection };
    case "remove_section": return { kind, sectionId: requireId("sectionId") };
    case "upsert_layer":
      validateEntity("layer", op.layer, "layer"); return { kind, layer: structuredClone(op.layer) as CompositionLayer };
    case "remove_layer": return { kind, layerId: requireId("layerId") };
    case "set_layer_base_property":
      requireId("layerId"); requireId("property"); valueShape(op.value, "value"); return { kind, layerId: op.layerId as string, property: op.property as string, value: structuredClone(op.value) as CompositionLayer["baseProperties"][string] };
    case "set_animation_binding": {
      requireId("layerId");
      if (op.binding !== null) {
        const binding = record(op.binding, "binding", ["sourceLayerId", "fallback"], ["sourceLayerId", "fallback"]);
        text(binding.sourceLayerId, "binding.sourceLayerId");
        if (!["authored-animation", "layer-base"].includes(String(binding.fallback))) throw new Error("binding.fallback is unsupported.");
      }
      return { kind, layerId: op.layerId as string, binding: structuredClone(op.binding) as CompositionLayer["animationBinding"] | null };
    }
    case "upsert_animation_clip":
      validateEntity("animation clip", op.clip, "clip"); return { kind, clip: structuredClone(op.clip) as CompositionAnimationClip };
    case "remove_animation_clip": return { kind, clipId: requireId("clipId") };
    case "upsert_property_track":
      validateEntity("property track", op.track, "track"); return { kind, track: structuredClone(op.track) as CompositionPropertyTrack };
    case "remove_property_track": return { kind, trackId: requireId("trackId") };
    case "upsert_keyframe": {
      requireId("trackId");
      const key = record(op.key, "key", ["id", "time", "value", "interpolation", "inTangent", "outTangent"], ["id", "time", "value", "interpolation"]);
      validateEntity("property track", { id: "validation-track", target: { kind: "camera" }, property: "camera.centerX", clock: { kind: "composition" }, enabled: true, priority: 0, blendMode: "override", weight: 1, holdBefore: false, holdAfter: false, keys: [key] }, "keyframe track");
      return { kind, trackId: op.trackId as string, key: structuredClone(key) as unknown as CompositionKeyframe };
    }
    case "remove_keyframe": return { kind, trackId: requireId("trackId"), keyId: requireId("keyId") };
    case "upsert_audio_clip":
      validateEntity("audio clip", op.clip, "clip"); return { kind, clip: structuredClone(op.clip) as CompositionAudioClip };
    case "remove_audio_clip": return { kind, clipId: requireId("clipId") };
    case "upsert_subtitle_cue":
      validateEntity("subtitle cue", op.cue, "cue"); return { kind, cue: structuredClone(op.cue) as CompositionSubtitleCue };
    case "remove_subtitle_cue": return { kind, cueId: requireId("cueId") };
    case "upsert_color_layer":
      validateEntity("color layer", op.layer, "layer"); return { kind, layer: structuredClone(op.layer) as CompositionColorLayer };
    case "remove_color_layer": return { kind, layerId: requireId("layerId") };
    case "set_camera": {
      if (op.camera === null) return { kind, camera: null };
      const camera = normalizeSpineCameraTrack(op.camera);
      if (!camera) throw new Error("camera must be a valid camera track or null.");
      return { kind, camera };
    }
    default:
      throw new Error(`Unsupported composition operation kind: ${String(kind)}`);
  }
}

function upsertById<T extends { id: string }>(items: readonly T[], value: T): { items: T[]; created: boolean } {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return { items: [...items, structuredClone(value)], created: true };
  const next = [...items];
  next[index] = structuredClone(value);
  return { items: next, created: false };
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
}

function requireUnlocked(composition: SpineComposition, layerId: string): void {
  const layer = composition.layers.find((item) => item.id === layerId);
  if (layer?.locked) throw new Error(`Composition layer is locked: ${layerId}`);
}

function operationLayerId(composition: SpineComposition, operation: CompositionEditOperation): string | null {
  switch (operation.kind) {
    case "upsert_layer":
      return operation.layer.id;
    case "remove_layer":
    case "set_layer_base_property":
    case "set_animation_binding":
      return operation.layerId;
    case "upsert_animation_clip":
      return operation.clip.layerId;
    case "remove_animation_clip":
      return composition.animationClips.find((clip) => clip.id === operation.clipId)?.layerId ?? null;
    case "upsert_property_track": {
      const target = operation.track.target;
      return target.kind === "layer" || target.kind === "bone" || target.kind === "constraint" || target.kind === "slot"
        ? target.layerId
        : target.kind === "clip"
          ? composition.animationClips.find((clip) => clip.id === target.clipId)?.layerId ?? null
          : null;
    }
    case "remove_property_track": {
      const track = composition.propertyTracks.find((item) => item.id === operation.trackId);
      if (!track) return null;
      const target = track.target;
      return target.kind === "layer" || target.kind === "bone" || target.kind === "constraint" || target.kind === "slot"
        ? target.layerId
        : target.kind === "clip" ? composition.animationClips.find((clip) => clip.id === target.clipId)?.layerId ?? null : null;
    }
    case "upsert_keyframe": {
      const track = composition.propertyTracks.find((item) => item.id === operation.trackId);
      if (!track) return null;
      if (track.target.kind === "layer" || track.target.kind === "bone" || track.target.kind === "constraint" || track.target.kind === "slot") return track.target.layerId;
      const target = track.target;
      return target.kind === "clip" ? composition.animationClips.find((clip) => clip.id === target.clipId)?.layerId ?? null : null;
    }
    case "remove_keyframe": {
      const track = composition.propertyTracks.find((item) => item.id === operation.trackId);
      if (!track) return null;
      const target = track.target;
      return target.kind === "layer" || target.kind === "bone" || target.kind === "constraint" || target.kind === "slot"
        ? target.layerId
        : target.kind === "clip" ? composition.animationClips.find((clip) => clip.id === target.clipId)?.layerId ?? null : null;
    }
    default:
      return null;
  }
}

/** Apply typed composition operations as one validated, immutable project edit. */
export function applyCompositionEdits(
  original: SpineComposition,
  operations: readonly CompositionEditOperation[],
): CompositionEditResult {
  if (operations.length === 0) throw new Error("At least one composition operation is required.");
  let composition = structuredClone(original);
  const affected = new Set<string>();
  const created = new Set<string>();

  for (const operation of operations) {
    const layerId = operationLayerId(composition, operation);
    if (layerId) requireUnlocked(composition, layerId);
    switch (operation.kind) {
      case "set_duration":
        if (!Number.isFinite(operation.duration) || operation.duration <= 0) throw new Error("Composition duration must be a positive finite number.");
        composition.duration = operation.duration;
        affected.add(composition.id);
        break;
      case "set_idle_section":
        composition.idleSectionId = operation.sectionId;
        affected.add(composition.id);
        if (operation.sectionId) affected.add(operation.sectionId);
        break;
      case "set_entry_section":
        composition.entrySectionId = operation.sectionId;
        affected.add(composition.id);
        if (operation.sectionId) affected.add(operation.sectionId);
        break;
      case "upsert_section": {
        requireText(operation.section.id, "Section ID");
        requireText(operation.section.name, "Section name");
        const result = upsertById(composition.sections, operation.section);
        composition.sections = result.items;
        affected.add(operation.section.id);
        if (result.created) created.add(operation.section.id);
        break;
      }
      case "remove_section":
        if (!composition.sections.some((item) => item.id === operation.sectionId)) throw new Error(`Composition section not found: ${operation.sectionId}`);
        composition.sections = composition.sections.filter((item) => item.id !== operation.sectionId);
        affected.add(operation.sectionId);
        break;
      case "upsert_layer": {
        requireText(operation.layer.id, "Layer ID");
        requireText(operation.layer.assetDirectory, "Layer asset directory");
        const existing = composition.layers.find((item) => item.id === operation.layer.id);
        if (existing?.locked) throw new Error(`Composition layer is locked: ${operation.layer.id}`);
        const result = upsertById(composition.layers, operation.layer);
        composition.layers = result.items;
        affected.add(operation.layer.id);
        if (result.created) created.add(operation.layer.id);
        break;
      }
      case "remove_layer":
        if (!composition.layers.some((item) => item.id === operation.layerId)) throw new Error(`Composition layer not found: ${operation.layerId}`);
        composition.layers = composition.layers.filter((item) => item.id !== operation.layerId);
        affected.add(operation.layerId);
        break;
      case "set_layer_base_property": {
        requireText(operation.property, "Property ID");
        const definition = compositionPropertyDefinition(operation.property);
        if (!definition || !definition.targetKinds.includes("layer")) throw new Error(`Unsupported layer base property: ${operation.property}`);
        const layer = composition.layers.find((item) => item.id === operation.layerId);
        if (!layer) throw new Error(`Composition layer not found: ${operation.layerId}`);
        layer.baseProperties = { ...layer.baseProperties, [operation.property]: structuredClone(operation.value) };
        affected.add(operation.layerId);
        break;
      }
      case "set_animation_binding": {
        const layer = composition.layers.find((item) => item.id === operation.layerId);
        if (!layer) throw new Error(`Composition layer not found: ${operation.layerId}`);
        if (operation.binding) layer.animationBinding = structuredClone(operation.binding);
        else delete layer.animationBinding;
        affected.add(operation.layerId);
        break;
      }
      case "upsert_animation_clip": {
        requireText(operation.clip.id, "Animation clip ID");
        requireText(operation.clip.animation, "Animation name");
        const result = upsertById(composition.animationClips, operation.clip);
        composition.animationClips = result.items;
        affected.add(operation.clip.id);
        affected.add(operation.clip.layerId);
        if (result.created) created.add(operation.clip.id);
        break;
      }
      case "remove_animation_clip":
        if (!composition.animationClips.some((item) => item.id === operation.clipId)) throw new Error(`Composition animation clip not found: ${operation.clipId}`);
        composition.animationClips = composition.animationClips.filter((item) => item.id !== operation.clipId);
        affected.add(operation.clipId);
        break;
      case "upsert_property_track": {
        requireText(operation.track.id, "Property track ID");
        requireText(operation.track.property, "Property ID");
        const definition = compositionPropertyDefinition(operation.track.property);
        if (!definition || !definition.targetKinds.includes(operation.track.target.kind)) throw new Error(`Unsupported composition property/target pair: ${operation.track.property}/${operation.track.target.kind}`);
        const result = upsertById(composition.propertyTracks, operation.track);
        composition.propertyTracks = result.items;
        affected.add(operation.track.id);
        if (layerId) affected.add(layerId);
        if (result.created) created.add(operation.track.id);
        break;
      }
      case "remove_property_track":
        if (!composition.propertyTracks.some((item) => item.id === operation.trackId)) throw new Error(`Composition property track not found: ${operation.trackId}`);
        if (!compositionPropertyDefinition(composition.propertyTracks.find((item) => item.id === operation.trackId)!.property)) throw new Error(`Cannot edit unsupported composition property track: ${operation.trackId}`);
        composition.propertyTracks = composition.propertyTracks.filter((item) => item.id !== operation.trackId);
        affected.add(operation.trackId);
        break;
      case "upsert_keyframe": {
        const track = composition.propertyTracks.find((item) => item.id === operation.trackId);
        if (!track) throw new Error(`Composition property track not found: ${operation.trackId}`);
        if (!compositionPropertyDefinition(track.property)) throw new Error(`Cannot edit unsupported composition property track: ${operation.trackId}`);
        requireText(operation.key.id, "Keyframe ID");
        const result = upsertById(track.keys, operation.key);
        track.keys = result.items;
        affected.add(operation.trackId);
        affected.add(operation.key.id);
        if (result.created) created.add(operation.key.id);
        break;
      }
      case "remove_keyframe": {
        const track = composition.propertyTracks.find((item) => item.id === operation.trackId);
        if (!track) throw new Error(`Composition property track not found: ${operation.trackId}`);
        if (!compositionPropertyDefinition(track.property)) throw new Error(`Cannot edit unsupported composition property track: ${operation.trackId}`);
        if (!track.keys.some((item) => item.id === operation.keyId)) throw new Error(`Composition keyframe not found: ${operation.keyId}`);
        track.keys = track.keys.filter((item) => item.id !== operation.keyId);
        affected.add(operation.trackId);
        affected.add(operation.keyId);
        break;
      }
      case "upsert_audio_clip": {
        requireText(operation.clip.id, "Audio clip ID");
        requireText(operation.clip.path, "Audio path");
        const result = upsertById(composition.audio, operation.clip);
        composition.audio = result.items;
        affected.add(operation.clip.id);
        if (result.created) created.add(operation.clip.id);
        break;
      }
      case "remove_audio_clip":
        if (!composition.audio.some((item) => item.id === operation.clipId)) throw new Error(`Composition audio clip not found: ${operation.clipId}`);
        composition.audio = composition.audio.filter((item) => item.id !== operation.clipId);
        affected.add(operation.clipId);
        break;
      case "upsert_subtitle_cue": {
        requireText(operation.cue.id, "Subtitle cue ID");
        const result = upsertById(composition.subtitles, operation.cue);
        composition.subtitles = result.items;
        affected.add(operation.cue.id);
        if (result.created) created.add(operation.cue.id);
        break;
      }
      case "remove_subtitle_cue":
        if (!composition.subtitles.some((item) => item.id === operation.cueId)) throw new Error(`Composition subtitle cue not found: ${operation.cueId}`);
        composition.subtitles = composition.subtitles.filter((item) => item.id !== operation.cueId);
        affected.add(operation.cueId);
        break;
      case "upsert_color_layer": {
        requireText(operation.layer.id, "Color layer ID");
        if (composition.colorLayers.find((item) => item.id === operation.layer.id)?.locked) throw new Error(`Composition color layer is locked: ${operation.layer.id}`);
        const result = upsertById(composition.colorLayers, operation.layer);
        composition.colorLayers = result.items;
        affected.add(operation.layer.id);
        if (result.created) created.add(operation.layer.id);
        break;
      }
      case "remove_color_layer": {
        const layer = composition.colorLayers.find((item) => item.id === operation.layerId);
        if (!layer) throw new Error(`Composition color layer not found: ${operation.layerId}`);
        if (layer.locked) throw new Error(`Composition color layer is locked: ${operation.layerId}`);
        composition.colorLayers = composition.colorLayers.filter((item) => item.id !== operation.layerId);
        affected.add(operation.layerId);
        break;
      }
      case "set_camera":
        if (operation.camera) composition.camera = structuredClone(operation.camera);
        else delete composition.camera;
        affected.add(composition.id);
        break;
    }
  }

  const diagnostics = validateComposition(composition);
  const errors = diagnostics.filter((item) => item.severity === "error");
  if (errors.length) throw new Error(`Composition edit is invalid: ${errors.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
  return {
    composition,
    affectedEntityIds: [...affected],
    createdEntityIds: [...created],
    warnings: diagnostics.filter((item) => item.severity === "warning").map((item) => `${item.code}: ${item.message}`),
  };
}
