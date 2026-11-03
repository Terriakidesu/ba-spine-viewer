import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampTimelinePanelWidth, DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH, DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH, MAX_TIMELINE_INSPECTOR_PANEL_WIDTH, MAX_TIMELINE_SEQUENCE_PANEL_WIDTH, MIN_TIMELINE_INSPECTOR_PANEL_WIDTH, MIN_TIMELINE_SEQUENCE_PANEL_WIDTH } from "./timelineLayout";
import "./timelinePanelResizer.css";

type TimelinePanelSide = "sequences" | "inspector";

interface TimelinePanelResizerProps {
  side: TimelinePanelSide;
  value: number;
  onChange: (value: number) => void;
}

interface ResizeGesture {
  pointerId: number;
  startX: number;
  startValue: number;
}

export function TimelinePanelResizer({ side, value, onChange }: TimelinePanelResizerProps) {
  const gestureRef = useRef<ResizeGesture | null>(null);
  const label = side === "sequences" ? "sequence panel" : "inspector panel";
  const min = side === "sequences" ? MIN_TIMELINE_SEQUENCE_PANEL_WIDTH : MIN_TIMELINE_INSPECTOR_PANEL_WIDTH;
  const max = side === "sequences" ? MAX_TIMELINE_SEQUENCE_PANEL_WIDTH : MAX_TIMELINE_INSPECTOR_PANEL_WIDTH;
  const defaultWidth = side === "sequences" ? DEFAULT_TIMELINE_SEQUENCE_PANEL_WIDTH : DEFAULT_TIMELINE_INSPECTOR_PANEL_WIDTH;
  const direction = side === "sequences" ? 1 : -1;

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    onChange(clampTimelinePanelWidth(side, gesture.startValue + (event.clientX - gesture.startX) * direction));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 8 : event.key === "ArrowLeft" ? -8 : 0;
    if (delta) {
      event.preventDefault();
      onChange(clampTimelinePanelWidth(side, value + delta * direction));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(max);
    }
  }

  return <div
    className={`timeline-panel-resizer ${side}`}
    role="separator"
    aria-label={`Resize ${label}`}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={`${value} pixels`}
    title={`Drag to resize ${label}; use left/right arrows or Home/End; double-click to reset`}
    tabIndex={0}
    onPointerDown={beginDrag}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onKeyDown={handleKeyDown}
    onDoubleClick={() => onChange(defaultWidth)}
  ><span aria-hidden="true" /></div>;
}
