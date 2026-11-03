import { describe, expect, test } from "bun:test";
import { zoomTimelineAtCursor } from "./timelineView";

describe("timeline wheel zoom", () => {
  test("keeps the time below the pointer fixed", () => {
    const zoom = 1.4;
    const scrollLeft = 420;
    const pointerX = 260;
    const beforeTime = (pointerX + scrollLeft - 116) / zoom;
    const next = zoomTimelineAtCursor(zoom, scrollLeft, pointerX, -100, 0, 300);
    const afterTime = (pointerX + next.scrollLeft - 116) / next.zoom;

    expect(next.zoom).toBeGreaterThan(zoom);
    expect(afterTime).toBeCloseTo(beforeTime, 10);
  });

  test("normalizes line and page wheel deltas and clamps zoom", () => {
    const lineZoom = zoomTimelineAtCursor(1, 100, 160, -1, 1, 300);
    const pageZoom = zoomTimelineAtCursor(1, 100, 160, -1, 2, 300);
    const capped = zoomTimelineAtCursor(2.9, 100, 160, -1000, 0, 300);
    const minimum = zoomTimelineAtCursor(0.11, 100, 160, 10000, 0, 300);

    expect(lineZoom.zoom).toBeCloseTo(Math.exp(16 * 0.0015), 10);
    expect(pageZoom.zoom).toBeCloseTo(Math.exp(300 * 0.0015), 10);
    expect(capped.zoom).toBe(3);
    expect(minimum.zoom).toBe(0.1);
  });
});
