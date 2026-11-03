import type { EditorSubtitleCue, TimelineLanguage } from "./editorModel";

export type SubtitleSearchLanguage = TimelineLanguage | "all";

export interface SubtitleCueSearchMatch {
  cue: EditorSubtitleCue;
  matches: Array<{ language: TimelineLanguage; text: string }>;
}

const LANGUAGES: readonly TimelineLanguage[] = ["en", "ja", "ko"];

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Search one selected language or all translations, returning each matching cue once in timeline order. */
export function searchSubtitleCues(
  cues: readonly EditorSubtitleCue[],
  query: string,
  language: SubtitleSearchLanguage = "all",
): SubtitleCueSearchMatch[] {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return [];

  return cues.map((cue, index) => ({
    cue,
    index,
    matches: LANGUAGES
      .filter((item) => language === "all" || item === language)
      .map((item) => ({ language: item, text: cue.text[item] }))
      .filter(({ text }) => normalizeSearchText(text).includes(normalizedQuery)),
  }))
    .filter(({ matches }) => matches.length > 0)
    .sort((a, b) => a.cue.start - b.cue.start || a.index - b.index)
    .map(({ cue, matches }) => ({ cue, matches }));
}
