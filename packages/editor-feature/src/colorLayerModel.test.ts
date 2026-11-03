import { expect, test } from "bun:test";
import { adjustColorClipFade, colorClipPreset, deleteColorClip, duplicateColorClip, moveColorClip, moveColorClipGroup, moveColorClipGroups, trimColorClipEnd, trimColorClipStart } from "./colorLayerModel";
import type { SpineTimelineColorClip } from "@ba-spine/spine-runtime/spine/spineTimeline";

function clip(id: string, start: number, end: number): SpineTimelineColorClip {
  return { id, name: id, color: "#000000", start, end, opacity: 1, fadeIn: 0, fadeOut: 0, enabled: true };
}

test("color presets create editable fade and flash clips", () => {
  expect(colorClipPreset("black-in", "fade-from-black", 2, 4)).toMatchObject({ name: "Fade from black", color: "#000000", start: 2, end: 6, fadeIn: 0, fadeOut: 4 });
  expect(colorClipPreset("black-out", "fade-to-black", 2, 4)).toMatchObject({ name: "Fade to black", color: "#000000", fadeIn: 4, fadeOut: 0 });
  expect(colorClipPreset("flash", "white-flash", 2, 4)).toMatchObject({ color: "#FFFFFF", fadeIn: 0.8, fadeOut: 3.2 });
});

test("adding or moving color clips keeps one track non-overlapping", () => {
  const moved = moveColorClip([clip("one", 1, 3), clip("two", 5, 7)], "one", 5);
  expect(moved.map(({ id, start, end }) => [id, start, end])).toEqual([["one", 3, 5], ["two", 5, 7]]);
  expect(moveColorClip([clip("one", 1, 3), clip("two", 5, 7)], "two", 1).map(({ id, start, end }) => [id, start, end])).toEqual([["one", 1, 3], ["two", 3, 5]]);
});

test("color clip trimming stops at adjacent clips and maintains valid fades", () => {
  const clips = [
    { ...clip("one", 0, 2), fadeIn: 0.5, fadeOut: 0.5 },
    clip("two", 3, 5),
  ];
  expect(trimColorClipEnd(clips, "one", 4).find((item) => item.id === "one")?.end).toBe(3);
  const trimmedStart = trimColorClipStart(clips, "two", 1).find((item) => item.id === "two")!;
  expect(trimmedStart.start).toBe(2);
  expect(trimColorClipStart(clips, "one", 1).find((item) => item.id === "one")).toMatchObject({ start: 1, end: 2, fadeIn: 0.5, fadeOut: 0.5 });
});

test("fade handles adjust either ramp and normalize fades to the clip", () => {
  const base = { ...clip("fade", 1, 3), fadeIn: 0.5, fadeOut: 0.5 };
  expect(adjustColorClipFade(base, "in", 0.75)).toMatchObject({ fadeIn: 1.25, fadeOut: 0.5 });
  expect(adjustColorClipFade(base, "out", 0.2)).toMatchObject({ fadeIn: 0.5, fadeOut: 0.3 });
  expect(adjustColorClipFade(base, "in", 4)).toMatchObject({ fadeIn: 1.6, fadeOut: 0.4 });
});

test("group moves preserve gaps and clamp against neighboring clips", () => {
  const clips = [clip("one", 0, 1), clip("two", 1.5, 2.5), clip("three", 4, 5)];
  const moved = moveColorClipGroup(clips, ["one", "two"], 2);
  expect(moved.map(({ id, start, end }) => [id, start, end])).toEqual([["one", 1.5, 2.5], ["two", 3, 4], ["three", 4, 5]]);
  expect(moveColorClipGroup(moved, ["one", "two"], -10).map(({ id, start }) => [id, start])).toEqual([["one", 0], ["two", 1.5], ["three", 4]]);
});

test("multi-track color group moves use one shared delta", () => {
  const moved = moveColorClipGroups([
    { clips: [clip("first", 0, 1), clip("first-blocker", 3, 4)], ids: ["first"] },
    { clips: [clip("second", 0, 1), clip("second-blocker", 2, 3)], ids: ["second"] },
  ], 4);
  expect(moved.map((clips) => clips.find((item) => item.id === "first" || item.id === "second")?.start)).toEqual([1, 1]);
});

test("duplicate seeks the next available gap and delete removes only the requested clip", () => {
  const clips = [clip("one", 0, 2), clip("two", 2, 4), clip("three", 4, 6)];
  const duplicated = duplicateColorClip(clips, "one", "copy");
  expect(duplicated.find((item) => item.id === "copy")).toMatchObject({ start: 6, end: 8, name: "one copy" });
  expect(deleteColorClip(duplicated, "two").map((item) => item.id)).toEqual(["one", "three", "copy"]);
});
