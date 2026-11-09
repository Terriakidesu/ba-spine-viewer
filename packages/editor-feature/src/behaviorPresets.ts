import {
  migrateLegacyInteractionsToBehaviors,
  normalizeSpineBehaviorMachine,
  normalizeSpineBehaviorMachines,
  type SpineBehaviorAction,
  type SpineBehaviorCondition,
  type SpineBehaviorEvent,
  type SpineBehaviorMachine,
  type SpineBehaviorState,
  type SpineBehaviorTransition,
} from "@ba-spine/spine-runtime/spine/spineBehavior";
import { DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS } from "@ba-spine/spine-runtime/spine/spineInteraction";

export const SPINE_BEHAVIOR_PRESETS = [
  { id: "blank", name: "Blank machine", description: "A single empty state to build from." },
  { id: "tap-animation", name: "Tap animation", description: "Play an editable body/face animation on press." },
  { id: "head-interaction", name: "Head interaction", description: "Region-based hold with animation, drag and rotation states." },
  { id: "look-follow", name: "Pointer look-follow", description: "Follow the pointer and return with editable animation phases." },
  { id: "drag-rotate", name: "Drag + rotate", description: "A region-based drag and rotation controller." },
  { id: "audio-subtitle", name: "Audio + subtitle cue", description: "Start an audio and subtitle pair, then clean it up on a timer." },
] as const;

export type SpineBehaviorPresetId = typeof SPINE_BEHAVIOR_PRESETS[number]["id"];

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function state(id: string, name: string, actions: SpineBehaviorAction[] = []): SpineBehaviorState {
  return { id, name, actions, exitActions: [], cancelActions: [], resourceClaims: [] };
}

function transition(
  fromStateId: string,
  toStateId: string,
  event: SpineBehaviorEvent,
  options: {
    conditions?: SpineBehaviorCondition[];
    afterSeconds?: number;
    priority?: number;
    interruptPolicy?: SpineBehaviorTransition["interruptPolicy"];
  } = {},
): SpineBehaviorTransition {
  return {
    id: makeId("transition"),
    fromStateId,
    toStateId,
    event,
    conditions: options.conditions ?? [],
    afterSeconds: options.afterSeconds ?? 0,
    priority: options.priority ?? 0,
    blendDuration: 0.14,
    interruptPolicy: options.interruptPolicy ?? "allow",
  };
}

function baseMachine(name: string): SpineBehaviorMachine {
  const idle = state("idle", "Idle");
  return {
    id: makeId("behavior"),
    name,
    enabled: true,
    priority: 0,
    exclusiveGroup: null,
    resourceClaims: [],
    activation: { kind: "pointer-region", trigger: "press", regions: [], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
    initialStateId: idle.id,
    cancelPolicy: "run-exit",
    states: [idle],
    transitions: [],
    sourceLegacyInteractionId: null,
  };
}

function animationAction(loop: boolean): SpineBehaviorAction {
  return { type: "play-animation", mainAnimation: null, faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop, mixDuration: 0.14 };
}

function region(name: string, shape: "ellipse" | "rectangle" = "ellipse") {
  return {
    id: makeId("region"),
    name,
    enabled: true,
    shape,
    anchorBone: null,
    offsetX: 0,
    offsetY: 0,
    radiusX: 120,
    radiusY: 90,
    rotation: 0,
  };
}

function normalize(machine: SpineBehaviorMachine): SpineBehaviorMachine {
  const result = normalizeSpineBehaviorMachine(machine);
  if (!result) throw new Error(`Could not create behavior preset: ${machine.name}`);
  return result;
}

/** Create a fresh, editable machine from one of Behavior Studio's named starters. */
export function createSpineBehaviorPreset(presetId: SpineBehaviorPresetId): SpineBehaviorMachine {
  if (presetId === "blank") return baseMachine("New behavior");

  if (presetId === "tap-animation") {
    const machine = baseMachine("Tap animation");
    const playing = state("playing", "Playing", [animationAction(false)]);
    return normalize({
      ...machine,
      activation: { kind: "pointer-canvas", trigger: "press", regions: [], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
      states: [machine.states[0]!, playing],
      transitions: [transition("idle", "playing", "pointer-press"), transition("playing", "idle", "timer-elapsed", { afterSeconds: 0.6 })],
    });
  }

  if (presetId === "head-interaction") {
    const machine = baseMachine("Head interaction");
    const head = region("Head region");
    const starting = state("starting", "Starting", [animationAction(false)]);
    const active = state("active", "Active", [
      animationAction(true),
      { type: "drag-bone", targetBonePath: null, sensitivity: 0.25, limitX: 90, limitY: 65, allowX: true, allowY: true, smoothing: 8, returnDuration: 0.35 },
      { type: "rotate-bone", targetBonePath: null, axis: "x", minimum: -20, maximum: 20, returnDuration: 0.35 },
    ]);
    const releasing = state("releasing", "Releasing", [animationAction(false)]);
    return normalize({
      ...machine,
      exclusiveGroup: "character-input",
      activation: { kind: "pointer-region", trigger: "hold", regions: [head], holdDelay: 0.25, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
      states: [machine.states[0]!, starting, active, releasing],
      transitions: [
        transition("idle", "starting", "pointer-press", { conditions: [{ type: "region-hit", regionIds: [head.id] }], interruptPolicy: "deny" }),
        transition("starting", "active", "timer-elapsed", { conditions: [{ type: "pointer-held", value: true }], afterSeconds: 0.35, priority: 1 }),
        transition("starting", "releasing", "pointer-release"),
        transition("active", "releasing", "pointer-release"),
        transition("releasing", "idle", "timer-elapsed", { afterSeconds: 0.35 }),
      ],
    });
  }

  if (presetId === "look-follow") {
    const migrated = migrateLegacyInteractionsToBehaviors([], DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS)
      .find((machine) => machine.name === "Look-follow");
    if (!migrated) throw new Error("Could not create pointer look-follow preset");
    return normalize({ ...migrated, id: makeId("behavior"), name: "Pointer look-follow", sourceLegacyInteractionId: null });
  }

  if (presetId === "drag-rotate") {
    const machine = baseMachine("Drag + rotate");
    const hitRegion = region("Control region", "rectangle");
    const active = state("active", "Controlling", [
      { type: "drag-bone", targetBonePath: null, sensitivity: 0.25, limitX: 90, limitY: 65, allowX: true, allowY: true, smoothing: 8, returnDuration: 0.35 },
      { type: "rotate-bone", targetBonePath: null, axis: "y", minimum: -20, maximum: 20, returnDuration: 0.35 },
    ]);
    return normalize({
      ...machine,
      activation: { kind: "pointer-region", trigger: "drag", regions: [hitRegion], holdDelay: 0, dragThreshold: 12, timerSeconds: 0, event: "pointer-press" },
      states: [machine.states[0]!, active],
      transitions: [
        transition("idle", "active", "pointer-press", { conditions: [{ type: "region-hit", regionIds: [hitRegion.id] }] }),
        transition("active", "idle", "pointer-release"),
        transition("active", "idle", "pointer-cancel"),
      ],
    });
  }

  const machine = baseMachine("Audio + subtitle cue");
  const cue = state("cue", "Cue", [
    { type: "play-audio", audioId: "audio-id", volume: 1, loop: false },
    { type: "show-subtitle", cueId: "subtitle-cue-id" },
  ]);
  return normalize({
    ...machine,
    activation: { kind: "pointer-canvas", trigger: "press", regions: [], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
    states: [machine.states[0]!, cue],
    transitions: [transition("idle", "cue", "pointer-press"), transition("cue", "idle", "timer-elapsed", { afterSeconds: 4 })],
  });
}

/** Append a fresh starter and return its normalized machine for selection in the UI. */
export function applySpineBehaviorPreset(
  machines: readonly SpineBehaviorMachine[],
  presetId: SpineBehaviorPresetId,
): { machines: SpineBehaviorMachine[]; machine: SpineBehaviorMachine } {
  const created = createSpineBehaviorPreset(presetId);
  const normalized = normalizeSpineBehaviorMachines([...machines, created]);
  const machine = normalized.find((item) => item.id === created.id) ?? normalized.at(-1);
  if (!machine) throw new Error(`Could not apply behavior preset: ${presetId}`);
  return { machines: normalized, machine };
}
