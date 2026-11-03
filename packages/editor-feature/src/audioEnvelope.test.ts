import { describe, expect, test } from "bun:test";
import { audioEnvelopePeaks } from "./audioEnvelope";

describe("decoded audio envelope", () => {
  test("returns the absolute maximum for each sample bucket", () => {
    const channel = new Float32Array([0, 0.2, -0.8, 0.1, 0, 0.4]);
    expect(audioEnvelopePeaks(channel, 3)).toEqual([channel[1], Math.abs(channel[2]!), Math.abs(channel[5]!)]);
  });

  test("handles empty and shorter-than-display signals", () => {
    expect(audioEnvelopePeaks(new Float32Array(), 4)).toEqual([0, 0, 0, 0]);
    const short = new Float32Array([-0.5, 0.25, 0.9]);
    expect(audioEnvelopePeaks(short, 5)).toEqual([0, Math.abs(short[0]!), 0, short[1], Math.abs(short[2]!)]);
  });

  test("rejects unusable bucket counts", () => {
    expect(() => audioEnvelopePeaks(new Float32Array([1]), 0)).toThrow(RangeError);
    expect(() => audioEnvelopePeaks(new Float32Array([1]), 1.5)).toThrow(RangeError);
  });
});
