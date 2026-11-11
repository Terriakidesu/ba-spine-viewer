import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CompositionKeyframe, CompositionPropertyTrack, CompositionTangent } from "@ba-spine/spine-runtime/spine/spineComposition";
import "./compositionCurveEditor.css";

interface CompositionCurveEditorProps {
  track: CompositionPropertyTrack;
  selectedKeyId: string;
  onUpdateKey: (key: CompositionKeyframe) => void;
}

type Handle = "in" | "out";
interface HandleDrag { pointerId: number; handle: Handle; tangent: CompositionTangent }

const WIDTH = 480;
const HEIGHT = 180;
const LEFT = 48;
const RIGHT = 456;
const TOP = 20;
const BOTTOM = 146;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function CompositionCurveEditor({ track, selectedKeyId, onUpdateKey }: CompositionCurveEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<HandleDrag | null>(null);
  const [previewTangent, setPreviewTangent] = useState<{ handle: Handle; tangent: CompositionTangent } | null>(null);
  const keys = [...track.keys].filter((key) => typeof key.value === "number").sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
  const selectedIndex = keys.findIndex((key) => key.id === selectedKeyId);
  if (selectedIndex < 0 || keys.length < 2) return <div className="composition-curve-empty">Select a numeric key with a neighboring key to edit its curve.</div>;
  const selected = keys[selectedIndex]!;
  const leftKey = selectedIndex < keys.length - 1 ? selected : keys[selectedIndex - 1]!;
  const rightKey = selectedIndex < keys.length - 1 ? keys[selectedIndex + 1]! : selected;
  const leftValue = leftKey.value as number;
  const rightValue = rightKey.value as number;
  const segment = rightKey.time - leftKey.time;
  if (segment <= 0) return <div className="composition-curve-empty">Curve editing requires two keys at distinct times.</div>;
  const outTangent = previewTangent?.handle === "out" && leftKey.id === selectedKeyId
    ? previewTangent.tangent
    : leftKey.outTangent ?? { time: 1 / 3, value: 1 / 3 };
  const inTangent = previewTangent?.handle === "in" && rightKey.id === selectedKeyId
    ? previewTangent.tangent
    : rightKey.inTangent ?? { time: 1 / 3, value: 2 / 3 };
  const valueDelta = rightValue - leftValue;
  const outValue = leftValue + valueDelta * outTangent.value;
  const inValue = leftValue + valueDelta * inTangent.value;
  const rawMin = Math.min(leftValue, rightValue, outValue, inValue);
  const rawMax = Math.max(leftValue, rightValue, outValue, inValue);
  const padding = Math.max((rawMax - rawMin) * 0.14, Math.max(Math.abs(rawMin), Math.abs(rawMax)) * 0.035, 0.15);
  const minValue = rawMin - padding;
  const maxValue = rawMax + padding;
  const valueY = (value: number) => BOTTOM - (value - minValue) / (maxValue - minValue) * (BOTTOM - TOP);
  const leftX = LEFT;
  const rightX = RIGHT;
  const outX = leftX + clamp01(outTangent.time) * (rightX - leftX);
  const inX = rightX - clamp01(inTangent.time) * (rightX - leftX);
  const leftY = valueY(leftValue);
  const rightY = valueY(rightValue);
  const outY = valueY(outValue);
  const inY = valueY(inValue);
  const curvePath = leftKey.interpolation === "step"
    ? `M ${leftX} ${leftY} H ${rightX} V ${rightY}`
    : leftKey.interpolation === "bezier"
      ? `M ${leftX} ${leftY} C ${outX} ${outY}, ${inX} ${inY}, ${rightX} ${rightY}`
      : `M ${leftX} ${leftY} L ${rightX} ${rightY}`;

  function tangentAtPointer(handle: Handle, clientX: number, clientY: number): CompositionTangent {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return handle === "out" ? outTangent : inTangent;
    const x = (clientX - bounds.left) / Math.max(1, bounds.width) * WIDTH;
    const y = (clientY - bounds.top) / Math.max(1, bounds.height) * HEIGHT;
    const fraction = handle === "out" ? (x - leftX) / (rightX - leftX) : (rightX - x) / (rightX - leftX);
    const normalizedValue = (maxValue - (BOTTOM - y) / (BOTTOM - TOP) * (maxValue - minValue) - leftValue) / (valueDelta || 1);
    return { time: clamp01(fraction), value: valueDelta === 0 ? (handle === "out" ? outTangent.value : inTangent.value) : normalizedValue };
  }

  function beginHandleDrag(event: ReactPointerEvent<SVGCircleElement>, handle: Handle) {
    event.stopPropagation();
    const tangent = handle === "out" ? outTangent : inTangent;
    dragRef.current = { pointerId: event.pointerId, handle, tangent };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreviewTangent({ handle, tangent });
  }

  function moveHandle(event: ReactPointerEvent<SVGCircleElement>) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.tangent = tangentAtPointer(active.handle, event.clientX, event.clientY);
    setPreviewTangent({ handle: active.handle, tangent: active.tangent });
  }

  function finishHandleDrag(event: ReactPointerEvent<SVGCircleElement>, cancelled = false) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!cancelled) {
      const target = active.handle === "out" ? leftKey : rightKey;
      onUpdateKey({
        ...target,
        [active.handle === "out" ? "outTangent" : "inTangent"]: active.tangent,
      });
    }
    dragRef.current = null;
    setPreviewTangent(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function nudgeHandle(event: ReactKeyboardEvent<SVGCircleElement>, handle: Handle) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const tangent = handle === "out" ? outTangent : inTangent;
    const horizontal = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
    const vertical = event.key === "ArrowUp" ? 0.05 : event.key === "ArrowDown" ? -0.05 : 0;
    const next = {
      time: clamp01(tangent.time + (handle === "in" ? -horizontal : horizontal)),
      value: tangent.value + vertical,
    };
    const target = handle === "out" ? leftKey : rightKey;
    onUpdateKey({ ...target, [handle === "out" ? "outTangent" : "inTangent"]: next });
  }

  const selectedSegmentInterpolation = leftKey.interpolation;
  return <section className="composition-curve-editor" aria-label="Selected key curve editor">
    <div className="composition-curve-heading"><strong>Curve · {selectedSegmentInterpolation}</strong><span>{leftValue.toFixed(3)} → {rightValue.toFixed(3)} · {segment.toFixed(3)}s</span></div>
    <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label={`Curve from ${leftValue.toFixed(3)} to ${rightValue.toFixed(3)}, ${selectedSegmentInterpolation}`}>
      <path className="composition-curve-grid" d={`M ${LEFT} ${TOP} H ${RIGHT} M ${LEFT} ${(TOP + BOTTOM) / 2} H ${RIGHT} M ${LEFT} ${BOTTOM} H ${RIGHT}`} />
      <path className="composition-curve-axis" d={`M ${LEFT} ${TOP} V ${BOTTOM} H ${RIGHT}`} />
      <path className="composition-curve-path" d={curvePath} />
      {leftKey.interpolation === "bezier" && <>
        <path className="composition-curve-handle-line" d={`M ${leftX} ${leftY} L ${outX} ${outY} M ${rightX} ${rightY} L ${inX} ${inY}`} />
        <circle className="composition-curve-handle" cx={outX} cy={outY} r="5" tabIndex={0} role="slider" aria-label="Outgoing Bézier handle" aria-valuetext={`time ${outTangent.time.toFixed(3)}, value ${outTangent.value.toFixed(3)}`} onPointerDown={(event) => beginHandleDrag(event, "out")} onPointerMove={moveHandle} onPointerUp={(event) => finishHandleDrag(event)} onPointerCancel={(event) => finishHandleDrag(event, true)} onKeyDown={(event) => nudgeHandle(event, "out")} />
        <circle className="composition-curve-handle" cx={inX} cy={inY} r="5" tabIndex={0} role="slider" aria-label="Incoming Bézier handle" aria-valuetext={`time ${inTangent.time.toFixed(3)}, value ${inTangent.value.toFixed(3)}`} onPointerDown={(event) => beginHandleDrag(event, "in")} onPointerMove={moveHandle} onPointerUp={(event) => finishHandleDrag(event)} onPointerCancel={(event) => finishHandleDrag(event, true)} onKeyDown={(event) => nudgeHandle(event, "in")} />
      </>}
      <circle className="composition-curve-key" cx={leftX} cy={leftY} r="4" />
      <circle className="composition-curve-key" cx={rightX} cy={rightY} r="4" />
      <text className="composition-curve-label" x={LEFT} y={HEIGHT - 7}>{leftKey.time.toFixed(3)}s</text>
      <text className="composition-curve-label" x={RIGHT} y={HEIGHT - 7} textAnchor="end">{rightKey.time.toFixed(3)}s</text>
      <text className="composition-curve-value" x={LEFT - 7} y={leftY} textAnchor="end">{leftValue.toFixed(2)}</text>
      <text className="composition-curve-value" x={LEFT - 7} y={rightY} textAnchor="end">{rightValue.toFixed(2)}</text>
    </svg>
    {leftKey.interpolation !== "bezier" && <small>Select Bezier interpolation on the left key to edit tangent handles.</small>}
  </section>;
}
