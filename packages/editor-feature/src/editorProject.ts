import { EDITOR_SCHEMA_VERSION, normalizeProject, type EditorProject } from "./editorModel";
import { editorProjectPath, editorProjectPaths } from "./editorStorage";
import { manifestProjectValue, readManifestProjectData } from "@ba-spine/spine-runtime/spine/spineProject";
import { manifestPath, manifestReferenceCandidates, sequencePath, type SpineManifest, type SpineManifestRecord, type SpineManifestPath } from "@ba-spine/spine-runtime/spine/spineManifest";

export interface SavedEditorProjectSource {
  readText: (path: string) => Promise<string | null>;
  getManifest?: (directory: string) => Promise<SpineManifestRecord | null>;
}

export interface WritableEditorProjectSource extends SavedEditorProjectSource {
  saveText: (path: string, content: string) => Promise<void>;
}

export async function readSavedEditorProject(source: SavedEditorProjectSource, directory: string, onError: (message: string) => void): Promise<EditorProject | null> {
  if (source.getManifest) {
    const manifestData = await readManifestProjectData({
      getManifest: source.getManifest,
      getFile: async (path) => {
        const content = await source.readText(path);
        return content === null ? null : new File([content], path.split("/").at(-1) ?? "data.json", { type: "application/json" });
      },
    }, directory);
    if (manifestData) {
      const project = normalizeProject(manifestProjectValue(manifestData, directory), directory);
      if (project) return project;
      onError(`The manifest project for ${directory} is not compatible.`);
    }
  }
  for (const path of editorProjectPaths(directory)) {
    const content = await source.readText(path);
    if (!content) continue;
    try {
      const project = normalizeProject(JSON.parse(content) as unknown, directory);
      if (project) return project;
      onError(`Saved editor project is not compatible: ${path}`);
    } catch (value) {
      onError(`Could not read saved editor project ${path}: ${value instanceof Error ? value.message : String(value)}`);
    }
  }
  return null;
}

export function pendingProjectForDirectory(pending: EditorProject | null, directory: string): EditorProject | null {
  return pending?.assetDirectory === directory ? pending : null;
}

function projectSequences(project: EditorProject): Record<string, EditorProject["timeline"]> {
  const sequences: Record<string, EditorProject["timeline"]> = { ...(project.sequences ?? {}) };
  const activeId = project.timeline.sequenceId ?? "legacy";
  sequences[activeId] = project.timeline;
  return sequences;
}

function timelineWithManifestAssetPaths(timeline: EditorProject["timeline"], manifest: SpineManifest): EditorProject["timeline"] {
  const assetPaths = { ...(timeline.assetPaths ?? {}) };
  for (const layer of timeline.layers) {
    if (assetPaths[layer.directory]) continue;
    const asset = manifest.assets[layer.directory];
    if (!asset) continue;
    assetPaths[layer.directory] = asset.atlas.scope === "root"
      ? asset.atlas.path.replace(/\/[^/]+$/, "")
      : `lobbies/${manifest.id}/spine`;
  }
  return Object.keys(assetPaths).length > 0 ? { ...timeline, assetPaths } : timeline;
}

async function saveManifestReference(source: WritableEditorProjectSource, record: SpineManifestRecord, reference: SpineManifestPath, content: string): Promise<void> {
  const path = manifestReferenceCandidates(record, reference)[0];
  if (!path) throw new Error(`Manifest path is empty for ${record.manifest.id}.`);
  await source.saveText(path, content);
}

function workspaceForProject(project: EditorProject): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectSchemaVersion: EDITOR_SCHEMA_VERSION,
    name: project.name,
    assetDirectory: project.assetDirectory,
    selectedSequenceId: project.timeline.sequenceId ?? "legacy",
    selectedInteractionId: project.selectedInteractionId,
    selectedRegionId: project.selectedRegionId,
    selectedBonePath: project.selectedBonePath,
    showBones: project.showBones,
    showBoneNames: project.showBoneNames,
    showConstraints: project.showConstraints,
    showInactiveBones: project.showInactiveBones,
  };
}

/** Save authored interactions/sequences and editor-only state to the manifest layout. */
export async function saveManifestEditorProject(source: WritableEditorProjectSource, project: EditorProject): Promise<{ manifest: SpineManifest; manifestPath: string; paths: string[] } | null> {
  if (!source.getManifest) return null;
  const record = await source.getManifest(project.assetDirectory);
  if (!record) return null;
  const current = record.manifest;
  const sequences = Object.fromEntries(Object.entries(projectSequences(project)).map(([id, timeline]) => [id, timelineWithManifestAssetPaths(timeline, current)]));
  const sequenceRefs: Record<string, SpineManifestPath> = { ...(current.sequences ?? {}) };
  for (const id of Object.keys(sequences)) sequenceRefs[id] ??= sequencePath(id);
  let entrySequence = project.entrySequence !== undefined ? project.entrySequence : current.entrySequence;
  if (entrySequence === null && sequences.opening && project.timeline.sequenceId === "opening") entrySequence = "opening";
  const interactions = current.interactions ?? manifestPath("lobby", "interactions.json");
  const workspace = current.workspace ?? manifestPath("lobby", ".editor/workspace.json");
  const nextManifest: SpineManifest = {
    ...current,
    entrySequence: entrySequence && sequenceRefs[entrySequence] ? entrySequence : null,
    entryMode: entrySequence && sequenceRefs[entrySequence] ? "authored-sequence" : "runtime-intro",
    sequences: sequenceRefs,
    interactions,
    workspace,
  };
  await saveManifestReference(source, record, interactions, JSON.stringify({
    schemaVersion: 1,
    id: project.assetDirectory,
    assetDirectory: project.assetDirectory,
    talkMixDuration: project.talkMixDuration,
    interactions: project.interactions,
  }, null, 2) + "\n");
  const paths: string[] = [];
  for (const [id, timeline] of Object.entries(sequences)) {
    const reference = sequenceRefs[id]!;
    await saveManifestReference(source, record, reference, JSON.stringify(timeline, null, 2) + "\n");
    paths.push(...manifestReferenceCandidates(record, reference).slice(0, 1));
  }
  const workspaceContent = JSON.stringify(workspaceForProject(project), null, 2) + "\n";
  await saveManifestReference(source, record, workspace, workspaceContent);
  const rootWorkspacePath = editorProjectPath(project.assetDirectory);
  const manifestWorkspacePath = manifestReferenceCandidates(record, workspace)[0];
  if (manifestWorkspacePath !== rootWorkspacePath) await source.saveText(rootWorkspacePath, workspaceContent);
  await source.saveText(record.path, JSON.stringify(nextManifest, null, 2) + "\n");
  return { manifest: nextManifest, manifestPath: record.path, paths };
}
