import { Physics, type AnimationState, type Skeleton } from "@esotericsoftware/spine-core";
import type { EditorInteraction } from "./editorModel";
import { clearInteractionTrack, interactionKind, interactionPhaseAfterStart, interactionPressReady, setInteractionTrack } from "@ba-spine/spine-runtime/spine/spineInteraction";
import {
  applyInteractionMotion,
  applyInteractionMotionReturn,
  beforeInteractionMotion,
  beginInteractionMotion,
  beginInteractionMotionReturn,
  createInteractionMotionState,
  interactionMotionReturnComplete,
  interactionMotionReturnProgress,
  resetInteractionMotion,
  type SpineInteractionMotionState,
} from "@ba-spine/spine-runtime/spine/spineInteractionMotion";

export type PreviewPhase = "idle" | "starting" | "holding" | "releasing";

export interface InteractionPreviewDebug {
  phase: PreviewPhase;
  interactionName: string;
  regionName: string;
  trigger: EditorInteraction["trigger"] | null;
  bodyAnimation: string;
  faceAnimation: string;
  held: boolean;
  targetBonePath: string | null;
  offsetX: number;
  offsetY: number;
  rotation: number;
  returning: boolean;
  returnProgress: number;
}

/** Runs the authored project, independently of the viewer's detected presets. */
export class InteractionPreview {
  phase: PreviewPhase = "idle";
  interaction: EditorInteraction | null = null;
  regionName = "";
  held = false;
  private pending = false;
  private released = false;
  private elapsed = 0;
  private duration = 0;
  private pointer: { x: number; y: number } | null = { x: 0, y: 0 };
  private motion: SpineInteractionMotionState = createInteractionMotionState();

  get progress() {
    return { time: this.phase === "holding" && this.duration > 0 ? this.elapsed % this.duration : Math.min(this.elapsed, this.duration), duration: this.duration };
  }

  get debug(): InteractionPreviewDebug {
    const item = this.interaction;
    const bodyAnimation = item
      ? this.phase === "starting" ? item.startAnimation : this.phase === "holding" ? item.followAnimation : this.phase === "releasing" ? item.endAnimation : ""
      : "";
    const faceAnimation = item
      ? this.phase === "starting" ? item.faceStartAnimation : this.phase === "holding" ? item.faceFollowAnimation : this.phase === "releasing" ? item.faceEndAnimation : ""
      : "";
    return {
      phase: this.phase,
      interactionName: item?.name ?? "",
      regionName: this.regionName,
      trigger: item?.trigger ?? null,
      bodyAnimation,
      faceAnimation,
      held: this.held,
      targetBonePath: this.motion.resolvedTargetBonePath ?? item?.followTargetBone ?? null,
      offsetX: this.motion.offset.x,
      offsetY: this.motion.offset.y,
      rotation: this.motion.rotation,
      returning: this.motion.returning,
      returnProgress: interactionMotionReturnProgress(this.motion),
    };
  }

  press(interaction: EditorInteraction, regionName: string, x: number, y: number) {
    if (this.phase !== "idle" || this.pending) return;
    this.interaction = structuredClone(interaction);
    this.regionName = regionName;
    this.pointer = { x, y };
    const kind = interactionKind(interaction) ?? "touch";
    beginInteractionMotion(this.motion, this.interaction, kind, this.pointer);
    this.held = true;
    this.released = false;
    this.pending = true;
  }

  move(x: number, y: number) { this.pointer = { x, y }; }
  leave() { this.pointer = null; }
  release() { this.held = false; this.released = true; }

  beforeUpdate() {
    beforeInteractionMotion(this.motion);
  }

  reset(state?: AnimationState) {
    resetInteractionMotion(this.motion);
    state?.clearTrack(1);
    state?.clearTrack(2);
    this.phase = "idle";
    this.interaction = null;
    this.pending = this.held = this.released = false;
    this.regionName = "";
  }

  private enter(phase: PreviewPhase, state: AnimationState) {
    this.phase = phase;
    this.elapsed = 0;
    const item = this.interaction;
    if (!item) return;
    if (phase === "releasing") beginInteractionMotionReturn(this.motion);
    const main = phase === "starting" ? item.startAnimation : phase === "holding" ? item.followAnimation : item.endAnimation;
    const face = phase === "starting" ? item.faceStartAnimation : phase === "holding" ? item.faceFollowAnimation : item.faceEndAnimation;
    const mixDuration = phase === "starting" ? item.startMixDuration
      : phase === "holding" ? item.followMixDuration
        : item.releaseMixDuration;
    this.duration = 0;
    for (const [track, name] of [[1, main], [2, face]] as const) {
      if (name && state.data.skeletonData.findAnimation(name)) {
        const entry = setInteractionTrack(state, track, name, phase === "holding", mixDuration);
        this.duration = Math.max(this.duration, entry?.animation?.duration ?? 0);
      } else clearInteractionTrack(state, track, true, mixDuration);
    }
    if (phase === "releasing") this.duration = Math.max(this.duration, item.returnDuration);
  }

  update(delta: number, skeleton: Skeleton, state: AnimationState) {
    if (this.pending && this.interaction?.trigger === "drag") {
      if (!this.held) { this.reset(state); return; }
      const pointer = this.pointer;
      if (!pointer) return;
      const origin = this.motion.origin ?? pointer;
      if (!interactionPressReady(this.interaction.trigger, this.held, Math.hypot(pointer.x - origin.x, pointer.y - origin.y))) return;
    }
    if (this.pending) { this.pending = false; this.enter("starting", state); }
    else this.elapsed += delta;
    const item = this.interaction;
    if (!item) return;
    if (this.phase === "starting" && (this.elapsed >= this.duration || (this.released && item.trigger !== "press"))) {
      this.enter(interactionPhaseAfterStart(item.trigger, this.held), state);
    }
    if (this.phase === "holding" && !this.held) this.enter("releasing", state);
    // Apply newly entered body/face tracks immediately, then apply the shared
    // editor/viewer motion in the animated parent space.
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.pose);
    if (this.phase === "starting" || (this.phase === "holding" && item.trigger !== "press")) {
      applyInteractionMotion(this.motion, skeleton, this.pointer, delta);
      if (this.motion.target?.directCheek && this.motion.resolvedTargetBonePath) item.followTargetBone = this.motion.resolvedTargetBonePath;
    } else if (this.phase === "releasing") {
      // The state update above happened before the release track was entered;
      // its first frame and the return clock both start on the next tick.
      applyInteractionMotionReturn(this.motion, skeleton, this.elapsed === 0 ? 0 : delta);
    }
    if (this.phase === "releasing" && this.elapsed >= this.duration && interactionMotionReturnComplete(this.motion)) {
      this.reset(state);
      skeleton.setToSetupPose();
      state.apply(skeleton);
      skeleton.updateWorldTransform(Physics.pose);
    }
  }
}
