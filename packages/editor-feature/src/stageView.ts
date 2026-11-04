export interface StageView {
  scale: number;
  x: number;
  y: number;
}

export interface StagePoint {
  x: number;
  y: number;
}

export interface StageRect extends StagePoint {
  width: number;
  height: number;
}

export interface StageViewport {
  width: number;
  height: number;
}

export const STAGE_VIEW_MIN_SCALE = 0.5;
export const STAGE_VIEW_MAX_SCALE = 20;
export const STAGE_VIEW_DEFAULT_SCALE = 1;

export function clampStageScale(value: number): number {
  if (!Number.isFinite(value)) return STAGE_VIEW_DEFAULT_SCALE;
  return Math.max(STAGE_VIEW_MIN_SCALE, Math.min(STAGE_VIEW_MAX_SCALE, value));
}

export function resetStageView(): StageView {
  return { scale: STAGE_VIEW_DEFAULT_SCALE, x: 0, y: 0 };
}

/** Center a scene-space rectangle in the viewport at the largest useful zoom. */
export function fitStageView(viewport: StageViewport, content: StageRect, padding = 0.82): StageView {
  if (![viewport.width, viewport.height, content.x, content.y, content.width, content.height].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) return resetStageView();
  const inset = Number.isFinite(padding) ? Math.max(0.1, Math.min(1, padding)) : 0.82;
  const scale = clampStageScale(Math.min(viewport.width * inset / content.width, viewport.height * inset / content.height));
  const centerX = content.x + content.width / 2;
  const centerY = content.y + content.height / 2;
  return {
    scale,
    x: (viewport.width / 2 - centerX) * scale,
    y: (viewport.height / 2 - centerY) * scale,
  };
}

export function panStageView(view: StageView, deltaX: number, deltaY: number): StageView {
  return {
    ...view,
    x: view.x + deltaX,
    y: view.y + deltaY,
  };
}

/** Apply the same centered zoom/pan to SVG gizmos without CSS-rasterizing the SVG layer. */
export function stageViewSvgTransform(view: StageView, viewport: StageViewport): string {
  const scale = clampStageScale(view.scale);
  const translateX = viewport.width * (1 - scale) / 2 + view.x;
  const translateY = viewport.height * (1 - scale) / 2 + view.y;
  return `matrix(${scale} 0 0 ${scale} ${translateX} ${translateY})`;
}

/** Map a screen-space point from the SVG overlay back into unscaled scene coordinates. */
export function stageViewToContentPoint(view: StageView, point: StagePoint, viewport: StageViewport): StagePoint {
  const scale = clampStageScale(view.scale);
  return {
    x: (point.x - viewport.width / 2 - view.x) / scale + viewport.width / 2,
    y: (point.y - viewport.height / 2 - view.y) / scale + viewport.height / 2,
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
