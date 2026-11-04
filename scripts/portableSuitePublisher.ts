import { cp, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT_FILES = ["Editor.exe", "Viewer.exe", "README.txt", "suite.json"] as const;
const GENERATED_DIRECTORIES = ["apps", "licenses"] as const;

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Publish generated suite files while leaving an existing portable data directory untouched. */
export async function publishPortableSuiteDirectory(stage: string, outputDirectory: string): Promise<void> {
  const outputInfo = await existingEntry(outputDirectory);
  if (outputInfo && (!outputInfo.isDirectory() || outputInfo.isSymbolicLink())) {
    throw new Error(`Portable output folder is not a regular directory: ${outputDirectory}`);
  }

  const dataPath = join(outputDirectory, "data");
  const dataInfo = await existingEntry(dataPath);
  if (dataInfo && (!dataInfo.isDirectory() || dataInfo.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-directory portable data path: ${dataPath}`);
  }

  for (const name of ROOT_FILES) {
    const target = join(outputDirectory, name);
    const info = await existingEntry(target);
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new Error(`Refusing to replace non-file portable output: ${target}`);
    }
  }
  for (const name of GENERATED_DIRECTORIES) {
    const target = join(outputDirectory, name);
    const info = await existingEntry(target);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`Refusing to replace non-directory portable output: ${target}`);
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const name of ROOT_FILES) {
    await copyFile(join(stage, name), join(outputDirectory, name));
  }
  for (const name of GENERATED_DIRECTORIES) {
    const target = join(outputDirectory, name);
    await rm(target, { recursive: true, force: true });
    await cp(join(stage, name), target, { recursive: true, errorOnExist: true });
  }
  if (!dataInfo) await cp(join(stage, "data"), dataPath, { recursive: true, errorOnExist: true });
}
