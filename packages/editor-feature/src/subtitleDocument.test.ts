import { expect, test } from "bun:test";
import { createProject } from "./editorModel";
import { serializeSubtitleDocument } from "./subtitleDocument";

test("subtitle direct-save serialization updates matching parts without mutating the imported document", () => {
  const document = {
    characters: [{
      directory: "Airi_home",
      lines: [{
        id: "talk-1",
        parts: [{ subtitle: { en: "Old one" }, start: 0, end: 1 }, { subtitle: { en: "Old two" }, start: 1, end: 2 }],
      }, { id: "untouched", subtitle: { en: "Keep me" } }],
    }],
  };
  const first = createProject("Airi_home", [], []).timeline;
  first.subtitles = [
    { id: "cue-1", lineId: "talk-1", start: 0.25, end: 1.5, enabled: true, text: { en: "New one", ja: "新しい一", ko: "새 하나" } },
    { id: "cue-2", lineId: "talk-1", start: 1.6, end: 3.25, enabled: true, text: { en: "New two", ja: "新しい二", ko: "새 둘" } },
  ];
  const second = createProject("Airi_home", [], []).timeline;
  second.subtitles = [{ id: "cue-3", lineId: "untouched", start: 4, end: 5, enabled: true, text: { en: "Moved", ja: "", ko: "" } }];

  const saved = JSON.parse(serializeSubtitleDocument(document, "Airi_home", [first, second])) as {
    characters: Array<{ lines: Array<{ parts?: Array<Record<string, unknown>>; subtitle?: Record<string, string>; markers?: number[] }> }>;
  };
  const parts = saved.characters[0]!.lines[0]!.parts!;
  expect(parts[0]).toMatchObject({ start: 0.25, end: 1.5, subtitle: { en: "New one", ja: "新しい一", ko: "새 하나" } });
  expect(parts[1]).toMatchObject({ start: 1.6, end: 3.25, subtitle: { en: "New two", ja: "新しい二", ko: "새 둘" } });
  expect(saved.characters[0]!.lines[0]!.markers).toEqual([0.25, 1.6]);
  expect(saved.characters[0]!.lines[1]!.subtitle).toMatchObject({ en: "Moved" });
  expect(document.characters[0]!.lines[0]!.parts![0]!.subtitle).toEqual({ en: "Old one" });

  first.subtitles[0]!.text.en = "Newest one";
  const savedAgain = JSON.parse(serializeSubtitleDocument(saved, "Airi_home", [first, second])) as typeof saved;
  expect(savedAgain.characters[0]!.lines[0]!.parts![0]!.subtitle).toMatchObject({ en: "Newest one" });
});

test("subtitle serialization removes duplicate same-start parts that would overlap audio", () => {
  const document = {
    directory: "Airi_home",
    lines: [{
      id: "MemorialLobby_1",
      parts: [
        { audio: ["Airi_MemorialLobby_1_1.ogg"], subtitle: { en: "Same line" }, start: 1.333333, end: 1.383333 },
        { audio: ["Airi_MemorialLobby_1_2.ogg"], subtitle: { en: "Same line" }, start: 1.333333, end: 3.333333 },
      ],
    }],
  };
  const timeline = createProject("Airi_home", [], []).timeline;
  timeline.subtitles = [{ id: "cue", lineId: "MemorialLobby_1", start: 1.333333, end: 3.333333, enabled: true, text: { en: "Same line", ja: "", ko: "" } }];
  const saved = JSON.parse(serializeSubtitleDocument(document, "Airi_home", [timeline])) as { lines: Array<{ parts: Array<Record<string, unknown>> }> };
  expect(saved.lines[0]!.parts).toHaveLength(1);
  expect(saved.lines[0]!.parts[0]).toMatchObject({ audio: ["Airi_MemorialLobby_1_2.ogg"], start: 1.333333, end: 3.333333 });
});

test("subtitle serialization repairs duplicate parts even when a line has no edited cue", () => {
  const document = {
    lines: [{
      id: "MemorialLobby_1",
      parts: [
        { audio: ["short.ogg"], subtitle: { en: "Same line" }, start: 1, end: 1.1 },
        { audio: ["long.ogg"], subtitle: { en: "Same line" }, start: 1, end: 2 },
      ],
    }],
  };
  const saved = JSON.parse(serializeSubtitleDocument(document, "Airi_home", [])) as { lines: Array<{ parts: Array<Record<string, unknown>> }> };
  expect(saved.lines[0]!.parts).toEqual([{ audio: ["long.ogg"], subtitle: { en: "Same line" }, start: 1, end: 2 }]);
  expect(document.lines[0]!.parts).toHaveLength(2);
});

test("subtitle serialization ignores a stale duplicate of the active sequence", () => {
  const document = {
    lines: [{
      id: "MemorialLobby_1",
      parts: [{ audio: ["voice.ogg"], subtitle: { en: "Same line" }, start: 1, end: 3 }],
    }],
  };
  const active = createProject("Airi_home", [], []).timeline;
  active.sequenceId = "talk-1";
  active.subtitles = [{ id: "active", lineId: "MemorialLobby_1", start: 1, end: 3, enabled: true, text: { en: "Same line", ja: "", ko: "" } }];
  const stale = createProject("Airi_home", [], []).timeline;
  stale.sequenceId = "talk-1";
  stale.subtitles = [{ id: "stale", lineId: "MemorialLobby_1", start: 1, end: 1.1, enabled: true, text: { en: "Same line", ja: "", ko: "" } }];
  const saved = JSON.parse(serializeSubtitleDocument(document, "Airi_home", [active, stale])) as { lines: Array<{ parts: Array<Record<string, unknown>> }> };
  expect(saved.lines[0]!.parts).toHaveLength(1);
  expect(saved.lines[0]!.parts[0]).toMatchObject({ start: 1, end: 3 });
});
