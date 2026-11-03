import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { filterCommandPaletteItems, firstEnabledCommandIndex, moveCommandPaletteIndex, type CommandPaletteItem } from "./commandPaletteModel";
import "./commandPalette.css";

export interface EditorCommand extends CommandPaletteItem {
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: readonly EditorCommand[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const filtered = useMemo(() => filterCommandPaletteItems(commands, query), [commands, query]);

  useEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setActiveIndex(firstEnabledCommandIndex(commands));
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    returnFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => firstEnabledCommandIndex(filtered, Math.max(0, index)));
  }, [filtered]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    dialogRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-item-${activeIndex}`)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, open]);

  if (!open) return null;

  function run(item: EditorCommand | undefined) {
    if (!item || item.disabled) return;
    onClose();
    item.run();
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = moveCommandPaletteIndex(activeIndex, direction, filtered.length);
      setActiveIndex(firstEnabledCommandIndex(filtered, next, direction));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledCommandIndex(filtered));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(firstEnabledCommandIndex(filtered, filtered.length - 1, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(filtered[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function keepFocusInDialog(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return <div className="editor-command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="editor-command-dialog" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={keepFocusInDialog}>
      <label className="editor-command-search"><span aria-hidden="true">⌕</span><input ref={inputRef} role="combobox" aria-label="Search commands" aria-autocomplete="list" aria-expanded="true" aria-controls={`${listId}-list`} aria-activedescendant={activeIndex >= 0 ? `${listId}-item-${activeIndex}` : undefined} placeholder="Search commands…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleSearchKeyDown} /></label>
      <div className="editor-command-results" id={`${listId}-list`} role="listbox" aria-label="Available commands">
        {filtered.map((item, index) => <button id={`${listId}-item-${index}`} key={item.id} type="button" role="option" aria-selected={index === activeIndex} disabled={item.disabled} className={`editor-command-option${index === activeIndex ? " is-active" : ""}`} onMouseEnter={() => !item.disabled && setActiveIndex(index)} onClick={() => run(item)}>
          <span className="editor-command-option-copy"><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}</span>
          <span className="editor-command-option-meta"><small>{item.group ?? "General"}</small>{item.disabled ? <small>Unavailable</small> : <small>↵</small>}</span>
        </button>)}
        {filtered.length === 0 && <p className="editor-command-empty">No commands match “{query}”.</p>}
      </div>
      <footer><span>↑↓ Navigate</span><span>Enter Run</span><span>Esc Close</span><kbd>Ctrl/⌘ K</kbd></footer>
    </section>
  </div>;
}
