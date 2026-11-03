import "./interactionSummary.css";

export interface InteractionSummaryProps {
  name: string;
  trigger: string;
  color: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export function InteractionSummary({ name, trigger, color, enabled, onEnabledChange }: InteractionSummaryProps) {
  return <div className="editor-interaction-summary" aria-label="Selected interaction summary">
    <span className="editor-interaction-summary-swatch" style={{ backgroundColor: color }} aria-label={`Region color ${color}`} />
    <span className="editor-interaction-summary-copy">
      <strong title={name}>{name || "Unnamed interaction"}</strong>
      <small>{trigger} trigger <span aria-hidden="true">·</span> {color.toUpperCase()}</small>
    </span>
    <button type="button" className={`editor-interaction-enabled${enabled ? " is-enabled" : ""}`} aria-pressed={enabled} onClick={() => onEnabledChange(!enabled)}>
      <span aria-hidden="true" />{enabled ? "Enabled" : "Disabled"}
    </button>
  </div>;
}
