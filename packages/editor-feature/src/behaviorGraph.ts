import type { SpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";

export const BEHAVIOR_NODE_WIDTH = 190;
export const BEHAVIOR_NODE_HEIGHT = 108;
export const BEHAVIOR_GRAPH_GAP_X = 70;
export const BEHAVIOR_GRAPH_GAP_Y = 64;

export interface BehaviorGraphPoint {
  x: number;
  y: number;
}

export interface BehaviorMachineGraphLayout {
  mode: "auto" | "manual";
  statePositions: Record<string, BehaviorGraphPoint>;
}

export type BehaviorGraphLayouts = Record<string, BehaviorMachineGraphLayout>;

export type BehaviorGraphTool = "select" | "pan";
export type BehaviorGraphHitTarget = "background" | "node" | "edge";
export type BehaviorGraphPointerIntent = "pan" | "move-node" | "select-edge" | "ignore";

export interface BehaviorGraphView {
  x: number;
  y: number;
  zoom: number;
}

export interface BehaviorTransitionRoute {
  transitionId: string;
  path: string;
  labelX: number;
  labelY: number;
}

/** Resolve canvas gestures consistently: pan modifiers/tools take priority over selection or node movement. */
export function getBehaviorGraphPointerIntent(
  button: number,
  hitTarget: BehaviorGraphHitTarget,
  tool: BehaviorGraphTool,
  spaceHeld: boolean,
): BehaviorGraphPointerIntent {
  if (button === 1 || (button === 0 && (spaceHeld || tool === "pan"))) return "pan";
  if (button !== 0) return "ignore";
  if (hitTarget === "node") return "move-node";
  if (hitTarget === "edge") return "select-edge";
  // Left-drag starts a background pan; a click with no movement deselects on pointer-up.
  return "pan";
}

export function shouldDeselectBehaviorGraphBackgroundClick(
  button: number,
  hitTarget: BehaviorGraphHitTarget,
  moved: boolean,
  spaceHeld: boolean,
): boolean {
  return button === 0 && hitTarget === "background" && !moved && !spaceHeld;
}

/** Match the cursor-anchored wheel response used by the Camera canvas. */
export function behaviorGraphWheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const safeDelta = Number.isFinite(deltaY) ? deltaY : 0;
  const pixels = deltaMode === 1 ? safeDelta * 16 : deltaMode === 2 ? safeDelta * Math.max(1, viewportHeight) : safeDelta;
  return Math.exp(-pixels * 0.0015);
}

function finitePoint(value: unknown): BehaviorGraphPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  if (typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y)) return null;
  return { x: Math.max(-100_000, Math.min(100_000, point.x)), y: Math.max(-100_000, Math.min(100_000, point.y)) };
}

function primaryStateOrder(machine: SpineBehaviorMachine): string[] {
  const ordered = [machine.initialStateId];
  const visited = new Set(ordered);
  let current = machine.initialStateId;
  while (ordered.length < machine.states.length) {
    const next = machine.transitions
      .filter((transition) => transition.fromStateId === current && !visited.has(transition.toStateId))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
    if (!next) break;
    ordered.push(next.toStateId);
    visited.add(next.toStateId);
    current = next.toStateId;
  }
  for (const state of machine.states) if (!visited.has(state.id)) ordered.push(state.id);
  return ordered;
}

/** Compute a predictable snake-flow arrangement without changing machine semantics. */
export function autoArrangeBehaviorMachine(machine: SpineBehaviorMachine, maxColumns = 4): Record<string, BehaviorGraphPoint> {
  const columns = Math.max(1, Math.min(8, Math.floor(maxColumns) || 1));
  const order = primaryStateOrder(machine);
  const positions: Record<string, BehaviorGraphPoint> = {};
  const bandOffsets = new Map<number, number>();
  let yOffset = 0;
  const bandCount = Math.ceil(order.length / columns);
  for (let band = 0; band < bandCount; band += 1) {
    bandOffsets.set(band, yOffset);
    yOffset += BEHAVIOR_NODE_HEIGHT + BEHAVIOR_GRAPH_GAP_Y;
  }
  order.forEach((stateId, index) => {
    const band = Math.floor(index / columns);
    const offset = index % columns;
    const column = band % 2 === 0 ? offset : columns - 1 - offset;
    positions[stateId] = {
      x: 54 + column * (BEHAVIOR_NODE_WIDTH + BEHAVIOR_GRAPH_GAP_X),
      y: 54 + (bandOffsets.get(band) ?? 0),
    };
  });
  return positions;
}

function overlaps(point: BehaviorGraphPoint, other: BehaviorGraphPoint): boolean {
  return point.x < other.x + BEHAVIOR_NODE_WIDTH + 24
    && point.x + BEHAVIOR_NODE_WIDTH + 24 > other.x
    && point.y < other.y + BEHAVIOR_NODE_HEIGHT + 24
    && point.y + BEHAVIOR_NODE_HEIGHT + 24 > other.y;
}

/** Migrate missing graph metadata once, preserve manual coordinates, and discard removed states. */
export function normalizeBehaviorGraphLayouts(value: unknown, machines: readonly SpineBehaviorMachine[]): BehaviorGraphLayouts {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const layouts: BehaviorGraphLayouts = {};
  for (const machine of machines) {
    const raw = source[machine.id] && typeof source[machine.id] === "object" && !Array.isArray(source[machine.id])
      ? source[machine.id] as Record<string, unknown>
      : {};
    const rawPositions = raw.statePositions && typeof raw.statePositions === "object" && !Array.isArray(raw.statePositions)
      ? raw.statePositions as Record<string, unknown>
      : {};
    const mode = raw.mode === "manual" ? "manual" : "auto";
    const defaults = autoArrangeBehaviorMachine(machine);
    const statePositions: Record<string, BehaviorGraphPoint> = {};
    for (const state of machine.states) {
      const saved = finitePoint(rawPositions[state.id]);
      if (saved) statePositions[state.id] = saved;
    }
    for (const state of machine.states) {
      if (statePositions[state.id]) continue;
      let point = defaults[state.id] ?? { x: 54, y: 54 };
      let attempts = 0;
      while (Object.values(statePositions).some((other) => overlaps(point, other)) && attempts < 100) {
        point = { ...point, y: point.y + BEHAVIOR_NODE_HEIGHT + BEHAVIOR_GRAPH_GAP_Y };
        attempts += 1;
      }
      statePositions[state.id] = point;
    }
    layouts[machine.id] = { mode, statePositions };
  }
  return layouts;
}

export function manualBehaviorGraphLayout(statePositions: Record<string, BehaviorGraphPoint>): BehaviorMachineGraphLayout {
  return { mode: "manual", statePositions: Object.fromEntries(Object.entries(statePositions).map(([id, point]) => [id, { ...point }])) };
}

export function autoBehaviorGraphLayout(machine: SpineBehaviorMachine, viewportWidth = 1200): BehaviorMachineGraphLayout {
  return { mode: "auto", statePositions: autoArrangeBehaviorGraph(machine, viewportWidth) };
}

export function autoArrangeBehaviorGraph(machine: SpineBehaviorMachine, viewportWidth: number): Record<string, BehaviorGraphPoint> {
  const responsiveColumns = Math.max(1, Math.min(4, Math.floor((Math.max(1, viewportWidth) - 76 + BEHAVIOR_GRAPH_GAP_X)
    / (BEHAVIOR_NODE_WIDTH + BEHAVIOR_GRAPH_GAP_X))));
  // Keep a four-state flow mostly horizontal on common desktop widths, then turn down at its end.
  const columns = machine.states.length <= 4 && viewportWidth >= 650
    ? Math.min(machine.states.length, Math.max(3, responsiveColumns))
    : responsiveColumns;
  return autoArrangeBehaviorMachine(machine, columns);
}

export function behaviorGraphPositionsForViewport(
  machine: SpineBehaviorMachine,
  layout: BehaviorMachineGraphLayout,
  viewportWidth: number,
): Record<string, BehaviorGraphPoint> {
  return layout.mode === "auto" ? autoArrangeBehaviorGraph(machine, viewportWidth) : layout.statePositions;
}

export function fitBehaviorGraphView(
  positions: Record<string, BehaviorGraphPoint>,
  viewportWidth: number,
  viewportHeight: number,
  routes: readonly BehaviorTransitionRoute[] = [],
): BehaviorGraphView {
  const points = Object.values(positions);
  if (points.length === 0) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...points.map((point) => point.x), ...routes.map((route) => route.labelX - 64));
  const minY = Math.min(...points.map((point) => point.y), ...routes.map((route) => route.labelY - 12));
  const maxX = Math.max(...points.map((point) => point.x + BEHAVIOR_NODE_WIDTH), ...routes.map((route) => route.labelX + 64));
  const maxY = Math.max(...points.map((point) => point.y + BEHAVIOR_NODE_HEIGHT), ...routes.map((route) => route.labelY + 12));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const zoom = Math.max(0.2, Math.min(1, Math.min((viewportWidth - 72) / contentWidth, (viewportHeight - 72) / contentHeight)));
  const visibleWidth = viewportWidth / zoom;
  const visibleHeight = viewportHeight / zoom;
  const verticalMargin = Math.max(0, (viewportHeight - contentHeight * zoom) / 2);
  const topControlOffset = Math.min(18, Math.max(0, verticalMargin - 4));
  return {
    x: (minX + maxX - visibleWidth) / 2,
    y: (minY + maxY - visibleHeight) / 2 - topControlOffset / zoom,
    zoom,
  };
}

export function zoomBehaviorGraphView(view: BehaviorGraphView, cursor: BehaviorGraphPoint, factor: number): BehaviorGraphView {
  const zoom = Math.max(0.2, Math.min(2.5, view.zoom * Math.max(0.01, Math.min(100, factor))));
  const worldX = view.x + cursor.x / view.zoom;
  const worldY = view.y + cursor.y / view.zoom;
  return { x: worldX - cursor.x / zoom, y: worldY - cursor.y / zoom, zoom };
}

export interface BehaviorNodeDragSession {
  move: (client: BehaviorGraphPoint) => Record<string, BehaviorGraphPoint> | null;
  finish: () => BehaviorMachineGraphLayout | null;
  cancel: () => void;
}

export function createBehaviorNodeDragSession(
  layout: BehaviorMachineGraphLayout,
  stateId: string,
  origin: BehaviorGraphPoint,
  zoom: number,
  threshold = 4,
): BehaviorNodeDragSession {
  const start = Object.fromEntries(Object.entries(layout.statePositions).map(([id, point]) => [id, { ...point }]));
  const startPoint = start[stateId];
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  let current = start;
  let dragging = false;
  let closed = false;
  return {
    move(client) {
      if (closed || !startPoint) return null;
      if (!dragging && Math.hypot(client.x - origin.x, client.y - origin.y) < threshold) return null;
      dragging = true;
      current = {
        ...start,
        [stateId]: {
          x: startPoint.x + (client.x - origin.x) / safeZoom,
          y: startPoint.y + (client.y - origin.y) / safeZoom,
        },
      };
      return current;
    },
    finish() {
      if (closed) return null;
      closed = true;
      if (!dragging || !startPoint || current[stateId]!.x === startPoint.x && current[stateId]!.y === startPoint.y) return null;
      return manualBehaviorGraphLayout(current);
    },
    cancel() { closed = true; },
  };
}

/** A drag session commits once at pointer-up, regardless of the number of preview moves. */
export function commitBehaviorNodeDrag(session: BehaviorNodeDragSession, commit: (layout: BehaviorMachineGraphLayout) => void): boolean {
  const layout = session.finish();
  if (!layout) return false;
  commit(layout);
  return true;
}

type BehaviorNodeSide = "left" | "right" | "top" | "bottom";

interface BehaviorRouteCandidate {
  path: string;
  labelX: number;
  labelY: number;
  blocked: boolean;
  score: number;
}

function nodeCenter(point: BehaviorGraphPoint): BehaviorGraphPoint {
  return { x: point.x + BEHAVIOR_NODE_WIDTH / 2, y: point.y + BEHAVIOR_NODE_HEIGHT / 2 };
}

function sidePoint(point: BehaviorGraphPoint, side: BehaviorNodeSide, lane: number): BehaviorGraphPoint {
  switch (side) {
    case "left": return { x: point.x, y: point.y + BEHAVIOR_NODE_HEIGHT / 2 + lane };
    case "right": return { x: point.x + BEHAVIOR_NODE_WIDTH, y: point.y + BEHAVIOR_NODE_HEIGHT / 2 + lane };
    case "top": return { x: point.x + BEHAVIOR_NODE_WIDTH / 2 + lane, y: point.y };
    case "bottom": return { x: point.x + BEHAVIOR_NODE_WIDTH / 2 + lane, y: point.y + BEHAVIOR_NODE_HEIGHT };
  }
}

function outward(side: BehaviorNodeSide): BehaviorGraphPoint {
  switch (side) {
    case "left": return { x: -1, y: 0 };
    case "right": return { x: 1, y: 0 };
    case "top": return { x: 0, y: -1 };
    case "bottom": return { x: 0, y: 1 };
  }
}

function bezierPoint(start: BehaviorGraphPoint, first: BehaviorGraphPoint, second: BehaviorGraphPoint, end: BehaviorGraphPoint, t: number): BehaviorGraphPoint {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * end.y,
  };
}

function curveCrossesNode(start: BehaviorGraphPoint, first: BehaviorGraphPoint, second: BehaviorGraphPoint, end: BehaviorGraphPoint, positions: Record<string, BehaviorGraphPoint>, sourceId: string, targetId: string): boolean {
  for (let sample = 1; sample < 32; sample += 1) {
    const point = bezierPoint(start, first, second, end, sample / 32);
    for (const [stateId, node] of Object.entries(positions)) {
      if (stateId === sourceId || stateId === targetId) continue;
      if (point.x >= node.x - 8 && point.x <= node.x + BEHAVIOR_NODE_WIDTH + 8
        && point.y >= node.y - 8 && point.y <= node.y + BEHAVIOR_NODE_HEIGHT + 8) return true;
    }
  }
  return false;
}

function routeCandidate(
  from: BehaviorGraphPoint,
  to: BehaviorGraphPoint,
  sourceId: string,
  targetId: string,
  sourceSide: BehaviorNodeSide,
  targetSide: BehaviorNodeSide,
  lane: number,
  positions: Record<string, BehaviorGraphPoint>,
  priority: number,
): BehaviorRouteCandidate {
  const sideLane = Math.max(-34, Math.min(34, lane));
  const start = sidePoint(from, sourceSide, sideLane);
  const end = sidePoint(to, targetSide, sideLane);
  const sourceNormal = outward(sourceSide);
  const targetNormal = outward(targetSide);
  const centerDistance = Math.hypot(nodeCenter(to).x - nodeCenter(from).x, nodeCenter(to).y - nodeCenter(from).y);
  const controlLength = Math.max(34, Math.min(140, centerDistance * 0.36));
  const first = { x: start.x + sourceNormal.x * controlLength, y: start.y + sourceNormal.y * controlLength };
  const second = { x: end.x + targetNormal.x * controlLength, y: end.y + targetNormal.y * controlLength };
  const middle = bezierPoint(start, first, second, end, 0.5);
  return {
    path: `M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`,
    labelX: middle.x,
    labelY: middle.y - 10,
    blocked: curveCrossesNode(start, first, second, end, positions, sourceId, targetId),
    score: priority * 10000 + centerDistance + Math.abs(lane) * 0.25,
  };
}

function facingSidePairs(from: BehaviorGraphPoint, to: BehaviorGraphPoint): Array<[BehaviorNodeSide, BehaviorNodeSide]> {
  const source = nodeCenter(from), target = nodeCenter(to);
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  // Compare the center vector against each box's dimensions, so a diagonal edge
  // chooses the side it approaches most directly instead of defaulting downward.
  if (Math.abs(deltaX) / BEHAVIOR_NODE_WIDTH >= Math.abs(deltaY) / BEHAVIOR_NODE_HEIGHT) {
    const horizontal: [BehaviorNodeSide, BehaviorNodeSide] = deltaX >= 0 ? ["right", "left"] : ["left", "right"];
    const vertical: [BehaviorNodeSide, BehaviorNodeSide] = deltaY >= 0 ? ["bottom", "top"] : ["top", "bottom"];
    return [horizontal, vertical];
  }
  const vertical: [BehaviorNodeSide, BehaviorNodeSide] = deltaY >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  const horizontal: [BehaviorNodeSide, BehaviorNodeSide] = deltaX >= 0 ? ["right", "left"] : ["left", "right"];
  return [vertical, horizontal];
}

function detourCandidate(
  from: BehaviorGraphPoint,
  to: BehaviorGraphPoint,
  sourceId: string,
  targetId: string,
  sourceSide: BehaviorNodeSide,
  targetSide: BehaviorNodeSide,
  lane: number,
  positions: Record<string, BehaviorGraphPoint>,
): BehaviorRouteCandidate {
  const firstTry = routeCandidate(from, to, sourceId, targetId, sourceSide, targetSide, lane, positions, 2);
  if (!firstTry.blocked) return firstTry;
  const start = sidePoint(from, sourceSide, Math.max(-34, Math.min(34, lane)));
  const end = sidePoint(to, targetSide, Math.max(-34, Math.min(34, lane)));
  const sourceNormal = outward(sourceSide), targetNormal = outward(targetSide);
  const all = Object.values(positions);
  const offset = BEHAVIOR_NODE_HEIGHT + BEHAVIOR_GRAPH_GAP_Y;
  const horizontalDetour = sourceSide === "left" || sourceSide === "right";
  const lanes = horizontalDetour
    ? [Math.min(...all.map((point) => point.y)) - offset, Math.max(...all.map((point) => point.y + BEHAVIOR_NODE_HEIGHT)) + offset]
    : [Math.min(...all.map((point) => point.x)) - offset, Math.max(...all.map((point) => point.x + BEHAVIOR_NODE_WIDTH)) + offset];
  return lanes.map((laneValue) => {
    const first = horizontalDetour
      ? { x: start.x + sourceNormal.x * 90, y: laneValue }
      : { x: laneValue, y: start.y + sourceNormal.y * 90 };
    const second = horizontalDetour
      ? { x: end.x + targetNormal.x * 90, y: laneValue }
      : { x: laneValue, y: end.y + targetNormal.y * 90 };
    const middle = bezierPoint(start, first, second, end, 0.5);
    return {
      path: `M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`,
      labelX: middle.x,
      labelY: middle.y - 10,
      blocked: curveCrossesNode(start, first, second, end, positions, sourceId, targetId),
      score: Math.abs(laneValue) + Math.hypot(nodeCenter(to).x - nodeCenter(from).x, nodeCenter(to).y - nodeCenter(from).y),
    };
  }).sort((left, right) => Number(left.blocked) - Number(right.blocked) || left.score - right.score)[0]!;
}

export function routeBehaviorTransitions(
  machine: SpineBehaviorMachine,
  positions: Record<string, BehaviorGraphPoint>,
): BehaviorTransitionRoute[] {
  const ordered = machine.transitions.map((transition, index) => ({ transition, index }))
    .filter(({ transition }) => positions[transition.fromStateId] && positions[transition.toStateId]);
  const parallelGroups = new Map<string, number[]>();
  for (const { transition, index } of ordered) {
    const [first, second] = [transition.fromStateId, transition.toStateId].sort();
    const key = `${first}\u0000${second}`;
    parallelGroups.set(key, [...(parallelGroups.get(key) ?? []), index]);
  }
  return ordered.map(({ transition, index }) => {
    const from = positions[transition.fromStateId]!;
    const to = positions[transition.toStateId]!;
    const [firstId, secondId] = [transition.fromStateId, transition.toStateId].sort();
    const group = parallelGroups.get(`${firstId}\u0000${secondId}`)!;
    const lane = (group.indexOf(index) - (group.length - 1) / 2) * 34;
    if (transition.fromStateId === transition.toStateId) {
      const offset = lane * 0.55;
      const path = `M ${from.x + BEHAVIOR_NODE_WIDTH * 0.68} ${from.y} C ${from.x + BEHAVIOR_NODE_WIDTH * 0.72} ${from.y - 58 + offset}, ${from.x + BEHAVIOR_NODE_WIDTH * 0.28} ${from.y - 58 + offset}, ${from.x + BEHAVIOR_NODE_WIDTH * 0.32} ${from.y}`;
      return { transitionId: transition.id, path, labelX: from.x + BEHAVIOR_NODE_WIDTH / 2, labelY: from.y - 48 + offset };
    }

    const pairs = facingSidePairs(from, to);
    const candidates: BehaviorRouteCandidate[] = [];
    for (let sideIndex = 0; sideIndex < pairs.length; sideIndex += 1) {
      const [sourceSide, targetSide] = pairs[sideIndex]!;
      const sideLane = sourceSide === "left" || sourceSide === "right" ? lane : -lane;
      const offsets = [sideLane, sideLane + 38, sideLane - 38, sideLane + 76, sideLane - 76];
      for (const offset of offsets) {
        candidates.push(routeCandidate(from, to, transition.fromStateId, transition.toStateId, sourceSide, targetSide, offset, positions, sideIndex));
      }
      candidates.push(detourCandidate(from, to, transition.fromStateId, transition.toStateId, sourceSide, targetSide, sideLane, positions));
    }
    const route = candidates.sort((left, right) => Number(left.blocked) - Number(right.blocked) || left.score - right.score)[0]!;
    return { transitionId: transition.id, path: route.path, labelX: route.labelX, labelY: route.labelY };
  });
}
