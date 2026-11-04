import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SpineRenderer, type SpineCameraFrame, type SpineCameraMode, type SpineCameraPose, type SpineFiles, type SpineInteractionOverlay, type SpineLoadProgress, type SpineMeta } from "./spineRuntime";
import { DEFAULT_TALK_MIX_DURATION, normalizeAnimationMixDuration, type SpineInteractionProject } from "./spineInteraction";
import { timelineActiveAnimationClip, timelineAnimationClipPlaybackEnd, timelineAnimationClipSampleTime, timelineBlendModeCss, timelineIdleAnimation, timelineTalkIdleStart, timelineAnimationNeedsIdleUnderlay, timelineLayerAnimation, timelineLayerAnimationClips, timelineLayerPlaybackEnd, timelineLayerSampleTime, type SpineTimeline, type SpineTimelineLayer } from "./spineTimeline";

export interface SpineTimelineLayerCanvasProps {
  layer: SpineTimelineLayer;
  files: SpineFiles | null;
  currentTime: number;
  mainAnimation?: string;
  mainAnimationTime?: number;
  mainAnimationLoop?: boolean;
  openingMode?: SpineTimeline["openingMode"];
  sequenceId?: string;
  idleMode?: "none" | "persistent" | "bridge";
  talkMixDuration?: number;
  talkBlendOutStart?: number;
  characterHidden?: boolean;
  preserveDrawingBuffer?: boolean;
  interactionEnabled?: boolean;
  interactionProject?: SpineInteractionProject | null;
  showInteractionPoints?: boolean;
  effectsStrength?: number;
  resetCameraSignal?: number;
  cameraMode?: SpineCameraMode;
  sharedCameraFrame?: SpineCameraFrame | null;
  sharedCameraPose: SpineCameraPose | null;
  referenceCamera: boolean;
  onMeta: (layerId: string, meta: SpineMeta | null) => void;
  onCameraPose: (pose: SpineCameraPose) => void;
  onAnimationDuration: (layerId: string, animation: string, duration: number) => void;
  onMarkers?: (markers: number[]) => void;
  onInteractionPoints?: (layerId: string, overlay: SpineInteractionOverlay) => void;
  onRenderer?: (layerId: string, renderer: SpineRenderer | null) => void;
  onTalk?: (index: number, animation: string, eventCount: number) => boolean;
  onTalkClip?: (index: number, clipIndex: number) => void;
  onIntro?: (animation: string, eventCount: number) => boolean;
  onIntroClip?: (clipIndex: number) => void;
  onRendererLoading?: (layerId: string, loading: boolean) => void;
  onLoadProgress?: (layerId: string, progress: SpineLoadProgress) => void;
  onError: (value: string | null) => void;
}

/**
 * The single viewer/editor implementation of a timeline Spine layer.
 *
 * Keep renderer lifecycle, deterministic sampling, talk tails, idle phases,
 * interaction preservation, and visibility in this component. The two UIs
 * should provide state and callbacks, not fork playback rules.
 */
export function SpineTimelineLayerCanvas({ layer, files, currentTime, mainAnimation, mainAnimationTime, mainAnimationLoop, openingMode = "direct", sequenceId = "legacy", idleMode = "none", talkMixDuration = DEFAULT_TALK_MIX_DURATION, talkBlendOutStart, characterHidden = false, preserveDrawingBuffer = false, interactionEnabled = false, interactionProject = null, showInteractionPoints = false, effectsStrength, resetCameraSignal = 0, cameraMode, sharedCameraFrame, sharedCameraPose, referenceCamera, onMeta, onCameraPose, onAnimationDuration, onMarkers, onInteractionPoints, onRenderer, onTalk, onTalkClip, onIntro, onIntroClip, onRendererLoading, onLoadProgress, onError }: SpineTimelineLayerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineRenderer | null>(null);
  const [meta, setMeta] = useState<SpineMeta | null>(null);
  const onMetaRef = useRef(onMeta);
  const onCameraPoseRef = useRef(onCameraPose);
  const onAnimationDurationRef = useRef(onAnimationDuration);
  const onMarkersRef = useRef(onMarkers);
  const onInteractionPointsRef = useRef(onInteractionPoints);
  const onRendererRef = useRef(onRenderer);
  const onTalkRef = useRef(onTalk);
  const onTalkClipRef = useRef(onTalkClip);
  const onIntroRef = useRef(onIntro);
  const onIntroClipRef = useRef(onIntroClip);
  const onRendererLoadingRef = useRef(onRendererLoading);
  const onLoadProgressRef = useRef(onLoadProgress);
  const onErrorRef = useRef(onError);
  onMetaRef.current = onMeta;
  onCameraPoseRef.current = onCameraPose;
  onAnimationDurationRef.current = onAnimationDuration;
  onMarkersRef.current = onMarkers;
  onInteractionPointsRef.current = onInteractionPoints;
  onRendererRef.current = onRenderer;
  onTalkRef.current = onTalk;
  onTalkClipRef.current = onTalkClip;
  onIntroRef.current = onIntro;
  onIntroClipRef.current = onIntroClip;
  onRendererLoadingRef.current = onRendererLoading;
  onLoadProgressRef.current = onLoadProgress;
  onErrorRef.current = onError;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: SpineRenderer;
    try {
      renderer = new SpineRenderer(canvas, {
        onMeta: (value) => {
          setMeta(value);
          onMetaRef.current(layer.id, value);
          if (!value) return;
          for (const animationName of [value.introAnimation, value.idleAnimation]) {
            if (!animationName) continue;
            const duration = renderer.getEditorAnimationInfo(animationName).duration;
            if (duration > 0) onAnimationDurationRef.current(layer.id, animationName, duration);
          }
          renderer.setCameraMode("fit");
          if (referenceCamera) requestAnimationFrame(() => {
            const pose = renderer.getCameraPose();
            if (pose) onCameraPoseRef.current(pose);
          });
        },
        onProgress: () => {},
        onLoading: (loading) => onRendererLoadingRef.current?.(layer.id, loading),
        onLoadProgress: (progress) => onLoadProgressRef.current?.(layer.id, progress),
        onError: (value) => onErrorRef.current(value?.message ?? null),
        onInteractionPoints: (value) => onInteractionPointsRef.current?.(layer.id, value),
        onTalk: (index, animation, eventCount) => onTalkRef.current?.(index, animation, eventCount) ?? false,
        onTalkClip: (index, clipIndex) => onTalkClipRef.current?.(index, clipIndex),
        onIntro: (animation, eventCount) => onIntroRef.current?.(animation, eventCount) ?? false,
        onIntroClip: (clipIndex) => onIntroClipRef.current?.(clipIndex),
      }, { preserveDrawingBuffer });
    } catch (value) {
      onErrorRef.current(value instanceof Error ? value.message : String(value));
      return;
    }
    renderer.setPlaying(false);
    renderer.setLoop(false);
    if (effectsStrength !== undefined) renderer.setEffectsStrength(effectsStrength);
    rendererRef.current = renderer;
    onRendererRef.current?.(layer.id, renderer);
    return () => {
      onRendererRef.current?.(layer.id, null);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [layer.id, preserveDrawingBuffer, referenceCamera]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (files) void renderer.load(files, layer.directory, interactionProject);
    else renderer.clear();
    return () => renderer.clear();
  }, [files, interactionProject, layer.directory]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setInteractionMode(interactionEnabled ? "interaction" : "free");
    renderer.setShowInteractionPoints(showInteractionPoints);
  }, [interactionEnabled, showInteractionPoints]);

  useEffect(() => {
    if (effectsStrength !== undefined) rendererRef.current?.setEffectsStrength(effectsStrength);
  }, [effectsStrength]);

  useEffect(() => {
    if (resetCameraSignal > 0) rendererRef.current?.resetCamera();
  }, [resetCameraSignal]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !meta) return;
    const introDuration = meta.introAnimation ? renderer.getEditorAnimationInfo(meta.introAnimation).duration : 0;
    for (const clip of timelineLayerAnimationClips(layer, meta, sequenceId, openingMode, introDuration)) {
      if (!clip.animation || !meta.animations.includes(clip.animation)) continue;
      const duration = renderer.getEditorAnimationInfo(clip.animation).duration;
      if (duration > 0) onAnimationDurationRef.current(layer.id, clip.animation, duration);
    }
  }, [layer, meta, openingMode, sequenceId]);

  const intro = meta?.introAnimation;
  const introDuration = intro ? rendererRef.current?.getEditorAnimationInfo(intro).duration ?? 0 : 0;
  const activeClip = meta ? timelineActiveAnimationClip(layer, meta, currentTime, sequenceId, openingMode, introDuration, idleMode !== "none") : null;
  const animationClips = meta ? timelineLayerAnimationClips(layer, meta, sequenceId, openingMode, introDuration) : [];
  const latestTalkClip = animationClips
    .filter((clip) => clip.enabled !== false && /^talk/i.test(clip.animation) && clip.start <= currentTime)
    .sort((a, b) => b.start - a.start)[0] ?? null;
  const continuedClip = idleMode !== "none" && sequenceId === "opening" && activeClip?.continueAfterOpening === true;
  const followedAnimation = idleMode !== "none" && layer.followMainAnimation && mainAnimation
    ? meta?.animations.find((name) => name.toLocaleLowerCase() === mainAnimation.toLocaleLowerCase()) ?? ""
    : "";
  const followedContinuation = Boolean(followedAnimation);
  const authoredAnimation = meta ? followedAnimation || timelineLayerAnimation(layer, meta, mainAnimation, currentTime, sequenceId, openingMode, introDuration, idleMode !== "none") : "";
  const authoredDuration = authoredAnimation ? rendererRef.current?.getEditorAnimationInfo(authoredAnimation).duration ?? 0 : 0;
  const talkLayer = sequenceId.startsWith("talk-") && (layer.role === "character" || layer.role === "background");
  const talkAnimation = latestTalkClip?.animation || (talkLayer && /^talk/i.test(authoredAnimation) ? authoredAnimation : "");
  const talkFace = latestTalkClip?.faceAnimation ?? activeClip?.faceAnimation ?? layer.faceAnimation ?? "";
  const talkAnimationDuration = talkAnimation ? rendererRef.current?.getEditorAnimationInfo(talkAnimation).duration ?? 0 : 0;
  const talkStart = latestTalkClip?.start ?? layer.start;
  const idleTailStart = timelineTalkIdleStart(layer, talkAnimationDuration || authoredDuration);
  const fadeOutStart = Number.isFinite(talkBlendOutStart) ? talkBlendOutStart! : idleTailStart;
  const talkMix = normalizeAnimationMixDuration(talkMixDuration, DEFAULT_TALK_MIX_DURATION);
  const talkBlendActive = talkLayer && Boolean(talkAnimation) && currentTime >= talkStart && currentTime < fadeOutStart + talkMix;
  const talkFadeOutAlpha = talkMix > 0 ? Math.max(0, Math.min(1, (fadeOutStart + talkMix - currentTime) / talkMix)) : Number(currentTime < fadeOutStart);
  const talkFadeInAlpha = talkMix > 0 ? Math.max(0, Math.min(1, (currentTime - talkStart) / talkMix)) : 1;
  const talkAlpha = Math.min(talkFadeInAlpha, talkFadeOutAlpha);
  const idleTail = talkLayer && currentTime >= fadeOutStart + talkMix;
  const idle = idleMode !== "none" && !continuedClip && !followedContinuation || idleTail;
  const animation = talkBlendActive ? talkAnimation : meta ? idle ? timelineIdleAnimation(meta) : authoredAnimation : "";
  const animationDuration = animation ? rendererRef.current?.getEditorAnimationInfo(animation).duration ?? 0 : 0;
  const clipDuration = activeClip?.animation ? rendererRef.current?.getEditorAnimationInfo(activeClip.animation).duration ?? 0 : 0;
  const talkCharacter = sequenceId.startsWith("talk-") && layer.role === "character" && layer.endMode !== "manual";
  const followMainClock = Boolean(layer.followMainAnimation && mainAnimationTime !== undefined);
  const effectiveLoop = idle || continuedClip || (followMainClock && mainAnimationLoop !== undefined ? mainAnimationLoop : talkCharacter ? false : activeClip?.loop ?? layer.loop);
  const time = idle
    ? idleTail && idleMode === "none" ? Math.max(0, currentTime - (fadeOutStart + talkMix)) : currentTime
    : talkBlendActive
      ? latestTalkClip
        ? timelineAnimationClipSampleTime(latestTalkClip, currentTime, talkAnimationDuration)
        : timelineLayerSampleTime(layer, currentTime, sequenceId, openingMode, introDuration, talkAnimationDuration)
      : followMainClock
      ? mainAnimationTime!
      : activeClip
        ? timelineAnimationClipSampleTime(activeClip, currentTime, clipDuration, continuedClip)
        : timelineLayerSampleTime(layer, currentTime, sequenceId, openingMode, introDuration, animationDuration);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !meta || !animation || !meta.animations.some((name) => name === animation)) return;
    renderer.setAnimation(animation, true);
  }, [animation, meta]);

  useEffect(() => {
    if (!meta || !animation) return;
    const renderer = rendererRef.current;
    renderer?.sampleEditorAnimation(animation, idle ? "" : talkBlendActive ? talkFace : activeClip?.faceAnimation ?? layer.faceAnimation ?? "", time, effectiveLoop, talkBlendActive || timelineAnimationNeedsIdleUnderlay(animation), interactionEnabled, talkBlendActive ? talkAlpha : 1, talkBlendActive ? talkAlpha : 1);
    if (referenceCamera) onMarkersRef.current?.(renderer?.getEditorAnimationInfo(animation).markers ?? []);
  }, [activeClip?.faceAnimation, animation, effectiveLoop, followMainClock, idle, interactionEnabled, layer.faceAnimation, mainAnimationLoop, mainAnimationTime, meta, openingMode, referenceCamera, sequenceId, talkAlpha, talkBlendActive, talkCharacter, talkFace, time]);

  useEffect(() => {
    if (animationDuration > 0 && animation) onAnimationDurationRef.current(layer.id, animation, animationDuration);
  }, [animation, animationDuration, layer.id]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (cameraMode === "authored" && sharedCameraFrame) {
      renderer.setCameraFrame(sharedCameraFrame);
      return;
    }
    if (cameraMode === "authored") renderer.setCameraFrame(null);
    if (cameraMode) renderer.setCameraMode(cameraMode);
    if (!referenceCamera && sharedCameraPose) renderer.setCameraPose(sharedCameraPose);
    if (!referenceCamera || !cameraMode) return;
    const frame = requestAnimationFrame(() => {
      const pose = renderer.getCameraPose();
      if (pose) onCameraPoseRef.current(pose);
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraMode, referenceCamera, sharedCameraFrame, sharedCameraPose]);

  const layerEnd = activeClip
    ? timelineAnimationClipPlaybackEnd(talkCharacter && !Array.isArray(layer.animationClips) ? { ...activeClip, loop: false } : activeClip, clipDuration)
    : timelineLayerPlaybackEnd(talkCharacter ? { ...layer, loop: false } : layer, animationDuration);
  const clipDriven = Array.isArray(layer.animationClips) || sequenceId === "opening";
  const visible = layer.enabled
    && !(layer.role === "character" && characterHidden)
    && (idle ? layer.role === "character" || layer.role === "background" : clipDriven ? Boolean(activeClip) || followedContinuation || talkBlendActive : currentTime >= layer.start && (talkLayer || currentTime <= layerEnd));
  const style: CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: layer.order,
    opacity: visible ? layer.opacity : 0,
    mixBlendMode: timelineBlendModeCss(layer.blendMode ?? "normal"),
    visibility: visible ? "visible" : "hidden",
    transform: `translate(${layer.x}px, ${layer.y}px) scale(${layer.scale})`,
    transformOrigin: "center center",
    pointerEvents: interactionEnabled && visible ? "auto" : "none",
  };
  return <canvas ref={canvasRef} className="spine-timeline-layer-canvas" data-layer-id={layer.id} style={style} data-animation={animation} data-sample-time={time} aria-label={`${layer.name} Spine layer`} />;
}
