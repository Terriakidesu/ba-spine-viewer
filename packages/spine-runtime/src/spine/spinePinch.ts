/** Lobby rigs use sided chin controls, numbered cheek pairs, or a cheek chain. */
export function cheekControlNames(bones: ReadonlyArray<{ name: string; parentName: string | null }>): string[] {
  const side = (name: string) => {
    const match = name.match(/^(?:(left|right|l|r)[ _-]?(?:chin|cheek)|(?:chin|cheek)[ _-](left|right|l|r))(?:[ _-].*)?$/i);
    const value = match?.[1] ?? match?.[2];
    return value ? (/^(?:l|left)$/i.test(value) ? "left" : "right") : null;
  };
  const sided = new Map<string, string>();
  const score = (name: string) => /(?:rot|root|control|ctrl|pos|point)/i.test(name) ? 2 : 1;
  for (const bone of bones) {
    const key = side(bone.name);
    if (key && (!sided.has(key) || score(bone.name) > score(sided.get(key)!))) sided.set(key, bone.name);
  }
  if (sided.size) return [sided.get("left"), sided.get("right")].filter((name): name is string => Boolean(name));
  const numbered = bones.filter((bone) => /^cheek(?:[ _-]?\d+)?$/i.test(bone.name));
  // A child cheek is part of its parent's deformation chain, not another side.
  return numbered.filter((bone) => !numbered.some((parent) => parent.name === bone.parentName)).map((bone) => bone.name);
}
