import { BlendMode, MeshAttachment, RegionAttachment, Vector2, type Bone, type Skeleton, type Slot } from "@esotericsoftware/spine-core";
import type { SpineAuthoredRegion } from "./spineInteraction";

export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AuthoredViewport extends SceneBounds {
  /** True when the viewport came from a named scene layer and backdrop. */
  authored: boolean;
  anchorX: number;
  anchorY: number;
}

const DEFAULT_ASPECT = 16 / 9;
// The lobby exports use a 3464-unit-wide camera for the normal full scene.
// Smaller split panels often need to be combined to recover that extent, but
// a union much wider than a full camera is usually an offstage prop/cut.
const TYPICAL_CAMERA_WIDTH = 3464;

function finiteBounds(bounds: SceneBounds | null): bounds is SceneBounds {
  return Boolean(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0);
}

function visibleAttachment(slot: Slot) {
  if (!slot.bone.active || slot.color.a * slot.getSkeleton().color.a <= 0.01 || slot.data.blendMode !== BlendMode.Normal) return null;
  const attachment = slot.getAttachment();
  if (!(attachment instanceof RegionAttachment || attachment instanceof MeshAttachment) || attachment.color.a <= 0.01) return null;
  const name = `${slot.data.name}/${attachment.name}/${boneNamePath(slot.bone)}`;
  // Some exported effects use normal blending rather than an additive slot.
  if (DECORATIVE_NAME.test(name) || /(?:^|[\/_\s-])(?:fx|vfx|effect|particle|fish|bubble)(?:[\/_\s-]|\d|$)/i.test(name)) return null;
  return attachment;
}

function attachmentBounds(slot: Slot): SceneBounds | null {
  const attachment = visibleAttachment(slot);
  if (!attachment) return null;
  const vertices = new Float32Array(attachment instanceof MeshAttachment ? attachment.worldVerticesLength : 8);
  if (attachment instanceof MeshAttachment) attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
  else attachment.computeWorldVertices(slot, vertices, 0, 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 2) {
    minX = Math.min(minX, vertices[i]!);
    minY = Math.min(minY, vertices[i + 1]!);
    maxX = Math.max(maxX, vertices[i]!);
    maxY = Math.max(maxY, vertices[i + 1]!);
  }
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return finiteBounds(bounds) ? bounds : null;
}

function unionBounds(bounds: SceneBounds[]): SceneBounds | null {
  if (bounds.length === 0) return null;
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const top = Math.max(...bounds.map((item) => item.y + item.height));
  const result = { x, y, width: right - x, height: top - y };
  return finiteBounds(result) ? result : null;
}

function authoredBackdropExtent(bounds: SceneBounds[]): SceneBounds | null {
  if (bounds.length === 0) return null;
  const largest = [...bounds].sort((a, b) => {
    const widthDelta = b.width - a.width;
    return Math.abs(widthDelta) > 1 ? widthDelta : b.height - a.height;
  })[0]!;
  const compositeParts = bounds.filter((item) => {
    if (item === largest) return true;
    const widthRatio = item.width / largest.width;
    const heightRatio = item.height / largest.height;
    if (Math.min(widthRatio, heightRatio) > 0.25) return true;
    const horizontalGap = Math.max(largest.x - (item.x + item.width), item.x - (largest.x + largest.width), 0);
    const verticalGap = Math.max(largest.y - (item.y + item.height), item.y - (largest.y + largest.height), 0);
    // Tiny named details attached to a camera-sized panel (`BG_detail`, a
    // chair marker, etc.) are backdrop labels, not a second camera panel.
    return horizontalGap > 1 || verticalGap > 1;
  });
  const composite = unionBounds(compositeParts);
  if (!composite) return largest;
  // Keep a composite when it is a set of small panels spanning one camera, or
  // when the extra pieces are a modest extension of a dominant backdrop. If a
  // full-sized panel is already present and the union grows by more than 25%,
  // the distant pieces are staged scenery rather than viewport geometry.
  const smallPanelComposite = largest.width <= TYPICAL_CAMERA_WIDTH * 0.75
    && composite.width <= TYPICAL_CAMERA_WIDTH * 1.25;
  const closeComposite = composite.width <= largest.width * 1.25;
  return smallPanelComposite || closeComposite ? composite : largest;
}

const BACKDROP_NAME = /(^|[\/_\s-])(?:bg|background|backgroud|backgrund|back[ _-]?ground|backdrop|sky|ground|floor|wall|sea|stage|room|building|window|city|booth|ocean|river|bottom|blur)([\/_\s-]|\d|$)/i;
const DECORATIVE_NAME = /(^|[\/_\s-])(?:fx|vfx|effect|bloom|flare|glow|light|lighting|beam\w*|sunlight|fish\w*|sardine\w*|turtle\w*|tetra\w*|moorish\w*|idol\w*|bird\w*|butterfly\w*|ladybug\w*|animal\w*|fauna\w*|insect\w*|coral\w*|cloud\w*|shooting[ _-]?star\w*|star\w*|bubble\w*|bokeh|particle|spark|dust|fog|rain|snow|steam|glitter)(?=[\/_\s-]|\d|$)/i;
const CHARACTER_BONE = /^(?:pc(?:\d+|[ _-])?|char(?:acter)?(?:[ _-]|$)|player(?:[ _-]|$)|avatar(?:[ _-]|$)|hip(?:[ _-]|$)|torso(?:[ _-]|$)|spine(?:[ _-]|$)|neck(?:[ _-]|$)|head(?:[ _-]|$)|face(?:[ _-]|$)|body(?:[ _-]|$)|arm(?:[ _-]|$)|leg(?:[ _-]|$)|hand(?:[ _-]|$)|foot(?:[ _-]|$)|finger(?:[ _-]|$)|eye(?:[ _-]|$)|mouth(?:[ _-]|$)|hair(?:[ _-]|$)|skirt(?:[ _-]|$))/i;

function boneNamePath(bone: Bone, stop: Bone | null = null): string {
  const names: string[] = [];
  for (let current: Bone | null = bone; current && current !== stop; current = current.parent) names.push(current.data.name);
  return names.join("/");
}

function isBackgroundRootName(name: string): boolean {
  return /^(?:bg|background|backgroud|backgrund|back[ _-]?ground|backdrop|sky|ground|floor|wall|sea|stage|room|building|window|city|booth|ocean|river|bottom)(?:\d+|$|[ _-])/i.test(name.trim());
}

/**
 * These are scene containers, not the many PC_Layer12/PC_Layer20 bones used
 * for character parts. Exporters use both underscore and compact spellings,
 * so keep the useful prefixes but require a layer boundary for PC layers.
 */
function isSceneContainer(bone: Bone): boolean {
  const name = bone.data.name.trim();
  if (/^pc[ _-]?layer(?:$|[_-])/i.test(name)) return true;
  // Scene roots are often prefixed with the cut/home name (for example
  // `2_home_All_Layer`, `Intro_All_Layer`, or `B_AllLayer`). Match the
  // authored `AllLayer` token wherever it forms a bone-name boundary instead
  // of assuming it starts at character zero.
  if (/(?:^|[\/_ -])all[ _-]?layer(?:$|[\/_-]|\d)/i.test(name)) return true;
  // Multi-cut exports also put complete scenes under neutral `Cut_00`,
  // `cut_01`, or `intro_02` bones. They must be isolated from their parent
  // layer or an offstage cut expands the Free bounds and wins the camera
  // backdrop selection.
  if (/^(?:cut|intro)[ _-]?\d+$/i.test(name)) return true;
  // Intro art is sometimes a complete offstage scene without an
  // `Intro_All_Layer` wrapper (`BG_Intro_F`, `Background_Intro`, ...).
  // Treat that branch as a scene boundary when it owns a backdrop so it does
  // not enlarge the normal home scene's camera.
  if (/^(?:bg|background)[\/_ -].*intro/i.test(name)) return true;
  // A few exports place an offstage blur/alternate background in a sibling
  // such as `BG_Layer2`. It is a complete visual branch, not a child panel of
  // the home scene; give it the same boundary treatment as named cuts.
  if (/^(?:bg|background)[\/_ -].*layer\d*$/i.test(name)) return true;
  if (/^(?:\d+[_ -])?(?:all[_ -]?cam(?:era)?(?:[_ -]?root)?|camera[_ -]?(?:pos|root)|main[_ -]?camera|background[_ -]?layer|full)$/i.test(name)) return true;
  return false;
}

function descendantOf(bone: Bone, ancestor: Bone): boolean {
  for (let current: Bone | null = bone; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function isCharacterContainer(bone: Bone): boolean {
  return /^(?:pc(?:\d+|[ _-]?(?:layer|root)(?:[ _-]?\d+)?)?|cha(?:racter)?[ _-]?root)$/i.test(bone.data.name.trim());
}

function hasCharacterBone(skeleton: Skeleton, container: Bone): boolean {
  return skeleton.bones.some((bone) => descendantOf(bone, container) && CHARACTER_BONE.test(bone.data.name.trim()));
}

function isCharacterBranch(skeleton: Skeleton, bone: Bone, stop: Bone | null): boolean {
  for (let current: Bone | null = bone; current; current = current.parent) {
    const name = current.data.name.trim();
    if (isCharacterContainer(current) || CHARACTER_BONE.test(name)) return true;
    // A few exports put the character directly under the background root in a
    // control bone (`BG_Crtl`, `BG_Ctrl`, ...), without a PC_Layer wrapper.
    // Only treat it as a character branch when its descendants look like a
    // rig; ordinary background control bones are still allowed through.
    if (/(?:ctrl|crtl|control)$/i.test(name) && hasCharacterBone(skeleton, current)) return true;
    if (current === stop) break;
  }
  return false;
}

function backgroundRoot(skeleton: Skeleton, slot: Slot, stop: Bone | null): Bone | null {
  if (!slot.getAttachment()) return null;
  for (let current: Bone | null = slot.bone; current; current = current.parent) {
    if (isBackgroundRootName(current.data.name)) return current;
    if (current === stop) break;
  }
  return null;
}

function isDecorative(skeleton: Skeleton, slot: Slot, stop: Bone | null): boolean {
  const attachment = slot.getAttachment();
  const names = `${slot.data.name}/${attachment?.name ?? ""}/${boneNamePath(slot.bone, stop)}`;
  return DECORATIVE_NAME.test(names) || /(?:^|[\/_\s-])(?:fx|vfx|effect|particle|fish|bubble)(?:[\/_\s-]|\d|$)/i.test(names);
}

/**
 * Background art is not consistently named. Newer exports have a `BG` or
 * `Background` branch and attach perfectly ordinary names (`book6`, `tree`,
 * `floor_tile`, ...) below it. Older exports put the marker on the slot
 * itself. Keep both forms, but never let a character branch inherit the
 * marker from its background parent.
 */
function isBackdrop(skeleton: Skeleton, slot: Slot, stop: Bone | null = null): boolean {
  if (!slot.getAttachment() || isDecorative(skeleton, slot, stop)) return false;
  const root = backgroundRoot(skeleton, slot, stop);
  const attachmentName = `${slot.data.name}/${slot.getAttachment()?.name ?? ""}`;
  const explicitlyNamed = BACKDROP_NAME.test(attachmentName);
  // Some old exports put the background branch below `PC_Layer`. Once a
  // genuine BG/Background root is found, only character bones between that
  // root and the slot disqualify it; the parent PC container itself does not.
  // An explicit background attachment is still authoritative when it is
  // attached directly to a PC layer (`Back_Ground_01`, `BG_03`, ...).
  if (!explicitlyNamed && (root ? isCharacterBranch(skeleton, slot.bone, root) : isCharacterBranch(skeleton, slot.bone, stop))) return false;
  // When the scene container is itself named `BG_Layer`, the root marker is
  // the only clue for generic art such as `BF_Blur`. Do not let an unrelated
  // prop attached directly to that same container become a backdrop merely
  // because it shares the parent bone.
  return Boolean((root && root !== stop) || explicitlyNamed);
}

function interactionSlots(skeleton: Skeleton): Slot[] {
  const scene = activeScene(skeleton, anchorPoint(skeleton));
  const available = scene?.slots ?? skeleton.drawOrder;
  const containers = skeleton.bones
    .filter(isCharacterContainer)
    .sort((a, b) => boneDepth(b) - boneDepth(a));
  for (const container of containers) {
    const slots = available.filter((slot) => descendantOf(slot.bone, container));
    if (slots.length > 0) return slots;
  }
  return available;
}

function boneDepth(bone: Bone): number {
  let depth = 0;
  for (let current = bone.parent; current; current = current.parent) depth += 1;
  return depth;
}

function hasBackdrop(skeleton: Skeleton, container: Bone): boolean {
  return skeleton.slots.some((slot) => descendantOf(slot.bone, container) && isBackdrop(skeleton, slot, container) && attachmentBounds(slot) !== null);
}

function sceneSlots(skeleton: Skeleton, container: Bone): Slot[] {
  return skeleton.slots.filter((slot) => {
    if (!descendantOf(slot.bone, container)) return false;
    // A parent layer may contain several complete cuts. Keep the parent's own
    // attachments, but do not let a child's offstage backdrop leak into its
    // bounds. The child is evaluated as its own scene candidate below.
    for (let current: Bone | null = slot.bone; current && current !== container; current = current.parent) {
      if (!current) break;
      if (isSceneContainer(current) && hasBackdrop(skeleton, current)) return false;
    }
    return true;
  });
}

function sceneInfo(skeleton: Skeleton, container: Bone) {
  const slots = sceneSlots(skeleton, container);
  const visualBounds: SceneBounds[] = [];
  const backdropBounds: SceneBounds[] = [];
  for (const slot of slots) {
    const bounds = attachmentBounds(slot);
    if (!bounds) continue;
    visualBounds.push(bounds);
    if (isBackdrop(skeleton, slot, container)) backdropBounds.push(bounds);
  }
  return {
    container,
    slots,
    bounds: unionBounds(visualBounds),
    // A scene can be assembled from several background pieces. Their union is
    // the authored camera extent; selecting only the widest piece crops split
    // city windows, floors, bookshelves, and other composite backdrops.
    // A named `BG_detail`/`BG_chair` attached directly to a scene layer is a
    // marker, not a second camera-sized panel. Composite extents are reliable
    // when the pieces belong to an authored background branch; otherwise keep
    // the largest named panel as the legacy fallback.
    backdrop: backdropBounds.length > 0
      ? authoredBackdropExtent(backdropBounds)
      : backdropBounds.sort((a, b) => {
        const widthDelta = b.width - a.width;
        return Math.abs(widthDelta) > 1 ? widthDelta : b.height - a.height;
      })[0] ?? null,
    depth: boneDepth(container),
  };
}

interface AnchorPoint {
  x: number;
  y: number;
  bone: Bone | null;
}

function anchorPoint(skeleton: Skeleton): AnchorPoint {
  const root = skeleton.bones[0];
  // Some exports wrap the entire scene rig in a Scale/offset bone. Searching
  // only root children silently anchors those lobbies at (0, 0), below the
  // artwork. Resolve the outermost actual scene rig through such wrappers.
  const containers = skeleton.bones.filter((bone) => isSceneContainer(bone) && hasBackdrop(skeleton, bone));
  const byHierarchy = (a: Bone, b: Bone) => boneDepth(a) - boneDepth(b)
    || Math.hypot(a.worldX - (root?.worldX ?? 0), a.worldY - (root?.worldY ?? 0))
      - Math.hypot(b.worldX - (root?.worldX ?? 0), b.worldY - (root?.worldY ?? 0));
  const cameraRoot = containers
    .filter((bone) => /camera|cam/i.test(bone.data.name))
    .sort(byHierarchy)[0];
  const layerRoot = containers.sort(byHierarchy)[0];
  const point = cameraRoot ?? layerRoot ?? root;
  return { x: point?.worldX ?? 0, y: point?.worldY ?? 0, bone: point ?? null };
}

function activeScene(skeleton: Skeleton, anchor: { x: number; y: number }) {
  const candidates = skeleton.bones
    .filter((bone) => isSceneContainer(bone))
    .map((bone) => sceneInfo(skeleton, bone))
    // A PC layer can contain a perfectly valid character-sized bounds while
    // still being only one child of the lobby. Require an owned backdrop so a
    // character layer never wins the same-anchor/deeper-container tie.
    .filter((info) => info.bounds && info.backdrop)
    .filter((info) => !isCharacterContainer(info.container) || !hasBackdropSceneAncestor(skeleton, info.container))
    .sort((a, b) => {
      // A child background layer can have an arbitrary transform while its
      // authored backdrop is centered on the parent camera (for example a
      // desk scene whose wall is on `All_Layer3`). Rank by the visual
      // backdrop center before falling back to the bone origin, otherwise a
      // tiny foreground fragment on the parent wins over the real scene.
      const distanceA = Math.hypot(
        (a.backdrop!.x + a.backdrop!.width / 2) - anchor.x,
        (a.backdrop!.y + a.backdrop!.height / 2) - anchor.y,
      );
      const distanceB = Math.hypot(
        (b.backdrop!.x + b.backdrop!.width / 2) - anchor.x,
        (b.backdrop!.y + b.backdrop!.height / 2) - anchor.y,
      );
      // A child scene at the same authored anchor is more specific than the
      // layer that contains it. This is what separates All_Layer_00/01 cuts.
      return distanceA - distanceB || b.depth - a.depth || (b.backdrop?.width ?? 0) - (a.backdrop?.width ?? 0);
    });
  return candidates[0] ?? null;
}

function hasBackdropSceneAncestor(skeleton: Skeleton, container: Bone): boolean {
  for (let current = container.parent; current; current = current.parent) {
    if (isCharacterContainer(current) || !isSceneContainer(current)) continue;
    const info = sceneInfo(skeleton, current);
    if (info.bounds && info.backdrop) return true;
  }
  return false;
}

/** Frame the active authored scene, not the offstage siblings in a multi-cut lobby. */
export function sceneBounds(skeleton: Skeleton): SceneBounds {
  const authored = activeScene(skeleton, anchorPoint(skeleton));
  if (authored?.bounds && finiteBounds(authored.bounds)) return authored.bounds;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const backgrounds: SceneBounds[] = [];
  for (const slot of skeleton.drawOrder) {
    const bounds = attachmentBounds(slot);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
    if (isBackdrop(skeleton, slot)) backgrounds.push(bounds);
  }
  const mainBackground = backgrounds.sort((a, b) => {
    const areaDelta = b.width * b.height - a.width * a.height;
    return Math.abs(areaDelta) > 1 ? areaDelta : b.width - a.width;
  })[0];
  if (mainBackground) return mainBackground;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return skeleton.getBoundsRect();
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounds used for game-like taps, excluding authored backdrops and FX. */
export function interactionBounds(skeleton: Skeleton): SceneBounds | null {
  const scene = activeScene(skeleton, anchorPoint(skeleton));
  const bounds = interactionSlots(skeleton)
    .filter((slot) => !isBackdrop(skeleton, slot, scene?.container ?? null))
    .map(attachmentBounds)
    .filter((item): item is SceneBounds => Boolean(item));
  return unionBounds(bounds);
}

export type InteractionHitKind = "pat" | "pinch" | "touch";

export interface InteractionZone {
  x: number;
  y: number;
  axisX: { x: number; y: number };
  axisY: { x: number; y: number };
  shape: "ellipse" | "rectangle";
}

function interactionBone(skeleton: Skeleton, pattern: RegExp): Bone | null {
  return skeleton.bones.find((bone) => pattern.test(bone.data.name.trim())) ?? null;
}

function interactionFaceBounds(skeleton: Skeleton): SceneBounds | null {
  const bounds = interactionSlots(skeleton)
    .filter((slot) => !isBackdrop(skeleton, slot))
    .filter((slot) => /(?:^|[\/_\s-])(?:face|head|cheek|chin|mouth)(?:[\/_\s-]|\d|$)/i.test(`${slot.data.name}/${slot.getAttachment()?.name ?? ""}/${boneNamePath(slot.bone)}`))
    .map(attachmentBounds)
    .filter((item): item is SceneBounds => Boolean(item));
  return unionBounds(bounds);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pointZone(x: number, y: number, radiusX: number, radiusY = radiusX): InteractionZone {
  return {
    x,
    y,
    axisX: { x: Math.max(1, radiusX), y: 0 },
    axisY: { x: 0, y: Math.max(1, radiusY) },
    shape: "ellipse",
  };
}

function fullBonePath(bone: Bone): string {
  const names: string[] = [];
  for (let current: Bone | null = bone; current; current = current.parent) names.unshift(current.data.name);
  return names.join("/");
}

function authoredZone(skeleton: Skeleton, region: SpineAuthoredRegion): InteractionZone | null {
  if (!region.anchorBone) return null;
  const bone = skeleton.bones.find((candidate) => fullBonePath(candidate) === region.anchorBone);
  if (!bone) return null;
  const angle = region.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const center = bone.localToWorld(new Vector2(region.offsetX, region.offsetY));
  const xEnd = bone.localToWorld(new Vector2(region.offsetX + cos * region.radiusX, region.offsetY + sin * region.radiusX));
  const yEnd = bone.localToWorld(new Vector2(region.offsetX - sin * region.radiusY, region.offsetY + cos * region.radiusY));
  return {
    x: center.x,
    y: center.y,
    axisX: { x: xEnd.x - center.x, y: xEnd.y - center.y },
    axisY: { x: yEnd.x - center.x, y: yEnd.y - center.y },
    shape: region.shape,
  };
}

function cheekZones(skeleton: Skeleton, face: SceneBounds | null, all: SceneBounds | null): InteractionZone[] {
  const cheeks = skeleton.bones.filter((bone) => /^(?:[lr][ _-]?)?cheek(?:[ _-]?\d+)?$/i.test(bone.data.name.trim()));
  if (cheeks.length > 0) {
    const radius = clamp(Math.min(face?.width ?? 600, face?.height ?? 600) * 0.12, 50, Math.max(90, (all?.width ?? 1200) * 0.06));
    return cheeks.map((bone) => pointZone(bone.worldX, bone.worldY, radius, radius * 0.8));
  }
  if (!face) return [];
  const radiusX = clamp(face.width * 0.14, 50, Math.max(90, (all?.width ?? face.width) * 0.07));
  const radiusY = clamp(face.height * 0.12, 40, Math.max(80, (all?.height ?? face.height) * 0.06));
  const centerY = face.y + face.height * 0.38;
  const offsetX = Math.max(radiusX * 0.8, face.width * 0.23);
  const centerX = face.x + face.width / 2;
  return [
    pointZone(centerX - offsetX, centerY, radiusX, radiusY),
    pointZone(centerX + offsetX, centerY, radiusX, radiusY),
  ];
}

function interactionZones(skeleton: Skeleton, kind: InteractionHitKind, regions: SpineAuthoredRegion[] = []): InteractionZone[] {
  const authored = regions.filter((region) => region.kind === kind).map((region) => authoredZone(skeleton, region)).filter((zone): zone is InteractionZone => Boolean(zone));
  if (authored.length > 0) return authored;
  const all = interactionBounds(skeleton);
  const face = interactionFaceBounds(skeleton);
  const point = interactionBone(skeleton, /^touch[ _-]?point$/i)
    ?? interactionBone(skeleton, /^touch[ _-]?point[ _-]?key$/i);

  if (kind === "pat") {
    if (point) {
      const radiusX = clamp((face?.width ?? all?.width ?? 800) * 0.28, 90, Math.max(160, (all?.width ?? 1200) * 0.18));
      const radiusY = clamp((face?.height ?? all?.height ?? 800) * 0.18, 70, Math.max(130, (all?.height ?? 1200) * 0.12));
      return [pointZone(point.worldX, point.worldY, radiusX, radiusY)];
    }
    return face ? [pointZone(face.x + face.width / 2, face.y + face.height * 0.85, face.width * 0.3, face.height * 0.18)] : [];
  }

  return cheekZones(skeleton, face, all);
}

/** Geometry for the optional viewer overlay; it is the same geometry used for hit testing. */
export function interactionZonesForDisplay(
  skeleton: Skeleton,
  kinds: InteractionHitKind[],
  regions: SpineAuthoredRegion[] = [],
): Array<InteractionZone & { kind: InteractionHitKind }> {
  return kinds.flatMap((kind) => interactionZones(skeleton, kind, regions).map((zone) => ({ ...zone, kind })));
}

function zoneCoordinates(zone: InteractionZone, x: number, y: number): { x: number; y: number } | null {
  const dx = x - zone.x;
  const dy = y - zone.y;
  const determinant = zone.axisX.x * zone.axisY.y - zone.axisX.y * zone.axisY.x;
  if (Math.abs(determinant) < 1e-9) return null;
  return {
    x: (dx * zone.axisY.y - dy * zone.axisY.x) / determinant,
    y: (zone.axisX.x * dy - zone.axisX.y * dx) / determinant,
  };
}

function zoneDistance(zone: InteractionZone, x: number, y: number): number {
  const point = zoneCoordinates(zone, x, y);
  if (!point) return Infinity;
  return zone.shape === "rectangle" ? Math.max(Math.abs(point.x), Math.abs(point.y)) : Math.hypot(point.x, point.y);
}

function inZone(zone: InteractionZone, x: number, y: number): boolean {
  return zoneDistance(zone, x, y) <= 1;
}

/** Resolve shared edges once, using only actions the loaded character supports. */
export function interactionKindAtPoint(skeleton: Skeleton, x: number, y: number, kinds: InteractionHitKind[], regions: SpineAuthoredRegion[] = []): InteractionHitKind | null {
  let closest: InteractionHitKind | null = null;
  let bestDistance = Infinity;
  for (const kind of kinds) {
    for (const zone of interactionZones(skeleton, kind, regions)) {
      const distance = zoneDistance(zone, x, y);
      if (distance <= 1 && distance < bestDistance) {
        closest = kind;
        bestDistance = distance;
      }
    }
  }
  return closest;
}

/** Test a world-space pointer against the authored character attachments or a named interaction area. */
export function interactionHit(skeleton: Skeleton, x: number, y: number, kind?: InteractionHitKind, regions: SpineAuthoredRegion[] = []): boolean {
  if (kind) return interactionZones(skeleton, kind, regions).some((zone) => inZone(zone, x, y));
  const scene = activeScene(skeleton, anchorPoint(skeleton));
  return interactionSlots(skeleton)
    .filter((slot) => !isBackdrop(skeleton, slot, scene?.container ?? null))
    .map((slot) => attachmentBounds(slot))
    .some((bounds) => Boolean(bounds && x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height));
}

/**
 * Lobby exports do not carry Unity's Camera component. They do carry the
 * authored scene hierarchy: a root/layer anchor, a backdrop-sized attachment,
 * and sibling cut layers. Use that data for the viewer's fixed camera instead
 * of fitting every attachment in the skeleton.
 */
export function authoredViewport(skeleton: Skeleton, anchorSkeleton: Skeleton = skeleton): AuthoredViewport {
  const rigAnchor = anchorPoint(anchorSkeleton);
  const scene = activeScene(skeleton, rigAnchor);
  const backdrop = scene?.backdrop;
  const setupContainer = scene ? anchorSkeleton.bones[scene.container.data.index] : undefined;
  const anchorBackdrop = setupContainer && anchorSkeleton !== skeleton
    ? sceneInfo(anchorSkeleton, setupContainer).backdrop ?? backdrop : backdrop;
  const fallback = scene?.bounds ?? sceneBounds(skeleton);
  // The layer/camera rig is the authored camera anchor. A backdrop is often a
  // single sky, floor, or wall strip, so its own bounds do not describe the
  // camera center. The one exception is an export whose only detected rig is
  // itself a Background layer, or whose selected complete cut is staged away
  // from the outer rig; there the cut backdrop center is the only usable
  // camera coordinate.
  const backgroundOnlyAnchor = rigAnchor.bone && /^(?:background|back[ _-]?ground|bg)(?:[ _-]?layer)?$/i.test(rigAnchor.bone.data.name.trim());
  const translatedCut = scene && rigAnchor.bone && setupContainer && setupContainer.data.index !== rigAnchor.bone.data.index
    && Math.hypot(setupContainer.worldX - rigAnchor.x, setupContainer.worldY - rigAnchor.y) > 1;
  const anchor = (backgroundOnlyAnchor || translatedCut) && anchorBackdrop
    ? { x: anchorBackdrop.x + anchorBackdrop.width / 2, y: anchorBackdrop.y + anchorBackdrop.height / 2 }
    : rigAnchor;
  const width = backdrop?.width ?? fallback.width;
  const height = width / DEFAULT_ASPECT;
  return {
    x: anchor.x - width / 2,
    y: anchor.y - height / 2,
    width,
    height,
    authored: Boolean(scene && backdrop && width > 0),
    anchorX: anchor.x,
    anchorY: anchor.y,
  };
}

export function fitScene(bounds: SceneBounds, viewportWidth: number, viewportHeight: number, fill = false) {
  const widthScale = Math.max(bounds.width, 1) / viewportWidth;
  const heightScale = Math.max(bounds.height, 1) / viewportHeight;
  const zoom = fill ? Math.min(widthScale, heightScale) : Math.max(widthScale, heightScale) * 1.02;
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    zoom,
  };
}
