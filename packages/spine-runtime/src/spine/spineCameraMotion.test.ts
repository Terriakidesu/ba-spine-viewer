import { describe, expect, test } from "bun:test";
import { normalizeSpineCameraTrack, sampleSpineCameraTrack, solveSpineCamera, spineCameraBoundFromCanvasDrag, type SpineCameraTrack } from "./spineCameraMotion";

const track = (overrides: Partial<SpineCameraTrack> = {}): SpineCameraTrack => ({
  enabled: true,
  aspectRatio: "16:9",
  constraint: { mode: "automatic" },
  safeBounds: [],
  keyframes: [
    { id: "start", time: 0, centerX: 0, centerY: 0, frameHeight: 100, easing: "linear" },
    { id: "end", time: 2, centerX: 100, centerY: 50, frameHeight: 200 },
  ],
  ...overrides,
});

describe("authored camera motion", () => {
  test("converts a preview-canvas drag into a scene-space safe bound", () => {
    const bound = spineCameraBoundFromCanvasDrag(
      "room",
      "Room",
      { x: 200, y: 100 },
      { x: 1400, y: 800 },
      { centerX: 10, centerY: 20, height: 900 },
      1600,
      900,
      3,
    );
    expect(bound).toMatchObject({ id: "room", name: "Room", enabled: true, priority: 3 });
    expect(bound?.x).toBeCloseTo(-590);
    expect(bound?.y).toBeCloseTo(-330);
    expect(bound?.width).toBeCloseTo(1200);
    expect(bound?.height).toBeCloseTo(700);
    expect(spineCameraBoundFromCanvasDrag("tiny", "Tiny", { x: 2, y: 2 }, { x: 2, y: 10 }, { centerX: 0, centerY: 0, height: 10 }, 16, 9)).toBeNull();
  });

  test("interpolates camera center and frame size and honors hold/smooth easing", () => {
    const value = track();
    expect(sampleSpineCameraTrack(value, 1)).toEqual({ centerX: 50, centerY: 25, frameHeight: 150, constraint: { mode: "automatic" } });
    value.keyframes[0]!.easing = "hold";
    expect(sampleSpineCameraTrack(value, 1)?.centerX).toBe(0);
    value.keyframes[0]!.easing = "smooth";
    expect(sampleSpineCameraTrack(value, 0.5)?.centerX).toBeCloseTo(15.625);
  });

  test("solves the full viewport inside a manual bound and zooms in without changing ratio", () => {
    const value = track({ safeBounds: [{ id: "room", name: "Room", x: 0, y: 0, width: 120, height: 90, enabled: true }], constraint: { mode: "manual", boundId: "room" } });
    const solved = solveSpineCamera({ centerX: -100, centerY: 200, frameHeight: 200, constraint: value.constraint }, value, 1600, 900)!;
    expect(solved.activeBoundId).toBe("room");
    expect(solved.frame.height).toBe(67.5);
    expect(solved.frame.width).toBeCloseTo(120);
    expect(solved.frame.centerX).toBeCloseTo(60);
    expect(solved.frame.centerY).toBeCloseTo(56.25);
    expect(solved.pose.zoom).toBeCloseTo(67.5 / 900);
  });

  test("automatic bounds retain the current containing bound, then select the nearest bound", () => {
    const value = track({ safeBounds: [
      { id: "left", name: "Left", x: 0, y: 0, width: 150, height: 100, enabled: true },
      { id: "right", name: "Right", x: 100, y: 0, width: 100, height: 100, enabled: true },
    ], aspectRatio: "1:1" });
    const current = solveSpineCamera({ centerX: 110, centerY: 50, frameHeight: 20, constraint: value.constraint }, value, 1600, 900, "left")!;
    expect(current.activeBoundId).toBe("left");
    const nearest = solveSpineCamera({ centerX: 230, centerY: 50, frameHeight: 20, constraint: value.constraint }, value, 1600, 900, null)!;
    expect(nearest.activeBoundId).toBe("right");
    expect(nearest.frame.centerX).toBe(190);
  });

  test("supports ratio-specific fit limits, unconstrained shots, and invalid manual fallback", () => {
    const bounds = [{ id: "square", name: "Square", x: 0, y: 0, width: 100, height: 100, enabled: true }];
    const square = track({ aspectRatio: "1:1", safeBounds: bounds });
    const fitted = solveSpineCamera({ centerX: 50, centerY: 50, frameHeight: 150, constraint: square.constraint }, square, 800, 800)!;
    expect(fitted.frame.width).toBe(100);
    expect(fitted.frame.height).toBe(100);
    const none = solveSpineCamera({ centerX: -20, centerY: -30, frameHeight: 150, constraint: { mode: "none" } }, square, 800, 800)!;
    expect(none.activeBoundId).toBeNull();
    expect(none.frame.centerX).toBe(-20);
    const invalid = solveSpineCamera({ centerX: 50, centerY: 50, frameHeight: 40, constraint: { mode: "manual", boundId: "missing" } }, square, 800, 800)!;
    expect(invalid.activeBoundId).toBe("square");
    expect(invalid.diagnostic).toBe("invalid-manual-bound");
  });

  test("keeps the full frame inside bounds for every supported ratio and respects priority", () => {
    for (const aspectRatio of ["16:9", "4:3", "1:1"] as const) {
      const value = track({
        aspectRatio,
        safeBounds: [{ id: "room", name: "Room", x: 10, y: 20, width: 240, height: 120, enabled: true }],
      });
      const solved = solveSpineCamera({ centerX: -50, centerY: 200, frameHeight: 400, constraint: value.constraint }, value, 1600, 900)!;
      expect(solved.frame.height).toBe(120);
      expect(solved.frame.width).toBeCloseTo(120 * (aspectRatio === "16:9" ? 16 / 9 : aspectRatio === "4:3" ? 4 / 3 : 1));
      expect(solved.frame.centerX - solved.frame.width / 2).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(solved.frame.centerX + solved.frame.width / 2).toBeLessThanOrEqual(250 + 1e-6);
      expect(solved.frame.centerY - solved.frame.height / 2).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(solved.frame.centerY + solved.frame.height / 2).toBeLessThanOrEqual(140 + 1e-6);
    }
    const overlap = track({
      aspectRatio: "1:1",
      safeBounds: [
        { id: "later", name: "Later", x: 0, y: 0, width: 100, height: 100, enabled: true, priority: 9 },
        { id: "first", name: "First", x: 0, y: 0, width: 100, height: 100, enabled: true, priority: 1 },
      ],
    });
    expect(solveSpineCamera({ centerX: 50, centerY: 50, frameHeight: 30, constraint: overlap.constraint }, overlap, 100, 100)?.activeBoundId).toBe("first");
  });

  test("falls back from a disabled manual bound and reports missing bounds", () => {
    const value = track({
      safeBounds: [
        { id: "disabled", name: "Disabled", x: 0, y: 0, width: 100, height: 100, enabled: false },
        { id: "enabled", name: "Enabled", x: 100, y: 0, width: 100, height: 100, enabled: true },
      ],
    });
    const solved = solveSpineCamera({ centerX: 120, centerY: 50, frameHeight: 40, constraint: { mode: "manual", boundId: "disabled" } }, value, 1600, 900)!;
    expect(solved.activeBoundId).toBe("enabled");
    expect(solved.diagnostic).toBe("invalid-manual-bound");
    const none = solveSpineCamera({ centerX: 0, centerY: 0, frameHeight: 40, constraint: { mode: "automatic" } }, track(), 1600, 900)!;
    expect(none.diagnostic).toBe("no-bounds");
  });

  test("normalizes malformed camera data and removes duplicate ids and times", () => {
    const normalized = normalizeSpineCameraTrack({
      aspectRatio: "nope",
      safeBounds: [
        { id: "same", x: 0, y: 0, width: 10, height: 10 },
        { id: "same", x: 5, y: 5, width: 10, height: 10 },
        { id: "bad", x: 0, y: 0, width: -1, height: 10 },
      ],
      keyframes: [
        { id: "a", time: 1, centerX: 0, centerY: 0, frameHeight: 10 },
        { id: "b", time: 1, centerX: 1, centerY: 1, frameHeight: 20 },
        { id: "c", time: -1, centerX: 0, centerY: 0, frameHeight: 10 },
        { id: "past-end", time: 5, centerX: 0, centerY: 0, frameHeight: 10 },
      ],
    }, 4);
    expect(normalized?.aspectRatio).toBe("16:9");
    expect(normalized?.safeBounds).toHaveLength(1);
    expect(normalized?.keyframes.map(({ id }) => id)).toEqual(["a"]);
  });
});
