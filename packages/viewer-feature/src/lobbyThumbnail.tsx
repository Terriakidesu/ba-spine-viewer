import { SpineRenderer, type SpineFiles, type SpineMeta } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { useEffect, useRef, useState } from "react";
import type { DesktopAssetSource } from "./desktopSource";

const THUMBNAIL_WIDTH = 256;
const THUMBNAIL_HEIGHT = 192;
const MAX_IMAGE_BYTES = 1024 * 1024;

class SerialThumbnailQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const result = this.tail.then(() => {
      if (signal.aborted) throw new DOMException("Thumbnail request canceled.", "AbortError");
      return work();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const thumbnailQueue = new SerialThumbnailQueue();

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the lobby thumbnail.")), type, quality);
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Thumbnail request canceled.", "AbortError");
}

async function renderSpineThumbnail(files: SpineFiles, directory: string, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw abortError(signal);
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  canvas.style.cssText = `position:fixed;left:-10000px;top:0;width:${THUMBNAIL_WIDTH}px;height:${THUMBNAIL_HEIGHT}px;pointer-events:none;`;
  document.body.append(canvas);

  let renderer: SpineRenderer | null = null;
  let resolveMeta!: (meta: SpineMeta) => void;
  let rejectMeta!: (error: Error) => void;
  const ready = new Promise<SpineMeta>((resolve, reject) => { resolveMeta = resolve; rejectMeta = reject; });
  const onAbort = () => {
    renderer?.clear();
    rejectMeta(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    renderer = new SpineRenderer(canvas, {
      onMeta: (meta) => { if (meta) resolveMeta(meta); },
      onProgress: () => undefined,
      onLoading: () => undefined,
      onError: (error) => { if (error) rejectMeta(error); },
    }, { preserveDrawingBuffer: true });
    const loading = renderer.load(files, directory);
    const meta = await ready;
    await loading;
    if (signal.aborted) throw abortError(signal);
    renderer.setPlaying(false);
    renderer.setAnimation(meta.idleAnimation ?? meta.defaultAnimation);
    if (!renderer.renderFrameForCapture()) throw new Error("The lobby renderer was not ready for thumbnail capture.");
    const image = await canvasBlob(canvas, "image/webp", 0.82).catch(() => canvasBlob(canvas, "image/png"));
    if (image.size <= 0 || image.size > MAX_IMAGE_BYTES) throw new Error("The generated thumbnail is empty or exceeds 1 MB.");
    if (signal.aborted) throw abortError(signal);
    return image;
  } finally {
    signal.removeEventListener("abort", onAbort);
    renderer?.dispose();
    canvas.remove();
  }
}

/** Load a persisted preview, generating it in a single asynchronous WebGL lane on cache miss. */
export async function getLobbyThumbnail(source: DesktopAssetSource, directory: string, signal: AbortSignal): Promise<Blob | null> {
  const fingerprint = await source.getThumbnailFingerprint(directory, signal);
  if (signal.aborted) throw abortError(signal);
  return thumbnailQueue.run(async () => {
    const cached = await source.getThumbnail(directory, fingerprint, signal);
    if (cached) return cached;
    await source.invalidateThumbnail(directory, signal);
    const files = await source.getThumbnailFiles(directory, signal);
    if (signal.aborted) throw abortError(signal);
    const image = await renderSpineThumbnail(files, directory, signal);
    if (signal.aborted) throw abortError(signal);
    const latestFingerprint = await source.getThumbnailFingerprint(directory, signal);
    if (latestFingerprint !== fingerprint) return null;
    await source.putThumbnail(directory, fingerprint, image, signal);
    return image;
  }, signal);
}

interface LobbyThumbnailProps {
  source: DesktopAssetSource | null;
  directory: string;
}

/** Lazy row thumbnail. It does no file I/O or rendering until it nears the visible list. */
export function LobbyThumbnail({ source, directory }: LobbyThumbnailProps) {
  const [imageUrl, setImageUrl] = useState("");
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setImageUrl("");
    if (!source || !directory) return;
    const controller = new AbortController();
    let started = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    let objectUrl = "";
    const start = () => {
      if (started || controller.signal.aborted) return;
      started = true;
      void getLobbyThumbnail(source, directory, controller.signal).then((blob) => {
        if (!blob || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      }).catch(() => {
        // Thumbnails are optional: a failed render never blocks lobby browsing or playback.
      });
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const schedule = () => {
      if (idleWindow.requestIdleCallback) idleHandle = idleWindow.requestIdleCallback(start, { timeout: 1500 });
      else timeoutHandle = window.setTimeout(start, 180);
    };
    const target = elementRef.current;
    const observer = typeof IntersectionObserver === "undefined" || !target
      ? null
      : new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          schedule();
        }
      }, { rootMargin: "100px" });
    if (observer && target) observer.observe(target);
    else schedule();

    return () => {
      controller.abort();
      observer?.disconnect();
      if (idleHandle !== null) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directory, source]);

  return <span ref={elementRef} className={`spine-lobby-thumbnail${imageUrl ? " has-image" : ""}`} aria-hidden="true">
    {imageUrl && <img src={imageUrl} alt="" loading="lazy" />}
  </span>;
}
