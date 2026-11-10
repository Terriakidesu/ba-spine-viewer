import { expect, test } from "bun:test";
import { createResourceQueue } from "./resourceQueue";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("bounds active work and drains queued tasks", async () => {
  const run = createResourceQueue(2);
  const gate = deferred();
  let active = 0, peak = 0, finished = 0;
  const jobs = Array.from({ length: 8 }, () => run(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate.promise;
    active--;
    finished++;
  }));
  await Promise.resolve();
  expect(active).toBe(2);
  gate.release();
  await Promise.all(jobs);
  expect(peak).toBe(2);
  expect(finished).toBe(8);
});

test("cancelled queued work rejects promptly without starting", async () => {
  const run = createResourceQueue(1);
  const gate = deferred();
  const first = run(() => gate.promise);
  const controller = new AbortController();
  let started = false;
  const cancelled = run(async () => { started = true; }, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toHaveProperty("name", "AbortError");
  expect(started).toBe(false);
  const next = run(async () => 42);
  gate.release();
  await first;
  expect(await next).toBe(42);
  expect(started).toBe(false);
});

test("already cancelled requests never run", async () => {
  const run = createResourceQueue(1);
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await expect(run(async () => { started = true; }, controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(started).toBe(false);
});

test("failed jobs release their slot", async () => {
  const run = createResourceQueue(1);
  const failed = run(async () => { throw new Error("decode failed"); });
  const next = run(async () => 42);
  await expect(failed).rejects.toThrow("decode failed");
  expect(await next).toBe(42);
});

test("cancelling active non-abortable work does not release its slot early", async () => {
  const run = createResourceQueue(1);
  const gate = deferred();
  const controller = new AbortController();
  const first = run(() => gate.promise, controller.signal);
  await Promise.resolve();
  controller.abort();
  let started = false;
  const next = run(async () => { started = true; });
  await Promise.resolve();
  expect(started).toBe(false);
  gate.release();
  await Promise.all([first, next]);
  expect(started).toBe(true);
});

test("rejects invalid concurrency", () => {
  expect(() => createResourceQueue(0)).toThrow();
  expect(() => createResourceQueue(1.5)).toThrow();
});
