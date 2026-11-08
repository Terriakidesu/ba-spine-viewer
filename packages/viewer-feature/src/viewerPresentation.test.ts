import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEWER_ASPECT_RATIO, VIEWER_ASPECT_RATIO_KEY, fitAspectRatioBox, hasLegacyViewerAspectRatio, normalizeViewerAspectRatio, readViewerAspectRatio, writeViewerAspectRatio } from "./viewerPresentation";

describe("Viewer presentation preferences", () => {
  test("fits only supported output ratios without distortion", () => {
    for (const ratio of ["16:9", "4:3"] as const) {
      const box = fitAspectRatioBox(1000, 600, ratio);
      expect(box.width / box.height).toBeCloseTo(ratio === "16:9" ? 16 / 9 : 4 / 3, 2);
      expect(box.width).toBeLessThanOrEqual(1000);
      expect(box.height).toBeLessThanOrEqual(600);
    }
    expect(fitAspectRatioBox(800, 600, "16:9").y).toBeGreaterThan(0);
  });

  test("falls back legacy square preferences without rewriting them until the user selects a ratio", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(normalizeViewerAspectRatio("wide")).toBe(DEFAULT_VIEWER_ASPECT_RATIO);
    expect(readViewerAspectRatio(storage)).toBe(DEFAULT_VIEWER_ASPECT_RATIO);
    values.set(VIEWER_ASPECT_RATIO_KEY, "1:1");
    expect(readViewerAspectRatio(storage)).toBe("16:9");
    expect(hasLegacyViewerAspectRatio(storage)).toBe(true);
    expect(values.get(VIEWER_ASPECT_RATIO_KEY)).toBe("1:1");
    writeViewerAspectRatio("4:3", storage);
    expect(values.get(VIEWER_ASPECT_RATIO_KEY)).toBe("4:3");
    expect(hasLegacyViewerAspectRatio(storage)).toBe(false);
    expect(normalizeViewerAspectRatio("1:1")).toBe("16:9");
  });
});
