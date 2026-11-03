export interface StageView {
  scale: number;
  x: number;
  y: number;
}

export interface StagePoint {
  x: number;
  y: number;
}

export interface StageViewport {
  width: number;
  height: number;
}

export const STAGE_VIEW_MIN_SCALE = 0.5;
export const STAGE_VIEW_MAX_SCALE = 3;
export const STAGE_VIEW_DEFAULT_SCALE = 1;

export function clampStageScale(value: number): number {
  if (!Number.isFinite(value)) return STAGE_VIEW_DEFAULT_SCALE;
  return Math.max(STAGE_VIEW_MIN_SCALE, Math.min(STAGE_VIEW_MAX_SCALE, value));
}

export function resetStageView(): StageView {
  return { scale: STAGE_VIEW_DEFAULT_SCALE, x: 0, y: 0 };
}

export function panStageView(view: StageView, deltaX: number, deltaY: number): StageView {
  return {
    ...view,
    x: view.x + deltaX,
    y: view.y + deltaY,
  };
}

/**
 * Zoom around a point in the viewport. The point under the cursor stays fixed
 * while the stage scale changes.
 */
export function zoomStageView(view: StageView, scale: number, cursor: StagePoint, viewport: StageViewport): StageView {
  const currentScale = clampStageScale(view.scale);
  const nextScale = clampStageScale(scale);
  if (currentScale === nextScale) return { ...view, scale: nextScale };

  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const cursorX = cursor.x - centerX;
  const cursorY = cursor.y - centerY;
  const ratio = nextScale / currentScale;
  return {
    scale: nextScale,
    x: cursorX - (cursorX - view.x) * ratio,
    y: cursorY - (cursorY - view.y) * ratio,
  };
}
