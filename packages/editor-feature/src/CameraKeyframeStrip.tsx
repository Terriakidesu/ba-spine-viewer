import { forwardRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { SpineCameraKeyframe } from "@ba-spine/spine-runtime/spine/spineCameraMotion";

interface CameraKeyframeStripProps {
  keyframes: readonly SpineCameraKeyframe[];
  duration: number;
  currentTime: number;
  selectedId: string | null;
  draggingId: string | null;
  timeIssue: string | null;
  onSeek: (clientX: number) => void;
  onSelect: (id: string) => void;
  onRetimeStart: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  onRetimeMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRetimeEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRetimeCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTrackContextMenu: (event: ReactMouseEvent<HTMLDivElement>, time: number | null) => void;
  onKeyframeContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, id: string) => void;
}

function seconds(value: number): string {
  return `${value.toFixed(3)}s`;
}

export const CameraKeyframeStrip = forwardRef<HTMLDivElement, CameraKeyframeStripProps>(function CameraKeyframeStrip({
  keyframes,
  duration,
  currentTime,
  selectedId,
  draggingId,
  timeIssue,
  onSeek,
  onSelect,
  onRetimeStart,
  onRetimeMove,
  onRetimeEnd,
  onRetimeCancel,
  onTrackContextMenu,
  onKeyframeContextMenu,
}, ref) {
  return <section className="camera-keyframe-strip" aria-label="Camera shot timeline">
    <header><strong>Camera timeline</strong><small>Drag shots to retime · snap to playhead and neighbors · hold Alt to bypass snapping</small></header>
    <div ref={ref} className="camera-keyframe-track" onClick={(event) => {
      if (event.target === event.currentTarget) onSeek(event.clientX);
    }} onContextMenu={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const time = bounds.width > 0 ? Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration)) : null;
      onTrackContextMenu(event, time);
    }}>
      <span className="camera-keyframe-axis" />
      <span className="camera-keyframe-playhead" style={{ left: `${duration > 0 ? currentTime / duration * 100 : 0}%` }} aria-hidden="true" />
      {keyframes.map((keyframe) => <button
        key={keyframe.id}
        type="button"
        className={`camera-keyframe-marker${selectedId === keyframe.id ? " is-selected" : ""}${draggingId === keyframe.id ? " is-dragging" : ""}`}
        data-camera-keyframe={keyframe.id}
        style={{ left: `${duration > 0 ? keyframe.time / duration * 100 : 0}%` }}
        title={`Shot ${seconds(keyframe.time)} · ${keyframe.easing ?? "linear"} · drag to retime`}
        aria-label={`Camera shot at ${seconds(keyframe.time)}, ${keyframe.easing ?? "linear"} interpolation`}
        aria-pressed={selectedId === keyframe.id}
        onPointerDown={(event) => onRetimeStart(event, keyframe.id)}
        onPointerMove={onRetimeMove}
        onPointerUp={onRetimeEnd}
        onPointerCancel={onRetimeCancel}
        onLostPointerCapture={onRetimeCancel}
        onClick={() => onSelect(keyframe.id)}
        onContextMenu={(event) => {
          event.stopPropagation();
          onKeyframeContextMenu(event, keyframe.id);
        }}
      ><i aria-hidden="true" /><span>{seconds(keyframe.time)}</span><small>{keyframe.easing === "hold" ? "Hold" : keyframe.easing === "smooth" ? "Smooth" : "Linear"}</small></button>)}
      {!keyframes.length && <span className="camera-keyframe-empty">No camera shots yet</span>}
    </div>
    {timeIssue && <small className="camera-timeline-issue" role="status">{timeIssue}</small>}
  </section>;
});
