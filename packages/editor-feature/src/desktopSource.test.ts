import { describe, expect, test } from "bun:test";
import { acknowledgeDesktopHandoff, DesktopSaveConflictError, publishDesktopDraft, receiveDesktopHandoffs, revokeDesktopDraft, sendDesktopHandoff, sourceFromDesktop } from "./desktopSource";

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
      await publishDesktopDraft({
        protocolVersion: 1,
        sessionId: "draft_session_01",
        library: { identity: "fixture", path: "/tmp/library" },
        lobbyId: "Airi_home",
        revision: 1,
        project: { assetDirectory: "Airi_home", interactions: [] },
      });
      await revokeDesktopDraft("draft_session_01");
      expect(calls.map((call) => call.path)).toEqual([
        "/__spine/companion/pending",
        "/__spine/companion/ack",
        "/__spine/companion/send",
        "/__spine/companion/draft-publish",
        "/__spine/companion/draft-revoke",
      ]);
      expect(calls.every((call) => call.token === "editor-token")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

test("submits complete saves with optimistic baselines and exposes reviewed conflicts", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: Array<{ path: string; body: unknown; token: string | null }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "save-token" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    requests.push({ path: url.pathname, body, token: new Headers(init?.headers).get("x-ba-spine-token") });
    if (url.pathname.endsWith("/save-batch") && requests.length === 1) {
      return Response.json({ error: "External changes detected", currentVersions: { ".editor/Airi_home.spine-project.json": "external-version" } }, { status: 409 });
    }
    return Response.json({ ok: true, backupPath: ".editor/backups/save-fixture.json" });
  }) as typeof fetch;
  try {
    const source = sourceFromDesktop("/tmp/library");
    const files = [{ path: ".editor/Airi_home.spine-project.json", content: "{}\n", expectedVersion: "baseline-version" }];
    let conflict: DesktopSaveConflictError | null = null;
    try { await source.saveBatch(files); }
    catch (error) { if (error instanceof DesktopSaveConflictError) conflict = error; else throw error; }
    expect(conflict?.currentVersions).toEqual({ ".editor/Airi_home.spine-project.json": "external-version" });
    expect(await source.saveBatch(files, conflict!.currentVersions)).toEqual({ backupPath: ".editor/backups/save-fixture.json" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ path: "/__spine/save-batch", token: "save-token", body: { files } });
    expect(requests[1]).toMatchObject({ body: { overwriteVersions: { ".editor/Airi_home.spine-project.json": "external-version" } } });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
