import { describe, expect, test } from "bun:test";
import { filterCommandPaletteItems, firstEnabledCommandIndex, moveCommandPaletteIndex } from "./commandPaletteModel";

const commands = [
  { id: "save", title: "Save project", description: "Write files to the asset root", group: "Project", keywords: ["persist"] },
  { id: "fit", title: "Fit canvas", description: "Frame all artwork", group: "View", keywords: ["zoom"] },
  { id: "timeline", title: "Switch to Timeline", group: "Workspace", disabled: true },
];

describe("command palette search and navigation", () => {
  test("ranks exact and prefix matches ahead of substring matches while keeping stable ties", () => {
    expect(filterCommandPaletteItems(commands, "save").map((item) => item.id)).toEqual(["save"]);
    expect(filterCommandPaletteItems(commands, "project").map((item) => item.id)).toEqual(["save"]);
    expect(filterCommandPaletteItems(commands, "").map((item) => item.id)).toEqual(["save", "fit", "timeline"]);
  });

  test("wraps keyboard navigation and skips disabled commands", () => {
    expect(moveCommandPaletteIndex(0, -1, 3)).toBe(2);
    expect(moveCommandPaletteIndex(2, 1, 3)).toBe(0);
    expect(moveCommandPaletteIndex(0, 1, 0)).toBe(-1);
    expect(firstEnabledCommandIndex(commands, 0, 1)).toBe(0);
    expect(firstEnabledCommandIndex(commands, 2, 1)).toBe(0);
    expect(firstEnabledCommandIndex([{ ...commands[2]!, id: "disabled" }])).toBe(-1);
  });
});
