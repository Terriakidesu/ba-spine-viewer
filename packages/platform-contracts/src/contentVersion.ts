/** Stable, browser-safe content version used for optimistic Editor saves. */
export function contentVersion(content: string | null): string {
  if (content === null) return "missing";
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(content)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
