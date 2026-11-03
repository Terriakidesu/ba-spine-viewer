export interface TimelineWheelZoom {
  zoom: number;
  scrollLeft: number;
}

/** Keep the timeline point below the pointer fixed while changing its scale. */
export function zoomTimelineAtCursor(
  zoom: number,
  scrollLeft: number,
  pointerX: number,
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
  trackLabelWidth = 116,
): TimelineWheelZoom {
  const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * viewportHeight : deltaY;
  const nextZoom = Math.max(0.1, Math.min(3, zoom * Math.exp(-delta * 0.0015)));
  if (nextZoom === zoom) return { zoom, scrollLeft };

  const timeX = pointerX + scrollLeft - trackLabelWidth;
  return {
    zoom: nextZoom,
    scrollLeft: Math.max(0, trackLabelWidth + timeX * (nextZoom / zoom) - pointerX),
  };
}
