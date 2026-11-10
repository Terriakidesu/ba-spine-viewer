/** Bound native decode/IO work; cancelled queued jobs never start. */
export function createResourceQueue(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid resource concurrency.");
  let active = 0;
  const waiting: Array<() => void> = [];
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      const start = () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) { abort(); return; }
        active++;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active--;
          waiting.shift()?.();
        });
      };
      if (signal?.aborted) { abort(); return; }
      if (active < concurrency) start();
      else {
        waiting.push(start);
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  };
}
