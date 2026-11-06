import { describe, expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegVideoRecorder, ffmpegAudioMixFilterGraph, ffmpegEncoderAttempts, ffmpegVideoColorPipelineArgs, parseFfmpegProgressMetrics } from "./ffmpegVideoRecorder";

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

  test("maps quality presets onto every supported encoder control", () => {
    const mp4Encoders = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"]
      .map((name) => ` V..... ${name} encoder`).join("\n");
    const balanced = ffmpegEncoderAttempts("mp4", mp4Encoders, "balanced");
    const high = ffmpegEncoderAttempts("mp4", mp4Encoders, "high");
    const compact = ffmpegEncoderAttempts("mp4", mp4Encoders, "compact");

    expect(balanced.find(({ name }) => name === "h264_nvenc")?.args).toContain("21");
    expect(balanced.find(({ name }) => name === "h264_qsv")?.args).toContain("22");
    expect(balanced.find(({ name }) => name === "libx264")?.args).toContain("21");
    expect(high.find(({ name }) => name === "h264_nvenc")?.args).toContain("18");
    expect(high.find(({ name }) => name === "h264_amf")?.args).toEqual(expect.arrayContaining(["-qp_i:v", "18", "-qp_p:v", "20"]));
    expect(high.find(({ name }) => name === "h264_mf")?.args).toEqual(["-b:v", "12M"]);
    expect(compact.find(({ name }) => name === "h264_nvenc")?.args).toContain("26");
    expect(compact.find(({ name }) => name === "h264_qsv")?.args).toContain("30");
    expect(compact.find(({ name }) => name === "libx264")?.args).toContain("26");

    const webmEncoders = ["vp9_qsv", "libvpx-vp9", "libvpx"].map((name) => ` V..... ${name} encoder`).join("\n");
    const qualityValue = (args: string[]) => {
      const optionIndex = args.findIndex((value) => value === "-global_quality:v" || value === "-crf:v");
      return args[optionIndex + 1];
    };
    expect(ffmpegEncoderAttempts("webm", webmEncoders, "high").map(({ args }) => qualityValue(args)))
      .toEqual(["24", "26", "24"]);
    expect(ffmpegEncoderAttempts("webm", webmEncoders, "compact").map(({ args }) => qualityValue(args)))
      .toEqual(["38", "40", "38"]);
  });
});

describe("FFmpeg progress parsing", () => {
  test("extracts encoded frame, media time, rate, and speed from progress records", () => {
    expect(parseFfmpegProgressMetrics({ frame: "45", out_time_us: "1500000", fps: "27.5", speed: "0.92x" }, 90, 3))
      .toEqual({ frames: 45, progress: 0.5, timeSeconds: 1.5, fps: 27.5, speed: 0.92 });
  });

  test("uses FFmpeg's timestamp when available and clamps output to the planned duration", () => {
    expect(parseFfmpegProgressMetrics({ frame: "150", out_time: "00:00:05.250000", fps: "N/A", speed: "N/A" }, 100, 4))
      .toEqual({ frames: 100, progress: 1, timeSeconds: 4, fps: null, speed: null });
  });

  test("falls back to the legacy FFmpeg out_time_ms field when out_time_us is unavailable", () => {
    expect(parseFfmpegProgressMetrics({ out_time_us: "N/A", out_time_ms: "2750000" }, 100, 5).timeSeconds).toBe(2.75);
  });
});

describe("FFmpeg video color signaling", () => {
  test("converts full-range browser JPEG frames to tagged limited-range BT.709", () => {
    const args = ffmpegVideoColorPipelineArgs("mp4");
    expect(args).toContain("scale=in_range=pc:out_range=tv:in_color_matrix=bt470bg:out_color_matrix=bt709");
    expect(args).toContain("-color_range:v");
    expect(args).toContain("tv");
    expect(args).toContain("-colorspace:v");
    expect(args).toContain("bt709");
    expect(args).toContain("h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1");
  });

  test("does not apply the H.264 bitstream filter to WebM output", () => {
    expect(ffmpegVideoColorPipelineArgs("webm").some((arg) => arg.startsWith("h264_metadata="))).toBe(false);
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
      activeEncoderHardware: true,
      encoderAttempt: 1,
      encoderAttempts: 3,
      encodeFrames: 42,
      encodeTotalFrames: 100,
      encodedTimeSeconds: 1.4,
      encodeDurationSeconds: 3.33,
      encodingFps: 30,
      encodingSpeed: 1.2,
      encodeStartedAt: null,
      encoderAttemptStartedAt: null,
      saveOperation: null,
      saveStartedAt: null,
      saveBytesCopied: 0,
      saveTotalBytes: null,
    };
    (recorder as unknown as { sessions: Map<string, typeof session> }).sessions.set(session.id, session);

    expect(recorder.status(session.id)).toEqual({
      phase: "encoding",
      progress: 0.42,
      framesEncoded: 42,
      totalFrames: 100,
      encodedTimeSeconds: 1.4,
      totalTimeSeconds: 3.33,
      fps: 30,
      speed: 1.2,
      encoder: "h264_nvenc",
      encoderHardware: true,
      encoderAttempt: 1,
      encoderAttempts: 3,
    });
  });

  test("reports save-copy bytes only when measurable instead of claiming completion", () => {
    const recorder = new FfmpegVideoRecorder("unused-ffmpeg.exe", () => null);
    const session = {
      id: "save-status",
      phase: "saving" as const,
      saveOperation: "finalizing" as "finalizing" | "copying" | "verifying",
      saveStartedAt: null as number | null,
      saveBytesCopied: 0,
      saveTotalBytes: null as number | null,
      activeEncoder: null,
      activeEncoderHardware: null,
    };
    (recorder as unknown as { sessions: Map<string, typeof session> }).sessions.set(session.id, session);

    expect(recorder.status(session.id)).toEqual({ phase: "saving", saveOperation: "finalizing" });
    session.saveOperation = "copying";
    session.saveBytesCopied = 256;
    session.saveTotalBytes = 1024;
    expect(recorder.status(session.id)).toEqual({
      phase: "saving",
      saveOperation: "copying",
      saveBytesCopied: 256,
      saveTotalBytes: 1024,
      progress: 0.25,
    });
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
