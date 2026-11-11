import type { EvaluatedCompositionFrame, SpineComposition } from "./spineComposition";
import { compositionTargetKey } from "./spineComposition";
import { sampleSpineCameraTrack, type SpineCameraTrack } from "./spineCameraMotion";
import type { SpineCameraFrame } from "./spineRuntime";
import type { SpineTimeline, SpineTimelineLayer } from "./spineTimeline";

function linearToSrgb(channel: number): number {
  const linear = Math.max(0, Math.min(1, channel));
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function compositionColorHex(color: { r: number; g: number; b: number }): string {
  const hex = (value: number) => Math.round(linearToSrgb(value) * 255).toString(16).padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`.toUpperCase();
}

/** Apply evaluated camera property tracks at one sample without mutating authored camera keys. */
export function compositionCameraTrackAt(
  composition: SpineComposition,
  frame: EvaluatedCompositionFrame,
  time: number,
  fallback: SpineCameraTrack | null = composition.camera ?? null,
  artworkFrame: SpineCameraFrame | null = null,
): SpineCameraTrack | null {
  if (!Number.isFinite(time)) return fallback;
  const properties = new Set(["camera.centerX", "camera.centerY", "camera.frameHeight"]);
  const contributions = frame.evaluation.propertyContributions.filter((item) => item.target.kind === "camera" && properties.has(item.property));
  if (contributions.length === 0) return fallback;

  const authored = fallback ?? {
    enabled: true,
    aspectRatio: "16:9" as const,
    constraint: { mode: "automatic" as const },
    safeBounds: [],
    keyframes: [],
  };
  const sampleTrack = authored.keyframes.length
    ? sampleSpineCameraTrack({ ...authored, enabled: true }, time)
    : null;
  const firstKey = authored.keyframes[0];
  const values = new Map<string, number>([
    ["camera.centerX", sampleTrack?.centerX ?? firstKey?.centerX ?? artworkFrame?.centerX ?? 0],
    ["camera.centerY", sampleTrack?.centerY ?? firstKey?.centerY ?? artworkFrame?.centerY ?? 0],
    ["camera.frameHeight", sampleTrack?.frameHeight ?? firstKey?.frameHeight ?? artworkFrame?.height ?? 1],
  ]);
  for (const contribution of contributions) {
    if (typeof contribution.value !== "number" || !Number.isFinite(contribution.value)) continue;
    const base = values.get(contribution.property);
    if (base === undefined) continue;
    const weight = Math.max(0, Math.min(1, contribution.weight));
    const value = contribution.blendMode === "additive"
      ? contribution.property === "camera.frameHeight"
        ? base * (1 + (contribution.value - 1) * weight)
        : base + contribution.value * weight
      : base + (contribution.value - base) * weight;
    values.set(contribution.property, value);
  }
  const keyframe = {
    id: "__composition-evaluated-camera__",
    time,
    centerX: values.get("camera.centerX")!,
    centerY: values.get("camera.centerY")!,
    frameHeight: values.get("camera.frameHeight")!,
    easing: "linear" as const,
    ...(sampleTrack?.constraint ? { constraint: sampleTrack.constraint } : {}),
  };
  return {
    ...authored,
    keyframes: [...authored.keyframes.filter((item) => Math.abs(item.time - time) > 1e-6), keyframe]
      .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id)),
  };
}

/** Adapt evaluated canonical data to the renderer's established scene surface. */
export function compositionFrameToTimeline(
  composition: SpineComposition,
  frame: EvaluatedCompositionFrame,
  time: number,
  language: SpineTimeline["language"],
  sectionInstanceStartTimes: Readonly<Record<string, number>> = {},
  activeSectionId?: string,
  globalTimeOffset = 0,
): SpineTimeline {
  const layers: SpineTimelineLayer[] = frame.layers.map((layerFrame) => {
    const layer = layerFrame.layer;
    const selected = layerFrame.animationClips.at(-1);
    const animation = selected?.clip.animation
      ?? (typeof layer.baseProperties["animation.selection"] === "string" ? layer.baseProperties["animation.selection"] : "");
    return {
      id: layer.id,
      name: layer.name,
      role: layer.role === "scene" || layer.role === "background" || layer.role === "character" ? layer.role : "overlay",
      directory: layer.assetDirectory,
      enabled: layer.enabled,
      locked: layer.locked,
      blendMode: layerFrame.blendMode,
      animation,
      ...(selected?.clip.faceAnimation ? { faceAnimation: selected.clip.faceAnimation } : {}),
      animationClips: layerFrame.animationClips.map(({ clip, sourceTime }) => ({
        id: clip.id,
        animation: clip.animation,
        ...(clip.faceAnimation ? { faceAnimation: clip.faceAnimation } : {}),
        start: time,
        end: Math.max(time + 0.01, composition.duration),
        animationOffset: sourceTime,
        loop: clip.loop,
        enabled: true,
      })),
      followMainAnimation: false,
      start: 0,
      end: composition.duration,
      endMode: "manual",
      animationOffset: selected?.sourceTime ?? 0,
      loop: selected?.clip.loop ?? false,
      x: layerFrame.transform.x,
      y: layerFrame.transform.y,
      rotation: layerFrame.transform.rotation,
      scale: layerFrame.transform.scaleX,
      opacity: layerFrame.transform.opacity,
      order: layer.order,
    };
  });
  const colorLayers: NonNullable<SpineTimeline["colorLayers"]> = composition.colorLayers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    enabled: layer.enabled,
    locked: layer.locked,
    opacity: 1,
    order: layer.order,
    blendMode: layer.blendMode,
    clips: frame.evaluation.activeColorClips.filter((active) => active.layer.id === layer.id).map(({ clip, color, opacity }) => ({
      id: clip.id,
      name: clip.name,
      color: compositionColorHex(color),
      start: time,
      end: Math.max(time + 0.01, composition.duration),
      opacity: opacity * color.a,
      fadeIn: 0,
      fadeOut: 0,
      enabled: true,
    })),
  }));
  const audio = composition.audio.map((clip) => {
    const volume = frame.evaluation.properties.get(compositionTargetKey({ kind: "audio", audioId: clip.id }, "audio.volume"));
    const isActive = frame.evaluation.activeAudio.some((active) => active.id === clip.id);
    const sectionStart = clip.sectionId
      ? sectionInstanceStartTimes[clip.sectionId] ?? composition.sections.find((section) => section.id === clip.sectionId)?.start ?? 0
      : undefined;
    return {
      id: clip.id,
      name: clip.name,
      path: clip.path,
      start: sectionStart === undefined ? clip.start + globalTimeOffset : sectionStart + clip.start,
      end: sectionStart === undefined ? clip.end + globalTimeOffset : sectionStart + clip.end,
      sourceOffset: clip.sourceOffset,
      enabled: clip.enabled && (!activeSectionId || !clip.sectionId || clip.sectionId === activeSectionId && isActive),
      volume: typeof volume === "number" ? volume : clip.volume,
    };
  });
  const subtitles = composition.subtitles.map((cue) => {
    const isActive = frame.evaluation.activeSubtitles.some((active) => active.id === cue.id);
    const sectionStart = cue.sectionId
      ? sectionInstanceStartTimes[cue.sectionId] ?? composition.sections.find((section) => section.id === cue.sectionId)?.start ?? 0
      : undefined;
    return {
      ...cue,
      start: sectionStart === undefined ? cue.start + globalTimeOffset : sectionStart + cue.start,
      end: sectionStart === undefined ? cue.end + globalTimeOffset : sectionStart + cue.end,
      enabled: cue.enabled && (!activeSectionId || !cue.sectionId || cue.sectionId === activeSectionId && isActive),
      text: { ...cue.text },
    };
  });
  return {
    sequenceId: "unified-composition",
    openingMode: "direct",
    sceneDuration: 0,
    openingIdleDuration: 0,
    durationMode: "manual",
    duration: composition.duration,
    loop: false,
    layers,
    colorLayers,
    subtitles,
    audio,
    language,
    ...(composition.camera ? { camera: composition.camera } : {}),
  };
}
