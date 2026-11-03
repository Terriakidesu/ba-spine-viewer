import { BlendMode, type Skeleton } from "@esotericsoftware/spine-core";

// A viewing preference, not a claim to reproduce Unity's material settings.
export const DEFAULT_EFFECTS_STRENGTH = 0.5;

/** Attenuate light contributions only while drawing, never the animation pose. */
export function drawWithEffectsStrength(skeleton: Skeleton, strength: number, draw: () => void): void {
  const amount = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : DEFAULT_EFFECTS_STRENGTH;
  const effects = skeleton.slots.filter((slot) => slot.data.blendMode === BlendMode.Additive || slot.data.blendMode === BlendMode.Screen);
  const alphas = effects.map((slot) => slot.color.a);
  try {
    for (let i = 0; i < effects.length; i += 1) effects[i]!.color.a = alphas[i]! * amount;
    // Spine's PMA renderer premultiplies tint RGB by slot alpha, including its
    // zero-alpha additive batching path. Scaling alpha here scales the light
    // contribution too, unlike lowering canvas opacity or skeleton brightness.
    draw();
  } finally {
    for (let i = 0; i < effects.length; i += 1) effects[i]!.color.a = alphas[i]!;
  }
}
