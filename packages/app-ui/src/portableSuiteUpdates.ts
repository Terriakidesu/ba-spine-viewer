import { useCallback, useEffect, useRef, useState } from "react";
import { compareSemanticVersions, type GitHubRelease } from "./releaseUpdates";

declare global {
  interface Window {
    __BA_SPINE_HOST_TOKEN__?: string;
  }
}

export type PortableSuiteUpdateStatus = "unsupported" | "idle" | "downloading" | "ready" | "installing" | "error";

export interface PortableSuiteUpdateState {
  supported: boolean;
  suiteVersion: string | null;
  editorHasUnsavedChanges: boolean;
  status: PortableSuiteUpdateStatus;
  version: string | null;
  error: string | null;
}

interface HostUpdateReply {
  supported?: unknown;
  suiteVersion?: unknown;
  editorHasUnsavedChanges?: unknown;
  status?: unknown;
  version?: unknown;
  error?: unknown;
}

function normalizedVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

async function hostRequest(path: string, init: RequestInit = {}): Promise<HostUpdateReply> {
  const token = typeof window === "undefined" ? undefined : window.__BA_SPINE_HOST_TOKEN__;
  if (!token) throw new Error("Suite updates are available only in the portable desktop apps.");
  const headers = new Headers(init.headers);
  headers.set("x-ba-spine-token", token);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as HostUpdateReply;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Suite update request failed (${response.status}).`);
  return body;
}

function stateFromReply(reply: HostUpdateReply): PortableSuiteUpdateState {
  const supported = reply.supported === true;
  const status: PortableSuiteUpdateStatus = supported && ["idle", "downloading", "ready", "installing"].includes(String(reply.status))
    ? reply.status as PortableSuiteUpdateStatus
    : supported ? "idle" : "unsupported";
  return {
    supported,
    suiteVersion: typeof reply.suiteVersion === "string" ? reply.suiteVersion : null,
    editorHasUnsavedChanges: reply.editorHasUnsavedChanges === true,
    status,
    version: typeof reply.version === "string" ? reply.version : null,
    error: typeof reply.error === "string" ? reply.error : null,
  };
}

export function usePortableSuiteUpdates(
  release: GitHubRelease | null,
  currentVersion: string,
  autoDownload: boolean,
): {
  state: PortableSuiteUpdateState;
  download: () => Promise<void>;
  install: () => Promise<void>;
} {
  const [state, setState] = useState<PortableSuiteUpdateState>({
    supported: false,
    suiteVersion: null,
    editorHasUnsavedChanges: false,
    status: "unsupported",
    version: null,
    error: null,
  });
  const downloadStartedVersion = useRef<string | null>(null);
  const targetVersion = release && compareSemanticVersions(release.version, currentVersion) > 0
    ? normalizedVersion(release.version)
    : null;

  const refreshStatus = useCallback(async (version: string | null) => {
    const query = version ? `?version=${encodeURIComponent(version)}` : "";
    const reply = await hostRequest(`/__spine/suite-update/status${query}`);
    const next = stateFromReply(reply);
    setState((previous) => {
      if (version && targetVersion !== version) return previous;
      return { ...next, error: previous.status === "error" ? previous.error : next.error };
    });
  }, [targetVersion]);

  useEffect(() => {
    let active = true;
    void hostRequest(`/__spine/suite-update/status${targetVersion ? `?version=${encodeURIComponent(targetVersion)}` : ""}`)
      .then((reply) => { if (active) setState(stateFromReply(reply)); })
      .catch(() => { if (active) setState((previous) => previous.supported ? previous : { ...previous, status: "unsupported" }); });
    return () => { active = false; };
  }, [targetVersion]);

  const downloadVersion = useCallback(async (version: string, force = false) => {
    const normalized = normalizedVersion(version);
    if (!state.supported) return;
    if (!force && downloadStartedVersion.current === normalized) return;
    downloadStartedVersion.current = normalized;
    setState((previous) => ({ ...previous, status: "downloading", version: normalized, error: null }));
    try {
      const reply = await hostRequest("/__spine/suite-update/download", {
        method: "POST",
        body: JSON.stringify({ version: normalized }),
      });
      setState((previous) => ({
        ...previous,
        status: reply.status === "ready" ? "ready" : "downloading",
        version: normalized,
        error: null,
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "error",
        version: normalized,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [state.supported]);

  const download = useCallback(async () => {
    if (!targetVersion) return;
    downloadStartedVersion.current = null;
    await downloadVersion(targetVersion, true);
  }, [downloadVersion, targetVersion]);

  useEffect(() => {
    if (!targetVersion || !state.supported || !autoDownload || state.status === "downloading" || state.status === "installing") return;
    if (state.status === "ready" && state.version === targetVersion) return;
    if (downloadStartedVersion.current === targetVersion) return;
    void downloadVersion(targetVersion);
  }, [autoDownload, downloadVersion, state.status, state.supported, state.version, targetVersion]);

  useEffect(() => {
    if (state.status !== "downloading" || !state.version) return;
    let active = true;
    const timer = window.setInterval(() => {
      void refreshStatus(state.version!).catch(() => {
        if (active) setState((previous) => ({ ...previous, error: "Suite update download is still in progress." }));
      });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshStatus, state.status, state.version]);

  const install = useCallback(async () => {
    if (!targetVersion || !state.supported) return;
    setState((previous) => ({ ...previous, status: "installing", version: targetVersion, error: null }));
    try {
      await hostRequest("/__spine/suite-update/install", {
        method: "POST",
        body: JSON.stringify({ version: targetVersion }),
      });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "error",
        version: targetVersion,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [state.supported, targetVersion]);

  return { state, download, install };
}
