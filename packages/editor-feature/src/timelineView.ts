export interface TimelineWheelZoom {
  zoom: number;
  scrollLeft: number;
}

export interface TimelineRange {
  start: number;
  end: number;
}

/** Fit a selected time range in the scrollable track area, leaving readable edge padding. */
export function fitTimelineToRange(
  range: TimelineRange,
  viewportWidth: number,
  trackLabelWidth = 116,
  timelineScale = 96,
  padding = 24,
): TimelineWheelZoom | null {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start
    || !Number.isFinite(viewportWidth) || !Number.isFinite(trackLabelWidth) || !Number.isFinite(timelineScale)
    || !Number.isFinite(padding) || timelineScale <= 0 || padding < 0) return null;
  const usableWidth = viewportWidth - trackLabelWidth - padding * 2;
  if (usableWidth <= 0) return null;
  const zoom = Math.max(0.1, Math.min(3, usableWidth / ((range.end - range.start) * timelineScale)));
  return { zoom, scrollLeft: Math.max(0, range.start * timelineScale * zoom - padding) };
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
