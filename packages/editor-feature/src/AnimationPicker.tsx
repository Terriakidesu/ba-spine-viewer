import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterAnimationPickerOptions, includeMissingAnimationOption, type AnimationPickerOption } from "./animationPickerModel";

interface AnimationPickerProps {
  ariaLabel: string;
  value: string;
  options: readonly AnimationPickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function AnimationPicker({ ariaLabel, value, options, onChange, disabled = false, placeholder = "Choose animation…" }: AnimationPickerProps) {
  const pickerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const availableOptions = useMemo(() => includeMissingAnimationOption(options, value), [options, value]);
  const results = useMemo(() => filterAnimationPickerOptions(availableOptions, search), [availableOptions, search]);
  const selected = availableOptions.find((option) => option.value === value);
  const activeOptionIndex = Math.min(Math.max(0, activeIndex), Math.max(0, results.length - 1));

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (open) optionRefs.current[activeOptionIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionIndex, open, results.length]);

  function openPicker() {
    setSearch("");
    const selectedIndex = availableOptions.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function closePicker(restoreFocus: boolean) {
    setOpen(false);
    setSearch("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(option: AnimationPickerOption) {
    onChange(option.value);
    closePicker(true);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const lastIndex = results.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(Math.max(0, lastIndex), activeOptionIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, activeOptionIndex - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, lastIndex));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = results[activeOptionIndex];
      if (option) choose(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePicker(true);
    } else if (event.key === "Tab") {
      closePicker(false);
    }
  }

  return <div ref={rootRef} className={`editor-animation-picker${open ? " is-open" : ""}`}>
    <button
      ref={triggerRef}
      type="button"
      className={`editor-animation-picker-trigger${value && !options.some((option) => option.value === value) ? " is-missing" : ""}`}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${pickerId}-list`}
      title={selected?.label ?? placeholder}
      disabled={disabled}
      onClick={() => open ? closePicker(false) : openPicker()}
    ><span>{selected?.label ?? placeholder}</span><i aria-hidden="true">⌄</i></button>
    {open && <div className="editor-animation-picker-popover">
      <label className="editor-animation-picker-search" htmlFor={`${pickerId}-search`}>Search animations
        <input
          ref={searchRef}
          id={`${pickerId}-search`}
          type="search"
          role="combobox"
          aria-label={`${ariaLabel} search`}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${pickerId}-list`}
          aria-activedescendant={results.length ? `${pickerId}-option-${activeOptionIndex}` : undefined}
          value={search}
          onChange={(event) => { setSearch(event.target.value); setActiveIndex(0); }}
          onKeyDown={handleSearchKeyDown}
          placeholder="Type an animation name…"
        />
      </label>
      <div className="editor-animation-picker-count" aria-live="polite">{search.trim() ? `${results.length} match${results.length === 1 ? "" : "es"}` : `${results.length} animation${results.length === 1 ? "" : "s"}`}</div>
      <div className="editor-animation-picker-list" id={`${pickerId}-list`} role="listbox" aria-label={`${ariaLabel} options`}>
        {results.map((option, index) => <button
          ref={(element) => { optionRefs.current[index] = element; }}
          id={`${pickerId}-option-${index}`}
          key={`${option.value}-${index}`}
          type="button"
          role="option"
          aria-selected={value === option.value}
          className={`editor-animation-picker-option${index === activeOptionIndex ? " is-active" : ""}${value === option.value ? " is-selected" : ""}`}
          title={option.label}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(option)}
        >{option.label}</button>)}
        {results.length === 0 && <p className="editor-muted editor-animation-picker-empty">No animations match this search.</p>}
      </div>
    </div>}
  </div>;
}
