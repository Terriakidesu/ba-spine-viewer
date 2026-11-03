export interface CommandPaletteItem {
  id: string;
  title: string;
  description?: string;
  group?: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

export function filterCommandPaletteItems<T extends CommandPaletteItem>(items: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items
    .map((item, order) => {
      const fields = [item.title, item.description ?? "", item.group ?? "", ...(item.keywords ?? [])]
        .map((field) => field.toLocaleLowerCase());
      const rank = !normalizedQuery ? 0
        : fields.some((field) => field === normalizedQuery) ? 0
          : fields.some((field) => field.startsWith(normalizedQuery)) ? 1
            : fields.some((field) => field.includes(normalizedQuery)) ? 2
              : Number.POSITIVE_INFINITY;
      return { item, order, rank };
    })
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(({ item }) => item);
}

export function moveCommandPaletteIndex(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  const start = index < 0 ? (direction > 0 ? -1 : count) : index;
  return (start + direction + count) % count;
}

export function firstEnabledCommandIndex(items: readonly CommandPaletteItem[], start = 0, direction: -1 | 1 = 1): number {
  if (!items.length) return -1;
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (start + offset * direction + items.length * 2) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}
