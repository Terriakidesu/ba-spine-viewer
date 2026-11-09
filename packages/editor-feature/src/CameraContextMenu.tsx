import { ContextMenu, type ContextMenuAction } from "@ba-spine/app-ui/ContextMenu";

export type CameraContextMenuAction = ContextMenuAction;

interface CameraContextMenuProps {
  x: number;
  y: number;
  actions: readonly CameraContextMenuAction[];
  onClose: () => void;
  onEscape: () => void;
  returnFocusTo?: HTMLElement | SVGElement | null;
}

export function CameraContextMenu({ x, y, actions, onClose, onEscape, returnFocusTo }: CameraContextMenuProps) {
  return <ContextMenu
    x={x}
    y={y}
    label="Camera actions"
    actions={actions}
    onClose={onClose}
    onEscape={onEscape}
    returnFocusTo={returnFocusTo}
  />;
}
