import { describe, expect, test } from "bun:test";
import type { EditorSubtitleCue } from "./editorModel";
import { searchSubtitleCues } from "./subtitleCueSearch";

const cues: EditorSubtitleCue[] = [
  { id: "later", start: 5, end: 6, enabled: true, text: { en: "Good morning", ja: "おはようございます", ko: "좋은 아침" } },
  { id: "first", start: 1, end: 2, enabled: true, text: { en: "Hello, Airi!", ja: "こんにちは", ko: "안녕, 아이리!" } },
  { id: "empty", start: 3, end: 4, enabled: true, text: { en: "", ja: "", ko: "" } },
  { id: "same-time", start: 1, end: 1.5, enabled: true, text: { en: "HELLO again", ja: "やあ", ko: "다시 안녕" } },
];

describe("subtitle cue search", () => {
  test("searches all translations case-insensitively and returns chronological cues once", () => {
    expect(searchSubtitleCues(cues, "  hello ")).toEqual([
      { cue: cues[1], matches: [{ language: "en", text: "Hello, Airi!" }] },
      { cue: cues[3], matches: [{ language: "en", text: "HELLO again" }] },
    ]);
  });

  test("restricts matches to the requested subtitle language", () => {
    expect(searchSubtitleCues(cues, "안녕", "ko").map(({ cue, matches }) => [cue.id, matches.map(({ language }) => language)])).toEqual([
      ["first", ["ko"]],
      ["same-time", ["ko"]],
    ]);
    expect(searchSubtitleCues(cues, "こんにちは", "en")).toEqual([]);
  });

  test("supports normalized full-width text and returns no results for blank input", () => {
    expect(searchSubtitleCues(cues, "ｇｏｏｄ", "en").map(({ cue }) => cue.id)).toEqual(["later"]);
    expect(searchSubtitleCues(cues, "  \t  ")).toEqual([]);
  });
});
