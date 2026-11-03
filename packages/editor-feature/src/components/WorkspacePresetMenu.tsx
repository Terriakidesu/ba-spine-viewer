import { IconChevronDown, IconExpand, IconSliders } from "@ba-spine/app-ui/icons";
import type { WorkspaceLayoutPreset } from "../editorLayout";
import "./workspacePresetMenu.css";

export interface WorkspacePresetMenuProps {
  selected: WorkspaceLayoutPreset;
  timelineDisabled?: boolean;
  onSelect: (preset: Exclude<WorkspaceLayoutPreset, "custom">) => void;
}

const options = [
  { id: "balanced", label: "Balanced", detail: "Show navigation, canvas, and inspector", icon: IconSliders },
  { id: "canvas-focus", label: "Canvas focus", detail: "Hide both side panels", icon: IconExpand },
  { id: "timeline-focus", label: "Timeline focus", detail: "Open the sequence timeline", icon: IconChevronDown },
] as const;

export function WorkspacePresetMenu({ selected, timelineDisabled = false, onSelect }: WorkspacePresetMenuProps) {
  return <details className="editor-layout-menu">
    <summary className="editor-button" title="Choose a workspace layout"><IconExpand /> Layout <IconChevronDown /></summary>
    <div className="editor-layout-menu-popover" role="group" aria-label="Workspace layout presets">
      {options.map(({ id, label, detail, icon: Icon }) => <button type="button" key={id} className={`editor-layout-preset${selected === id ? " is-selected" : ""}`} aria-pressed={selected === id} disabled={id === "timeline-focus" && timelineDisabled} title={detail} onClick={(event) => {
        onSelect(id);
        const details = event.currentTarget.closest("details");
        if (details) details.open = false;
      }}>
        <span className="editor-layout-preset-icon"><Icon /></span>
        <span><strong>{label}</strong><small>{detail}</small></span>
        {selected === id && <span className="editor-layout-preset-current">Current</span>}
      </button>)}
    </div>
  </details>;
}
