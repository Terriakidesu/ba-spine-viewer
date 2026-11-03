import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { IconCheck, IconChevronRight, IconClose, IconFolder, IconSearch } from "@ba-spine/app-ui/icons";
import type { CharacterDirectoryInfo } from "./characterCatalog";
import {
  assetSetPreferencesKey,
  buildAssetPickerEntries,
  filterAndSortAssetPickerEntries,
  groupAssetPickerEntries,
  initialPickerIndex,
  movePickerIndex,
  normalizeAssetSetPreferences,
  rememberAssetSet,
  toggleAssetFavorite,
  type AssetPickerView,
  type AssetSetPreferences,
} from "./assetPickerModel";
import "./assetPicker.css";

export interface AssetPickerModalProps {
  open: boolean;
  title: string;
  eyebrow?: string;
  description?: string;
  directories: readonly string[];
  selected?: string;
  assetRoot?: string;
  directoryInfo?: Readonly<Record<string, CharacterDirectoryInfo>>;
  emptyLabel?: string;
  renderLabel?: (directory: string) => ReactNode;
  getSearchText?: (directory: string) => string;
  onClose: () => void;
  onSelect: (directory: string) => void;
}

function readPreferences(key: string): AssetSetPreferences {
  try {
    const stored = localStorage.getItem(key);
    return normalizeAssetSetPreferences(stored ? JSON.parse(stored) as unknown : null);
  } catch {
    return normalizeAssetSetPreferences(null);
  }
}

export function AssetPickerModal({ open, title, eyebrow = "CHOOSE ASSET SET", description, directories, selected, assetRoot = "", directoryInfo = {}, emptyLabel = "No matching asset sets.", renderLabel, getSearchText, onClose, onSelect }: AssetPickerModalProps) {
  const pickerId = useId();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AssetPickerView>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [storedPreferences, setStoredPreferences] = useState<{ key: string; value: AssetSetPreferences } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const storageKey = assetSetPreferencesKey(assetRoot);
  const preferences = useMemo(
    () => storedPreferences?.key === storageKey ? storedPreferences.value : readPreferences(storageKey),
    [storageKey, storedPreferences],
  );
  const entries = useMemo(() => buildAssetPickerEntries(directories, directoryInfo), [directories, directoryInfo]);
  const customSearchText = useMemo(
    () => Object.fromEntries(directories.map((directory) => [directory, getSearchText?.(directory) ?? ""])),
    [directories, getSearchText],
  );
  const allEntries = useMemo(
    () => filterAndSortAssetPickerEntries(entries, "", "all", preferences, customSearchText),
    [customSearchText, entries, preferences],
  );
  const filtered = useMemo(
    () => filterAndSortAssetPickerEntries(entries, query, view, preferences, customSearchText),
    [customSearchText, entries, preferences, query, view],
  );
  const groups = useMemo(() => groupAssetPickerEntries(filtered), [filtered]);
  const indexByDirectory = useMemo(() => new Map(filtered.map((entry, index) => [entry.directory, index])), [filtered]);
  const activeEntry = filtered[activeIndex] ?? null;
  const favoriteSet = new Set(preferences.favorites);
  const favoriteCount = directories.filter((directory) => favoriteSet.has(directory)).length;
  const recentCount = directories.filter((directory) => preferences.recent.includes(directory)).length;

  useEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setView("all");
      const selectedIndex = allEntries.findIndex((entry) => entry.directory === selected);
      setActiveIndex(initialPickerIndex(selectedIndex, allEntries.length));
      requestAnimationFrame(() => searchRef.current?.focus());
      return;
    }
    returnFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    setActiveIndex((index) => initialPickerIndex(index, filtered.length));
  }, [filtered.length, query, view]);

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, filtered.length, query, view]);

  function updatePreferences(update: (current: AssetSetPreferences) => AssetSetPreferences) {
    const next = update(preferences);
    setStoredPreferences({ key: storageKey, value: next });
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { /* Favorites and recents remain available for this modal session. */ }
  }

  function selectDirectory(directory: string) {
    updatePreferences((current) => ({ ...current, recent: rememberAssetSet(current.recent, directory) }));
    onSelect(directory);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => movePickerIndex(index, 1, filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => movePickerIndex(index, -1, filtered.length));
    } else if (event.key === "Home" && filtered.length > 0) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && filtered.length > 0) {
      event.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      selectDirectory(filtered[activeIndex]!.directory);
    }
  }

  function keepFocusInDialog(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1']), input:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const emptyMessage = filtered.length > 0 ? "" : view === "favorites" && favoriteCount === 0
    ? "No favorite sets yet. Choose a set, then add it to Favorites."
    : view === "recent" && recentCount === 0
      ? "No recently opened sets yet. Choose a set to add it here."
      : query.trim() ? "No asset sets match this search." : emptyLabel;

  return <div className="editor-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="asset-picker-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={keepFocusInDialog}>
      <header className="editor-modal-header">
        <div>
          <span className="editor-kicker">{eyebrow}</span>
          <h2 id="asset-picker-title">{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="editor-modal-close" type="button" aria-label="Close asset picker" onClick={onClose}><IconClose /></button>
      </header>
      <label className="editor-modal-search"><IconSearch /><input ref={searchRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${pickerId}-list`} aria-activedescendant={activeIndex >= 0 ? `${pickerId}-option-${activeIndex}` : undefined} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleSearchKeyDown} placeholder="Search asset sets…" aria-label="Search asset sets" /></label>
      <div className="editor-asset-picker-toolbar">
        <div className="editor-asset-picker-views" role="group" aria-label="Filter asset sets">
          <button type="button" aria-pressed={view === "all"} className={view === "all" ? "is-active" : ""} onClick={() => { setView("all"); setActiveIndex(0); }}>All <small>{directories.length}</small></button>
          <button type="button" aria-pressed={view === "favorites"} className={view === "favorites" ? "is-active" : ""} onClick={() => { setView("favorites"); setActiveIndex(0); }}>Favorites <small>{favoriteCount}</small></button>
          <button type="button" aria-pressed={view === "recent"} className={view === "recent" ? "is-active" : ""} onClick={() => { setView("recent"); setActiveIndex(0); }}>Recent <small>{recentCount}</small></button>
        </div>
        <button type="button" className="editor-asset-picker-favorite" disabled={!activeEntry} aria-pressed={activeEntry ? favoriteSet.has(activeEntry.directory) : false} title={activeEntry && favoriteSet.has(activeEntry.directory) ? "Remove this set from favorites" : "Add this set to favorites"} onClick={() => activeEntry && updatePreferences((current) => ({ ...current, favorites: toggleAssetFavorite(current.favorites, activeEntry.directory) }))}>
          {activeEntry && favoriteSet.has(activeEntry.directory) ? "★ Remove favorite" : "☆ Favorite active set"}
        </button>
      </div>
      <div className="editor-modal-count" aria-live="polite">{filtered.length} of {directories.length} asset sets{query && <span> · ↑/↓ choose, Enter opens</span>}</div>
      <div className="editor-modal-list" id={`${pickerId}-list`} role="listbox" aria-label={title}>
        {groups.map((group) => <div key={group.key} className="editor-asset-picker-group" role="group" aria-label={`${group.label} asset sets`}>
          <div className="editor-asset-picker-group-title" aria-hidden="true"><strong>{group.label}</strong><small>{group.entries.length}</small></div>
          {group.entries.map((entry) => {
            const index = indexByDirectory.get(entry.directory) ?? -1;
            const isFavorite = favoriteSet.has(entry.directory);
            const friendlyName = renderLabel ? renderLabel(entry.directory) : entry.label;
            const technicalName = entry.directory;
            return <button ref={(element) => { if (index >= 0) optionRefs.current[index] = element; }} id={`${pickerId}-option-${index}`} key={entry.directory} type="button" role="option" tabIndex={-1} aria-label={`${entry.label}, ${entry.directory}, ${entry.role}${isFavorite ? ", favorite" : ""}`} aria-selected={entry.directory === selected} className={`editor-modal-option${entry.directory === selected ? " is-selected" : ""}${index === activeIndex ? " is-active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => selectDirectory(entry.directory)}>
              <span className="editor-modal-option-icon">{entry.directory === selected ? <IconCheck /> : <IconFolder />}</span>
              <span className="editor-modal-option-label">
                <span className="editor-asset-picker-friendly">{friendlyName}</span>
                <small className="editor-asset-picker-technical">{technicalName}</small>
              </span>
              <span className="editor-asset-picker-badge" title={`${entry.role} asset set`}>{entry.role}</span>
              <span className="editor-asset-picker-star" aria-label={isFavorite ? "Favorite" : undefined}>{isFavorite ? "★" : ""}</span>
              <span className="editor-modal-option-arrow"><IconChevronRight /></span>
            </button>;
          })}
        </div>)}
        {filtered.length === 0 && <div className="editor-modal-empty">{emptyMessage}</div>}
      </div>
    </section>
  </div>;
}
