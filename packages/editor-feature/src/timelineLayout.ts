export const TIMELINE_LAYOUT_PREFERENCES_KEY = "shittim-spine-editor:timeline-layout-preferences:v1";

export const DEFAULT_TIMELINE_PREVIEW_SHARE = 52;
export const MIN_TIMELINE_PREVIEW_SHARE = 25;
export const MAX_TIMELINE_PREVIEW_SHARE = 75;
export const DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH = 190;
export const DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH = 300;
export const MIN_TIMELINE_SEQUENCE_PANEL_WIDTH = 140;
export const MAX_TIMELINE_SEQUENCE_PANEL_WIDTH = 360;
export const MIN_TIMELINE_INSPECTOR_PANEL_WIDTH = 220;
export const MAX_TIMELINE_INSPECTOR_PANEL_WIDTH = 440;

export interface TimelineLayoutPreferences {
  previewShare: number;
  sequencePanelWidth: number;
  inspectorPanelWidth: number;
  sequencePanelCollapsed: boolean;
  inspectorPanelCollapsed: boolean;
}

export const DEFAULT_TIMELINE_LAYOUT_PREFERENCES: TimelineLayoutPreferences = {
  previewShare: DEFAULT_TIMELINE_PREVIEW_SHARE,
  sequencePanelWidth: DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH,
  inspectorPanelWidth: DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH,
  sequencePanelCollapsed: false,
  inspectorPanelCollapsed: false,
};

export function clampTimelinePreviewShare(value: number): number {
  return Math.round(Math.min(MAX_TIMELINE_PREVIEW_SHARE, Math.max(MIN_TIMELINE_PREVIEW_SHARE, value)));
}

export function normalizeTimelinePreviewShare(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampTimelinePreviewShare(value)
    : DEFAULT_TIMELINE_PREVIEW_SHARE;
}

export function clampTimelinePanelWidth(side: "sequences" | "inspector", value: number): number {
  const min = side === "sequences" ? MIN_TIMELINE_SEQUENCE_PANEL_WIDTH : MIN_TIMELINE_INSPECTOR_PANEL_WIDTH;
  const max = side === "sequences" ? MAX_TIMELINE_SEQUENCE_PANEL_WIDTH : MAX_TIMELINE_INSPECTOR_PANEL_WIDTH;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function normalizeTimelineLayoutPreferences(value: unknown): TimelineLayoutPreferences {
  const raw = value && typeof value === "object" ? value as Partial<TimelineLayoutPreferences> : {};
  return {
    previewShare: normalizeTimelinePreviewShare(raw.previewShare),
    sequencePanelWidth: typeof raw.sequencePanelWidth === "number" && Number.isFinite(raw.sequencePanelWidth)
      ? clampTimelinePanelWidth("sequences", raw.sequencePanelWidth)
      : DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH,
    inspectorPanelWidth: typeof raw.inspectorPanelWidth === "number" && Number.isFinite(raw.inspectorPanelWidth)
      ? clampTimelinePanelWidth("inspector", raw.inspectorPanelWidth)
      : DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH,
    sequencePanelCollapsed: raw.sequencePanelCollapsed === true,
    inspectorPanelCollapsed: raw.inspectorPanelCollapsed === true,
  };
}
