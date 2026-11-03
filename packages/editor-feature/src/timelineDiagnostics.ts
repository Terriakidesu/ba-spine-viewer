import type { EditorTimeline, TimelineLanguage } from "./editorModel";
import { SPINE_MANIFEST_SCHEMA_VERSION } from "@ba-spine/spine-runtime/spine/spineManifest";

export type TimelineDiagnosticKind =
  | "missing-layer"
  | "missing-files"
  | "missing-animation"
  | "unsupported-version"
  | "invalid-range"
  | "timeline-bounds"
  | "subtitle-bounds"
  | "subtitle-overlap"
  | "subtitle-duplicate"
  | "missing-translation"
  | "missing-audio"
  | "missing-subtitle-link";

export type TimelineDiagnosticTarget = {
  kind: "layer" | "animation" | "color-layer" | "color" | "cue" | "audio";
  id: string;
};

export interface TimelineDiagnostic {
  id: string;
  kind: TimelineDiagnosticKind;
  message: string;
  target?: TimelineDiagnosticTarget;
}

export interface TimelineDiagnosticContext {
  availableDirectories: readonly string[];
  animationsByLayer?: Readonly<Record<string, readonly string[]>>;
  duration?: number;
  layerLoadErrors?: Readonly<Record<string, string>>;
  manifestSchemaVersionsByLayer?: Readonly<Record<string, number>>;
  missingAudioPaths?: readonly string[];
}

/** Compare manifest references with already-loaded basename-keyed Spine files. */
export function missingManifestAssetFiles(
  references: readonly { path: string }[],
  loadedFileNames: readonly string[],
): string[] {
  const loadedNames = new Set(loadedFileNames.map((name) => name.replaceAll("\\", "/").split("/").at(-1)?.toLocaleLowerCase() ?? ""));
  return references.flatMap(({ path }) => {
    const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLocaleLowerCase() ?? "";
    return name && loadedNames.has(name) ? [] : [path];
  });
}

const LANGUAGES: readonly TimelineLanguage[] = ["en", "ja", "ko"];
const MIN_RANGE_SECONDS = 0.01;
const TIME_EPSILON = 0.001;

function validRange(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start + MIN_RANGE_SECONDS;
}

function animationKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function subtitleTextKey(text: Record<TimelineLanguage, string>): string {
  return LANGUAGES.map((language) => text[language].normalize("NFKC").trim().toLowerCase()).join("\u0000");
}

/** Inspect the active sequence without reading or mutating project files. */
export function validateTimeline(
  timeline: EditorTimeline,
  context: TimelineDiagnosticContext,
): TimelineDiagnostic[] {
  const diagnostics: TimelineDiagnostic[] = [];
  const availableDirectories = new Set(context.availableDirectories);
  const missingAudioPaths = new Set(context.missingAudioPaths ?? []);
  const animationsByLayer = new Map(Object.entries(context.animationsByLayer ?? {})
    .map(([id, names]) => [id, new Set(names.map(animationKey))] as const));
  const subtitleTextKeys = timeline.subtitles.map((cue) => subtitleTextKey(cue.text));
  const subtitleHasText = timeline.subtitles.map((cue) => LANGUAGES.some((language) => cue.text[language].trim().length > 0));
  const diagnosedDuplicateIndexes = new Set<number>();
  const duration = context.duration ?? timeline.duration;

  if (!Number.isFinite(duration) || duration <= 0) {
    diagnostics.push({
      id: "timeline:duration",
      kind: "invalid-range",
      message: "Sequence duration must be a positive finite value.",
    });
  }

  const checkRange = (
    id: string,
    label: string,
    start: number,
    end: number,
    target: TimelineDiagnosticTarget,
    boundsKind: "timeline-bounds" | "subtitle-bounds" = "timeline-bounds",
  ) => {
    if (!validRange(start, end)) {
      diagnostics.push({ id, kind: "invalid-range", message: `${label} must have a non-negative start and an end at least 0.01 seconds later.`, target });
      return;
    }
    if (Number.isFinite(duration) && end > duration + TIME_EPSILON) {
      diagnostics.push({ id: `${id}:bounds`, kind: boundsKind, message: `${label} ends at ${end.toFixed(3)}s, past the ${duration.toFixed(3)}s sequence duration.`, target });
    }
  };

  const checkAnimation = (layerId: string, layerName: string, value: string | undefined, target: TimelineDiagnosticTarget) => {
    const name = value?.trim();
    const known = animationsByLayer.get(layerId);
    if (!name || name === "__intro__" || !known) return;
    if (!known.has(animationKey(name))) {
      diagnostics.push({ id: `animation:${layerId}:${target.kind}:${target.id}:${name}`, kind: "missing-animation", message: `${layerName} references animation “${name}”, which is not present in its Spine asset.`, target });
    }
  };

  for (const layer of timeline.layers) {
    const target: TimelineDiagnosticTarget = { kind: "layer", id: layer.id };
    if (!timeline.assetPaths?.[layer.directory] && !availableDirectories.has(layer.directory)) {
      diagnostics.push({ id: `layer:${layer.id}:directory`, kind: "missing-layer", message: `${layer.name} references unavailable Spine directory “${layer.directory}”.`, target });
    }
    const loadError = context.layerLoadErrors?.[layer.id];
    if (loadError) {
      diagnostics.push({ id: `layer:${layer.id}:files`, kind: "missing-files", message: `${layer.name} could not load its manifest or Spine files: ${loadError}`, target });
    }
    const manifestVersion = context.manifestSchemaVersionsByLayer?.[layer.id];
    if (manifestVersion !== undefined && manifestVersion > SPINE_MANIFEST_SCHEMA_VERSION) {
      diagnostics.push({ id: `layer:${layer.id}:manifest-version`, kind: "unsupported-version", message: `${layer.name} uses manifest schema v${manifestVersion}; this Editor supports v${SPINE_MANIFEST_SCHEMA_VERSION}.`, target });
    }
    checkRange(`layer:${layer.id}:range`, layer.name, layer.start, layer.end, target);
    checkAnimation(layer.id, layer.name, layer.animation, target);
    checkAnimation(layer.id, layer.name, layer.faceAnimation, target);

    for (const clip of layer.animationClips ?? []) {
      const clipTarget: TimelineDiagnosticTarget = { kind: "animation", id: clip.id };
      const clipName = `${layer.name} / ${clip.animation || "Auto animation"}`;
      checkRange(`animation:${clip.id}:range`, clipName, clip.start, clip.end, clipTarget);
      checkAnimation(layer.id, layer.name, clip.animation, clipTarget);
      checkAnimation(layer.id, layer.name, clip.faceAnimation, clipTarget);
    }
  }

  for (const layer of timeline.colorLayers) {
    const target: TimelineDiagnosticTarget = { kind: "color-layer", id: layer.id };
    for (const clip of layer.clips) {
      checkRange(`color:${clip.id}:range`, `${layer.name} / ${clip.name}`, clip.start, clip.end, { kind: "color", id: clip.id });
    }
  }

  const cueIds = new Set(timeline.subtitles.map((cue) => cue.id));
  for (const [index, cue] of timeline.subtitles.entries()) {
    const target: TimelineDiagnosticTarget = { kind: "cue", id: cue.id };
    const label = `Subtitle #${index + 1}`;
    checkRange(`subtitle:${cue.id}:range`, label, cue.start, cue.end, target, "subtitle-bounds");
    if (!cue.enabled) continue;

    const cueTextKey = subtitleTextKeys[index]!;
    const hasAnyText = subtitleHasText[index]!;
    const currentText = cue.text[timeline.language].trim();
    const hasAlternate = LANGUAGES.some((language) => language !== timeline.language && cue.text[language].trim().length > 0);
    if (!currentText && hasAlternate) {
      diagnostics.push({ id: `subtitle:${cue.id}:translation:${timeline.language}`, kind: "missing-translation", message: `${label} has no ${timeline.language.toUpperCase()} translation; playback will fall back to another language.`, target });
    }

    for (let otherIndex = index + 1; otherIndex < timeline.subtitles.length; otherIndex += 1) {
      const other = timeline.subtitles[otherIndex]!;
      if (!other.enabled || !validRange(cue.start, cue.end) || !validRange(other.start, other.end) || cue.start >= other.end || cue.end <= other.start) continue;
      if (hasAnyText && subtitleHasText[otherIndex] && Math.abs(cue.start - other.start) <= TIME_EPSILON
        && cueTextKey === subtitleTextKeys[otherIndex]) {
        if (!diagnosedDuplicateIndexes.has(otherIndex)) {
          diagnostics.push({
            id: `subtitle:${other.id}:duplicate:${cue.id}`,
            kind: "subtitle-duplicate",
            message: `Subtitle #${otherIndex + 1} has the same translations and start time as ${label}.`,
            target: { kind: "cue", id: other.id },
          });
          diagnosedDuplicateIndexes.add(otherIndex);
        }
        continue;
      }
      diagnostics.push({
        id: `subtitle:${cue.id}:overlap:${other.id}`,
        kind: "subtitle-overlap",
        message: `${label} overlaps Subtitle #${otherIndex + 1}.`,
        target,
      });
    }
  }

  for (const clip of timeline.audio) {
    const target: TimelineDiagnosticTarget = { kind: "audio", id: clip.id };
    checkRange(`audio:${clip.id}:range`, `Audio “${clip.name}”`, clip.start, clip.end, target);
    if (clip.enabled && missingAudioPaths.has(clip.path)) {
      diagnostics.push({ id: `audio:${clip.id}:missing`, kind: "missing-audio", message: `Audio file “${clip.path}” is missing or could not be decoded.`, target });
    }
    if (clip.subtitleId && !cueIds.has(clip.subtitleId)) {
      diagnostics.push({ id: `audio:${clip.id}:subtitle`, kind: "missing-subtitle-link", message: `Audio “${clip.name}” links to a subtitle cue that no longer exists.`, target });
    }
  }

  return diagnostics;
}
