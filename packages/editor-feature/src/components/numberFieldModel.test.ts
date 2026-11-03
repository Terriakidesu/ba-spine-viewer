import { describe, expect, test } from "bun:test";
import { clampNumericValue, formatNumericValue, numericPrecision, parseNumericDraft, stepNumericValue } from "./numberFieldModel";

describe("numeric field model", () => {
  test("keeps empty and incomplete edits separate from numeric zero", () => {
    expect(parseNumericDraft("")).toBeNull();
    expect(parseNumericDraft("-" )).toBeNull();
    expect(parseNumericDraft("." )).toBeNull();
    expect(parseNumericDraft("0")).toBe(0);
    expect(parseNumericDraft("1.25")).toBe(1.25);
  });

  test("formats values using the precision implied by the step", () => {
    expect(numericPrecision(1)).toBe(0);
    expect(numericPrecision(0.05)).toBe(2);
    expect(numericPrecision(0.001)).toBe(3);
    expect(formatNumericValue(1.5, 3)).toBe("1.500");
  });

  test("clamps and rounds keyboard steps, including accelerated steps", () => {
    expect(clampNumericValue(12, { min: 0, max: 10 })).toBe(10);
    expect(stepNumericValue(0.1, 1, 0.05, { min: 0, max: 0.2 })).toBe(0.15);
    expect(stepNumericValue(0.15, 1, 0.05, { min: 0, max: 0.2 }, 10)).toBe(0.2);
    expect(stepNumericValue(0, -1, 1, { min: 0 })).toBe(0);
  });
});
