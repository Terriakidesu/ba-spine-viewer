import { describe, expect, test } from "bun:test";
import { filterAnimationPickerOptions, includeMissingAnimationOption, type AnimationPickerOption } from "./animationPickerModel";

const options: AnimationPickerOption[] = [
  { value: "idle_breath", label: "Idle breathing" },
  { value: "attack", label: "Attack" },
  { value: "idle", label: "Idle" },
  { value: "face_smile", label: "Face smile" },
];

describe("animation picker search", () => {
  test("ranks exact and prefix matches before substring matches", () => {
    expect(filterAnimationPickerOptions(options, "idle").map(({ value }) => value)).toEqual(["idle", "idle_breath"]);
    expect(filterAnimationPickerOptions(options, "tac").map(({ value }) => value)).toEqual(["attack"]);
  });

  test("matches case-insensitively with Unicode compatibility normalization", () => {
    expect(filterAnimationPickerOptions(options, "ＩＤＬＥ").map(({ value }) => value)).toEqual(["idle", "idle_breath"]);
  });

  test("preserves source order for empty queries and returns no unrelated options", () => {
    expect(filterAnimationPickerOptions(options, "  ")).toEqual(options);
    expect(filterAnimationPickerOptions(options, "missing")).toEqual([]);
  });

  test("keeps an authored animation visible when it is missing from the loaded rig", () => {
    expect(includeMissingAnimationOption(options, "old_idle").at(-1)).toEqual({ value: "old_idle", label: "old_idle · missing from rig" });
    expect(includeMissingAnimationOption(options, "idle")).toEqual(options);
    expect(includeMissingAnimationOption(options, "")).toEqual(options);
  });
});
