import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { clampTimelinePreviewShare, DEFAULT_TIMELINE_PREVIEW_SHARE, MAX_TIMELINE_PREVIEW_SHARE, MIN_TIMELINE_PREVIEW_SHARE } from "./timelineLayout";
import "./timelineSplitHandle.css";

interface TimelineSplitHandleProps {
  value: number;
  onChange: (value: number) => void;
  getFlexibleHeight: () => number;
}

interface SplitGesture {
  pointerId: number;
  startY: number;
  startValue: number;
  availableHeight: number;
}

export function TimelineSplitHandle({ value, onChange, getFlexibleHeight }: TimelineSplitHandleProps) {
  const gestureRef = useRef<SplitGesture | null>(null);

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startValue: value,
      availableHeight: Math.max(1, getFlexibleHeight()),
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    onChange(clampTimelinePreviewShare(gesture.startValue + (gesture.startY - event.clientY) / gesture.availableHeight * 100));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onChange(clampTimelinePreviewShare(value + (event.key === "ArrowUp" ? step : -step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(MIN_TIMELINE_PREVIEW_SHARE);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(MAX_TIMELINE_PREVIEW_SHARE);
    }
  }

  return <div
    className="timeline-split-handle"
    role="separator"
    aria-label="Resize preview and timeline"
    aria-orientation="horizontal"
    aria-valuemin={MIN_TIMELINE_PREVIEW_SHARE}
    aria-valuemax={MAX_TIMELINE_PREVIEW_SHARE}
    aria-valuenow={value}
    aria-valuetext={`${value}% of flexible workspace height for the preview`}
    title="Drag to resize preview and timeline; use Up/Down, Home/End, or double-click to reset"
    tabIndex={0}
    onPointerDown={beginDrag}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onDoubleClick={() => onChange(DEFAULT_TIMELINE_PREVIEW_SHARE)}
    onKeyDown={handleKeyDown}
  ><span aria-hidden="true" /></div>;
}
