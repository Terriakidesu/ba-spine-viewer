import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import { saveVideoFileWithoutOverwrite } from "./videoExport";

export type FfmpegVideoFormat = "webm" | "mp4";

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
  filename: string;
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
  framesPath: string;
  frameWriter: ReturnType<typeof createWriteStream>;
  frameCount: number;
  frameBytes: number;
  socket: RecordingSocket | null;
  socketClaimed: boolean;
  finishing: boolean;
  failure: Error | null;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_BYTES = 1_073_741_824;
const MAX_FRAME_STREAM_BYTES = 4_294_967_296;
const MAX_RECORDING_FRAMES = 108_000;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;

function parseEncoders(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match?.[1]) encoders.add(match[1]);
  }
  return encoders;
}

export function ffmpegEncoderAttempts(format: FfmpegVideoFormat, encoderOutput: string): Array<{ name: string; args: string[]; hardware: boolean }> {
  const available = parseEncoders(encoderOutput);
  const candidates = format === "mp4"
    ? [
      { name: "h264_nvenc", args: ["-preset:v", "p4", "-rc:v", "vbr", "-cq:v", "21", "-b:v", "0"], hardware: true },
      { name: "h264_qsv", args: ["-preset:v", "medium", "-global_quality:v", "22"], hardware: true },
      { name: "h264_amf", args: ["-quality:v", "speed", "-rc:v", "cqp", "-qp_i:v", "21", "-qp_p:v", "23"], hardware: true },
      { name: "h264_mf", args: ["-b:v", "8M"], hardware: true },
      { name: "libx264", args: ["-preset:v", "veryfast", "-crf:v", "21"], hardware: false },
    ]
    : [
      { name: "vp9_qsv", args: ["-preset:v", "medium", "-global_quality:v", "30"], hardware: true },
      { name: "libvpx-vp9", args: ["-deadline:v", "realtime", "-cpu-used:v", "5", "-crf:v", "32", "-b:v", "0", "-row-mt:v", "1"], hardware: false },
      { name: "libvpx", args: ["-deadline:v", "realtime", "-cpu-used:v", "5", "-crf:v", "30", "-b:v", "0"], hardware: false },
    ];
  return candidates.filter((candidate) => available.has(candidate.name));
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

  async start(options: FfmpegVideoRecordingOptions): Promise<string> {
    const support = await this.support();
    if (!support.available || !support.formats.includes(options.format)) throw new Error("The bundled FFmpeg encoder is unavailable for this video format.");
    if (!safeRecordingDimensions(options.width, options.height)) throw new Error("The requested video dimensions are invalid.");
    if (options.frameRate !== 30 && options.frameRate !== 60) throw new Error("The requested video frame rate is invalid.");
    if (!options.filename.toLocaleLowerCase().endsWith(options.format === "webm" ? ".webm" : ".mp4")) {
      throw new Error("The requested filename does not match the video format.");
    }
    if (this.sessions.size > 0) throw new Error("A Viewer video recording is already in progress.");
    const directory = this.exportDirectory();
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
      framesPath,
      frameWriter,
      frameCount: 0,
      frameBytes: 0,
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

  async finish(sessionId: string, expectedFrameCount: number, audioBytes: Uint8Array | null, audioType: string): Promise<{ fileName: string; encoder: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.finishing) throw new Error("The Viewer recording session is unavailable.");
    session.finishing = true;
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
      if (audioBytes && audioBytes.byteLength > MAX_AUDIO_BYTES) throw new Error("The recording audio exceeds the temporary-storage safety limit.");
      let audioPath: string | null = null;
      if (audioBytes?.byteLength) {
        if (!audioType.toLocaleLowerCase().startsWith("audio/webm") && !audioType.toLocaleLowerCase().startsWith("audio/mp4")) {
          throw new Error("The Viewer audio stream uses an unsupported format.");
        }
        audioPath = join(session.temporaryDirectory, audioType.toLocaleLowerCase().includes("webm") ? "audio.webm" : "audio.mp4");
        await writeFile(audioPath, audioBytes, { flag: "wx" });
      }
      const { encoder, outputPath } = await this.encode(session, expectedFrameCount, audioPath);
      const outputSize = (await stat(outputPath)).size;
      if (outputSize <= 0 || outputSize > MAX_RECORDING_BYTES) throw new Error("The encoded video is empty or exceeds the 1 GB export limit.");
      const fileName = await saveVideoFileWithoutOverwrite(session.exportDirectory, session.filename, outputPath);
      return { fileName, encoder };
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

  private async encode(session: FfmpegVideoSession, frameCount: number, audioPath: string | null): Promise<{ encoder: string; outputPath: string }> {
    const attempts = ffmpegEncoderAttempts(session.format, await this.encoderListing());
    if (!attempts.length) throw new Error(`The bundled FFmpeg has no encoder for ${session.format.toUpperCase()}.`);
    const extension = session.format === "webm" ? "webm" : "mp4";
    const outputPath = join(session.temporaryDirectory, `recording.${extension}`);
    const duration = (frameCount / session.frameRate).toFixed(6);
    let lastError = "FFmpeg could not encode the recording.";
    for (const attempt of attempts) {
      await rm(outputPath, { force: true });
      const args = [
        this.executablePath,
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(session.frameRate), "-i", session.framesPath,
      ];
      if (audioPath) args.push("-i", audioPath);
      args.push("-map", "0:v:0");
      if (audioPath) args.push("-map", "1:a:0?");
      args.push("-frames:v", String(frameCount), "-t", duration, "-c:v", attempt.name, ...attempt.args, "-pix_fmt:v", "yuv420p");
      if (audioPath) args.push("-c:a", session.format === "mp4" ? "aac" : "libopus", "-b:a", session.format === "mp4" ? "160k" : "128k");
      if (session.format === "mp4") args.push("-movflags", "+faststart");
      args.push("-f", session.format, outputPath);
      const process = Bun.spawn({ cmd: args, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
      const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
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
