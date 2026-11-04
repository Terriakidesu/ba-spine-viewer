import { describe, expect, test } from "bun:test";
import { cameraAspectValue, cameraFrameHeightForBound, cameraKeyframeTimeAvailable, changeSpineCameraAspectRatio, defaultSpineCameraSample, evaluateSpineCameraTrack, moveSpineCameraBound, moveSpineCameraKeyframe, normalizeSpineCameraTrack, resizeSpineCameraBound, resizeSpineCameraKeyframe, retimeSpineCameraKeyframe, sampleSpineCameraTrack, sampleSpineCameraTrackWithFallback, solveSpineCamera, spineCameraBoundFromCanvasDrag, type SpineCameraTrack } from "./spineCameraMotion";

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
    const sampled = sampleSpineCameraTrack(value, 1);
    expect(sampled).toMatchObject({ centerX: 50, centerY: 25, frameHeight: 150, constraint: { mode: "automatic" } });
    expect(sampled?.frameWidth).toBeCloseTo(800 / 3);
    value.keyframes[0]!.easing = "hold";
    expect(sampleSpineCameraTrack(value, 1)?.centerX).toBe(0);
    value.keyframes[0]!.easing = "smooth";
    expect(sampleSpineCameraTrack(value, 0.5)?.centerX).toBeCloseTo(15.625);
  });

  test("uses the full-artwork fit to preview and constrain bounds before any shot is authored", () => {
    const value = track({
      keyframes: [],
      safeBounds: [{ id: "room", name: "Room", x: -100, y: -60, width: 200, height: 120, enabled: true }],
    });
    expect(sampleSpineCameraTrack(value, 0)).toBeNull();
    const fallback = defaultSpineCameraSample(value, { centerX: 0, centerY: 0, height: 200 });
    expect(fallback).toMatchObject({ centerX: 0, centerY: 0, frameHeight: 200, constraint: { mode: "automatic" } });
    expect(fallback?.frameWidth).toBeCloseTo(200 * 16 / 9);
    const solved = solveSpineCamera(fallback!, value, 16, 9)!;
    expect(solved.activeBoundId).toBe("room");
    expect(solved.frame.width).toBeCloseTo(200);
    expect(solved.frame.height).toBeCloseTo(112.5);
  });

  test("uses identical default camera sampling for Editor and Viewer before a shot exists", () => {
    const value = track({ keyframes: [], safeBounds: [] });
    const frame = { centerX: 25, centerY: 40, height: 180 };
    expect(sampleSpineCameraTrackWithFallback(value, 0, frame)).toMatchObject({
      centerX: 25,
      centerY: 40,
      frameHeight: 180,
      constraint: { mode: "automatic" },
    });
    expect(sampleSpineCameraTrackWithFallback({ ...value, enabled: false }, 0, frame)).toBeNull();
    expect(sampleSpineCameraTrackWithFallback(track(), 1, frame)?.centerX).toBe(50);
  });

  test("shared Editor and Viewer evaluation produces the same world frame across viewport sizes", () => {
    const value = track({ keyframes: [], safeBounds: [{ id: "room", name: "Room", x: -120, y: -80, width: 240, height: 160, enabled: true }] });
    const frame = { centerX: 5, centerY: 10, height: 180 };
    const editor = evaluateSpineCameraTrack(value, 0, 1, 1, frame)!;
    const viewer = evaluateSpineCameraTrack(value, 0, 1600, 900, frame)!;
    expect(viewer.frame).toEqual(editor.frame);
    expect(viewer.activeBoundId).toBe(editor.activeBoundId);
    expect(viewer.pose.zoom).not.toBe(editor.pose.zoom);
  });

  test("preserves authored world width across output ratios while boundaries cap the fit", () => {
    const value = track({
      aspectRatio: "16:9",
      constraint: { mode: "manual", boundId: "room" },
      safeBounds: [{ id: "room", name: "Room", x: -200, y: -200, width: 400, height: 400, enabled: true }],
      keyframes: [{ id: "wide", time: 0, centerX: 0, centerY: 0, frameHeight: 90 }],
    });
    const sampled = sampleSpineCameraTrack(value, 0)!;
    const square = solveSpineCamera(sampled, { ...value, aspectRatio: "1:1" }, 900, 900)!;
    expect(sampled.frameWidth).toBeCloseTo(160);
    expect(square.frame.width).toBeCloseTo(160);
    expect(square.frame.height).toBeCloseTo(160);
    expect(cameraFrameHeightForBound({ width: 400, height: 120 }, "1:1")).toBe(120);

    const fitHeight = cameraFrameHeightForBound(value.safeBounds[0]!, value.aspectRatio);
    const fitted = solveSpineCamera(
      { ...sampled, frameHeight: fitHeight, frameWidth: fitHeight * 16 / 9 },
      { ...value, aspectRatio: "1:1" },
      900,
      900,
    )!;
    expect(fitted.frame.width).toBe(400);
    expect(fitted.frame.height).toBe(400);

    const shortBound = { ...value, safeBounds: [{ id: "room", name: "Room", x: -200, y: -60, width: 400, height: 120, enabled: true }] };
    const constrained = solveSpineCamera(sampled, { ...shortBound, aspectRatio: "1:1" }, 900, 900)!;
    expect(constrained.frame.width).toBe(120);
    expect(constrained.frame.height).toBe(120);
    expect(constrained.frame.centerY - constrained.frame.height / 2).toBeGreaterThanOrEqual(-60);
    expect(constrained.frame.centerY + constrained.frame.height / 2).toBeLessThanOrEqual(60);
  });

  test("changes authored output ratio by fitting shots to width for the shared Viewer camera path", () => {
    const original = track({
      aspectRatio: "16:9",
      constraint: { mode: "none" },
      keyframes: [
        { id: "wide", time: 0, centerX: 18, centerY: 24, frameHeight: 90, easing: "smooth" },
        { id: "close", time: 2, centerX: -8, centerY: 10, frameHeight: 45, constraint: { mode: "manual", boundId: "room" } },
      ],
    });

    const square = changeSpineCameraAspectRatio(original, "1:1");
    expect(square.aspectRatio).toBe("1:1");
    expect(square.keyframes.map((keyframe) => keyframe.frameHeight)).toEqual([160, 80]);
    expect(square.keyframes.map(({ centerX, centerY }) => [centerX, centerY])).toEqual([[18, 24], [-8, 10]]);
    expect(square.keyframes[1]?.constraint).toEqual({ mode: "manual", boundId: "room" });
    expect(original.keyframes[0]?.frameHeight).toBe(90);

    const viewerFrame = evaluateSpineCameraTrack(square, 0, 1600, 900, null)!;
    expect(viewerFrame.frame).toEqual({ centerX: 18, centerY: 24, width: 160, height: 160 });

    const boundedSquare = changeSpineCameraAspectRatio(track({
      aspectRatio: "16:9",
      constraint: { mode: "manual", boundId: "room" },
      safeBounds: [{ id: "room", name: "Room", x: -200, y: -60, width: 400, height: 120, enabled: true }],
      keyframes: [{ id: "bounded", time: 0, centerX: 0, centerY: 0, frameHeight: 90 }],
    }), "1:1");
    const boundedViewerFrame = evaluateSpineCameraTrack(boundedSquare, 0, 1600, 900, null)!;
    expect(boundedViewerFrame.frame).toMatchObject({ width: 120, height: 120 });

    const wideAgain = changeSpineCameraAspectRatio(square, "4:3");
    expect(wideAgain.keyframes[0]?.frameHeight).toBeCloseTo(120);
    expect(wideAgain.keyframes[0]!.frameHeight * cameraAspectValue(wideAgain.aspectRatio)).toBeCloseTo(160);
  });

  test("moves and resizes selected boundaries in stable world coordinates", () => {
    const bound = { id: "room", name: "Room", x: 10, y: 20, width: 100, height: 80, enabled: true };
    expect(moveSpineCameraBound(bound, -5, 7)).toMatchObject({ x: 5, y: 27, width: 100, height: 80 });
    expect(resizeSpineCameraBound(bound, "se", { x: 130, y: 10 })).toMatchObject({ x: 10, y: 10, width: 120, height: 90 });
    expect(resizeSpineCameraBound(bound, "nw", { x: 150, y: 50 }, 5)).toMatchObject({ x: 105, y: 20, width: 5, height: 30 });
    const locked = resizeSpineCameraBound(bound, "se", { x: 180, y: -90 }, 0.01, 16 / 9);
    expect(locked.width / locked.height).toBeCloseTo(16 / 9);
    expect(locked.x).toBe(bound.x);
    expect(locked.y + locked.height).toBe(bound.y + bound.height);
  });

  test("optionally locks a drawn boundary to the selected output ratio", () => {
    const bound = spineCameraBoundFromCanvasDrag("locked", "Locked", { x: 0, y: 0 }, { x: 300, y: 200 }, { centerX: 0, centerY: 0, height: 200 }, 300, 200, 0, 16 / 9)!;
    expect(bound.width / bound.height).toBeCloseTo(16 / 9);
    expect(bound.x).toBeCloseTo(-150);
    expect(bound.y + bound.height).toBeCloseTo(100);
  });

  test("moves and resizes an existing shot without changing its identity, time or ratio", () => {
    const keyframe = { id: "selected", time: 4, centerX: 10, centerY: 20, frameHeight: 30, easing: "smooth" as const };
    expect(moveSpineCameraKeyframe(keyframe, 5, -7)).toMatchObject({ id: "selected", time: 4, centerX: 15, centerY: 13, frameHeight: 30 });
    const resized = resizeSpineCameraKeyframe(keyframe, "se", { x: 196.6666666667, y: -85 }, 16 / 9);
    expect(resized.id).toBe("selected");
    expect(resized.time).toBe(4);
    expect(resized.easing).toBe("smooth");
    expect(resized.frameHeight).toBeCloseTo(120);
    expect(resized.frameHeight * 16 / 9).toBeCloseTo(213.3333333333);
  });

  test("retimes shots with clamping, identity preservation, and explicit collision checks", () => {
    const keys = [
      { id: "one", time: 0, centerX: 0, centerY: 0, frameHeight: 20 },
      { id: "two", time: 2, centerX: 10, centerY: 5, frameHeight: 30, easing: "hold" as const },
    ];
    expect(cameraKeyframeTimeAvailable(keys, "one", 2)).toBe(false);
    expect(cameraKeyframeTimeAvailable(keys, "one", 1.9995)).toBe(false);
    expect(cameraKeyframeTimeAvailable(keys, "one", 1.998)).toBe(true);
    expect(retimeSpineCameraKeyframe(keys[1]!, 1.25, 4)).toMatchObject({ id: "two", time: 1.25, centerX: 10, easing: "hold" });
    expect(retimeSpineCameraKeyframe(keys[1]!, -1, 4)?.time).toBe(0);
    expect(retimeSpineCameraKeyframe(keys[1]!, 8, 4)?.time).toBe(4);
    expect(retimeSpineCameraKeyframe(keys[1]!, 1, Number.NaN)).toBeNull();
  });

  test("switches per-keyframe scene assignments at the exact shot boundary", () => {
    const value = track({
      keyframes: [
        { id: "first", time: 0, centerX: 0, centerY: 0, frameHeight: 50, constraint: { mode: "manual", boundId: "room-a" } },
        { id: "second", time: 1, centerX: 100, centerY: 0, frameHeight: 50, constraint: { mode: "manual", boundId: "room-b" } },
      ],
    });
    expect(sampleSpineCameraTrack(value, 0.999)?.constraint).toEqual({ mode: "manual", boundId: "room-a" });
    expect(sampleSpineCameraTrack(value, 1)?.constraint).toEqual({ mode: "manual", boundId: "room-b" });
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
      referenceLayerId: " scene-layer ",
      safeBounds: [
        { id: "same", x: 0, y: 0, width: 10, height: 10, visible: false },
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
    expect(normalized?.referenceLayerId).toBe("scene-layer");
    expect(normalized?.safeBounds).toHaveLength(1);
    expect(normalized?.safeBounds[0]?.visible).toBe(false);
    expect(normalized?.keyframes.map(({ id }) => id)).toEqual(["a"]);
  });

  test("camera settings and authored motion survive serialization normalization round-trip", () => {
    const value = track({
      enabled: false,
      aspectRatio: "4:3",
      referenceLayerId: "reference-scene",
      constraint: { mode: "manual", boundId: "room" },
      safeBounds: [{ id: "room", name: "Room", x: -40, y: -20, width: 80, height: 60, enabled: true, visible: false, locked: true, priority: 3 }],
      keyframes: [
        { id: "first", time: 0.5, centerX: 10, centerY: 20, frameHeight: 30, easing: "smooth", constraint: { mode: "manual", boundId: "room" } },
        { id: "second", time: 2.5, centerX: 15, centerY: 25, frameHeight: 35, easing: "hold", constraint: { mode: "none" } },
      ],
    });
    const decoded = normalizeSpineCameraTrack(JSON.parse(JSON.stringify(value)), 5);
    const reloaded = normalizeSpineCameraTrack(JSON.parse(JSON.stringify(decoded)), 5);
    expect(decoded).toEqual(value);
    expect(reloaded).toEqual(decoded);
  });
});
