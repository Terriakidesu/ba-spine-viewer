import { describe, expect, test } from "bun:test";
import { suggestInteractionPhases } from "./interactionSuggestions";

describe("interaction phase suggestions", () => {
  test("only suggests a mapping when the selected press exactly matches a local profile", () => {
    const animations = ["Pat_01_M", "Pat_02_M", "PatEnd_01_M", "Pat_01_A", "Pat_02_A", "PatEnd_01_A"];
    const suggestion = suggestInteractionPhases(animations, "Pat_01_M");

    expect(suggestion).not.toBeNull();
    expect(suggestion?.kind).toBe("Pat");
    expect(suggestion?.startAnimation).toBe("Pat_01_M");
    expect(suggestion?.followAnimation).toBe("Pat_02_M");
    expect(suggestion?.endAnimation).toBe("PatEnd_01_M");
    expect(suggestion?.faceStartAnimation).toBe("Pat_01_A");
    expect(suggestion?.reason).toContain("exactly matches");
  });

  test("does not invent a suggestion for an unknown or empty press animation", () => {
    const animations = ["idle", "wave"];
    expect(suggestInteractionPhases(animations, "wave")).toBeNull();
    expect(suggestInteractionPhases(animations, "")).toBeNull();
  });
});
