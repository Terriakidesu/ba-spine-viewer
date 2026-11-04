import { expect, test } from "bun:test";
import { clampStageScale, fitStageView, panStageView, resetStageView, stageViewSvgTransform, stageViewToContentPoint, zoomStageView, type StagePoint, type StageViewport, type StageView } from "./stageView";

function contentPointAtCursor(view: StageView, point: StagePoint, viewport: StageViewport): StagePoint {
  return {
    x: (point.x - viewport.width / 2 - view.x) / view.scale,
    y: (point.y - viewport.height / 2 - view.y) / view.scale,
  };
}

test("stage scale stays within the useful preview range", () => {
  expect(clampStageScale(0.1)).toBe(0.5);
  expect(clampStageScale(4)).toBe(4);
  expect(clampStageScale(200)).toBe(20);
  expect(clampStageScale(Number.NaN)).toBe(1);
});

test("panning accumulates without changing zoom", () => {
  const view = panStageView({ scale: 1.4, x: 8, y: -3 }, 12, 7);
  expect(view).toEqual({ scale: 1.4, x: 20, y: 4 });
});

test("SVG gizmos use the same centered stage transform", () => {
  expect(stageViewSvgTransform({ scale: 2, x: 20, y: -10 }, { width: 800, height: 600 }))
    .toBe("matrix(2 0 0 2 -380 -310)");
  const content = { x: 210, y: 380 };
  const viewport = { width: 800, height: 600 };
  const view = { scale: 2, x: 20, y: -10 };
  const screen = { x: 20 + (content.x - 400) * 2 + 400, y: -10 + (content.y - 300) * 2 + 300 };
  expect(stageViewToContentPoint(view, screen, viewport)).toEqual(content);
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

test("fit view centers a selected scene rectangle with useful margins", () => {
  const view = fitStageView({ width: 800, height: 600 }, { x: 200, y: 200, width: 300, height: 150 });
  expect(view.scale).toBeCloseTo(800 * 0.82 / 300);
  expect(view.x).toBeCloseTo((400 - 350) * view.scale);
  expect(view.y).toBeCloseTo((300 - 275) * view.scale);
});
