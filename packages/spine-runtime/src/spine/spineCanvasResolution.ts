export const MAX_CANVAS_RESOLUTION_PIXELS = 8_000_000;

/** Match device resolution, then spend a bounded pixel budget on deliberate magnification. */
export function spineCanvasBackingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  resolutionScale: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (![cssWidth, cssHeight, maxWidth, maxHeight].every(Number.isFinite)
    || cssWidth <= 0 || cssHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) return { width: 0, height: 0 };

  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const deviceScale = Math.min(dpr, maxWidth / cssWidth, maxHeight / cssHeight);
  const pixelBudgetScale = Math.sqrt(MAX_CANVAS_RESOLUTION_PIXELS / (cssWidth * cssHeight));
  const scaleLimit = Math.min(maxWidth / cssWidth, maxHeight / cssHeight, Math.max(deviceScale, pixelBudgetScale));
  const requestedScale = Number.isFinite(resolutionScale) ? Math.max(1, resolutionScale) : 1;
  const scale = Math.min(deviceScale * requestedScale, scaleLimit);
  return {
    width: Math.max(1, Math.min(maxWidth, Math.round(cssWidth * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.round(cssHeight * scale))),
  };
}
