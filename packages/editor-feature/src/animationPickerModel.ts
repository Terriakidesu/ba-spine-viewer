export interface AnimationPickerOption {
  value: string;
  label: string;
}

export function includeMissingAnimationOption(
  options: readonly AnimationPickerOption[],
  value: string,
): AnimationPickerOption[] {
  if (!value || options.some((option) => option.value === value)) return [...options];
  return [...options, { value, label: `${value} · missing from rig` }];
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function matchRank(option: AnimationPickerOption, query: string): number {
  const value = normalized(option.value);
  const label = normalized(option.label);
  if (value === query || label === query) return 0;
  if (value.startsWith(query) || label.startsWith(query)) return 1;
  if (value.includes(query) || label.includes(query)) return 2;
  return Number.POSITIVE_INFINITY;
}

/** Rank matching animation names while retaining source order for ties. */
export function filterAnimationPickerOptions(
  options: readonly AnimationPickerOption[],
  query: string,
): AnimationPickerOption[] {
  const term = normalized(query);
  if (!term) return [...options];
  return options.map((option, index) => ({ option, index, rank: matchRank(option, term) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ option }) => option);
}
