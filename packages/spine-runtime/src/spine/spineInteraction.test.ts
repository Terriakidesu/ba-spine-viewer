import { describe, expect, test } from "bun:test";
import { Animation, AnimationState, AnimationStateData, BoneData, Skeleton, SkeletonData } from "@esotericsoftware/spine-core";
import { createEmptySpineComposition } from "./spineComposition";
import { authoredInteractionAction, authoredRegions, DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, DEFAULT_TALK_MIX_DURATION, findInteractionProfile, interactionPhaseAfterStart, interactionPressReady, INTERACTION_PHASE_MIX, lookFollowRotation, lookFollowTarget, normalizeSpineInteractionProject, normalizeSpineLookFollowSettings, profileFromProject, setInteractionTrack, smoothLookFollowPoint } from "./spineInteraction";

describe("Spine lobby interaction data", () => {
  test("Viewer project normalization retains a supported unified composition and refuses newer versions", () => {
    const composition = createEmptySpineComposition("composition-1", "Unified timeline", 8, 30);
    expect(normalizeSpineInteractionProject({ schemaVersion: 9, assetDirectory: "Airi_home", interactions: [], composition })?.composition).toEqual(composition);
    expect(normalizeSpineInteractionProject({ schemaVersion: 9, assetDirectory: "Airi_home", interactions: [], composition: { ...composition, schemaVersion: 2 } })).toBeNull();
  });

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

  test("resolves distinct authored animation phases for multiple interactions of the same kind", () => {
    const animations = [
      "Touch_Left_Start", "Touch_Left_Follow", "Touch_Left_End", "Touch_Left_Face_Start", "Touch_Left_Face_Follow", "Touch_Left_Face_End",
      "Touch_Right_Start", "Touch_Right_Follow", "Touch_Right_End", "Touch_Right_Face_Start", "Touch_Right_Face_Follow", "Touch_Right_Face_End",
    ];
    const project = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      interactions: [
        {
          id: "touch-left",
          name: "Touch left",
          startAnimation: "Touch_Left_Start",
          followAnimation: "Touch_Left_Follow",
          endAnimation: "Touch_Left_End",
          faceStartAnimation: "Touch_Left_Face_Start",
          faceFollowAnimation: "Touch_Left_Face_Follow",
          faceEndAnimation: "Touch_Left_Face_End",
          regions: [{ id: "left", name: "Left", anchorBone: "root/LeftHand" }],
        },
        {
          id: "touch-right",
          name: "Touch right",
          startAnimation: "Touch_Right_Start",
          followAnimation: "Touch_Right_Follow",
          endAnimation: "Touch_Right_End",
          faceStartAnimation: "Touch_Right_Face_Start",
          faceFollowAnimation: "Touch_Right_Face_Follow",
          faceEndAnimation: "Touch_Right_Face_End",
          regions: [{ id: "right", name: "Right", anchorBone: "root/RightHand" }],
        },
      ],
    })!;

    expect(authoredInteractionAction(animations, project.interactions[0]!)?.start).toEqual({ main: "Touch_Left_Start", face: "Touch_Left_Face_Start" });
    expect(authoredInteractionAction(animations, project.interactions[1]!)?.follow).toEqual({ main: "Touch_Right_Follow", face: "Touch_Right_Face_Follow" });
    expect(authoredInteractionAction(animations, project.interactions[1]!)?.release).toEqual({ main: "Touch_Right_End", face: "Touch_Right_Face_End" });
    expect(profileFromProject(animations, project).touch?.start.main).toBe("Touch_Left_Start");
    expect(authoredRegions(project).map(({ interactionId, id }) => [interactionId, id])).toEqual([
      ["touch-left", "left"],
      ["touch-right", "right"],
    ]);
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

  test("normalizes saved look-follow settings while preserving automatic ranges", () => {
    const legacy = normalizeSpineInteractionProject({ schemaVersion: 2, assetDirectory: "Airi_home", interactions: [] });
    expect(legacy?.lookFollow).toEqual(DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS);

    const configured = normalizeSpineLookFollowSettings({
      enabled: false,
      targetBonePath: "root/Touch_Eye",
      delay: 9,
      rangeX: 84,
      rangeY: -12,
      smoothing: 40,
      allowX: false,
      allowY: true,
      rotationEnabled: true,
      rotationAxis: "y",
      rotationMin: -38,
      rotationMax: 24,
      startAnimation: "Look_Custom_M",
      faceStartAnimation: "Look_Custom_A",
      endAnimation: "Look_Custom_End_M",
      faceEndAnimation: "Look_Custom_End_A",
    });
    expect(configured).toEqual({
      enabled: false,
      targetBonePath: "root/Touch_Eye",
      delay: 2,
      rangeX: 84,
      rangeY: 0,
      smoothing: 30,
      allowX: false,
      allowY: true,
      rotationEnabled: true,
      rotationAxis: "y",
      rotationMin: -38,
      rotationMax: 24,
      startAnimation: "Look_Custom_M",
      faceStartAnimation: "Look_Custom_A",
      endAnimation: "Look_Custom_End_M",
      faceEndAnimation: "Look_Custom_End_A",
    });
    expect(normalizeSpineLookFollowSettings({ rangeX: null, rangeY: Number.NaN }).rangeX).toBeNull();
    expect(normalizeSpineLookFollowSettings({ rangeX: null, rangeY: Number.NaN }).rangeY).toBeNull();
  });

  test("normalizes Pat-style Look-follow rotation limits and maps the selected input axis", () => {
    expect(normalizeSpineLookFollowSettings({}).rotationEnabled).toBe(false);
    expect(normalizeSpineLookFollowSettings({ rotationEnabled: true, rotationAxis: "y", rotationMin: 20, rotationMax: 240 })).toMatchObject({
      rotationEnabled: true, rotationAxis: "y", rotationMin: 0, rotationMax: 180,
    });
    expect(lookFollowRotation({ x: -50, y: 10 }, 100, 100, "x", -30, 20)).toBeCloseTo(-15);
    expect(lookFollowRotation({ x: -50, y: 50 }, 100, 100, "y", -30, 20)).toBeCloseTo(10);
    expect(lookFollowRotation({ x: 200, y: 0 }, 100, 100, "x", -30, 20)).toBeCloseTo(20);
    expect(lookFollowRotation(null, 100, 100, "x", -30, 20)).toBe(0);

    const project = normalizeSpineInteractionProject({
      schemaVersion: 2,
      assetDirectory: "Airi_home",
      interactions: [],
      lookFollow: { rotationEnabled: true, rotationAxis: "y", rotationMin: -44, rotationMax: 26 },
    })!;
    expect(project.lookFollow).toMatchObject({ rotationEnabled: true, rotationAxis: "y", rotationMin: -44, rotationMax: 26 });
    expect(project.behaviorMachines?.find((machine) => machine.id === "look-follow")?.states.find((state) => state.id === "following")?.actions)
      .toContainEqual(expect.objectContaining({ type: "pointer-follow", rotationEnabled: true, rotationAxis: "y", rotationMin: -44, rotationMax: 26 }));
  });

  test("uses automatic look phases by default and supports authored look overrides", () => {
    const animations = ["Look_01_M", "Look_01_A", "LookEnd_01_M", "LookEnd_01_A", "CustomLook_M", "CustomLook_A", "CustomLookEnd_M"];
    const automatic = normalizeSpineInteractionProject({ schemaVersion: 1, assetDirectory: "Airi_home", interactions: [] })!;
    expect(profileFromProject(animations, automatic).look).toEqual({
      start: { main: "Look_01_M", face: "Look_01_A" },
      end: { main: "LookEnd_01_M", face: "LookEnd_01_A" },
    });

    const authored = normalizeSpineInteractionProject({
      schemaVersion: 1,
      assetDirectory: "Airi_home",
      lookFollow: { startAnimation: "CustomLook_M", faceStartAnimation: "CustomLook_A", endAnimation: "CustomLookEnd_M" },
      interactions: [],
    })!;
    expect(profileFromProject(animations, authored).look).toEqual({
      start: { main: "CustomLook_M", face: "CustomLook_A" },
      end: { main: "CustomLookEnd_M", face: "LookEnd_01_A" },
    });
    const faceOnlyOverride = normalizeSpineInteractionProject({
      schemaVersion: 1,
      assetDirectory: "Airi_home",
      lookFollow: { faceStartAnimation: "CustomLook_A" },
      interactions: [],
    })!;
    expect(profileFromProject(animations, faceOnlyOverride).look?.start).toEqual({ main: "Look_01_M", face: "CustomLook_A" });
    const missingOverride = normalizeSpineInteractionProject({
      schemaVersion: 1,
      assetDirectory: "Airi_home",
      lookFollow: { startAnimation: "Missing_Look" },
      interactions: [],
    })!;
    expect(profileFromProject(animations, missingOverride).look?.start.main).toBe("Look_01_M");
    expect(profileFromProject(["Idle_01"], automatic).look).toBeNull();
    const disabled = normalizeSpineInteractionProject({ schemaVersion: 1, assetDirectory: "Airi_home", lookFollow: { enabled: false }, interactions: [] })!;
    expect(profileFromProject(animations, disabled).look).toBeNull();
  });

  test("clamps look-follow target and applies smoothing without moving on a paused frame", () => {
    expect(lookFollowTarget({ x: 10, y: 20 }, { x: 100, y: -100 }, 25, 12, true, true)).toEqual({ x: 35, y: 8 });
    expect(lookFollowTarget({ x: 10, y: 20 }, { x: 100, y: -100 }, 25, 12, false, true)).toEqual({ x: 10, y: 8 });
    expect(lookFollowTarget({ x: 10, y: 20 }, null, 25, 12, true, true)).toEqual({ x: 10, y: 20 });
    expect(smoothLookFollowPoint({ x: 0, y: 0 }, { x: 100, y: -50 }, 0, 14)).toEqual({ x: 0, y: 0 });
    const halfSecond = smoothLookFollowPoint({ x: 0, y: 0 }, { x: 100, y: -50 }, 0.5, 14);
    expect(halfSecond.x).toBeCloseTo(99.9086, 3);
    expect(halfSecond.y).toBeCloseTo(-49.9543, 3);
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
