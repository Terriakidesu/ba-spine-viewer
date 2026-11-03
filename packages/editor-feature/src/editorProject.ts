import { EDITOR_SCHEMA_VERSION, normalizeProject, type EditorProject } from "./editorModel";
import { editorProjectPath, editorProjectPaths } from "./editorStorage";
import { manifestProjectValue, readManifestProjectData } from "@ba-spine/spine-runtime/spine/spineProject";
import { manifestPath, manifestReferenceCandidates, sequencePath, type SpineManifest, type SpineManifestRecord, type SpineManifestPath } from "@ba-spine/spine-runtime/spine/spineManifest";
import { contentVersion } from "@ba-spine/platform-contracts/contentVersion";

export interface SavedEditorProjectSource {
  readText: (path: string) => Promise<string | null>;
  getManifest?: (directory: string) => Promise<SpineManifestRecord | null>;
}

export interface WritableEditorProjectSource extends SavedEditorProjectSource {
  saveText: (path: string, content: string) => Promise<void>;
}

export interface EditorSaveFile {
  path: string;
  content: string;
  /** Content observed when the linked file entered the Editor session. */
  baselineContent?: string | null;
}

export interface PreparedEditorProjectSave {
  manifestSave: { manifest: SpineManifest; manifestPath: string; paths: string[] } | null;
  files: EditorSaveFile[];
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

/** Convert the live Editor model to the read-only project shape consumed by Viewer. */
export function editorProjectDraftValue(project: EditorProject): Record<string, unknown> {
  return {
    schemaVersion: project.schemaVersion,
    name: project.name,
    assetDirectory: project.assetDirectory,
    entrySequence: project.entrySequence ?? null,
    talkMixDuration: project.talkMixDuration,
    interactions: project.interactions,
    timeline: project.timeline,
    sequences: projectSequences(project),
  };
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

function manifestReferenceFile(record: SpineManifestRecord, reference: SpineManifestPath): string {
  const path = manifestReferenceCandidates(record, reference)[0];
  if (!path) throw new Error(`Manifest path is empty for ${record.manifest.id}.`);
  return path;
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

/** Prepare all manifest-layout writes without touching the library. */
export async function prepareManifestEditorProjectSave(source: SavedEditorProjectSource, project: EditorProject): Promise<PreparedEditorProjectSave | null> {
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
  const writes: EditorSaveFile[] = [{
    path: manifestReferenceFile(record, interactions),
    content: JSON.stringify({
    schemaVersion: 1,
    id: project.assetDirectory,
    assetDirectory: project.assetDirectory,
    talkMixDuration: project.talkMixDuration,
    interactions: project.interactions,
    }, null, 2) + "\n",
  }];
  const paths: string[] = [];
  for (const [id, timeline] of Object.entries(sequences)) {
    const reference = sequenceRefs[id]!;
    const path = manifestReferenceFile(record, reference);
    writes.push({ path, content: JSON.stringify(timeline, null, 2) + "\n" });
    paths.push(path);
  }
  const workspaceContent = JSON.stringify(workspaceForProject(project), null, 2) + "\n";
  const workspacePath = manifestReferenceFile(record, workspace);
  writes.push({ path: workspacePath, content: workspaceContent });
  const rootWorkspacePath = editorProjectPath(project.assetDirectory);
  if (workspacePath !== rootWorkspacePath) writes.push({ path: rootWorkspacePath, content: workspaceContent });
  writes.push({ path: record.path, content: JSON.stringify(nextManifest, null, 2) + "\n" });
  return { manifestSave: { manifest: nextManifest, manifestPath: record.path, paths }, files: uniqueEditorSaveFiles(writes) };
}

function uniqueEditorSaveFiles(files: readonly EditorSaveFile[]): EditorSaveFile[] {
  const byPath = new Map<string, EditorSaveFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing && existing.content !== file.content) throw new Error(`The save plan contains conflicting output for ${file.path}.`);
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

/** Prepare the complete project write set; callers stage linked documents before saving. */
export async function prepareEditorProjectSave(source: SavedEditorProjectSource, project: EditorProject): Promise<PreparedEditorProjectSave> {
  const manifestSave = await prepareManifestEditorProjectSave(source, project);
  if (manifestSave) return manifestSave;
  return {
    manifestSave: null,
    files: [{ path: editorProjectPath(project.assetDirectory), content: `${JSON.stringify(project, null, 2)}\n` }],
  };
}

/** Include every path whose baseline must be captured when a project is loaded. */
export async function editorProjectSavePaths(source: SavedEditorProjectSource, project: EditorProject): Promise<string[]> {
  const prepared = await prepareEditorProjectSave(source, project);
  const paths = new Set(prepared.files.map((file) => file.path));
  for (const timeline of Object.values(projectSequences(project))) {
    if (timeline.subtitlePath) paths.add(timeline.subtitlePath);
  }
  const record = await source.getManifest?.(project.assetDirectory);
  for (const reference of [record?.manifest.subtitles, record?.manifest.legacySubtitles]) {
    if (reference) {
      const path = manifestReferenceCandidates(record!, reference)[0];
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

export async function captureEditorProjectBaseline(source: SavedEditorProjectSource, project: EditorProject): Promise<Record<string, string>> {
  const paths = await editorProjectSavePaths(source, project);
  const baseline: Record<string, string> = {};
  await Promise.all(paths.map(async (path) => {
    baseline[path] = contentVersion(await source.readText(path));
  }));
  return baseline;
}

/** Legacy fixture helper: prepare first, then write each output in sequence. */
export async function saveManifestEditorProject(source: WritableEditorProjectSource, project: EditorProject): Promise<{ manifest: SpineManifest; manifestPath: string; paths: string[] } | null> {
  const prepared = await prepareManifestEditorProjectSave(source, project);
  if (!prepared?.manifestSave) return null;
  for (const file of prepared.files) await source.saveText(file.path, file.content);
  return prepared.manifestSave;
}
