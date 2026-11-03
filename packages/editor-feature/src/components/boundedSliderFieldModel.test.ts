import { expect, test } from "bun:test";
import { nextBoundedCommit, normalizeBoundedValue } from "./boundedSliderFieldModel";

const bounds = { min: 0, max: 1 };

test("bounded controls normalize invalid and out-of-range values safely", () => {
  expect(normalizeBoundedValue(Number.NaN, 0.6, bounds)).toBe(0.6);
  expect(normalizeBoundedValue(-2, 0.6, bounds)).toBe(0);
  expect(normalizeBoundedValue(2, 0.6, bounds)).toBe(1);
});

test("bounded controls clamp commits and avoid duplicate no-op changes", () => {
  expect(nextBoundedCommit(0.4, 0.2, bounds)).toBe(0.4);
  expect(nextBoundedCommit(-2, 0, bounds)).toBeNull();
  expect(nextBoundedCommit(4, 1, bounds)).toBeNull();
  expect(nextBoundedCommit(Number.POSITIVE_INFINITY, 0.5, bounds)).toBeNull();
});
