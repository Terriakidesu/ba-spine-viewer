import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { nextBoundedCommit, normalizeBoundedValue } from "./boundedSliderFieldModel";
import { NumberField } from "./NumberField";
import "./boundedSliderField.css";

interface BoundedSliderFieldProps {
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  precision?: number;
  unit?: string;
  disabled?: boolean;
  compact?: boolean;
  onCommit: (value: number) => void;
}

export function BoundedSliderField({ label, value, defaultValue, min, max, step, precision, unit, disabled = false, compact = false, onCommit }: BoundedSliderFieldProps) {
  const bounds = { min, max };
  const [draft, setDraft] = useState(() => normalizeBoundedValue(value, defaultValue, bounds));
  const draftRef = useRef(draft);
  const draggingRef = useRef(false);
  const lastCommittedRef = useRef(value);

  useEffect(() => {
    const next = normalizeBoundedValue(value, defaultValue, bounds);
    setDraft(next);
    draftRef.current = next;
    lastCommittedRef.current = value;
  }, [defaultValue, max, min, value]);

  function updateDraft(next: number) {
    const normalized = normalizeBoundedValue(next, value, bounds);
    draftRef.current = normalized;
    setDraft(normalized);
  }

  function commit(next = draftRef.current) {
    const changed = nextBoundedCommit(next, value, bounds);
    if (changed === null || changed === lastCommittedRef.current) return;
    lastCommittedRef.current = changed;
    onCommit(changed);
  }

  function beginDrag(event: ReactPointerEvent<HTMLInputElement>) {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishDrag(event: ReactPointerEvent<HTMLInputElement>) {
    if (!draggingRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = false;
    commit();
  }

  function cancelDrag(event: ReactPointerEvent<HTMLInputElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = false;
    updateDraft(value);
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    updateDraft(value);
    event.currentTarget.blur();
  }

  const displayed = precision === undefined ? String(Number(draft.toFixed(3))) : draft.toFixed(precision);

  return <div className={`editor-bounded-slider-field${compact ? " is-compact" : ""}`}>
    <div className="editor-bounded-slider-heading"><span>{label}</span><output>{displayed}{unit ? ` ${unit}` : ""}</output></div>
    <input
      className="editor-bounded-slider"
      type="range"
      aria-label={`${label} slider`}
      aria-valuetext={`${displayed}${unit ? ` ${unit}` : ""}`}
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onChange={(event) => updateDraft(Number(event.target.value))}
      onPointerDown={beginDrag}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={() => { if (!draggingRef.current) commit(); }}
    />
    <div className="editor-bounded-slider-controls">
      <NumberField
        label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        precision={precision}
        unit={unit}
        disabled={disabled}
        scrub={false}
        compact={compact}
        onCommit={(next) => { updateDraft(next); commit(next); }}
      />
      <button
        type="button"
        className="editor-button editor-bounded-slider-reset"
        aria-label={`Reset ${label}`}
        title={`Reset ${label} to ${defaultValue}${unit ? ` ${unit}` : ""}`}
        disabled={disabled || value === defaultValue}
        onClick={() => { updateDraft(defaultValue); commit(defaultValue); }}
      >Reset</button>
    </div>
  </div>;
}
