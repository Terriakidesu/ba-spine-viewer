import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { SpineRenderer, type SpineCameraFrame, type SpineCameraMode, type SpineCameraPose, type SpineFiles, type SpineInteractionMode, type SpineInteractionOverlay, type SpineLoadProgress, type SpineMeta, type SpineProgress } from "./spineRuntime";
import type { AssetSource } from "./spineAssets";
import { DEFAULT_TALK_MIX_DURATION, normalizeAnimationMixDuration, type SpineInteractionProject } from "./spineInteraction";
import { spineAudioPathCandidates } from "./spineAudio";
import { advanceSpineTimeline, timelineActiveColorClip, timelineActiveSubtitleTexts, timelineAudioPlaybackDecision, timelineAudioPreloadsReady, timelineBlendModeCss, timelineColorClipOpacity, timelineLayerAnimation, timelineLayerAnimationClips, timelineMainAnimation, timelineOpeningContinuationStart, timelinePlaybackDuration, timelineReferenceLayerId, timelineSceneHidesCharacter, timelineVisualLayers, type SpineTimeline, type SpineTimelineAudioPreloadState } from "./spineTimeline";
import { SpineTimelineLayerCanvas } from "./SpineTimelineLayerCanvas";
import { cameraAspectValue, changeSpineCameraAspectRatio, evaluateSpineCameraTrack, type SpineCameraAspectRatio } from "./spineCameraMotion";

export interface SpineCompositionViewportHandle {
  resetCamera: () => void;
  setResolutionScale: (scale: number, includeLayerScale?: boolean) => void;
  getCameraPose: () => SpineCameraPose | null;
  setCameraPose: (pose: SpineCameraPose | null) => void;
  toggleFullscreen: () => Promise<void>;
  restartPlayback: () => void;
  seek: (time: number) => void;
  sampleRecordingFrame: (time: number) => void;
  triggerTalk: (animation?: string) => void;
  setTalkAudioPending: (pending: boolean) => void;
  isTalkActive: () => boolean;
  startIntroAudio: () => void;
  getRecordingMetrics: () => { openingDuration: number; idleDuration: number; idleAnimation: string; ready: boolean };
}

function SpineColorLayer({ layer, time }: { layer: NonNullable<SpineTimeline["colorLayers"]>[number]; time: number }) {
  const clip = timelineActiveColorClip(layer, time);
  if (!clip) return null;
  const opacity = timelineColorClipOpacity(layer, clip, time);
  if (opacity <= 0) return null;
  return <div className="spine-color-layer" aria-hidden="true" style={{ zIndex: layer.order, backgroundColor: clip.color, opacity, mixBlendMode: timelineBlendModeCss(layer.blendMode) }} />;
}

interface SpineCompositionViewportProps {
  source: AssetSource;
  timeline: SpineTimeline;
  interactionMode: SpineInteractionMode;
  interactionProject: SpineInteractionProject | null;
  showInteractionPoints: boolean;
  currentTime: number;
  playing: boolean;
  speed: number;
  effectsStrength: number;
  cameraMode?: SpineCameraMode;
  aspectRatio?: SpineCameraAspectRatio;
  idleMode?: "none" | "persistent" | "bridge";
  preserveDrawingBuffer?: boolean;
  onMeta: (meta: SpineMeta | null) => void;
  onProgress: (progress: SpineProgress) => void;
  onLoading: (loading: boolean) => void;
  onLoadProgress: (progress: SpineLoadProgress) => void;
  onError: (error: Error | null) => void;
  onFinished: () => void;
  onTalk: (index: number, animation: string, eventCount: number) => boolean;
  onTalkClip: (index: number, clipIndex: number) => void;
  onIntro: (animation: string, eventCount: number) => boolean;
  onIntroClip: (clipIndex: number) => void;
}

export const SpineCompositionViewport = forwardRef<SpineCompositionViewportHandle, SpineCompositionViewportProps>(function SpineCompositionViewport({ source, timeline, interactionMode, interactionProject, showInteractionPoints, currentTime, playing, speed, effectsStrength, cameraMode = "fit", aspectRatio = "16:9", idleMode = "none", preserveDrawingBuffer = false, onMeta, onProgress, onLoading, onLoadProgress, onError, onFinished, onTalk, onTalkClip, onIntro, onIntroClip }, ref) {
  const stageRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef(currentTime);
  const phaseRef = useRef<{ timeline: SpineTimeline | null; idleMode: "none" | "persistent" | "bridge" }>({ timeline: null, idleMode: "none" });
  const finishedRef = useRef(false);
  const onProgressRef = useRef(onProgress);
  const onFinishedRef = useRef(onFinished);
  const onLoadingRef = useRef(onLoading);
  const onLoadProgressRef = useRef(onLoadProgress);
  const onErrorRef = useRef(onError);
  const [files, setFiles] = useState<Record<string, SpineFiles | null>>({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [loadingLayers, setLoadingLayers] = useState<Set<string>>(() => new Set());
  const [metas, setMetas] = useState<Record<string, SpineMeta | null>>({});
  const [animationDurations, setAnimationDurations] = useState<Record<string, number>>({});
  const [sharedCameraPose, setSharedCameraPose] = useState<SpineCameraPose | null>(null);
  const [referenceArtworkFrame, setReferenceArtworkFrame] = useState<SpineCameraFrame | null>(null);
  const activeCameraBoundRef = useRef<string | null>(null);
  const pendingCameraPoseRef = useRef<SpineCameraPose | null>(null);
  const [interactionOverlay, setInteractionOverlay] = useState<SpineInteractionOverlay>({ canvasWidth: 0, canvasHeight: 0, points: [] });
  const [resetCameraSignal, setResetCameraSignal] = useState(0);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [audioPreloadStates, setAudioPreloadStates] = useState<Record<string, SpineTimelineAudioPreloadState>>({});
  const audioElementsRef = useRef<Record<string, HTMLAudioElement | null>>({});
  const talkRendererRef = useRef<SpineRenderer | null>(null);
  const layerRenderersRef = useRef(new Map<string, SpineRenderer>());
  const resolutionScaleRef = useRef(1);
  const includeLayerScaleRef = useRef(false);
  const audioStartedRef = useRef<Record<string, boolean>>({});
  const audioPreviousTimeRef = useRef<Record<string, number | undefined>>({});
  const fileCacheRef = useRef(new Map<string, Promise<SpineFiles | null>>());
  onProgressRef.current = onProgress;
  onFinishedRef.current = onFinished;
  onLoadingRef.current = onLoading;
  onLoadProgressRef.current = onLoadProgress;
  onErrorRef.current = onError;

  const layers = useMemo(() => [...timeline.layers].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)), [timeline.layers]);
  const visualLayers = useMemo(() => timelineVisualLayers(timeline), [timeline.layers, timeline.colorLayers]);
  const referenceLayerId = timelineReferenceLayerId(timeline);
  const characterLayer = timeline.layers.find((layer) => layer.role === "character");
  const characterMeta = characterLayer ? metas[characterLayer.id] ?? null : null;
  const introAnimation = characterMeta?.introAnimation ?? "";
  const introDuration = characterLayer && introAnimation
    ? animationDurations[`${characterLayer.id}:${introAnimation}`] ?? 0
    : 0;
  const hasAnimationClips = Array.isArray(characterLayer?.animationClips);
  const mainAnimationName = characterLayer && characterMeta
    ? timelineLayerAnimation(characterLayer, characterMeta, undefined, currentTime, timeline.sequenceId, timeline.openingMode, introDuration, idleMode !== "none")
    : characterLayer
      ? characterLayer.animation || characterMeta?.idleAnimation || ""
    : "";
  const mainAnimationDuration = characterLayer && mainAnimationName
    ? animationDurations[`${characterLayer.id}:${mainAnimationName}`] ?? 0
    : 0;
  const openingMinimumDuration = timeline.sequenceId === "opening" && characterLayer
    ? hasAnimationClips ? 0 : characterLayer.start + (timeline.openingMode === "skip" ? 0 : introDuration)
    : 0;
  const talkMixDuration = normalizeAnimationMixDuration(interactionProject?.talkMixDuration, DEFAULT_TALK_MIX_DURATION);
  const playbackDuration = idleMode !== "none" ? Math.max(0.01, timeline.openingIdleDuration) : timelinePlaybackDuration(timeline, openingMinimumDuration, undefined, talkMixDuration);
  const talkBlendOutStart = /^talk-\d+$/i.test(timeline.sequenceId) ? playbackDuration - talkMixDuration : undefined;
  const openingIdleStart = timeline.sequenceId === "opening" && characterLayer
    ? timelineOpeningContinuationStart(timeline, characterLayer, characterMeta, introDuration)
    : 0;
  const openingIdleActive = idleMode !== "none";
  const effectiveCurrentTime = idleMode === "persistent" && openingIdleActive
    ? Math.max(currentTime, currentTimeRef.current, openingIdleStart)
    : openingIdleActive
      ? Math.max(currentTime, openingIdleStart)
      : currentTime;
  const mainAnimationState = characterLayer && characterMeta
    ? timelineMainAnimation(characterLayer, characterMeta, effectiveCurrentTime, timeline.sequenceId, timeline.openingMode, introDuration, mainAnimationDuration, idleMode !== "none")
    : null;
  const characterHidden = timelineSceneHidesCharacter(timeline, effectiveCurrentTime);
  const progressAnimation = mainAnimationState?.animation ?? null;
  // Do not consume an opening while the saved composition is still loading.
  // The page starts in autoplay mode, so advancing the shared playhead before
  // every layer has a renderer/meta would skip a short editor-authored intro.
  const compositionReady = layers.every((layer) => Boolean(files[layer.directory] && metas[layer.id]));
  const compositionLoading = filesLoading || (layers.length > 0 && !compositionReady) || loadingLayers.size > 0;
  const directoriesKey = [...new Set(layers.map((layer) => layer.directory))].join("|");
  const assetPathsKey = JSON.stringify(timeline.assetPaths ?? {});
  const audioKey = timeline.audio.map((clip) => `${clip.id}:${clip.path}`).join("|");
  const audioPreloadIdentityRef = useRef({ audioKey, source });
  const audioReady = audioPreloadIdentityRef.current.audioKey === audioKey
    && audioPreloadIdentityRef.current.source === source
    && timelineAudioPreloadsReady(timeline.audio, audioPreloadStates);
  // The Viewer output frame can use a different ratio from the authored shot.
  // Reframe the track for that output instead of letting the stage clip it.
  const effectiveCameraTrack = useMemo(
    () => timeline.camera ? changeSpineCameraAspectRatio(timeline.camera, aspectRatio) : null,
    [aspectRatio, timeline.camera],
  );
  const cameraArtworkAspect = cameraAspectValue(cameraMode === "authored" && effectiveCameraTrack?.enabled ? effectiveCameraTrack.aspectRatio : aspectRatio);
  const solvedCamera = cameraMode === "authored" && effectiveCameraTrack
    ? evaluateSpineCameraTrack(effectiveCameraTrack, effectiveCurrentTime, 1600, 900, referenceArtworkFrame, activeCameraBoundRef.current)
    : null;
  if (solvedCamera) activeCameraBoundRef.current = solvedCamera.activeBoundId;
  const sharedCameraFrame: SpineCameraFrame | null = solvedCamera
    ? { centerX: solvedCamera.frame.centerX, centerY: solvedCamera.frame.centerY, height: solvedCamera.frame.height }
    : null;

  useEffect(() => {
    onLoadingRef.current(compositionLoading);
  }, [compositionLoading]);

  useEffect(() => {
    const loaded = timeline.audio.filter((clip) => audioPreloadStates[clip.id] !== undefined && audioPreloadStates[clip.id] !== "loading").length;
    onLoadProgressRef.current({ stage: "audio", loaded, total: timeline.audio.length });
  }, [audioKey, audioPreloadStates, timeline.audio]);

  useEffect(() => { fileCacheRef.current.clear(); }, [source]);

  useEffect(() => {
    setReferenceArtworkFrame(talkRendererRef.current?.getArtworkCameraFrame(cameraArtworkAspect) ?? null);
  }, [cameraArtworkAspect, referenceLayerId]);

  useEffect(() => {
    activeCameraBoundRef.current = null;
  }, [timeline.sequenceId, referenceLayerId]);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const directories = [...new Set(layers.map((layer) => layer.directory))];
    if (!directories.length) {
      setFilesLoading(false);
      return () => { live = false; };
    }
    setFilesLoading(true);
    onLoadProgressRef.current({ stage: "files", loaded: 0, total: directories.length });
    let loaded = 0;
    void Promise.all(directories.map(async (item) => {
      const assetPath = timeline.assetPaths?.[item];
      const key = assetPath ?? item;
      let pending = fileCacheRef.current.get(key);
      if (!pending) {
        pending = assetPath && source.getSetFilesAtPath
          ? source.getSetFilesAtPath(assetPath, controller.signal)
          : source.getSetFiles(item, controller.signal);
        fileCacheRef.current.set(key, pending);
      }
      const files = await pending;
      if (live) onLoadProgressRef.current({ stage: "files", loaded: ++loaded, total: directories.length });
      return [item, files] as const;
    })).then((entries) => {
      if (!live) return;
      setFiles(Object.fromEntries(entries));
      setFilesLoading(false);
    }).catch((reason) => {
      if (!live) return;
      setFilesLoading(false);
      onErrorRef.current(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      live = false;
      controller.abort();
      fileCacheRef.current.clear();
    };
  // The layer directory key keeps this request scoped to the saved composition.
  // eslint is intentionally not part of this repository; keep the dependency explicit.
  }, [assetPathsKey, directoriesKey, source]);

  useEffect(() => {
    let live = true;
    const urls: Record<string, string> = {};
    audioPreloadIdentityRef.current = { audioKey, source };
    setAudioUrls({});
    setAudioPreloadStates(Object.fromEntries(timeline.audio.map((clip) => [clip.id, "loading" as const])));
    void Promise.all(timeline.audio.map(async (clip) => {
      for (const candidate of spineAudioPathCandidates(clip.path)) {
        let file: File | null = null;
        try {
          file = await source.getFile(candidate);
        } catch {
          // A missing candidate should not prevent the remaining path
          // spellings or other timeline clips from loading.
          continue;
        }
        if (file) {
          try {
            const url = URL.createObjectURL(file);
            urls[clip.id] = url;
            if (live) setAudioUrls((current) => ({ ...current, [clip.id]: url }));
            return;
          } catch {
            break;
          }
        }
      }
      if (live) setAudioPreloadStates((current) => ({ ...current, [clip.id]: "missing" }));
    })).then(() => {
      if (!live) {
        Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
        return;
      }
    });
    return () => {
      live = false;
      Object.values(audioElementsRef.current).forEach((audio) => {
        audio?.pause();
        audio?.removeAttribute("src");
      });
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [audioKey, source]);

  useEffect(() => {
    const previous = phaseRef.current;
    const timelineChanged = previous.timeline !== timeline;
    const modeChanged = previous.idleMode !== idleMode;
    const idle = idleMode !== "none";
    let report = false;

    if (timelineChanged) {
      currentTimeRef.current = idle ? openingIdleStart : 0;
      report = true;
    } else if (modeChanged) {
      if (idleMode === "bridge") currentTimeRef.current = openingIdleStart;
      else if (idleMode === "persistent") currentTimeRef.current = Math.max(currentTimeRef.current, currentTime, openingIdleStart);
      else currentTimeRef.current = currentTime;
      report = true;
    } else if (idle && currentTimeRef.current < openingIdleStart) {
      // Intro metadata may arrive after the opening has switched to idle.
      // Move the clock forward to the measured idle boundary, never back to
      // the opening start.
      currentTimeRef.current = openingIdleStart;
      report = true;
    }

    phaseRef.current = { timeline, idleMode };
    if (report) {
      const time = idleMode === "persistent"
        ? Math.min(playbackDuration, Math.max(openingIdleStart, currentTimeRef.current))
        : Math.min(playbackDuration, Math.max(0, currentTimeRef.current));
      onProgressRef.current({ time, duration: playbackDuration, animation: progressAnimation });
    }
  }, [currentTime, idleMode, openingIdleStart, playbackDuration, progressAnimation, timeline]);

  useEffect(() => {
    if (idleMode === "persistent") return;
    currentTimeRef.current = idleMode === "bridge"
      ? Math.max(currentTime, openingIdleStart)
      : currentTime;
  }, [currentTime, idleMode, openingIdleStart, timeline]);

  useEffect(() => {
    const duration = playbackDuration;
    const time = idleMode === "persistent"
      ? Math.min(duration, Math.max(openingIdleStart, currentTimeRef.current))
      : Math.max(0, Math.min(duration, currentTimeRef.current));
    if (idleMode !== "persistent") currentTimeRef.current = time;
    onProgressRef.current({ time, duration, animation: progressAnimation });
  }, [idleMode, openingIdleStart, playbackDuration, progressAnimation, timeline]);

  useEffect(() => {
    setInteractionOverlay({ canvasWidth: 0, canvasHeight: 0, points: [] });
  }, [directoriesKey, interactionMode, showInteractionPoints, timeline.sequenceId]);

  useEffect(() => {
    activeCameraBoundRef.current = null;
  }, [timeline.sequenceId, timeline.camera]);

  useEffect(() => {
    audioStartedRef.current = {};
    audioPreviousTimeRef.current = {};
  }, [audioKey, timeline.sequenceId]);

  useEffect(() => {
    if (!compositionReady || !audioReady || !playing) Object.values(audioElementsRef.current).forEach((audio) => audio?.pause());
    if (!compositionReady || !audioReady) return;
    for (const clip of timeline.audio) {
      const audio = audioElementsRef.current[clip.id];
      if (!audio) continue;
      if (audioPreloadStates[clip.id] === "missing") {
        audio.pause();
        audioStartedRef.current[clip.id] = false;
        audioPreviousTimeRef.current[clip.id] = undefined;
        continue;
      }
      audio.volume = clip.volume;
      audio.playbackRate = speed;
      const active = idleMode === "none" && clip.enabled && effectiveCurrentTime >= clip.start && effectiveCurrentTime <= clip.end;
      const decision = timelineAudioPlaybackDecision({
        active,
        playing,
        currentTime: effectiveCurrentTime,
        previousTime: audioPreviousTimeRef.current[clip.id],
        started: audioStartedRef.current[clip.id] === true,
        ended: audio.ended,
      });
      audioPreviousTimeRef.current[clip.id] = effectiveCurrentTime;
      audioStartedRef.current[clip.id] = decision.started;
      if (!active) {
        audio.pause();
        continue;
      }
      const local = Math.max(0, effectiveCurrentTime - clip.start);
      if (decision.seek || Math.abs(audio.currentTime - local) > 0.08) audio.currentTime = local;
      if (decision.play) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  }, [audioPreloadStates, audioReady, compositionReady, effectiveCurrentTime, idleMode, playing, speed, timeline.audio]);

  useEffect(() => {
    if (!playing || !compositionReady || !audioReady) return;
    let frame = 0;
    let previous = 0;
    finishedRef.current = false;
    const tick = (now: number) => {
      if (!previous) previous = now;
      const elapsed = Math.max(0, (now - previous) / 1000) * speed;
      previous = now;
      const duration = playbackDuration;
      let next = currentTimeRef.current + elapsed;
      if (idleMode === "persistent") {
        // Persistent idle is a continuation of the opening clock, not a loop
        // back to time zero. Let the authored idle animation and background
        // clocks keep advancing past the opening's one-shot endpoint.
        currentTimeRef.current = next;
        onProgressRef.current({ time: next, duration, animation: characterMeta?.idleAnimation ?? progressAnimation });
        frame = requestAnimationFrame(tick);
        return;
      }
      const advanced = advanceSpineTimeline(currentTimeRef.current, elapsed, 1, duration, timeline.loop && idleMode === "none");
      if (advanced.finished) {
        next = advanced.time;
        const finish = !finishedRef.current;
        finishedRef.current = true;
        currentTimeRef.current = next;
        onProgressRef.current({ time: next, duration, animation: progressAnimation });
        if (finish) onFinishedRef.current();
        return;
      }
      next = advanced.time;
      currentTimeRef.current = next;
      onProgressRef.current({ time: next, duration, animation: progressAnimation });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioReady, compositionReady, idleMode, playbackDuration, playing, progressAnimation, speed, timeline]);

  useImperativeHandle(ref, () => ({
    resetCamera: () => setResetCameraSignal((value) => value + 1),
    setResolutionScale: (scale, includeLayerScale = false) => {
      resolutionScaleRef.current = scale;
      includeLayerScaleRef.current = includeLayerScale;
      for (const [id, renderer] of layerRenderersRef.current) {
        const layerScale = includeLayerScale ? Math.max(1, timeline.layers.find((layer) => layer.id === id)?.scale ?? 1) : 1;
        renderer.setResolutionScale(scale * layerScale);
      }
    },
    getCameraPose: () => talkRendererRef.current?.getCameraPose() ?? sharedCameraPose,
    setCameraPose: (pose) => {
      pendingCameraPoseRef.current = pose;
      setSharedCameraPose(pose);
      if (pose && talkRendererRef.current) {
        talkRendererRef.current.setCameraPose(pose);
        pendingCameraPoseRef.current = null;
      }
    },
    toggleFullscreen: async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageRef.current?.requestFullscreen) await stageRef.current.requestFullscreen();
    },
    restartPlayback: () => {
      if (interactionMode === "interaction") talkRendererRef.current?.restartPlayback();
      const restartTime = idleMode !== "none" && timeline.sequenceId === "opening" ? openingIdleStart : 0;
      currentTimeRef.current = restartTime;
      onProgressRef.current({ time: restartTime, duration: playbackDuration, animation: progressAnimation });
    },
    seek: (time) => {
      const next = idleMode !== "none" && timeline.sequenceId === "opening"
        ? Math.max(openingIdleStart, Math.min(playbackDuration, time))
        : Math.max(0, Math.min(playbackDuration, time));
      currentTimeRef.current = next;
      onProgressRef.current({ time: next, duration: playbackDuration, animation: progressAnimation });
    },
    sampleRecordingFrame: (time) => {
      if (!Number.isFinite(time)) return;
      const next = Math.max(0, time);
      currentTimeRef.current = next;
      finishedRef.current = false;
      onProgressRef.current({ time: next, duration: playbackDuration, animation: progressAnimation });
    },
    triggerTalk: (animation) => talkRendererRef.current?.triggerTalk(animation),
    setTalkAudioPending: (pending) => talkRendererRef.current?.setTalkAudioPending(pending),
    isTalkActive: () => talkRendererRef.current?.isTalkActive() ?? false,
    startIntroAudio: () => talkRendererRef.current?.startIntroAudio(),
    getRecordingMetrics: () => {
      const layer = timeline.layers.find((candidate) => candidate.role === "character");
      const layerMeta = layer ? metas[layer.id] ?? null : null;
      if (!layer || !layerMeta) return { openingDuration: 0, idleDuration: 0, idleAnimation: "", ready: false };
      const intro = layerMeta.introAnimation ? animationDurations[`${layer.id}:${layerMeta.introAnimation}`] ?? 0 : 0;
      const clips = timelineLayerAnimationClips(layer, layerMeta, timeline.sequenceId, timeline.openingMode, intro);
      const continuation = clips.filter((clip) => clip.enabled !== false && clip.continueAfterOpening).sort((a, b) => b.start - a.start)[0];
      const idleAnimation = continuation?.animation || layer.animation || layerMeta.idleAnimation || "";
      const knownIdleDuration = animationDurations[`${layer.id}:${idleAnimation}`] ?? 0;
      const idleDuration = knownIdleDuration || (idleAnimation && talkRendererRef.current
        ? talkRendererRef.current.getEditorAnimationInfo(idleAnimation).duration
        : 0);
      return {
        openingDuration: timeline.sequenceId === "opening" ? timelineOpeningContinuationStart(timeline, layer, layerMeta, intro) : 0,
        idleDuration,
        idleAnimation,
        ready: compositionReady && audioReady,
      };
    },
  }), [animationDurations, audioReady, compositionReady, idleMode, interactionMode, layers, metas, openingIdleStart, playbackDuration, progressAnimation, referenceLayerId, sharedCameraPose, timeline]);

  const activeSubtitleTexts = idleMode === "none" ? timelineActiveSubtitleTexts(timeline, effectiveCurrentTime) : [];
  const interactionLayer = layers.find((layer) => layer.id === referenceLayerId);
  const interactionOverlayStyle: CSSProperties = interactionLayer
    ? {
      position: "absolute",
      inset: 0,
      zIndex: 2,
      transform: `translate(${interactionLayer.x}px, ${interactionLayer.y}px) scale(${interactionLayer.scale})`,
      transformOrigin: "center center",
      pointerEvents: "none",
    }
    : {};
  const interactionColors = { pat: "#ff668f", pinch: "#28c7ed", touch: "#ffc857" } as const;
  return <div ref={stageRef} className={`spine-stage spine-stage-composition${interactionMode === "interaction" ? " spine-stage-interaction" : ""}`}>
     <div className="spine-visual-composition">
        {visualLayers.map((entry) => entry.kind === "spine"
            ? <SpineTimelineLayerCanvas
              key={`spine-${entry.layer.id}`}
              layer={entry.layer}
              files={files[entry.layer.directory] ?? null}
              interactionEnabled={interactionMode === "interaction" && entry.layer.id === referenceLayerId}
              cameraControlsEnabled={interactionMode === "free" && entry.layer.id === referenceLayerId}
              interactionProject={entry.layer.id === referenceLayerId ? interactionProject : null}
              talkMixDuration={talkMixDuration}
              talkBlendOutStart={talkBlendOutStart}
              showInteractionPoints={showInteractionPoints}
              currentTime={effectiveCurrentTime}
              mainAnimation={mainAnimationState?.animation}
              mainAnimationTime={mainAnimationState?.time}
              mainAnimationLoop={mainAnimationState?.loop}
              sequenceId={timeline.sequenceId}
              openingMode={timeline.openingMode}
              idleMode={idleMode}
              characterHidden={characterHidden}
              preserveDrawingBuffer={preserveDrawingBuffer}
              cameraMode={cameraMode}
              sharedCameraFrame={sharedCameraFrame}
              sharedCameraPose={sharedCameraPose}
              referenceCamera={entry.layer.id === referenceLayerId}
              effectsStrength={effectsStrength}
              resetCameraSignal={resetCameraSignal}
              onMeta={(id, value) => { setMetas((current) => current[id] === value ? current : { ...current, [id]: value }); if (id === referenceLayerId) onMeta(value); }}
              onAnimationDuration={(id, animation, duration) => setAnimationDurations((current) => current[`${id}:${animation}`] === duration ? current : { ...current, [`${id}:${animation}`]: duration })}
              onInteractionPoints={(id, value) => { if (id === referenceLayerId) setInteractionOverlay(value); }}
              onRenderer={(id, value) => {
                if (value) {
                  layerRenderersRef.current.set(id, value);
                  const layerScale = includeLayerScaleRef.current ? Math.max(1, timeline.layers.find((layer) => layer.id === id)?.scale ?? 1) : 1;
                  value.setResolutionScale(resolutionScaleRef.current * layerScale);
                } else {
                  layerRenderersRef.current.delete(id);
                }
                if (id !== referenceLayerId) return;
                if (!value) {
                  pendingCameraPoseRef.current = talkRendererRef.current?.getCameraPose() ?? sharedCameraPose;
                  talkRendererRef.current = null;
                  return;
                }
                talkRendererRef.current = value;
                setReferenceArtworkFrame(value.getArtworkCameraFrame(cameraArtworkAspect));
                const pendingPose = pendingCameraPoseRef.current;
                if (pendingPose) {
                  value.setCameraPose(pendingPose);
                  pendingCameraPoseRef.current = null;
                }
              }}
              onRendererLoading={(id, loading) => setLoadingLayers((current) => { const next = new Set(current); if (loading) next.add(id); else next.delete(id); return next; })}
              onLoadProgress={(_id, value) => onLoadProgressRef.current(value)}
              onCameraPose={(pose) => setSharedCameraPose((current) => current && current.x === pose.x && current.y === pose.y && current.zoom === pose.zoom ? current : pose)}
              onTalk={onTalk}
              onTalkClip={onTalkClip}
              onIntro={onIntro}
              onIntroClip={onIntroClip}
              onError={(value) => onError(value ? new Error(value) : null)} />
         : <SpineColorLayer key={`color-${entry.layer.id}`} layer={entry.layer} time={effectiveCurrentTime} />)}
     </div>
    {showInteractionPoints && interactionOverlay.points.length > 0 && interactionOverlay.canvasWidth > 0 && interactionOverlay.canvasHeight > 0 && <svg className="spine-interaction-overlay" style={interactionOverlayStyle} viewBox={`0 0 ${interactionOverlay.canvasWidth} ${interactionOverlay.canvasHeight}`} preserveAspectRatio="none" aria-hidden="true">
      {interactionOverlay.points.map((point, index) => {
        const color = interactionColors[point.kind];
        const matrix = `matrix(${point.axisXEndX - point.centerX} ${point.axisXEndY - point.centerY} ${point.axisYEndX - point.centerX} ${point.axisYEndY - point.centerY} ${point.centerX} ${point.centerY})`;
        return <g key={`${point.kind}-${index}`} className={`spine-interaction-point spine-interaction-point-${point.kind}`}>
          {point.shape === "ellipse" ? <ellipse transform={matrix} cx="0" cy="0" rx="1" ry="1" fill={color} fillOpacity=".14" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /> : <rect transform={matrix} x="-1" y="-1" width="2" height="2" fill={color} fillOpacity=".14" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />}
          <circle cx={point.centerX} cy={point.centerY} r="7" fill={color} fillOpacity=".9" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <text x={point.centerX + 11} y={point.centerY - 10} fill={color} stroke="#10202d" strokeWidth="4" paintOrder="stroke" fontSize="18" fontWeight="700">{point.kind}</text>
        </g>;
      })}
    </svg>}
    {activeSubtitleTexts.length > 0 && <div className="spine-dialogue" aria-live="polite">{activeSubtitleTexts.map((text, index) => <div key={`${index}-${text}`}>{text}</div>)}</div>}
    {timeline.audio.map((clip) => <audio key={clip.id} ref={(element) => { audioElementsRef.current[clip.id] = element; }} src={audioUrls[clip.id]} preload="auto" onCanPlay={() => setAudioPreloadStates((current) => current[clip.id] === "ready" ? current : { ...current, [clip.id]: "ready" })} onError={() => setAudioPreloadStates((current) => current[clip.id] === "missing" ? current : { ...current, [clip.id]: "missing" })} />)}
  </div>;
});
