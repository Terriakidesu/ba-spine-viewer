/** Share one idempotent cleanup between native window close and process exit. */
export function onceDesktopHostShutdown(cleanup: () => void): () => void {
  let shutDown = false;
  return () => {
    if (shutDown) return;
    shutDown = true;
    cleanup();
  };
}
