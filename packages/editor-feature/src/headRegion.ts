import { AnimationState, AnimationStateData, AtlasAttachmentLoader, MeshAttachment, Physics, RegionAttachment, Skeleton, SkeletonBinary, TextureAtlas, Vector2, type Bone } from "@esotericsoftware/spine-core";
import { normalizeProject, projectStorageKey, type EditorProject, type EditorRegion } from "./editorModel";
import type { SpineFiles } from "@ba-spine/spine-runtime/spine/spineRuntime";

export type HeadRegion = Pick<EditorRegion, "anchorBone" | "offsetX" | "offsetY" | "radiusX" | "radiusY" | "rotation">;
const HEAD = /^(?:(?:pc|head)[ _-](?:[ab][ _-])?)?(?:head|face)(?:[ _-]?(?:root|rot|rotation|main|base|pos|ani|top))?(?:[ _-]?\d+[a-z]?)?$/i;
const FACE_ART = /(?:^|[\/_ -])(?:face(?:base)?|head)(?:[\/_ -]|\d|$)/i;
const DETAIL = /(?:^|[\/_ -])(?:eye\w*|brow\w*|mouth\w*|lip\w*|ear\w*|hair\w*|shadow\w*|fx|effect\w*|mask\w*)(?:[\/_ -]|\d|$)/i;

function path(bone: Bone): string {
  return bone.parent ? `${path(bone.parent)}/${bone.data.name}` : bone.data.name;
}

/** Detect visible head artwork, never the rig's Touch_Point motion controller.
 * Use the actual animated mesh rather than assuming bone lengths or world scale.
 */
export function detectHeadRegion(skeleton: Skeleton): HeadRegion | null {
  const candidates: Array<{ bone: Bone; x: number; y: number; width: number; height: number }> = [];
  for (const slot of skeleton.slots) {
    if (!slot.bone.active || slot.color.a * skeleton.color.a <= 0.01) continue;
    const attachment = slot.getAttachment();
    if (!(attachment instanceof MeshAttachment || attachment instanceof RegionAttachment) || attachment.color.a <= 0.01) continue;
    const label = `${slot.data.name}/${attachment.name}`;
    if (!FACE_ART.test(label) || DETAIL.test(label)) continue;
    let bone: Bone | null = slot.bone;
    while (bone && !HEAD.test(bone.data.name.trim())) bone = bone.parent;
    // Weighted faces are often slotted under PC_Layer, not under the head.
    // Follow their real vertex influences instead of binding to that layer.
    if (!bone && attachment instanceof MeshAttachment && attachment.bones) {
      const weights = new Map<Bone, number>();
      let v = 0;
      for (let i = 0; i < attachment.bones.length;) {
        const count = attachment.bones[i++]!;
        for (let n = 0; n < count; n++) {
          let influence: Bone | null = skeleton.bones[attachment.bones[i++]!] ?? null;
          const weight = attachment.vertices[v + 2] ?? 0;
          v += 3;
          while (influence && !HEAD.test(influence.data.name.trim())) influence = influence.parent;
          if (influence) weights.set(influence, (weights.get(influence) ?? 0) + weight);
        }
      }
      bone = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    if (!bone) continue;
    const vertices = new Float32Array(attachment instanceof MeshAttachment ? attachment.worldVerticesLength : 8);
    if (attachment instanceof MeshAttachment) attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
    else attachment.computeWorldVertices(slot, vertices, 0, 2);
    let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
    for (let i = 0; i < vertices.length; i += 2) {
      x = Math.min(x, vertices[i]!); right = Math.max(right, vertices[i]!);
      y = Math.min(y, vertices[i + 1]!); top = Math.max(top, vertices[i + 1]!);
    }
    const width = right - x, height = top - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    if (width / height < 0.3 || width / height > 3) continue;
    candidates.push({ bone, x, y, width, height });
  }
  const face = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!face) return null;
  const { bone } = face;
  if (Math.abs(bone.a * bone.d - bone.b * bone.c) < 1e-8) return null;
  const center = bone.worldToLocal(new Vector2(face.x + face.width / 2, face.y + face.height * 0.85));
  const origin = bone.worldToLocal(new Vector2(bone.worldX, bone.worldY));
  const horizontal = bone.worldToLocal(new Vector2(bone.worldX + face.width * 0.5, bone.worldY));
  const vertical = bone.worldToLocal(new Vector2(bone.worldX, bone.worldY + face.height * 0.33));
  return {
    anchorBone: path(bone), offsetX: center.x, offsetY: center.y,
    radiusX: Math.hypot(horizontal.x - origin.x, horizontal.y - origin.y),
    radiusY: Math.hypot(vertical.x - origin.x, vertical.y - origin.y),
    rotation: Math.atan2(horizontal.y - origin.y, horizontal.x - origin.x) * 180 / Math.PI,
  };
}

/** Deliberately narrow: user-drawn, moved, resized, renamed or rebound areas
 * must never be overwritten by an automatic migration. */
export function isLegacyPatRegion(project: EditorProject, region: EditorRegion): boolean {
  const interaction = project.interactions.find((item) => item.regions.some((candidate) => candidate.id === region.id));
  return Boolean(interaction && /(?:^|\/)(?:s_)?pat(?:2)?[_ -]?\d+_m(?:_|$)/i.test(interaction.startAnimation)
    && region.name === "Patting area" && region.shape === "ellipse" && region.rotation === 0
    && region.offsetX === 0 && region.offsetY === 0 && region.radiusX === 120 && region.radiusY === 90
    && region.enabled && !region.placement
    && region.anchorBone === interaction.followTargetBone);
}

export function repairPatRegions(project: EditorProject, head: HeadRegion | null) {
  let repaired = 0, unresolved = 0;
  const next: EditorProject = { ...project, interactions: project.interactions.map((interaction) => ({
    ...interaction,
    regions: interaction.regions.map((region) => {
      if (!isLegacyPatRegion(project, region) && region.placement !== "needs-head") return region;
      if (!head) { unresolved++; return { ...region, enabled: false, placement: "needs-head" as const }; }
      repaired++;
      return { ...region, ...head, enabled: true, placement: "head-v1" as const };
    }),
  })) };
  return { project: next, repaired, unresolved };
}

/** Geometry-only loading: bulk repair never decodes textures or opens WebGL contexts. */
export async function headRegionFromFiles(files: SpineFiles, directory: string): Promise<HeadRegion | null> {
  const atlasFile = [...files.values()].find((file) => /\.atlas$/i.test(file.name));
  if (!atlasFile) throw new Error("No atlas in asset set.");
  const atlas = new TextureAtlas(await atlasFile.text());
  const loader = new SkeletonBinary(new AtlasAttachmentLoader(atlas));
  const candidates = [...files.values()].filter((file) => /\.skel$/i.test(file.name)).sort((a, b) => Number(b.name.toLowerCase() === `${directory}.skel`.toLowerCase()) - Number(a.name.toLowerCase() === `${directory}.skel`.toLowerCase()));
  let failure: unknown;
  for (const file of candidates) {
    try {
      const data = loader.readSkeletonData(await file.arrayBuffer());
      const idle = data.animations.find((animation) => /^idle(?:[_ -]?0?1)?$/i.test(animation.name));
      if (!idle) continue; // Background/scene skeletons aren't the character.
      const skeleton = new Skeleton(data);
      const state = new AnimationState(new AnimationStateData(data));
      state.setAnimation(0, idle.name, true);
      state.apply(skeleton);
      skeleton.updateWorldTransform(Physics.pose);
      return detectHeadRegion(skeleton);
    } catch (error) { failure = error; }
  }
  if (failure) throw failure;
  return null;
}

export const HEAD_REPAIR_BACKUP = "shittim-spine-editor:head-repair-backup:v1";
interface RepairBackup { key: string; before: string; after: string }

function backups(storage: Storage): RepairBackup[] {
  const value: unknown = JSON.parse(storage.getItem(HEAD_REPAIR_BACKUP) ?? "[]");
  if (!Array.isArray(value)) throw new Error("Invalid head-repair backup.");
  return value.filter((item): item is RepairBackup => item && typeof item.key === "string" && typeof item.before === "string" && typeof item.after === "string");
}

export async function repairSavedHeadRegions(source: { getSetFiles: (directory: string) => Promise<SpineFiles> }, directories: string[], signal: AbortSignal, progress: (text: string) => void, storage: Storage = localStorage) {
  const result = { repaired: 0, unresolved: 0, kept: 0, failed: 0, cancelled: false };
  const backup = backups(storage);
  for (const [index, directory] of directories.entries()) {
    if (signal.aborted) { result.cancelled = true; break; }
    progress(`Repairing saved defaults ${index + 1}/${directories.length}: ${directory}`);
    try {
      const key = projectStorageKey(directory);
      const before = storage.getItem(key);
      if (!before) continue; // Unopened sets get the new detection on first load.
      const project = normalizeProject(JSON.parse(before), directory);
      if (!project || !project.interactions.some((item) => item.regions.some((region) => isLegacyPatRegion(project, region) || region.placement === "needs-head"))) { result.kept++; continue; }
      const head = await headRegionFromFiles(await source.getSetFiles(directory), directory);
      if (signal.aborted) { result.cancelled = true; break; }
      const repair = repairPatRegions(project, head);
      const after = JSON.stringify(repair.project);
      // Never overwrite a project edited while its geometry was being loaded.
      if (storage.getItem(key) !== before) { result.kept++; continue; }
      const previous = backup.findIndex((item) => item.key === key);
      const entry = { key, before, after };
      if (previous >= 0) backup[previous] = entry; else backup.push(entry);
      storage.setItem(HEAD_REPAIR_BACKUP, JSON.stringify(backup)); // Backup must succeed first.
      storage.setItem(key, after);
      result.repaired += repair.repaired;
      result.unresolved += repair.unresolved;
    } catch { result.failed++; }
  }
  return result;
}

export function undoSavedHeadRepair(storage: Storage = localStorage) {
  let restored = 0, kept = 0;
  const remaining: RepairBackup[] = [];
  for (const entry of backups(storage)) {
    if (storage.getItem(entry.key) === entry.after) { storage.setItem(entry.key, entry.before); restored++; }
    else { kept++; remaining.push(entry); } // Preserve edits made after the repair.
  }
  if (remaining.length) storage.setItem(HEAD_REPAIR_BACKUP, JSON.stringify(remaining));
  else storage.removeItem(HEAD_REPAIR_BACKUP);
  return { restored, kept };
}
