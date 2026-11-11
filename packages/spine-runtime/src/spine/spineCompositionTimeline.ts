import type { EvaluatedCompositionFrame, SpineComposition } from "./spineComposition";
import { compositionTargetKey } from "./spineComposition";
import type { SpineTimeline, SpineTimelineLayer } from "./spineTimeline";

function linearToSrgb(channel: number): number {
  const linear = Math.max(0, Math.min(1, channel));
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function compositionColorHex(color: { r: number; g: number; b: number }): string {
  const hex = (value: number) => Math.round(linearToSrgb(value) * 255).toString(16).padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`.toUpperCase();
}

/** Adapt evaluated canonical data to the renderer's established scene surface. */
export function compositionFrameToTimeline(
  composition: SpineComposition,
  frame: EvaluatedCompositionFrame,
  time: number,
  language: SpineTimeline["language"],
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
    return {
      id: clip.id,
      name: clip.name,
      path: clip.path,
      start: clip.start,
      end: clip.end,
      sourceOffset: clip.sourceOffset,
      enabled: clip.enabled,
      volume: typeof volume === "number" ? volume : clip.volume,
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
    subtitles: composition.subtitles.map((cue) => ({ ...cue, text: { ...cue.text } })),
    audio,
    language,
    ...(composition.camera ? { camera: composition.camera } : {}),
  };
}
