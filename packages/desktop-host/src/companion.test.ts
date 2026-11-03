import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPANION_HANDOFF_PATH,
  CompanionInbox,
  CompanionUnavailableError,
  registerCompanionEndpoint,
  sendCompanionHandoff,
} from "./companion";

const message = {
  protocolVersion: 1,
  requestId: "req_00000001",
  targetApp: "viewer",
  library: { identity: "fixture-library", path: "D:\\fixtures\\library" },
  lobbyId: "Airi_home",
  sequenceId: "opening",
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
      const inbox = new CompanionInbox("viewer", token);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => inbox.handle(request) });
      if (server.port === undefined) throw new Error("Test companion server failed to bind.");
      const registration = await registerCompanionEndpoint("viewer", server.port, { directory, token });
      try {
        await sendCompanionHandoff(message, { directory });
        await sendCompanionHandoff(message, { directory });
        expect(inbox.pending()).toEqual([message]);
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

  test("reports an unavailable target and preserves a replacement registration on close", async () => {
    await withRegistry(async (directory) => {
      await expect(sendCompanionHandoff(message, { directory })).rejects.toBeInstanceOf(CompanionUnavailableError);
      const first = await registerCompanionEndpoint("viewer", 43121, { directory, token: "c".repeat(64) });
      const second = await registerCompanionEndpoint("viewer", 43122, { directory, token: "d".repeat(64) });
      first.close();
      const endpoint = JSON.parse(await readFile(join(directory, "viewer.json"), "utf8")) as { port: number; token: string };
      expect(endpoint).toEqual(expect.objectContaining({ port: 43122, token: "d".repeat(64) }));
      second.close();
    });
  });
});
