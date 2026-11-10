import { describe, expect, test } from "bun:test";
import { openDesktopVideoFolder } from "./desktopSource";

describe("Viewer desktop video export actions", () => {
  test("opens the last exported folder through the authenticated native bridge", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; method: string; token: string | null }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "video-folder-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("x-ba-spine-token"),
      });
      return Response.json({ opened: true });
    }) as typeof fetch;

    try {
      await openDesktopVideoFolder();
      expect(calls).toEqual([{
        path: "/__spine/video/open-folder",
        method: "POST",
        token: "video-folder-token",
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
