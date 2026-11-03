import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopWindowState,
  defaultDesktopWindowFrame,
  MAX_WINDOW_STATE_BYTES,
  readDesktopWindowState,
  restoreDesktopWindowState,
  startDesktopWindowStatePersistence,
  writeDesktopWindowState,
  writeDesktopWindowStateSync,
  type WindowDisplay,
} from "./windowState";

const display = (overrides: Partial<WindowDisplay> = {}): WindowDisplay => ({
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  isPrimary: true,
  ...overrides,
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop window state", () => {
  test("captures a frame against the display with greatest work-area overlap", () => {
    const displays = [
      display(),
      display({ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.5, isPrimary: false }),
    ];
    const captured = createDesktopWindowState({ x: 2100, y: 70, width: 1200, height: 850 }, displays, true);
    expect(captured?.displayId).toBe(2);
    expect(captured?.scaleFactor).toBe(1.5);
    expect(captured?.maximized).toBe(true);
    expect(restoreDesktopWindowState(captured, [displays[1]!], { width: 760, height: 560 })?.maximized).toBe(true);
  });

  test("rescales for a DPI change and restores fully inside the matching monitor work area", () => {
    const state = createDesktopWindowState({ x: 100, y: 80, width: 1200, height: 900 }, [display()], false);
    const restored = restoreDesktopWindowState(state, [display({ workArea: { x: 0, y: 0, width: 1600, height: 900 }, scaleFactor: 1.5 })], { width: 760, height: 560 });
    expect(restored).toEqual({
      frame: { x: 111, y: 171, width: 800, height: 600 },
      maximized: false,
    });
  });

  test("falls back to the primary monitor when the saved display was disconnected", () => {
    const saved = createDesktopWindowState({ x: 2050, y: 100, width: 1000, height: 700 }, [display({ id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, isPrimary: false })]);
    const restored = restoreDesktopWindowState(saved, [display({ bounds: { x: -1280, y: 0, width: 1280, height: 800 }, workArea: { x: -1280, y: 0, width: 1280, height: 760 } })], { width: 760, height: 560 });
    expect(restored?.frame).toEqual({ x: -1240, y: 18, width: 1000, height: 700 });
  });

  test("caps restored dimensions to a smaller work area and rejects invalid state or missing displays", () => {
    const saved = createDesktopWindowState({ x: 0, y: 0, width: 1600, height: 900 }, [display()]);
    const small = display({ bounds: { x: 0, y: 0, width: 720, height: 520 }, workArea: { x: 0, y: 0, width: 720, height: 500 } });
    expect(restoreDesktopWindowState(saved, [small], { width: 760, height: 560 })?.frame).toEqual({ x: 0, y: 0, width: 720, height: 500 });
    expect(restoreDesktopWindowState({ ...saved, version: 2 }, [display()], { width: 760, height: 560 })).toBeNull();
    expect(restoreDesktopWindowState(saved, [], { width: 760, height: 560 })).toBeNull();
    expect(createDesktopWindowState({ x: 0, y: 0, width: Number.NaN, height: 600 }, [display()])).toBeNull();
  });

  test("centers and bounds first-run defaults to the primary work area", () => {
    const small = display({ bounds: { x: 0, y: 0, width: 720, height: 520 }, workArea: { x: 0, y: 0, width: 720, height: 500 } });
    expect(defaultDesktopWindowFrame([small], { width: 1440, height: 940 }, { width: 760, height: 560 })).toEqual({ x: 0, y: 0, width: 720, height: 500 });
    expect(defaultDesktopWindowFrame([], { width: 1440, height: 940 }, { width: 760, height: 560 })).toBeNull();
  });

  test("atomically writes and defensively reads app-data state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-window-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "window-state.json");
    const state = createDesktopWindowState({ x: 50, y: 70, width: 1200, height: 800 }, [display()], true)!;
    await writeDesktopWindowState(path, state);
    expect(await readDesktopWindowState(path)).toEqual(state);
    writeDesktopWindowStateSync(path, { ...state, maximized: false });
    expect(await readDesktopWindowState(path)).toEqual({ ...state, maximized: false });

    await writeFile(path, "x".repeat(MAX_WINDOW_STATE_BYTES + 1));
    expect(await readDesktopWindowState(path)).toBeNull();
  });

  test("debounces native move/resize events and flushes the latest frame on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-window-events-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "window-state.json");
    let frame = { x: 20, y: 30, width: 1200, height: 800 };
    const handlers = new Map<string, () => void>();
    const fakeWindow = {
      getFrame: () => frame,
      isMaximized: () => false,
      on: (name: string, handler: () => void) => { handlers.set(name, handler); },
    };
    const stop = startDesktopWindowStatePersistence(fakeWindow, path, () => [display()], () => undefined);
    frame = { x: 90, y: 110, width: 1100, height: 760 };
    handlers.get("move")?.();
    handlers.get("resize")?.();
    handlers.get("close")?.();
    stop();
    expect(await readDesktopWindowState(path)).toEqual(createDesktopWindowState(frame, [display()], false));
  });

  test("ignores malformed persisted JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ba-spine-window-state-invalid-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "window-state.json");
    await writeFile(path, "{broken");
    expect(await readDesktopWindowState(path)).toBeNull();
  });
});
