/**
 * Translation entry point.
 *
 * - `t(key, params?)` looks up the current language's dictionary with an
 *   English fallback and interpolates `{param}` placeholders.
 * - `message(lang, key)` reads a specific dictionary directly — used by
 *   `seo.ts`, which must localize off the *current* language without
 *   re-rendering a component tree.
 * - Name/type/school/club helpers centralize the localized-data lookups so
 *   components never branch on language themselves.
 * - `translateModelString` maps strings minted inside the pure model
 *   (`gachaRules.ts`, the exported forecast explanations) to dictionary keys,
 *   falling back to the original English text for anything unmapped.
 */
import { en } from "./en";
import { useSyncExternalStore } from "react";
import { DICTIONARIES, getLanguage, subscribeLanguage } from "./store";
import type { LangKey, Language, TParams } from "./types";

export * from "./store";
export * from "./types";

export function t(key: LangKey, params?: TParams): string {
  let text = DICTIONARIES[getLanguage()][key] ?? en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Re-render on language change — mirrors `subscribeTheme`/`getTheme` usage. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** Read a value from a specific language's dictionary (SEO metadata). */
export function message(lang: Language, key: LangKey): string {
  return DICTIONARIES[lang][key];
}

/* Weekday labels, Monday-first — arrays rather than keys because calendar
   headers need them in order and interpolation makes no sense here. */
const WEEKDAYS: Record<Language, readonly string[]> = {
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  ja: ["月", "火", "水", "木", "金", "土", "日"],
  ko: ["월", "화", "수", "목", "금", "토", "일"],
};

export function weekdays(): readonly string[] {
  return WEEKDAYS[getLanguage()];
}

/* Localized names ---------------------------------------------------------- */

export interface LocalizedName {
  name: string;
  nameJp?: string;
  nameKr?: string;
}

/** Character display name for the current language, English fallback. */
export function studentName(character: LocalizedName): string {
  const language = getLanguage();
  if (language === "ja") return character.nameJp || character.name;
  if (language === "ko") return character.nameKr || character.name;
  return character.name;
}

export interface LocalizedDialogue {
  recruitmentDialogue?: string;
  dialogueJp?: string;
  dialogueKr?: string;
}

/** Recruitment line for the current language. Japanese comes from the wiki's
    own lang="ja" cell and Korean from SchaleDB's transcription of the same
    clip; anything missing falls back to the English wiki text. */
export function studentDialogue(profile: LocalizedDialogue | undefined): string {
  if (!profile) return "";
  const language = getLanguage();
  if (language === "ja") return profile.dialogueJp || profile.recruitmentDialogue || "";
  if (language === "ko") return profile.dialogueKr || profile.recruitmentDialogue || "";
  return profile.recruitmentDialogue || "";
}

/** Banner label: localized featured names joined, falling back to banner code. */
export function bannerNames(
  banner: { characters?: readonly LocalizedName[]; code?: string | null },
  join = ", ",
): string {
  const list = banner.characters ?? [];
  if (!list.length) return banner.code || t("type.Unknown");
  return list.map(studentName).join(join);
}

/* Type / school / club glossaries ------------------------------------------- */

export function typeLabel(type: string): string {
  const key = `type.${type}` as LangKey;
  return key in en ? t(key) : type.replace(/Gacha$/, "");
}

export function schoolName(school: string): string {
  const key = `school.${school}` as LangKey;
  return key in en ? t(key) : school;
}

export function clubName(club: string): string {
  const key = `club.${club}` as LangKey;
  return key in en ? t(key) : club;
}

/* Model-minted strings ------------------------------------------------------ */

const MODEL_TEXT_KEYS: Record<string, LangKey> = {
  "Archive/select-pickup banners retain the 200-point exchange.": "sim.note.archive",
  "JP banner after the 5.5 Anniversary recruitment overhaul.": "sim.note.jpOverhaul",
  "Global historical banners use the 200-point system in this data set.": "sim.note.glHistorical",
  "Banner predates the Recruitment Charge overhaul.": "sim.note.preCharge",
  "This banner has no recruitable students in the historical pool.": "sim.err.emptyPool",
  "No limited 10-recruitment ticket available.": "sim.err.noTicket",
  "Recruitment tickets can only be used for ten-pulls.": "sim.err.tenOnly",
  "200 Recruitment Points are required to exchange.": "sim.err.noPoints",
  "Choose a student currently featured on this period.": "sim.err.notFeatured",
  "Confirmed in an official Blue Archive Global announcement on X/Twitter.": "cal.explanation.official",
  "Scheduled date recorded on the Blue Archive Wiki (not independently verified against an official announcement).": "cal.explanation.wikiScheduled",
};

/* `forecast.ts` builds explanations by concatenation; recognize the exact
   template and reassemble it from translated parts. */
const EXPLANATION_PATTERN =
  /^(Recent JP-to-Global lag|Recent lag trend|Batch alignment), snapped to the projected Global maintenance schedule\. (Range based on (\d+) historical update outcomes, with one-update safety padding\.|Conservative range: insufficient historical calibration\.)$/;

export function translateModelString(text: string): string {
  if (!text) return text;
  const exact = MODEL_TEXT_KEYS[text];
  if (exact) return t(exact);
  const match = EXPLANATION_PATTERN.exec(text);
  if (match) {
    const method =
      match[1] === "Recent JP-to-Global lag"
        ? "cal.explanation.method.recentLag"
        : match[1] === "Recent lag trend"
          ? "cal.explanation.method.lagTrend"
          : "cal.explanation.method.alignment";
    const range = match[2].startsWith("Range based on")
      ? t("cal.explanation.range.calibrated", { n: match[3] })
      : t("cal.explanation.range.uncalibrated");
    return t("cal.explanation.full", { method: t(method), range });
  }
  return text;
}
