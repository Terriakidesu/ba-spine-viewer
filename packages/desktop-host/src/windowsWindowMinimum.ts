import { cc, type Pointer } from "bun:ffi";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Electrobun 2.0.5 exposes the HWND but has no native minimum-size API. Its
 * window belongs to Electrobun's event-loop thread, so a JSCallback subclass
 * would be unsafe here. This native thread-specific hook updates WM_GETMINMAXINFO
 * synchronously on the owning Windows thread without calling into JavaScript.
 */
export const WINDOWS_WINDOW_MINIMUM_SOURCE = String.raw`
typedef void* HWND;
typedef void* HHOOK;
typedef void* HMONITOR;
typedef void* HINSTANCE;
typedef unsigned int UINT;
typedef unsigned int DWORD;
typedef unsigned long long WPARAM;
typedef long long LPARAM;
typedef long long LRESULT;
typedef int BOOL;
typedef int LONG;

typedef struct { LONG x; LONG y; } BA_POINT;
typedef struct { LONG left; LONG top; LONG right; LONG bottom; } BA_RECT;
typedef struct {
  DWORD cbSize;
  BA_RECT rcMonitor;
  BA_RECT rcWork;
  DWORD dwFlags;
} BA_MONITORINFO;
typedef struct {
  BA_POINT ptReserved;
  BA_POINT ptMaxSize;
  BA_POINT ptMaxPosition;
  BA_POINT ptMinTrackSize;
  BA_POINT ptMaxTrackSize;
} BA_MINMAXINFO;
typedef struct {
  LPARAM lParam;
  WPARAM wParam;
  UINT message;
  HWND hwnd;
} BA_CWPSTRUCT;
typedef LRESULT (*BA_HOOKPROC)(int code, WPARAM wParam, LPARAM lParam);

extern HHOOK SetWindowsHookExW(int idHook, BA_HOOKPROC procedure, HINSTANCE module, DWORD threadId);
extern BOOL UnhookWindowsHookEx(HHOOK hook);
extern LRESULT CallNextHookEx(HHOOK hook, int code, WPARAM wParam, LPARAM lParam);
extern DWORD GetWindowThreadProcessId(HWND window, DWORD* processId);
extern DWORD GetCurrentProcessId(void);
extern UINT GetDpiForWindow(HWND window);
extern HMONITOR MonitorFromWindow(HWND window, DWORD flags);
extern BOOL GetMonitorInfoW(HMONITOR monitor, BA_MONITORINFO* info);
extern HWND CreateWindowExW(DWORD exStyle, const unsigned short* className, const unsigned short* title, DWORD style, int x, int y, int width, int height, HWND parent, void* menu, HINSTANCE instance, void* parameter);
extern BOOL DestroyWindow(HWND window);

#define BA_WH_CALLWNDPROC 4
#define BA_WM_GETMINMAXINFO 0x0024
#define BA_WM_NCDESTROY 0x0082
#define BA_MONITOR_DEFAULTTONEAREST 2

static HWND baTargetWindow;
static HHOOK baMinimumHook;
static int baMinimumWidthDip;
static int baMinimumHeightDip;

static int baDipsToPixels(int dips, UINT dpi, int availablePixels) {
  if (dpi == 0) dpi = 96;
  long long pixels = ((long long)dips * (long long)dpi + 95) / 96;
  if (pixels < 1) pixels = 1;
  if (availablePixels > 0 && pixels > availablePixels) pixels = availablePixels;
  return (int)pixels;
}

void baSpineApplyMinimum(void* minimumInfo, int widthDip, int heightDip, UINT dpi, int workWidthPixels, int workHeightPixels) {
  if (!minimumInfo || widthDip < 1 || heightDip < 1) return;
  BA_MINMAXINFO* info = (BA_MINMAXINFO*)minimumInfo;
  info->ptMinTrackSize.x = baDipsToPixels(widthDip, dpi, workWidthPixels);
  info->ptMinTrackSize.y = baDipsToPixels(heightDip, dpi, workHeightPixels);
}

static void baApplyMonitorMinimum(HWND window, BA_MINMAXINFO* info) {
  if (!info) return;
  UINT dpi = GetDpiForWindow(window);
  int workWidth = 0;
  int workHeight = 0;
  HMONITOR monitor = MonitorFromWindow(window, BA_MONITOR_DEFAULTTONEAREST);
  BA_MONITORINFO monitorInfo;
  monitorInfo.cbSize = (DWORD)sizeof(BA_MONITORINFO);
  if (monitor && GetMonitorInfoW(monitor, &monitorInfo)) {
    workWidth = monitorInfo.rcWork.right - monitorInfo.rcWork.left;
    workHeight = monitorInfo.rcWork.bottom - monitorInfo.rcWork.top;
  }
  baSpineApplyMinimum(info, baMinimumWidthDip, baMinimumHeightDip, dpi, workWidth, workHeight);
}

static LRESULT baWindowMinimumHookProc(int code, WPARAM wParam, LPARAM lParam) {
  LRESULT result = CallNextHookEx(baMinimumHook, code, wParam, lParam);
  int destroyTarget = 0;
  if (code >= 0) {
    BA_CWPSTRUCT* message = (BA_CWPSTRUCT*)lParam;
    if (message && message->hwnd == baTargetWindow) {
      if (message->message == BA_WM_GETMINMAXINFO && message->lParam) {
        baApplyMonitorMinimum(message->hwnd, (BA_MINMAXINFO*)message->lParam);
      } else if (message->message == BA_WM_NCDESTROY) {
        destroyTarget = 1;
      }
    }
  }

  if (destroyTarget && baMinimumHook) {
    UnhookWindowsHookEx(baMinimumHook);
    baMinimumHook = (HHOOK)0;
    baTargetWindow = (HWND)0;
  }
  return result;
}

int baSpineInstallWindowMinimum(void* nativeWindow, int widthDip, int heightDip) {
  HWND window = (HWND)nativeWindow;
  if (!window || widthDip < 1 || heightDip < 1) return 0;
  if (baMinimumHook && baTargetWindow == window) {
    baMinimumWidthDip = widthDip;
    baMinimumHeightDip = heightDip;
    return 1;
  }
  if (baMinimumHook) {
    UnhookWindowsHookEx(baMinimumHook);
    baMinimumHook = (HHOOK)0;
    baTargetWindow = (HWND)0;
  }

  DWORD processId = 0;
  DWORD threadId = GetWindowThreadProcessId(window, &processId);
  if (!threadId || processId != GetCurrentProcessId()) return 0;

  baTargetWindow = window;
  baMinimumWidthDip = widthDip;
  baMinimumHeightDip = heightDip;
  baMinimumHook = SetWindowsHookExW(BA_WH_CALLWNDPROC, baWindowMinimumHookProc, (HINSTANCE)0, threadId);
  if (!baMinimumHook) {
    baTargetWindow = (HWND)0;
    return 0;
  }
  return 1;
}

int baSpineRemoveWindowMinimum(void* nativeWindow) {
  if (!baMinimumHook || (nativeWindow && baTargetWindow != (HWND)nativeWindow)) return 1;
  int removed = UnhookWindowsHookEx(baMinimumHook) != 0;
  baMinimumHook = (HHOOK)0;
  baTargetWindow = (HWND)0;
  return removed;
}

int baSpineTestHookRegistration(void) {
  static const unsigned short className[] = {'S', 'T', 'A', 'T', 'I', 'C', 0};
  static const unsigned short title[] = {0};
  HWND window = CreateWindowExW(0, className, title, 0, 0, 0, 1, 1, (HWND)0, (void*)0, (HINSTANCE)0, (void*)0);
  if (!window) return 0;
  int installed = baSpineInstallWindowMinimum(window, 760, 560);
  baSpineRemoveWindowMinimum(window);
  DestroyWindow(window);
  return installed;
}
`;

interface NativeWindowMinimumBindings {
  install: (window: Pointer, widthDip: number, heightDip: number) => number;
  remove: (window: Pointer | null) => number;
  close: () => void;
}

let bindings: NativeWindowMinimumBindings | null = null;

function nativeBindings(): NativeWindowMinimumBindings {
  if (bindings) return bindings;
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The native minimum-size hook currently supports Windows x64 only.");
  }

  const directory = mkdtempSync(join(tmpdir(), "ba-spine-window-minimum-"));
  const sourcePath = join(directory, "window-minimum.c");
  try {
    writeFileSync(sourcePath, WINDOWS_WINDOW_MINIMUM_SOURCE, "utf8");
    const compiled = cc({
      source: sourcePath,
      library: ["user32", "kernel32"],
      symbols: {
        baSpineInstallWindowMinimum: { args: ["ptr", "int", "int"], returns: "int" },
        baSpineRemoveWindowMinimum: { args: ["ptr"], returns: "int" },
      },
    });
    bindings = {
      install: compiled.symbols.baSpineInstallWindowMinimum,
      remove: compiled.symbols.baSpineRemoveWindowMinimum,
      close: compiled.close,
    };
    return bindings;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Install an OS-level 760x560 logical-pixel minimum, clamped to the current monitor work area. */
export function installWindowsNativeWindowMinimum(
  window: unknown,
  widthDip: number,
  heightDip: number,
): (() => void) | null {
  if (process.platform !== "win32") return null;
  if (!window || typeof window !== "object") return null;
  // BrowserWindow.ptr is documented by Electrobun as its platform FFI escape
  // hatch, although the projected 2.0.5 TypeScript facade omits it.
  const nativePointer = (window as { ptr?: unknown }).ptr;
  if (typeof nativePointer !== "number") return null;
  const nativeWindow = nativePointer as Pointer;
  const native = nativeBindings();
  if (native.install(nativeWindow, widthDip, heightDip) !== 1) return null;

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    native.remove(nativeWindow);
  };
}
