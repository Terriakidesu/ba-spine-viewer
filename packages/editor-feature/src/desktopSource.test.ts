import { describe, expect, test } from "bun:test";
import { acknowledgeDesktopHandoff, receiveDesktopHandoffs, sendDesktopHandoff } from "./desktopSource";

describe("editor desktop companion adapter", () => {
  test("uses the authenticated host APIs for receiving and sending handoffs", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; token: string | null }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "editor-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      calls.push({ path: url.pathname, token: new Headers(init?.headers).get("x-ba-spine-token") });
      return url.pathname.endsWith("/pending")
        ? Response.json({ messages: [{
            protocolVersion: 1,
            requestId: "req_00000005",
            targetApp: "editor",
            library: { identity: "fixture", path: "/tmp/library" },
            lobbyId: "Airi_home",
            sequenceId: "opening",
          }] })
        : Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      const messages = await receiveDesktopHandoffs();
      expect(messages.map((message) => message.requestId)).toEqual(["req_00000005"]);
      await acknowledgeDesktopHandoff("req_00000005");
      await sendDesktopHandoff({
        protocolVersion: 1,
        requestId: "req_00000006",
        targetApp: "viewer",
        library: { identity: "fixture", path: "/tmp/library" },
        lobbyId: "Airi_home",
      });
      expect(calls.map((call) => call.path)).toEqual([
        "/__spine/companion/pending",
        "/__spine/companion/ack",
        "/__spine/companion/send",
      ]);
      expect(calls.every((call) => call.token === "editor-token")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
