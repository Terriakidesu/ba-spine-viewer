import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SpineEditorBone } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { IconChevronDown, IconChevronRight, IconDot } from "@ba-spine/app-ui/icons";
import { buildBoneTreeRows } from "./boneTree";
import type { BoneTreeBone } from "./boneTree";
import {
  bonePathsForFilter,
  boneTargetPreferencesKey,
  initialCollapsedBonePaths,
  normalizeBoneTargetPreferences,
  parentBonePaths,
  rememberBoneTarget,
  toggleBoneFavorite,
  type BoneNavigationFilter,
  type BoneTargetPreferences,
} from "./boneNavigatorModel";
import "./boneNavigator.css";

export interface BoneRevealRequest {
  path: string;
  revision: number;
}

interface BoneNavigatorProps {
  assetRoot: string;
  directory: string;
  bones: SpineEditorBone[];
  selectedPath: string | null;
  interactionTargetPaths: readonly string[];
  showInactive: boolean;
  revealRequest: BoneRevealRequest | null;
  onSelect: (path: string) => void;
}

interface StoredPreferences {
  key: string;
  value: BoneTargetPreferences;
}

function readPreferences(key: string): BoneTargetPreferences {
  try {
    const value = localStorage.getItem(key);
    return normalizeBoneTargetPreferences(value ? JSON.parse(value) as unknown : null);
  } catch {
    return normalizeBoneTargetPreferences(null);
  }
}

function highlightedName(name: string, search: string) {
  const query = search.trim();
  const start = query ? name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  if (start < 0) return name;
  return <>{name.slice(0, start)}<mark>{name.slice(start, start + query.length)}</mark>{name.slice(start + query.length)}</>;
}

function parentPathsFor(path: string, byPath: ReadonlyMap<string, BoneTreeBone>): string[] {
  const parents: string[] = [];
  const visited = new Set([path]);
  let current = byPath.get(path)?.parentPath ?? null;
  while (current && !visited.has(current)) {
    visited.add(current);
    parents.push(current);
    current = byPath.get(current)?.parentPath ?? null;
  }
  return parents;
}

const FILTERS: Array<{ id: BoneNavigationFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "interaction-targets", label: "Interaction targets" },
  { id: "selected-branch", label: "Selected branch" },
];

export function BoneNavigator({ assetRoot, directory, bones, selectedPath, interactionTargetPaths, showInactive, revealRequest, onSelect }: BoneNavigatorProps) {
  const searchId = useId();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastRevealRevisionRef = useRef(revealRequest?.revision ?? 0);
  const storageKey = boneTargetPreferencesKey(assetRoot, directory);
  const [storedPreferences, setStoredPreferences] = useState<StoredPreferences | null>(null);
  const preferences = useMemo(
    () => storedPreferences?.key === storageKey ? storedPreferences.value : readPreferences(storageKey),
    [storageKey, storedPreferences],
  );
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BoneNavigationFilter>("all");
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);
  const rigKey = `${assetRoot}\u0000${directory}\u0000${bones.map((bone) => `${bone.path}\u0001${bone.name}\u0001${bone.parentPath ?? ""}\u0001${Number(bone.active)}`).join("\u0000")}`;
  const treeBones = useMemo(() => bones.map(({ path, name, parentPath, active }) => ({ path, name, parentPath, active })), [rigKey]);
  const defaultCollapsed = useMemo(() => initialCollapsedBonePaths(treeBones), [treeBones]);
  const [collapseState, setCollapseState] = useState<{ rigKey: string; paths: Set<string> } | null>(null);
  const collapsed = collapseState?.rigKey === rigKey ? collapseState.paths : defaultCollapsed;
  const byPath = useMemo(() => new Map(treeBones.map((bone) => [bone.path, bone])), [treeBones]);
  const includedPaths = useMemo(
    () => bonePathsForFilter(treeBones, filter, interactionTargetPaths, selectedPath),
    [filter, interactionTargetPaths, selectedPath, treeBones],
  );
  const rows = useMemo(
    () => buildBoneTreeRows(treeBones, collapsed, search, showInactive, includedPaths, pinnedPath),
    [collapsed, includedPaths, pinnedPath, search, showInactive, treeBones],
  );
  const selectedAncestors = useMemo(() => new Set(parentPathsFor(selectedPath ?? "", byPath)), [byPath, selectedPath]);
  const rovingPath = rows.some((row) => row.bone.path === selectedPath) ? selectedPath : rows[0]?.bone.path ?? null;
  const selectedBone = selectedPath ? byPath.get(selectedPath) ?? null : null;
  const selectedIsFavorite = selectedPath !== null && preferences.favorites.includes(selectedPath);
  const availableFavorites = preferences.favorites.map((path) => byPath.get(path)).filter((bone): bone is BoneTreeBone => Boolean(bone));
  const availableRecent = preferences.recent.map((path) => byPath.get(path)).filter((bone): bone is BoneTreeBone => Boolean(bone));

  function updatePreferences(update: (current: BoneTargetPreferences) => BoneTargetPreferences) {
    const next = update(preferences);
    setStoredPreferences({ key: storageKey, value: next });
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { /* Target shortcuts still work for this session if storage is unavailable. */ }
  }

  function updateCollapsed(update: (current: ReadonlySet<string>) => Set<string>) {
    setCollapseState((current) => ({
      rigKey,
      paths: update(current?.rigKey === rigKey ? current.paths : defaultCollapsed),
    }));
  }

  function changeFilter(nextFilter: BoneNavigationFilter) {
    setFilter(nextFilter);
    setPinnedPath(null);
    const paths = nextFilter === "interaction-targets"
      ? interactionTargetPaths
      : nextFilter === "selected-branch" && selectedPath
        ? [selectedPath]
        : [];
    if (paths.length) {
      updateCollapsed((current) => {
        const next = new Set(current);
        for (const path of paths) for (const ancestor of parentPathsFor(path, byPath)) next.delete(ancestor);
        return next;
      });
    }
  }

  function toggleBranch(path: string) {
    updateCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function selectPath(path: string, focus = false) {
    onSelect(path);
    updatePreferences((current) => ({ ...current, recent: rememberBoneTarget(current.recent, path) }));
    if (focus) requestAnimationFrame(() => rowRefs.current.get(path)?.focus());
  }

  function revealPath(path: string, select = false) {
    setPinnedPath(path);
    const ancestors = parentPathsFor(path, byPath);
    updateCollapsed((current) => {
      const next = new Set(current);
      for (const ancestor of ancestors) next.delete(ancestor);
      return next;
    });
    if (select) selectPath(path);
    else updatePreferences((current) => ({ ...current, recent: rememberBoneTarget(current.recent, path) }));
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(path);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus();
    });
  }

  useEffect(() => {
    const request = revealRequest;
    if (!request || request.revision <= lastRevealRevisionRef.current) return;
    lastRevealRevisionRef.current = request.revision;
    revealPath(request.path);
  }, [revealRequest]);

  function moveTo(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    const row = rows[index];
    if (!row) return;
    event.preventDefault();
    selectPath(row.bone.path, true);
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, path: string) {
    const index = rows.findIndex((row) => row.bone.path === path);
    const row = rows[index];
    if (!row) return;
    if (event.key === "ArrowDown") moveTo(Math.min(rows.length - 1, index + 1), event);
    else if (event.key === "ArrowUp") moveTo(Math.max(0, index - 1), event);
    else if (event.key === "Home") moveTo(0, event);
    else if (event.key === "End") moveTo(rows.length - 1, event);
    else if (event.key === "ArrowRight" && row.hasChildren) {
      event.preventDefault();
      if (!search.trim() && collapsed.has(path)) toggleBranch(path);
      else {
        const childIndex = rows.findIndex((candidate) => candidate.bone.parentPath === path);
        if (childIndex >= 0) moveTo(childIndex, event);
      }
    } else if (event.key === "ArrowLeft") {
      if (!search.trim() && row.hasChildren && !collapsed.has(path)) {
        event.preventDefault();
        toggleBranch(path);
      } else if (row.bone.parentPath) {
        const parentIndex = rows.findIndex((candidate) => candidate.bone.path === row.bone.parentPath);
        if (parentIndex >= 0) moveTo(parentIndex, event);
      }
    }
  }

  function openTarget(path: string) {
    revealPath(path, true);
  }

  function renderTargetChips(label: string, targets: readonly BoneTreeBone[], kind: "favorite" | "recent") {
    if (!targets.length) return null;
    return <div className={`editor-bone-shortcuts is-${kind}`}>
      <strong>{label}</strong>
      <div>{targets.slice(0, 6).map((bone) => <button key={bone.path} type="button" title={bone.path} aria-current={bone.path === selectedPath ? "true" : undefined} onClick={() => openTarget(bone.path)}>{kind === "favorite" ? "★ " : "↻ "}{bone.name}</button>)}</div>
    </div>;
  }

  return <section className="editor-section editor-bone-section">
    <div className="editor-section-title"><strong>Rig hierarchy</strong><span>{search.trim() ? `${rows.filter((row) => row.matches).length} matches` : `${rows.filter((row) => !row.contextOnly).length} visible`}</span></div>
    <div className="editor-bone-nav-filters" role="group" aria-label="Filter bones">
      {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} disabled={item.id === "selected-branch" && !selectedBone} className={filter === item.id ? "is-active" : ""} onClick={() => changeFilter(item.id)}>{item.label}</button>)}
    </div>
    <div className="editor-bone-actions" aria-label="Hierarchy actions">
      <button type="button" title="Expand every branch" onClick={() => updateCollapsed(() => new Set())}>Expand all</button>
      <button type="button" title="Collapse every branch" onClick={() => updateCollapsed(() => new Set(parentBonePaths(treeBones)))}>Collapse all</button>
      <button type="button" title="Reveal the selected bone without changing search" disabled={!selectedBone} onClick={() => selectedPath && revealPath(selectedPath)}>Reveal selected</button>
      <button type="button" aria-pressed={selectedIsFavorite} title={selectedIsFavorite ? "Remove the selected bone from favorites" : "Add the selected bone to favorites"} disabled={!selectedBone} onClick={() => selectedPath && updatePreferences((current) => ({ ...current, favorites: toggleBoneFavorite(current.favorites, selectedPath) }))}>{selectedIsFavorite ? "★ Favorited" : "☆ Favorite"}</button>
    </div>
    {renderTargetChips("Favorites", availableFavorites, "favorite")}
    {renderTargetChips("Recent", availableRecent, "recent")}
    <label className="editor-bone-search" htmlFor={searchId}><span className="sr-only">Search bones by name or path</span><input id={searchId} className="editor-search" value={search} onChange={(event) => { setSearch(event.target.value); setPinnedPath(null); }} placeholder="Search bones…" /></label>
    {search.trim() && rows.length > 0 && <div className="editor-bone-search-hint">Matches highlighted · ancestors shown{pinnedPath ? " · revealed target kept visible" : ""}</div>}
    <div className="editor-bone-list" role="tree" aria-label="Rig hierarchy">
      {rows.map((row) => {
        const { bone } = row;
        const isCollapsed = !search.trim() && collapsed.has(bone.path);
        const selected = selectedPath === bone.path;
        const ancestor = selectedAncestors.has(bone.path);
        return <div key={bone.path} className={`editor-bone-row${selected ? " is-selected" : ""}${ancestor ? " is-selected-ancestor" : ""}${row.matches ? " is-match" : ""}${row.contextOnly ? " is-context-only" : ""}${pinnedPath === bone.path ? " is-pinned" : ""}`} role="treeitem" aria-label={bone.name} aria-level={row.depth + 1} aria-expanded={row.hasChildren ? !isCollapsed : undefined} aria-selected={selected}>
          {row.depth > 0 && <span className="editor-bone-guides" aria-hidden="true">
            {row.ancestorContinues.map((continues, index) => <i key={`${bone.path}-guide-${index}`} className={`editor-bone-guide${continues ? " is-continuing" : ""}`} />)}
            <i className={`editor-bone-guide is-branch${row.isLastSibling ? " is-last" : ""}`} />
          </span>}
          <button className="editor-bone-toggle" tabIndex={-1} disabled={!row.hasChildren} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${bone.name}`} aria-expanded={row.hasChildren ? !isCollapsed : undefined} onClick={() => toggleBranch(bone.path)}>{row.hasChildren ? isCollapsed ? <IconChevronRight /> : <IconChevronDown /> : <IconDot />}</button>
          <button ref={(element) => { if (element) rowRefs.current.set(bone.path, element); else rowRefs.current.delete(bone.path); }} className="editor-bone-item" tabIndex={rovingPath === bone.path ? 0 : -1} title={bone.path} onClick={() => selectPath(bone.path)} onKeyDown={(event) => onRowKeyDown(event, bone.path)}>
            <span className="editor-bone-name">{highlightedName(bone.name, row.matches ? search : "")}</span>
          </button>
        </div>;
      })}
      {rows.length === 0 && <p className="editor-muted editor-bone-empty">{filter === "interaction-targets" && interactionTargetPaths.length === 0 ? "No interaction targets are configured yet." : filter === "selected-branch" && !selectedBone ? "Select a bone to browse its branch." : search.trim() ? "No bones match this search and filter." : "No bones are visible in this filter."}</p>}
    </div>
  </section>;
}
