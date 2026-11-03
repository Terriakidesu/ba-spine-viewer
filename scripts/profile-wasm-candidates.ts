import { audioEnvelopePeaks } from "../packages/editor-feature/src/audioEnvelope";
import { arch, cpus, platform } from "node:os";

const SAMPLE_RATE = 48_000;
let checksum = 0;

function signal(seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.sin(index * 0.0037) * (0.25 + (index % 13) / 20);
  }
  return samples;
}

function measure(name: string, run: () => number, iterations: number, warmup = 4) {
  for (let index = 0; index < warmup; index++) checksum += run();
  const timings: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    checksum += run();
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  const median = timings[Math.floor(timings.length / 2)] ?? 0;
  const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)] ?? 0;
  return { name, iterations, medianMs: Number(median.toFixed(3)), p95Ms: Number(p95.toFixed(3)), medianOf16_67msFrame: Number((median / 16.67).toFixed(3)) };
}

const fiveSeconds = signal(5);
const tenSeconds = signal(10);
const fifteenSeconds = signal(15);
const thirtySeconds = signal(30);
const representativeTimelineBatch = Array.from({ length: 4 }, () => signal(8));
const timelineBatch = Array.from({ length: 32 }, () => signal(5));

const results = [
  measure("single decoded 5s mono clip / 160 peaks", () => audioEnvelopePeaks(fiveSeconds).reduce((sum, peak) => sum + peak, 0), 80),
  measure("single decoded 10s mono clip / 160 peaks", () => audioEnvelopePeaks(tenSeconds).reduce((sum, peak) => sum + peak, 0), 60),
  measure("single decoded 15s mono clip / 160 peaks", () => audioEnvelopePeaks(fifteenSeconds).reduce((sum, peak) => sum + peak, 0), 40),
  measure("single decoded 30s mono clip / 160 peaks", () => audioEnvelopePeaks(thirtySeconds).reduce((sum, peak) => sum + peak, 0), 25),
  measure("data-informed batch of 4 decoded 8s mono clips", () => representativeTimelineBatch.reduce((sum, channel) => sum + audioEnvelopePeaks(channel).reduce((peaks, peak) => peaks + peak, 0), 0), 30),
  measure("batch of 32 decoded 5s mono clips", () => timelineBatch.reduce((sum, channel) => sum + audioEnvelopePeaks(channel).reduce((peaks, peak) => peaks + peak, 0), 0), 12, 2),
];

console.log(JSON.stringify({
  runtime: `Bun ${Bun.version}`,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model ?? "unknown",
  operation: "pure JS absolute-peak envelope after PCM decode (fetch/decode/UI excluded)",
  sampleRate: SAMPLE_RATE,
  bucketsPerClip: 160,
  results,
  checksum: Number(checksum.toFixed(3)),
}, null, 2));
