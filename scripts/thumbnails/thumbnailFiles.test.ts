import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkedThumbnailRoot, saveThumbnail, thumbnailDirectories, thumbnailJob, validateThumbnailPng } from "./thumbnailFiles";
import { lobbyThumbnailPath } from "../../packages/spine-runtime/src/spine/spineThumbnail";

const fixtures: string[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true }); });

async function fixture() {
  const temporaryRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, "thumbnail-test-"));
  fixtures.push(root);
  await mkdir(join(root, "lobbies", "Fixture", "spine"), { recursive: true });
  const manifest = { schemaVersion: 1, id: "Fixture", skeleton: "spine/Fixture.skel", atlas: "spine/Fixture.atlas" };
  await writeFile(join(root, "lobbies", "Fixture", "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "lobbies", "Fixture", "spine", "Fixture.atlas"), "");
  await writeFile(join(root, "lobbies", "Fixture", "spine", "Fixture.skel"), "");
  return root;
}

function pngHeader(width = 640, height = 360) {
  const bytes = Buffer.alloc(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("thumbnail paths are lobby-local and reject traversal", () => {
  expect(lobbyThumbnailPath("Airi_home")).toBe("lobbies/Airi_home/thumbnail.png");
  for (const name of ["", ".", "..", "../Fixture", "D:\\library", "a/b", "a\\b", "a\0", "trailing."]) expect(() => lobbyThumbnailPath(name)).toThrow();
});

test("requires a 16:9 640x360 PNG", () => {
  expect(() => validateThumbnailPng(pngHeader())).not.toThrow();
  expect(() => validateThumbnailPng(pngHeader(640, 480))).toThrow("16:9");
  expect(() => validateThumbnailPng(new Uint8Array(40))).toThrow();
});

test("publishes atomically, skips existing files, and supports explicit force", async () => {
  const root = await fixture();
  const path = join(root, "lobbies", "Fixture", "thumbnail.png");
  const first = pngHeader();
  const second = pngHeader();
  second[32] = 123;
  expect(await saveThumbnail(root, path, first, false)).toBe(true);
  expect(await saveThumbnail(root, path, second, false)).toBe(false);
  expect(await readFile(path)).toEqual(first);
  expect(await saveThumbnail(root, path, second, true)).toBe(true);
  expect(await readFile(path)).toEqual(second);
});

test("resolves manifest assets and verifies lobby identity", async () => {
  const root = await fixture();
  const job = await thumbnailJob(root, "Fixture");
  expect(job.files.length).toBe(2);
  expect(job.output).toBe(join(root, "lobbies", "Fixture", "thumbnail.png"));
  await writeFile(join(root, "lobbies", "Fixture", "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "WrongVariant", skeleton: "spine/Fixture.skel", atlas: "spine/Fixture.atlas" }));
  await expect(thumbnailJob(root, "Fixture")).rejects.toThrow("identity");
});

test("refuses thumbnail writes through escaping lobby junctions", async () => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(join(outside, "lobbies", "Fixture"), join(root, "lobbies", "Escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(saveThumbnail(root, join(root, "lobbies", "Escape", "thumbnail.png"), pngHeader(), true)).rejects.toThrow("outside");
});

test("refuses repository data before performing writes", async () => {
  await expect(checkedThumbnailRoot(resolve(import.meta.dir, "../../data"))).rejects.toThrow("repository data");
});

test("batch generation includes home lobbies only, with explicit targeting available", async () => {
  const root = await fixture();
  for (const name of ["Airi_home", "CH0264_home", "Aru_scene", "Airi_home_background", "akari_bg"]) {
    await mkdir(join(root, "lobbies", name));
  }
  expect(await thumbnailDirectories(root)).toEqual(["Airi_home", "CH0264_home"]);
  expect(await thumbnailDirectories(root, "Aru_scene")).toEqual(["Aru_scene"]);
});
