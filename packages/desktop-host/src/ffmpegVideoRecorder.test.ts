import { describe, expect, test } from "bun:test";
import { ffmpegAudioMixFilterGraph, ffmpegEncoderAttempts } from "./ffmpegVideoRecorder";

describe("FFmpeg video encoder selection", () => {
  test("prefers available H.264 hardware encoders and keeps a software fallback", () => {
    const attempts = ffmpegEncoderAttempts("mp4", [
      " V....D h264_nvenc NVIDIA NVENC H.264 encoder",
      " V..... h264_qsv Intel Quick Sync Video acceleration",
      " V....D libx264 libx264 H.264 / AVC / MPEG-4 AVC",
    ].join("\n"));

    expect(attempts.map(({ name, hardware }) => [name, hardware])).toEqual([
      ["h264_nvenc", true],
      ["h264_qsv", true],
      ["libx264", false],
    ]);
  });

  test("uses VP9 hardware when listed, then a real-time software encoder for WebM", () => {
    const attempts = ffmpegEncoderAttempts("webm", [
      " V..... vp9_qsv VP9 video (Intel Quick Sync Video acceleration)",
      " V....D libvpx-vp9 libvpx VP9",
    ].join("\n"));

    expect(attempts.map(({ name }) => name)).toEqual(["vp9_qsv", "libvpx-vp9"]);
    expect(attempts[0]?.hardware).toBe(true);
    expect(attempts[0]?.args).toContain("-global_quality:v");
    expect(attempts[1]?.args).toContain("realtime");
  });

  test("does not advertise an encoder that FFmpeg did not list", () => {
    expect(ffmpegEncoderAttempts("mp4", " V....D h264_nvenc NVENC").map(({ name }) => name)).toEqual(["h264_nvenc"]);
    expect(ffmpegEncoderAttempts("webm", "")).toEqual([]);
  });
});

describe("FFmpeg timestamped audio mixing", () => {
  test("delays authored clips, applies per-track gain, and trims the mix to video duration", () => {
    const mix = ffmpegAudioMixFilterGraph([
      { start: 2.25, duration: 1.5, volume: 0.65 },
      { start: 0, duration: 4, volume: 1 },
    ], 5);

    expect(mix).toEqual({
      graph: "[1:a:0]atrim=start=0:duration=1.500000,asetpts=PTS-STARTPTS,volume=0.6500,adelay=2250:all=1[a0];[2:a:0]atrim=start=0:duration=4.000000,asetpts=PTS-STARTPTS,volume=1.0000,adelay=0:all=1[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=5.000000[aout]",
      output: "[aout]",
    });
  });

  test("does not add an audio stream when no audio tracks were scheduled", () => {
    expect(ffmpegAudioMixFilterGraph([], 5)).toBeNull();
  });
});
