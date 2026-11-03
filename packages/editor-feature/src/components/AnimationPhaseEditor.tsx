import { NumberField } from "./NumberField";
import { AnimationPicker } from "../AnimationPicker";
import type { AnimationPickerOption } from "../animationPickerModel";
import "./animationPhaseEditor.css";

export type AnimationPhaseField = "startAnimation" | "followAnimation" | "endAnimation" | "faceStartAnimation" | "faceFollowAnimation" | "faceEndAnimation";
export type AnimationMixField = "startMixDuration" | "followMixDuration" | "releaseMixDuration";

interface PhaseValue {
  key: "press" | "hold" | "release";
  title: string;
  animationField: AnimationPhaseField;
  faceField: AnimationPhaseField;
  mixField: AnimationMixField;
  body: string;
  face: string;
  loop: boolean;
  activePhase: string;
}

export interface AnimationPhaseEditorProps {
  animations: readonly string[];
  press: string;
  hold: string;
  release: string;
  facePress: string;
  faceHold: string;
  faceRelease: string;
  mixPress: number;
  mixHold: number;
  mixRelease: number;
  activePhase: string;
  disabled?: boolean;
  onAnimationChange: (field: AnimationPhaseField, value: string) => void;
  onMixChange: (field: AnimationMixField, value: number) => void;
  onPreview: (title: string, body: string, face: string, loop: boolean) => void;
}

export function AnimationPhaseEditor({ animations, press, hold, release, facePress, faceHold, faceRelease, mixPress, mixHold, mixRelease, activePhase, disabled = false, onAnimationChange, onMixChange, onPreview }: AnimationPhaseEditorProps) {
  const phases: PhaseValue[] = [
    { key: "press", title: "Press", animationField: "startAnimation", faceField: "faceStartAnimation", mixField: "startMixDuration", body: press, face: facePress, loop: false, activePhase: "starting" },
    { key: "hold", title: "Hold", animationField: "followAnimation", faceField: "faceFollowAnimation", mixField: "followMixDuration", body: hold, face: faceHold, loop: true, activePhase: "holding" },
    { key: "release", title: "Release", animationField: "endAnimation", faceField: "faceEndAnimation", mixField: "releaseMixDuration", body: release, face: faceRelease, loop: false, activePhase: "releasing" },
  ];
  const mixByField: Record<AnimationMixField, number> = { startMixDuration: mixPress, followMixDuration: mixHold, releaseMixDuration: mixRelease };
  const animationOptions: AnimationPickerOption[] = [
    { value: "", label: "None" },
    ...animations.map((animation) => ({ value: animation, label: animation })),
  ];

  return <div className="editor-phase-editor" aria-label="Press, hold, and release animation phases">
    {phases.map((phase, index) => {
      const bodyMissing = phase.body !== "" && !animations.includes(phase.body);
      const faceMissing = phase.face !== "" && !animations.includes(phase.face);
      return <article className={`editor-phase-editor-card${activePhase === phase.activePhase ? " is-active" : ""}`} key={phase.key}>
        <header className="editor-phase-editor-heading">
          <span className="editor-phase-number">0{index + 1}</span>
          <span><strong>{phase.title}</strong><small>{phase.loop ? "Loops while held" : "Plays once"}</small></span>
          <button type="button" className="editor-preview-button" disabled={disabled || (!phase.body && !phase.face)} onClick={() => onPreview(phase.title, phase.body, phase.face, phase.loop)}>Preview</button>
        </header>
        <div className="editor-two-fields editor-phase-animation-fields">
          <div className="editor-animation-field"><span>Body animation</span>{bodyMissing && <small className="editor-phase-missing">Missing from rig</small>}<AnimationPicker disabled={disabled} ariaLabel={`${phase.title} body animation${bodyMissing ? ", missing from rig" : ""}`} value={phase.body} options={animationOptions} onChange={(value) => onAnimationChange(phase.animationField, value)} /></div>
          <div className="editor-animation-field"><span>Face animation</span>{faceMissing && <small className="editor-phase-missing">Missing from rig</small>}<AnimationPicker disabled={disabled} ariaLabel={`${phase.title} face animation${faceMissing ? ", missing from rig" : ""}`} value={phase.face} options={animationOptions} onChange={(value) => onAnimationChange(phase.faceField, value)} /></div>
        </div>
        <NumberField label="Blend duration" value={mixByField[phase.mixField]} min={0} max={2} step={0.05} unit="s" disabled={disabled} scrub={false} onCommit={(value) => onMixChange(phase.mixField, value)} />
      </article>;
    })}
  </div>;
}
