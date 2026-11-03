import type { SpineEditorFrame } from "@ba-spine/spine-runtime/spine/spineRuntime";
import type { EditorProject, EditorRegion } from "./editorModel";

export function regionMatrix(frame: SpineEditorFrame, region: EditorRegion) {
  const bone = frame.bones.find((item) => item.path === region.anchorBone);
  const x = bone?.screenX ?? frame.screenOriginX;
  const y = bone?.screenY ?? frame.screenOriginY;
  const ax = (bone?.screenLocalXEndX ?? frame.screenUnitXEndX) - x;
  const ay = (bone?.screenLocalXEndY ?? frame.screenUnitXEndY) - y;
  const bx = (bone?.screenLocalYEndX ?? frame.screenUnitYEndX) - x;
  const by = (bone?.screenLocalYEndY ?? frame.screenUnitYEndY) - y;
  const angle = region.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return { a: ax * c + bx * s, b: ay * c + by * s, c: bx * c - ax * s, d: by * c - ay * s, e: x + ax * region.offsetX + bx * region.offsetY, f: y + ay * region.offsetX + by * region.offsetY };
}

export function inversePoint(matrix: ReturnType<typeof regionMatrix>, x: number, y: number) {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(det) < 1e-9) return null;
  const dx = x - matrix.e, dy = y - matrix.f;
  return { x: (matrix.d * dx - matrix.c * dy) / det, y: (matrix.a * dy - matrix.b * dx) / det };
}

export function hitRegion(frame: SpineEditorFrame, project: EditorProject, x: number, y: number) {
  // Last drawn wins, matching the canvas stacking order.
  for (const interaction of [...project.interactions].reverse()) {
    if (!interaction.enabled) continue;
    for (const region of [...interaction.regions].reverse()) {
      // regionMatrix intentionally falls back to the world origin when an
      // imported project references a bone this asset does not have. The
      // overlay still renders that region, so hit-testing must use the same
      // fallback rather than making a visible region impossible to press.
      if (!region.enabled) continue;
      const point = inversePoint(regionMatrix(frame, region), x, y);
      if (!point) continue;
      const nx = point.x / region.radiusX, ny = point.y / region.radiusY;
      if (region.shape === "rectangle" ? Math.abs(nx) <= 1 && Math.abs(ny) <= 1 : nx * nx + ny * ny <= 1) return { interaction, region };
    }
  }
  return null;
}

export function screenToWorld(frame: SpineEditorFrame, x: number, y: number) {
  return inversePoint({ a: frame.screenUnitXEndX - frame.screenOriginX, b: frame.screenUnitXEndY - frame.screenOriginY, c: frame.screenUnitYEndX - frame.screenOriginX, d: frame.screenUnitYEndY - frame.screenOriginY, e: frame.screenOriginX, f: frame.screenOriginY }, x, y);
}
