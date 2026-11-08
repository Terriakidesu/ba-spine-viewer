import { createHash } from "node:crypto";
import { open, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  downloadPortableSuiteUpdate,
  getPortableSuiteUpdateStatus,
  getStagedPortableSuiteUpdate,
  hasPortableSuiteUpdater,
  isNewerPortableSuiteVersion,
  PORTABLE_SUITE_UPDATE_DIRECTORY,
} from "./portableSuiteUpdate";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = join(tmpdir(), `suite-update-test-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, "data"), { recursive: true });
  await Bun.write(join(root, "data", "authored.txt"), "keep");
  return root;
}

function releaseResponse(version: string, bytes: Uint8Array, options: { zipUrl?: string; checksum?: string } = {}): Response {
  const archiveName = `BA-Spine-Suite-${version}-win-x64.zip`;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const assets = [
    {
      name: archiveName,
      browser_download_url: options.zipUrl ?? `https://github.com/Terriakidesu/ba-spine-viewer/releases/download/v${version}/${archiveName}`,
      size: bytes.byteLength,
    },
    {
      name: `${archiveName}.sha256`,
      browser_download_url: `https://github.com/Terriakidesu/ba-spine-viewer/releases/download/v${version}/${archiveName}.sha256`,
      size: 100,
    },
  ];
  return new Response(JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, assets }));
}

function fetcherFor(version: string, bytes: Uint8Array, options: { zipUrl?: string; checksum?: string } = {}): typeof fetch {
  const archiveName = `BA-Spine-Suite-${version}-win-x64.zip`;
  const digest = createHash("sha256").update(bytes).digest("hex");
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.github.com")) return releaseResponse(version, bytes, options);
    if (url.endsWith(`${archiveName}.sha256`)) return new Response(options.checksum ?? `${digest}  ${archiveName}\n`);
    if (url.endsWith(archiveName)) {
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new Response(body, { headers: { "content-length": String(bytes.byteLength) } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

describe("portable suite updater", () => {
  test("compares stable suite versions without number precision loss", () => {
    expect(isNewerPortableSuiteVersion("v0.3.0", "0.2.0")).toBe(true);
    expect(isNewerPortableSuiteVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerPortableSuiteVersion("1.0.0", "2.0.0")).toBe(false);
    expect(isNewerPortableSuiteVersion("9007199254740993.0.0", "9007199254740992.0.0")).toBe(true);
    expect(() => isNewerPortableSuiteVersion("0.3.0-rc.1", "0.2.0")).toThrow("invalid");
  });

  test("only enables installs when the helper is a regular file", async () => {
    const root = await fixtureRoot();
    expect(await hasPortableSuiteUpdater(root)).toBe(false);
    await Bun.write(join(root, "SuiteUpdater.exe"), "updater fixture");
    expect(await hasPortableSuiteUpdater(root)).toBe(true);
  });

  test("downloads and verifies a single suite archive into a contained update folder", async () => {
    const root = await fixtureRoot();
    const bytes = new TextEncoder().encode("disposable suite zip bytes");
    const result = await downloadPortableSuiteUpdate(root, "0.3.0", fetcherFor("0.3.0", bytes));
    expect(result).toEqual({ status: "ready", version: "0.3.0" });
    expect(await getPortableSuiteUpdateStatus(root, "0.3.0")).toEqual({ status: "ready", version: "0.3.0" });
    const staged = await getStagedPortableSuiteUpdate(root, "0.3.0");
    expect(staged.archivePath.startsWith(join(root, PORTABLE_SUITE_UPDATE_DIRECTORY))).toBe(true);
    expect(staged.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(join(root, "data", "authored.txt"), "utf8")).toBe("keep");
  });

  test("rejects unsafe asset URLs and bad release checksums without retaining a partial archive", async () => {
    const root = await fixtureRoot();
    const bytes = new TextEncoder().encode("zip bytes");
    await expect(downloadPortableSuiteUpdate(root, "0.3.0", fetcherFor("0.3.0", bytes, {
      zipUrl: "https://example.com/suite.zip",
    }))).rejects.toThrow("unexpected suite update asset URL");
    await expect(downloadPortableSuiteUpdate(root, "0.3.0", fetcherFor("0.3.0", bytes, {
      checksum: `${"0".repeat(64)}  BA-Spine-Suite-0.3.0-win-x64.zip\n`,
    }))).rejects.toThrow("failed its SHA-256 check");
    expect(await getPortableSuiteUpdateStatus(root, "0.3.0")).toEqual({ status: "idle", version: null });
  });

  test("reports a concurrent suite download instead of starting a duplicate", async () => {
    const root = await fixtureRoot();
    const directory = join(root, PORTABLE_SUITE_UPDATE_DIRECTORY);
    await mkdir(directory, { recursive: true });
    const lock = await open(join(directory, "download-0.3.0.lock"), "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, version: "0.3.0" }));
    await lock.close();
    const result = await downloadPortableSuiteUpdate(root, "0.3.0", fetcherFor("0.3.0", new TextEncoder().encode("unused")));
    expect(result).toEqual({ status: "downloading", version: "0.3.0" });
    expect(await getPortableSuiteUpdateStatus(root, "0.3.0")).toEqual({ status: "downloading", version: "0.3.0" });
  });
});
