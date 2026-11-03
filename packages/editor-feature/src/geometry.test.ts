import { describe, expect, test } from "bun:test";
import type { SpineEditorFrame } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { blankRegion, createProject } from "./editorModel";
import { hitRegion, inversePoint, regionMatrix, screenToWorld } from "./geometry";

const frame = { canvasWidth: 800, canvasHeight: 600, screenOriginX: 400, screenOriginY: 300, screenUnitXEndX: 402, screenUnitXEndY: 300, screenUnitYEndX: 400, screenUnitYEndY: 298, bones: [], constraints: [] } as unknown as SpineEditorFrame;

describe("Editor region projection", () => {
  test("world-up maps upward in SVG, and inverse projection survives camera pan/zoom", () => {
    const region = { ...blankRegion(undefined, 0), offsetX: 10, offsetY: 20, rotation: 35 };
    const matrix = regionMatrix(frame, region);
    expect(matrix.e).toBe(420);
    expect(matrix.f).toBe(260);
    expect(screenToWorld(frame, 420, 260)).toEqual({ x: 10, y: 20 });
    const point = inversePoint(matrix, matrix.e + matrix.a * 12 + matrix.c * 7, matrix.f + matrix.b * 12 + matrix.d * 7)!;
    expect(point.x).toBeCloseTo(12);
    expect(point.y).toBeCloseTo(7);
    const moved = { ...frame, screenOriginX: 200, screenOriginY: 150, screenUnitXEndX: 203, screenUnitXEndY: 150, screenUnitYEndX: 200, screenUnitYEndY: 147 };
    expect(screenToWorld(moved, 230, 90)).toEqual({ x: 10, y: 20 });
  });

  test("hit testing uses the same transformed ellipse/rectangle as the overlay", () => {
    const project = createProject("test", [], []);
    const region = { ...blankRegion(undefined, 0), radiusX: 20, radiusY: 10, rotation: 90 };
    project.interactions[0]!.regions = [region];
    expect(hitRegion(frame, project, 400, 270)?.region.id).toBe(region.id);
    expect(hitRegion(frame, project, 430, 300)).toBeNull();
    project.interactions[0]!.regions[0]!.anchorBone = "root/from-another-asset";
    project.interactions[0]!.regions[0]!.offsetX = 0;
    project.interactions[0]!.regions[0]!.offsetY = 0;
    expect(hitRegion(frame, project, 400, 300)?.region.id).toBe(region.id);
    project.interactions[0]!.enabled = false;
    expect(hitRegion(frame, project, 400, 300)).toBeNull();
  });
});
