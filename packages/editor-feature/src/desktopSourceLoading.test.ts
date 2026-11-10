import { afterEach, expect, test } from "bun:test";
import { sourceFromDesktop } from "./desktopSource";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("desktop file loading forwards cancellation and bounds outstanding reads", async () => {
  let active = 0, peak = 0, calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        active--;
        reject(init.signal?.reason);
      }, { once: true });
    });
  }) as typeof fetch;
  const source = sourceFromDesktop("fixture");
  const controller = new AbortController();
  const results = Promise.allSettled(Array.from({ length: 12 }, (_, index) => source.getFile(`${index}.png`, controller.signal)));
  await Promise.resolve();
  expect(calls).toBe(4);
  controller.abort();
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect(peak).toBe(4);
  expect(calls).toBe(4);
  expect(active).toBe(0);
});

test("cancelled asset-set loads do not request texture files", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    requested.push(String(url));
    return Response.json({ sets: [{ directory: "fixture", path: "fixture", files: ["fixture/page.png"] }] });
  }) as typeof fetch;
  const source = sourceFromDesktop("fixture");
  const controller = new AbortController();
  controller.abort();
  await expect(source.getSetFiles("fixture", controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(requested).toEqual([]);
});
