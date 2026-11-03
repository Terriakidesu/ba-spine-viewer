export type ProjectSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Prevent replacing an in-flight or failed save; dirty projects require consent. */
export async function confirmProjectReplacement(
  saveState: ProjectSaveState,
  confirmDiscard: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (saveState === "saving" || saveState === "error") return false;
  if (saveState !== "dirty") return true;
  return Boolean(await confirmDiscard());
}
