import { expect, test } from "bun:test";
import { isEditorIgnored, parseEditorIgnore } from "./editorIgnore";

const rules = parseEditorIgnore(`
# Generated files
*.tmp
cache/
**/drafts/**
!**/cache/keep.atlas
`);

test("editorignore handles root-relative globs and descendants", () => {
  expect(isEditorIgnored("Airi_home/texture.tmp", rules)).toBe(true);
  expect(isEditorIgnored("Airi_home/cache", rules, true)).toBe(true);
  expect(isEditorIgnored("Airi_home/cache/keep.atlas", rules)).toBe(false);
  expect(isEditorIgnored("Airi_home/voice/drafts/line.ogg", rules)).toBe(true);
});

test("editorignore supports negation, question marks, and slash paths", () => {
  const parsed = parseEditorIgnore("temp/\n!temp/keep.txt\nvoice-?.ogg\n/Airi_home/hidden/**");
  expect(isEditorIgnored("temp", parsed, true)).toBe(true);
  expect(isEditorIgnored("temp/keep.txt", parsed)).toBe(false);
  expect(isEditorIgnored("voice-1.ogg", parsed)).toBe(true);
  expect(isEditorIgnored("voice-10.ogg", parsed)).toBe(false);
  expect(isEditorIgnored("Airi_home/hidden/file.json", parsed)).toBe(true);
  expect(isEditorIgnored("Other_home/hidden/file.json", parsed)).toBe(false);
});
