import { useEffect, useRef, useState } from "react";
import { lobbyThumbnailPath } from "@ba-spine/spine-runtime/spine/spineThumbnail";
import type { DesktopAssetSource } from "./desktopSource";

export type ViewerThumbnailKind = "lobby" | "face";

/** Browsing reads pre-generated PNGs only; a missing image stays a placeholder. */
export async function getViewerThumbnail(source: DesktopAssetSource, directory: string, _kind: ViewerThumbnailKind, signal: AbortSignal): Promise<Blob | null> {
  signal.throwIfAborted();
  const image = await source.getFile(lobbyThumbnailPath(directory), signal);
  signal.throwIfAborted();
  return image;
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

/** Lazy image row. Never creates a renderer or loads skeletons/atlas pages. */
export function LobbyThumbnail({ source, directory, kind = "lobby" }: LobbyThumbnailProps) {
  const [imageUrl, setImageUrl] = useState("");
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setImageUrl("");
    if (!source || !directory) return;
    const controller = new AbortController();
    let started = false;
    let objectUrl = "";
    const start = () => {
      if (started || controller.signal.aborted) return;
      started = true;
      void getViewerThumbnail(source, directory, kind, controller.signal).then((blob) => {
        if (!blob || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      }).catch(() => {
        // Optional images must not block browsing or trigger live generation.
      });
    };
    const target = elementRef.current;
    const observer = typeof IntersectionObserver === "undefined" || !target
      ? null
      : new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          start();
        }
      }, { rootMargin: "100px" });
    if (observer && target) observer.observe(target);
    else start();

    return () => {
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directory, kind, source]);

  return <span ref={elementRef} className={`spine-lobby-thumbnail${kind === "face" ? " is-face-thumbnail" : ""}${imageUrl ? " has-image" : ""}`} aria-hidden="true">
    {imageUrl && <img src={imageUrl} alt="" loading="lazy" onError={() => setImageUrl("")} />}
  </span>;
}
