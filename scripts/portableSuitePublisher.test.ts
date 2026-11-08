import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPortableSuiteDirectory } from "./portableSuitePublisher";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ba-spine-portable-publisher-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeStage(stage: string, marker: string): Promise<void> {
  await mkdir(join(stage, "data"), { recursive: true });
  await mkdir(join(stage, "apps", "editor"), { recursive: true });
  await mkdir(join(stage, "licenses"), { recursive: true });
  for (const name of ["Editor.exe", "Viewer.exe", "SuiteUpdater.exe", "README.txt", "suite.json"]) {
    await writeFile(join(stage, name), `${marker}:${name}`);
  }
  await writeFile(join(stage, "data", "README.txt"), "Portable data placeholder");
  await writeFile(join(stage, "apps", "editor", "bundle.txt"), `${marker}:bundle`);
  await writeFile(join(stage, "licenses", "license.txt"), `${marker}:license`);
}

test("publishes portable app files while preserving existing user data", async () => {
  const root = await temporaryRoot();
  const stage = join(root, "stage");
  const output = join(root, "BA-Spine-Suite-0.1.0-win-x64");
  await writeStage(stage, "new");

  await mkdir(join(output, "data"), { recursive: true });
  await mkdir(join(output, "apps", "editor"), { recursive: true });
  await mkdir(join(output, "licenses"), { recursive: true });
  await writeFile(join(output, "data", "README.txt"), "Existing data folder");
  await writeFile(join(output, "data", "catalog.json"), "disposable authored fixture");
  await writeFile(join(output, "Editor.exe"), "old launcher");
  await writeFile(join(output, "apps", "editor", "stale.txt"), "stale app output");
  await writeFile(join(output, "licenses", "stale.txt"), "stale license output");

  await publishPortableSuiteDirectory(stage, output);

  expect(await readFile(join(output, "Editor.exe"), "utf8")).toBe("new:Editor.exe");
  expect(await readFile(join(output, "SuiteUpdater.exe"), "utf8")).toBe("new:SuiteUpdater.exe");
  expect(await readFile(join(output, "apps", "editor", "bundle.txt"), "utf8")).toBe("new:bundle");
  expect(await readFile(join(output, "licenses", "license.txt"), "utf8")).toBe("new:license");
  expect((await readdir(join(output, "data"))).sort()).toEqual(["README.txt", "catalog.json"]);
  expect(await readFile(join(output, "data", "README.txt"), "utf8")).toBe("Existing data folder");
  expect(await readFile(join(output, "data", "catalog.json"), "utf8")).toBe("disposable authored fixture");
});

test("creates the data placeholder for a new extracted portable folder", async () => {
  const root = await temporaryRoot();
  const stage = join(root, "stage");
  const output = join(root, "BA-Spine-Suite-0.1.0-win-x64");
  await writeStage(stage, "new");

  await publishPortableSuiteDirectory(stage, output);

  expect(await readFile(join(output, "data", "README.txt"), "utf8")).toBe("Portable data placeholder");
});

test("refuses an invalid existing data path before replacing generated files", async () => {
  const root = await temporaryRoot();
  const stage = join(root, "stage");
  const output = join(root, "BA-Spine-Suite-0.1.0-win-x64");
  await writeStage(stage, "new");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "data"), "not a directory");
  await writeFile(join(output, "Editor.exe"), "existing launcher");

  await expect(publishPortableSuiteDirectory(stage, output)).rejects.toThrow("Refusing to replace non-directory portable data path");
  expect(await readFile(join(output, "Editor.exe"), "utf8")).toBe("existing launcher");
});
