import { describe, expect, test } from "bun:test";
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";
import { bannerNames, message, schoolName, setLanguage, studentName, t, translateModelString, weekdays, typeLabel } from "./index";

/** `{...}` placeholders, excluding the `{star}` icon marker handled by JSX. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9]+)\}/g)].map((match) => match[1]);
}

describe("dictionary parity", () => {
  test("ja and ko define every key in the English source of truth", () => {
    const source = Object.keys(en).sort();
    expect(Object.keys(ja).sort()).toEqual(source);
    expect(Object.keys(ko).sort()).toEqual(source);
  });

  /** Expectation list rather than inline labels: bun's `expect()` takes no
      message argument, so collect mismatches and fail on the joined list. */
  test("translated values keep the same placeholders (except the empty glue strings)", () => {
    for (const [lang, dict] of [["ja", ja], ["ko", ko]] as const) {
      const mismatches: string[] = [];
      for (const [key, value] of Object.entries(dict)) {
        // `cal.guide.suffix` is "." in English and a zero-length glue string
        // in CJK sentences, which is an intentional divergence.
        const got = key === "cal.guide.suffix" && value === "" ? [] : placeholders(value).sort();
        const want = placeholders(en[key as keyof typeof en]).sort();
        if (got.join("|") !== want.join("|")) {
          mismatches.push(`${lang} ${key}: expected {${want.join("|")}}, got {${got.join("|")}}`);
        }
      }
      expect(mismatches).toEqual([]);
    }
  });

  test("every value is a non-empty string (the only zero-length ones are the CJK glue strings)", () => {
    for (const [lang, dict] of [["ja", ja], ["ko", ko]] as const) {
      const empties: string[] = [];
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value).toBe("string");
        if (key === "cal.guide.suffix") continue;
        if (value.length === 0) empties.push(`${lang} ${key}`);
      }
      expect(empties).toEqual([]);
    }
  });
});

describe("t() interpolation in the default (English) language", () => {
  test("substitutes every parameter", () => {
    expect(t("cal.lagDays", { n: 3, unit: t("cal.dayUnit") })).toBe("3d");
    expect(t("sim.rewards.withTicketsMany", { n: 2 })).toBe(" · +2 tickets");
    expect(t("cal.explanation.range.calibrated", { n: 41 })).toBe(
      "Range based on 41 historical update outcomes, with one-update safety padding.",
    );
  });

  test("reads a specific dictionary without touching module state", () => {
    expect(message("ja", "cal.today")).toBe("今日");
    expect(message("ko", "cal.today")).toBe("오늘");
  });
});

describe("model string translation", () => {
  test("maps gachaRules errors to dictionary entries", () => {
    expect(translateModelString("No limited 10-recruitment ticket available.")).toBe(t("sim.err.noTicket"));
    expect(translateModelString("Unmapped model text")).toBe("Unmapped model text");
    expect(translateModelString("")).toBe("");
  });

  test("reassembles forecast explanations from translated parts", () => {
    expect(
      translateModelString(
        "Recent JP-to-Global lag, snapped to the projected Global maintenance schedule. Range based on 41 historical update outcomes, with one-update safety padding.",
      ),
    ).toBe(t("cal.explanation.full", { method: t("cal.explanation.method.recentLag"), range: t("cal.explanation.range.calibrated", { n: "41" }) }));
    expect(
      translateModelString(
        "Batch alignment, snapped to the projected Global maintenance schedule. Conservative range: insufficient historical calibration.",
      ),
    ).toBe(t("cal.explanation.full", { method: t("cal.explanation.method.alignment"), range: t("cal.explanation.range.uncalibrated") }));
  });
});

describe("localized lookups with language switching", () => {
  const character = { name: "Shiroko", nameJp: "シロコ", nameKr: "시로코" };

  test("studentName prefers the language dump, falling back to English", () => {
    setLanguage("ja");
    expect(studentName(character)).toBe("シロコ");
    setLanguage("ko");
    expect(studentName(character)).toBe("시로코");
    expect(studentName({ name: "Aru", nameJp: "アル" })).toBe("Aru"); // missing kr falls back
    setLanguage("en");
    expect(studentName(character)).toBe("Shiroko");
  });

  test("bannerNames joins localized names with a banner-code fallback", () => {
    setLanguage("ja");
    expect(bannerNames({ characters: [character, { name: "Tsumugi", nameJp: "ツムギ" }], code: "code-1" })).toBe("シロコ, ツムギ");
    expect(bannerNames({ characters: [], code: "solo-code" })).toBe("solo-code");
    setLanguage("en");
    expect(bannerNames({ characters: [character] }, ", ")).toBe("Shiroko");
  });

  test("weekdays are Monday-first and seven long in every language", () => {
    for (const language of ["en", "ja", "ko"] as const) {
      setLanguage(language);
      expect(weekdays()).toHaveLength(7);
    }
    setLanguage("en");
    expect(weekdays()[0]).toBe("Mon");
  });

  test("glossaries fall back to the raw key", () => {
    expect(typeLabel("PickupGacha")).toBe("Pick-up");
    expect(typeLabel("FutureThingGacha")).toBe("FutureThing");
    expect(schoolName("Gehenna")).toBe("Gehenna");
    expect(schoolName("NotASchool")).toBe("NotASchool");
    setLanguage("ja");
    expect(schoolName("Gehenna")).toBe("ゲヘナ");
    setLanguage("en");
  });
});
