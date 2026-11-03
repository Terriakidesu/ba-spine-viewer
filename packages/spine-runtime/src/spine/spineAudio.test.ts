import { expect, test } from "bun:test";
import { preloadSpineAudio, spineAudioPathCandidates } from "./spineAudio";

test("audio path candidates are shared across browser and desktop sources", () => {
  expect(spineAudioPathCandidates("./audios\\voicelines\\Aru\\line.ogg")).toEqual([
    "audios/voicelines/Aru/line.ogg",
    "Aru/line.ogg",
    "voicelines/Aru/line.ogg",
    "line.ogg",
  ]);
});

test("audio preload starts immediately and resolves when playback can begin", async () => {
  const listeners = new Map<string, EventListener>();
  let loads = 0;
  const audio = {
    preload: "none",
    readyState: 0,
    src: "",
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    load() { loads++; },
  } as unknown as HTMLAudioElement;
  const prepared = preloadSpineAudio(
    new File(["audio"], "line.ogg"),
    () => audio,
    () => "blob:preloaded-line",
  );

  expect(audio.preload).toBe("auto");
  expect(audio.src).toBe("blob:preloaded-line");
  expect(loads).toBe(1);
  expect(listeners.has("canplay")).toBe(true);
  let ready = false;
  void prepared.ready.then(() => { ready = true; });
  expect(ready).toBe(false);
  listeners.get("canplay")?.(new Event("canplay"));
  expect(await prepared.ready).toBe(true);
  expect(ready).toBe(true);
  expect(listeners.size).toBe(0);
});

test("audio preload settles as unavailable when the media element errors", async () => {
  const listeners = new Map<string, EventListener>();
  const audio = {
    preload: "none",
    readyState: 0,
    src: "",
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    load() {},
  } as unknown as HTMLAudioElement;
  const prepared = preloadSpineAudio(new File(["audio"], "broken.ogg"), () => audio, () => "blob:broken-line");

  listeners.get("error")?.(new Event("error"));
  expect(await prepared.ready).toBe(false);
  expect(listeners.size).toBe(0);
});
