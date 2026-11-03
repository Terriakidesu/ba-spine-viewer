import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPANION_ACTIVATE_PATH,
  COMPANION_DRAFT_PATH,
  COMPANION_HANDOFF_PATH,
  CompanionAlreadyRunningError,
  CompanionInbox,
  CompanionUnavailableError,
  readCompanionDraftSnapshot,
  readCompanionLaunchPlan,
  registerCompanionEndpoint,
  sendCompanionHandoff,
  writeCompanionLaunchPlan,
} from "./companion";

const message = {
  protocolVersion: 1,
  requestId: "req_00000001",
  targetApp: "viewer",
  library: { identity: "fixture-library", path: "D:\\fixtures\\library" },
  lobbyId: "Airi_home",
  sequenceId: "opening",
} as const;

const editorMessage = {
  ...message,
  requestId: "req_00000002",
  targetApp: "editor",
} as const;

async function withRegistry<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ba-spine-companion-test-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("authenticated local companion transport", () => {
  test("registers and delivers a validated handoff over loopback exactly once", async () => {
    await withRegistry(async (directory) => {
      const token = "a".repeat(64);
      let activations = 0;
      const inbox = new CompanionInbox("viewer", token, () => { activations += 1; });
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => inbox.handle(request) });
      if (server.port === undefined) throw new Error("Test companion server failed to bind.");
      const registration = await registerCompanionEndpoint("viewer", server.port, { directory, token });
      try {
        await sendCompanionHandoff(message, { directory });
        await sendCompanionHandoff(message, { directory });
        expect(inbox.pending()).toEqual([message]);
        expect(activations).toBe(2);
        expect(inbox.acknowledge([message.requestId])).toBe(1);
        expect(inbox.pending()).toEqual([]);

        const endpoint = JSON.parse(await readFile(join(directory, "viewer.json"), "utf8")) as { port: number; token: string };
        expect(endpoint).toEqual(expect.objectContaining({ port: server.port, token }));
      } finally {
        registration.close();
        server.stop(true);
      }
      await expect(readFile(join(directory, "viewer.json"), "utf8")).rejects.toThrow();
    });
  });

  test("serves volatile Editor drafts only to authenticated requests and revokes stale sessions", async () => {
    await withRegistry(async (directory) => {
      const token = "7".repeat(64);
      const snapshot = {
        protocolVersion: 1,
        sessionId: "draft_session_02",
        library: { identity: "fixture-library", path: "D:\\fixtures\\library" },
        lobbyId: "Airi_home",
        revision: 1,
        project: { assetDirectory: "Airi_home", interactions: [], timeline: { sequenceId: "opening" } },
      } as const;
      const inbox = new CompanionInbox("editor", token);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => inbox.handle(request) });
      let registration: Awaited<ReturnType<typeof registerCompanionEndpoint>> | undefined;
      try {
        if (server.port === undefined) throw new Error("Test companion server failed to bind.");
        registration = await registerCompanionEndpoint("editor", server.port, { directory, token });
        inbox.publishDraft(snapshot);
        const response = await fetch(`http://127.0.0.1:${server.port}${COMPANION_DRAFT_PATH}?sessionId=${snapshot.sessionId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(snapshot);
        const unauthorized = await fetch(`http://127.0.0.1:${server.port}${COMPANION_DRAFT_PATH}?sessionId=${snapshot.sessionId}`);
        expect(unauthorized.status).toBe(403);
        expect(await readCompanionDraftSnapshot(snapshot.sessionId, { directory })).toEqual(snapshot);
        expect(inbox.revokeDraft(snapshot.sessionId)).toBe(true);
        expect(await readCompanionDraftSnapshot(snapshot.sessionId, { directory })).toBeNull();
      } finally {
        registration?.close();
        server.stop(true);
      }
    });
  });

  test("keeps draft revisions monotonic and binds a session to one library and lobby", () => {
    const inbox = new CompanionInbox("editor", "8".repeat(64));
    const snapshot = {
      protocolVersion: 1,
      sessionId: "draft_session_03",
      library: { identity: "fixture-library", path: "D:\\fixtures\\library" },
      lobbyId: "Airi_home",
      revision: 2,
      project: { timeline: { duration: 12 } },
    } as const;
    inbox.publishDraft(snapshot);
    expect(inbox.publishDraft({ ...snapshot, revision: 1, project: { timeline: { duration: 3 } } })).toEqual(snapshot);
    expect(() => inbox.publishDraft({ ...snapshot, revision: 3, lobbyId: "Hina_home" })).toThrow();
    expect(inbox.publishDraft({ ...snapshot, revision: 3, project: { timeline: { duration: 13 } } }).revision).toBe(3);
  });

  test("rejects unauthorized, wrong-target, malformed, and oversized requests", async () => {
    const inbox = new CompanionInbox("editor", "b".repeat(64));
    const endpoint = `http://127.0.0.1/__spine/companion/handoff`;
    const send = (body: string, authorization = `Bearer ${"b".repeat(64)}`, contentLength?: string) => inbox.handle(new Request(endpoint, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", ...(contentLength ? { "content-length": contentLength } : {}) },
      body,
    }));

    expect((await send(JSON.stringify({ ...message, targetApp: "editor" }), "Bearer wrong-token")).status).toBe(403);
    expect((await send(JSON.stringify(message))).status).toBe(409);
    expect((await send("{" )).status).toBe(400);
    expect((await send(" ".repeat(128 * 1024 + 1))).status).toBe(413);
    expect((await send(" ".repeat(128 * 1024 + 1), `Bearer ${"b".repeat(64)}`, "1")).status).toBe(413);
    expect(inbox.pending()).toEqual([]);
    expect(COMPANION_HANDOFF_PATH).toBe("/__spine/companion/handoff");
  });

  test("accepts editor-targeted handoffs in the editor inbox", async () => {
    const token = "e".repeat(64);
    const inbox = new CompanionInbox("editor", token);
    const response = await inbox.handle(new Request(`http://127.0.0.1${COMPANION_HANDOFF_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...message, requestId: "req_00000007", targetApp: "editor" }),
    }));
    expect(response.status).toBe(202);
    expect(inbox.pending().map((item) => item.targetApp)).toEqual(["editor"]);
  });

  test("activates a live instance and refuses a duplicate registration", async () => {
    await withRegistry(async (directory) => {
      let activations = 0;
      const token = "c".repeat(64);
      const inbox = new CompanionInbox("viewer", token, () => { activations += 1; });
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => inbox.handle(request) });
      if (server.port === undefined) throw new Error("Test companion server failed to bind.");
      const first = await registerCompanionEndpoint("viewer", server.port, { directory, token });
      try {
        await expect(registerCompanionEndpoint("viewer", server.port, { directory, token: "d".repeat(64) }))
          .rejects.toBeInstanceOf(CompanionAlreadyRunningError);
        expect(activations).toBe(1);
      } finally {
        first.close();
        server.stop(true);
      }
      await expect(sendCompanionHandoff(message, { directory })).rejects.toBeInstanceOf(CompanionUnavailableError);
    });
  });

  test("requires the session token to activate a window", async () => {
    let activations = 0;
    const token = "f".repeat(64);
    const inbox = new CompanionInbox("editor", token, () => { activations += 1; });
    const url = `http://127.0.0.1${COMPANION_ACTIVATE_PATH}`;
    const unauthenticated = await inbox.handle(new Request(url, { method: "POST" }));
    const authenticated = await inbox.handle(new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(unauthenticated.status).toBe(403);
    expect(authenticated.status).toBe(200);
    expect(activations).toBe(1);
  });

  test("reports an unavailable target when no instance has registered", async () => {
    await withRegistry(async (directory) => {
      await expect(sendCompanionHandoff(message, { directory })).rejects.toBeInstanceOf(CompanionUnavailableError);
      const endpoint = join(directory, "viewer.json");
      await expect(readFile(endpoint, "utf8")).rejects.toThrow();
    });
  });

  test("persists a validated launch plan after an app exits", async () => {
    await withRegistry(async (directory) => {
      const plan = { command: "bun", args: ["run", "dev:viewer"], cwd: "C:\\workspace" };
      await writeCompanionLaunchPlan("viewer", plan, directory);
      expect(await readCompanionLaunchPlan("viewer", directory)).toEqual(plan);
      await expect(writeCompanionLaunchPlan("viewer", { command: "cmd.exe & whoami", args: [] }, directory)).rejects.toThrow();
      expect(await readCompanionLaunchPlan("viewer", directory)).toEqual(plan);
    });
  });

  test("launches a missing target, waits for its registration, then delivers and focuses", async () => {
    await withRegistry(async (directory) => {
      let focused = 0;
      let server: ReturnType<typeof Bun.serve> | undefined;
      let registration: Awaited<ReturnType<typeof registerCompanionEndpoint>> | undefined;
      const token = "6".repeat(64);
      const inbox = new CompanionInbox("editor", token, () => { focused += 1; });
      const plan = { command: "fixture-editor-launcher", args: [] };
      let launches = 0;
      try {
        await sendCompanionHandoff(editorMessage, {
          directory,
          autoLaunch: {
            resolvePlan: (target) => {
              expect(target).toBe("editor");
              return plan;
            },
            launch: async (target, discoveredPlan) => {
              expect(target).toBe("editor");
              expect(discoveredPlan).toEqual(plan);
              launches += 1;
              server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => inbox.handle(request) });
              if (server.port === undefined) throw new Error("Test companion server failed to bind.");
              registration = await registerCompanionEndpoint("editor", server.port, {
                directory,
                token,
                launchPlan: plan,
              });
            },
            timeoutMs: 1_000,
            pollIntervalMs: 5,
          },
        });
        expect(launches).toBe(1);
        expect(inbox.pending()).toEqual([editorMessage]);
        expect(focused).toBe(1);
      } finally {
        registration?.close();
        server?.stop(true);
      }
    });
  });

  test("uses the saved launch plan instead of asking discovery again", async () => {
    await withRegistry(async (directory) => {
      const plan = { command: "fixture-editor-launcher", args: [] };
      await writeCompanionLaunchPlan("viewer", plan, directory);
      let launches = 0;
      await expect(sendCompanionHandoff(message, {
        directory,
        autoLaunch: {
          resolvePlan: () => { throw new Error("persisted plan should win"); },
          launch: async (_target, actual) => {
            expect(actual).toEqual(plan);
            launches += 1;
          },
          timeoutMs: 30,
          pollIntervalMs: 5,
        },
      })).rejects.toBeInstanceOf(CompanionUnavailableError);
      expect(launches).toBe(1);
    });
  });

  test("removes its lock and endpoint on close", async () => {
    await withRegistry(async (directory) => {
      const registration = await registerCompanionEndpoint("viewer", 43121, { directory, token: "e".repeat(64) });
      registration.close();
      await expect(readFile(join(directory, "viewer.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(directory, "viewer.lock"), "utf8")).rejects.toThrow();
    });
  });

  test("releases the owned lock if the endpoint disappeared before close", async () => {
    await withRegistry(async (directory) => {
      const registration = await registerCompanionEndpoint("viewer", 43122, { directory, token: "7".repeat(64) });
      await unlink(join(directory, "viewer.json"));
      registration.close();
      await expect(readFile(join(directory, "viewer.lock"), "utf8")).rejects.toThrow();
    });
  });

  test("reclaims a stale lock left by a crashed process", async () => {
    await withRegistry(async (directory) => {
      const stale = { protocolVersion: 1, app: "viewer", token: "9".repeat(64), pid: 2_147_483_647 };
      await writeFile(join(directory, "viewer.lock"), JSON.stringify(stale));
      await writeFile(join(directory, "viewer.json"), JSON.stringify({ ...stale, port: 43120 }));
      const registration = await registerCompanionEndpoint("viewer", 43121, { directory, token: "8".repeat(64) });
      try {
        const endpoint = JSON.parse(await readFile(join(directory, "viewer.json"), "utf8")) as { port: number; token: string };
        expect(endpoint).toEqual(expect.objectContaining({ port: 43121, token: "8".repeat(64) }));
      } finally {
        registration.close();
      }
    });
  });
});
