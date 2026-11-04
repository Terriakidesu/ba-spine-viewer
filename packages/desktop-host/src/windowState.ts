import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_WINDOW_STATE_BYTES = 4096;

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDisplay {
  id: number;
  bounds: WindowRect;
  workArea: WindowRect;
  scaleFactor: number;
  isPrimary?: boolean;
}

export interface DesktopWindowState {
  version: 1;
  frame: WindowRect;
  displayId: number;
  scaleFactor: number;
  workArea: WindowRect;
  maximized: boolean;
}

export interface RestoredDesktopWindowState {
  frame: WindowRect;
  maximized: boolean;
}

export interface WindowMinimumSize {
  width: number;
  height: number;
}

/** Keep a native resize minimum within the work area of the window's current display. */
export function effectiveWindowMinimumSize(
  frame: WindowRect,
  displays: readonly WindowDisplay[],
  minimumSize: WindowMinimumSize,
): WindowMinimumSize {
  const candidates = usableDisplays(displays);
  if (candidates.length === 0) return { ...minimumSize };
  const target = candidates.reduce((best, candidate) => {
    const overlap = intersectionArea(frame, candidate.workArea);
    return overlap > best.overlap ? { candidate, overlap } : best;
  }, {
    candidate: candidates.find(({ display }) => display.isPrimary) ?? candidates[0]!,
    overlap: -1,
  }).candidate;
  return {
    width: Math.max(1, Math.min(Math.floor(minimumSize.width), Math.floor(target.workArea.width))),
    height: Math.max(1, Math.min(Math.floor(minimumSize.height), Math.floor(target.workArea.height))),
  };
}

export interface WindowStateEventSource {
  getFrame(): WindowRect;
  isMaximized(): boolean;
  on(name: string, handler: () => void): void;
}

export interface NativeResizableWindow extends WindowStateEventSource {
  setSize(width: number, height: number): void;
}

/**
 * Electrobun 2.0.5 does not expose an OS-level minimum-size API. Correct a
 * below-minimum resize immediately through its supported native setSize API.
 */
export function enforceDesktopWindowMinimum(
  window: NativeResizableWindow,
  displays: readonly WindowDisplay[],
  minimumSize: WindowMinimumSize,
): boolean {
  const frame = window.getFrame();
  const minimum = effectiveWindowMinimumSize(frame, displays, minimumSize);
  const width = Math.max(frame.width, minimum.width);
  const height = Math.max(frame.height, minimum.height);
  if (width === frame.width && height === frame.height) return false;
  window.setSize(width, height);
  return true;
}

function validRect(value: unknown, minimumSize = 1): value is WindowRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<WindowRect>;
  return Number.isFinite(rect.x) && Math.abs(rect.x!) <= 100_000
    && Number.isFinite(rect.y) && Math.abs(rect.y!) <= 100_000
    && Number.isFinite(rect.width) && rect.width! >= minimumSize && rect.width! <= 20_000
    && Number.isFinite(rect.height) && rect.height! >= minimumSize && rect.height! <= 20_000;
}

function validScaleFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 8;
}

function usableDisplay(display: WindowDisplay): { display: WindowDisplay; workArea: WindowRect; scaleFactor: number } | null {
  if (!display || !Number.isSafeInteger(display.id) || !validRect(display.bounds) || !validScaleFactor(display.scaleFactor)) return null;
  const workArea = validRect(display.workArea) ? display.workArea : display.bounds;
  return { display, workArea, scaleFactor: display.scaleFactor };
}

function usableDisplays(displays: readonly WindowDisplay[]) {
  return displays.map(usableDisplay).filter((display): display is NonNullable<typeof display> => display !== null);
}

function intersectionArea(left: WindowRect, right: WindowRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

/** Capture a bounded, versioned native frame in the logical coordinates of its best-overlapping display. */
export function createDesktopWindowState(
  frame: WindowRect,
  displays: readonly WindowDisplay[],
  maximized = false,
): DesktopWindowState | null {
  if (!validRect(frame, 100)) return null;
  const candidates = usableDisplays(displays);
  if (candidates.length === 0) return null;
  const selected = candidates.reduce((best, candidate) => {
    const overlap = intersectionArea(frame, candidate.workArea);
    return overlap > best.overlap ? { candidate, overlap } : best;
  }, { candidate: candidates.find(({ display }) => display.isPrimary) ?? candidates[0]!, overlap: -1 }).candidate;
  return {
    version: 1,
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    displayId: selected.display.id,
    scaleFactor: selected.scaleFactor,
    workArea: { ...selected.workArea },
    maximized,
  };
}

function parseWindowState(value: unknown): DesktopWindowState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<DesktopWindowState>;
  if (state.version !== 1 || !validRect(state.frame, 100) || !validRect(state.workArea, 200)
    || !Number.isSafeInteger(state.displayId) || !validScaleFactor(state.scaleFactor)
    || typeof state.maximized !== "boolean") return null;
  return state as DesktopWindowState;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Center a requested first-run size within the primary display, shrinking it when the work area is smaller. */
export function defaultDesktopWindowFrame(
  displays: readonly WindowDisplay[],
  requestedSize: Pick<WindowRect, "width" | "height">,
  minimumSize: WindowMinimumSize,
): WindowRect | null {
  const candidates = usableDisplays(displays);
  if (candidates.length === 0 || !Number.isFinite(requestedSize.width) || !Number.isFinite(requestedSize.height)
    || requestedSize.width < 100 || requestedSize.height < 100) return null;
  const target = candidates.find(({ display }) => display.isPrimary) ?? candidates[0]!;
  const available = target.workArea;
  const width = clamp(requestedSize.width, Math.min(Math.max(1, minimumSize.width), available.width), available.width);
  const height = clamp(requestedSize.height, Math.min(Math.max(1, minimumSize.height), available.height), available.height);
  return {
    x: Math.round(available.x + (available.width - width) / 2),
    y: Math.round(available.y + (available.height - height) / 2),
    width,
    height,
  };
}

/** Restore to a connected display, rescale logical dimensions for DPI changes, and keep the whole frame in its work area. */
export function restoreDesktopWindowState(
  value: unknown,
  displays: readonly WindowDisplay[],
  minimumSize: WindowMinimumSize,
): RestoredDesktopWindowState | null {
  const state = parseWindowState(value);
  const candidates = usableDisplays(displays);
  if (!state || candidates.length === 0) return null;

  const target = candidates.find(({ display }) => display.id === state.displayId)
    ?? candidates.find(({ display }) => display.isPrimary)
    ?? candidates[0]!;
  const scale = clamp(state.scaleFactor / target.scaleFactor, 0.5, 2);
  const available = target.workArea;
  const minimumWidth = Math.min(Math.max(1, minimumSize.width), available.width);
  const minimumHeight = Math.min(Math.max(1, minimumSize.height), available.height);
  const width = clamp(Math.round(state.frame.width * scale), minimumWidth, available.width);
  const height = clamp(Math.round(state.frame.height * scale), minimumHeight, available.height);
  const oldHorizontalRange = Math.max(1, state.workArea.width - state.frame.width);
  const oldVerticalRange = Math.max(1, state.workArea.height - state.frame.height);
  const horizontalPosition = clamp((state.frame.x - state.workArea.x) / oldHorizontalRange, 0, 1);
  const verticalPosition = clamp((state.frame.y - state.workArea.y) / oldVerticalRange, 0, 1);

  return {
    frame: {
      x: Math.round(available.x + (available.width - width) * horizontalPosition),
      y: Math.round(available.y + (available.height - height) * verticalPosition),
      width,
      height,
    },
    maximized: state.maximized,
  };
}

/** Load untrusted local state defensively; invalid, oversized, or non-regular files fall back to defaults. */
export async function readDesktopWindowState(path: string): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WINDOW_STATE_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function stateContents(state: DesktopWindowState): string {
  const contents = JSON.stringify(state);
  if (Buffer.byteLength(contents, "utf8") > MAX_WINDOW_STATE_BYTES) throw new Error("Window state exceeds its size limit.");
  return contents;
}

/** Atomically replace the tiny state file after a debounced move or resize. */
export async function writeDesktopWindowState(path: string, state: DesktopWindowState): Promise<void> {
  const contents = stateContents(state);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Synchronous final flush for process exit, using the latest already-captured frame. */
export function writeDesktopWindowStateSync(path: string, state: DesktopWindowState): void {
  const contents = stateContents(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* the atomic rename already consumed it */ }
  }
}

/** Debounce native move/resize events, then flush the most recently captured state on close or process exit. */
export function startDesktopWindowStatePersistence(
  window: WindowStateEventSource,
  path: string,
  getDisplays: () => readonly WindowDisplay[],
  onError: (error: unknown) => void,
  debounceMs = 400,
): () => void {
  let lastState = createDesktopWindowState(window.getFrame(), getDisplays(), window.isMaximized());
  let timer: ReturnType<typeof setTimeout> | null = null;
  function capture() {
    const state = createDesktopWindowState(window.getFrame(), getDisplays(), window.isMaximized());
    if (state) lastState = state;
  }
  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!lastState) return;
    try { writeDesktopWindowStateSync(path, lastState); }
    catch (error) { onError(error); }
  }
  function schedule() {
    capture();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastState) void writeDesktopWindowState(path, lastState).catch(onError);
    }, debounceMs);
  }
  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("close", flush);
  process.on("exit", flush);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    process.off("exit", flush);
  };
}
