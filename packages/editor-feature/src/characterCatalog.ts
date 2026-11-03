export type CharacterDirectoryLabels = Readonly<Record<string, string>>;

interface CharacterVariantRecord {
  variant?: unknown;
  directory?: unknown;
  assetId?: unknown;
  role?: unknown;
}

interface CharacterExtraRecord {
  type?: unknown;
  directory?: unknown;
}

interface CharacterRecord {
  variants?: unknown;
  extras?: unknown;
  role?: unknown;
}

export type AssetSetKind = "character" | "scene" | "background" | "other";

export interface CharacterDirectoryInfo {
  label: string;
  group: string;
  kind: AssetSetKind;
  role?: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function prettyExtraType(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function kindForExtra(type: string | null): AssetSetKind {
  const normalized = type?.toLocaleLowerCase().replace(/[-_]+/g, " ") ?? "";
  if (/scene|cutscene/.test(normalized)) return "scene";
  if (/background|backdrop|bg/.test(normalized)) return "background";
  return "other";
}

/** Parse friendly labels and grouping metadata from a local ba-spine catalog. */
export function parseCharacterDirectoryCatalog(value: unknown): Record<string, CharacterDirectoryInfo> {
  if (!value || typeof value !== "object") return {};
  const root = value as { characters?: unknown };
  if (!root.characters || typeof root.characters !== "object" || Array.isArray(root.characters)) return {};

  const directories: Record<string, CharacterDirectoryInfo> = {};
  for (const [name, rawCharacter] of Object.entries(root.characters as Record<string, unknown>)) {
    if (!rawCharacter || typeof rawCharacter !== "object" || Array.isArray(rawCharacter)) continue;
    const character = rawCharacter as CharacterRecord;
    if (Array.isArray(character.variants)) {
      for (const rawVariant of character.variants) {
        if (!rawVariant || typeof rawVariant !== "object" || Array.isArray(rawVariant)) continue;
        const variant = rawVariant as CharacterVariantRecord;
        const directory = text(variant.directory);
        if (!directory) continue;
        const assetId = text(variant.assetId);
        const variantName = text(variant.variant);
        const role = text(variant.role) ?? text(character.role);
        directories[directory] = {
          label: `${name}${variantName && variantName !== "Base" ? ` ${variantName}` : ""}${assetId ? ` (${assetId})` : ""}`,
          group: name,
          kind: "character",
          ...(role ? { role } : {}),
        };
      }
    }
    if (Array.isArray(character.extras)) {
      for (const rawExtra of character.extras) {
        if (!rawExtra || typeof rawExtra !== "object" || Array.isArray(rawExtra)) continue;
        const extra = rawExtra as CharacterExtraRecord;
        const directory = text(extra.directory);
        if (!directory) continue;
        const type = text(extra.type);
        directories[directory] = {
          label: type ? `${name} ${prettyExtraType(type)}` : name,
          group: name,
          kind: kindForExtra(type),
          ...(type ? { role: prettyExtraType(type) } : {}),
        };
      }
    }
  }
  return directories;
}

/** Build display names for asset directories from a ba-spine character catalog. */
export function parseCharacterDirectoryLabels(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(parseCharacterDirectoryCatalog(value)).map(([directory, info]) => [directory, info.label]));
}

export function characterDirectoryLabel(directory: string, labels: CharacterDirectoryLabels): string {
  return labels[directory] ?? directory;
}
