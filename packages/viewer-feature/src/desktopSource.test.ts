import { describe, expect, test } from "bun:test";
import { acknowledgeDesktopHandoff, getDesktopFullscreen, readDesktopDraftSnapshot, receiveDesktopHandoffs, sendDesktopHandoff, setDesktopFullscreen, sourceFromDesktop } from "./desktopSource";

const manifest = JSON.stringify({
  schemaVersion: 1,
  id: "Airi_home",
  entrySequence: null,
  skeleton: { scope: "lobby", path: "spine/Airi_home.skel" },
  atlas: { scope: "lobby", path: "spine/Airi_home.atlas" },
  assets: {
    Airi_home: {
      atlas: { scope: "lobby", path: "spine/Airi_home.atlas" },
      skeletons: [{ scope: "lobby", path: "spine/Airi_home.skel" }],
      pages: [{ scope: "lobby", path: "spine/Airi_home.png" }],
      files: [{ scope: "lobby", path: "spine/Airi_home.atlas" }],
    },
  },
});

describe("viewer desktop asset source", () => {
  test("reads and changes native fullscreen through the authenticated desktop bridge", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; method: string; token: string | null; body?: string }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "fullscreen-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("x-ba-spine-token"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Response.json({ fullScreen: true });
    }) as typeof fetch;

    try {
      expect(await getDesktopFullscreen()).toBe(true);
      await setDesktopFullscreen(false);
      expect(calls).toEqual([
        { path: "/__spine/window/fullscreen", method: "GET", token: "fullscreen-token" },
        { path: "/__spine/window/fullscreen", method: "POST", token: "fullscreen-token", body: JSON.stringify({ fullScreen: false }) },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("loads indexed files through the authenticated read-only bridge", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const requested: Array<{ path: string; token: string | null; signal: AbortSignal | null }> = [];
    const controller = new AbortController();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "test-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      requested.push({ path: `${url.pathname}${url.search}`, token: new Headers(init?.headers).get("x-ba-spine-token"), signal: init?.signal ?? null });
      if (url.pathname === "/__spine/catalog") {
        return Response.json({
          rootPath: "D:/fixture",
          sets: [{ directory: "Airi_home", path: "lobbies/Airi_home/manifest.json", files: ["lobbies/Airi_home/spine/Airi_home.atlas"] }],
        });
      }
      if (url.pathname === "/__spine/file") {
        const path = url.searchParams.get("path");
        if (path === "lobbies/Airi_home/manifest.json") return new Response(manifest);
        if (path === "lobbies/Airi_home/spine/Airi_home.atlas") return new Response("atlas data");
        return Response.json({ error: "File not found." }, { status: 404 });
      }
      return Response.json({ error: "Unexpected route." }, { status: 404 });
    }) as typeof fetch;

    try {
      const source = sourceFromDesktop("D:/fixture");
      expect(await source.getDirectories()).toEqual(["Airi_home"]);
      const files = await source.getSetFiles("Airi_home", controller.signal);
      expect(await files.get("Airi_home.atlas")?.text()).toBe("atlas data");
      expect((await source.getManifest?.("Airi_home"))?.manifest.id).toBe("Airi_home");
      expect("saveText" in source).toBe(false);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((request) => request.token === "test-token")).toBe(true);
      expect(requested.find((request) => request.path.includes("Airi_home.atlas"))?.signal).toBe(controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("treats missing local files as absent instead of failing the viewer", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "test-token" } });
    globalThis.fetch = (async () => Response.json({ error: "File not found." }, { status: 404 })) as unknown as typeof fetch;
    try {
      const source = sourceFromDesktop("D:/fixture");
      expect(await source.getFile("missing.json")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("uses the authenticated host bridge for fingerprinted thumbnail cache operations", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; method: string; rootPath: string | null; token: string | null; contentType: string | null; signal: AbortSignal | null }> = [];
    const controller = new AbortController();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "thumb-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        rootPath: url.searchParams.get("rootPath"),
        token: new Headers(init?.headers).get("x-ba-spine-token"),
        contentType: new Headers(init?.headers).get("content-type"),
        signal: init?.signal ?? null,
      });
      if (url.pathname.endsWith("/fingerprint")) return Response.json({ fingerprint: "sha256:fixture" });
      if (url.pathname === "/__spine/thumbnail" && (init?.method ?? "GET") === "GET") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const source = sourceFromDesktop("D:/fixture library");
      const fingerprint = await source.getThumbnailFingerprint("Airi_home", controller.signal);
      const image = await source.getThumbnail("Airi_home", fingerprint, controller.signal);
      expect(fingerprint).toBe("sha256:fixture");
      expect(image?.type).toBe("image/webp");
      await source.putThumbnail("Airi_home", fingerprint, new Blob([new Uint8Array([4, 5])], { type: "image/webp" }), controller.signal);
      await source.invalidateThumbnail("Airi_home", controller.signal);
      expect(calls.map((call) => [call.path, call.method])).toEqual([
        ["/__spine/thumbnail/fingerprint", "GET"],
        ["/__spine/thumbnail", "GET"],
        ["/__spine/thumbnail", "POST"],
        ["/__spine/thumbnail", "DELETE"],
      ]);
      expect(calls.every((call) => call.rootPath === "D:/fixture library" && call.token === "thumb-token")).toBe(true);
      expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
      expect(calls[2]?.contentType).toBe("image/webp");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("reports watched library revisions and refreshes the desktop catalog", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; method: string; rootPath: string | null; token: string | null; signal: AbortSignal | null }> = [];
    const controller = new AbortController();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "refresh-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        rootPath: url.searchParams.get("rootPath"),
        token: new Headers(init?.headers).get("x-ba-spine-token"),
        signal: init?.signal ?? null,
      });
      if (url.pathname === "/__spine/changes") return Response.json({ revision: 7, watching: true });
      if (url.pathname === "/__spine/refresh") return Response.json({ revision: 8 });
      if (url.pathname === "/__spine/catalog") return Response.json({ rootPath: "D:/fixture", sets: [{ directory: "Airi_home", path: "lobbies/Airi_home" }] });
      return Response.json({ error: "Unexpected route." }, { status: 404 });
    }) as typeof fetch;
    try {
      const source = sourceFromDesktop("D:/fixture");
      expect(await source.getLibraryChangeState(controller.signal)).toEqual({ revision: 7, watching: true });
      const refreshedSource = await source.refreshLibrary(controller.signal);
      expect(await refreshedSource.getDirectories()).toEqual(["Airi_home"]);
      expect(calls.map(({ path, method }) => [path, method])).toEqual([
        ["/__spine/changes", "GET"],
        ["/__spine/refresh", "POST"],
        ["/__spine/catalog", "GET"],
      ]);
      expect(calls.every((call) => call.rootPath === "D:/fixture" && call.token === "refresh-token")).toBe(true);
      expect(calls.slice(0, 2).every((call) => call.signal === controller.signal)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("polls, acknowledges, and sends handoffs through the authenticated host API", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; method: string; token: string | null; body?: unknown }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "test-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("x-ba-spine-token"),
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });
      return url.pathname.endsWith("/pending")
        ? Response.json({ messages: [{
            protocolVersion: 1,
            requestId: "req_00000003",
            targetApp: "viewer",
            library: { identity: "fixture", path: "D:\\fixture" },
            lobbyId: "Airi_home",
            sequenceId: "opening",
          }] })
        : Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const messages = await receiveDesktopHandoffs();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.lobbyId).toBe("Airi_home");
      await acknowledgeDesktopHandoff("req_00000003");
      await sendDesktopHandoff({
        protocolVersion: 1,
        requestId: "req_00000004",
        targetApp: "editor",
        library: { identity: "fixture", path: "D:\\fixture" },
        lobbyId: "Airi_home",
      });
      expect(calls.map(({ path, method }) => [path, method])).toEqual([
        ["/__spine/companion/pending", "GET"],
        ["/__spine/companion/ack", "POST"],
        ["/__spine/companion/send", "POST"],
      ]);
      expect(calls.every((call) => call.token === "test-token")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("reads and validates an unsaved draft through the authenticated Viewer host", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const calls: Array<{ path: string; token: string | null }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "test-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      calls.push({ path: `${url.pathname}${url.search}`, token: new Headers(init?.headers).get("x-ba-spine-token") });
      return Response.json({ snapshot: {
        protocolVersion: 1,
        sessionId: "draft_session_04",
        library: { identity: "fixture", path: "D:/fixture" },
        lobbyId: "Airi_home",
        revision: 3,
        project: { assetDirectory: "Airi_home", interactions: [], timeline: { sequenceId: "opening" } },
      } });
    }) as typeof fetch;
    try {
      const snapshot = await readDesktopDraftSnapshot("draft_session_04");
      expect(snapshot?.revision).toBe(3);
      expect(calls).toEqual([{ path: "/__spine/companion/draft-read?sessionId=draft_session_04", token: "test-token" }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
