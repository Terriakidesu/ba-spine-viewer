import { expect, test } from "bun:test";
import { clampStageScale, panStageView, resetStageView, zoomStageView, type StagePoint, type StageViewport, type StageView } from "./stageView";

function contentPointAtCursor(view: StageView, point: StagePoint, viewport: StageViewport): StagePoint {
  return {
    x: (point.x - viewport.width / 2 - view.x) / view.scale,
    y: (point.y - viewport.height / 2 - view.y) / view.scale,
  };
}

test("stage scale stays within the useful preview range", () => {
  expect(clampStageScale(0.1)).toBe(0.5);
  expect(clampStageScale(4)).toBe(3);
  expect(clampStageScale(Number.NaN)).toBe(1);
});

test("panning accumulates without changing zoom", () => {
  const view = panStageView({ scale: 1.4, x: 8, y: -3 }, 12, 7);
  expect(view).toEqual({ scale: 1.4, x: 20, y: 4 });
});

test("cursor-centered zoom keeps the content under the cursor fixed", () => {
  const viewport = { width: 800, height: 600 };
  const cursor = { x: 175, y: 430 };
  const before = { scale: 1, x: 24, y: -18 };
  const after = zoomStageView(before, 2, cursor, viewport);
  expect(contentPointAtCursor(after, cursor, viewport)).toEqual(contentPointAtCursor(before, cursor, viewport));
});

test("resetting the stage returns to the centered fit view", () => {
  expect(resetStageView()).toEqual({ scale: 1, x: 0, y: 0 });
});
