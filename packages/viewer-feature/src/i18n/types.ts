import { en } from "./en";

export type Language = "en" | "ja" | "ko";

/** A translation key. `en` is the source of truth. */
export type LangKey = keyof typeof en;

/** A per-language dictionary: must define every source key. */
export type Dictionary = Record<LangKey, string>;

/** `{param}` interpolation values for `t()`. */
export type TParams = Record<string, string | number>;
