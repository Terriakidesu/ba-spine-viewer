import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { normalizeSpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";
import { BehaviorEditor } from "./BehaviorEditor";

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
});
