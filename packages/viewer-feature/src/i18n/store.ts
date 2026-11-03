/**
 * Language store. Mirrors `theme.ts`: a tiny module-level external store,
 * no third-party state library.
 *
 * - Persisted in `localStorage` under `shittim-language`.
 * - Default derived from `navigator.languages` (ja* → ja, ko* → ko, else en),
 *   so switching must never touch simulator progress, banner selection or the
 *   Arona/Plana pick — it only changes text, dates and metadata.
 * - The read path is synchronous and reactive: `useLanguage()` subscribes via
 *   `useSyncExternalStore`, and every dictionary lookup goes through `t()`.
 */
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";
import type { Dictionary, Language } from "./types";

export const LANGUAGES: Language[] = ["en", "ja", "ko"];
export const LANGUAGE_STORAGE_KEY = "shittim-language";

export const DICTIONARIES: Record<Language, Dictionary> = { en, ja, ko };

const listeners = new Set<() => void>();
let language: Language = "en";

function readStorage(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null; // private browsing or storage disabled
  }
}

function writeStorage(value: Language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
  } catch {
    /* private browsing: in-memory choice only */
  }
}

function detectLanguage(): Language {
  const stored = readStorage();
  if (stored === "en" || stored === "ja" || stored === "ko") return stored;
  if (typeof navigator === "undefined") return "en";
  const preferences = [...(navigator.languages ?? []), navigator.language ?? ""];
  for (const preference of preferences) {
    if (!preference) continue;
    if (/^ja/i.test(preference)) return "ja";
    if (/^ko/i.test(preference)) return "ko";
  }
  return "en";
}

/** Preferred BCP-47 locale for Intl formatting (dates, month headings). */
export function localeFor(lang: Language = language): string {
  return lang === "ja" ? "ja-JP" : lang === "ko" ? "ko-KR" : "en-GB";
}

export function getLanguage(): Language {
  return language;
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLanguage(next: Language) {
  if (next === language) return;
  language = next;
  writeStorage(next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

export function initializeLanguage() {
  language = detectLanguage();
  if (typeof document !== "undefined") document.documentElement.lang = language;
}
