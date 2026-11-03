import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { rankBoneMatches } from "./boneTree";

function shortParentBreadcrumb(bone: SpineEditorBone): string {
  const parents = bone.parentPath?.split("/").filter(Boolean) ?? [];
  if (parents.length === 0) return "Root bone";
  const visible = parents.slice(-2);
  return `${parents.length > visible.length ? "… / " : ""}${visible.join(" / ")}`;
}

interface BonePickerProps {
  label: string;
  bones: SpineEditorBone[];
  value: string | null;
  noneLabel: string;
  selectedPath: string | null;
  useSelectedLabel?: string;
  onChange: (path: string | null) => void;
  onUseSelected?: () => void;
  onReveal: (path: string) => void;
}

export function BonePicker({ label, bones, value, noneLabel, selectedPath, useSelectedLabel = "Use selected bone", onChange, onUseSelected, onReveal }: BonePickerProps) {
  const pickerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => rankBoneMatches(bones, search), [bones, search]);
  const selectedBone = bones.find((bone) => bone.path === value) ?? null;
  const selectedBoneIndex = bones.findIndex((bone) => bone.path === value);
  const activeOptionIndex = Math.min(Math.max(0, activeIndex), results.length);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, results.length));
  }, [results.length]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, results.length, search]);

  function openPicker() {
    setSearch("");
    setActiveIndex(selectedBoneIndex >= 0 ? selectedBoneIndex + 1 : 0);
    setOpen(true);
  }

  function choose(path: string | null) {
    onChange(path);
    setOpen(false);
    setSearch("");
    triggerRef.current?.focus();
  }

  function useSelectedBone() {
    if (!selectedPath || !bones.some((bone) => bone.path === selectedPath)) return;
    if (onUseSelected) {
      onUseSelected();
      setOpen(false);
      setSearch("");
      triggerRef.current?.focus();
    } else choose(selectedPath);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const lastIndex = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(lastIndex, activeOptionIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, activeOptionIndex - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastIndex);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeOptionIndex === 0 ? null : results[activeOptionIndex - 1]?.path ?? null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return <div className="editor-bone-picker" ref={rootRef}>
    <div className="editor-bone-picker-heading">
      <strong>{label}</strong>
      <button ref={triggerRef} type="button" className="editor-bone-picker-choose" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${pickerId}-list`} onClick={() => open ? setOpen(false) : openPicker()}>
        {open ? "Close" : "Choose bone…"}
      </button>
    </div>
    <div className="editor-bone-current">
      <span className="editor-bone-current-label">Current</span>
      <strong title={selectedBone?.name ?? noneLabel}>{selectedBone?.name ?? noneLabel}</strong>
      <small title={selectedBone?.path ?? ""}>{selectedBone?.path ?? (value ? "Bone not found in this rig" : "No bone assigned")}</small>
    </div>
    <div className="editor-bone-picker-actions">
      <button type="button" disabled={!value} onClick={() => choose(null)}>Clear</button>
      <button type="button" disabled={!selectedPath || !bones.some((bone) => bone.path === selectedPath)} onClick={useSelectedBone}>{useSelectedLabel}</button>
      <button type="button" disabled={!value || !selectedBone} onClick={() => { if (value && selectedBone) { onReveal(value); setOpen(false); } }}>Reveal in hierarchy</button>
    </div>
    {open && <div className="editor-bone-picker-popover">
      <label className="editor-bone-picker-search" htmlFor={`${pickerId}-search`}>Search name or path
        <input ref={searchRef} id={`${pickerId}-search`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${pickerId}-list`} aria-activedescendant={`${pickerId}-option-${activeOptionIndex}`} value={search} onChange={(event) => { setSearch(event.target.value); setActiveIndex(1); }} onKeyDown={handleSearchKeyDown} placeholder="Type a bone name or path…" />
      </label>
      <div className="editor-bone-picker-count" aria-live="polite">{search.trim() ? `${results.length} matching bone${results.length === 1 ? "" : "s"}` : `${results.length} bones`}</div>
      <div className="editor-bone-picker-list" id={`${pickerId}-list`} role="listbox" aria-label={`${label} options`}>
        <button ref={(element) => { optionRefs.current[0] = element; }} id={`${pickerId}-option-0`} type="button" role="option" aria-selected={!value} className={`editor-bone-option editor-bone-option-none${activeOptionIndex === 0 ? " is-active" : ""}${!value ? " is-selected" : ""}`} onMouseEnter={() => setActiveIndex(0)} onClick={() => choose(null)}>
          <strong>{noneLabel}</strong>
          <small>{value ? "Clear the current bone assignment" : "No bone assignment"}</small>
        </button>
        {results.map((bone, index) => {
          const optionIndex = index + 1;
          const path = bone.path;
          const active = activeOptionIndex === optionIndex;
          return <button ref={(element) => { optionRefs.current[optionIndex] = element; }} id={`${pickerId}-option-${optionIndex}`} type="button" role="option" key={path} aria-selected={value === path} className={`editor-bone-option${active ? " is-active" : ""}${value === path ? " is-selected" : ""}`} title={path} onMouseEnter={() => setActiveIndex(optionIndex)} onClick={() => choose(path)}>
            <strong>{bone.name}</strong>
            <small>{shortParentBreadcrumb(bone)}</small>
          </button>;
        })}
        {results.length === 0 && <p className="editor-muted editor-bone-picker-empty">No matching bones.</p>}
      </div>
    </div>}
  </div>;
}
