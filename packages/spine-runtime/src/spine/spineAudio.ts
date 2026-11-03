/** Resolve the path spellings used by browser folders and desktop catalogs. */
export function spineAudioPathCandidates(path: string): string[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  const withoutAudioRoot = normalized.replace(/^audios\/voicelines\//i, "");
  const withoutAudios = normalized.replace(/^audios\//i, "");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return [...new Set([normalized, withoutAudioRoot, withoutAudios, basename])].filter(Boolean);
}

export interface PreloadedSpineAudio {
  audio: HTMLAudioElement;
  url: string;
  ready: Promise<boolean>;
  cancel: () => void;
}

/** Resolve true when playback can start, or false when this source failed to load. */
export function preloadSpineAudio(
  file: File,
  createAudio: () => HTMLAudioElement = () => new Audio(),
  createUrl: (file: File) => string = (value) => URL.createObjectURL(value),
): PreloadedSpineAudio {
  const url = createUrl(file);
  const audio = createAudio();
  audio.preload = "auto";
  let cancel: () => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    let settled = false;
    let canPlay: EventListener;
    let failed: EventListener;
    let aborted: EventListener;
    const finish = (playable: boolean) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("canplay", canPlay);
      audio.removeEventListener("error", failed);
      audio.removeEventListener("abort", aborted);
      resolve(playable);
    };
    canPlay = () => finish(true);
    failed = () => finish(false);
    aborted = () => finish(false);
    cancel = () => finish(false);
    audio.addEventListener("canplay", canPlay);
    audio.addEventListener("error", failed);
    audio.addEventListener("abort", aborted);
    audio.src = url;
    try {
      audio.load();
      if (audio.readyState >= 3) finish(true);
    } catch {
      finish(false);
    }
  });
  return { audio, url, ready, cancel };
}

export function releasePreloadedSpineAudio(preloaded: PreloadedSpineAudio): void {
  const { audio, url } = preloaded;
  preloaded.cancel();
  audio.pause();
  audio.onplay = null;
  audio.onended = null;
  audio.onerror = null;
  audio.removeAttribute("src");
  audio.load();
  URL.revokeObjectURL(url);
}
