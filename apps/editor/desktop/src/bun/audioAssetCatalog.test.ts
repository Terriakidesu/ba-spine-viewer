import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAudioAssets } from "./audioAssetCatalog";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ba-spine-editor-audio-catalog-"));
  fixtures.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("audio asset catalog", () => {
  test("finds supported root-relative files recursively and applies ignore rules", async () => {
    const root = await fixture();
    await mkdir(join(root, "voice"), { recursive: true });
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "voice", "line.ogg"), "audio");
    await writeFile(join(root, "voice", "notes.txt"), "text");
    await writeFile(join(root, "ignored", "hidden.wav"), "audio");

    const result = await discoverAudioAssets(root, (path) => path.startsWith("ignored/"));
    expect(result).toMatchObject({ truncated: false, assets: [{ path: "voice/line.ogg", sizeBytes: 5 }] });
  });

  test("does not follow symlinks outside the library and reports bounded scans", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "private.mp3"), "outside");
    let linked = false;
    try {
      await symlink(outside, join(root, "external"), "junction");
      linked = true;
    } catch { /* Symlink creation may be unavailable in restricted Windows environments. */ }
    await mkdir(join(root, "sounds"), { recursive: true });
    await writeFile(join(root, "sounds", "one.wav"), "1");
    await writeFile(join(root, "sounds", "two.wav"), "2");

    const result = await discoverAudioAssets(root, () => false, 1);
    expect(result.assets).toHaveLength(1);
    expect(result.truncated).toBe(true);
    if (linked) expect(result.assets.some((asset) => asset.path.includes("private.mp3"))).toBe(false);
  });
});
