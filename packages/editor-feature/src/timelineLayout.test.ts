import { expect, test } from "bun:test";
import {
  clampTimelinePanelWidth,
  clampTimelinePreviewShare,
  DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH,
  DEFAULT_TIMELINE_LAYOUT_PREFERENCES,
  DEFAULT_TIMELINE_PREVIEW_SHARE,
  DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH,
  normalizeTimelineLayoutPreferences,
  normalizeTimelinePreviewShare,
} from "./timelineLayout";

test("timeline preview split stays within usable bounds", () => {
  expect(clampTimelinePreviewShare(12)).toBe(25);
  expect(clampTimelinePreviewShare(52.6)).toBe(53);
  expect(clampTimelinePreviewShare(90)).toBe(75);
});

test("timeline preview split preferences reject invalid values", () => {
  expect(normalizeTimelinePreviewShare(undefined)).toBe(DEFAULT_TIMELINE_PREVIEW_SHARE);
  expect(normalizeTimelinePreviewShare(Number.NaN)).toBe(DEFAULT_TIMELINE_PREVIEW_SHARE);
  expect(normalizeTimelinePreviewShare(34)).toBe(34);
});

test("timeline panel widths clamp independently to usable ranges", () => {
  expect(clampTimelinePanelWidth("sequences", 90)).toBe(140);
  expect(clampTimelinePanelWidth("sequences", 280.4)).toBe(280);
  expect(clampTimelinePanelWidth("inspector", 520)).toBe(440);
});

test("timeline layout preferences default safely and retain legacy preview-only settings", () => {
  expect(normalizeTimelineLayoutPreferences(null)).toEqual(DEFAULT_TIMELINE_LAYOUT_PREFERENCES);
  expect(normalizeTimelineLayoutPreferences({ previewShare: 41 })).toEqual({
    ...DEFAULT_TIMELINE_LAYOUT_PREFERENCES,
    previewShare: 41,
  });
  expect(DEFAULT_TIMELINE_LAYOUT_PREFERENCES.sequencePanelWidth).toBe(DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH);
  expect(DEFAULT_TIMELINE_LAYOUT_PREFERENCES.inspectorPanelWidth).toBe(DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH);
});

test("timeline collapsed panel preferences are normalized as view state", () => {
  expect(normalizeTimelineLayoutPreferences({ sequencePanelCollapsed: true, inspectorPanelCollapsed: 1 })).toMatchObject({
    sequencePanelCollapsed: true,
    inspectorPanelCollapsed: false,
  });
});
