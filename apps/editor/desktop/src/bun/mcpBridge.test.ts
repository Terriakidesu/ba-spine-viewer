import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { EDITOR_MCP_OPERATION_REGISTRY, EDITOR_MCP_REVISION_REQUIRED_COMMANDS } from "@ba-spine/editor-feature/editorMcp";
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
  test("the shared operation registry is exhaustive and every operation has a registered MCP tool", async () => {
    const serverSource = await readFile(new URL("../../scripts/mcp-server.ts", import.meta.url), "utf8");
    const registeredTools = new Set([...serverSource.matchAll(/trackToolName\("(editor_[^"]+)"\)/g)].map((match) => match[1]));
    const operations = Object.values(EDITOR_MCP_OPERATION_REGISTRY);
    expect(operations.length).toBeGreaterThan(50);
    expect(new Set(operations.map((operation) => operation.toolName)).size).toBe(operations.length);
    for (const operation of operations) {
      expect(registeredTools.has(operation.toolName)).toBe(true);
      expect(operation.resultShape).toBe("EditorMcpResultEnvelope<unknown>");
      expect(typeof operation.inputSchema).toBe("function");
      expect(operation.revisionRequired).toBe(EDITOR_MCP_REVISION_REQUIRED_COMMANDS.has(operation.name));
    }
  });

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
      const posted = await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", assetRoot: "D:/assets", directory: "Aru_home", projectName: "Aru", saveState: "saved", documentRevision: 7 }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      expect(posted.status).toBe(200);
      await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", assetRoot: "D:/assets", directory: "Aru_home", projectName: "Aru", saveState: "saved", documentRevision: 7 }), new URL("/__spine/mcp/ui-state", bridgeUrl));

      const token = JSON.parse(await readFile(connectionFile!, "utf8")).token as string;
      const auth = { authorization: `Bearer ${token}` };
      const stateResponse = await bridge.handle(new Request(new URL("/__spine/mcp/state", bridgeUrl), { headers: auth }), new URL("/__spine/mcp/state", bridgeUrl));
      const statePayload = await stateResponse.json() as { state: { directory: string; snapshotRevision: number; snapshotAgeMs: number; documentRevision: number }; revision: number };
      expect(statePayload.state.directory).toBe("Aru_home");
      expect(statePayload.state.snapshotRevision).toBe(2);
      expect(statePayload.state.documentRevision).toBe(7);
      expect(statePayload.revision).toBe(2);
      expect(statePayload.state.snapshotAgeMs).toBeGreaterThanOrEqual(0);

      const pending = bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 2 }, expectedDocumentRevision: 7 }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const queuedResponse = await bridge.handle(new Request(new URL("/__spine/mcp/ui-command", bridgeUrl)), new URL("/__spine/mcp/ui-command", bridgeUrl));
      const queued = await queuedResponse.json() as { id: string; command: { name: string; seconds: number }; expectedDocumentRevision: number; expiresAt: number };
      expect(queued.command).toEqual({ name: "seek", seconds: 2 });
      expect(queued.expectedDocumentRevision).toBe(7);
      expect(queued.expiresAt).toBeGreaterThan(Date.now());
      await bridge.handle(jsonRequest("/__spine/mcp/ui-result", { id: queued.id, result: { currentTime: 2, documentRevision: 8 } }), new URL("/__spine/mcp/ui-result", bridgeUrl));
      const commandResponse = await pending;
      expect(await commandResponse.json()).toMatchObject({
        envelopeVersion: 1,
        ok: true,
        requestId: queued.id,
        currentTime: 2,
        documentRevision: 8,
        result: { currentTime: 2, documentRevision: 8 },
        projectIdentity: {
          before: { hostPid: process.pid, assetRoot: "D:/assets", directory: "Aru_home", projectName: "Aru" },
          after: { hostPid: process.pid, assetRoot: "D:/assets", directory: "Aru_home", projectName: "Aru" },
        },
        documentRevisions: { before: 7, after: 7 },
        affectedEntityIds: [],
        createdEntityIds: [],
        warnings: [],
        normalization: null,
        saveState: "saved",
      });
    } finally {
      bridge.cleanup();
    }
  });

  test("rejects stale document revisions and removes timed-out commands from the queue", async () => {
    const bridge = new SpineEditorMcpBridge(true, { commandTimeoutMs: 60 });
    const connectionFile = await bridge.start(43210);
    try {
      await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", documentRevision: 4 }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      const token = JSON.parse(await readFile(connectionFile!, "utf8")).token as string;
      const auth = { authorization: `Bearer ${token}` };
      const stale = await bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 1 }, expectedDocumentRevision: 3 }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ envelopeVersion: 1, ok: false, code: "stale_document_revision", error: { code: "stale_document_revision", details: { expectedDocumentRevision: 3, actualDocumentRevision: 4 } }, documentRevisions: { before: 4, after: 4 } });

      const timedOut = bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 2 }, expectedDocumentRevision: 4 }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      const response = await timedOut;
      expect(response.status).toBe(504);
      const timedOutPayload = await response.json() as { error: { message: string; code: string }; code: string; envelopeVersion: number; ok: boolean };
      expect(timedOutPayload.error.message).toContain("queued command was canceled");
      expect(timedOutPayload.error.code).toBe("command_timeout");
      expect(timedOutPayload).toMatchObject({ envelopeVersion: 1, ok: false, code: "command_timeout" });
      const queued = await bridge.handle(new Request(new URL("/__spine/mcp/ui-command", bridgeUrl)), new URL("/__spine/mcp/ui-command", bridgeUrl));
      expect(await queued.json()).toBeNull();
    } finally {
      bridge.cleanup();
    }
  });

  test("requires document revisions at the native boundary for authored edits", async () => {
    const bridge = new SpineEditorMcpBridge(true);
    const connectionFile = await bridge.start(43210);
    try {
      await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "interaction", documentRevision: 9 }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      const token = JSON.parse(await readFile(connectionFile!, "utf8")).token as string;
      const auth = { authorization: `Bearer ${token}` };
      const missingRevision = await bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "delete_interaction", interactionId: "pat" } }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      expect(missingRevision.status).toBe(400);
      const missingRevisionPayload = await missingRevision.json() as { error: { message: string }; code: string; envelopeVersion: number; ok: boolean };
      expect(missingRevisionPayload.error.message).toContain("expectedDocumentRevision is required");
      expect(missingRevisionPayload).toMatchObject({ envelopeVersion: 1, ok: false, code: "revision_required" });
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

  test("enforces request, snapshot, and command-result size limits", async () => {
    const bridge = new SpineEditorMcpBridge(true, { commandTimeoutMs: 1000 });
    const connectionFile = await bridge.start(43210);
    try {
      const tooLargeState = await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", padding: "x".repeat(2 * 1024 * 1024) }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      expect(tooLargeState.status).toBe(413);

      await bridge.handle(jsonRequest("/__spine/mcp/ui-state", { workspace: "timeline", documentRevision: 1 }), new URL("/__spine/mcp/ui-state", bridgeUrl));
      const token = JSON.parse(await readFile(connectionFile!, "utf8")).token as string;
      const auth = { authorization: `Bearer ${token}` };
      const tooLargeCommand = await bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 1 }, padding: "x".repeat(2 * 1024 * 1024) }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      expect(tooLargeCommand.status).toBe(413);

      const pending = bridge.handle(jsonRequest("/__spine/mcp/command", { command: { name: "seek", seconds: 2 }, expectedDocumentRevision: 1 }, auth), new URL("/__spine/mcp/command", bridgeUrl));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const queued = await (await bridge.handle(new Request(new URL("/__spine/mcp/ui-command", bridgeUrl)), new URL("/__spine/mcp/ui-command", bridgeUrl))).json() as { id: string };
      const oversizedResult = await bridge.handle(jsonRequest("/__spine/mcp/ui-result", { id: queued.id, result: "x".repeat(1024 * 1024 + 1) }, { "x-ba-spine-command-id": queued.id }), new URL("/__spine/mcp/ui-result", bridgeUrl));
      expect(oversizedResult.status).toBe(413);
      const commandResponse = await pending;
      expect(commandResponse.status).toBe(502);
       expect(((await commandResponse.json()) as { error: { message: string } }).error.message).toContain("1 MiB response limit");
    } finally {
      bridge.cleanup();
    }
  });
});
