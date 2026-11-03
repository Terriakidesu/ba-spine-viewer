import { describe, expect, test } from "bun:test";
import { createProject } from "./editorModel";
import { copyTimelineSelection, pasteTimelineSelection } from "./timelineClipboard";
import type { EditorAnimationClip } from "./editorModel";

function timelineFixture() {
  const timeline = createProject("Airi_home", ["Idle"], []).timeline;
  const character = timeline.layers[0]!;
  const animation: EditorAnimationClip = {
    id: "animation-source",
    animation: "Idle",
    start: 1,
    end: 2,
    animationOffset: 0,
    loop: false,
  };
  timeline.layers = [{ ...character, id: "character", animationClips: [
    animation,
    { ...animation, id: "animation-later", start: 6, end: 7 },
  ] }];
  timeline.colorLayers = [{
    id: "color-layer",
    name: "Flashes",
    enabled: true,
    locked: false,
    opacity: 1,
    order: 1,
    blendMode: "normal",
    clips: [{ id: "color-source", name: "Flash", color: "#FFFFFF", start: 2, end: 3, opacity: 1, fadeIn: 0, fadeOut: 0, enabled: true }],
  }];
  timeline.subtitles = [{ id: "cue-source", lineId: "line-source", start: 1.5, end: 2.5, enabled: true, text: { en: "Hello", ja: "こんにちは", ko: "안녕" } }];
  timeline.audio = [{ id: "audio-source", name: "Voice", path: "audios/voice.ogg", lineId: "line-source", subtitleId: "cue-source", start: 1.5, end: 2.5, enabled: true, volume: 0.8 }];
  timeline.duration = 3;
  return timeline;
}

const resolveAnimations = (layer: { animationClips?: EditorAnimationClip[] }) => layer.animationClips ?? [];

describe("timeline copy and paste", () => {
  test("snapshots selected clips with their timing and nested subtitle text", () => {
    const timeline = timelineFixture();
    const clipboard = copyTimelineSelection(timeline, [
      { kind: "animation", id: "animation-source" },
      { kind: "color", id: "color-source" },
      { kind: "cue", id: "cue-source" },
      { kind: "audio", id: "audio-source" },
    ], resolveAnimations);

    expect(clipboard?.anchor).toBe(1);
    expect(clipboard?.entries.map((entry) => entry.kind)).toEqual(["animation", "color", "cue", "audio"]);
    timeline.subtitles[0]!.text.en = "Changed after copy";
    expect(clipboard?.entries.find((entry) => entry.kind === "cue")?.cue.text.en).toBe("Hello");
  });

  test("pastes clips at the playhead preserving offsets and remapping copied audio links", () => {
    const timeline = timelineFixture();
    const clipboard = copyTimelineSelection(timeline, [
      { kind: "animation", id: "animation-source" },
      { kind: "color", id: "color-source" },
      { kind: "cue", id: "cue-source" },
      { kind: "audio", id: "audio-source" },
    ], resolveAnimations)!;
    let nextId = 0;
    const result = pasteTimelineSelection(timeline, clipboard, 6, resolveAnimations, () => `pasted-${++nextId}`);

    expect(result.pastedCount).toBe(4);
    expect(result.skippedCount).toBe(0);
    expect(result.adjustedCount).toBe(0);
    expect(result.timeline.layers[0]!.animationClips).toContainEqual(expect.objectContaining({ id: "pasted-2", start: 6, end: 7 }));
    expect(result.timeline.layers[0]!.animationClips).toContainEqual(expect.objectContaining({ id: "animation-later", start: 7, end: 8 }));
    expect(result.timeline.colorLayers[0]!.clips).toContainEqual(expect.objectContaining({ id: "pasted-4", start: 7, end: 8, name: "Flash copy" }));
    const pastedCue = result.timeline.subtitles.find((cue) => cue.id === "pasted-1")!;
    const pastedAudio = result.timeline.audio.find((clip) => clip.id === "pasted-3")!;
    expect(pastedCue).toMatchObject({ start: 6.5, end: 7.5, text: { en: "Hello" }, lineId: undefined });
    expect(pastedAudio).toMatchObject({ start: 6.5, end: 7.5, subtitleId: pastedCue.id, lineId: "line-source" });
    expect(result.timeline.duration).toBeGreaterThanOrEqual(7.5);
    expect(result.selections).toHaveLength(4);
    expect(timeline.layers[0]!.animationClips).toEqual([
      { id: "animation-source", animation: "Idle", start: 1, end: 2, animationOffset: 0, loop: false },
      { id: "animation-later", animation: "Idle", start: 6, end: 7, animationOffset: 0, loop: false },
    ]);
  });

  test("skips clips whose original tracks are locked", () => {
    const timeline = timelineFixture();
    timeline.layers[0]!.locked = true;
    timeline.colorLayers[0]!.locked = true;
    const clipboard = copyTimelineSelection(timeline, [
      { kind: "animation", id: "animation-source" },
      { kind: "color", id: "color-source" },
    ], resolveAnimations)!;
    const result = pasteTimelineSelection(timeline, clipboard, 6, resolveAnimations, () => "unused");

    expect(result.timeline).toBe(timeline);
    expect(result.pastedCount).toBe(0);
    expect(result.skippedCount).toBe(2);
  });

  test("repositions pasted color clips around occupied track time and maps legacy line links", () => {
    const timeline = timelineFixture();
    timeline.colorLayers[0]!.clips.push({ id: "occupied", name: "Occupied", color: "#000000", start: 6, end: 7, opacity: 1, fadeIn: 0, fadeOut: 0, enabled: true });
    timeline.audio[0]!.subtitleId = undefined;
    const clipboard = copyTimelineSelection(timeline, [
      { kind: "color", id: "color-source" },
      { kind: "cue", id: "cue-source" },
      { kind: "audio", id: "audio-source" },
    ], resolveAnimations)!;
    let nextId = 0;
    const result = pasteTimelineSelection(timeline, clipboard, 6, resolveAnimations, () => `legacy-${++nextId}`);
    const pastedColor = result.timeline.colorLayers[0]!.clips.find((clip) => clip.id === "legacy-3")!;
    const pastedCue = result.timeline.subtitles.find((cue) => cue.id === "legacy-1")!;
    const pastedAudio = result.timeline.audio.find((clip) => clip.id === "legacy-2")!;

    expect(result.adjustedCount).toBe(1);
    expect(pastedColor.start >= 7 || pastedColor.end <= 6).toBe(true);
    expect(pastedAudio).toMatchObject({ subtitleId: pastedCue.id, lineId: undefined });
  });

  test("does not attach a pasted audio clip to a cue that was not copied", () => {
    const timeline = timelineFixture();
    const clipboard = copyTimelineSelection(timeline, [{ kind: "audio", id: "audio-source" }], resolveAnimations)!;
    const result = pasteTimelineSelection(timeline, clipboard, 6, resolveAnimations, () => "audio-copy");

    expect(result.timeline.audio.find((clip) => clip.id === "audio-copy")).toMatchObject({ subtitleId: null, lineId: "line-source" });
  });
});
