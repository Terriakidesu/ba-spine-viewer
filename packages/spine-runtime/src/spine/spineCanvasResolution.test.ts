import { describe, expect, test } from "bun:test";
import { MAX_CANVAS_RESOLUTION_PIXELS, spineCanvasBackingSize } from "./spineCanvasResolution";

describe("Spine canvas backing resolution", () => {
  test("matches device pixel ratio and adds resolution for deliberate zoom", () => {
    expect(spineCanvasBackingSize(100, 50, 1.25, 1, 4096, 4096)).toEqual({ width: 125, height: 63 });
    expect(spineCanvasBackingSize(100, 50, 1.25, 2, 4096, 4096)).toEqual({ width: 250, height: 125 });
  });

  test("caps magnification to GPU dimensions and the canvas pixel budget", () => {
    expect(spineCanvasBackingSize(100, 50, 1, 3, 200, 80)).toEqual({ width: 160, height: 80 });
    const size = spineCanvasBackingSize(1000, 1000, 1, 3, 4096, 4096);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_CANVAS_RESOLUTION_PIXELS);
    expect(size.width).toBeGreaterThan(1000);
  });

  test("allows the complete 4K UHD backing size within the pixel budget", () => {
    expect(spineCanvasBackingSize(960, 540, 1, 4, 4096, 4096)).toEqual({ width: 3840, height: 2160 });
  });

  test("returns empty dimensions for an undisplayed canvas", () => {
    expect(spineCanvasBackingSize(0, 50, 1, 2, 4096, 4096)).toEqual({ width: 0, height: 0 });
  });
});
