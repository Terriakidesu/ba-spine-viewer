import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface CameraContextMenuAction {
  label: string;
  disabled?: boolean;
  reason?: string;
  run: () => void;
}

interface CameraContextMenuProps {
  x: number;
  y: number;
  actions: readonly CameraContextMenuAction[];
  onClose: () => void;
  onEscape: () => void;
}

export function CameraContextMenu({ x, y, actions, onClose, onEscape }: CameraContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onClose, onEscape });
  const [position, setPosition] = useState({ x, y });
  callbacksRef.current = { onClose, onEscape };
  const style: CSSProperties = { left: position.x, top: position.y };

  useLayoutEffect(() => {
    const menu = rootRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
  }, [x, y, actions.length]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      callbacksRef.current.onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onEscape();
    };
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return <div
    ref={rootRef}
    className="camera-context-menu"
    role="menu"
    aria-label="Camera actions"
    style={style}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}
  >
    {actions.map((action, index) => <button
      key={`${action.label}-${index}`}
      type="button"
      role="menuitem"
      disabled={action.disabled}
      title={action.reason}
      onClick={() => {
        onClose();
        action.run();
      }}
    >
      <span>{action.label}</span>{action.disabled && action.reason && <small>{action.reason}</small>}
    </button>)}
  </div>;
}
