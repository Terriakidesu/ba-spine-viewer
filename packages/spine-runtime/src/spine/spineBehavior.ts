import type { SpineAuthoredInteraction, SpineInteractionRegion, SpineLookFollowSettings } from "./spineInteraction";

export type SpineBehaviorEvent =
  | "pointer-press"
  | "pointer-release"
  | "pointer-drag"
  | "pointer-cancel"
  | "pointer-leave"
  | "timer-elapsed"
  | "animation-complete"
  | "state-entered"
  | "manual";

export type SpineBehaviorScalar = string | number | boolean | null;

export type SpineBehaviorCondition =
  | { type: "pointer-held"; value: boolean }
  | { type: "region-hit"; regionIds: string[] }
  | { type: "held-for"; seconds: number }
  | { type: "drag-distance"; minimum: number }
  | { type: "variable"; name: string; operator: "equals" | "not-equals" | "greater-than" | "less-than"; value: SpineBehaviorScalar }
  | { type: "machine-state"; machineId: string; stateId: string };

export type SpineBehaviorAction =
  | { type: "play-animation"; mainAnimation: string | null; faceAnimation: string | null; bodyTrack: number; faceTrack: number; loop: boolean; mixDuration: number; fallbackProfile?: "look-start" | "look-end" }
  | { type: "pointer-follow"; targetBonePath: string | null; allowX: boolean; allowY: boolean; rangeX: number | null; rangeY: number | null; smoothing: number }
  | { type: "drag-bone"; targetBonePath: string | null; sensitivity: number; limitX: number; limitY: number; allowX: boolean; allowY: boolean; smoothing: number; returnDuration: number }
  | { type: "rotate-bone"; targetBonePath: string | null; axis: "x" | "y"; minimum: number; maximum: number; returnDuration: number }
  | { type: "play-audio"; audioId: string; volume: number; loop: boolean }
  | { type: "show-subtitle"; cueId: string }
  | { type: "set-variable"; name: string; value: SpineBehaviorScalar }
  | { type: "wait"; seconds: number }
  | { type: "restore-resource"; resource: string };

export interface SpineBehaviorActivation {
  kind: "pointer-region" | "pointer-canvas" | "timer" | "event";
  trigger: "press" | "hold" | "drag";
  regions: SpineInteractionRegion[];
  holdDelay: number;
  dragThreshold: number;
  timerSeconds: number;
  event: SpineBehaviorEvent;
}

export interface SpineBehaviorState {
  id: string;
  name: string;
  actions: SpineBehaviorAction[];
  exitActions: SpineBehaviorAction[];
  cancelActions: SpineBehaviorAction[];
  resourceClaims: string[];
}

export interface SpineBehaviorTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  event: SpineBehaviorEvent;
  conditions: SpineBehaviorCondition[];
  afterSeconds: number;
  priority: number;
  blendDuration: number;
  interruptPolicy: "allow" | "deny" | "queue";
}

export interface SpineBehaviorMachine {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  exclusiveGroup: string | null;
  resourceClaims: string[];
  activation: SpineBehaviorActivation;
  initialStateId: string;
  cancelPolicy: "reset" | "run-exit";
  states: SpineBehaviorState[];
  transitions: SpineBehaviorTransition[];
  /** Identifies a compatibility-generated machine; never controls runtime behavior. */
  sourceLegacyInteractionId: string | null;
}

const MAX_BEHAVIOR_DELAY = 3600;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown, fallback: number, min = 0, max = MAX_BEHAVIOR_DELAY): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function scalar(value: unknown): SpineBehaviorScalar | null {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null
    ? value as SpineBehaviorScalar
    : null;
}

function uniqueStrings(values: unknown): string[] {
  return Array.isArray(values)
    ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort()
    : [];
}

function normalizeRegion(value: unknown, index: number): SpineInteractionRegion | null {
  const region = record(value);
  if (!Object.keys(region).length) return null;
  return {
    id: text(region.id, `region-${index + 1}`),
    name: text(region.name, `Region ${index + 1}`),
    enabled: region.enabled !== false,
    shape: region.shape === "rectangle" ? "rectangle" : "ellipse",
    anchorBone: nullableText(region.anchorBone),
    offsetX: number(region.offsetX, 0, -1_000_000, 1_000_000),
    offsetY: number(region.offsetY, 0, -1_000_000, 1_000_000),
    radiusX: number(region.radiusX, 100, 0, 1_000_000),
    radiusY: number(region.radiusY, 75, 0, 1_000_000),
    rotation: number(region.rotation, 0, -360_000, 360_000),
  };
}

function normalizeAction(value: unknown): SpineBehaviorAction | null {
  const action = record(value);
  switch (action.type) {
    case "play-animation": {
      const fallbackProfile = action.fallbackProfile === "look-start" || action.fallbackProfile === "look-end" ? action.fallbackProfile : undefined;
      const bodyTrack = number(action.bodyTrack, fallbackProfile ? 1 : 3, 1, 32);
      let faceTrack = number(action.faceTrack, fallbackProfile ? 2 : 4, 1, 32);
      if (faceTrack === bodyTrack) faceTrack = bodyTrack < 32 ? bodyTrack + 1 : bodyTrack - 1;
      return {
        type: "play-animation",
        mainAnimation: nullableText(action.mainAnimation),
        faceAnimation: nullableText(action.faceAnimation),
        bodyTrack,
        faceTrack,
        loop: action.loop === true,
        mixDuration: number(action.mixDuration, 0.14, 0, 2),
        ...(fallbackProfile ? { fallbackProfile } : {}),
      };
    }
    case "pointer-follow":
      return {
        type: "pointer-follow",
        targetBonePath: nullableText(action.targetBonePath),
        allowX: action.allowX !== false,
        allowY: action.allowY !== false,
        rangeX: typeof action.rangeX === "number" && Number.isFinite(action.rangeX) ? number(action.rangeX, 0, 0, 512) : null,
        rangeY: typeof action.rangeY === "number" && Number.isFinite(action.rangeY) ? number(action.rangeY, 0, 0, 512) : null,
        smoothing: number(action.smoothing, 14, 0.1, 60),
      };
    case "drag-bone":
      return {
        type: "drag-bone",
        targetBonePath: nullableText(action.targetBonePath),
        sensitivity: number(action.sensitivity, 0.25, 0, 10),
        limitX: number(action.limitX, 90, 0, 10_000),
        limitY: number(action.limitY, 65, 0, 10_000),
        allowX: action.allowX !== false,
        allowY: action.allowY !== false,
        smoothing: number(action.smoothing, 8, 0.1, 60),
        returnDuration: number(action.returnDuration, 0.35, 0.05, 10),
      };
    case "rotate-bone":
      return {
        type: "rotate-bone",
        targetBonePath: nullableText(action.targetBonePath),
        axis: action.axis === "y" ? "y" : "x",
        minimum: number(action.minimum, -20, -360, 0),
        maximum: number(action.maximum, 20, 0, 360),
        returnDuration: number(action.returnDuration, 0.35, 0.05, 10),
      };
    case "play-audio":
      return { type: "play-audio", audioId: text(action.audioId), volume: number(action.volume, 1, 0, 1), loop: action.loop === true };
    case "show-subtitle":
      return { type: "show-subtitle", cueId: text(action.cueId) };
    case "set-variable":
      return { type: "set-variable", name: text(action.name), value: scalar(action.value) };
    case "wait":
      return { type: "wait", seconds: number(action.seconds, 0, 0, MAX_BEHAVIOR_DELAY) };
    case "restore-resource":
      return { type: "restore-resource", resource: text(action.resource) };
    default:
      // Saved projects are data-only; executable/script action types are rejected.
      return null;
  }
}

function normalizeCondition(value: unknown): SpineBehaviorCondition | null {
  const condition = record(value);
  switch (condition.type) {
    case "pointer-held":
      return { type: "pointer-held", value: condition.value === true };
    case "region-hit":
      return { type: "region-hit", regionIds: uniqueStrings(condition.regionIds) };
    case "held-for":
      return { type: "held-for", seconds: number(condition.seconds, 0, 0, MAX_BEHAVIOR_DELAY) };
    case "drag-distance":
      return { type: "drag-distance", minimum: number(condition.minimum, 0, 0, 1_000_000) };
    case "variable": {
      const operator = condition.operator === "not-equals" || condition.operator === "greater-than" || condition.operator === "less-than"
        ? condition.operator
        : "equals";
      return { type: "variable", name: text(condition.name), operator, value: scalar(condition.value) };
    }
    case "machine-state":
      return { type: "machine-state", machineId: text(condition.machineId), stateId: text(condition.stateId) };
    default:
      return null;
  }
}

function normalizeEvent(value: unknown): SpineBehaviorEvent {
  return value === "pointer-press" || value === "pointer-release" || value === "pointer-drag"
    || value === "pointer-cancel" || value === "pointer-leave" || value === "timer-elapsed"
    || value === "animation-complete" || value === "state-entered"
    ? value
    : "manual";
}

function normalizeActivation(value: unknown): SpineBehaviorActivation {
  const activation = record(value);
  const kind = activation.kind === "pointer-region" || activation.kind === "pointer-canvas" || activation.kind === "timer"
    ? activation.kind
    : "event";
  const trigger = activation.trigger === "press" || activation.trigger === "drag" ? activation.trigger : "hold";
  const regions = (Array.isArray(activation.regions) ? activation.regions : [])
    .map((region, index) => normalizeRegion(region, index))
    .filter((region): region is SpineInteractionRegion => region !== null);
  return {
    kind,
    trigger,
    regions,
    holdDelay: number(activation.holdDelay, 0, 0, 10),
    dragThreshold: number(activation.dragThreshold, 4, 0, 10_000),
    timerSeconds: number(activation.timerSeconds, 0, 0, MAX_BEHAVIOR_DELAY),
    event: normalizeEvent(activation.event),
  };
}

function normalizeState(value: unknown, index: number): SpineBehaviorState | null {
  const state = record(value);
  if (!Object.keys(state).length) return null;
  const actions = (Array.isArray(state.actions) ? state.actions : []).map(normalizeAction).filter((action): action is SpineBehaviorAction => action !== null);
  const exitActions = (Array.isArray(state.exitActions) ? state.exitActions : []).map(normalizeAction).filter((action): action is SpineBehaviorAction => action !== null);
  const cancelActions = (Array.isArray(state.cancelActions) ? state.cancelActions : []).map(normalizeAction).filter((action): action is SpineBehaviorAction => action !== null);
  const actionClaims = actions.flatMap((action) => {
    switch (action.type) {
      case "play-animation": return [`track:${action.bodyTrack}`, `track:${action.faceTrack}`];
      case "pointer-follow":
      case "drag-bone":
      case "rotate-bone": return action.targetBonePath ? [`bone:${action.targetBonePath}`] : [];
      case "play-audio": return action.audioId ? [`audio:${action.audioId}`] : [];
      case "show-subtitle": return action.cueId ? [`subtitle:${action.cueId}`] : [];
      case "set-variable":
      case "wait":
      case "restore-resource": return [];
    }
  });
  return {
    id: text(state.id, `state-${index + 1}`),
    name: text(state.name, `State ${index + 1}`),
    actions,
    exitActions,
    cancelActions,
    resourceClaims: uniqueStrings([...(Array.isArray(state.resourceClaims) ? state.resourceClaims : []), ...actionClaims]),
  };
}

function normalizeTransition(value: unknown, index: number): SpineBehaviorTransition | null {
  const transition = record(value);
  if (!Object.keys(transition).length) return null;
  const conditions = (Array.isArray(transition.conditions) ? transition.conditions : [])
    .map(normalizeCondition)
    .filter((condition): condition is SpineBehaviorCondition => condition !== null);
  const interruptPolicy = transition.interruptPolicy === "deny" || transition.interruptPolicy === "queue" ? transition.interruptPolicy : "allow";
  return {
    id: text(transition.id, `transition-${index + 1}`),
    fromStateId: text(transition.fromStateId),
    toStateId: text(transition.toStateId),
    event: normalizeEvent(transition.event),
    conditions,
    afterSeconds: number(transition.afterSeconds, 0, 0, MAX_BEHAVIOR_DELAY),
    priority: number(transition.priority, 0, -1000, 1000),
    blendDuration: number(transition.blendDuration, 0.14, 0, 2),
    interruptPolicy,
  };
}

export function normalizeSpineBehaviorMachine(value: unknown, index = 0): SpineBehaviorMachine | null {
  const machine = record(value);
  if (!Object.keys(machine).length) return null;
  const states = (Array.isArray(machine.states) ? machine.states : []).map(normalizeState).filter((state): state is SpineBehaviorState => state !== null);
  if (states.length === 0) states.push({ id: "idle", name: "Idle", actions: [], exitActions: [], cancelActions: [], resourceClaims: [] });
  const stateIds = new Set(states.map((state) => state.id));
  const transitions = (Array.isArray(machine.transitions) ? machine.transitions : [])
    .map(normalizeTransition)
    .filter((transition): transition is SpineBehaviorTransition => Boolean(transition && stateIds.has(transition.fromStateId) && stateIds.has(transition.toStateId)));
  const requestedInitial = text(machine.initialStateId);
  const cancelPolicy = machine.cancelPolicy === "run-exit" ? "run-exit" : "reset";
  return {
    id: text(machine.id, `behavior-${index + 1}`),
    name: text(machine.name, `Behavior ${index + 1}`),
    enabled: machine.enabled !== false,
    priority: number(machine.priority, 0, -1000, 1000),
    exclusiveGroup: nullableText(machine.exclusiveGroup),
    resourceClaims: uniqueStrings(machine.resourceClaims),
    activation: normalizeActivation(machine.activation),
    initialStateId: stateIds.has(requestedInitial) ? requestedInitial : states[0]!.id,
    cancelPolicy,
    states,
    transitions,
    sourceLegacyInteractionId: nullableText(machine.sourceLegacyInteractionId),
  };
}

export function normalizeSpineBehaviorMachines(value: unknown): SpineBehaviorMachine[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value
    .map((machine, index) => normalizeSpineBehaviorMachine(machine, index))
    .filter((machine): machine is SpineBehaviorMachine => machine !== null)
    .map((machine) => {
      if (!ids.has(machine.id)) {
        ids.add(machine.id);
        return machine;
      }
      let suffix = 2;
      while (ids.has(`${machine.id}-${suffix}`)) suffix += 1;
      const unique = { ...machine, id: `${machine.id}-${suffix}` };
      ids.add(unique.id);
      return unique;
    });
}

function animationAction(main: string, face: string, loop: boolean, fallbackProfile?: "look-start" | "look-end"): SpineBehaviorAction {
  return {
    type: "play-animation",
    mainAnimation: nullableText(main),
    faceAnimation: nullableText(face),
    bodyTrack: fallbackProfile ? 1 : 3,
    faceTrack: fallbackProfile ? 2 : 4,
    loop,
    mixDuration: 0.14,
    ...(fallbackProfile ? { fallbackProfile } : {}),
  };
}

function legacyInteractionMachine(interaction: SpineAuthoredInteraction, index: number): SpineBehaviorMachine {
  const startState = "starting";
  const activeState = "active";
  const releaseState = "releasing";
  const regionIds = interaction.regions.filter((region) => region.enabled).map((region) => region.id);
  const activeActions: SpineBehaviorAction[] = [
    animationAction(interaction.followAnimation, interaction.faceFollowAnimation, true),
  ];
  if (interaction.followTargetBone || interaction.limitX > 0 || interaction.limitY > 0) {
    activeActions.push({
      type: "drag-bone",
      targetBonePath: interaction.followTargetBone,
      sensitivity: interaction.sensitivity,
      limitX: interaction.limitX,
      limitY: interaction.limitY,
      allowX: interaction.allowX !== false,
      allowY: interaction.allowY !== false,
      smoothing: interaction.smoothing,
      returnDuration: interaction.returnDuration ?? 0.35,
    });
  }
  if (interaction.rotationEnabled) {
    activeActions.push({
      type: "rotate-bone",
      targetBonePath: interaction.followTargetBone,
      axis: interaction.rotationAxis === "y" ? "y" : "x",
      minimum: interaction.rotationMin ?? -20,
      maximum: interaction.rotationMax ?? 20,
      returnDuration: interaction.returnDuration ?? 0.35,
    });
  }

  const followsAfterStart = interaction.trigger !== "press";
  const transitions: SpineBehaviorTransition[] = [
    {
      id: `${interaction.id}-press`, fromStateId: "idle", toStateId: startState, event: "pointer-press",
      conditions: [{ type: "region-hit", regionIds }], afterSeconds: 0, priority: 0, blendDuration: interaction.startMixDuration ?? 0.14, interruptPolicy: "deny",
    },
    {
      id: `${interaction.id}-start-active`, fromStateId: startState, toStateId: activeState, event: "animation-complete",
      conditions: followsAfterStart ? [{ type: "pointer-held", value: true }] : [], afterSeconds: 0, priority: 10, blendDuration: interaction.followMixDuration ?? 0.14, interruptPolicy: "allow",
    },
    {
      id: `${interaction.id}-start-release`, fromStateId: startState, toStateId: releaseState, event: "animation-complete",
      conditions: followsAfterStart ? [{ type: "pointer-held", value: false }] : [], afterSeconds: 0, priority: 0, blendDuration: interaction.releaseMixDuration ?? 0.14, interruptPolicy: "allow",
    },
    {
      id: `${interaction.id}-release`, fromStateId: activeState, toStateId: releaseState, event: "pointer-release",
      conditions: [], afterSeconds: 0, priority: 0, blendDuration: interaction.releaseMixDuration ?? 0.14, interruptPolicy: "allow",
    },
    {
      id: `${interaction.id}-cancel`, fromStateId: activeState, toStateId: releaseState, event: "pointer-cancel",
      conditions: [], afterSeconds: 0, priority: 10, blendDuration: interaction.releaseMixDuration ?? 0.14, interruptPolicy: "allow",
    },
    {
      id: `${interaction.id}-leave`, fromStateId: activeState, toStateId: releaseState, event: "pointer-leave",
      conditions: [], afterSeconds: 0, priority: 10, blendDuration: interaction.releaseMixDuration ?? 0.14, interruptPolicy: "allow",
    },
    {
      id: `${interaction.id}-finish`, fromStateId: releaseState, toStateId: "idle", event: "animation-complete",
      conditions: [], afterSeconds: 0, priority: 0, blendDuration: interaction.releaseMixDuration ?? 0.14, interruptPolicy: "allow",
    },
  ];
  return {
    id: interaction.id || `legacy-interaction-${index + 1}`,
    name: interaction.name || `Interaction ${index + 1}`,
    enabled: interaction.enabled,
    priority: 0,
    exclusiveGroup: "character-gesture",
    resourceClaims: ["track:3", "track:4", ...(interaction.followTargetBone ? [`bone:${interaction.followTargetBone}`] : [])],
    activation: {
      kind: "pointer-region",
      trigger: interaction.trigger,
      regions: interaction.regions,
      holdDelay: 0,
      dragThreshold: 4,
      timerSeconds: 0,
      event: "pointer-press",
    },
    initialStateId: "idle",
    cancelPolicy: "run-exit",
    sourceLegacyInteractionId: interaction.id,
    states: [
      { id: "idle", name: "Idle", actions: [], exitActions: [], cancelActions: [], resourceClaims: [] },
      { id: startState, name: "Starting", actions: [animationAction(interaction.startAnimation, interaction.faceStartAnimation, false)], exitActions: [], cancelActions: [{ type: "restore-resource", resource: "interaction-motion" }], resourceClaims: ["track:3", "track:4"] },
      { id: activeState, name: "Active", actions: activeActions, exitActions: [], cancelActions: [{ type: "restore-resource", resource: "interaction-motion" }], resourceClaims: ["track:3", "track:4", ...(interaction.followTargetBone ? [`bone:${interaction.followTargetBone}`] : [])] },
      { id: releaseState, name: "Releasing", actions: interaction.endAnimation || interaction.faceEndAnimation ? [animationAction(interaction.endAnimation, interaction.faceEndAnimation, false)] : [], exitActions: [], cancelActions: [{ type: "restore-resource", resource: "interaction-motion" }], resourceClaims: ["track:3", "track:4"] },
    ],
    transitions,
  };
}

function lookFollowMachine(settings: SpineLookFollowSettings, existingIds: Set<string>): SpineBehaviorMachine {
  let id = "look-follow";
  let suffix = 2;
  while (existingIds.has(id)) id = `look-follow-${suffix++}`;
  const start = animationAction(settings.startAnimation, settings.faceStartAnimation, false, "look-start");
  const end = animationAction(settings.endAnimation, settings.faceEndAnimation, false, "look-end");
  return {
    id,
    name: "Look-follow",
    enabled: settings.enabled,
    priority: 10,
    exclusiveGroup: "gaze",
    resourceClaims: ["track:1", "track:2", ...(settings.targetBonePath ? [`bone:${settings.targetBonePath}`] : ["bone:auto-look-target"])],
    activation: { kind: "pointer-canvas", trigger: "hold", regions: [], holdDelay: settings.delay, dragThreshold: 0, timerSeconds: 0, event: "pointer-press" },
    initialStateId: "neutral",
    cancelPolicy: "run-exit",
    sourceLegacyInteractionId: "$legacy-look-follow",
    states: [
      { id: "neutral", name: "Neutral", actions: [], exitActions: [], cancelActions: [], resourceClaims: [] },
      {
        id: "following", name: "Following", actions: [
          start,
          { type: "pointer-follow", targetBonePath: settings.targetBonePath, allowX: settings.allowX, allowY: settings.allowY, rangeX: settings.rangeX, rangeY: settings.rangeY, smoothing: settings.smoothing },
        ],
        exitActions: [],
        cancelActions: [{ type: "restore-resource", resource: "look-follow-target" }],
        resourceClaims: ["track:1", "track:2", ...(settings.targetBonePath ? [`bone:${settings.targetBonePath}`] : ["bone:auto-look-target"])],
      },
      { id: "returning", name: "Returning", actions: [end], exitActions: [], cancelActions: [{ type: "restore-resource", resource: "look-follow-target" }], resourceClaims: ["track:1", "track:2"] },
    ],
    transitions: [
      // The activation's holdDelay already models the authored look delay.
      { id: `${id}-start`, fromStateId: "neutral", toStateId: "following", event: "pointer-press", conditions: [{ type: "pointer-held", value: true }], afterSeconds: 0, priority: 10, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: `${id}-release`, fromStateId: "following", toStateId: "returning", event: "pointer-release", conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: `${id}-cancel`, fromStateId: "following", toStateId: "returning", event: "pointer-cancel", conditions: [], afterSeconds: 0, priority: 10, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: `${id}-leave`, fromStateId: "following", toStateId: "returning", event: "pointer-leave", conditions: [], afterSeconds: 0, priority: 10, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: `${id}-return`, fromStateId: "returning", toStateId: "neutral", event: "animation-complete", conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" },
    ],
  };
}

/** Compile the legacy interaction schema into equivalent data-only state machines. */
export function migrateLegacyInteractionsToBehaviors(
  interactions: readonly SpineAuthoredInteraction[],
  lookFollow?: SpineLookFollowSettings,
): SpineBehaviorMachine[] {
  const machines = interactions.map(legacyInteractionMachine);
  if (lookFollow) machines.push(lookFollowMachine(lookFollow, new Set(machines.map((machine) => machine.id))));
  return normalizeSpineBehaviorMachines(machines);
}

/** Locate the designated compatibility Look-follow machine, including after it is authored. */
export function findLookFollowBehaviorMachine(machines: readonly SpineBehaviorMachine[]): SpineBehaviorMachine | null {
  return machines.find((machine) => machine.sourceLegacyInteractionId === "$legacy-look-follow")
    ?? machines.find((machine) => /^look-follow(?:-\d+)?$/i.test(machine.id))
    ?? machines.find((machine) => machine.name.trim().toLocaleLowerCase() === "look-follow")
    ?? null;
}

/** Read the friendly Look-follow values from the canonical behavior machine. */
export function spineLookFollowSettingsFromBehaviorMachines(
  fallback: SpineLookFollowSettings,
  machines: readonly SpineBehaviorMachine[],
): SpineLookFollowSettings {
  const machine = findLookFollowBehaviorMachine(machines);
  if (!machine || machine.sourceLegacyInteractionId !== null) return fallback;
  const pointerAction = machine.states.flatMap((state) => state.actions).find((action) => action.type === "pointer-follow");
  const startAction = machine.states.flatMap((state) => state.actions).find((action) => action.type === "play-animation" && action.fallbackProfile === "look-start");
  const endAction = machine.states.flatMap((state) => state.actions).find((action) => action.type === "play-animation" && action.fallbackProfile === "look-end");
  return {
    ...fallback,
    enabled: machine.enabled,
    delay: machine.activation.holdDelay,
    ...(pointerAction?.type === "pointer-follow" ? {
      targetBonePath: pointerAction.targetBonePath,
      allowX: pointerAction.allowX,
      allowY: pointerAction.allowY,
      rangeX: pointerAction.rangeX,
      rangeY: pointerAction.rangeY,
      smoothing: pointerAction.smoothing,
    } : {}),
    ...(startAction?.type === "play-animation" ? {
      startAnimation: startAction.mainAnimation ?? "",
      faceStartAnimation: startAction.faceAnimation ?? "",
    } : {}),
    ...(endAction?.type === "play-animation" ? {
      endAnimation: endAction.mainAnimation ?? "",
      faceEndAnimation: endAction.faceAnimation ?? "",
    } : {}),
  };
}

/** Apply friendly Look-follow edits to the same machine while retaining other authored machine data. */
export function behaviorMachineWithLookFollowSettings(
  machine: SpineBehaviorMachine,
  settings: SpineLookFollowSettings,
): SpineBehaviorMachine {
  const states = machine.states.map((state) => {
    let foundPointer = false;
    let foundStart = false;
    let foundEnd = false;
    const actions = state.actions.map((action): SpineBehaviorAction => {
      if (action.type === "pointer-follow") {
        foundPointer = true;
        return { ...action, targetBonePath: settings.targetBonePath, allowX: settings.allowX, allowY: settings.allowY, rangeX: settings.rangeX, rangeY: settings.rangeY, smoothing: settings.smoothing };
      }
      if (action.type === "play-animation" && action.fallbackProfile === "look-start") {
        foundStart = true;
        return { ...action, mainAnimation: settings.startAnimation || null, faceAnimation: settings.faceStartAnimation || null };
      }
      if (action.type === "play-animation" && action.fallbackProfile === "look-end") {
        foundEnd = true;
        return { ...action, mainAnimation: settings.endAnimation || null, faceAnimation: settings.faceEndAnimation || null };
      }
      return action;
    });
    if (state.id === "following" && !foundPointer) actions.push({ type: "pointer-follow", targetBonePath: settings.targetBonePath, allowX: settings.allowX, allowY: settings.allowY, rangeX: settings.rangeX, rangeY: settings.rangeY, smoothing: settings.smoothing });
    if (state.id === "following" && !foundStart) actions.unshift(animationAction(settings.startAnimation, settings.faceStartAnimation, false, "look-start"));
    if (state.id === "returning" && !foundEnd) actions.unshift(animationAction(settings.endAnimation, settings.faceEndAnimation, false, "look-end"));
    return { ...state, actions };
  });
  const normalized = normalizeSpineBehaviorMachine({
    ...machine,
    enabled: settings.enabled,
    activation: { ...machine.activation, kind: "pointer-canvas", trigger: "hold", holdDelay: settings.delay },
    states,
  });
  return normalized ?? machine;
}

/** Project the compatibility subset of authored machines back into the friendly interaction controls. */
export function projectBehaviorMachinesToLegacyInteractions<T extends SpineAuthoredInteraction>(
  interactions: readonly T[],
  machines: readonly SpineBehaviorMachine[],
): T[] {
  return interactions.map((interaction) => {
    const machine = machines.find((item) => item.id === interaction.id && item.sourceLegacyInteractionId === null);
    if (!machine) return interaction;
    const starting = machine.states.find((state) => state.id === "starting");
    const active = machine.states.find((state) => state.id === "active");
    const releasing = machine.states.find((state) => state.id === "releasing");
    const start = starting?.actions.find((action) => action.type === "play-animation");
    const follow = active?.actions.find((action) => action.type === "play-animation");
    const release = releasing?.actions.find((action) => action.type === "play-animation");
    const drag = active?.actions.find((action) => action.type === "drag-bone");
    const rotate = active?.actions.find((action) => action.type === "rotate-bone");
    const transitionMix = (suffix: string, fallback: number | undefined) => machine.transitions.find((item) => item.id === `${interaction.id}-${suffix}`)?.blendDuration ?? fallback;
    return {
      ...interaction,
      name: machine.name,
      enabled: machine.enabled,
      ...(machine.activation.kind === "pointer-region" ? {
        trigger: machine.activation.trigger,
        regions: machine.activation.regions,
      } : {}),
      ...(start?.type === "play-animation" ? { startAnimation: start.mainAnimation ?? "", faceStartAnimation: start.faceAnimation ?? "" } : {}),
      ...(follow?.type === "play-animation" ? { followAnimation: follow.mainAnimation ?? "", faceFollowAnimation: follow.faceAnimation ?? "" } : {}),
      ...(release?.type === "play-animation" ? { endAnimation: release.mainAnimation ?? "", faceEndAnimation: release.faceAnimation ?? "" } : {}),
      ...(drag?.type === "drag-bone" ? {
        followTargetBone: drag.targetBonePath,
        sensitivity: drag.sensitivity,
        limitX: drag.limitX,
        limitY: drag.limitY,
        smoothing: drag.smoothing,
        returnDuration: drag.returnDuration,
        allowX: drag.allowX,
        allowY: drag.allowY,
      } : {}),
      ...(active ? (rotate?.type === "rotate-bone"
        ? { rotationEnabled: true, rotationAxis: rotate.axis, rotationMin: rotate.minimum, rotationMax: rotate.maximum }
        : { rotationEnabled: false }) : {}),
      startMixDuration: transitionMix("press", interaction.startMixDuration),
      followMixDuration: transitionMix("start-active", interaction.followMixDuration),
      releaseMixDuration: transitionMix("release", interaction.releaseMixDuration),
    } as T;
  });
}

/** Apply friendly interaction edits to their canonical machine without dropping additional authored actions. */
export function behaviorMachineWithLegacyInteraction(
  machine: SpineBehaviorMachine,
  interaction: SpineAuthoredInteraction,
): SpineBehaviorMachine {
  const template = legacyInteractionMachine(interaction, 0);
  const states = machine.states.map((state) => {
    const authoredTemplate = template.states.find((item) => item.id === state.id);
    if (!authoredTemplate) return state;
    const actions = [...state.actions];
    for (const type of ["play-animation", "drag-bone", "rotate-bone"] as const) {
      const templateActions = authoredTemplate.actions.filter((action) => action.type === type);
      const authoredIndex = actions.findIndex((action) => action.type === type);
      if (templateActions.length > 0) {
        if (authoredIndex >= 0) actions[authoredIndex] = templateActions[0]!;
        else actions.push(...templateActions);
      } else if (type === "rotate-bone" && authoredIndex >= 0) {
        actions.splice(authoredIndex, 1);
      }
    }
    return { ...state, actions };
  });
  const templateTransitions = new Map(template.transitions.map((transition) => [transition.id, transition]));
  const transitions = machine.transitions.map((transition) => {
    const friendly = templateTransitions.get(transition.id);
    return friendly ? { ...transition, blendDuration: friendly.blendDuration } : transition;
  });
  const normalized = normalizeSpineBehaviorMachine({
    ...machine,
    name: template.name,
    enabled: template.enabled,
    activation: template.activation,
    resourceClaims: [...new Set([...machine.resourceClaims, ...template.resourceClaims])],
    states,
    transitions,
  });
  return normalized ?? machine;
}

/** Keep compatibility-generated machines in step with the still-editable friendly controls. */
export function synchronizeLegacyBehaviorMachines(
  interactions: readonly SpineAuthoredInteraction[],
  lookFollow: SpineLookFollowSettings,
  existing: readonly SpineBehaviorMachine[] = [],
): SpineBehaviorMachine[] {
  const authored = existing.filter((machine) => machine.sourceLegacyInteractionId === null);
  const authoredLook = findLookFollowBehaviorMachine(authored);
  const generated = migrateLegacyInteractionsToBehaviors(interactions, authoredLook ? undefined : lookFollow);
  const synchronized = generated.map((machine) => {
    const authoredVersion = authored.find((item) => item.id === machine.id);
    return authoredVersion ?? machine;
  });
  const includedIds = new Set(synchronized.map((machine) => machine.id));
  for (const machine of authored) {
    if (includedIds.has(machine.id)) continue;
    synchronized.push(machine);
    includedIds.add(machine.id);
  }
  return normalizeSpineBehaviorMachines(synchronized);
}

export interface SpineBehaviorTransitionContext {
  pointerHeld: boolean;
  regionId: string | null;
  heldSeconds: number;
  dragDistance: number;
  elapsedSeconds: number;
  variables: Readonly<Record<string, SpineBehaviorScalar>>;
  machineStates: Readonly<Record<string, string>>;
}

function conditionMatches(condition: SpineBehaviorCondition, context: SpineBehaviorTransitionContext): boolean {
  switch (condition.type) {
    case "pointer-held": return context.pointerHeld === condition.value;
    case "region-hit": return context.regionId !== null && condition.regionIds.includes(context.regionId);
    case "held-for": return context.heldSeconds >= condition.seconds;
    case "drag-distance": return context.dragDistance >= condition.minimum;
    case "machine-state": return context.machineStates[condition.machineId] === condition.stateId;
    case "variable": {
      const current = context.variables[condition.name];
      if (current === undefined) return false;
      switch (condition.operator) {
        case "equals": return current === condition.value;
        case "not-equals": return current !== condition.value;
        case "greater-than": return typeof current === "number" && typeof condition.value === "number" && current > condition.value;
        case "less-than": return typeof current === "number" && typeof condition.value === "number" && current < condition.value;
      }
    }
  }
}

/** Pick one eligible edge predictably; transition priority breaks same-event ties. */
export function evaluateSpineBehaviorTransition(
  machine: SpineBehaviorMachine,
  fromStateId: string,
  event: SpineBehaviorEvent,
  context: SpineBehaviorTransitionContext,
): SpineBehaviorTransition | null {
  return machine.transitions
    .filter((transition) => transition.fromStateId === fromStateId && transition.event === event)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .find((transition) => context.elapsedSeconds >= transition.afterSeconds && transition.conditions.every((condition) => conditionMatches(condition, context))) ?? null;
}

export interface SpineActiveBehavior {
  machine: SpineBehaviorMachine;
  stateId: string;
}

export interface SpineBehaviorConflict {
  machineId: string;
  ownerMachineId: string;
  resource: string;
}

/** Resolve concurrent-machine conflicts by priority, then stable machine ID. */
export function arbitrateSpineBehaviors(candidates: readonly SpineActiveBehavior[]): { accepted: SpineActiveBehavior[]; blocked: SpineBehaviorConflict[] } {
  const ordered = [...candidates].sort((left, right) => right.machine.priority - left.machine.priority || left.machine.id.localeCompare(right.machine.id));
  const accepted: SpineActiveBehavior[] = [];
  const blocked: SpineBehaviorConflict[] = [];
  const resourceOwners = new Map<string, string>();
  const groupOwners = new Map<string, string>();
  for (const candidate of ordered) {
    const { machine } = candidate;
    if (!machine.enabled) continue;
    const state = machine.states.find((item) => item.id === candidate.stateId);
    if (!state) continue;
    const groupResource = machine.exclusiveGroup ? `group:${machine.exclusiveGroup}` : null;
    const groupOwner = machine.exclusiveGroup ? groupOwners.get(machine.exclusiveGroup) : undefined;
    if (groupResource && groupOwner) {
      blocked.push({ machineId: machine.id, ownerMachineId: groupOwner, resource: groupResource });
      continue;
    }
    const resources = [...new Set([...machine.resourceClaims, ...state.resourceClaims])].sort();
    const conflict = resources.map((resource) => ({ resource, owner: resourceOwners.get(resource) })).find((item) => item.owner);
    if (conflict?.owner) {
      blocked.push({ machineId: machine.id, ownerMachineId: conflict.owner, resource: conflict.resource });
      continue;
    }
    accepted.push(candidate);
    if (machine.exclusiveGroup) groupOwners.set(machine.exclusiveGroup, machine.id);
    for (const resource of resources) resourceOwners.set(resource, machine.id);
  }
  return { accepted, blocked };
}
