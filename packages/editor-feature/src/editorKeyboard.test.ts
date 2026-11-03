import { describe, expect, test } from "bun:test";
import { isTextEditingTarget } from "./editorKeyboard";

function elementTarget(options: { tagName?: string; type?: string; contentEditable?: string } = {}): EventTarget {
  const editable = options.contentEditable === undefined ? null : { getAttribute: () => options.contentEditable! };
  const field = options.tagName ? {
    tagName: options.tagName.toUpperCase(),
    getAttribute: (name: string) => name === "type" ? options.type ?? null : null,
  } : null;
  return {
    closest(selector: string) {
      if (selector === "[contenteditable]") return editable;
      if (selector === "input, textarea") return field;
      return null;
    },
  } as unknown as EventTarget;
}

describe("focus-safe editor shortcuts", () => {
  test("yields while editing text, numeric fields, textareas, and editable content", () => {
    expect(isTextEditingTarget(elementTarget({ tagName: "input", type: "text" }))).toBe(true);
    expect(isTextEditingTarget(elementTarget({ tagName: "input", type: "number" }))).toBe(true);
    expect(isTextEditingTarget(elementTarget({ tagName: "textarea" }))).toBe(true);
    expect(isTextEditingTarget(elementTarget({ contentEditable: "true" }))).toBe(true);
  });

  test("keeps shortcuts available for non-text controls and explicitly non-editable content", () => {
    expect(isTextEditingTarget(elementTarget({ tagName: "input", type: "range" }))).toBe(false);
    expect(isTextEditingTarget(elementTarget({ tagName: "input", type: "checkbox" }))).toBe(false);
    expect(isTextEditingTarget(elementTarget({ tagName: "select" }))).toBe(false);
    expect(isTextEditingTarget(elementTarget({ contentEditable: "false" }))).toBe(false);
    expect(isTextEditingTarget(null)).toBe(false);
  });
});
