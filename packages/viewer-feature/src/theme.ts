export type ThemePreference = "light" | "dark" | "system";
const KEY = "shittim-theme";
let preference: ThemePreference = "system";

export function parseTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveTheme(value: ThemePreference, systemDark: boolean) {
  return value === "system" ? (systemDark ? "dark" : "light") : value;
}
function applyTheme() {
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolveTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
  window.dispatchEvent(new Event("shittim-theme-change"));
}
export function initializeTheme() {
  try { preference = parseTheme(localStorage.getItem(KEY)); } catch { /* Private browsing follows system. */ }
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) { preference = parseTheme(event.newValue); applyTheme(); }
  });
}
export function setTheme(value: ThemePreference) {
  preference = value;
  try { localStorage.setItem(KEY, value); } catch { /* Keep the in-memory choice. */ }
  applyTheme();
}
export function subscribeTheme(listener: () => void) {
  window.addEventListener("shittim-theme-change", listener);
  return () => window.removeEventListener("shittim-theme-change", listener);
}
export function getTheme() { return preference; }
export function getResolvedTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
