import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEWER_ASPECT_RATIO, VIEWER_ASPECT_RATIO_KEY, fitAspectRatioBox, normalizeViewerAspectRatio, readViewerAspectRatio, writeViewerAspectRatio } from "./viewerPresentation";

describe("Viewer presentation preferences", () => {
  test("fits 16:9, 4:3, and square output without distortion", () => {
    for (const ratio of ["16:9", "4:3", "1:1"] as const) {
      const box = fitAspectRatioBox(1000, 600, ratio);
      expect(box.width / box.height).toBeCloseTo(ratio === "16:9" ? 16 / 9 : ratio === "4:3" ? 4 / 3 : 1, 2);
      expect(box.width).toBeLessThanOrEqual(1000);
      expect(box.height).toBeLessThanOrEqual(600);
    }
    expect(fitAspectRatioBox(800, 600, "16:9").y).toBeGreaterThan(0);
  });

  test("normalizes and safely persists the selected ratio", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(normalizeViewerAspectRatio("wide")).toBe(DEFAULT_VIEWER_ASPECT_RATIO);
    expect(readViewerAspectRatio(storage)).toBe(DEFAULT_VIEWER_ASPECT_RATIO);
    writeViewerAspectRatio("1:1", storage);
    expect(values.get(VIEWER_ASPECT_RATIO_KEY)).toBe("1:1");
    expect(readViewerAspectRatio(storage)).toBe("1:1");
  });
});
