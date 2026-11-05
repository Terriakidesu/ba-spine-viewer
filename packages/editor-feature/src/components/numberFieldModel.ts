export interface NumericBounds {
  min?: number;
  max?: number;
}

export function parseNumericDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function numericPrecision(step: number): number {
  const decimal = String(step).split(".")[1]?.length ?? 0;
  return Math.min(6, decimal);
}

export function clampNumericValue(value: number, bounds: NumericBounds = {}): number {
  const lower = bounds.min === undefined ? Number.NEGATIVE_INFINITY : bounds.min;
  const upper = bounds.max === undefined ? Number.POSITIVE_INFINITY : bounds.max;
  return Math.min(upper, Math.max(lower, value));
}

export function formatNumericValue(value: number, precision: number): string {
  return precision > 0 ? value.toFixed(precision) : String(Math.round(value));
}

export function stepNumericValue(
  value: number,
  direction: -1 | 1,
  step: number,
  bounds: NumericBounds = {},
  multiplier = 1,
): number {
  const precision = Math.max(numericPrecision(step), numericPrecision(step * multiplier));
  const next = clampNumericValue(value + direction * step * multiplier, bounds);
  return Number(next.toFixed(precision));
}
