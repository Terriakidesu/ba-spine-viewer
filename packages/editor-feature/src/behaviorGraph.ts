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

function pointForState(positions: Record<string, BehaviorGraphPoint>, stateId: string): BehaviorGraphPoint | null {
  return positions[stateId] ?? null;
}

export function routeBehaviorTransitions(
  machine: SpineBehaviorMachine,
  positions: Record<string, BehaviorGraphPoint>,
): BehaviorTransitionRoute[] {
  const allPositions = Object.values(positions);
  const maxBottom = Math.max(0, ...allPositions.map((point) => point.y + BEHAVIOR_NODE_HEIGHT));
  const ordered = machine.transitions.map((transition, index) => ({ transition, index }))
    .filter(({ transition }) => pointForState(positions, transition.fromStateId) && pointForState(positions, transition.toStateId));
  const parallelGroups = new Map<string, number[]>();
  for (const { transition, index } of ordered) {
    const key = `${transition.fromStateId}\u0000${transition.toStateId}`;
    parallelGroups.set(key, [...(parallelGroups.get(key) ?? []), index]);
  }
  let backEdgeLane = 0;
  return ordered.map(({ transition, index }) => {
    const from = pointForState(positions, transition.fromStateId)!;
    const to = pointForState(positions, transition.toStateId)!;
    const group = parallelGroups.get(`${transition.fromStateId}\u0000${transition.toStateId}`)!;
    const lane = group.indexOf(index) - (group.length - 1) / 2;
    if (transition.fromStateId === transition.toStateId) {
      const x = from.x, y = from.y;
      const offset = lane * 24;
      const path = `M ${x + BEHAVIOR_NODE_WIDTH * 0.68} ${y} C ${x + BEHAVIOR_NODE_WIDTH * 0.72} ${y - 58 + offset}, ${x + BEHAVIOR_NODE_WIDTH * 0.28} ${y - 58 + offset}, ${x + BEHAVIOR_NODE_WIDTH * 0.32} ${y}`;
      return { transitionId: transition.id, path, labelX: x + BEHAVIOR_NODE_WIDTH / 2, labelY: y - 48 + lane * 30 };
    }

    const fromCenterY = from.y + BEHAVIOR_NODE_HEIGHT / 2;
    const toCenterY = to.y + BEHAVIOR_NODE_HEIGHT / 2;
    const isForward = to.x > from.x;
    const laneOffset = lane * 34;
    if (Math.abs(to.x - from.x) < 1 && to.y > from.y) {
      const blockedByNode = allPositions.some((point) => point !== from && point !== to
        && point.x < from.x + BEHAVIOR_NODE_WIDTH && point.x + BEHAVIOR_NODE_WIDTH > from.x
        && point.y < to.y && point.y + BEHAVIOR_NODE_HEIGHT > from.y + BEHAVIOR_NODE_HEIGHT);
      if (!blockedByNode) {
        const x = from.x + BEHAVIOR_NODE_WIDTH / 2 + lane * 24;
        const startY = from.y + BEHAVIOR_NODE_HEIGHT;
        const endY = to.y;
        const control = Math.max(18, (endY - startY) / 3);
        return {
          transitionId: transition.id,
          path: `M ${x} ${startY} C ${x} ${startY + control}, ${x} ${endY - control}, ${x} ${endY}`,
          labelX: x,
          labelY: (startY + endY) / 2 + lane * 30,
        };
      }
    }
    if (isForward && Math.abs(toCenterY - fromCenterY) < 1 && Math.abs(laneOffset) < BEHAVIOR_NODE_HEIGHT / 2 + BEHAVIOR_GRAPH_GAP_Y / 2 - 20) {
      const crossesNode = allPositions.some((point) => point !== from && point !== to
        && point.x > from.x + BEHAVIOR_NODE_WIDTH - 1 && point.x < to.x + 1
        && Math.abs((point.y + BEHAVIOR_NODE_HEIGHT / 2) - fromCenterY) < BEHAVIOR_NODE_HEIGHT / 2 + 16);
      if (!crossesNode) {
        const startX = from.x + BEHAVIOR_NODE_WIDTH;
        const endX = to.x;
        const control = Math.max(38, (endX - startX) / 2);
        return {
          transitionId: transition.id,
          path: `M ${startX} ${fromCenterY} C ${startX + control} ${fromCenterY + laneOffset}, ${endX - control} ${toCenterY + laneOffset}, ${endX} ${toCenterY}`,
          labelX: (startX + endX) / 2,
          labelY: (fromCenterY + toCenterY) / 2 + laneOffset - 12,
        };
      }
    }

    const routeY = maxBottom + 52 + backEdgeLane * 34 + Math.abs(lane) * 14;
    backEdgeLane += 1;
    const startX = from.x + BEHAVIOR_NODE_WIDTH * 0.74;
    const endX = to.x + BEHAVIOR_NODE_WIDTH * 0.26;
    return {
      transitionId: transition.id,
      path: `M ${startX} ${from.y + BEHAVIOR_NODE_HEIGHT} C ${startX} ${routeY}, ${endX} ${routeY}, ${endX} ${to.y + BEHAVIOR_NODE_HEIGHT}`,
      labelX: (startX + endX) / 2,
      labelY: routeY - 11,
    };
  });
}
