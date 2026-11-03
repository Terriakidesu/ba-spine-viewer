import { describe, expect, test } from "bun:test";
import { HANDOFF_PROTOCOL_VERSION, HandoffValidationError, libraryIdentityForPath, parseHandoffMessage, parseSpineDraftSnapshot } from "./handoff";

const validMessage = {
  protocolVersion: 1,
  requestId: "req_00000001",
  targetApp: "viewer",
  library: { identity: "sha256:library-fixture", path: "D:\\BA Spine\\data" },
  lobbyId: "Airi_home",
  sequenceId: "opening-1",
  language: "en-US",
  playheadSeconds: 12.5,
  draft: { sessionId: "draft_00000001" },
} as const;

describe("versioned companion handoff contract", () => {
  test("accepts and returns a normalized handoff message", () => {
    expect(parseHandoffMessage(validMessage)).toEqual({ ...validMessage, protocolVersion: HANDOFF_PROTOCOL_VERSION });
  });

  test("derives a stable fixed-length library identity from normalized path separators", async () => {
    const windows = await libraryIdentityForPath("D:\\BA Spine\\library\\");
    const normalized = await libraryIdentityForPath("D:/BA Spine/library");
    expect(windows).toBe(normalized);
    expect(windows).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("supports the minimal saved-project message without optional context", () => {
    expect(parseHandoffMessage({
      protocolVersion: 1,
      requestId: "req_00000002",
      targetApp: "editor",
      library: { identity: "local-library", path: "/mnt/library" },
      lobbyId: "Airi_home",
    })).toEqual({
      protocolVersion: 1,
      requestId: "req_00000002",
      targetApp: "editor",
      library: { identity: "local-library", path: "/mnt/library" },
      lobbyId: "Airi_home",
    });
  });

  test("rejects unknown versions, fields, invalid targets, and path-like project IDs", () => {
    const invalidMessages = [
      { ...validMessage, protocolVersion: 2 },
      { ...validMessage, extra: "not in v1" },
      { ...validMessage, targetApp: "other" },
      { ...validMessage, lobbyId: "../outside" },
      { ...validMessage, sequenceId: "nested/sequence" },
      { ...validMessage, library: { ...validMessage.library, path: "relative/library" } },
    ];
    for (const message of invalidMessages) expect(() => parseHandoffMessage(message)).toThrow(HandoffValidationError);
  });

  test("rejects invalid optional playback and draft values", () => {
    for (const playheadSeconds of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, 604_801]) {
      expect(() => parseHandoffMessage({ ...validMessage, playheadSeconds })).toThrow(HandoffValidationError);
    }
    expect(() => parseHandoffMessage({ ...validMessage, language: "english language" })).toThrow(HandoffValidationError);
    expect(() => parseHandoffMessage({ ...validMessage, draft: { sessionId: "short" } })).toThrow(HandoffValidationError);
  });
});

describe("volatile unsaved draft snapshot contract", () => {
  const snapshot = {
    protocolVersion: 1,
    sessionId: "draft_session_01",
    library: { identity: "sha256:library-fixture", path: "D:\\BA Spine\\data" },
    lobbyId: "Airi_home",
    revision: 1,
    project: { assetDirectory: "Airi_home", interactions: [], timeline: { sequenceId: "opening" } },
  } as const;

  test("accepts and normalizes a bounded project snapshot", () => {
    expect(parseSpineDraftSnapshot(snapshot)).toEqual(snapshot);
  });

  test("rejects invalid session, revision, identity, or unsupported fields", () => {
    expect(() => parseSpineDraftSnapshot({ ...snapshot, sessionId: "../draft" })).toThrow(HandoffValidationError);
    expect(() => parseSpineDraftSnapshot({ ...snapshot, revision: 0 })).toThrow(HandoffValidationError);
    expect(() => parseSpineDraftSnapshot({ ...snapshot, library: { ...snapshot.library, path: "relative" } })).toThrow(HandoffValidationError);
    expect(() => parseSpineDraftSnapshot({ ...snapshot, extra: true })).toThrow(HandoffValidationError);
  });

  test("rejects non-object and oversized project payloads", () => {
    expect(() => parseSpineDraftSnapshot({ ...snapshot, project: [] })).toThrow(HandoffValidationError);
    expect(() => parseSpineDraftSnapshot({ ...snapshot, project: { data: "x".repeat(8 * 1024 * 1024) } })).toThrow(HandoffValidationError);
  });
});
