import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { normalizeSpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { BehaviorEditor } from "./BehaviorEditor";
import { applySpineBehaviorPreset, createSpineBehaviorPreset, SPINE_BEHAVIOR_PRESETS } from "../behaviorPresets";

test("Behavior Studio renders its graph, inspector, and live action feedback", () => {
  const machine = normalizeSpineBehaviorMachine({
    id: "head-tap",
    name: "Head tap",
    activation: { kind: "pointer-canvas", trigger: "press", event: "pointer-press" },
    initialStateId: "idle",
    states: [
      { id: "idle", name: "Idle", actions: [] },
      { id: "active", name: "Active", actions: [{ type: "show-subtitle", cueId: "hello" }] },
    ],
    transitions: [{ id: "begin", fromStateId: "idle", toStateId: "active", event: "pointer-press" }],
  })!;
  const markup = renderToStaticMarkup(createElement(BehaviorEditor, {
    machines: [machine],
    animations: ["Wave"],
    debug: [],
    testFeedback: ["Audio: tap.ogg", "Subtitle: Hello there"],
    onChange: () => undefined,
    onTestEvent: () => undefined,
    onCancelTest: () => undefined,
  }));

  expect(markup).toContain('aria-label="Behavior state machine editor"');
  expect(markup).toContain('aria-label="Head tap state graph"');
  expect(markup).toContain("Machine resource claims");
  expect(markup).toContain("Input scope");
  expect(markup).toContain("Action feedback");
  expect(markup).toContain("Audio: tap.ogg");
  expect(markup).toContain("Subtitle: Hello there");
  for (const preset of SPINE_BEHAVIOR_PRESETS) expect(markup).toContain(preset.name);
});

test("named Behavior Studio presets create editable state machines", () => {
  const created = SPINE_BEHAVIOR_PRESETS.map((preset) => createSpineBehaviorPreset(preset.id));
  expect(created.map((machine) => machine.name)).toEqual([
    "New behavior",
    "Tap animation",
    "Head interaction",
    "Pointer look-follow",
    "Drag + rotate",
    "Audio + subtitle cue",
  ]);
  expect(created.every((machine) => machine.sourceLegacyInteractionId === null)).toBe(true);
  expect(new Set(created.map((machine) => machine.id)).size).toBe(created.length);

  const head = created.find((machine) => machine.name === "Head interaction")!;
  expect(head.activation).toMatchObject({ kind: "pointer-region", trigger: "hold" });
  expect(head.transitions.some((transition) => transition.event === "timer-elapsed")).toBe(true);
  expect(head.states.find((state) => state.id === "active")?.actions.map((action) => action.type)).toEqual([
    "play-animation", "drag-bone", "rotate-bone",
  ]);

  const cue = created.find((machine) => machine.name === "Audio + subtitle cue")!;
  expect(cue.states.find((state) => state.id === "cue")?.actions.map((action) => action.type)).toEqual([
    "play-audio", "show-subtitle",
  ]);
});

test("applying a named preset appends the fresh machine without mutating existing machines", () => {
  const existing = createSpineBehaviorPreset("blank");
  const applied = SPINE_BEHAVIOR_PRESETS.map((preset) => applySpineBehaviorPreset([existing], preset.id));

  for (const [index, preset] of SPINE_BEHAVIOR_PRESETS.entries()) {
    const result = applied[index]!;
    expect(result.machines).toHaveLength(2);
    expect(result.machines[0]).toEqual(existing);
    expect(result.machine).toEqual(result.machines[1]);
    expect(result.machine.name).toBe(preset.id === "blank" ? "New behavior" : preset.name);
    expect(result.machine.sourceLegacyInteractionId).toBeNull();
    expect(result.machine.id).not.toBe(existing.id);
  }
  expect(existing.name).toBe("New behavior");
});
