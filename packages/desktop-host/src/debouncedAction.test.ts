import { describe, expect, test } from "bun:test";
import { createDebouncedAction } from "./debouncedAction";

class FakeTimers {
  private nextId = 0;
  private now = 0;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  readonly api = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = ++this.nextId;
      this.tasks.set(id, { dueAt: this.now + delayMs, callback });
      return id;
    },
    clearTimeout: (id: number) => { this.tasks.delete(id); },
  };

  advance(milliseconds: number) {
    const until = this.now + milliseconds;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= until)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].dueAt;
      due[1].callback();
    }
    this.now = until;
  }
}

describe("debounced filesystem change action", () => {
  test("coalesces a burst until the quiet interval elapses", () => {
    const timers = new FakeTimers();
    let calls = 0;
    const action = createDebouncedAction(300, () => calls++, timers.api);
    action.schedule();
    timers.advance(200);
    action.schedule();
    timers.advance(299);
    expect(calls).toBe(0);
    timers.advance(1);
    expect(calls).toBe(1);
  });

  test("cancel prevents a pending action after a library switch", () => {
    const timers = new FakeTimers();
    let calls = 0;
    const action = createDebouncedAction(300, () => calls++, timers.api);
    action.schedule();
    action.cancel();
    timers.advance(1000);
    expect(calls).toBe(0);
  });
});
