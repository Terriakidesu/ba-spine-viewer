import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { createSpineBehaviorPreset } from "../behaviorPresets";
import { autoArrangeBehaviorMachine, manualBehaviorGraphLayout } from "../behaviorGraph";
import { BehaviorGraph } from "./BehaviorGraph";

test("Behavior graph exposes familiar select, pan, zoom, fit, and arrange controls", () => {
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
  expect(markup).toContain('aria-label="Head interaction state graph.');
  expect(markup).toContain('aria-keyshortcuts="V H F Escape Space"');
  expect(markup).toContain('title="Fit graph (F)"');
  expect(markup).toContain('title="Arrange states automatically"');
  expect(markup).toContain('title="Select states (V)"');
  expect(markup).toContain('title="Pan the graph (H)"');
  expect(markup).toContain('aria-label="Zoom in"');
  expect(markup).toContain('aria-label="Zoom out"');
  expect(markup).toContain("middle/Space-drag pans");
  expect(markup).toContain("background drag pans");
  expect(markup).toContain("Escape cancels or deselects");
  expect(markup).toContain("drag to move");
  expect(markup).toContain("INITIAL STATE");
});
