import { describe, expect, test } from "bun:test";
import { parseTheme, resolveTheme } from "./theme";

describe("shared Viewer theme preference", () => {
  test("defaults missing or invalid preferences to the Editor-derived dark theme", () => {
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme("unknown")).toBe("dark");
  });

  test("preserves explicit light, dark, and system preferences", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
  });

  test("resolves system preference without changing the saved preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
