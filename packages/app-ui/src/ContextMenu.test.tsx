import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import { ContextMenu, isContextMenuShortcut } from "./ContextMenu";

test("shared context menu renders accessible items and keeps unsupported actions disabled", () => {
  const markup = renderToStaticMarkup(createElement(ContextMenu, {
    x: 20,
    y: 30,
    label: "Asset actions",
    actions: [
      { label: "Open", run: () => undefined },
      { label: "Reveal", run: () => undefined, disabled: true, reason: "Not available in this source." },
      { label: "Delete", run: () => undefined, danger: true, separatorBefore: true },
    ],
    onClose: () => undefined,
  }));

  expect(markup).toContain('role="menu"');
  expect(markup).toContain('aria-label="Asset actions"');
  expect(markup.match(/role="menuitem"/g)).toHaveLength(3);
  expect(markup).toContain('role="separator"');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain("Not available in this source.");
  expect(markup).toContain('class="is-danger"');
});

test("context-menu keyboard shortcut recognizes Shift+F10 and the menu key", () => {
  expect(isContextMenuShortcut({ key: "F10", shiftKey: true })).toBe(true);
  expect(isContextMenuShortcut({ key: "ContextMenu", shiftKey: false })).toBe(true);
  expect(isContextMenuShortcut({ key: "F10", shiftKey: false })).toBe(false);
});
