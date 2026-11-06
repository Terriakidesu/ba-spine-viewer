import { describe, expect, test } from "bun:test";
import {
  checkForLatestRelease,
  compareSemanticVersions,
  parseGitHubRelease,
  parseSemanticVersion,
  RELEASE_CHECK_INTERVAL_MS,
} from "./releaseUpdates";

function releasePayload(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.3",
    name: "BA Spine Suite 1.2.3",
    html_url: "https://github.com/Terriakidesu/ba-spine-viewer/releases/tag/v1.2.3",
    published_at: "2026-10-01T12:00:00Z",
    body: "Stable release notes",
    draft: false,
    prerelease: false,
    assets: [{
      name: "BA-Spine-Suite-1.2.3-win-x64.zip",
      browser_download_url: "https://github.com/Terriakidesu/ba-spine-viewer/releases/download/v1.2.3/BA-Spine-Suite-1.2.3-win-x64.zip",
      size: 1024,
    }],
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("release update helpers", () => {
  test("parses SemVer and compares stable and prerelease ordering", () => {
    expect(parseSemanticVersion("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0, prerelease: [] });
    expect(compareSemanticVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.0", "1.2.0-rc.2")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.0-rc.10", "1.2.0-rc.2")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.0+build.1", "v1.2.0+build.2")).toBe(0);
    expect(parseSemanticVersion("01.2.3")).toBeNull();
    expect(() => compareSemanticVersions("not-a-version", "1.0.0")).toThrow("invalid semantic versions");
  });

  test("normalizes a stable GitHub release and rejects unsafe or prerelease responses", () => {
    const parsed = parseGitHubRelease(releasePayload());
    expect(parsed.version).toBe("v1.2.3");
    expect(parsed.notes).toBe("Stable release notes");
    expect(parsed.assets[0]?.name).toBe("BA-Spine-Suite-1.2.3-win-x64.zip");
    expect(() => parseGitHubRelease(releasePayload({ prerelease: true }))).toThrow("stable release");
    expect(() => parseGitHubRelease(releasePayload({ html_url: "https://example.com/releases/v1.2.3" }))).toThrow("unexpected release URL");
  });

  test("caches successful checks for one day and supports a conditional refresh", async () => {
    const storage = memoryStorage();
    const now = Date.parse("2026-11-01T00:00:00Z");
    let fetchCount = 0;
    const observed = { conditionalHeader: null as string | null };
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      if (fetchCount === 1) return new Response(JSON.stringify(releasePayload()), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"release-v1"' },
      });
      observed.conditionalHeader = new Headers(init?.headers).get("If-None-Match");
      return new Response(null, { status: 304, headers: { ETag: '"release-v1"' } });
    };

    const first = await checkForLatestRelease({ now, fetcher, storage });
    const cached = await checkForLatestRelease({ now: now + RELEASE_CHECK_INTERVAL_MS - 1, fetcher, storage });
    expect(first.release.version).toBe("v1.2.3");
    expect(cached).toEqual(first);
    expect(fetchCount).toBe(1);

    const refreshed = await checkForLatestRelease({ now: now + RELEASE_CHECK_INTERVAL_MS, force: true, fetcher, storage });
    expect(refreshed.release.version).toBe("v1.2.3");
    expect(refreshed.checkedAt).toBe(now + RELEASE_CHECK_INTERVAL_MS);
    expect(observed.conditionalHeader).toBe('"release-v1"');
    expect(fetchCount).toBe(2);
  });

  test("does not cache a failed request", async () => {
    const storage = memoryStorage();
    const fetcher = async () => new Response("", { status: 403 });
    await expect(checkForLatestRelease({ fetcher, storage })).rejects.toThrow("rate-limited");
    expect(storage.getItem("ba-spine-suite:release-check:v1")).toBeNull();
  });
});
