import { describe, expect, test } from "bun:test";
import { arbitrateSpineBehaviors, evaluateSpineBehaviorTransition, migrateLegacyInteractionsToBehaviors, normalizeSpineBehaviorMachine, normalizeSpineBehaviorMachines, synchronizeLegacyBehaviorMachines, type SpineBehaviorEvent, type SpineBehaviorMachine } from "./spineBehavior";
import { DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, normalizeSpineInteractionProject, type SpineAuthoredInteraction } from "./spineInteraction";
import { SpineBehaviorRuntime } from "./spineBehaviorRuntime";

const legacyPat: SpineAuthoredInteraction = {
  id: "pat-head",
  name: "Head pat",
  enabled: true,
  trigger: "hold",
  startAnimation: "PatStart_M",
  followAnimation: "PatLoop_M",
  endAnimation: "PatEnd_M",
  faceStartAnimation: "PatStart_A",
  faceFollowAnimation: "PatLoop_A",
  faceEndAnimation: "PatEnd_A",
  followTargetBone: "root/HeadTarget",
  sensitivity: 0.4,
  limitX: 80,
  limitY: 45,
  smoothing: 7,
  returnDuration: 0.4,
  allowX: true,
  allowY: false,
  rotationEnabled: true,
  rotationAxis: "y",
  rotationMin: -12,
  rotationMax: 18,
  regions: [{
    id: "head-region", name: "Head", enabled: true, shape: "ellipse", anchorBone: "root/HeadTarget",
    offsetX: 3, offsetY: 4, radiusX: 120, radiusY: 90, rotation: 5,
  }],
};

function machine(id: string, priority: number, resource: string, group: string | null = null): SpineBehaviorMachine {
  return normalizeSpineBehaviorMachine({
    id,
    name: id,
    enabled: true,
    priority,
    exclusiveGroup: group,
    resourceClaims: [resource],
    initialStateId: "idle",
    activation: { kind: "event", event: "manual" },
    states: [
      { id: "idle", name: "Idle", actions: [], resourceClaims: [] },
      { id: "active", name: "Active", actions: [], resourceClaims: [] },
    ],
    transitions: [{ id: "go", fromStateId: "idle", toStateId: "active", event: "pointer-press", priority: 2, afterSeconds: 0, conditions: [{ type: "pointer-held", value: true }] }],
  })!;
}

describe("declarative behavior machines", () => {
  test("migrates legacy gesture and look-follow settings into editable states without losing authored values", () => {
    const migrated = migrateLegacyInteractionsToBehaviors([legacyPat], {
      ...DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS,
      targetBonePath: "root/EyeTarget",
      delay: 0.5,
      startAnimation: "LookStart_M",
    });
    const pat = migrated.find((item) => item.sourceLegacyInteractionId === "pat-head")!;
    const active = pat.states.find((state) => state.id === "active")!;
    const actions = active.actions;
    const look = migrated.find((item) => item.name === "Look-follow")!;

    expect(pat.activation).toMatchObject({ kind: "pointer-region", trigger: "hold", regions: [{ id: "head-region", anchorBone: "root/HeadTarget", rotation: 5 }] });
    expect(pat.states.find((state) => state.id === "starting")?.actions[0]).toMatchObject({ type: "play-animation", mainAnimation: "PatStart_M", faceAnimation: "PatStart_A" });
    expect(actions).toContainEqual(expect.objectContaining({ type: "play-animation", mainAnimation: "PatLoop_M", faceAnimation: "PatLoop_A", loop: true }));
    expect(actions).toContainEqual(expect.objectContaining({ type: "drag-bone", targetBonePath: "root/HeadTarget", allowY: false, returnDuration: 0.4 }));
    expect(actions).toContainEqual(expect.objectContaining({ type: "rotate-bone", targetBonePath: "root/HeadTarget", axis: "y", minimum: -12, maximum: 18 }));
    expect(look.activation).toMatchObject({ kind: "pointer-canvas", holdDelay: 0.5 });
    expect(look.transitions.find((transition) => transition.id === "look-follow-start")?.afterSeconds).toBe(0);
    expect(look.states.find((state) => state.id === "following")?.actions).toContainEqual(expect.objectContaining({ type: "pointer-follow", targetBonePath: "root/EyeTarget" }));
  });

  test("evaluates matching transitions by priority and stable id, with conditions and timers", () => {
    const candidate = machine("fsm", 0, "track:1");
    candidate.transitions.push({
      id: "higher-priority", fromStateId: "idle", toStateId: "active", event: "pointer-press",
      conditions: [{ type: "held-for", seconds: 0.2 }], afterSeconds: 0.1, priority: 8, blendDuration: 0.14, interruptPolicy: "allow",
    });
    const rejected = evaluateSpineBehaviorTransition(candidate, "idle", "pointer-press", {
      pointerHeld: true, regionId: null, heldSeconds: 0.1, dragDistance: 0, elapsedSeconds: 0.3, variables: {}, machineStates: {},
    });
    expect(rejected?.id).toBe("go");

    const accepted = evaluateSpineBehaviorTransition(candidate, "idle", "pointer-press", {
      pointerHeld: true, regionId: null, heldSeconds: 0.25, dragDistance: 0, elapsedSeconds: 0.3, variables: {}, machineStates: {},
    });
    expect(accepted?.id).toBe("higher-priority");
  });

  test("arbitrates exclusive groups and resource claims deterministically", () => {
    const candidates = [
      { machine: machine("z-look", 3, "bone:eyes", "gaze"), stateId: "active" },
      { machine: machine("a-look", 3, "bone:eyes", "gaze"), stateId: "active" },
      { machine: machine("mouth", 2, "bone:mouth"), stateId: "active" },
    ];
    const first = arbitrateSpineBehaviors(candidates);
    const second = arbitrateSpineBehaviors([...candidates].reverse());
    expect(first.accepted.map(({ machine: item }) => item.id)).toEqual(["a-look", "mouth"]);
    expect(first.blocked).toEqual([{ machineId: "z-look", ownerMachineId: "a-look", resource: "group:gaze" }]);
    expect(second).toEqual(first);
  });

  test("rejects executable action payloads and malformed transition targets", () => {
    const normalized = normalizeSpineBehaviorMachine({
      id: "safe", states: [{ id: "idle", actions: [{ type: "script", source: "alert(1)" }] }],
      transitions: [{ id: "invalid", fromStateId: "idle", toStateId: "missing", event: "manual" }],
    })!;
    expect(normalized.states[0]?.actions).toEqual([]);
    expect(normalized.transitions).toEqual([]);
    expect(normalizeSpineBehaviorMachines([normalized, normalized]).map((item) => item.id)).toEqual(["safe", "safe-2"]);
  });

  test("migrates old saved projects and preserves explicit behavior machines on reload", () => {
    const old = normalizeSpineInteractionProject({ assetDirectory: "Airi_home", interactions: [legacyPat] })!;
    expect(old.behaviorMachines?.find((item) => item.id === "pat-head")?.sourceLegacyInteractionId).toBe("pat-head");
    const authored = machine("custom", 4, "track:9");
    const newProject = normalizeSpineInteractionProject({ ...old, behaviorMachines: [authored] })!;
    expect(newProject.behaviorMachines?.map((item) => item.id)).toEqual(["pat-head", "look-follow", "custom"]);
  });

  test("legacy Look-follow migration carries every authored setting into the generated machine", () => {
    const authored = {
      ...DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS,
      enabled: false,
      targetBonePath: "root/EyeTarget",
      delay: 0.76,
      rangeX: 92,
      rangeY: 37,
      smoothing: 21,
      allowX: false,
      allowY: true,
      startAnimation: "LookStart_M",
      faceStartAnimation: "LookStart_A",
      endAnimation: "LookEnd_M",
      faceEndAnimation: "LookEnd_A",
    };
    const look = migrateLegacyInteractionsToBehaviors([legacyPat], authored).find((item) => item.id === "look-follow")!;
    const follow = look.states.find((state) => state.id === "following")!;
    expect(look).toMatchObject({ enabled: false, sourceLegacyInteractionId: "$legacy-look-follow", activation: { holdDelay: 0.76 } });
    expect(follow.actions.find((action) => action.type === "pointer-follow")).toMatchObject({
      targetBonePath: "root/EyeTarget", rangeX: 92, rangeY: 37, smoothing: 21, allowX: false, allowY: true,
    });
    expect(follow.actions.find((action) => action.type === "play-animation" && action.fallbackProfile === "look-start")).toMatchObject({ mainAnimation: "LookStart_M", faceAnimation: "LookStart_A" });
    expect(look.states.find((state) => state.id === "returning")?.actions[0]).toMatchObject({ mainAnimation: "LookEnd_M", faceAnimation: "LookEnd_A" });
  });

  test("legacy synchronization updates generated machines and retains independently authored machines", () => {
    const authored = { ...machine("custom", 4, "track:9"), sourceLegacyInteractionId: null };
    const initial = synchronizeLegacyBehaviorMachines([legacyPat], DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, [authored]);
    const updated = synchronizeLegacyBehaviorMachines([{ ...legacyPat, startAnimation: "PatNew_M" }], DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS, initial);
    expect(updated.find((item) => item.id === "pat-head")?.states.find((state) => state.id === "starting")?.actions[0]).toMatchObject({ mainAnimation: "PatNew_M" });
    expect(updated.some((item) => item.id === "custom")).toBe(true);
  });

  test("runtime waits for delayed edges, emits actions, transitions, and runs declared cleanup", () => {
    const trace: string[] = [];
    const ownership: boolean[] = [];
    const delayed = normalizeSpineBehaviorMachine({
      id: "delayed", name: "Delayed", enabled: true, priority: 1, exclusiveGroup: null, resourceClaims: [],
      activation: { kind: "pointer-canvas", trigger: "hold", event: "pointer-press" }, initialStateId: "idle", cancelPolicy: "run-exit",
      states: [
        { id: "idle", name: "Idle", actions: [], exitActions: [], cancelActions: [], resourceClaims: [] },
        { id: "active", name: "Active", actions: [{ type: "set-variable", name: "entered", value: true }], exitActions: [{ type: "restore-resource", resource: "demo" }], cancelActions: [{ type: "show-subtitle", cueId: "cancelled" }], resourceClaims: ["track:3"] },
      ],
      transitions: [
        { id: "enter", fromStateId: "idle", toStateId: "active", event: "pointer-press", afterSeconds: 0.5, conditions: [{ type: "pointer-held", value: true }] },
        { id: "release", fromStateId: "active", toStateId: "idle", event: "pointer-release" },
      ],
    })!;
    const runtime = new SpineBehaviorRuntime([delayed], {
      onActions: (_machine, state, actions, phase) => trace.push(`${phase}:${state.id}:${actions.map((action) => action.type).join(",")}`),
      onTransition: (_machine, transition) => trace.push(`transition:${transition.id}`),
      onOwnershipChange: (_machine, _state, owned) => ownership.push(owned),
    });

    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    expect(runtime.getDebugSnapshot()[0]?.lastReason).toBe("waiting");
    runtime.update(0.3, { pointerHeld: true, regionId: null, heldSeconds: 0.3, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.2, { pointerHeld: true, regionId: null, heldSeconds: 0.5, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("active");
    expect(trace).toContain("transition:enter");

    runtime.dispatch("pointer-release", { pointerHeld: false, regionId: null, heldSeconds: 0.5, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    expect(trace).toContain("exit:active:restore-resource");

    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    runtime.update(0.5, { pointerHeld: true, regionId: null, heldSeconds: 0.5, dragDistance: 0, variables: {} });
    runtime.cancel("delayed");
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    expect(trace).toContain("cancel:active:show-subtitle");
    expect(ownership.slice(-2)).toEqual([true, false]);
    expect(runtime.getDebugSnapshot()[0]?.active).toBe(false);
    runtime.dispose();
  });

  test("runtime reports deterministic ownership conflicts in live machine snapshots", () => {
    const low = normalizeSpineBehaviorMachine({
      ...machine("low", 1, "bone:head"),
      activation: { kind: "pointer-canvas", trigger: "press", event: "pointer-press" },
    })!;
    const high = normalizeSpineBehaviorMachine({
      ...machine("high", 5, "bone:head"),
      activation: { kind: "pointer-canvas", trigger: "press", event: "pointer-press" },
    })!;
    const runtime = new SpineBehaviorRuntime([low, high]);
    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    const snapshot = runtime.getDebugSnapshot();
    expect(snapshot.find((entry) => entry.machineId === "high")).toMatchObject({ stateId: "active", active: true });
    expect(snapshot.find((entry) => entry.machineId === "low")).toMatchObject({ stateId: "idle", active: false, lastReason: "resource-conflict", blockedBy: { machineId: "high", resource: "bone:head" } });
    runtime.dispose();
  });

  test("stopping a test run cancels every engaged machine and releases all ownership", () => {
    const ownership: Array<{ machineId: string; owned: boolean }> = [];
    const runtime = new SpineBehaviorRuntime([
      machine("test-a", 1, "track:3"),
      machine("test-b", 2, "track:4"),
    ], {
      onOwnershipChange: (activeMachine, _state, owned) => ownership.push({ machineId: activeMachine.id, owned }),
    });
    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} }, undefined, { bypassActivation: true });
    expect(runtime.getDebugSnapshot().filter((item) => item.active)).toHaveLength(2);

    runtime.cancelAll("cancel");

    expect(runtime.getDebugSnapshot().every((item) => !item.active && item.stateId === "idle")).toBe(true);
    expect(ownership.filter((item) => !item.owned).map((item) => item.machineId).sort()).toEqual(["test-a", "test-b"]);
    runtime.dispose();
  });

  test("hold activation waits once, then applies the transition delay; release cancels the held trigger", () => {
    const base = machine("hold-delay", 1, "track:3");
    const held = normalizeSpineBehaviorMachine({
      ...base,
      activation: { kind: "pointer-canvas", trigger: "hold", event: "pointer-press", holdDelay: 0.4 },
      transitions: base.transitions.map((transition) => ({ ...transition, afterSeconds: 0.2 })),
    })!;
    const runtime = new SpineBehaviorRuntime([held]);
    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    runtime.update(0.3, { pointerHeld: true, regionId: null, heldSeconds: 0.3, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.1, { pointerHeld: true, regionId: null, heldSeconds: 0.4, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.19, { pointerHeld: true, regionId: null, heldSeconds: 0.59, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.02, { pointerHeld: true, regionId: null, heldSeconds: 0.61, dragDistance: 0, variables: {} });
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("active");
    runtime.dispose();

    const cancelled = new SpineBehaviorRuntime([held]);
    cancelled.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    cancelled.dispatch("pointer-release", { pointerHeld: false, regionId: null, heldSeconds: 0.2, dragDistance: 0, variables: {} });
    cancelled.update(0.8, { pointerHeld: false, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    expect(cancelled.getDebugSnapshot()[0]?.stateId).toBe("idle");
    cancelled.dispose();
  });

  test("wait actions gate timer transitions and state-entered events chain predictably", () => {
    const timed = normalizeSpineBehaviorMachine({
      id: "wait-timer", activation: { kind: "event", event: "manual" }, initialStateId: "idle",
      states: [
        { id: "idle", actions: [] },
        { id: "waiting", actions: [{ type: "wait", seconds: 0.5 }] },
        { id: "done", actions: [] },
      ],
      transitions: [
        { id: "begin", fromStateId: "idle", toStateId: "waiting", event: "manual" },
        { id: "finish", fromStateId: "waiting", toStateId: "done", event: "timer-elapsed", afterSeconds: 0.3 },
      ],
    })!;
    const runtime = new SpineBehaviorRuntime([timed]);
    runtime.dispatch("manual");
    runtime.update(0.3);
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("waiting");
    runtime.update(0.2);
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("done");
    runtime.dispose();

    const chained = normalizeSpineBehaviorMachine({
      id: "entered-chain", activation: { kind: "event", event: "manual" }, initialStateId: "idle",
      states: [{ id: "idle", actions: [] }, { id: "one", actions: [] }, { id: "two", actions: [] }],
      transitions: [
        { id: "begin", fromStateId: "idle", toStateId: "one", event: "manual" },
        { id: "entered", fromStateId: "one", toStateId: "two", event: "state-entered" },
      ],
    })!;
    const chainedRuntime = new SpineBehaviorRuntime([chained]);
    chainedRuntime.dispatch("manual");
    expect(chainedRuntime.getDebugSnapshot()[0]?.stateId).toBe("two");
    chainedRuntime.dispose();
  });

  test("timer activation delay and transition blend duration are applied independently", () => {
    const blendValues: number[] = [];
    const timed = normalizeSpineBehaviorMachine({
      id: "timer-entry", activation: { kind: "timer", event: "timer-elapsed", timerSeconds: 0.4 }, initialStateId: "idle",
      states: [
        { id: "idle", actions: [] },
        { id: "active", actions: [{ type: "play-animation", mainAnimation: "Wave", faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop: false, mixDuration: 0.1 }] },
      ],
      transitions: [{ id: "begin", fromStateId: "idle", toStateId: "active", event: "timer-elapsed", afterSeconds: 0.1, blendDuration: 0.65 }],
    })!;
    const runtime = new SpineBehaviorRuntime([timed], {
      onActions: (_machine, _state, actions, phase) => {
        if (phase === "enter") for (const action of actions) if (action.type === "play-animation") blendValues.push(action.mixDuration);
      },
    });
    runtime.update(0.3);
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.1);
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("idle");
    runtime.update(0.1);
    expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("active");
    expect(blendValues).toEqual([0.65]);
    runtime.dispose();
  });

  test("animation completion waits for non-loop tracks and obeys allow, deny, and queue interrupts", () => {
    const createInterruptMachine = (policy: "allow" | "deny" | "queue") => normalizeSpineBehaviorMachine({
      id: `interrupt-${policy}`, activation: { kind: "event", event: "manual" }, initialStateId: "idle",
      states: [
        { id: "idle", actions: [] },
        { id: "active", actions: [{ type: "play-animation", mainAnimation: "Start", faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop: false }] },
        { id: "finished", actions: [] },
        { id: "released", actions: [] },
      ],
      transitions: [
        { id: "begin", fromStateId: "idle", toStateId: "active", event: "manual" },
        { id: "complete", fromStateId: "active", toStateId: "finished", event: "animation-complete" },
        { id: "release", fromStateId: "active", toStateId: "released", event: "pointer-release", interruptPolicy: policy },
        { id: "queued-release", fromStateId: "finished", toStateId: "idle", event: "pointer-release" },
      ],
    })!;

    for (const policy of ["allow", "deny", "queue"] as const) {
      const runtime = new SpineBehaviorRuntime([createInterruptMachine(policy)]);
      runtime.dispatch("manual");
      const completion = runtime.getAnimationCompletions()[0];
      expect(completion?.machineId).toBe(`interrupt-${policy}`);
      expect(completion?.tracks.some((track) => track.track === 3 && track.animation === "Start" && track.channel === "body")).toBe(true);
      expect(completion?.tracks.some((track) => track.track === 4 && track.animation === null && track.channel === "face")).toBe(true);
      runtime.dispatch("pointer-release", { pointerHeld: false, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
      if (policy === "allow") expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("released");
      else expect(runtime.getDebugSnapshot()[0]?.stateId).toBe("active");
      if (policy !== "allow") {
        runtime.notifyAnimationComplete(`interrupt-${policy}`);
        expect(runtime.getDebugSnapshot()[0]?.stateId).toBe(policy === "queue" ? "idle" : "finished");
      }
      runtime.dispose();
    }
  });

  test("ownership transfers release the previous machine before new enter actions", () => {
    const createContender = (id: string, priority: number, event: SpineBehaviorEvent) => {
      const base = machine(id, priority, "track:3");
      return normalizeSpineBehaviorMachine({
        ...base,
        activation: { kind: "event", event },
        states: base.states.map((state) => state.id === "active"
          ? { ...state, actions: [{ type: "set-variable", name: id, value: true }] }
          : state),
        transitions: base.transitions.map((transition) => ({ ...transition, event })),
      })!;
    };
    const trace: string[] = [];
    const runtime = new SpineBehaviorRuntime([createContender("low", 1, "manual"), createContender("high", 5, "pointer-press")], {
      onActions: (current, _state, _actions, phase) => { if (phase === "enter") trace.push(`enter:${current.id}`); },
      onOwnershipChange: (current, _state, owned) => { if (!owned) trace.push(`release:${current.id}`); },
    });
    runtime.dispatch("manual", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    runtime.dispatch("pointer-press", { pointerHeld: true, regionId: null, heldSeconds: 0, dragDistance: 0, variables: {} });
    expect(trace.indexOf("release:low")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("release:low")).toBeLessThan(trace.indexOf("enter:high"));
    expect(runtime.getDebugSnapshot().find((item) => item.machineId === "high")?.stateId).toBe("active");
    runtime.dispose();
  });

  test("normalization infers claims from animation and bone-control actions", () => {
    const normalized = normalizeSpineBehaviorMachine({
      id: "claims", initialStateId: "idle",
      states: [{
        id: "idle", actions: [
          { type: "play-animation", mainAnimation: "Wave", bodyTrack: 7, faceTrack: 8 },
          { type: "drag-bone", targetBonePath: "root/Hand" },
          { type: "play-audio", audioId: "voice.ogg" },
          { type: "show-subtitle", cueId: "line-1" },
        ],
      }],
    })!;
    expect(normalized.states[0]?.resourceClaims).toEqual([
      "audio:voice.ogg", "bone:root/Hand", "subtitle:line-1", "track:7", "track:8",
    ]);
  });
});
