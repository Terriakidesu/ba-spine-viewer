import { useSyncExternalStore } from "react";
import { getTheme, parseTheme, setTheme, subscribeTheme } from "../theme";
import { t, type LangKey } from "../i18n";

const OPTIONS: { value: string; key: LangKey }[] = [
  { value: "light", key: "settings.theme.light" },
  { value: "dark", key: "settings.theme.dark" },
  { value: "system", key: "settings.theme.system" },
];

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return <label className="theme-switch">{t("settings.theme")} <select aria-label={t("settings.theme")} value={theme} onChange={(event) => setTheme(parseTheme(event.target.value))}>
    {OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.key)}</option>)}
  </select></label>;
}
