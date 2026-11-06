import { expect, test } from "bun:test";
import { createProject, normalizeProject } from "./editorModel";
import { addTalkSequence, animationClipEnd, animationEndForLayer, authoredTimelineEnd, deleteAnimationClipRipple, deleteSequence, duplicateAnimationClipRipple, effectiveAnimationClips, extendTimelineDuration, linkAudioToSubtitle, linkedSubtitleForAudio, matchAudioAndSubtitleLength, matchedAnimationEndpoint, moveAnimationClipRipple, moveAudioClip, moveSequenceBy, moveSequenceId, nextTalkSequenceId, nextTalkSequenceIdForProject, openingPhaseTimings, openingTimelineDuration, replaceSubtitleImport, resolveTimelineSnap, sequenceIdsForProject, snapToTargets, splitCue, switchSequence, talkSequenceDuration, talkSequenceId } from "./sequenceModel";
import type { SpineMeta } from "@ba-spine/spine-runtime/spine/spineRuntime";

test("talk sequences pair body and face and isolate subtitle clocks", () => {
  const animations = ["Idle_01", "Talk_01_M", "Talk_01_A", "Talk_02_M", "Talk_02_A"];
  let project = switchSequence(createProject("Airi_home", animations, []), "talk-1", animations, []);
  project.timeline.subtitles.push({ id: "one", start: 1, end: 3, enabled: true, text: { en: "First talk", ja: "", ko: "" } });
  expect(project.timeline.layers[0]?.faceAnimation).toBe("Talk_01_A");
  project = switchSequence(project, "talk-2", animations, []);
  expect(project.timeline.subtitles).toEqual([]);
  expect(project.timeline.layers[0]?.animation).toBe("Talk_02_M");
  project = switchSequence(project, "talk-1", animations, []);
  expect(project.timeline.subtitles[0]?.text.en).toBe("First talk");
  const restored = normalizeProject(JSON.parse(JSON.stringify(project)), "Airi_home")!;
  expect(restored.timeline.sequenceId).toBe("talk-1");
  expect(restored.sequences?.["talk-2"]?.layers[0]?.faceAnimation).toBe("Talk_02_A");
});

test("Talk autoplay follows the authored order and can wrap the playlist", () => {
  const talks = ["opening", "talk-1", "talk-2", "talk-10", "talk-2"];
  expect(nextTalkSequenceId(talks, "talk-1")).toBe("talk-2");
  expect(nextTalkSequenceId(talks, "talk-2")).toBe("talk-10");
  expect(nextTalkSequenceId(talks, "talk-10")).toBeNull();
  expect(nextTalkSequenceId(talks, "talk-10", true)).toBe("talk-1");
  expect(nextTalkSequenceId(["talk-3", "talk-1", "talk-2"], "talk-3")).toBe("talk-1");
});

test("sequence management keeps Opening fixed and persists Talk order and deletion", () => {
  const animations = ["Idle_01", "Talk_01_M", "Talk_02_M"];
  let project = createProject("Airi_home", animations, []);
  expect(sequenceIdsForProject(project, animations)).toEqual(["opening", "talk-1", "talk-2"]);
  expect(moveSequenceBy(sequenceIdsForProject(project, animations), "opening", 1)).toEqual(["opening", "talk-1", "talk-2"]);
  expect(moveSequenceId(["opening", "talk-1", "talk-2", "talk-3"], "talk-1", 3)).toEqual(["opening", "talk-2", "talk-3", "talk-1"]);

  project = { ...project, sequenceOrder: [...moveSequenceBy(sequenceIdsForProject(project, animations), "talk-2", -1), "talk-2"] };
  expect(sequenceIdsForProject(project, animations)).toEqual(["opening", "talk-2", "talk-1"]);
  expect(nextTalkSequenceIdForProject(project, animations)).toBe("talk-3");

  project = addTalkSequence(project, animations, []);
  expect(project.timeline.sequenceId).toBe("talk-3");
  expect(sequenceIdsForProject(project, animations)).toEqual(["opening", "talk-2", "talk-1", "talk-3"]);

  project = deleteSequence(project, "talk-2", animations, []);
  expect(sequenceIdsForProject(project, animations)).toEqual(["opening", "talk-1", "talk-3"]);
  expect(project.deletedSequenceIds).toContain("talk-2");
  expect(project.sequences?.["talk-2"]).toBeUndefined();
  expect(deleteSequence(project, "opening", animations, [])).toBe(project);
  const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)), "Airi_home")!;
  expect(sequenceIdsForProject(reloaded, animations)).toEqual(["opening", "talk-1", "talk-3"]);
});

test("reselecting a talk sequence keeps its current imported edits", () => {
  const animations = ["Idle_01", "Talk_01_M", "Talk_01_A"];
  let project = switchSequence(createProject("Airi_home", animations, []), "talk-1", animations, []);
  project.timeline.subtitles = [{ id: "latest", lineId: "talk-1", start: 0, end: 2, enabled: true, text: { en: "Latest", ja: "", ko: "" } }];
  project.timeline.audio = [{ id: "long-audio", lineId: "talk-1", name: "voice.ogg", path: "voice.ogg", start: 0, end: 20, enabled: true, volume: 1 }];
  project = switchSequence(project, "talk-1", animations, []);
  expect(project.timeline.subtitles[0]?.text.en).toBe("Latest");
  expect(project.timeline.audio[0]?.end).toBe(20);
  expect(project.timeline.layers[0]?.loop).toBe(false);
});

test("reopening a subtitle file replaces imported content in every sequence", () => {
  let project = createProject("Airi_home", ["Talk_01_M"], []);
  project = switchSequence(project, "opening", ["Talk_01_M"], []);
  project.timeline.subtitlePath = "old-subtitles.json";
  project.timeline.subtitles = [{ id: "old-opening", start: 0, end: 2, enabled: true, text: { en: "Old opening", ja: "", ko: "" } }];
  project.timeline.audio = [{ id: "old-opening-audio", name: "old.ogg", path: "old.ogg", start: 0, end: 2, enabled: true, volume: 1 }];
  project = switchSequence(project, "talk-1", ["Talk_01_M"], []);
  project.timeline.subtitlePath = "old-subtitles.json";
  project.timeline.subtitles = [{ id: "old-talk", start: 1, end: 3, enabled: true, text: { en: "Old talk", ja: "", ko: "" } }];

  const replaced = replaceSubtitleImport(project, "new-subtitles.json");
  expect(replaced.timeline.subtitlePath).toBe("new-subtitles.json");
  expect(replaced.timeline.subtitles).toEqual([]);
  expect(replaced.timeline.audio).toEqual([]);
  expect(replaced.sequences?.opening?.subtitlePath).toBe("new-subtitles.json");
  expect(replaced.sequences?.opening?.subtitles).toEqual([]);
  expect(replaced.timeline.sequenceId).toBe("talk-1");
  expect(replaced.timeline.subtitlePath).toBe("new-subtitles.json");
  expect(replaced.timeline.subtitles).toEqual([]);
});

test("each sequence preserves intentional layer deletions while new sequences initialize discovered layers", () => {
  const directories = ["Momoi_home", "Momoi_scene"];
  let project = switchSequence(createProject("Momoi_home", [], []), "opening", [], directories);
  project = switchSequence(project, "talk-1", [], directories);
  const scene = project.timeline.layers.find((layer) => layer.role === "scene");
  expect(scene).toBeDefined();
  project = {
    ...project,
    timeline: {
      ...project.timeline,
      layers: project.timeline.layers.filter((layer) => layer.id !== scene?.id),
    },
  };

  project = switchSequence(project, "talk-2", [], directories);
  expect(project.timeline.layers.some((layer) => layer.role === "scene")).toBe(true);
  project = switchSequence(project, "talk-1", [], directories);
  expect(project.timeline.layers.some((layer) => layer.role === "scene")).toBe(false);
  const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)), "Momoi_home")!;
  expect(reloaded.timeline.layersInitialized).toBe(true);
  expect(reloaded.timeline.layers.some((layer) => layer.role === "scene")).toBe(false);
});

test("opening choices persist and old compositions remain recoverable", () => {
  const old = createProject("Akari_home", [], []);
  old.timeline.duration = 33;
  let project = switchSequence(old, "opening", [], ["Akari_home", "akari_bg", "akari_scene"]);
  project.timeline.openingMode = "scene-first";
  project.timeline.sceneDuration = 4;
  project = switchSequence(project, "talk-1", [], []);
  project = switchSequence(project, "opening", [], []);
  expect(project.timeline.openingMode).toBe("scene-first");
  expect(project.timeline.sceneDuration).toBe(4);
  expect(project.sequences?.legacy?.duration).toBe(33);
  expect(project.timeline.layers.map((item) => item.directory)).toContain("akari_scene");
});

test("split preserves all languages and snapping favors nearby markers", () => {
  const timeline = createProject("test", [], []).timeline;
  timeline.subtitles = [{ id: "cue", start: 1, end: 4, enabled: true, text: { en: "Hello", ja: "はい", ko: "네" } }];
  const split = splitCue(timeline, "cue", 2);
  expect(split.subtitles.map((cue) => [cue.start, cue.end])).toEqual([[1, 2], [2, 4]]);
  expect(split.subtitles[1]?.text.ko).toBe("네");
  expect(splitCue(timeline, "cue", 5)).toBe(timeline);
  expect(snapToTargets(1.03, 0.1, [1.05])).toBe(1.05);
  expect(resolveTimelineSnap(1.03, 0.1, [1.05])).toEqual({ value: 1.05, target: 1.05, source: "target" });
  expect(resolveTimelineSnap(1.03, 0.1, [])).toEqual({ value: 1, target: 1, source: "grid" });
  expect(resolveTimelineSnap(1.03, 0, [])).toEqual({ value: 1.03, target: null, source: null });
  expect(talkSequenceId("Talk_05_A")).toBe("talk-5");
});

test("non-looping timeline layers follow the real Spine duration unless manually overridden", () => {
  const layer = { start: 1, end: 12, endMode: "auto" as const, loop: false, animationOffset: 0 };
  expect(animationEndForLayer(layer, 4.5)).toBe(5.5);
  expect(animationEndForLayer({ ...layer, animationOffset: 1 }, 4.5)).toBe(4.5);
  expect(animationEndForLayer({ ...layer, loop: true }, 4.5)).toBe(12);
  expect(animationEndForLayer({ ...layer, endMode: "manual", end: 3 }, 4.5)).toBe(3);
});

test("matching animation length uses decoded duration, start, and offset", () => {
  expect(matchedAnimationEndpoint({ start: 2.5, animationOffset: 0.75 }, 5)).toBe(6.75);
  expect(matchedAnimationEndpoint({ start: 2.5, animationOffset: 8 }, 5)).toBe(2.51);
  expect(matchedAnimationEndpoint({ start: 2.5, animationOffset: 0 }, 0)).toBeNull();
});

test("talk playback duration follows character animation instead of a long audio clip", () => {
  const layer = { ...createProject("Airi_home", [], []).timeline.layers[0]!, animation: "Talk_01_M", end: 20, loop: true };
  expect(talkSequenceDuration([layer], { [`${layer.id}:Talk_01_M`]: 2.75 }, () => "Talk_01_M")).toBe(2.75);
});

test("authored timeline content can extend the saved duration", () => {
  const timeline = createProject("Airi_home", [], []).timeline;
  timeline.subtitles = [{ id: "cue", start: 8, end: 11, enabled: true, text: { en: "Late", ja: "", ko: "" } }];
  timeline.audio = [{ id: "audio", name: "voice.ogg", path: "voice.ogg", start: 8, end: 12, enabled: true, volume: 1 }];
  expect(authoredTimelineEnd(timeline)).toBe(12);
  const extended = extendTimelineDuration({ ...timeline, duration: 4 });
  expect(extended.duration).toBe(12);
  expect(extended.subtitles).toBe(timeline.subtitles);
  expect(extended.audio).toBe(timeline.audio);
});

test("automatic opening duration trims a blank tail but keeps intro and authored content", () => {
  const timeline = createProject("Aru_home", [], []).timeline;
  timeline.sequenceId = "opening";
  timeline.openingMode = "scene-first";
  timeline.sceneDuration = 4.6;
  timeline.duration = 19.266;
  timeline.layers = [
    { ...timeline.layers[0]!, role: "character", start: 4.6, end: 17.8, endMode: "manual" },
    { ...timeline.layers[0]!, id: "scene", role: "scene", start: 0, end: 4.7, endMode: "manual" },
  ];
  timeline.subtitles = [{ id: "cue", start: 9, end: 12.9, enabled: true, text: { en: "Hello", ja: "", ko: "" } }];
  expect(openingTimelineDuration(timeline, 11.667)).toBe(17.8);
});

test("opening duration and saved endpoints include enabled color clips only", () => {
  const timeline = createProject("Aru_home", [], []).timeline;
  timeline.sequenceId = "opening";
  timeline.durationMode = "auto";
  timeline.layers = [];
  timeline.duration = 17;
  timeline.colorLayers = [
    {
      id: "color", name: "Fade", enabled: true, locked: false, opacity: 1, order: 0, blendMode: "normal",
      clips: [{ id: "visible", name: "Fade to black", color: "#000000", start: 2, end: 8, opacity: 1, fadeIn: 6, fadeOut: 0, enabled: true }],
    },
    {
      id: "hidden", name: "Hidden", enabled: false, locked: false, opacity: 1, order: 1, blendMode: "normal",
      clips: [{ id: "disabled", name: "Disabled", color: "#FFFFFF", start: 10, end: 30, opacity: 1, fadeIn: 0, fadeOut: 0, enabled: true }],
    },
  ];
  expect(authoredTimelineEnd(timeline)).toBe(8);
  expect(openingTimelineDuration(timeline, 0)).toBe(8);
});

test("color clips do not rewrite a manual sequence duration", () => {
  const timeline = createProject("Aru_home", [], []).timeline;
  timeline.sequenceId = "opening";
  timeline.durationMode = "manual";
  timeline.duration = 6;
  timeline.colorLayers = [{
    id: "wash", name: "Wash", enabled: true, locked: false, opacity: 1, order: 0, blendMode: "normal",
    clips: [{ id: "fade", name: "Fade", color: "#000000", start: 3, end: 12, opacity: 1, fadeIn: 9, fadeOut: 0, enabled: true }],
  }];
  expect(extendTimelineDuration(timeline).duration).toBe(6);
  expect(extendTimelineDuration({ ...timeline, durationMode: "auto" }).duration).toBe(12);
});

test("moving linked audio moves its nearest subtitle cue but not unlinked cues", () => {
  const timeline = createProject("Airi_home", [], []).timeline;
  timeline.audio = [
    { id: "linked", lineId: "talk-1", name: "linked.ogg", path: "linked.ogg", start: 1, end: 3, enabled: true, volume: 1 },
    { id: "free", name: "free.ogg", path: "free.ogg", start: 1, end: 3, enabled: true, volume: 1 },
  ];
  timeline.subtitles = [
    { id: "linked-cue", lineId: "talk-1", start: 1, end: 2, enabled: true, text: { en: "Linked", ja: "", ko: "" } },
    { id: "free-cue", start: 1, end: 2, enabled: true, text: { en: "Free", ja: "", ko: "" } },
  ];
  const moved = moveAudioClip(timeline, "linked", 4);
  expect(moved.audio.find((clip) => clip.id === "linked")).toMatchObject({ start: 4, end: 6 });
  expect(moved.subtitles.find((cue) => cue.id === "linked-cue")).toMatchObject({ start: 4, end: 5 });
  expect(moved.subtitles.find((cue) => cue.id === "free-cue")).toMatchObject({ start: 1, end: 2 });
});

test("audio links can target a cue directly and match both ranges to decoded duration", () => {
  const timeline = createProject("Airi_home", [], []).timeline;
  timeline.audio = [{ id: "voice", name: "voice.ogg", path: "voice.ogg", start: 1, end: 2, enabled: true, volume: 1 }];
  timeline.subtitles = [
    { id: "first", start: 1, end: 1.5, enabled: true, text: { en: "First", ja: "", ko: "" } },
    { id: "second", start: 3, end: 4, enabled: true, text: { en: "Second", ja: "", ko: "" } },
  ];
  const linked = linkAudioToSubtitle(timeline, "voice", "second");
  expect(linkedSubtitleForAudio(linked, linked.audio[0]! )?.id).toBe("second");
  const matched = matchAudioAndSubtitleLength(linked, "voice", 2.75);
  expect(matched.audio[0]).toMatchObject({ start: 1, end: 3.75, autoEnd: true });
  expect(matched.subtitles.find((cue) => cue.id === "second")).toMatchObject({ start: 1, end: 3.75 });
  const unlinked = linkAudioToSubtitle(matched, "voice", null);
  expect(linkedSubtitleForAudio(unlinked, unlinked.audio[0]!)).toBeNull();
  const secondAudio = { id: "voice-2", name: "voice-2.ogg", path: "voice-2.ogg", start: 3, end: 4, enabled: true, volume: 1, subtitleId: "second" };
  const oneToOne = linkAudioToSubtitle({ ...unlinked, audio: [...unlinked.audio, secondAudio] }, "voice", "second");
  expect(oneToOne.audio.find((clip) => clip.id === "voice-2")?.subtitleId).toBeNull();
});

test("opening phases keep scene, intro, and idle boundaries explicit", () => {
  expect(openingPhaseTimings("scene-first", 3, 2.5, 10)).toEqual([
    { id: "scene", start: 0, end: 3 },
    { id: "intro", start: 3, end: 5.5 },
    { id: "idle", start: 5.5, end: 10 },
  ]);
  expect(openingPhaseTimings("skip", 3, 2.5, 4)).toEqual([{ id: "idle", start: 0, end: 4 }]);
});

test("opening phases follow the character clip start instead of a fixed lead-in", () => {
  expect(openingPhaseTimings("scene-first", 3, 2.5, 10, 1.5)).toEqual([
    { id: "scene", start: 0, end: 1.5 },
    { id: "intro", start: 1.5, end: 4 },
    { id: "idle", start: 4, end: 10 },
  ]);
  expect(openingPhaseTimings("direct", 0, 2.5, 10, 1.5)).toEqual([
    { id: "intro", start: 1.5, end: 4 },
    { id: "idle", start: 4, end: 10 },
  ]);
});

test("legacy opening data migrates to intro and idle clips without shifting its timing", () => {
  const project = createProject("Airi_home", [], []);
  project.timeline.sequenceId = "opening";
  project.timeline.openingMode = "scene-first";
  project.timeline.layers[0] = { ...project.timeline.layers[0]!, start: 2, end: 9, animation: "Idle_01", animationOffset: 0.2 };
  const meta = { animations: ["Start_Idle", "Idle_01"], introAnimation: "Start_Idle", idleAnimation: "Idle_01" } as SpineMeta;
  const clips = effectiveAnimationClips(project.timeline.layers[0]!, project.timeline, meta, 2.5);
  expect(clips.map(({ animation, start, end }) => ({ animation, start, end }))).toEqual([
    { animation: "Start_Idle", start: 2, end: 4.5 },
    { animation: "Idle_01", start: 4.5, end: 9 },
  ]);
  expect(clips[1]).toMatchObject({ animationOffset: 0.2, loop: true, continueAfterOpening: true });
  expect(animationClipEnd(clips[0]!, 2.5)).toBe(4.5);
});

test("animation clip movement snaps and ripples later clips without overlaps", () => {
  const clips = [
    { id: "a", animation: "Start_Idle", start: 0, end: 1, animationOffset: 0, loop: false },
    { id: "b", animation: "Scene", start: 1, end: 2, animationOffset: 0, loop: false },
    { id: "c", animation: "Idle", start: 2, end: 3, animationOffset: 0, loop: true },
  ];
  const forward = moveAnimationClipRipple(clips, "b", 1.96, 0.1, [2]);
  expect(forward.map(({ id, start, end }) => [id, start, end])).toEqual([["a", 0, 1], ["b", 2, 3], ["c", 3, 4]]);
  const backward = moveAnimationClipRipple(clips, "b", 0, 0, []);
  expect(backward.map(({ id, start, end }) => [id, start, end])).toEqual([["b", 0, 1], ["a", 1, 2], ["c", 2, 3]]);
  expect(backward.slice(1).every((clip, index) => clip.start >= backward[index]!.end)).toBe(true);
});

test("duplicating and deleting animation clips ripple the sequence around them", () => {
  const clips = [
    { id: "a", animation: "Start_Idle", start: 0, end: 1, animationOffset: 0, loop: false },
    { id: "b", animation: "Scene", start: 1, end: 2, animationOffset: 0, loop: false },
    { id: "c", animation: "Idle", start: 2, end: 3, animationOffset: 0, loop: true },
  ];
  const duplicated = duplicateAnimationClipRipple(clips, "b", "b-copy");
  expect(duplicated.map(({ id, start, end }) => [id, start, end])).toEqual([["a", 0, 1], ["b", 1, 2], ["b-copy", 2, 3], ["c", 3, 4]]);
  const deleted = deleteAnimationClipRipple(duplicated, "b-copy");
  expect(deleted.map(({ id, start, end }) => [id, start, end])).toEqual([["a", 0, 1], ["b", 1, 2], ["c", 2, 3]]);
});
