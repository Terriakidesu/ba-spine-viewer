import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { IconSliders } from "@ba-spine/app-ui/icons";
import { clampNumericValue, formatNumericValue, numericPrecision, parseNumericDraft, stepNumericValue, type NumericBounds } from "./numberFieldModel";
import "./numberField.css";

export interface NumberFieldProps extends NumericBounds {
  label: string;
  value: number;
  step?: number;
  precision?: number;
  unit?: string;
  disabled?: boolean;
  scrub?: boolean;
  shiftMultiplier?: number;
  altMultiplier?: number;
  scrubLabel?: string | false;
  scrubHint?: string;
  compact?: boolean;
  onCommit: (value: number) => void;
}

interface ScrubGesture {
  pointerId: number;
  lastX: number;
  startValue: number;
  accumulatedSteps: number;
}

export function NumberField({ label, value, min, max, step = 1, precision = numericPrecision(step), unit, disabled = false, scrub = true, shiftMultiplier = 10, altMultiplier = 1, scrubLabel = "Drag", scrubHint, compact = false, onCommit }: NumberFieldProps) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => formatNumericValue(value, precision));
  const [invalid, setInvalid] = useState(false);
  const [focused, setFocused] = useState(false);
  const scrubRef = useRef<ScrubGesture | null>(null);
  const syncedValueRef = useRef({ value, precision });
  const lastCommittedValueRef = useRef(value);
  const bounds = { min, max };

  useEffect(() => {
    const changed = syncedValueRef.current.value !== value || syncedValueRef.current.precision !== precision;
    syncedValueRef.current = { value, precision };
    if (changed) lastCommittedValueRef.current = value;
    if (changed && !focused && !scrubRef.current) {
      setDraft(formatNumericValue(value, precision));
      setInvalid(false);
    }
  }, [focused, precision, value]);

  function commitDraft(nextDraft = draft): boolean {
    const parsed = parseNumericDraft(nextDraft);
    if (parsed === null) {
      setInvalid(true);
      return false;
    }
    const next = clampNumericValue(parsed, bounds);
    setDraft(formatNumericValue(next, precision));
    setInvalid(false);
    commitValue(next);
    return true;
  }

  function commitValue(next: number) {
    if (next === value || next === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = next;
    onCommit(next);
  }

  function onScrubMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = scrubRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.lastX;
    gesture.lastX = event.clientX;
    const multiplier = event.shiftKey ? shiftMultiplier : event.altKey ? altMultiplier : 1;
    gesture.accumulatedSteps += deltaX / 5 * multiplier;
    const next = clampNumericValue(gesture.startValue + gesture.accumulatedSteps * step, bounds);
    const effectivePrecision = Math.max(precision, numericPrecision(step * Math.min(1, shiftMultiplier, altMultiplier || 1)));
    setDraft(formatNumericValue(next, effectivePrecision));
  }

  function finishScrub(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = scrubRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    commitDraft(draft);
  }

  function cancelScrub(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = scrubRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraft(formatNumericValue(value, precision));
  }

  return <div className={`editor-number-field${invalid ? " is-invalid" : ""}${compact ? " is-compact" : ""}`}>
    <span className="editor-number-heading">
      <label htmlFor={inputId}>{label}</label>
      {scrub && <button
        type="button"
        className="editor-number-scrub"
        aria-label={`Scrub ${label}`}
         title={scrubHint ?? `Drag horizontally to adjust ${label}; Shift ${shiftMultiplier < 1 ? "fine-tunes" : `${shiftMultiplier}× steps`}${altMultiplier !== 1 ? `; Alt ${altMultiplier}× steps` : ""}.`}
        disabled={disabled}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          scrubRef.current = { pointerId: event.pointerId, lastX: event.clientX, startValue: value, accumulatedSteps: 0 };
        }}
        onPointerMove={onScrubMove}
        onPointerUp={finishScrub}
        onPointerCancel={cancelScrub}
        onLostPointerCapture={cancelScrub}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const multiplier = event.shiftKey ? shiftMultiplier : event.altKey ? altMultiplier : 1;
          const next = stepNumericValue(value, event.key === "ArrowRight" ? 1 : -1, step, bounds, multiplier);
          setDraft(formatNumericValue(next, precision));
          commitValue(next);
        }}
       ><IconSliders />{scrubLabel !== false && <span>{scrubLabel}</span>}</button>}
    </span>
    <span className="editor-number-input-wrap">
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onFocus={() => setFocused(true)}
        onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
        onBlur={() => { setFocused(false); commitDraft(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (commitDraft()) event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(formatNumericValue(value, precision));
            setInvalid(false);
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const direction = event.key === "ArrowUp" ? 1 : -1;
            const multiplier = event.shiftKey ? shiftMultiplier : event.altKey ? altMultiplier : 1;
            const next = stepNumericValue(parseNumericDraft(draft) ?? value, direction, step, bounds, multiplier);
            setDraft(formatNumericValue(next, precision));
            setInvalid(false);
            commitValue(next);
          } else if (event.key === "Home" && min !== undefined) {
            event.preventDefault();
            const next = clampNumericValue(min, bounds);
            setDraft(formatNumericValue(next, precision));
            setInvalid(false);
            commitValue(next);
          } else if (event.key === "End" && max !== undefined) {
            event.preventDefault();
            const next = clampNumericValue(max, bounds);
            setDraft(formatNumericValue(next, precision));
            setInvalid(false);
            commitValue(next);
          }
        }}
      />
      {unit && <span className="editor-number-unit-suffix" aria-hidden="true">{unit}</span>}
    </span>
    {invalid && <small className="editor-number-error" id={errorId} role="alert">Enter a valid finite number.</small>}
  </div>;
}
