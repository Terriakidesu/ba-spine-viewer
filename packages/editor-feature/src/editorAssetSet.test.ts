import { describe, expect, test } from "bun:test";
import { isEditorAssetSetReady, type EditorAssetSetReadiness } from "./editorAssetSet";

describe("Editor asset-set readiness", () => {
  const readyState: EditorAssetSetReadiness = {
    directory: "CH0307_home",
    projectDirectory: "CH0307_home",
    assetLoading: false,
    hasMeta: true,
    initialized: true,
    error: null,
  };

  test("does not treat a changed directory as loaded before its project initializes", () => {
    expect(isEditorAssetSetReady({
      ...readyState,
      projectDirectory: "Akane_home",
      initialized: false,
    }, "CH0307_home")).toBe(false);
  });

  test("waits for loading and metadata initialization", () => {
    expect(isEditorAssetSetReady({ ...readyState, assetLoading: true }, "CH0307_home")).toBe(false);
    expect(isEditorAssetSetReady({ ...readyState, hasMeta: false }, "CH0307_home")).toBe(false);
    expect(isEditorAssetSetReady({ ...readyState, initialized: false }, "CH0307_home")).toBe(false);
  });

  test("accepts only the fully initialized requested asset set", () => {
    expect(isEditorAssetSetReady(readyState, "CH0307_home")).toBe(true);
    expect(isEditorAssetSetReady(readyState, "Akane_home")).toBe(false);
    expect(isEditorAssetSetReady({ ...readyState, error: "Spine load failed" }, "CH0307_home")).toBe(false);
  });
});
