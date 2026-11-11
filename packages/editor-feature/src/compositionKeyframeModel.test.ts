import { expect, test } from "bun:test";
import { clampCompositionKeyDelta, frameSnappedCompositionKeyDelta, moveCompositionKeyLocations, snapCompositionTimeToFrame } from "./compositionKeyframeModel";

test("composition keyframe tools snap to frames and clamp a multi-key move to every owning range", () => {
  expect(snapCompositionTimeToFrame(1.01, 30)).toBeCloseTo(1);
  expect(snapCompositionTimeToFrame(1.02, 30)).toBeCloseTo(31 / 30);
  expect(frameSnappedCompositionKeyDelta(1.01, 1, 30)).toBeCloseTo(1 / 30 - 0.01);
  expect(frameSnappedCompositionKeyDelta(1.02, -1, 30)).toBeCloseTo(-0.02);

  const selected = [
    { trackId: "global", key: { id: "a", time: 1, value: 0, interpolation: "linear" as const }, globalTime: 1, minimumGlobalTime: 0, maximumGlobalTime: 10 },
    { trackId: "local", key: { id: "b", time: 1, value: 1, interpolation: "linear" as const }, globalTime: 5, minimumGlobalTime: 4, maximumGlobalTime: 6 },
  ];
  expect(clampCompositionKeyDelta(selected, 3)).toBe(1);
  expect(clampCompositionKeyDelta(selected, -3)).toBe(-1);
  expect(clampCompositionKeyDelta([
    { ...selected[0]!, globalTime: 1, minimumGlobalTime: 0, maximumGlobalTime: 1.2 },
    { ...selected[1]!, globalTime: 1.5, minimumGlobalTime: 2, maximumGlobalTime: 3 },
  ], 1)).toBe(0);
  expect(moveCompositionKeyLocations(selected, 1).map(({ trackId, key }) => [trackId, key.time])).toEqual([
    ["global", 2],
    ["local", 2],
  ]);
});
