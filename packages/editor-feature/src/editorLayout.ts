export type WorkspaceLayoutPreset = "balanced" | "canvas-focus" | "timeline-focus" | "custom";

export interface EditorLayoutPreferences {
  preset: WorkspaceLayoutPreset;
  leftWidth: number;
  rightWidth: number;
  leftHidden: boolean;
  rightHidden: boolean;
}

export const EDITOR_LAYOUT_PREFERENCES_KEY = "shittim-spine-editor:layout-preferences:v1";

export const DEFAULT_EDITOR_LAYOUT_PREFERENCES: EditorLayoutPreferences = {
  preset: "balanced",
  leftWidth: 220,
  rightWidth: 320,
  leftHidden: false,
  rightHidden: false,
};

function boundedWidth(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : fallback;
}

export function normalizeEditorLayoutPreferences(value: unknown): EditorLayoutPreferences | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<EditorLayoutPreferences>;
  const preset = raw.preset === "canvas-focus" || raw.preset === "timeline-focus" || raw.preset === "custom" ? raw.preset : "balanced";
  return {
    preset,
    leftWidth: boundedWidth(raw.leftWidth, 160, 380, DEFAULT_EDITOR_LAYOUT_PREFERENCES.leftWidth),
    rightWidth: boundedWidth(raw.rightWidth, 260, 460, DEFAULT_EDITOR_LAYOUT_PREFERENCES.rightWidth),
    leftHidden: raw.leftHidden === true,
    rightHidden: raw.rightHidden === true,
  };
}
