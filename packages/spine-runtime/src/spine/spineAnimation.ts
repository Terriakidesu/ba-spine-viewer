/** Prefer the normal idle, then accommodate older/variant lobby exports. */
export function findIdleAnimation(animations: string[]): string | null {
  const interactionClip = /(?:^|[_ -])(?:look(?:end)?|talk|pat|pinch|touch|interact(?:ion)?|reaction|react|greet)(?:[_ -]|$)/i;
  const isIdle = (name: string) => /^idle(?:[_ -].*)?$/i.test(name) && !interactionClip.test(name);
  for (const preferred of ["Idle_01", "Idle", "Idle_1"]) {
    const found = animations.find((name) => name.toLocaleLowerCase() === preferred.toLocaleLowerCase() && isIdle(name));
    if (found) return found;
  }
  return animations.find(isIdle) ?? null;
}
