import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveVideoFileWithoutOverwrite, saveVideoWithoutOverwrite } from "./videoExport";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("safe video export", () => {
  test("preserves an existing file and picks a unique sibling name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-video-export-"));
    temporaryDirectories.push(directory);
    const originalPath = join(directory, "Airi opening.webm");
    await writeFile(originalPath, "existing recording");

    const savedAs = await saveVideoWithoutOverwrite(directory, "Airi opening.webm", new TextEncoder().encode("new recording"));

    expect(savedAs).toBe("Airi opening (1).webm");
    expect(await readFile(originalPath, "utf8")).toBe("existing recording");
    expect(await readFile(join(directory, savedAs), "utf8")).toBe("new recording");
  });

  test("rejects unsupported extensions and strips path separators", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-video-export-"));
    temporaryDirectories.push(directory);

    await expect(saveVideoWithoutOverwrite(directory, "capture.avi", new Uint8Array([1]))).rejects.toThrow("Only WebM and MP4");
    expect(await saveVideoWithoutOverwrite(directory, "../unsafe/capture.mp4", new Uint8Array([2]))).toBe("..-unsafe-capture.mp4");
  });

  test("copies encoded videos without replacing existing files or buffering the source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-video-export-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "encoded.mp4");
    const existingPath = join(directory, "capture.mp4");
    await writeFile(sourcePath, Buffer.alloc(1024 * 1024 + 9, 23));
    await writeFile(existingPath, "keep this recording");

    const progress: Array<{ copied: number; total: number }> = [];
    const savedAs = await saveVideoFileWithoutOverwrite(directory, "capture.mp4", sourcePath, (copied, total) => progress.push({ copied, total }));

    expect(savedAs).toBe("capture (1).mp4");
    expect(await readFile(existingPath, "utf8")).toBe("keep this recording");
    const copy = await readFile(join(directory, savedAs));
    expect(copy.byteLength).toBe(1024 * 1024 + 9);
    expect(copy[0]).toBe(23);
    expect(copy.at(-1)).toBe(23);
    expect(progress[0]).toEqual({ copied: 0, total: 1024 * 1024 + 9 });
    expect(progress.at(-1)).toEqual({ copied: 1024 * 1024 + 9, total: 1024 * 1024 + 9 });
  });
});
