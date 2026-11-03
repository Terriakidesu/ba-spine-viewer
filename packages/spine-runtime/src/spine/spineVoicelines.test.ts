import { describe, expect, test } from "bun:test";
import { dialogueForVoiceLine, dialogueSegmentsForVoiceLine, introVoiceLineForCharacter, parseVoiceCatalog, parseVoiceCharacterFile, parseVoiceManifest, playableVoiceLines, voiceCatalogEntryForDirectory, voiceCharacterForDirectory, voiceLineForLanguage, voiceLineIndexForAnimation } from "./spineVoicelines";

describe("Spine voice manifests", () => {
  test("parses valid records and ignores malformed entries", () => {
    const manifest = parseVoiceManifest({
      schemaVersion: 3,
      characters: [
        {
          character: "Airi",
          variant: "Base",
          directory: "Airi_home",
          lines: [
            { id: "MemorialLobby_2", audio: ["Airi/two.ogg"], JR: "二", EN: "Two", KR: "둘" },
            { id: "MemorialLobby_1", audio: ["Airi/one.ogg"], JR: "一", EN: "One", KR: "하나" },
            { id: "MemorialLobby_0", audio: ["Airi/empty.ogg"], JR: "", EN: "", KR: "" },
            { id: "MemorialLobby_ignored", audio: "not-an-array", JR: null, EN: 3, KR: "" },
            { id: 7, audio: [], JR: "", EN: "", KR: "" },
          ],
        },
        null,
        { directory: "missing-lines" },
      ],
    });

    expect(manifest?.schemaVersion).toBe(3);
    expect(manifest?.characters).toHaveLength(1);
    expect(manifest?.characters[0]?.lines).toHaveLength(4);
    expect(playableVoiceLines(manifest?.characters[0] ?? null).map((line) => line.id)).toEqual([
      "MemorialLobby_1",
      "MemorialLobby_2",
    ]);
    expect(voiceCharacterForDirectory(manifest, "Airi_home")?.variant).toBe("Base");
    expect(introVoiceLineForCharacter(voiceCharacterForDirectory(manifest, "Airi_home"))?.id).toBe("MemorialLobby_0");
    expect(parseVoiceManifest(null)).toBeNull();
    expect(parseVoiceManifest({ characters: "not-an-array" })).toBeNull();
  });

  test("falls back to another localized dialogue when the selected language is missing", () => {
    const line = { id: "MemorialLobby_1", audio: ["line.ogg"], JR: "", EN: "English line", KR: "" };
    expect(dialogueForVoiceLine(line, "en")).toBe("English line");
    expect(dialogueForVoiceLine(line, "ja")).toBe("English line");
    expect(dialogueForVoiceLine(line, "ko")).toBe("English line");

    const koreanLine = { ...line, EN: "", KR: "한국어 대사" };
    expect(dialogueForVoiceLine(koreanLine, "en")).toBe("한국어 대사");
    expect(dialogueForVoiceLine(koreanLine, "ja")).toBe("한국어 대사");
  });

  test("splits multi-clip dialogue and keeps mismatched translations aligned", () => {
    const exact = { id: "MemorialLobby_4", audio: ["one.ogg", "two.ogg", "three.ogg"], JR: "一\n二\n三", EN: "one\ntwo\nthree", KR: "하나\n둘\n셋" };
    expect(dialogueSegmentsForVoiceLine(exact, "en")).toEqual(["one", "two", "three"]);
    expect(dialogueForVoiceLine(exact, "en", 1)).toBe("two");

    const fewer = { ...exact, audio: ["one.ogg", "two.ogg", "three.ogg", "four.ogg"], EN: "one\ntwo" };
    expect(dialogueSegmentsForVoiceLine(fewer, "en")).toEqual(["one", "two", "", ""]);

    const more = { ...exact, audio: ["one.ogg", "two.ogg"], EN: "one\ntwo\nthree" };
    expect(dialogueSegmentsForVoiceLine(more, "en")).toEqual(["one", "two\nthree"]);

    const single = { ...exact, audio: ["one.ogg"], EN: "one\ntwo" };
    expect(dialogueForVoiceLine(single, "en")).toBe("one\ntwo");
  });

  test("selects one language pack and never falls back from an unknown numbered talk", () => {
    const line = {
      id: "MemorialLobby_2",
      audio: ["Airi/base.ogg", "Airi/GL/line_GL_1.ogg", "Airi/kr_line_KR_1.ogg", "Airi/jp_line_JP_1.ogg"],
      JR: "日本語",
      EN: "English",
      KR: "한국어",
    };
    expect(voiceLineForLanguage(line, "ja").audio).toEqual(["Airi/jp_line_JP_1.ogg"]);
    expect(voiceLineForLanguage(line, "en").audio).toEqual(["Airi/GL/line_GL_1.ogg"]);
    expect(voiceLineForLanguage(line, "ko").audio).toEqual(["Airi/kr_line_KR_1.ogg"]);
    expect(voiceLineIndexForAnimation([line], "Talk_02_M", 0)).toBe(0);
    expect(voiceLineIndexForAnimation([line], "Talk_03_M", 0)).toBe(-1);
  });

  test("does not repeat a one-part subtitle over silent extra clips", () => {
    const line = { id: "MemorialLobby_1", audio: ["one.ogg", "two.ogg"], JR: "一\n二", EN: "Ehehe...", KR: "하나\n둘" };
    expect(dialogueSegmentsForVoiceLine(line, "en")).toEqual(["Ehehe...", ""]);
  });

  test("keeps an explicitly blank localized part blank", () => {
    const line = {
      id: "MemorialLobby_1",
      audio: ["one.ogg", "two.ogg"],
      parts: [
        { index: 1, audio: ["one.ogg"], subtitle: { en: "One", ja: "一", ko: "하나" } },
        { index: 2, audio: ["two.ogg"], subtitle: { en: "", ja: "二", ko: "둘" } },
      ],
      JR: "一\n二",
      EN: "One",
      KR: "하나\n둘",
    };
    expect(dialogueSegmentsForVoiceLine(line, "en")).toEqual(["One", ""]);
    expect(dialogueSegmentsForVoiceLine(line, "ja")).toEqual(["一", "二"]);
  });

  test("parses a catalog and prefixes audio paths in a character subtitle file", () => {
    const catalog = parseVoiceCatalog({
      schemaVersion: 2,
      characters: [
        { character: "Airi", variant: "Base", directory: "Airi_home", file: "Airi/subtitles.json", audioDirectory: "Airi" },
        { character: "bad", directory: "bad_home", file: "../outside.json" },
      ],
    });
    expect(catalog?.characters).toHaveLength(1);
    expect(voiceCatalogEntryForDirectory(catalog, "Airi_home")?.file).toBe("Airi/subtitles.json");

    const character = parseVoiceCharacterFile({
      character: "Airi",
      variant: "Base",
      directory: "Airi_home",
      lines: [{
        id: "MemorialLobby_1",
        parts: [
          { index: 1, audio: "one.ogg", start: 0.25, subtitle: { en: "One", ja: "一", ko: "하나" } },
          { index: 2, audio: ["two.ogg"], start: 1.5, subtitle: { en: "Two", ja: "二", ko: "둘" } },
        ],
      }],
    }, "Airi");
    expect(character?.lines[0]?.audio).toEqual(["Airi/one.ogg", "Airi/two.ogg"]);
    expect(character?.lines[0]?.markers).toEqual([0.25, 1.5]);
    expect(dialogueForVoiceLine(character?.lines[0], "en", 1)).toBe("Two");
  });
});
