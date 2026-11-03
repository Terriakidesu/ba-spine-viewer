import { expect, test } from "bun:test";
import { audioPlaybackDecision, clampAudioEnd, clampAudioStart, decodedAudioTiming } from "./audioModel";

test("decoded audio timing replaces only the guessed clip end", () => {
  expect(decodedAudioTiming(2, 4.25)).toEqual({ end: 6.25 });
  expect(decodedAudioTiming(2, 0)).toBeNull();
  expect(decodedAudioTiming(Number.NaN, 2)).toBeNull();
});

test("audio edge edits cannot exceed the decoded source duration", () => {
  expect(clampAudioEnd(2, 9, 4.25)).toBe(6.25);
  expect(clampAudioEnd(2, 3, 4.25)).toBe(3);
  expect(clampAudioStart(6.25, 0, 4.25)).toBe(2);
  expect(clampAudioStart(6.25, 4, 4.25)).toBe(4);
});

test("ended audio does not restart until the playhead re-enters or rewinds", () => {
  expect(audioPlaybackDecision({ active: true, playing: true, currentTime: 4.1, previousTime: 4, started: true, ended: true })).toEqual({ seek: false, play: false, started: true });
  expect(audioPlaybackDecision({ active: true, playing: true, currentTime: 2, previousTime: 4, started: true, ended: true })).toEqual({ seek: true, play: true, started: true });
  expect(audioPlaybackDecision({ active: false, playing: true, currentTime: 1, previousTime: 1, started: true, ended: false })).toEqual({ seek: false, play: false, started: false });
});
