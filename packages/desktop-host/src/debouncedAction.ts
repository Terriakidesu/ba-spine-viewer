interface TimerApi<Handle> {
  setTimeout(callback: () => void, delayMs: number): Handle;
  clearTimeout(handle: Handle): void;
}

const systemTimers: TimerApi<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Schedule one action after a quiet period; later events restart the delay. */
export function createDebouncedAction<Handle = ReturnType<typeof setTimeout>>(
  delayMs: number,
  action: () => void,
  timers: TimerApi<Handle> = systemTimers as TimerApi<Handle>,
) {
  let timer: Handle | null = null;
  return {
    schedule() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = null;
        action();
      }, Math.max(0, delayMs));
    },
    cancel() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
