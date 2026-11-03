import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SpineEditorMcpBridge } from "./mcpBridge";

const bridgeUrl = new URL("http://127.0.0.1:43210");

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, bridgeUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Spine editor MCP bridge", () => {
  test("publishes a private connection file and requires its token", async () => {
    const bridge = new SpineEditorMcpBridge(true);
    const connectionFile = await bridge.start(43210);
    expect(connectionFile).not.toBeNull();
    try {
      const info = JSON.parse(await readFile(connectionFile!, "utf8")) as { version: number; port: number; token: string };
      expect(info.version).toBe(1);
      expect(info.port).toBe(43210);
      expect(info.token.length).toBeGreaterThan(32);

      const denied = await bridge.handle(new Request(new URL("/__spine/mcp/state", bridgeUrl)), new URL("/__spine/mcp/state", bridgeUrl));
      expect(denied.status).toBe(401);
      const accepted = await bridge.handle(new Request(new URL("/__spine/mcp/health", bridgeUrl), { headers: { authorization: `Bearer ${info.token}` } }), new URL("/__spine/mcp/health", bridgeUrl));
      expect(accepted.status).toBe(200);
    } finally {
      bridge.cleanup();
    }
  });

  test("round-trips UI state and resolves a queued UI command", async () => {
    const bridge = new SpineEditorMcpBridge(true);
    const connectionFile = await bridge.start(43210);
    try {
      const enabled = await bridge.handle(new Request(new URL("/__spine/mcp/ui-enabled", bridgeUrl)), new URL("/__spine/mcp/ui-enabled", bridgeUrl));
      expect(await enabled.json()).toEqual({ enabled: true });
      const posted = await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", directory: "Aru_home" }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      expect(posted.status).toBe(200);

      const token = JSON.parse(await readFile(connectionFile!, "utf8")).token as string;
      const auth = { authorization: `Bearer ${token}` };
      const stateResponse = await bridge.handle(new Request(new URL("/__spine/mcp/state", bridgeUrl), { headers: auth }), new URL("/__spine/mcp/state", bridgeUrl));
      const statePayload = await stateResponse.json() as { state: { directory: string; snapshotRevision: number; snapshotAgeMs: number }; revision: number };
      expect(statePayload.state.directory).toBe("Aru_home");
      expect(statePayload.state.snapshotRevision).toBe(1);
      expect(statePayload.revision).toBe(1);
      expect(statePayload.state.snapshotAgeMs).toBeGreaterThanOrEqual(0);

      const pending = bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 2 } }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const queuedResponse = await bridge.handle(new Request(new URL("/__spine/mcp/ui-command", bridgeUrl)), new URL("/__spine/mcp/ui-command", bridgeUrl));
      const queued = await queuedResponse.json() as { id: string; command: { name: string; seconds: number } };
      expect(queued.command).toEqual({ name: "seek", seconds: 2 });
      await bridge.handle(jsonRequest("/__spine/mcp/ui-result", { id: queued.id, result: { currentTime: 2 } }), new URL("/__spine/mcp/ui-result", bridgeUrl));
      const commandResponse = await pending;
      expect(await commandResponse.json()).toEqual({ result: { currentTime: 2 } });
    } finally {
      bridge.cleanup();
    }
  });

  test("rejects cross-origin UI bridge requests and disables MCP by default", async () => {
    const bridge = new SpineEditorMcpBridge(true);
    const disabled = new SpineEditorMcpBridge(false);
    try {
      const crossOrigin = await bridge.handle(new Request(new URL("/__spine/mcp/ui-command", bridgeUrl), { headers: { origin: "https://example.com" } }), new URL("/__spine/mcp/ui-command", bridgeUrl));
      expect(crossOrigin.status).toBe(403);
      const off = await disabled.handle(new Request(new URL("/__spine/mcp/health", bridgeUrl)), new URL("/__spine/mcp/health", bridgeUrl));
      expect(off.status).toBe(404);
    } finally {
      bridge.cleanup();
      disabled.cleanup();
    }
  });
});
