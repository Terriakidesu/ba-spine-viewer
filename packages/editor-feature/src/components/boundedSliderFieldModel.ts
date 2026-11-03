import { clampNumericValue } from "./numberFieldModel";

export interface BoundedRange {
  min: number;
  max: number;
}

export function normalizeBoundedValue(value: unknown, fallback: number, bounds: BoundedRange): number {
  const finiteValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clampNumericValue(finiteValue, bounds);
}

export function nextBoundedCommit(value: number, current: number, bounds: BoundedRange): number | null {
  if (!Number.isFinite(value)) return null;
  const next = clampNumericValue(value, bounds);
  return next === current ? null : next;
}
