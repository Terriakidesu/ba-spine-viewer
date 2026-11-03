import { IconCheck, IconDot } from "@ba-spine/app-ui/icons";
import "./saveStatus.css";

export type EditorSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface SaveStatusProps {
  state: EditorSaveState;
  savedAt: number | null;
  hasProject: boolean;
}

export function SaveStatus({ state, savedAt, hasProject }: SaveStatusProps) {
  const label = state === "saving"
    ? "Saving…"
    : state === "dirty"
      ? "Unsaved changes"
      : state === "error"
        ? "Save failed"
        : state === "saved" && savedAt
          ? `Saved to disk · ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "No changes";

  return <div className="editor-save-status" aria-live="polite">
    <span className={`editor-save-state is-${state}`}>{state === "saved" ? <IconCheck /> : <IconDot />}{label}</span>
    {hasProject && <span className="editor-recovery-state" title="A local browser recovery copy is maintained after edits when storage is available. Save to root writes the project and linked subtitles to the selected asset root.">Local recovery</span>}
  </div>;
}
