import { open, unlink } from "node:fs/promises";
import { extname, join } from "node:path";

function safeVideoFilename(filename: string): { stem: string; extension: ".webm" | ".mp4" } {
  const leaf = filename.replace(/[\\/]/g, "-");
  const extension = extname(leaf).toLocaleLowerCase();
  if (extension !== ".webm" && extension !== ".mp4") throw new Error("Only WebM and MP4 video exports are supported.");
  const stem = leaf.slice(0, -extension.length)
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100) || "spine-recording";
  return { stem, extension };
}

/** Save a video under an unused name; existing recordings are never replaced. */
export async function saveVideoWithoutOverwrite(directory: string, filename: string, content: Uint8Array): Promise<string> {
  const { stem, extension } = safeVideoFilename(filename);
  for (let index = 0; index < 10_000; index++) {
    const candidate = `${stem}${index ? ` (${index})` : ""}${extension}`;
    const fullPath = join(directory, candidate);
    let handle;
    try {
      handle = await open(fullPath, "wx");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      return candidate;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(fullPath).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("Could not find an unused filename for the video export.");
}

/** Copy an encoded video under an unused name without loading the whole file into memory. */
export async function saveVideoFileWithoutOverwrite(directory: string, filename: string, sourcePath: string): Promise<string> {
  const { stem, extension } = safeVideoFilename(filename);
  const source = await open(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let index = 0; index < 10_000; index++) {
      const candidate = `${stem}${index ? ` (${index})` : ""}${extension}`;
      const fullPath = join(directory, candidate);
      let output;
      try {
        output = await open(fullPath, "wx");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
      try {
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
            offset += bytesWritten;
          }
        }
        await output.sync();
        await output.close();
        return candidate;
      } catch (error) {
        await output.close().catch(() => undefined);
        await unlink(fullPath).catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await source.close();
  }
  throw new Error("Could not find an unused filename for the video export.");
}
