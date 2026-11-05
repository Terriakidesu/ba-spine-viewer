import { describe, expect, test } from "bun:test";
import { Animation, AnimationState, AnimationStateData, BoneData, Skeleton, SkeletonData } from "@esotericsoftware/spine-core";
import { authoredRegions, DEFAULT_TALK_MIX_DURATION, findInteractionProfile, interactionPhaseAfterStart, interactionPressReady, INTERACTION_PHASE_MIX, normalizeSpineInteractionProject, profileFromProject, setInteractionTrack } from "./spineInteraction";

describe("Spine lobby interaction data", () => {
  test("pairs the game start, follow and release tracks", () => {
    const profile = findInteractionProfile([
      "Idle_01", "Pat_01_M", "Pat_01_A", "PatEnd_01_M", "PatEnd_01_A",
      "Look_01_M", "LookEnd_01_M", "LookEnd_01_A", "Talk_02_M", "Talk_02_A", "Talk_01_M", "Talk_01_A",
    ]);
    expect(profile.pat).toEqual({
      start: { main: "Pat_01_M", face: "Pat_01_A" },
      follow: { main: "Pat_01_M", face: "Pat_01_A" },
      release: { main: "PatEnd_01_M", face: "PatEnd_01_A" },
    });
    expect(profile.look).toEqual({
      start: { main: "Look_01_M", face: null },
      end: { main: "LookEnd_01_M", face: "LookEnd_01_A" },
    });
    expect(profile.talks).toEqual([
      { main: "Talk_01_M", face: "Talk_01_A" },
      { main: "Talk_02_M", face: "Talk_02_A" },
    ]);
  });

  test("detects Touch and Pat2 naming used by newer home sets", () => {
    const profile = findInteractionProfile(["Touch_01_M", "Touch_02_M", "TouchEnd_01_M", "Pat2_01_M", "Pat2End_01_M", "Pat2_02_M"]);
    expect(profile.pat?.start.main).toBe("Pat2_01_M");
    expect(profile.pat?.follow.main).toBe("Pat2_02_M");
    expect(profile.pat?.release?.main).toBe("Pat2End_01_M");
    expect(profile.touch?.start.main).toBe("Touch_01_M");
    expect(profile.touch?.follow.main).toBe("Touch_02_M");
    expect(profile.touch?.release?.main).toBe("TouchEnd_01_M");
  });

  test("detects cheek pinch tracks independently from patting", () => {
    const profile = findInteractionProfile([
      "Idle_01",
      "Pat_01_M", "PatEnd_01_M",
      "Pinch_01_M", "Pinch_01_A", "PinchEnd_01_M", "PinchEnd_01_A",
    ]);
    expect(profile.pat?.start.main).toBe("Pat_01_M");
    expect(profile.pat?.follow.main).toBe("Pat_01_M");
    expect(profile.pinch).toEqual({
      start: { main: "Pinch_01_M", face: "Pinch_01_A" },
      follow: { main: "Pinch_01_M", face: "Pinch_01_A" },
      release: { main: "PinchEnd_01_M", face: "PinchEnd_01_A" },
    });
  });

  test("uses the exported project phases instead of auto-detected variants", () => {
    const profile = profileFromProject(
      ["Idle_01", "Pat_01_M", "Pat_02_M", "PatEnd_01_M", "Pat_01_A", "CustomPatEnd_M"],
      {
        schemaVersion: 1,
        assetDirectory: "Airi_home",
        interactions: [{
          id: "pat",
          name: "Patting",
          enabled: true,
          trigger: "hold",
          startAnimation: "Pat_01_M",
          followAnimation: "Pat_02_M",
          endAnimation: "CustomPatEnd_M",
          faceStartAnimation: "Pat_01_A",
          faceFollowAnimation: "",
          faceEndAnimation: "",
          followTargetBone: null,
          sensitivity: 0.25,
          limitX: 90,
          limitY: 65,
          smoothing: 8,
          regions: [],
        }],
      },
    );
    expect(profile.pat).toEqual({
      start: { main: "Pat_01_M", face: "Pat_01_A" },
      follow: { main: "Pat_02_M", face: null },
      release: { main: "CustomPatEnd_M", face: null },
    });
  });

  test("crossfades when an interaction changes phase", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("start", [], 0.3), new Animation("follow", [], 0.5));
    const state = new AnimationState(new AnimationStateData(data));
    const skeleton = new Skeleton(data);
    setInteractionTrack(state, 3, "start", false);
    state.apply(skeleton);
    const next = setInteractionTrack(state, 3, "follow", true)!;
    expect(next.mixDuration).toBe(INTERACTION_PHASE_MIX);
    expect(next.mixingFrom?.animation?.name).toBe("start");
  });

  test("uses a configurable mix duration and blends the first overlay up from idle", () => {
    const data = new SkeletonData();
    data.bones.push(new BoneData(0, "root", null));
    data.animations.push(new Animation("start", [], 0.3));
    const state = new AnimationState(new AnimationStateData(data));
    const entry = setInteractionTrack(state, 3, "start", false, 0.42)!;
    expect(entry.mixDuration).toBe(0.42);
    expect(state.getCurrent(3)?.animation?.name).toBe("start");
    expect(state.getCurrent(3)?.mixingFrom?.animation?.name).toBe("<empty>");
  });

  test("normalizes per-phase and Talk mix settings without changing legacy defaults", () => {
    const legacy = normalizeSpineInteractionProject({ schemaVersion: 2, assetDirectory: "Airi_home", interactions: [{ id: "touch", name: "Touch", regions: [] }] });
    expect(legacy?.talkMixDuration).toBe(DEFAULT_TALK_MIX_DURATION);
    expect(legacy?.effectsStrength).toBe(0.5);
    expect(legacy?.interactions[0]).toMatchObject({ startMixDuration: INTERACTION_PHASE_MIX, followMixDuration: INTERACTION_PHASE_MIX, releaseMixDuration: INTERACTION_PHASE_MIX });

    const configured = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      talkMixDuration: 0.8,
      effectsStrength: 0.85,
      interactions: [{ id: "touch", name: "Touch", startMixDuration: 0.25, followMixDuration: 0, releaseMixDuration: 9, regions: [] }],
    });
    expect(configured).toMatchObject({ talkMixDuration: 0.8, effectsStrength: 0.85 });
    expect(normalizeSpineInteractionProject({ schemaVersion: 2, assetDirectory: "Airi_home", effectsStrength: 2, interactions: [] })?.effectsStrength).toBe(1);
    expect(configured?.interactions[0]).toMatchObject({ startMixDuration: 0.25, followMixDuration: 0, releaseMixDuration: 2 });
  });

  test("uses authored trigger gates and phase transitions for both previews", () => {
    expect(interactionPressReady("hold", true, 0)).toBe(true);
    expect(interactionPressReady("press", true, 0)).toBe(true);
    expect(interactionPressReady("drag", true, 3.99)).toBe(false);
    expect(interactionPressReady("drag", true, 4)).toBe(true);
    expect(interactionPressReady("drag", false, 100)).toBe(false);
    expect(interactionPhaseAfterStart("press", true)).toBe("releasing");
    expect(interactionPhaseAfterStart("hold", true)).toBe("holding");
    expect(interactionPhaseAfterStart("drag", false)).toBe("releasing");
  });

  test("normalizes authored regions and keeps them attached to their interaction kind", () => {
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
        regions: [{ id: "head", name: "Head", shape: "rectangle", anchorBone: "root/head", offsetX: 2, offsetY: -3, radiusX: 100, radiusY: 80, rotation: 5 }],
      }],
    });
    expect(project?.interactions[0]?.regions[0]).toMatchObject({ shape: "rectangle", anchorBone: "root/head", offsetX: 2 });
    expect(project?.interactions[0]).toMatchObject({ returnDuration: 0.35, returnEasing: "ease-out" });
    expect(authoredRegions(project)).toMatchObject([{ kind: "pat", id: "head", enabled: true }]);
  });

  test("normalizes authored return easing and duration without changing follow smoothing", () => {
    const project = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      interactions: [{
        id: "touch",
        name: "Touch",
        startAnimation: "Touch_01_M",
        followAnimation: "Touch_02_M",
        smoothing: 12,
        returnDuration: 0.8,
        returnEasing: "linear",
        regions: [],
      }],
    });
    expect(project?.interactions[0]).toMatchObject({ smoothing: 12, returnDuration: 0.8, returnEasing: "linear" });
    const invalid = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      interactions: [{ id: "touch", name: "Touch", startAnimation: "Touch_01_M", followAnimation: "Touch_02_M", returnDuration: 20, returnEasing: "bounce", regions: [] }],
    });
    expect(invalid?.interactions[0]).toMatchObject({ returnDuration: 2, returnEasing: "ease-out" });
    const tooShort = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      interactions: [{ id: "touch", name: "Touch", startAnimation: "Touch_01_M", followAnimation: "Touch_02_M", returnDuration: 0.01, regions: [] }],
    });
    expect(tooShort?.interactions[0]?.returnDuration).toBe(0.05);
  });

  test("ignores developer and nested duplicate talk tracks when root tracks exist", () => {
    const profile = findInteractionProfile(["Dev/Talk_01_M", "Dev/Talk_01_A", "Talk_01_M", "Talk_01_A", "talk2/Talk_01_M"]);
    expect(profile.talks).toEqual([{ main: "Talk_01_M", face: "Talk_01_A" }]);
  });
});
