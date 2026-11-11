import { normalizeSpineInteractionProject, type SpineInteractionProject } from "./spineInteraction";
import { manifestReferenceCandidates, type SpineManifestRecord, type SpineManifestPath } from "./spineManifest";
import { hasLegacySquareCameraAspectRatio } from "./spineCameraMotion";

export interface SpineProjectSource {
  getFile: (path: string) => Promise<File | null>;
  getManifest?: (directory: string) => Promise<SpineManifestRecord | null>;
}

export interface SpineManifestProjectData {
  record: SpineManifestRecord;
  interactions: unknown;
  sequences: Record<string, unknown>;
  workspace: Record<string, unknown> | null;
}

function safeName(directory: string): string {
  return directory.replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
}

export function editorProjectPath(directory: string): string {
  return `.editor/${safeName(directory)}.spine-project.json`;
}

export function legacyEditorProjectPath(directory: string): string {
  return `.shittim-spine-editor/${safeName(directory)}.spine-project.json`;
}

export function editorProjectPaths(directory: string): string[] {
  return [editorProjectPath(directory), legacyEditorProjectPath(directory)];
}

async function readManifestReference(source: SpineProjectSource, record: SpineManifestRecord, reference: SpineManifestPath | undefined): Promise<unknown | null> {
  if (!reference) return null;
  for (const path of manifestReferenceCandidates(record, reference)) {
    const file = await source.getFile(path);
    if (!file) continue;
    try {
      return JSON.parse(await file.text()) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/** Read the explicit manifest files shared by the browser viewer and native editor. */
export async function readManifestProjectData(source: SpineProjectSource, directory: string): Promise<SpineManifestProjectData | null> {
  const record = await source.getManifest?.(directory);
  if (!record || !record.manifest.sequences || Object.keys(record.manifest.sequences).length === 0) return null;
  const interactions = await readManifestReference(source, record, record.manifest.interactions);
  const sequences: Record<string, unknown> = {};
  for (const [id, reference] of Object.entries(record.manifest.sequences)) {
    const value = await readManifestReference(source, record, reference);
    if (value !== null) sequences[id] = value;
  }
  let workspace: Record<string, unknown> | null = null;
  const workspaceValue = await readManifestReference(source, record, record.manifest.workspace);
  if (workspaceValue && typeof workspaceValue === "object" && !Array.isArray(workspaceValue)) workspace = workspaceValue as Record<string, unknown>;
  return { record, interactions, sequences, workspace };
}

export function manifestProjectValue(data: SpineManifestProjectData, directory: string): Record<string, unknown> {
  const rawInteractions = data.interactions && typeof data.interactions === "object" && !Array.isArray(data.interactions)
    ? data.interactions as Record<string, unknown>
    : {};
  const workspace = data.workspace ?? {};
  const manifestSubtitlePath = data.record.manifest.subtitles
    ? manifestReferenceCandidates(data.record, data.record.manifest.subtitles)[0]
    : undefined;
  const sequences = Object.fromEntries(Object.entries(data.sequences).map(([id, value]) => [
    id,
    manifestSubtitlePath && value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), subtitlePath: manifestSubtitlePath }
      : value,
  ]));
  const sequenceIds = Object.keys(sequences);
  const requested = typeof workspace.selectedSequenceId === "string" ? workspace.selectedSequenceId : "";
  const activeId = requested && sequences[requested] !== undefined
    ? requested
    : data.record.manifest.entrySequence && sequences[data.record.manifest.entrySequence] !== undefined
      ? data.record.manifest.entrySequence
      : sequenceIds[0];
  const active = activeId ? sequences[activeId] : undefined;
  const workspaceState = {
    ...(typeof workspace.name === "string" ? { name: workspace.name } : {}),
    ...(typeof workspace.selectedInteractionId === "string" || workspace.selectedInteractionId === null ? { selectedInteractionId: workspace.selectedInteractionId } : {}),
    ...(typeof workspace.selectedRegionId === "string" || workspace.selectedRegionId === null ? { selectedRegionId: workspace.selectedRegionId } : {}),
    ...(typeof workspace.selectedBonePath === "string" || workspace.selectedBonePath === null ? { selectedBonePath: workspace.selectedBonePath } : {}),
    ...(typeof workspace.showBones === "boolean" ? { showBones: workspace.showBones } : {}),
    ...(typeof workspace.showBoneNames === "boolean" ? { showBoneNames: workspace.showBoneNames } : {}),
    ...(typeof workspace.showConstraints === "boolean" ? { showConstraints: workspace.showConstraints } : {}),
    ...(typeof workspace.showInactiveBones === "boolean" ? { showInactiveBones: workspace.showInactiveBones } : {}),
  };
  return {
    // Older workspaces predate the one-time Talk duration migration. Treat
    // them as the previous editor schema until the editor saves the project.
    schemaVersion: typeof workspace.projectSchemaVersion === "number" ? workspace.projectSchemaVersion : 2,
    name: `${directory} interactions`,
    assetDirectory: directory,
    entrySequence: data.record.manifest.entrySequence,
    interactions: Array.isArray(rawInteractions.interactions) ? rawInteractions.interactions : [],
    ...(rawInteractions.composition && typeof rawInteractions.composition === "object" && !Array.isArray(rawInteractions.composition)
      ? { composition: rawInteractions.composition }
      : {}),
    ...(Array.isArray(rawInteractions.behaviorMachines) ? { behaviorMachines: rawInteractions.behaviorMachines } : {}),
    ...(rawInteractions.behaviorGraphLayouts && typeof rawInteractions.behaviorGraphLayouts === "object" && !Array.isArray(rawInteractions.behaviorGraphLayouts)
      ? { behaviorGraphLayouts: rawInteractions.behaviorGraphLayouts }
      : {}),
    ...(Array.isArray(rawInteractions.sequenceOrder) ? { sequenceOrder: rawInteractions.sequenceOrder } : {}),
    ...(Array.isArray(rawInteractions.deletedSequenceIds) ? { deletedSequenceIds: rawInteractions.deletedSequenceIds } : {}),
    ...(active !== undefined ? { timeline: active } : {}),
    sequences,
    ...(typeof rawInteractions.talkMixDuration === "number" ? { talkMixDuration: rawInteractions.talkMixDuration } : {}),
    ...(typeof rawInteractions.effectsStrength === "number" ? { effectsStrength: rawInteractions.effectsStrength } : {}),
    ...(rawInteractions.lookFollow && typeof rawInteractions.lookFollow === "object" && !Array.isArray(rawInteractions.lookFollow)
      ? { lookFollow: rawInteractions.lookFollow }
      : {}),
    ...workspaceState,
  };
}

/** Read the local project companion when the viewer is pointed at an asset root. */
export async function readLocalInteractionProject(source: SpineProjectSource, directory: string, onLegacyAspectRatio?: () => void): Promise<SpineInteractionProject | null> {
  const manifestData = await readManifestProjectData(source, directory);
  if (manifestData) {
    const value = manifestProjectValue(manifestData, directory);
    const project = normalizeSpineInteractionProject(value, directory);
    if (project) {
      if (hasLegacySquareCameraAspectRatio(value)) onLegacyAspectRatio?.();
      return project;
    }
  }
  for (const path of editorProjectPaths(directory)) {
    const file = await source.getFile(path);
    if (!file) continue;
    try {
      const value = JSON.parse(await file.text()) as unknown;
      const project = normalizeSpineInteractionProject(value, directory);
      if (project) {
        if (hasLegacySquareCameraAspectRatio(value)) onLegacyAspectRatio?.();
        return {
          ...project,
          entrySequence: project.entrySequence !== undefined ? project.entrySequence : (project.sequences?.opening ? "opening" : null),
        };
      }
    } catch {
      // A malformed private project should not prevent the published fallback from loading.
    }
  }
  return null;
}
