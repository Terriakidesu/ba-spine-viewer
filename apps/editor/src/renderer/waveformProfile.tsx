import { Profiler, useCallback, useEffect, useRef, useState, type ProfilerOnRenderCallback } from "react";
import { AudioWaveform, type AudioWaveformMeasurement, type AudioWaveformStage } from "@ba-spine/editor-feature/AudioWaveform";
import { TimelineWorkspace } from "@ba-spine/editor-feature/TimelineWorkspace";
import { createProject, type EditorAudioClip, type EditorProject } from "@ba-spine/editor-feature/editorModel";
import type { DesktopAssetSource } from "@ba-spine/editor-feature/desktopSource";
import "@ba-spine/editor-feature/editor.css";
import "./waveformProfile.css";

const SAMPLE_RATE = 48_000;
const MIN_FRAME_SAMPLES_PER_TRIAL = 60;
const FRAME_SAMPLE_DEADLINE_MS = 1_500;
const PROFILE_STAGES: AudioWaveformStage[] = ["context", "fetch", "read", "decode", "envelope", "close", "error"];

interface StageSample {
  stage: AudioWaveformStage;
  durationMs: number;
}

interface ReactSample {
  phase: string;
  actualDurationMs: number;
  baseDurationMs: number;
}

interface Trial {
  id: string;
  index: number;
  startedAt: number;
  readyCount: number;
  completed: boolean;
  completionScheduled: boolean;
  stages: StageSample[];
  commits: ReactSample[];
  frameGapsMs: number[];
  longTasks: Array<{ startTimeMs: number; durationMs: number }>;
  lastFrameAt: number;
  frameRequest: number;
  completionFrameRequest: number;
  completionTimeout: number;
  timeout: number;
  longTaskObserver: PerformanceObserver | null;
  pageVisible: boolean;
  visibilityHandler: (() => void) | null;
  readyAt: number | null;
}

interface Session {
  id: string;
  surface: "component" | "timeline";
  clipCount: number;
  durationSeconds: number;
  repeatCount: number;
  fixtureBuildMs: number;
  audioUrl: string | null;
  source: DesktopAssetSource;
  project: EditorProject;
  trials: Array<Record<string, unknown>>;
  stageSamples: Array<{ trial: number; stage: AudioWaveformStage; durationMs: number }>;
  reactSamples: number[];
  frameGapsMs: number[];
  longTaskDurationsMs: number[];
  elapsedMs: number[];
  frameAdequacy: boolean[];
}

interface ActiveRun {
  id: string;
  index: number;
  sessionId: string;
  surface: Session["surface"];
  clipCount: number;
  audioUrl: string | null;
  source: DesktopAssetSource;
  project: EditorProject;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function distribution(values: number[]) {
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5) === null ? null : Number(percentile(values, 0.5)!.toFixed(3)),
    p95Ms: percentile(values, 0.95) === null ? null : Number(percentile(values, 0.95)!.toFixed(3)),
    maxMs: values.length ? Number(Math.max(...values).toFixed(3)) : null,
  };
}

function syntheticPcmWav(durationSeconds: number): Blob {
  const frameCount = SAMPLE_RATE * durationSeconds;
  const bytes = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, frameCount * 2, true);
  for (let index = 0; index < frameCount; index++) {
    const sample = Math.sin(index * 0.0037) * (0.25 + (index % 13) / 20);
    view.setInt16(44 + index * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function syntheticTimelineProject(clipCount: number, durationSeconds: number): EditorProject {
  const project = createProject("waveform-profile", [], []);
  const audio: EditorAudioClip[] = Array.from({ length: clipCount }, (_, index) => ({
    id: `profile-audio-${index + 1}`,
    name: `Synthetic clip ${index + 1}.wav`,
    path: "audio-profile.wav",
    start: index * 0.05,
    end: durationSeconds + index * 0.05,
    enabled: true,
    volume: 1,
    autoEnd: false,
  }));
  project.timeline = {
    ...project.timeline,
    duration: durationSeconds + 1,
    layers: [],
    layersInitialized: true,
    selectedLayerId: null,
    audio,
  };
  return project;
}

function syntheticDesktopSource(file: File): DesktopAssetSource {
  return {
    desktop: true,
    rootPath: "memory://waveform-profile",
    getSetFiles: async () => new Map<string, File>(),
    getDirectories: async () => [],
    getFile: async (path) => path === "audio-profile.wav" ? file : null,
    getManifest: async () => null,
    openText: async () => null,
    openProject: async () => null,
    readText: async () => null,
    openAudio: async () => [],
    saveText: async () => undefined,
    saveBatch: async () => ({ backupPath: null }),
  };
}

function summarizeTrial(trial: Trial, finishedAt: number) {
  const stages = Object.fromEntries(PROFILE_STAGES.map((stage) => [
    stage,
    distribution(trial.stages.filter((sample) => sample.stage === stage).map((sample) => sample.durationMs)),
  ]));
  const longTaskDurations = trial.longTasks.map((task) => task.durationMs);
  return {
    elapsedMs: Number((finishedAt - trial.startedAt).toFixed(2)),
    pageVisible: trial.pageVisible,
    waveformStageTimings: stages,
    reactProfilerCommits: {
      count: trial.commits.length,
      totalActualDurationMs: Number(trial.commits.reduce((sum, sample) => sum + sample.actualDurationMs, 0).toFixed(3)),
      samples: trial.commits.map((sample) => ({
        phase: sample.phase,
        actualDurationMs: Number(sample.actualDurationMs.toFixed(3)),
        baseDurationMs: Number(sample.baseDurationMs.toFixed(3)),
      })),
    },
    animationFrameGaps: {
      ...distribution(trial.frameGapsMs),
      over16_67ms: trial.frameGapsMs.filter((gap) => gap > 16.67).length,
      over33_33ms: trial.frameGapsMs.filter((gap) => gap > 33.33).length,
      samplingAdequate: trial.pageVisible && trial.frameGapsMs.length >= MIN_FRAME_SAMPLES_PER_TRIAL,
    },
    mainThreadLongTasks: {
      ...distribution(longTaskDurations),
      tasks: trial.longTasks.map((task) => ({
        startTimeMs: Number(task.startTimeMs.toFixed(2)),
        durationMs: Number(task.durationMs.toFixed(2)),
      })),
    },
    errors: trial.stages.filter((sample) => sample.stage === "error").length,
  };
}

export function WaveformProfile() {
  const [surface, setSurface] = useState<Session["surface"]>("timeline");
  const [clipCount, setClipCount] = useState(4);
  const [durationSeconds, setDurationSeconds] = useState(8);
  const [repeatCount, setRepeatCount] = useState(5);
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const trialRef = useRef<Trial | null>(null);

  const beginTrial = useCallback((session: Session, index: number) => {
    const trial: Trial = {
      id: `${session.id}-${index}`,
      index,
      startedAt: performance.now(),
      readyCount: 0,
      completed: false,
      completionScheduled: false,
      stages: [],
      commits: [],
      frameGapsMs: [],
      longTasks: [],
      lastFrameAt: performance.now(),
      frameRequest: 0,
      completionFrameRequest: 0,
      completionTimeout: 0,
      timeout: 0,
      longTaskObserver: null,
      pageVisible: document.visibilityState === "visible",
      visibilityHandler: null,
      readyAt: null,
    };
    trialRef.current = trial;
    trial.visibilityHandler = () => {
      if (document.visibilityState !== "visible") trial.pageVisible = false;
    };
    document.addEventListener("visibilitychange", trial.visibilityHandler);
    const tick = (now: number) => {
      if (trialRef.current !== trial || trial.completed) return;
      trial.frameGapsMs.push(now - trial.lastFrameAt);
      trial.lastFrameAt = now;
      trial.frameRequest = requestAnimationFrame(tick);
    };
    trial.frameRequest = requestAnimationFrame(tick);
    if (typeof PerformanceObserver !== "undefined") {
      try {
        trial.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) trial.longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
        });
        trial.longTaskObserver.observe({ type: "longtask", buffered: false });
      } catch {
        trial.longTaskObserver = null;
      }
    }
    trial.timeout = window.setTimeout(() => {
      if (trialRef.current !== trial || trial.completed) return;
      trial.stages.push({ stage: "error", durationMs: performance.now() - trial.startedAt });
      trial.readyCount = session.clipCount;
      completeWhenPainted(trial);
    }, 45_000);
    setRun({
      id: trial.id,
      index,
      sessionId: session.id,
      surface: session.surface,
      clipCount: session.clipCount,
      audioUrl: session.audioUrl,
      source: session.source,
      project: session.project,
    });
  }, []);

  const finishTrial = useCallback((trial: Trial) => {
    if (trial.completed || trialRef.current !== trial) return;
    trial.completed = true;
    cancelAnimationFrame(trial.frameRequest);
    cancelAnimationFrame(trial.completionFrameRequest);
    window.clearTimeout(trial.timeout);
    window.clearTimeout(trial.completionTimeout);
    if (trial.visibilityHandler) document.removeEventListener("visibilitychange", trial.visibilityHandler);
    for (const entry of trial.longTaskObserver?.takeRecords() ?? []) trial.longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
    trial.longTaskObserver?.disconnect();
    const session = sessionRef.current;
    if (!session) return;
    const finishedAt = performance.now();
    session.trials.push(summarizeTrial(trial, finishedAt));
    session.stageSamples.push(...trial.stages.map((sample) => ({ trial: trial.index + 1, ...sample })));
    session.reactSamples.push(...trial.commits.map((sample) => sample.actualDurationMs));
    session.frameGapsMs.push(...trial.frameGapsMs);
    session.longTaskDurationsMs.push(...trial.longTasks.map((task) => task.durationMs));
    session.elapsedMs.push(finishedAt - trial.startedAt);
    session.frameAdequacy.push(trial.pageVisible && trial.frameGapsMs.length >= MIN_FRAME_SAMPLES_PER_TRIAL);
    if (trial.index + 1 < session.repeatCount) {
      beginTrial(session, trial.index + 1);
      return;
    }
    const result = {
      profile: session.surface === "timeline"
        ? "development-only production TimelineWorkspace and AudioWaveform with synthetic PCM WAV input"
        : "development-only production AudioWaveform component with synthetic PCM WAV input",
      generatedAt: new Date().toISOString(),
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        visibilityState: document.visibilityState,
        sampleRate: SAMPLE_RATE,
      },
      fixture: {
        codec: "uncompressed mono PCM WAV; synthetic deterministic tone; generated in memory",
        surface: session.surface === "timeline" ? "TimelineWorkspace audio timeline and inspector; no Spine visual layers; in-memory DesktopAssetSource" : "AudioWaveform component rows",
        durationSeconds: session.durationSeconds,
        clipsPerTrial: session.clipCount,
        repetitions: session.repeatCount,
        spineVisualLayers: 0,
        audioContexts: "one per AudioWaveform, matching production component lifecycle",
        fixtureGenerationMs: Number(session.fixtureBuildMs.toFixed(3)),
        filesystemReads: 0,
        networkUploads: 0,
      },
      aggregateAcrossTrials: {
        elapsedMs: distribution(session.elapsedMs),
        waveformStageTimings: Object.fromEntries(PROFILE_STAGES.map((stage) => [
          stage,
          distribution(session.stageSamples.filter((sample) => sample.stage === stage).map((sample) => sample.durationMs)),
        ])),
        reactProfilerActualDurationMs: distribution(session.reactSamples),
        animationFrameGaps: {
          ...distribution(session.frameGapsMs),
          over16_67ms: session.frameGapsMs.filter((gap) => gap > 16.67).length,
          over33_33ms: session.frameGapsMs.filter((gap) => gap > 33.33).length,
          samplingAdequateInEveryTrial: session.frameAdequacy.every(Boolean),
          samplingAdequateTrials: session.frameAdequacy.filter(Boolean).length,
          totalTrials: session.frameAdequacy.length,
        },
        mainThreadLongTasksMs: distribution(session.longTaskDurationsMs),
      },
      trials: session.trials,
      interpretation: "Timeline mode exercises the production TimelineWorkspace audio track, inspector, and AudioWaveform children, but contains no Spine visual layers or library project. Synthetic WAV results do not model OGG decoding or the optimized packaged runtime. Sampling adequacy only confirms visible frame count; large frame gaps/long tasks in automation are not representative production evidence. Separate async fetch/decode timings from synchronous JS envelope CPU before considering workers or WASM.",
    };
    setReport(result);
    setRun(null);
    setRunning(false);
    setError(null);
    sessionRef.current = null;
    trialRef.current = null;
    if (session.audioUrl) URL.revokeObjectURL(session.audioUrl);
  }, [beginTrial]);

  const completeWhenPainted = useCallback((trial: Trial) => {
    if (trial.completed || trial.completionScheduled || trial.readyCount < (sessionRef.current?.clipCount ?? Number.POSITIVE_INFINITY)) return;
    trial.completionScheduled = true;
    trial.readyAt = performance.now();
    trial.completionTimeout = window.setTimeout(() => finishTrial(trial), FRAME_SAMPLE_DEADLINE_MS + 250);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (trialRef.current !== trial || trial.completed) return;
      const waitForFrameSamples = () => {
        if (trialRef.current !== trial || trial.completed) return;
        if (trial.frameGapsMs.length >= MIN_FRAME_SAMPLES_PER_TRIAL || performance.now() - trial.readyAt! >= FRAME_SAMPLE_DEADLINE_MS) {
          finishTrial(trial);
          return;
        }
        trial.completionFrameRequest = requestAnimationFrame(waitForFrameSamples);
      };
      trial.completionFrameRequest = requestAnimationFrame(waitForFrameSamples);
    }));
  }, [finishTrial]);

  const recordMeasurement = useCallback((runId: string, measurement: AudioWaveformMeasurement) => {
    const trial = trialRef.current;
    if (!trial || trial.id !== runId || trial.completed) return;
    trial.stages.push({ stage: measurement.stage, durationMs: measurement.durationMs });
    if (measurement.stage === "envelope" || measurement.stage === "error") {
      trial.readyCount++;
      completeWhenPainted(trial);
    }
  }, [completeWhenPainted]);

  const recordReactCommit: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
    const trial = trialRef.current;
    if (!trial || trial.completed) return;
    trial.commits.push({ phase, actualDurationMs: actualDuration, baseDurationMs: baseDuration });
  };

  function startProfile() {
    if (running) return;
    setReport(null);
    setError(null);
    setRunning(true);
    const fixtureStarted = performance.now();
    let file: File;
    let audioUrl: string | null = null;
    try {
      file = new File([syntheticPcmWav(durationSeconds)], "audio-profile.wav", { type: "audio/wav" });
      if (surface === "component") audioUrl = URL.createObjectURL(file);
    } catch (value) {
      setRunning(false);
      setError(value instanceof Error ? value.message : String(value));
      return;
    }
    const session: Session = {
      id: crypto.randomUUID(),
      surface,
      clipCount,
      durationSeconds,
      repeatCount,
      fixtureBuildMs: performance.now() - fixtureStarted,
      audioUrl,
      source: syntheticDesktopSource(file),
      project: syntheticTimelineProject(clipCount, durationSeconds),
      trials: [],
      stageSamples: [],
      reactSamples: [],
      frameGapsMs: [],
      longTaskDurationsMs: [],
      elapsedMs: [],
      frameAdequacy: [],
    };
    sessionRef.current = session;
    beginTrial(session, 0);
  }

  function cancelProfile() {
    const session = sessionRef.current;
    const trial = trialRef.current;
    if (trial) {
      trial.completed = true;
      cancelAnimationFrame(trial.frameRequest);
      cancelAnimationFrame(trial.completionFrameRequest);
      window.clearTimeout(trial.timeout);
      window.clearTimeout(trial.completionTimeout);
      trial.longTaskObserver?.disconnect();
      if (trial.visibilityHandler) document.removeEventListener("visibilitychange", trial.visibilityHandler);
    }
    if (session?.audioUrl) URL.revokeObjectURL(session.audioUrl);
    trialRef.current = null;
    sessionRef.current = null;
    setRun(null);
    setRunning(false);
  }

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("autostart") === "1") startProfile();
  }, []);

  return <main className="waveform-profile">
    <header>
      <p className="waveform-profile-eyebrow">LOCAL DEVELOPMENT FIXTURE</p>
      <h1>Timeline waveform profile</h1>
      <p>This page can mount the production <code>TimelineWorkspace</code> audio timeline and inspector (without Spine visual layers), or waveform components alone. It uses generated audio and an in-memory source mock; it does not open the asset library, read library files, call the desktop API, or send telemetry.</p>
      <p>Runs measure AudioContext creation, Blob fetch/read, decode, the production JS envelope, context close, React commits, animation-frame gaps, and browser long tasks separately.</p>
    </header>

    <section className="waveform-profile-controls" aria-label="Profile settings">
      <label>UI surface<select value={surface} disabled={running} onChange={(event) => setSurface(event.target.value as Session["surface"])}><option value="timeline">TimelineWorkspace (no Spine layers)</option><option value="component">AudioWaveform only</option></select></label>
      <label>Clips per trial<select value={clipCount} disabled={running} onChange={(event) => setClipCount(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={4}>4 (observed project maximum)</option></select></label>
      <label>Seconds per clip<select value={durationSeconds} disabled={running} onChange={(event) => setDurationSeconds(Number(event.target.value))}><option value={8}>8 (observed p95 interval)</option><option value={14}>14 (observed maximum interval)</option></select></label>
      <label>Repetitions<select value={repeatCount} disabled={running} onChange={(event) => setRepeatCount(Number(event.target.value))}><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option></select></label>
      <button type="button" disabled={running} onClick={startProfile}>Run profile</button>
      {running && <button type="button" className="waveform-profile-cancel" onClick={cancelProfile}>Cancel</button>}
    </section>

    {error && <p role="alert">{error}</p>}
    {running && <p role="status">Trial {(run?.index ?? 0) + 1} of {repeatCount}; decoding {clipCount} × {durationSeconds}s synthetic clips…</p>}

    {run && <section className={`waveform-profile-fixture${run.surface === "timeline" ? " is-timeline" : ""}`} aria-label="Live waveform fixture">
      <Profiler id="production-audio-waveforms" onRender={recordReactCommit}>
        {run.surface === "timeline"
          ? <TimelineWorkspace
            key={run.id}
            source={run.source}
            directory="waveform-profile"
            directories={[]}
            project={run.project}
            onSubtitleOpened={() => undefined}
            onAudioOpened={() => undefined}
            onRecentFile={() => undefined}
            onMutate={() => undefined}
            onLive={() => undefined}
            onBeginEdit={() => undefined}
            onSave={() => undefined}
            onRegisterSave={() => undefined}
            onStatus={() => undefined}
            onError={() => undefined}
            onRegisterMcp={() => undefined}
            onMcpSnapshot={() => undefined}
            onAudioWaveformProfile={(_clipId, measurement) => recordMeasurement(run.id, measurement)}
          />
          : <div className="waveform-profile-rows">
            {Array.from({ length: run.clipCount }, (_, index) => <div className="waveform-profile-row" key={`${run.id}-${index}`}>
              <AudioWaveform url={run.audioUrl ?? undefined} onProfile={(measurement) => recordMeasurement(run.id, measurement)} />
              <span>Clip {index + 1}</span>
            </div>)}
          </div>}
      </Profiler>
    </section>}

    {report && <section className="waveform-profile-report" aria-label="Waveform profile results">
      <h2>Profile results</h2>
      <p>Use medians and p95s across trials. Each trial targets 60 frames or waits 1.5 seconds after decoding. Sampling adequacy does not mean frame quality passed; large frame gaps and long tasks remain visible in the report.</p>
      <pre>{JSON.stringify(report, null, 2)}</pre>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(report, null, 2))}>Copy JSON report</button>
    </section>}
  </main>;
}
