import { findInteractionProfile, type SpineInteractionAction } from "@ba-spine/spine-runtime/spine/spineInteraction";

export interface InteractionPhaseSuggestion {
  kind: "Pat" | "Touch" | "Pinch";
  startAnimation: string;
  followAnimation: string;
  endAnimation: string;
  faceStartAnimation: string;
  faceFollowAnimation: string;
  faceEndAnimation: string;
  reason: string;
}

function phaseSuggestion(kind: InteractionPhaseSuggestion["kind"], action: SpineInteractionAction, startAnimation: string): InteractionPhaseSuggestion {
  return {
    kind,
    startAnimation: action.start.main,
    followAnimation: action.follow.main,
    endAnimation: action.release?.main ?? "",
    faceStartAnimation: action.start.face ?? "",
    faceFollowAnimation: action.follow.face ?? "",
    faceEndAnimation: action.release?.face ?? "",
    reason: `The selected press animation exactly matches the ${kind.toLowerCase()} profile.`,
  };
}

export function suggestInteractionPhases(animations: readonly string[], startAnimation: string): InteractionPhaseSuggestion | null {
  if (!startAnimation) return null;
  const profile = findInteractionProfile([...animations]);
  const candidates = [
    { kind: "Pat" as const, action: profile.pat },
    { kind: "Touch" as const, action: profile.touch },
    { kind: "Pinch" as const, action: profile.pinch },
  ];
  const match = candidates.find(({ action }) => action?.start.main === startAnimation);
  return match?.action ? phaseSuggestion(match.kind, match.action, startAnimation) : null;
}
