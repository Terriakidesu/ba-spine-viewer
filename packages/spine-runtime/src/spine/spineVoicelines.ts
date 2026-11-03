import type { Language } from "../i18n";

export interface SpineVoiceSubtitle {
  en: string;
  ja: string;
  ko: string;
}

export interface SpineVoicePart {
  index: number;
  audio: string[];
  subtitle: SpineVoiceSubtitle;
  start?: number;
}

export interface SpineVoiceLine {
  id: string;
  audio: string[];
  JR: string;
  EN: string;
  KR: string;
  animation?: string;
  markers?: number[];
  parts?: SpineVoicePart[];
}

export interface SpineVoiceCharacter {
  character: string;
  variant: string;
  directory: string;
  wikiPage?: string;
  lines: SpineVoiceLine[];
}

export interface SpineVoiceManifest {
  schemaVersion: number;
  characters: SpineVoiceCharacter[];
}

export interface SpineVoiceCatalogEntry {
  character: string;
  variant: string;
  directory: string;
  file: string;
  audioDirectory?: string;
}

export interface SpineVoiceCatalog {
  schemaVersion: number;
  characters: SpineVoiceCatalogEntry[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function paths(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  return strings(value);
}

function relativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return normalized;
}

function subtitle(value: unknown): SpineVoiceSubtitle {
  if (!value || typeof value !== "object") return { en: "", ja: "", ko: "" };
  const item = value as Record<string, unknown>;
  return {
    en: text(item.en ?? item.EN),
    ja: text(item.ja ?? item.JR ?? item.JA),
    ko: text(item.ko ?? item.KR),
  };
}

function prefixAudio(path: string, audioDirectory: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!audioDirectory || normalized.includes("/")) return normalized;
  return `${audioDirectory.replaceAll("\\", "/").replace(/^\/|\/$/g, "")}/${normalized}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseParts(value: unknown, audioDirectory: string): SpineVoicePart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): SpineVoicePart[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const audio = paths(item.audio ?? item.files).map((path) => prefixAudio(path, audioDirectory));
    if (audio.length === 0) return [];
    const part = numberValue(item.index ?? item.part) ?? index + 1;
    const start = numberValue(item.start ?? item.time);
    return [{
      index: part,
      audio,
      subtitle: subtitle(item.subtitle ?? item.text),
      ...(start === undefined ? {} : { start }),
    }];
  });
}

function parseCharacter(value: unknown, audioDirectory = ""): SpineVoiceCharacter | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.character !== "string" || typeof item.directory !== "string" || !Array.isArray(item.lines)) return null;
  const resolvedAudioDirectory = audioDirectory || text(item.audioDirectory);
  const lines = item.lines.flatMap((candidate): SpineVoiceLine[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const line = candidate as Record<string, unknown>;
    if (typeof line.id !== "string") return [];
    const parts = parseParts(line.parts, resolvedAudioDirectory);
    // The legacy manifest uses arrays. Do not turn an invalid scalar into a
    // playable file just because the per-part format accepts a single path.
    const audio = (Array.isArray(line.audio) ? paths(line.audio) : []).map((path) => prefixAudio(path, resolvedAudioDirectory));
    const partAudio = parts.flatMap((part) => part.audio);
    const localized = subtitle(line.subtitle ?? line.text);
    const legacyEn = text(line.EN) || localized.en || parts.map((part) => part.subtitle.en).filter(Boolean).join("\n");
    const legacyJp = text(line.JR) || localized.ja || parts.map((part) => part.subtitle.ja).filter(Boolean).join("\n");
    const legacyKr = text(line.KR) || localized.ko || parts.map((part) => part.subtitle.ko).filter(Boolean).join("\n");
    const markers = Array.isArray(line.markers)
      ? line.markers.filter((marker): marker is number => typeof marker === "number" && Number.isFinite(marker))
      : parts.flatMap((part) => part.start === undefined ? [] : [part.start]);
    return [{
      id: line.id,
      audio: audio.length > 0 ? audio : partAudio,
      JR: legacyJp,
      EN: legacyEn,
      KR: legacyKr,
      ...(typeof line.animation === "string" ? { animation: line.animation } : {}),
      ...(markers.length > 0 ? { markers } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    }];
  });
  return {
    character: item.character,
    variant: typeof item.variant === "string" ? item.variant : "Base",
    directory: item.directory,
    ...(typeof item.wikiPage === "string" ? { wikiPage: item.wikiPage } : {}),
    lines,
  };
}

/** Parse the local manifest defensively: a missing or partial voice file must not block the viewer. */
export function parseVoiceManifest(value: unknown): SpineVoiceManifest | null {
  if (!value || typeof value !== "object") return null;
  const source = value as { schemaVersion?: unknown; characters?: unknown };
  if (!Array.isArray(source.characters)) return null;
  const characters = source.characters.flatMap((candidate): SpineVoiceCharacter[] => {
    const parsed = parseCharacter(candidate);
    return parsed ? [parsed] : [];
  });
  return {
    schemaVersion: typeof source.schemaVersion === "number" ? source.schemaVersion : 1,
    characters,
  };
}

/** Parse the dialogue-free index that points at one subtitle file per character folder. */
export function parseVoiceCatalog(value: unknown): SpineVoiceCatalog | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.characters)) return null;
  const characters = source.characters.flatMap((candidate): SpineVoiceCatalogEntry[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.character !== "string" || typeof item.directory !== "string") return [];
    const file = item.file ?? item.subtitle ?? item.subtitles;
    const safeFile = relativePath(file);
    if (!safeFile) return [];
    return [{
      character: item.character,
      variant: typeof item.variant === "string" ? item.variant : "Base",
      directory: item.directory,
      file: safeFile,
      ...(typeof item.audioDirectory === "string" && item.audioDirectory.length > 0 ? { audioDirectory: item.audioDirectory } : {}),
    }];
  });
  return {
    schemaVersion: typeof source.schemaVersion === "number" ? source.schemaVersion : 1,
    characters,
  };
}

export function parseVoiceCharacterFile(value: unknown, audioDirectory = ""): SpineVoiceCharacter | null {
  return parseCharacter(value, audioDirectory);
}

export function voiceCatalogEntryForDirectory(catalog: SpineVoiceCatalog | null, directory: string): SpineVoiceCatalogEntry | null {
  return catalog?.characters.find((character) => character.directory === directory) ?? null;
}

export function voiceCharacterForDirectory(manifest: SpineVoiceManifest | null, directory: string): SpineVoiceCharacter | null {
  return manifest?.characters.find((character) => character.directory === directory) ?? null;
}

/** The opening lobby voice is a separate trigger from the numbered Talk lines. */
export function introVoiceLineForCharacter(character: SpineVoiceCharacter | null): SpineVoiceLine | null {
  return character?.lines.find((line) => line.id.toLocaleLowerCase() === "memoriallobby_0" && line.audio.length > 0) ?? null;
}

function audioTag(path: string, tag: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return new RegExp(`_${tag}_`, "i").test(name);
}

/** Pick one installed voice pack instead of playing JP and GL files back-to-back. */
export function voiceLineForLanguage(line: SpineVoiceLine, language: Language): SpineVoiceLine {
  const global = line.audio.filter((path) => audioTag(path, "GL"));
  const korean = line.audio.filter((path) => audioTag(path, "KR"));
  const japanese = line.audio.filter((path) => audioTag(path, "JP"));
  const base = line.audio.filter((path) => !audioTag(path, "GL") && !audioTag(path, "KR") && !audioTag(path, "JP"));
  const audio = language === "en" && global.length > 0
    ? global
    : language === "ko" && korean.length > 0
      ? korean
      : language === "ja" && japanese.length > 0
        ? japanese
        : base.length > 0
          ? base
          : global.length > 0
            ? global
            : korean.length > 0
              ? korean
              : japanese.length > 0
                ? japanese
                : line.audio;
  if (audio === line.audio && !line.parts) return line;
  const selected = new Set(audio);
  const parts = line.parts?.map((part) => ({ ...part, audio: part.audio.filter((path) => selected.has(path)) })).filter((part) => part.audio.length > 0);
  return {
    ...line,
    audio,
    ...(parts && parts.length > 0 ? { parts } : {}),
  };
}

/** Match a Talk_# animation to its MemorialLobby_# voice line. */
export function voiceLineIndexForAnimation(lines: SpineVoiceLine[], animation: string, fallbackIndex: number): number {
  if (lines.length === 0) return -1;
  const match = animation.replaceAll("\\", "/").match(/(?:^|\/)talk[_ -]?(\d+)/i);
  const number = match ? Number(match[1]) : Number.NaN;
  if (Number.isFinite(number)) {
    const exact = lines.findIndex((line) => line.id.toLocaleLowerCase() === `memoriallobby_${number}`);
    if (exact >= 0) return exact;
    const numeric = lines.findIndex((line) => Number(line.id.match(/(\d+)$/)?.[1] ?? Number.NaN) === number);
    return numeric;
  }
  return ((fallbackIndex % lines.length) + lines.length) % lines.length;
}

/** MemorialLobby_0 is the intro trigger, never a Talk line. */
export function playableVoiceLines(character: SpineVoiceCharacter | null): SpineVoiceLine[] {
  return character?.lines
    .filter((line) => line.audio.length > 0 && line.id.toLocaleLowerCase() !== "memoriallobby_0")
    .sort((a, b) => {
      const aNumber = Number(a.id.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const bNumber = Number(b.id.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
      return aNumber - bNumber || a.id.localeCompare(b.id, undefined, { sensitivity: "base" });
    }) ?? [];
}

function localizedDialogue(line: SpineVoiceLine, language: Language): string {
  const localized = language === "ja" ? line.JR : language === "ko" ? line.KR : line.EN;
  return localized || line.EN || line.JR || line.KR;
}

function subtitleForLanguage(value: SpineVoiceSubtitle, language: Language): string {
  return language === "ja" ? value.ja : language === "ko" ? value.ko : value.en;
}

/**
 * Split a transcript into the clips that make up one lobby talk. Newlines are
 * clip boundaries when the source provides one line per audio file. When a
 * translation has a different number of lines, keep contiguous lines
 * together; unmatched trailing clips stay silent instead of repeating a
 * subtitle over audio that has no corresponding text.
 */
export function dialogueSegmentsForVoiceLine(line: SpineVoiceLine | undefined, language: Language): string[] {
  if (!line) return [];
  // A blank part is intentional: the source has more audio clips than
  // subtitle text. Do not fall back to another language here or make a
  // trailing clip appear to have a repeated subtitle.
  if (line.parts && line.parts.length > 0) return line.parts.map((part) => subtitleForLanguage(part.subtitle, language));
  const dialogue = localizedDialogue(line, language).replaceAll("\r\n", "\n").trim();
  if (!dialogue) return [];
  const parts = dialogue.split("\n").map((part) => part.trim()).filter(Boolean);
  const clipCount = Math.max(1, line.audio.length);
  if (clipCount === 1) return [dialogue];
  if (parts.length === 1) return [parts[0]!, ...Array.from({ length: clipCount - 1 }, () => "")];
  if (parts.length === clipCount) return parts;
  if (parts.length < clipCount) {
    return [...parts, ...Array.from({ length: clipCount - parts.length }, () => "")];
  }
  return Array.from({ length: clipCount }, (_, index) => {
    const start = Math.floor(index * parts.length / clipCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * parts.length / clipCount));
    return parts.slice(start, end).join("\n");
  });
}

export function dialogueForVoiceLine(line: SpineVoiceLine | undefined, language: Language, clipIndex = 0): string {
  const segments = dialogueSegmentsForVoiceLine(line, language);
  return segments[Math.min(Math.max(clipIndex, 0), Math.max(segments.length - 1, 0))] ?? "";
}
