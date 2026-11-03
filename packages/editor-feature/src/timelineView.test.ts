import { describe, expect, test } from "bun:test";
import { fitTimelineToRange, zoomTimelineAtCursor } from "./timelineView";

describe("fit timeline to selection", () => {
  test("fits the selected time range and includes edge padding", () => {
    const result = fitTimelineToRange({ start: 10, end: 12 }, 700, 116, 96, 24);
    expect(result).not.toBeNull();
    expect(result!.zoom).toBeCloseTo((700 - 116 - 48) / (2 * 96), 10);
    expect(result!.scrollLeft).toBeCloseTo(10 * 96 * result!.zoom - 24, 10);
  });

  test("clamps zoom and rejects ranges that cannot be fit", () => {
    expect(fitTimelineToRange({ start: 0, end: 100 }, 300, 116)?.zoom).toBe(0.1);
    expect(fitTimelineToRange({ start: 0, end: 0 }, 1000)).toBeNull();
    expect(fitTimelineToRange({ start: 0, end: 2 }, 100)).toBeNull();
  });
});

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
