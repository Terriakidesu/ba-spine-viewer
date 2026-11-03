import { describe, expect, test } from "bun:test";
import { sourceFromDesktop } from "./desktopSource";

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
  test("loads indexed files through the authenticated read-only bridge", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const requested: Array<{ path: string; token: string | null }> = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BA_SPINE_HOST_TOKEN__: "test-token" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      requested.push({ path: `${url.pathname}${url.search}`, token: new Headers(init?.headers).get("x-ba-spine-token") });
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
      const files = await source.getSetFiles("Airi_home");
      expect(await files.get("Airi_home.atlas")?.text()).toBe("atlas data");
      expect((await source.getManifest?.("Airi_home"))?.manifest.id).toBe("Airi_home");
      expect("saveText" in source).toBe(false);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((request) => request.token === "test-token")).toBe(true);
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
});
