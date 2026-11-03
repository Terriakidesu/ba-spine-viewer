import { expect, test } from "bun:test";
import { authoredRegions, normalizeSpineInteractionProject } from "./spineInteraction";
import { timelineActiveSubtitleTexts, timelineForSequence, timelineLayerAnimation, timelineMainAnimation } from "./spineTimeline";

test("a saved interaction project keeps sequences, regions, backgrounds, and timing in one viewer contract", () => {
  const project = normalizeSpineInteractionProject({
    schemaVersion: 2,
    assetDirectory: "Airi_home",
    interactions: [{
      id: "pat",
      name: "Head pat",
      trigger: "hold",
      startAnimation: "Pat_01_M",
      followAnimation: "Pat_01_M",
      endAnimation: "PatEnd_01_M",
      regions: [{ id: "head", name: "Head", shape: "ellipse", anchorBone: "root/head", radiusX: 100, radiusY: 80 }],
    }],
    timeline: {
      sequenceId: "opening",
      openingMode: "direct",
      duration: 8,
      layers: [
        { id: "character", name: "Airi", role: "character", directory: "Airi_home", animation: "Idle", start: 0, end: 8, loop: true },
        { id: "background", name: "Airi_bg", role: "background", directory: "Airi_bg", animation: "Fallback", start: 0, end: 8, loop: true },
      ],
      subtitles: [{ id: "cue", start: 2, end: 4, enabled: true, text: { en: "Hello", ja: "", ko: "" } }],
      audio: [],
      language: "en",
    },
    sequences: {
      "talk-1": {
        sequenceId: "talk-1",
        openingMode: "direct",
        duration: 3,
        layers: [{ id: "character", name: "Airi", role: "character", directory: "Airi_home", animation: "Talk_01_M", start: 0, end: 3, loop: false }],
        subtitles: [],
        audio: [],
        language: "en",
      },
    },
  });
  expect(project).not.toBeNull();
  const opening = timelineForSequence(project!, "opening");
  const talk = timelineForSequence(project!, "talk-1");
  expect(opening?.layers[1]?.followMainAnimation).toBe(true);
  expect(talk?.sequenceId).toBe("talk-1");
  expect(authoredRegions(project)).toMatchObject([{ kind: "pat", id: "head" }]);

  const meta = { animations: ["Idle", "Talk_01_M"], introAnimation: null, idleAnimation: "Idle" };
  const background = opening!.layers[1]!;
  expect(timelineLayerAnimation(background, meta, "Talk_01_M", 1, "talk-1", "direct", 0)).toBe("Talk_01_M");
  expect(timelineMainAnimation(opening!.layers[0]!, meta, 2, "opening", "direct", 0, 3).time).toBe(2);
  expect(timelineActiveSubtitleTexts(opening!, 3)).toEqual(["Hello"]);
});
