import { describe, expect, test } from "bun:test";
import { createProject } from "./editorModel";
import { missingManifestAssetFiles, validateTimeline } from "./timelineDiagnostics";

function timelineFixture() {
  return createProject("Airi_home", ["Idle", "Pat"], []).timeline;
}

describe("timeline diagnostics", () => {
  test("checks manifest references against loaded filenames without reading source files again", () => {
    expect(missingManifestAssetFiles([
      { path: "lobbies/Airi_home/spine/Airi_home.atlas" },
      { path: "textures\\page.png" },
      { path: "lobbies/Airi_home/spine/missing.skel" },
    ], ["Airi_home.atlas", "page.png"])).toEqual(["lobbies/Airi_home/spine/missing.skel"]);
  });

  test("reports unavailable layers, failed file resolution, and unknown animations only when metadata is known", () => {
    const timeline = timelineFixture();
    timeline.layers = [{
      ...timeline.layers[0]!,
      id: "background",
      name: "Background",
      directory: "Airi_bg",
      animation: "Gone",
      faceAnimation: "MissingFace",
      end: 3,
      animationClips: [{ id: "clip", animation: "AlsoGone", start: 0, end: 1, animationOffset: 0, loop: false }],
    }];
    timeline.duration = 2;

    expect(validateTimeline(timeline, { availableDirectories: [] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "missing-layer", target: { kind: "layer", id: "background" } }),
    ]));

    const diagnostics = validateTimeline(timeline, {
      availableDirectories: ["Airi_bg"],
      animationsByLayer: { background: ["Idle"] },
      layerLoadErrors: { background: "manifest atlas is missing" },
      manifestSchemaVersionsByLayer: { background: 9 },
    });
    expect(diagnostics.map((item) => item.kind)).toEqual(expect.arrayContaining(["missing-files", "missing-animation", "unsupported-version"]));
    expect(diagnostics.filter((item) => item.kind === "missing-animation")).toHaveLength(3);
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "timeline-bounds", target: { kind: "layer", id: "background" } })]));
    expect(validateTimeline(timeline, { availableDirectories: ["Airi_bg"] }).some((item) => item.kind === "missing-animation")).toBe(false);
  });

  test("reports invalid ranges, subtitle bounds, enabled overlaps, and missing translations", () => {
    const timeline = timelineFixture();
    timeline.duration = 2;
    timeline.subtitles = [
      { id: "one", start: 0, end: 1.5, enabled: true, text: { en: "Hello", ja: "", ko: "" } },
      { id: "two", start: 1, end: 2.5, enabled: true, text: { en: "World", ja: "こんにちは", ko: "" } },
      { id: "disabled", start: 0.5, end: 1, enabled: false, text: { en: "Hidden", ja: "", ko: "" } },
    ];
    timeline.language = "ja";

    const diagnostics = validateTimeline(timeline, { availableDirectories: [] });
    expect(diagnostics.map((item) => item.kind)).toEqual(expect.arrayContaining(["subtitle-bounds", "subtitle-overlap", "missing-translation"]));
    expect(diagnostics.filter((item) => item.kind === "subtitle-overlap")).toHaveLength(1);
    expect(diagnostics.some((item) => item.id === "subtitle:disabled:translation:ja")).toBe(false);
  });

  test("reports same-time duplicate translations without flagging repeated dialogue later", () => {
    const timeline = timelineFixture();
    timeline.subtitles = [
      { id: "first", start: 1, end: 2, enabled: true, text: { en: "Hello", ja: "こんにちは", ko: "안녕" } },
      { id: "duplicate", start: 1.0005, end: 2.5, enabled: true, text: { en: "  ＨＥＬＬＯ  ", ja: "こんにちは", ko: "안녕" } },
      { id: "later-repeat", start: 4, end: 5, enabled: true, text: { en: "Hello", ja: "こんにちは", ko: "안녕" } },
      { id: "disabled-copy", start: 1, end: 2, enabled: false, text: { en: "Hello", ja: "こんにちは", ko: "안녕" } },
    ];

    const diagnostics = validateTimeline(timeline, { availableDirectories: [] });
    const duplicates = diagnostics.filter((item) => item.kind === "subtitle-duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      id: "subtitle:duplicate:duplicate:first",
      target: { kind: "cue", id: "duplicate" },
    });
    expect(duplicates[0]?.message).toContain("Subtitle #1");
    expect(diagnostics.some((item) => item.kind === "subtitle-overlap" && item.target?.id === "first")).toBe(false);
  });

  test("reports missing audio and stale explicit subtitle links with navigable targets", () => {
    const timeline = timelineFixture();
    timeline.audio = [{
      id: "voice",
      name: "Voice",
      path: "audios/missing.ogg",
      start: 0,
      end: 1,
      enabled: true,
      volume: 1,
      subtitleId: "deleted-cue",
    }];

    const diagnostics = validateTimeline(timeline, { availableDirectories: [], missingAudioPaths: ["audios/missing.ogg"] });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "missing-audio", target: { kind: "audio", id: "voice" } }),
      expect.objectContaining({ kind: "missing-subtitle-link", target: { kind: "audio", id: "voice" } }),
    ]));
  });
});
