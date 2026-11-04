import { afterEach, describe, expect, test } from "bun:test";
import { cc, ptr } from "bun:ffi";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS_WINDOW_MINIMUM_SOURCE } from "./windowsWindowMinimum";

let temporaryDirectory: string | null = null;
afterEach(() => {
  if (!temporaryDirectory) return;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe("Windows native window minimum", () => {
  test.skipIf(process.platform !== "win32" || process.arch !== "x64")("compiles the thread hook and registers it on a native window thread", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "ba-spine-window-minimum-test-"));
    const sourcePath = join(temporaryDirectory, "window-minimum.c");
    writeFileSync(sourcePath, WINDOWS_WINDOW_MINIMUM_SOURCE, "utf8");
    const native = cc({
      source: sourcePath,
      library: ["user32", "kernel32"],
      symbols: {
        baSpineTestHookRegistration: { args: [], returns: "int" },
      },
    });

    try {
      expect(native.symbols.baSpineTestHookRegistration()).toBe(1);
    } finally {
      native.close();
    }
  });

  test.skipIf(process.platform !== "win32" || process.arch !== "x64")("scales logical minimums at common DPIs and clamps to the monitor work area", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "ba-spine-window-minimum-test-"));
    const sourcePath = join(temporaryDirectory, "window-minimum.c");
    writeFileSync(sourcePath, WINDOWS_WINDOW_MINIMUM_SOURCE, "utf8");
    const native = cc({
      source: sourcePath,
      library: ["user32", "kernel32"],
      symbols: {
        baSpineApplyMinimum: { args: ["ptr", "int", "int", "u32", "int", "int"], returns: "void" },
      },
    });

    try {
      for (const [dpi, expectedWidth, expectedHeight] of [
        [96, 760, 560],
        [120, 950, 700],
        [144, 1140, 840],
        [192, 1520, 1120],
      ]) {
        const info = new Int32Array(10);
        native.symbols.baSpineApplyMinimum(ptr(info), 760, 560, dpi!, 4000, 3000);
        expect([info[6], info[7]]).toEqual([expectedWidth, expectedHeight]);
      }

      const smallWorkArea = new Int32Array(10);
      native.symbols.baSpineApplyMinimum(ptr(smallWorkArea), 760, 560, 96, 720, 500);
      expect([smallWorkArea[6], smallWorkArea[7]]).toEqual([720, 500]);
    } finally {
      native.close();
    }
  });
});
