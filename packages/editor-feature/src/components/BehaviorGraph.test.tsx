import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { createSpineBehaviorPreset } from "../behaviorPresets";
import { autoArrangeBehaviorMachine, manualBehaviorGraphLayout } from "../behaviorGraph";
import { BehaviorGraph } from "./BehaviorGraph";

test("Behavior graph exposes keyboard-selectable states and pan, zoom, fit, and arrange controls", () => {
  const machine = createSpineBehaviorPreset("head-interaction");
  const markup = renderToStaticMarkup(createElement(BehaviorGraph, {
    machine,
    layout: manualBehaviorGraphLayout(autoArrangeBehaviorMachine(machine, 4)),
    selected: null,
    runningStateId: "active",
    onLayoutChange: () => undefined,
    onSelect: () => undefined,
  }));

  expect(markup).toContain('role="group"');
  expect(markup).toContain('aria-label="Head interaction state graph"');
  expect(markup).toContain('title="Fit graph"');
  expect(markup).toContain('title="Arrange states automatically"');
  expect(markup).toContain('aria-label="Zoom in"');
  expect(markup).toContain('aria-label="Zoom out"');
  expect(markup).toContain("middle/Space pan");
  expect(markup).toContain("drag header to move");
  expect(markup).toContain("INITIAL STATE");
});
