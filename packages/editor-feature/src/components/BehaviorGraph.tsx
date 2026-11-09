import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { SpineBehaviorMachine } from "@ba-spine/spine-runtime/spine/spineBehavior";
import {
  BEHAVIOR_NODE_HEIGHT,
  BEHAVIOR_NODE_WIDTH,
  autoBehaviorGraphLayout,
  behaviorGraphWheelZoomFactor,
  behaviorGraphPositionsForViewport,
  commitBehaviorNodeDrag,
  createBehaviorNodeDragSession,
  fitBehaviorGraphView,
  getBehaviorGraphPointerIntent,
  routeBehaviorTransitions,
  shouldDeselectBehaviorGraphBackgroundClick,
  zoomBehaviorGraphView,
  type BehaviorGraphPoint,
  type BehaviorGraphHitTarget,
  type BehaviorGraphTool,
  type BehaviorGraphView,
  type BehaviorMachineGraphLayout,
} from "../behaviorGraph";
import { isTextEditingTarget } from "../editorKeyboard";

interface BehaviorGraphProps {
  machine: SpineBehaviorMachine;
  layout: BehaviorMachineGraphLayout;
  selected: { kind: "state" | "transition"; id: string } | null;
  runningStateId?: string;
  onLayoutChange: (layout: BehaviorMachineGraphLayout) => void;
  onSelect: (selection: { kind: "state" | "transition"; id: string } | null) => void;
}

interface NodeDrag {
  kind: "node";
  stateId: string;
  pointerId: number;
  session: ReturnType<typeof createBehaviorNodeDragSession>;
}

interface ViewDrag {
  kind: "view";
  pointerId: number;
  origin: BehaviorGraphPoint;
  view: BehaviorGraphView;
  moved: boolean;
  button: number;
  hitTarget: BehaviorGraphHitTarget;
  spaceHeld: boolean;
  suppressClick: boolean;
}

const DEFAULT_SIZE = { width: 960, height: 540 };

function safeMarkerId(machineId: string): string {
  return `behavior-arrow-${machineId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function behaviorGraphHitTarget(target: EventTarget | null): BehaviorGraphHitTarget {
  const element = target && typeof (target as Element).closest === "function" ? target as Element : null;
  if (element?.closest(".behavior-node")) return "node";
  if (element?.closest(".behavior-edge")) return "edge";
  return "background";
}

export function BehaviorGraph({ machine, layout, selected, runningStateId, onLayoutChange, onSelect }: BehaviorGraphProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<NodeDrag | ViewDrag | null>(null);
  const spaceDownRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [view, setView] = useState<BehaviorGraphView>({ x: 0, y: 0, zoom: 1 });
  const [previewPositions, setPreviewPositions] = useState<Record<string, BehaviorGraphPoint> | null>(null);
  const [tool, setTool] = useState<BehaviorGraphTool>("select");
  const [isPanning, setIsPanning] = useState(false);
  const [isNodeDragging, setIsNodeDragging] = useState(false);

  const basePositions = useMemo(
    () => behaviorGraphPositionsForViewport(machine, layout, size.width),
    [machine, layout, size.width],
  );
  const positions = previewPositions ?? basePositions;
  const routes = useMemo(() => routeBehaviorTransitions(machine, positions), [machine, positions]);
  const markerId = safeMarkerId(machine.id);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setSize({ width: Math.max(1, surface.clientWidth), height: Math.max(1, surface.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPreviewPositions(null);
    setView(fitBehaviorGraphView(basePositions, size.width, size.height, routeBehaviorTransitions(machine, basePositions)));
  }, [machine.id, machine.states.length, size.width, size.height]); // Fit on machine/viewport changes, not during authored edits.

  useEffect(() => {
    const releaseSpacePan = (event: KeyboardEvent) => {
      if (event.code === "Space" || event.key === " ") spaceDownRef.current = false;
    };
    const clearSpacePan = () => { spaceDownRef.current = false; };
    window.addEventListener("keyup", releaseSpacePan);
    window.addEventListener("blur", clearSpacePan);
    return () => {
      window.removeEventListener("keyup", releaseSpacePan);
      window.removeEventListener("blur", clearSpacePan);
      clearSpacePan();
    };
  }, []);

  function focusCanvas() {
    svgRef.current?.focus({ preventScroll: true });
  }

  function startViewDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    button: number,
    hitTarget: BehaviorGraphHitTarget,
    spaceHeld: boolean,
    suppressClick: boolean,
  ) {
    dragRef.current = {
      kind: "view",
      pointerId,
      origin: { x: clientX, y: clientY },
      view,
      moved: false,
      button,
      hitTarget,
      spaceHeld,
      suppressClick,
    };
    if (suppressClick) suppressClickRef.current = true;
    setIsPanning(true);
    svgRef.current?.setPointerCapture(pointerId);
  }

  function beginNodeDrag(event: ReactPointerEvent<SVGGElement>, stateId: string) {
    const spaceHeld = spaceDownRef.current;
    const intent = getBehaviorGraphPointerIntent(event.button, "node", tool, spaceHeld);
    if (intent === "ignore") return;
    event.preventDefault();
    event.stopPropagation();
    focusCanvas();
    if (intent === "pan") {
      startViewDrag(event.pointerId, event.clientX, event.clientY, event.button, "node", spaceHeld, true);
      return;
    }
    if (intent !== "move-node") return;
    onSelect({ kind: "state", id: stateId });
    const dragLayout = layout.mode === "auto" ? { ...layout, statePositions: basePositions } : layout;
    const session = createBehaviorNodeDragSession(dragLayout, stateId, { x: event.clientX, y: event.clientY }, view.zoom);
    dragRef.current = { kind: "node", stateId, pointerId: event.pointerId, session };
    setIsNodeDragging(true);
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const hitTarget = behaviorGraphHitTarget(event.target);
    const spaceHeld = spaceDownRef.current;
    const intent = getBehaviorGraphPointerIntent(event.button, hitTarget, tool, spaceHeld);
    if (event.button === 0 || event.button === 1) focusCanvas();
    if (intent !== "pan") return;
    event.preventDefault();
    startViewDrag(event.pointerId, event.clientX, event.clientY, event.button, hitTarget, spaceHeld, hitTarget !== "background");
  }

  function movePointer(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "node") {
      const next = drag.session.move({ x: event.clientX, y: event.clientY });
      if (next) setPreviewPositions(next);
      return;
    }
    const deltaX = event.clientX - drag.origin.x;
    const deltaY = event.clientY - drag.origin.y;
    if (Math.hypot(deltaX, deltaY) >= 3) drag.moved = true;
    setView({
      ...drag.view,
      x: drag.view.x - deltaX / drag.view.zoom,
      y: drag.view.y - deltaY / drag.view.zoom,
    });
  }

  function endPointer(event: ReactPointerEvent<SVGSVGElement>, cancel = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.kind === "node") {
      if (cancel) drag.session.cancel();
      else commitBehaviorNodeDrag(drag.session, onLayoutChange);
      setPreviewPositions(null);
      setIsNodeDragging(false);
    } else {
      setIsPanning(false);
      if (cancel) setView(drag.view);
      else if (shouldDeselectBehaviorGraphBackgroundClick(drag.button, drag.hitTarget, drag.moved, drag.spaceHeld)) onSelect(null);
      if (drag.suppressClick) requestAnimationFrame(() => { suppressClickRef.current = false; });
    }
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
  }

  function cancelOperationOrSelection() {
    const drag = dragRef.current;
    if (!drag) {
      onSelect(null);
      return;
    }
    dragRef.current = null;
    if (drag.kind === "node") {
      drag.session.cancel();
      setPreviewPositions(null);
      setIsNodeDragging(false);
    } else {
      setView(drag.view);
      setIsPanning(false);
      if (drag.suppressClick) requestAnimationFrame(() => { suppressClickRef.current = false; });
    }
    if (svgRef.current?.hasPointerCapture(drag.pointerId)) svgRef.current.releasePointerCapture(drag.pointerId);
    onSelect(null);
  }

  function zoomAt(factor: number, cursor = { x: size.width / 2, y: size.height / 2 }) {
    setView((current) => zoomBehaviorGraphView(current, cursor, factor));
  }

  function fitGraph() {
    setView(fitBehaviorGraphView(positions, size.width, size.height, routes));
    focusCanvas();
  }

  function autoArrange() {
    const next = autoBehaviorGraphLayout(machine, size.width);
    onLayoutChange(next);
    setPreviewPositions(null);
    setView(fitBehaviorGraphView(next.statePositions, size.width, size.height, routeBehaviorTransitions(machine, next.statePositions)));
    focusCanvas();
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const bounds = svgRef.current?.getBoundingClientRect();
    const cursor = bounds ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top } : { x: size.width / 2, y: size.height / 2 };
    zoomAt(behaviorGraphWheelZoomFactor(event.deltaY, event.deltaMode, size.height), cursor);
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (isTextEditingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === "Space" || event.key === " ") {
      event.preventDefault();
      spaceDownRef.current = true;
      return;
    }
    if (event.repeat) return;
    switch (event.key.toLocaleLowerCase()) {
      case "v":
        event.preventDefault();
        event.stopPropagation();
        setTool("select");
        break;
      case "h":
        event.preventDefault();
        event.stopPropagation();
        setTool("pan");
        break;
      case "f":
        event.preventDefault();
        event.stopPropagation();
        fitGraph();
        break;
      case "escape":
        event.preventDefault();
        event.stopPropagation();
        cancelOperationOrSelection();
        break;
    }
  }

  const viewBox = `${view.x} ${view.y} ${size.width / view.zoom} ${size.height / view.zoom}`;
  return <div className={`behavior-graph-stage${isPanning ? " is-panning" : ""}${isNodeDragging ? " is-node-dragging" : ""}`} ref={surfaceRef}>
    <div className="behavior-canvas-controls" role="toolbar" aria-label="Graph controls">
      <button type="button" className={tool === "select" ? "is-active" : ""} aria-pressed={tool === "select"} onClick={() => { setTool("select"); focusCanvas(); }} title="Select states (V)">Select</button>
      <button type="button" className={tool === "pan" ? "is-active" : ""} aria-pressed={tool === "pan"} onClick={() => { setTool("pan"); focusCanvas(); }} title="Pan the graph (H)">Pan</button>
      <button type="button" onClick={fitGraph} title="Fit graph (F)">Fit</button>
      <button type="button" onClick={autoArrange} title="Arrange states automatically">Auto-arrange</button>
      <span aria-hidden="true" />
      <button type="button" onClick={() => { zoomAt(1.2); focusCanvas(); }} aria-label="Zoom in">+</button>
      <button type="button" onClick={() => { zoomAt(1 / 1.2); focusCanvas(); }} aria-label="Zoom out">−</button>
      <output aria-label="Graph zoom">{Math.round(view.zoom * 100)}%</output>
    </div>
    <div className="behavior-graph-gesture-hint" aria-hidden="true">Drag states · background drag pans · middle/Space-drag pans · V select · H pan · F fit · Esc cancel</div>
    <svg
      ref={svgRef}
      className={`behavior-graph tool-${tool}`}
      viewBox={viewBox}
      preserveAspectRatio="none"
      role="group"
      aria-label={`${machine.name} state graph. Drag states to move, drag the background to pan, or use middle/Space-drag. V selects, H pans, F fits, Escape cancels or deselects.`}
      aria-keyshortcuts="V H F Escape Space"
      tabIndex={0}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={movePointer}
      onPointerUp={(event) => endPointer(event)}
      onPointerCancel={(event) => endPointer(event, true)}
      onLostPointerCapture={(event) => endPointer(event, true)}
      onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
      onWheel={handleWheel}
      onKeyDownCapture={handleCanvasKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) spaceDownRef.current = false;
      }}
    >
      <defs>
        <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L9,4 z" /></marker>
        <pattern id={`${markerId}-grid`} width="18" height="18" patternUnits="userSpaceOnUse"><circle className="behavior-graph-grid-dot" cx="1" cy="1" r="1" /></pattern>
      </defs>
      <rect className="behavior-graph-background" x={view.x} y={view.y} width={size.width / view.zoom} height={size.height / view.zoom} fill={`url(#${markerId}-grid)`} />
      {routes.map((route) => {
        const transition = machine.transitions.find((item) => item.id === route.transitionId)!;
        const selectedEdge = selected?.kind === "transition" && selected.id === transition.id;
        const label = transition.event.replaceAll("-", " ");
        const labelWidth = Math.max(56, label.length * 6.2 + 14);
        return <g
          key={transition.id}
          className={`behavior-edge${selectedEdge ? " is-selected" : ""}`}
          onClick={() => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            onSelect({ kind: "transition", id: transition.id });
          }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ kind: "transition", id: transition.id }); } }}
          role="button"
          tabIndex={0}
          aria-label={`${machine.states.find((state) => state.id === transition.fromStateId)?.name} to ${machine.states.find((state) => state.id === transition.toStateId)?.name} on ${label}`}
        >
          <path d={route.path} markerEnd={`url(#${markerId})`} />
          <rect className="behavior-edge-label-bg" x={route.labelX - labelWidth / 2} y={route.labelY - 10} width={labelWidth} height={18} rx={4} />
          <text x={route.labelX} y={route.labelY + 3}>{label}</text>
        </g>;
      })}
      {machine.states.map((state) => {
        const position = positions[state.id] ?? { x: 54, y: 54 };
        const selectedState = selected?.kind === "state" && selected.id === state.id;
        const nameTextLength = state.name.length > 22 ? 162 : undefined;
        return <g
          key={state.id}
          className={`behavior-node${selectedState ? " is-selected" : ""}${runningStateId === state.id ? " is-running" : ""}`}
          transform={`translate(${position.x} ${position.y})`}
          onPointerDown={(event) => beginNodeDrag(event, state.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ kind: "state", id: state.id }); } }}
          role="button"
          tabIndex={0}
          aria-label={`Select ${state.name} state; drag to move`}
        >
          <rect className="behavior-node-body" width={BEHAVIOR_NODE_WIDTH} height={BEHAVIOR_NODE_HEIGHT} rx="10" />
          <rect className="behavior-node-header" width={BEHAVIOR_NODE_WIDTH} height="34" rx="10" />
          <path className="behavior-node-header-bottom" d={`M 0 34 H ${BEHAVIOR_NODE_WIDTH}`} />
          <text className="behavior-node-kind" x="14" y="21">{state.id === machine.initialStateId ? "INITIAL STATE" : "STATE"}</text>
          <text className="behavior-node-name" x="14" y="63" textLength={nameTextLength} lengthAdjust="spacingAndGlyphs"><title>{state.name}</title>{state.name}</text>
          <text className="behavior-node-actions" x="14" y="87">{state.actions.length} action{state.actions.length === 1 ? "" : "s"}</text>
        </g>;
      })}
    </svg>
  </div>;
}
