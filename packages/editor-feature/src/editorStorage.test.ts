import { expect, test } from "bun:test";
import { editorProjectPath, editorProjectPaths, legacyEditorProjectPath } from "./editorStorage";

test("editor projects live in the root .editor directory while legacy files remain readable", () => {
  expect(editorProjectPath("Airi_home")).toBe(".editor/Airi_home.spine-project.json");
  expect(legacyEditorProjectPath("Airi_home")).toBe(".shittim-spine-editor/Airi_home.spine-project.json");
  expect(editorProjectPaths("Airi_home")).toEqual([
    ".editor/Airi_home.spine-project.json",
    ".shittim-spine-editor/Airi_home.spine-project.json",
  ]);
});

test("project filenames stay safe for nested asset directory names", () => {
  expect(editorProjectPath("Lobby/Airi home")).toBe(".editor/Lobby-Airi-home.spine-project.json");
});
