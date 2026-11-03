import { LANGUAGES, setLanguage, t, useLanguage, type LangKey, type Language } from "../i18n";

/**
 * Same visual slot as the theme switch (lobby toolbar, calendar topbar,
 * simulator header). Switching only changes display text and date formats —
 * never game state. Each option is written in its own language (`lang.*`), so
 * the list never needs re-translation.
 */
export function LanguageSwitch() {
  const language = useLanguage();
  return <label className="theme-switch lang-switch">{t("settings.language")} <select aria-label={t("settings.language")} value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
    {LANGUAGES.map((lang) => <option key={lang} value={lang}>{t(`lang.${lang}` as LangKey)}</option>)}
  </select></label>;
}
