import { describe, expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegVideoRecorder, ffmpegAudioMixFilterGraph, ffmpegEncoderAttempts } from "./ffmpegVideoRecorder";

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

describe("FFmpeg recording finalization", () => {
  test("reports the active encoder during encoding progress", () => {
    const recorder = new FfmpegVideoRecorder("unused-ffmpeg.exe", () => null);
    const session = {
      id: "encoder-status",
      phase: "encoding" as const,
      encodeProgress: 0.42,
      activeEncoder: "h264_nvenc",
    };
    (recorder as unknown as { sessions: Map<string, typeof session> }).sessions.set(session.id, session);

    expect(recorder.status(session.id)).toEqual({ phase: "encoding", progress: 0.42, encoder: "h264_nvenc" });
  });

  test("coalesces repeated finish requests for the same session", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ba-spine-video-finish-"));
    const framesPath = join(temporaryDirectory, "frames.mjpg");
    const frameWriter = createWriteStream(framesPath, { flags: "wx" });
    await new Promise<void>((resolve, reject) => {
      frameWriter.once("open", resolve);
      frameWriter.once("error", reject);
    });
    const recorder = new FfmpegVideoRecorder("unused-ffmpeg.exe", () => null);
    const session = {
      id: "repeat-finish",
      exportDirectory: temporaryDirectory,
      temporaryDirectory,
      filename: "recording.mp4",
      width: 1280,
      height: 720,
      frameRate: 30,
      format: "mp4" as const,
      framesPath,
      frameWriter,
      frameCount: 1,
      frameBytes: 0,
      audioTracks: [],
      audioBytes: 0,
      phase: "rendering" as const,
      encodeProgress: 0,
      socket: null,
      socketClaimed: false,
      finishing: false,
      failure: new Error("Synthetic recording failure."),
    };
    (recorder as unknown as { sessions: Map<string, typeof session> }).sessions.set(session.id, session);

    try {
      const firstFinish = recorder.finish(session.id, 1);
      const repeatedFinish = recorder.finish(session.id, 1);
      expect(repeatedFinish).toBe(firstFinish);
      await expect(firstFinish).rejects.toThrow("Synthetic recording failure.");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
