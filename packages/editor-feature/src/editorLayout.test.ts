import { describe, expect, test } from "bun:test";
import { DEFAULT_EDITOR_LAYOUT_PREFERENCES, normalizeEditorLayoutPreferences } from "./editorLayout";

describe("editor layout preferences", () => {
  test("rejects malformed storage and normalizes a minimal object", () => {
    expect(normalizeEditorLayoutPreferences(null)).toBeNull();
    expect(normalizeEditorLayoutPreferences({})).toEqual(DEFAULT_EDITOR_LAYOUT_PREFERENCES);
  });

  test("clamps dimensions and preserves independent panel visibility", () => {
    expect(normalizeEditorLayoutPreferences({ preset: "custom", leftWidth: 900, rightWidth: 100, leftHidden: true })).toEqual({
      preset: "custom",
      leftWidth: 380,
      rightWidth: 260,
      leftHidden: true,
      rightHidden: false,
    });
  });
});
