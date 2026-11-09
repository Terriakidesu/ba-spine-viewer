import { describe, expect, test } from "bun:test";
import { createSpineBehaviorPreset } from "./behaviorPresets";
import { createProject } from "./editorModel";
import {
  autoArrangeBehaviorMachine,
  autoArrangeBehaviorGraph,
  behaviorGraphWheelZoomFactor,
  commitBehaviorNodeDrag,
  createBehaviorNodeDragSession,
  behaviorGraphPositionsForViewport,
  fitBehaviorGraphView,
  getBehaviorGraphPointerIntent,
  manualBehaviorGraphLayout,
  normalizeBehaviorGraphLayouts,
  routeBehaviorTransitions,
  shouldDeselectBehaviorGraphBackgroundClick,
  zoomBehaviorGraphView,
} from "./behaviorGraph";

function pathNumbers(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function curveCrossesBox(path: string, box: { x: number; y: number }, width = 190, height = 108): boolean {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = pathNumbers(path);
  for (let sample = 1; sample < 32; sample += 1) {
    const t = sample / 32, inverse = 1 - t;
    const x = inverse ** 3 * x0! + 3 * inverse ** 2 * t * x1! + 3 * inverse * t ** 2 * x2! + t ** 3 * x3!;
    const y = inverse ** 3 * y0! + 3 * inverse ** 2 * t * y1! + 3 * inverse * t ** 2 * y2! + t ** 3 * y3!;
    if (x >= box.x - 8 && x <= box.x + width + 8 && y >= box.y - 8 && y <= box.y + height + 8) return true;
  }
  return false;
}

describe("behavior graph layout and geometry", () => {
  test("graph gestures match the editor canvas: background pans, states move, and pan modifiers win", () => {
    expect(getBehaviorGraphPointerIntent(0, "background", "select", false)).toBe("pan");
    expect(getBehaviorGraphPointerIntent(0, "node", "select", false)).toBe("move-node");
    expect(getBehaviorGraphPointerIntent(0, "edge", "select", false)).toBe("select-edge");
    expect(getBehaviorGraphPointerIntent(0, "node", "select", true)).toBe("pan");
    expect(getBehaviorGraphPointerIntent(1, "edge", "select", false)).toBe("pan");
    expect(getBehaviorGraphPointerIntent(0, "node", "pan", false)).toBe("pan");
    expect(getBehaviorGraphPointerIntent(2, "background", "select", false)).toBe("ignore");
    expect(shouldDeselectBehaviorGraphBackgroundClick(0, "background", false, false)).toBe(true);
    expect(shouldDeselectBehaviorGraphBackgroundClick(0, "background", true, false)).toBe(false);
    expect(shouldDeselectBehaviorGraphBackgroundClick(0, "node", false, false)).toBe(false);
    expect(shouldDeselectBehaviorGraphBackgroundClick(0, "background", false, true)).toBe(false);
    expect(shouldDeselectBehaviorGraphBackgroundClick(1, "background", false, false)).toBe(false);
  });

  test("wheel zoom response matches Camera for pixel, line, and page deltas", () => {
    expect(behaviorGraphWheelZoomFactor(100, 0, 600)).toBeLessThan(1);
    expect(behaviorGraphWheelZoomFactor(-100, 0, 600)).toBeGreaterThan(1);
    expect(behaviorGraphWheelZoomFactor(1, 1, 600)).toBeCloseTo(behaviorGraphWheelZoomFactor(16, 0, 600));
    expect(behaviorGraphWheelZoomFactor(1, 2, 600)).toBeCloseTo(behaviorGraphWheelZoomFactor(600, 0, 600));
  });

  test("migrated Patting gets an uncluttered Idle → Starting → Active → Releasing layout", () => {
    const project = createProject("Airi_home", ["Pat_01_M", "Pat_02_M", "PatEnd_01_M"], []);
    const patting = project.behaviorMachines!.find((machine) => machine.name === "Patting")!;
    expect(patting.states.map((state) => state.name)).toEqual(["Idle", "Starting", "Active", "Releasing"]);
    const positions = autoArrangeBehaviorMachine(patting, 4);
    const flow = patting.states.map((state) => positions[state.id]!);
    expect(flow.every((point, index) => index === 0 || point.x > flow[index - 1]!.x)).toBe(true);
    const routes = routeBehaviorTransitions(patting, positions);
    expect(routes).toHaveLength(patting.transitions.length);
    expect(routes.every((route) => Number.isFinite(route.labelX) && Number.isFinite(route.labelY))).toBe(true);
  });

  test("responsive auto layouts keep state boxes distinct at compact and wide graph sizes", () => {
    const patting = createSpineBehaviorPreset("head-interaction");
    for (const viewportWidth of [460, 708, 964, 1348]) {
      const positions = autoArrangeBehaviorGraph(patting, viewportWidth);
      const entries = Object.entries(positions);
      for (let left = 0; left < entries.length; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          const a = entries[left]![1], b = entries[right]![1];
          const separated = a.x + 190 + 24 <= b.x || b.x + 190 + 24 <= a.x
            || a.y + 108 + 24 <= b.y || b.y + 108 + 24 <= a.y;
          expect(separated).toBe(true);
        }
      }
    }

    const compactFlow = autoArrangeBehaviorGraph(patting, 708);
    expect(compactFlow.idle!.x).toBeLessThan(compactFlow.starting!.x);
    expect(compactFlow.starting!.x).toBeLessThan(compactFlow.active!.x);
    expect(compactFlow.releasing!.x).toBe(compactFlow.active!.x);
    expect(compactFlow.releasing!.y).toBeGreaterThan(compactFlow.active!.y);
    const verticalRelease = routeBehaviorTransitions(patting, compactFlow).find((route) => {
      const transition = patting.transitions.find((item) => item.id === route.transitionId)!;
      return transition.fromStateId === "active" && transition.toStateId === "releasing";
    })!;
    expect(verticalRelease.labelY).toBeGreaterThan(compactFlow.active!.y + 108);
    expect(verticalRelease.labelY).toBeLessThan(compactFlow.releasing!.y);
  });

  test("auto layout follows the Patting primary flow in readable left-to-right order", () => {
    const patting = createSpineBehaviorPreset("head-interaction");
    const positions = autoArrangeBehaviorMachine(patting, 4);
    const flow = ["idle", "starting", "active", "releasing"].map((id) => positions[id]!);
    expect(flow.every((point, index) => index === 0 || point.x > flow[index - 1]!.x)).toBe(true);
    expect(new Set(flow.map((point) => `${point.x},${point.y}`)).size).toBe(4);
  });

  test("manual positions survive normalization while added states avoid existing nodes", () => {
    const machine = createSpineBehaviorPreset("head-interaction");
    const normalized = normalizeBehaviorGraphLayouts({
      [machine.id]: {
        mode: "manual",
        statePositions: { idle: { x: 500, y: 260 }, starting: { x: 500, y: 260 } },
      },
    }, [machine]);
    const layout = normalized[machine.id]!;
    expect(layout.mode).toBe("manual");
    expect(layout.statePositions.idle).toEqual({ x: 500, y: 260 });
    expect(layout.statePositions.starting).toEqual({ x: 500, y: 260 });
    expect(layout.statePositions.active).toBeDefined();
    expect(layout.statePositions.releasing).toBeDefined();
    expect(behaviorGraphPositionsForViewport(machine, layout, 708)).toEqual(layout.statePositions);
    expect(behaviorGraphPositionsForViewport(machine, layout, 1348)).toEqual(layout.statePositions);
  });

  test("parallel, skipped-flow, reverse, and self-loop edges route around nodes", () => {
    const machine = createSpineBehaviorPreset("head-interaction");
    const positions = autoArrangeBehaviorMachine(machine, 4);
    const skipped = routeBehaviorTransitions(machine, positions).find((route) => {
      const transition = machine.transitions.find((item) => item.id === route.transitionId)!;
      return transition.fromStateId === "starting" && transition.toStateId === "releasing";
    })!;
    expect(Number.isFinite(skipped.labelY)).toBe(true);
    expect(curveCrossesBox(skipped.path, positions.active!)).toBe(false);

    const multi = {
      ...machine,
      transitions: [
        ...machine.transitions,
        { ...machine.transitions[0]!, id: "parallel" },
        { ...machine.transitions[0]!, id: "return-to-start", fromStateId: "starting", toStateId: "idle" },
        { ...machine.transitions[0]!, id: "self-loop", fromStateId: "active", toStateId: "active" },
        { ...machine.transitions.find((item) => item.fromStateId === "active" && item.toStateId === "releasing")!, id: "parallel-release", event: "pointer-cancel" as const },
      ],
    };
    const routes = routeBehaviorTransitions(multi, positions);
    const parallel = routes.filter((route) => route.transitionId === machine.transitions[0]!.id || route.transitionId === "parallel");
    expect(parallel).toHaveLength(2);
    expect(parallel[0]?.path).not.toBe(parallel[1]?.path);
    expect(parallel[0]?.labelY).not.toBe(parallel[1]?.labelY);
    const reverse = routes.find((route) => route.transitionId === "return-to-start")!;
    expect(Number.isFinite(reverse.labelY)).toBe(true);
    expect(curveCrossesBox(reverse.path, positions.active!)).toBe(false);
    expect(routes.find((route) => route.transitionId === "self-loop")?.path).toContain("C");
    const releaseLabels = routes.filter((route) => [
      machine.transitions.find((item) => item.fromStateId === "active" && item.toStateId === "releasing")?.id,
      "parallel-release",
    ].includes(route.transitionId));
    expect(releaseLabels).toHaveLength(2);
    expect(Math.abs(releaseLabels[0]!.labelY - releaseLabels[1]!.labelY)).toBeGreaterThanOrEqual(30);
  });

  test("diagonal edges attach to the closest facing side instead of defaulting down", () => {
    const machine = createSpineBehaviorPreset("head-interaction");
    const transition = machine.transitions.find((item) => item.fromStateId === "idle" && item.toStateId === "starting")!;
    const positions = {
      idle: { x: 0, y: 0 },
      starting: { x: 300, y: 200 },
      active: { x: 800, y: 400 },
      releasing: { x: 1000, y: 600 },
    };
    const route = routeBehaviorTransitions(machine, positions).find((item) => item.transitionId === transition.id)!;
    const values = pathNumbers(route.path);
    expect(values[1]).toBe(108);
    expect(values[7]).toBe(200);
    expect(values[0]).toBe(95);
    expect(values[6]).toBe(395);
  });

  test("a direct edge detours around an intervening node instead of crossing it", () => {
    const base = createSpineBehaviorPreset("head-interaction");
    const machine = { ...base, transitions: [...base.transitions, { ...base.transitions[0]!, id: "blocked-route", fromStateId: "idle", toStateId: "releasing" }] };
    const transition = machine.transitions.find((item) => item.id === "blocked-route")!;
    const positions = {
      idle: { x: 0, y: 0 },
      starting: { x: 250, y: 0 },
      active: { x: 900, y: 300 },
      releasing: { x: 600, y: 0 },
    };
    const route = routeBehaviorTransitions(machine, positions).find((item) => item.transitionId === transition.id)!;
    expect(curveCrossesBox(route.path, positions.starting!)).toBe(false);
    expect(Number.isFinite(route.labelX) && Number.isFinite(route.labelY)).toBe(true);
  });

  test("cursor-centered zoom keeps the world point fixed and fit encloses node bounds", () => {
    const view = { x: 20, y: 40, zoom: 1 };
    const cursor = { x: 250, y: 120 };
    const worldBefore = { x: view.x + cursor.x / view.zoom, y: view.y + cursor.y / view.zoom };
    const zoomed = zoomBehaviorGraphView(view, cursor, 1.5);
    expect(zoomed.x + cursor.x / zoomed.zoom).toBeCloseTo(worldBefore.x);
    expect(zoomed.y + cursor.y / zoomed.zoom).toBeCloseTo(worldBefore.y);

    const positions = autoArrangeBehaviorMachine(createSpineBehaviorPreset("head-interaction"), 4);
    const routes = routeBehaviorTransitions(createSpineBehaviorPreset("head-interaction"), positions);
    const fit = fitBehaviorGraphView(positions, 1100, 680, routes);
    const visible = { x: fit.x, y: fit.y, width: 1100 / fit.zoom, height: 680 / fit.zoom };
    for (const point of Object.values(positions)) {
      expect(point.x).toBeGreaterThanOrEqual(visible.x);
      expect(point.y).toBeGreaterThanOrEqual(visible.y);
      expect(point.x + 190).toBeLessThanOrEqual(visible.x + visible.width);
      expect(point.y + 108).toBeLessThanOrEqual(visible.y + visible.height);
    }
    for (const route of routes) {
      expect(route.labelX).toBeGreaterThanOrEqual(visible.x);
      expect(route.labelY).toBeGreaterThanOrEqual(visible.y);
      expect(route.labelX).toBeLessThanOrEqual(visible.x + visible.width);
      expect(route.labelY).toBeLessThanOrEqual(visible.y + visible.height);
    }

    const compact = fitBehaviorGraphView(positions, 708, 300, routes);
    expect((positions.idle!.y - compact.y) * compact.zoom).toBeGreaterThanOrEqual(48);
  });

  test("multiple pointer moves commit one manual layout at drag completion", () => {
    const machine = createSpineBehaviorPreset("head-interaction");
    const startLayout = manualBehaviorGraphLayout(autoArrangeBehaviorMachine(machine, 4));
    const session = createBehaviorNodeDragSession(startLayout, "starting", { x: 100, y: 100 }, 2);
    expect(session.move({ x: 101, y: 100 })).toBeNull();
    session.move({ x: 120, y: 110 });
    session.move({ x: 140, y: 130 });

    const commits: unknown[] = [];
    expect(commitBehaviorNodeDrag(session, (layout) => commits.push(layout))).toBe(true);
    expect(commitBehaviorNodeDrag(session, (layout) => commits.push(layout))).toBe(false);
    expect(commits).toHaveLength(1);
    expect((commits[0] as ReturnType<typeof manualBehaviorGraphLayout>).mode).toBe("manual");
    expect((commits[0] as ReturnType<typeof manualBehaviorGraphLayout>).statePositions.starting).toEqual({ x: 334, y: 69 });
  });

  test("canceling an in-progress node drag does not commit a layout", () => {
    const machine = createSpineBehaviorPreset("head-interaction");
    const layout = manualBehaviorGraphLayout(autoArrangeBehaviorMachine(machine, 4));
    const session = createBehaviorNodeDragSession(layout, "starting", { x: 100, y: 100 }, 1);
    session.move({ x: 150, y: 130 });
    session.cancel();

    const commits: unknown[] = [];
    expect(commitBehaviorNodeDrag(session, (next) => commits.push(next))).toBe(false);
    expect(commits).toHaveLength(0);
  });
});
