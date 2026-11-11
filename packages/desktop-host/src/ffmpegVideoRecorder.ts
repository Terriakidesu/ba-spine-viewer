import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import { saveVideoFileWithoutOverwrite } from "./videoExport";

export type FfmpegVideoFormat = "webm" | "mp4";
export type FfmpegVideoQuality = "high" | "balanced" | "compact";

const ENCODER_QUALITY_VALUES: Record<FfmpegVideoQuality, {
  nvenc: number;
  h264Qsv: number;
  amfI: number;
  amfP: number;
  mediaFoundationBitrate: string;
  x264Crf: number;
  vp9Qsv: number;
  vp9Crf: number;
  vp8Crf: number;
}> = {
  high: { nvenc: 18, h264Qsv: 18, amfI: 18, amfP: 20, mediaFoundationBitrate: "12M", x264Crf: 18, vp9Qsv: 24, vp9Crf: 26, vp8Crf: 24 },
  balanced: { nvenc: 21, h264Qsv: 22, amfI: 21, amfP: 23, mediaFoundationBitrate: "8M", x264Crf: 21, vp9Qsv: 30, vp9Crf: 32, vp8Crf: 30 },
  compact: { nvenc: 26, h264Qsv: 30, amfI: 27, amfP: 29, mediaFoundationBitrate: "5M", x264Crf: 26, vp9Qsv: 38, vp9Crf: 40, vp8Crf: 38 },
};

export interface FfmpegVideoSupport {
  available: boolean;
  formats: FfmpegVideoFormat[];
  version: string | null;
  hardwareEncoders: string[];
}

export interface FfmpegVideoRecordingOptions {
  width: number;
  height: number;
  frameRate: 30 | 60;
  format: FfmpegVideoFormat;
  quality?: FfmpegVideoQuality;
  filename: string;
}

export interface FfmpegVideoAudioTrack {
  start: number;
  duration: number;
  volume: number;
  sourceOffset: number;
  gainAutomation?: Array<{ time: number; volume: number }>;
  extension: string;
  bytes: Uint8Array;
}

interface RecordingSocket {
  close: (code?: number, reason?: string) => void;
  pause: () => void;
  resume: () => void;
  readonly isPaused: boolean;
}

interface FfmpegVideoSession {
  id: string;
  exportDirectory: string;
  temporaryDirectory: string;
  filename: string;
  width: number;
  height: number;
  frameRate: number;
  format: FfmpegVideoFormat;
  quality: FfmpegVideoQuality;
  framesPath: string;
  frameWriter: ReturnType<typeof createWriteStream>;
  frameCount: number;
  frameBytes: number;
  audioTracks: Array<{ path: string; start: number; duration: number; volume: number; sourceOffset: number; gainAutomation?: Array<{ time: number; volume: number }> }>;
  audioBytes: number;
  phase: "rendering" | "encoding" | "saving";
  encodeProgress: number;
  activeEncoder: string | null;
  activeEncoderHardware: boolean | null;
  encoderAttempt: number;
  encoderAttempts: number;
  encodeFrames: number;
  encodeTotalFrames: number;
  encodedTimeSeconds: number;
  encodeDurationSeconds: number;
  encodingFps: number | null;
  encodingSpeed: number | null;
  encodeStartedAt: number | null;
  encoderAttemptStartedAt: number | null;
  saveOperation: "finalizing" | "copying" | "verifying" | null;
  saveStartedAt: number | null;
  saveBytesCopied: number;
  saveTotalBytes: number | null;
  socket: RecordingSocket | null;
  socketClaimed: boolean;
  finishing: boolean;
  failure: Error | null;
}

export interface FfmpegVideoExportResult {
  fileName: string;
  encoder: string;
  encoderHardware: boolean;
  encoderAttempt: number;
  encoderAttempts: number;
  outputBytes: number;
  exportDirectory: string;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_BYTES = 1_073_741_824;
const MAX_FRAME_STREAM_BYTES = 4_294_967_296;
const MAX_RECORDING_FRAMES = 108_000;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_AUDIO_TRACKS = 128;
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"]);

export interface FfmpegVideoStatus {
  phase: "rendering" | "encoding" | "saving";
  progress?: number;
  encoder?: string;
  encoderHardware?: boolean;
  encoderAttempt?: number;
  encoderAttempts?: number;
  framesEncoded?: number;
  totalFrames?: number;
  encodedTimeSeconds?: number;
  totalTimeSeconds?: number;
  fps?: number;
  speed?: number;
  elapsedSeconds?: number;
  etaSeconds?: number;
  saveOperation?: "finalizing" | "copying" | "verifying";
  saveBytesCopied?: number;
  saveTotalBytes?: number;
}

export interface FfmpegProgressMetrics {
  frames: number | null;
  progress: number | null;
  timeSeconds: number | null;
  fps: number | null;
  speed: number | null;
}

function parseFfmpegTime(value: string | undefined): number | null {
  if (!value || value === "N/A") return null;
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

export function parseFfmpegProgressMetrics(values: Record<string, string>, totalFrames: number, totalTimeSeconds: number): FfmpegProgressMetrics {
  const rawFrames = Number(values.frame);
  const frames = Number.isFinite(rawFrames) && rawFrames >= 0 ? Math.min(totalFrames, rawFrames) : null;
  const parsedTime = parseFfmpegTime(values.out_time);
  const outTimeUs = Number(values.out_time_us);
  const outTimeMs = Number(values.out_time_ms);
  const rawTimeMicroseconds = Number.isFinite(outTimeUs) && outTimeUs >= 0 ? outTimeUs : outTimeMs;
  const timeSeconds = parsedTime ?? (Number.isFinite(rawTimeMicroseconds) && rawTimeMicroseconds >= 0 ? rawTimeMicroseconds / 1_000_000 : null);
  const rawFps = Number(values.fps);
  const fps = Number.isFinite(rawFps) && rawFps >= 0 ? rawFps : null;
  const rawSpeed = Number(values.speed?.replace(/x$/i, ""));
  const speed = Number.isFinite(rawSpeed) && rawSpeed >= 0 ? rawSpeed : null;
  return {
    frames,
    progress: frames === null || totalFrames <= 0 ? null : Math.min(1, frames / totalFrames),
    timeSeconds: positiveFinite(timeSeconds) ? Math.min(totalTimeSeconds, timeSeconds) : null,
    fps,
    speed,
  };
}

function parseEncoders(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match?.[1]) encoders.add(match[1]);
  }
  return encoders;
}

export function ffmpegEncoderAttempts(format: FfmpegVideoFormat, encoderOutput: string, quality: FfmpegVideoQuality = "balanced"): Array<{ name: string; args: string[]; hardware: boolean }> {
  const available = parseEncoders(encoderOutput);
  const values = ENCODER_QUALITY_VALUES[quality];
  const candidates = format === "mp4"
    ? [
      { name: "h264_nvenc", args: ["-preset:v", "p4", "-rc:v", "vbr", "-cq:v", String(values.nvenc), "-b:v", "0"], hardware: true },
      { name: "h264_qsv", args: ["-preset:v", "medium", "-global_quality:v", String(values.h264Qsv)], hardware: true },
      { name: "h264_amf", args: ["-quality:v", "speed", "-rc:v", "cqp", "-qp_i:v", String(values.amfI), "-qp_p:v", String(values.amfP)], hardware: true },
      { name: "h264_mf", args: ["-b:v", values.mediaFoundationBitrate], hardware: true },
      { name: "libx264", args: ["-preset:v", "veryfast", "-crf:v", String(values.x264Crf)], hardware: false },
    ]
    : [
      { name: "vp9_qsv", args: ["-preset:v", "medium", "-global_quality:v", String(values.vp9Qsv)], hardware: true },
      { name: "libvpx-vp9", args: ["-deadline:v", "realtime", "-cpu-used:v", "5", "-crf:v", String(values.vp9Crf), "-b:v", "0", "-row-mt:v", "1"], hardware: false },
      { name: "libvpx", args: ["-deadline:v", "realtime", "-cpu-used:v", "5", "-crf:v", String(values.vp8Crf), "-b:v", "0"], hardware: false },
    ];
  return candidates.filter((candidate) => available.has(candidate.name));
}

/** Convert browser JPEG frames to standard limited-range BT.709 video. */
export function ffmpegVideoColorPipelineArgs(format: FfmpegVideoFormat): string[] {
  const args = [
    "-vf", "scale=in_range=pc:out_range=tv:in_color_matrix=bt470bg:out_color_matrix=bt709",
    "-pix_fmt:v", "yuv420p",
    "-color_range:v", "tv",
    "-colorspace:v", "bt709",
    "-color_primaries:v", "bt709",
    "-color_trc:v", "bt709",
  ];
  if (format === "mp4") {
    // Some Windows hardware encoders (notably Media Foundation) omit VUI color
    // metadata even when the corresponding output options are supplied.
    args.push("-bsf:v", "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1");
  }
  return args;
}

export function ffmpegAudioMixFilterGraph(
  tracks: readonly (Pick<FfmpegVideoAudioTrack, "start" | "duration" | "volume"> & Partial<Pick<FfmpegVideoAudioTrack, "sourceOffset" | "gainAutomation">>)[],
  videoDuration: number,
): { graph: string; output: "[aout]" } | null {
  if (tracks.length === 0 || !Number.isFinite(videoDuration) || videoDuration <= 0) return null;
  const filters = tracks.map((track, index) => {
    const start = Math.max(0, track.start);
    const duration = Math.max(0, Math.min(track.duration, videoDuration - start));
    const volume = Math.max(0, Math.min(1, track.volume));
    const sourceOffset = Math.max(0, track.sourceOffset ?? 0);
    const delayMilliseconds = Math.round(start * 1000);
    const points = track.gainAutomation;
    let volumeFilter = `volume=${volume.toFixed(4)}`;
    if (points?.length) {
      if (points.length < 2 || points.length > 512 || points[0]!.time > 1e-6
        || points.at(-1)!.time < duration - 1e-6 || points.at(-1)!.time > duration + 1e-6
        || points.some((point, pointIndex) => !Number.isFinite(point.time) || !Number.isFinite(point.volume)
          || point.time < 0 || point.time > duration + 1e-6 || point.volume < 0 || point.volume > 1
          || (pointIndex > 0 && point.time <= points[pointIndex - 1]!.time))) {
        throw new Error("The Viewer audio gain automation is invalid.");
      }
      let expression = points.at(-1)!.volume.toFixed(8);
      for (let pointIndex = points.length - 2; pointIndex >= 0; pointIndex -= 1) {
        const first = points[pointIndex]!;
        const last = points[pointIndex + 1]!;
        const slope = (last.volume - first.volume) / (last.time - first.time);
        const segment = `${first.volume.toFixed(8)}+(t-${first.time.toFixed(6)})*${slope.toFixed(10)}`;
        expression = `if(lt(t,${last.time.toFixed(6)}),${segment},${expression})`;
      }
      volumeFilter = `volume='${expression}':eval=frame`;
    }
    return `[${index + 1}:a:0]atrim=start=${sourceOffset.toFixed(6)}:duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,${volumeFilter},adelay=${delayMilliseconds}:all=1[a${index}]`;
  });
  const inputs = tracks.map((_, index) => `[a${index}]`).join("");
  filters.push(`${inputs}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${videoDuration.toFixed(6)}[aout]`);
  return { graph: filters.join(";"), output: "[aout]" };
}

function parseVersion(output: string): string | null {
  return output.split(/\r?\n/, 1)[0]?.trim() || null;
}

async function runOutput(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { code, stdout, stderr };
}

export async function inspectFfmpeg(executablePath: string): Promise<FfmpegVideoSupport> {
  try {
    await access(executablePath);
    const [versionResult, encoderResult] = await Promise.all([
      runOutput([executablePath, "-version"]),
      runOutput([executablePath, "-hide_banner", "-encoders"]),
    ]);
    if (versionResult.code !== 0 || encoderResult.code !== 0) throw new Error("FFmpeg could not be started.");
    const encoderOutput = `${encoderResult.stdout}\n${encoderResult.stderr}`;
    const available = parseEncoders(encoderOutput);
    const formats: FfmpegVideoFormat[] = [];
    if (["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"].some((name) => available.has(name))) formats.push("mp4");
    if (["vp9_qsv", "libvpx-vp9", "libvpx"].some((name) => available.has(name))) formats.push("webm");
    return {
      available: formats.length > 0,
      formats,
      version: parseVersion(versionResult.stdout || versionResult.stderr),
      hardwareEncoders: ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "vp9_qsv"].filter((name) => available.has(name)),
    };
  } catch {
    return { available: false, formats: [], version: null, hardwareEncoders: [] };
  }
}

function safeRecordingDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= 320 && height >= 320 && width <= 3840 && height <= 2160
    && width % 2 === 0 && height % 2 === 0;
}

export class FfmpegVideoRecorder {
  private readonly sessions = new Map<string, FfmpegVideoSession>();
  private readonly finishPromises = new Map<string, Promise<FfmpegVideoExportResult>>();
  private supportPromise: Promise<FfmpegVideoSupport> | null = null;

  constructor(
    private readonly executablePath: string,
    private readonly exportDirectory: () => string | null,
  ) {}

  support(): Promise<FfmpegVideoSupport> {
    return this.supportPromise ??= inspectFfmpeg(this.executablePath);
  }

  claimSocket(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.finishing || session.socketClaimed) return false;
    session.socketClaimed = true;
    return true;
  }

  releaseSocketClaim(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.socket) session.socketClaimed = false;
  }

  attachSocket(sessionId: string, socket: RecordingSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.finishing || session.socket) {
      socket.close(1008, "Recording session is unavailable.");
      return;
    }
    session.socket = socket;
  }

  writeFrame(sessionId: string, socket: RecordingSocket, value: string | Uint8Array): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.socket !== socket || session.finishing || session.failure) {
      socket.close(1008, "Recording session is unavailable.");
      return;
    }
    if (typeof value === "string") {
      socket.close(1003, "Only binary JPEG frames are accepted.");
      return;
    }
    const bytes = Buffer.from(value);
    if (bytes.byteLength < 4 || bytes.byteLength > MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      session.failure = new Error("The Viewer sent an invalid video frame.");
      socket.close(1003, "Invalid JPEG frame.");
      return;
    }
    if (session.frameCount >= MAX_RECORDING_FRAMES || session.frameBytes + bytes.byteLength > MAX_FRAME_STREAM_BYTES) {
      session.failure = new Error("The recording exceeded its frame or temporary-storage safety limit.");
      socket.close(1009, "Recording limit reached.");
      return;
    }
    session.frameCount++;
    session.frameBytes += bytes.byteLength;
    if (!session.frameWriter.write(bytes) && !socket.isPaused) {
      socket.pause();
      session.frameWriter.once("drain", () => socket.resume());
    }
  }

  socketClosed(sessionId: string, socket: RecordingSocket): void {
    const session = this.sessions.get(sessionId);
    if (session?.socket === socket) session.socket = null;
  }

  async start(options: FfmpegVideoRecordingOptions, selectedExportDirectory?: string): Promise<string> {
    const directory = selectedExportDirectory ?? this.exportDirectory();
    const support = await this.support();
    if (!support.available || !support.formats.includes(options.format)) throw new Error("The bundled FFmpeg encoder is unavailable for this video format.");
    if (!safeRecordingDimensions(options.width, options.height)) throw new Error("The requested video dimensions are invalid.");
    if (options.frameRate !== 30 && options.frameRate !== 60) throw new Error("The requested video frame rate is invalid.");
    const quality = options.quality ?? "balanced";
    if (quality !== "high" && quality !== "balanced" && quality !== "compact") throw new Error("The requested video quality is invalid.");
    if (!options.filename.toLocaleLowerCase().endsWith(options.format === "webm" ? ".webm" : ".mp4")) {
      throw new Error("The requested filename does not match the video format.");
    }
    if (this.sessions.size > 0) throw new Error("A Viewer video recording is already in progress.");
    if (!directory) throw new Error("Choose a video export folder before recording.");
    const id = randomUUID();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ba-spine-video-"));
    const framesPath = join(temporaryDirectory, "frames.mjpg");
    const frameWriter = createWriteStream(framesPath, { flags: "wx", highWaterMark: 4 * 1024 * 1024 });
    try {
      await new Promise<void>((resolve, reject) => {
        frameWriter.once("open", () => resolve());
        frameWriter.once("error", reject);
      });
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const session: FfmpegVideoSession = {
      id,
      exportDirectory: directory,
      temporaryDirectory,
      filename: options.filename,
      width: options.width,
      height: options.height,
      frameRate: options.frameRate,
      format: options.format,
      quality,
      framesPath,
      frameWriter,
      frameCount: 0,
      frameBytes: 0,
      audioTracks: [],
      audioBytes: 0,
      phase: "rendering",
      encodeProgress: 0,
      activeEncoder: null,
      activeEncoderHardware: null,
      encoderAttempt: 0,
      encoderAttempts: 0,
      encodeFrames: 0,
      encodeTotalFrames: 0,
      encodedTimeSeconds: 0,
      encodeDurationSeconds: 0,
      encodingFps: null,
      encodingSpeed: null,
      encodeStartedAt: null,
      encoderAttemptStartedAt: null,
      saveOperation: null,
      saveStartedAt: null,
      saveBytesCopied: 0,
      saveTotalBytes: null,
      socket: null,
      socketClaimed: false,
      finishing: false,
      failure: null,
    };
    frameWriter.on("error", (error) => {
      session.failure = error;
      session.socket?.close(1011, "Could not write video frames.");
    });
    this.sessions.set(id, session);
    return id;
  }

  async addAudioTrack(sessionId: string, track: FfmpegVideoAudioTrack): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.finishing) throw new Error("The Viewer recording session is unavailable.");
    const extension = track.extension.replace(/^\./, "").toLocaleLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)
      || !Number.isFinite(track.start) || track.start < 0 || track.start > 1800
      || !Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 1800
      || !Number.isFinite(track.sourceOffset) || track.sourceOffset < 0 || track.sourceOffset > 1800
      || !Number.isFinite(track.volume) || track.volume < 0 || track.volume > 1) {
      throw new Error("The Viewer audio track settings are invalid.");
    }
    if (track.gainAutomation !== undefined && (!Array.isArray(track.gainAutomation) || track.gainAutomation.length < 2 || track.gainAutomation.length > 512
      || track.gainAutomation[0]!.time > 1e-6 || track.gainAutomation.at(-1)!.time < track.duration - 1e-6
      || track.gainAutomation.at(-1)!.time > track.duration + 1e-6
      || track.gainAutomation.some((point, index) => !Number.isFinite(point.time) || !Number.isFinite(point.volume)
        || point.time < 0 || point.time > track.duration + 1e-6 || point.volume < 0 || point.volume > 1
        || (index > 0 && point.time <= track.gainAutomation![index - 1]!.time)))) {
      throw new Error("The Viewer audio gain automation is invalid.");
    }
    if (!(track.bytes instanceof Uint8Array) || track.bytes.byteLength === 0
      || track.bytes.byteLength > MAX_AUDIO_BYTES
      || session.audioBytes + track.bytes.byteLength > MAX_AUDIO_BYTES
      || session.audioTracks.length >= MAX_AUDIO_TRACKS) {
      throw new Error("The recording audio exceeds its track or temporary-storage safety limit.");
    }
    const audioPath = join(session.temporaryDirectory, `audio-${session.audioTracks.length}.${extension}`);
    await writeFile(audioPath, track.bytes, { flag: "wx" });
    session.audioTracks.push({
      path: audioPath,
      start: track.start,
      duration: track.duration,
      volume: track.volume,
      sourceOffset: track.sourceOffset,
      ...(track.gainAutomation ? { gainAutomation: track.gainAutomation } : {}),
    });
    session.audioBytes += track.bytes.byteLength;
  }

  status(sessionId: string): FfmpegVideoStatus | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const status: FfmpegVideoStatus = { phase: session.phase };
    if (session.phase === "encoding") {
      status.progress = session.encodeProgress;
      status.framesEncoded = session.encodeFrames;
      status.totalFrames = session.encodeTotalFrames;
      status.encodedTimeSeconds = session.encodedTimeSeconds;
      status.totalTimeSeconds = session.encodeDurationSeconds;
      if (typeof session.encodingFps === "number") status.fps = session.encodingFps;
      if (typeof session.encodingSpeed === "number") status.speed = session.encodingSpeed;
      if (typeof session.encodeStartedAt === "number") {
        status.elapsedSeconds = Math.max(0, (performance.now() - session.encodeStartedAt) / 1000);
        if (session.encodingFps !== null && session.encodingFps > 0) {
          status.etaSeconds = Math.max(0, (session.encodeTotalFrames - session.encodeFrames) / session.encodingFps);
        } else if (session.encodeProgress > 0 && session.encodeProgress < 1 && typeof session.encoderAttemptStartedAt === "number") {
          const attemptElapsed = Math.max(0, (performance.now() - session.encoderAttemptStartedAt) / 1000);
          if (attemptElapsed > 0) status.etaSeconds = attemptElapsed * (1 - session.encodeProgress) / session.encodeProgress;
        }
      }
      if (session.activeEncoder) status.encoder = session.activeEncoder;
      if (typeof session.activeEncoderHardware === "boolean") status.encoderHardware = session.activeEncoderHardware;
      if (session.encoderAttempt > 0) status.encoderAttempt = session.encoderAttempt;
      if (session.encoderAttempts > 0) status.encoderAttempts = session.encoderAttempts;
    } else if (session.phase === "saving") {
      if (session.saveOperation) status.saveOperation = session.saveOperation;
      if (typeof session.saveStartedAt === "number") status.elapsedSeconds = Math.max(0, (performance.now() - session.saveStartedAt) / 1000);
      if (typeof session.saveTotalBytes === "number") {
        status.saveBytesCopied = session.saveBytesCopied;
        status.saveTotalBytes = session.saveTotalBytes;
        if (session.saveTotalBytes > 0) status.progress = Math.min(1, session.saveBytesCopied / session.saveTotalBytes);
      }
      if (session.activeEncoder) status.encoder = session.activeEncoder;
      if (typeof session.activeEncoderHardware === "boolean") status.encoderHardware = session.activeEncoderHardware;
    }
    return status;
  }

  finish(sessionId: string, expectedFrameCount: number): Promise<FfmpegVideoExportResult> {
    const existingFinish = this.finishPromises.get(sessionId);
    if (existingFinish) return existingFinish;
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("The Viewer recording session is unavailable."));
    if (session.finishing) return Promise.reject(new Error("The Viewer recording session is already finalizing."));
    session.finishing = true;
    const finishPromise = this.finishSession(sessionId, session, expectedFrameCount);
    this.finishPromises.set(sessionId, finishPromise);
    while (this.finishPromises.size > 64) {
      const oldestSessionId = this.finishPromises.keys().next().value;
      if (oldestSessionId === undefined) break;
      this.finishPromises.delete(oldestSessionId);
    }
    void finishPromise.catch(() => {
      if (this.finishPromises.get(sessionId) === finishPromise) this.finishPromises.delete(sessionId);
    });
    return finishPromise;
  }

  private async finishSession(sessionId: string, session: FfmpegVideoSession, expectedFrameCount: number): Promise<FfmpegVideoExportResult> {
    try {
      if (session.socket) {
        session.socket.close(1000, "Recording complete.");
        session.socket = null;
      }
      const writerFinished = finished(session.frameWriter).catch((error: unknown) => {
        session.failure ??= error instanceof Error ? error : new Error(String(error));
      });
      if (!session.frameWriter.destroyed && !session.frameWriter.writableEnded) session.frameWriter.end();
      await writerFinished;
      if (session.failure) throw session.failure;
      if (!Number.isInteger(expectedFrameCount) || expectedFrameCount < 1 || expectedFrameCount !== session.frameCount) {
        throw new Error("The Viewer did not deliver the complete video frame sequence.");
      }
      session.phase = "encoding";
      session.encodeProgress = 0;
      session.encodeFrames = 0;
      session.encodeTotalFrames = expectedFrameCount;
      session.encodedTimeSeconds = 0;
      session.encodeDurationSeconds = expectedFrameCount / session.frameRate;
      session.encodeStartedAt = performance.now();
      const { encoder, outputPath } = await this.encode(session, expectedFrameCount);
      session.phase = "saving";
      session.saveStartedAt = performance.now();
      session.saveOperation = "finalizing";
      session.saveBytesCopied = 0;
      session.saveTotalBytes = null;
      const outputSize = (await stat(outputPath)).size;
      if (outputSize <= 0 || outputSize > MAX_RECORDING_BYTES) throw new Error("The encoded video is empty or exceeds the 1 GB export limit.");
      session.saveOperation = "copying";
      session.saveTotalBytes = outputSize;
      const fileName = await saveVideoFileWithoutOverwrite(session.exportDirectory, session.filename, outputPath, (copiedBytes, totalBytes) => {
        session.saveBytesCopied = copiedBytes;
        session.saveTotalBytes = totalBytes;
      });
      session.saveOperation = "verifying";
      const savedSize = (await stat(join(session.exportDirectory, fileName))).size;
      if (savedSize !== outputSize) throw new Error("The saved video did not match the encoded output size.");
      return {
        fileName,
        encoder,
        encoderHardware: session.activeEncoderHardware ?? false,
        encoderAttempt: session.encoderAttempt,
        encoderAttempts: session.encoderAttempts,
        outputBytes: savedSize,
        exportDirectory: session.exportDirectory,
      };
    } finally {
      this.sessions.delete(sessionId);
      if (!session.frameWriter.destroyed && !session.frameWriter.writableEnded) session.frameWriter.destroy();
      await finished(session.frameWriter).catch(() => undefined);
      await rm(session.temporaryDirectory, { recursive: true, force: true });
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.socket?.close(1000, "Recording canceled.");
    session.frameWriter.destroy();
    await finished(session.frameWriter).catch(() => undefined);
    await rm(session.temporaryDirectory, { recursive: true, force: true });
  }

  private async encode(session: FfmpegVideoSession, frameCount: number): Promise<{ encoder: string; outputPath: string }> {
    const attempts = ffmpegEncoderAttempts(session.format, await this.encoderListing(), session.quality);
    if (!attempts.length) throw new Error(`The bundled FFmpeg has no encoder for ${session.format.toUpperCase()}.`);
    session.encoderAttempts = attempts.length;
    const extension = session.format === "webm" ? "webm" : "mp4";
    const outputPath = join(session.temporaryDirectory, `recording.${extension}`);
    const duration = (frameCount / session.frameRate).toFixed(6);
    const durationSeconds = frameCount / session.frameRate;
    const audioTracks = session.audioTracks
      .map((track) => ({ ...track, duration: Math.min(track.duration, durationSeconds - track.start) }))
      .filter((track) => track.start < durationSeconds && track.duration > 0);
    let lastError = "FFmpeg could not encode the recording.";
    for (const [attemptIndex, attempt] of attempts.entries()) {
      session.activeEncoder = attempt.name;
      session.activeEncoderHardware = attempt.hardware;
      session.encoderAttempt = attemptIndex + 1;
      session.encodeProgress = 0;
      session.encodeFrames = 0;
      session.encodedTimeSeconds = 0;
      session.encodingFps = null;
      session.encodingSpeed = null;
      session.encoderAttemptStartedAt = performance.now();
      await rm(outputPath, { force: true });
      const args = [
        this.executablePath,
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(session.frameRate), "-i", session.framesPath,
      ];
      for (const track of audioTracks) args.push("-i", track.path);
      args.push("-map", "0:v:0");
      const audioMix = ffmpegAudioMixFilterGraph(audioTracks, durationSeconds);
      if (audioMix) {
        args.push("-filter_complex", audioMix.graph, "-map", audioMix.output);
      }
      args.push("-frames:v", String(frameCount), "-t", duration, "-c:v", attempt.name, ...attempt.args, ...ffmpegVideoColorPipelineArgs(session.format));
      if (audioTracks.length > 0) args.push("-c:a", session.format === "mp4" ? "aac" : "libopus", "-b:a", session.format === "mp4" ? "160k" : "128k");
      if (session.format === "mp4") args.push("-movflags", "+faststart");
      args.push("-progress", "pipe:1", "-nostats");
      args.push("-f", session.format, outputPath);
      const process = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const progressReader = process.stdout.getReader();
      const progressTask = (async () => {
        const decoder = new TextDecoder();
        let buffered = "";
        const progressValues: Record<string, string> = {};
        const applyProgress = () => {
          const metrics = parseFfmpegProgressMetrics(progressValues, frameCount, session.encodeDurationSeconds);
          if (metrics.frames !== null) session.encodeFrames = Math.max(session.encodeFrames, metrics.frames);
          if (metrics.progress !== null) session.encodeProgress = Math.max(session.encodeProgress, metrics.progress);
          if (metrics.timeSeconds !== null) session.encodedTimeSeconds = Math.max(session.encodedTimeSeconds, metrics.timeSeconds);
          if (metrics.fps !== null) session.encodingFps = metrics.fps;
          if (metrics.speed !== null) session.encodingSpeed = metrics.speed;
        };
        while (true) {
          const { value, done } = await progressReader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            const separator = line.indexOf("=");
            if (separator <= 0) continue;
            const key = line.slice(0, separator).trim();
            progressValues[key] = line.slice(separator + 1).trim();
            if (key === "progress") applyProgress();
          }
        }
      })();
      const [stderr, exitCode] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
        progressTask,
      ]).then(([stderrText, code]) => [stderrText, code] as const);
      if (exitCode === 0) {
        session.encodeProgress = 1;
        session.encodeFrames = frameCount;
        session.encodedTimeSeconds = session.encodeDurationSeconds;
      }
      if (exitCode === 0) return { encoder: attempt.name, outputPath };
      lastError = stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `${attempt.name} exited with status ${exitCode}.`;
    }
    throw new Error(`FFmpeg could not encode the recording with a supported hardware or software encoder: ${lastError}`);
  }

  private async encoderListing(): Promise<string> {
    const result = await runOutput([this.executablePath, "-hide_banner", "-encoders"]);
    if (result.code !== 0) throw new Error("Could not inspect the bundled FFmpeg encoders.");
    return `${result.stdout}\n${result.stderr}`;
  }
}
