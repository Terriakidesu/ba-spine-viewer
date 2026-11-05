import { SpineRenderer, type SpineFiles, type SpineMeta } from "@ba-spine/spine-runtime/spine/spineRuntime";
import { useEffect, useRef, useState } from "react";
import type { DesktopAssetSource } from "./desktopSource";

const THUMBNAIL_WIDTH = 256;
const THUMBNAIL_HEIGHT = 192;
const FACE_THUMBNAIL_SIZE = 192;
const THUMBNAIL_CACHE_VERSION = { lobby: "lobby-v2", face: "face-v1" } as const;
const MAX_IMAGE_BYTES = 1024 * 1024;

export type ViewerThumbnailKind = keyof typeof THUMBNAIL_CACHE_VERSION;

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

function cropFaceCanvas(source: HTMLCanvasElement, bounds: { x: number; y: number; width: number; height: number }): HTMLCanvasElement | null {
  const side = Math.min(Math.min(source.width, source.height), Math.max(bounds.width, bounds.height) * 1.55);
  if (![bounds.x, bounds.y, bounds.width, bounds.height, side].every(Number.isFinite)
    || bounds.width < 10 || bounds.height < 10 || side < 14
    || bounds.width > source.width * 0.92 && bounds.height > source.height * 0.92) return null;
  const output = document.createElement("canvas");
  output.width = FACE_THUMBNAIL_SIZE;
  output.height = FACE_THUMBNAIL_SIZE;
  const context = output.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#102432";
  context.fillRect(0, 0, output.width, output.height);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const sourceX = Math.max(0, Math.min(source.width - side, centerX - side / 2));
  const sourceY = Math.max(0, Math.min(source.height - side, centerY - side / 2));
  context.drawImage(source, sourceX, sourceY, side, side, 0, 0, output.width, output.height);
  return output;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Thumbnail request canceled.", "AbortError");
}

async function renderSpineThumbnail(files: SpineFiles, directory: string, kind: ViewerThumbnailKind, signal: AbortSignal): Promise<Blob> {
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
    renderer.setCameraMode("fit");
    renderer.setPlaying(false);
    renderer.setAnimation(meta.idleAnimation ?? meta.defaultAnimation);
    if (!renderer.renderFrameForCapture()) throw new Error("The lobby renderer was not ready for thumbnail capture.");
    const head = kind === "face" ? renderer.getHeadCanvasRect() : null;
    const faceCanvas = head ? cropFaceCanvas(canvas, head) : null;
    // If head art is absent or the crop is unusable, cache the full scene in the face namespace.
    const imageCanvas = faceCanvas ?? canvas;
    const image = await canvasBlob(imageCanvas, "image/webp", 0.82).catch(() => canvasBlob(imageCanvas, "image/png"));
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
export async function getViewerThumbnail(source: DesktopAssetSource, directory: string, kind: ViewerThumbnailKind, signal: AbortSignal): Promise<Blob | null> {
  const fingerprint = await source.getThumbnailFingerprint(directory, signal);
  if (signal.aborted) throw abortError(signal);
  const cacheFingerprint = `${THUMBNAIL_CACHE_VERSION[kind]}:${fingerprint}`;
  return thumbnailQueue.run(async () => {
    const cached = await source.getThumbnail(directory, cacheFingerprint, signal);
    if (cached) return cached;
    const files = await source.getThumbnailFiles(directory, signal);
    if (signal.aborted) throw abortError(signal);
    const image = await renderSpineThumbnail(files, directory, kind, signal);
    if (signal.aborted) throw abortError(signal);
    const latestFingerprint = await source.getThumbnailFingerprint(directory, signal);
    if (latestFingerprint !== fingerprint) return null;
    await source.putThumbnail(directory, cacheFingerprint, image, signal);
    return image;
  }, signal);
}

export function getLobbyThumbnail(source: DesktopAssetSource, directory: string, signal: AbortSignal) {
  return getViewerThumbnail(source, directory, "lobby", signal);
}

export function getFaceThumbnail(source: DesktopAssetSource, directory: string, signal: AbortSignal) {
  return getViewerThumbnail(source, directory, "face", signal);
}

interface LobbyThumbnailProps {
  source: DesktopAssetSource | null;
  directory: string;
  kind?: ViewerThumbnailKind;
}

/** Lazy row thumbnail. It does no file I/O or rendering until it nears the visible list. */
export function LobbyThumbnail({ source, directory, kind = "lobby" }: LobbyThumbnailProps) {
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
      void getViewerThumbnail(source, directory, kind, controller.signal).then((blob) => {
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
  }, [directory, kind, source]);

  return <span ref={elementRef} className={`spine-lobby-thumbnail${kind === "face" ? " is-face-thumbnail" : ""}${imageUrl ? " has-image" : ""}`} aria-hidden="true">
    {imageUrl && <img src={imageUrl} alt="" loading="lazy" />}
  </span>;
}
