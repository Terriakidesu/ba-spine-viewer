import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface ContextMenuAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  label: string;
  actions: readonly ContextMenuAction[];
  onClose: () => void;
  onEscape?: () => void;
  returnFocusTo?: HTMLElement | SVGElement | null;
}

export function isContextMenuShortcut(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function ContextMenu({ x, y, label, actions, onClose, onEscape, returnFocusTo }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onClose, onEscape, returnFocusTo });
  const [position, setPosition] = useState({ x, y });
  callbacksRef.current = { onClose, onEscape, returnFocusTo };
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
      const callbacks = callbacksRef.current;
      (callbacks.onEscape ?? callbacks.onClose)();
      requestAnimationFrame(() => callbacks.returnFocusTo?.focus({ preventScroll: true }));
    };
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div
    ref={rootRef}
    className="suite-context-menu"
    role="menu"
    aria-label={label}
    aria-keyshortcuts="ArrowDown ArrowUp Home End Escape"
    style={style}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={moveFocus}
  >
    {actions.map((action, index) => <FragmentAction key={`${action.label}-${index}`} action={action} onClose={onClose} returnFocusTo={returnFocusTo} />)}
  </div>;
}

function FragmentAction({ action, onClose, returnFocusTo }: { action: ContextMenuAction; onClose: () => void; returnFocusTo?: HTMLElement | SVGElement | null }) {
  return <>
    {action.separatorBefore && <div className="suite-context-menu-separator" role="separator" />}
    <button
      type="button"
      role="menuitem"
      className={action.danger ? "is-danger" : undefined}
      disabled={action.disabled}
      title={action.reason}
      onClick={() => {
        onClose();
        action.run();
        requestAnimationFrame(() => returnFocusTo?.focus({ preventScroll: true }));
      }}
    >
      <span>{action.label}</span>{action.disabled && action.reason && <small>{action.reason}</small>}
    </button>
  </>;
}
