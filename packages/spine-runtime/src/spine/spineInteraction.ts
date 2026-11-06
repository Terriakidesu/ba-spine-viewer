import { normalizeSpineTimeline, type SpineTimeline } from "./spineTimeline";
import { DEFAULT_EFFECTS_STRENGTH } from "./spineEffects";

export type SpineInteractionReturnEasing = "linear" | "ease-out" | "ease-in-out";
export const DEFAULT_INTERACTION_RETURN_DURATION = 0.35;
export const DEFAULT_INTERACTION_RETURN_EASING: SpineInteractionReturnEasing = "ease-out";

export interface SpineAnimationPair {
  main: string;
  face: string | null;
}

export interface SpineInteractionAction {
  start: SpineAnimationPair;
  follow: SpineAnimationPair;
  release: SpineAnimationPair | null;
}

export type SpineInteractionKind = "pat" | "pinch" | "touch";
export type SpineInteractionTrigger = "press" | "hold" | "drag";

/** Shared trigger gate used by the native preview and the published renderer. */
export function interactionPressReady(trigger: SpineInteractionTrigger, held: boolean, distance: number, threshold = 4): boolean {
  if (!held) return false;
  return trigger !== "drag" || distance >= threshold;
}

/** Resolve the phase entered after the authored start animation completes. */
export function interactionPhaseAfterStart(trigger: SpineInteractionTrigger, held: boolean): "holding" | "releasing" {
  return trigger !== "press" && held ? "holding" : "releasing";
}

export interface SpineInteractionRegion {
  id: string;
  name: string;
  enabled: boolean;
  shape: "ellipse" | "rectangle";
  anchorBone: string | null;
  offsetX: number;
  offsetY: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
}

export interface SpineAuthoredInteraction {
  id: string;
  name: string;
  color?: string;
  enabled: boolean;
  trigger: "press" | "hold" | "drag";
  startAnimation: string;
  followAnimation: string;
  endAnimation: string;
  faceStartAnimation: string;
  faceFollowAnimation: string;
  faceEndAnimation: string;
  followTargetBone: string | null;
  sensitivity: number;
  limitX: number;
  limitY: number;
  smoothing: number;
  /** Optional for legacy projects; normalization supplies a stable default. */
  returnDuration?: number;
  returnEasing?: SpineInteractionReturnEasing;
  /** Per-transition animation crossfades; omitted legacy fields use the default. */
  startMixDuration?: number;
  followMixDuration?: number;
  releaseMixDuration?: number;
  /** Local parent-space translation axes. Missing legacy fields mean both. */
  allowX?: boolean;
  allowY?: boolean;
  /** Rotate the target around its animated local pose while following. */
  rotationEnabled?: boolean;
  rotationAxis?: "x" | "y";
  rotationMin?: number;
  rotationMax?: number;
  regions: SpineInteractionRegion[];
}

export interface SpineInteractionProject {
  schemaVersion: number;
  name?: string;
  assetDirectory: string;
  /** Explicit authored entry; null intentionally selects the runtime intro. */
  entrySequence?: string | null;
  /** Shared Talk animation crossfade for runtime dialogue and timeline previews. */
  talkMixDuration?: number;
  /** Additive and screen light contribution used by Viewer and Editor previews. */
  effectsStrength?: number;
  interactions: SpineAuthoredInteraction[];
  timeline?: SpineTimeline;
  sequences?: Record<string, SpineTimeline>;
}

export interface SpineInteractionBundle {
  schemaVersion: number;
  projects: SpineInteractionProject[];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const result = finiteNumber(value, fallback);
  return result > 0 ? result : fallback;
}

function normalizeInteractionRegion(value: unknown, index: number): SpineInteractionRegion | null {
  if (!value || typeof value !== "object") return null;
  const region = value as Partial<SpineInteractionRegion>;
  return {
    id: stringValue(region.id, `region-${index + 1}`),
    name: stringValue(region.name, `Region ${index + 1}`),
    enabled: region.enabled !== false,
    shape: region.shape === "rectangle" ? "rectangle" : "ellipse",
    anchorBone: nullableString(region.anchorBone),
    offsetX: finiteNumber(region.offsetX, 0),
    offsetY: finiteNumber(region.offsetY, 0),
    radiusX: positiveNumber(region.radiusX, 100),
    radiusY: positiveNumber(region.radiusY, 75),
    rotation: finiteNumber(region.rotation, 0),
  };
}

function normalizeAuthoredInteraction(value: unknown, index: number): SpineAuthoredInteraction | null {
  if (!value || typeof value !== "object") return null;
  const interaction = value as Partial<SpineAuthoredInteraction>;
  const trigger = interaction.trigger === "press" || interaction.trigger === "drag" ? interaction.trigger : "hold";
  const normalized: SpineAuthoredInteraction = {
    id: stringValue(interaction.id, `interaction-${index + 1}`),
    name: stringValue(interaction.name, `Interaction ${index + 1}`),
    enabled: interaction.enabled !== false,
    trigger,
    startAnimation: stringValue(interaction.startAnimation),
    followAnimation: stringValue(interaction.followAnimation),
    endAnimation: stringValue(interaction.endAnimation),
    faceStartAnimation: stringValue(interaction.faceStartAnimation),
    faceFollowAnimation: stringValue(interaction.faceFollowAnimation),
    faceEndAnimation: stringValue(interaction.faceEndAnimation),
    followTargetBone: nullableString(interaction.followTargetBone),
    sensitivity: positiveNumber(interaction.sensitivity, 0.25),
    limitX: positiveNumber(interaction.limitX, 90),
    limitY: positiveNumber(interaction.limitY, 65),
    smoothing: positiveNumber(interaction.smoothing, 8),
    returnDuration: Math.max(0.05, Math.min(2, positiveNumber(interaction.returnDuration ?? DEFAULT_INTERACTION_RETURN_DURATION, DEFAULT_INTERACTION_RETURN_DURATION))),
    returnEasing: interaction.returnEasing === "linear" || interaction.returnEasing === "ease-in-out"
      ? interaction.returnEasing
      : DEFAULT_INTERACTION_RETURN_EASING,
    startMixDuration: normalizeAnimationMixDuration(interaction.startMixDuration),
    followMixDuration: normalizeAnimationMixDuration(interaction.followMixDuration),
    releaseMixDuration: normalizeAnimationMixDuration(interaction.releaseMixDuration),
    regions: (Array.isArray(interaction.regions) ? interaction.regions : [])
      .map((region, regionIndex) => normalizeInteractionRegion(region, regionIndex))
      .filter((region): region is SpineInteractionRegion => region !== null),
  };
  if (typeof interaction.color === "string") normalized.color = interaction.color;
  if (typeof interaction.allowX === "boolean") normalized.allowX = interaction.allowX;
  if (typeof interaction.allowY === "boolean") normalized.allowY = interaction.allowY;
  if (typeof interaction.rotationEnabled === "boolean") normalized.rotationEnabled = interaction.rotationEnabled;
  if (interaction.rotationAxis === "x" || interaction.rotationAxis === "y") normalized.rotationAxis = interaction.rotationAxis;
  if (typeof interaction.rotationMin === "number" && Number.isFinite(interaction.rotationMin)) normalized.rotationMin = interaction.rotationMin;
  if (typeof interaction.rotationMax === "number" && Number.isFinite(interaction.rotationMax)) normalized.rotationMax = interaction.rotationMax;
  return normalized;
}

/** Normalize either a published interaction project or a private editor project for playback. */
export function normalizeSpineInteractionProject(value: unknown, directory?: string): SpineInteractionProject | null {
  if (!value || typeof value !== "object") return null;
  const project = value as Partial<SpineInteractionProject>;
  const assetDirectory = directory ?? stringValue(project.assetDirectory);
  if (!assetDirectory || !Array.isArray(project.interactions)) return null;
  const timeline = "timeline" in project ? normalizeSpineTimeline(project.timeline) : null;
  const sequences = project.sequences && typeof project.sequences === "object"
    ? Object.fromEntries(Object.entries(project.sequences)
      .map(([id, value]) => [id, normalizeSpineTimeline(value)] as const)
      .filter((entry): entry is [string, SpineTimeline] => entry[1] !== null))
    : {};
  return {
    schemaVersion: Math.max(1, Math.trunc(finiteNumber(project.schemaVersion, 1))),
    ...(typeof project.name === "string" ? { name: project.name } : {}),
    assetDirectory,
    ...(project.entrySequence === null || typeof project.entrySequence === "string" ? { entrySequence: project.entrySequence } : {}),
    talkMixDuration: normalizeAnimationMixDuration(project.talkMixDuration, DEFAULT_TALK_MIX_DURATION),
    effectsStrength: Math.max(0, Math.min(1, finiteNumber(project.effectsStrength, DEFAULT_EFFECTS_STRENGTH))),
    interactions: project.interactions
      .map((interaction, index) => normalizeAuthoredInteraction(interaction, index))
      .filter((interaction): interaction is SpineAuthoredInteraction => interaction !== null),
    ...(timeline ? { timeline } : {}),
    ...(Object.keys(sequences).length > 0 ? { sequences } : {}),
  };
}

export interface SpineAuthoredRegion extends SpineInteractionRegion {
  kind: SpineInteractionKind;
  interactionId: string;
}

export interface SpineInteractionProfile {
  pat: SpineInteractionAction | null;
  pinch: SpineInteractionAction | null;
  touch: SpineInteractionAction | null;
  look: {
    start: SpineAnimationPair;
    end: SpineAnimationPair | null;
  } | null;
  talks: SpineAnimationPair[];
}

/** Short crossfades keep authored start/follow/release phases from hard-cutting. */
export const DEFAULT_INTERACTION_PHASE_MIX = 0.14;
/** Backward-compatible alias retained for existing imports. */
export const INTERACTION_PHASE_MIX = DEFAULT_INTERACTION_PHASE_MIX;
export const DEFAULT_TALK_MIX_DURATION = 0.14;
export const MAX_ANIMATION_MIX_DURATION = 2;

export function normalizeAnimationMixDuration(value: unknown, fallback = DEFAULT_INTERACTION_PHASE_MIX): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_ANIMATION_MIX_DURATION, value));
}

export function setInteractionTrack(state: AnimationState, track: number, name: string, loop: boolean, mixDuration = DEFAULT_INTERACTION_PHASE_MIX): TrackEntry | null {
  if (!name) return null;
  const mix = normalizeAnimationMixDuration(mixDuration);
  // Seed an empty overlay so the first authored phase can blend up from the
  // underlying idle pose, not just mix when a previous overlay exists.
  if (mix > 0 && !state.getCurrent(track)) {
    const empty = state.setEmptyAnimation(track, mix);
    // This empty animation has no timelines. Mark its no-op sample as applied
    // so Spine will mix from it without applying the whole state and replaying
    // events on unrelated tracks.
    empty.trackLast = empty.trackTime;
    empty.nextTrackLast = empty.trackTime;
  }
  const entry = state.setAnimation(track, name, loop);
  entry.mixDuration = mix;
  return entry;
}

export function clearInteractionTrack(state: AnimationState, track: number, smooth = true, mixDuration = DEFAULT_INTERACTION_PHASE_MIX): void {
  if (smooth && state.getCurrent(track)) state.setEmptyAnimation(track, normalizeAnimationMixDuration(mixDuration));
  else state.clearTrack(track);
}

export function queueInteractionFadeOut(state: AnimationState, track: number, mixDuration = DEFAULT_INTERACTION_PHASE_MIX): void {
  state.addEmptyAnimation(track, normalizeAnimationMixDuration(mixDuration), 0);
}

function exactAnimation(animations: string[], wanted: string): string | null {
  const lower = wanted.toLocaleLowerCase();
  return animations.find((name) => name.toLocaleLowerCase() === lower) ?? null;
}

function animationBase(name: string): string {
  return name.split("/").pop() ?? name;
}

function faceVariant(animations: string[], main: string): string | null {
  const candidates = [
    main.replace(/_m(?=_|$)/i, "_A"),
    `${main}_A`,
  ].filter((candidate) => candidate.toLocaleLowerCase() !== main.toLocaleLowerCase());
  return candidates.map((candidate) => exactAnimation(animations, candidate)).find(Boolean) ?? null;
}

function pair(animations: string[], main: string | null): SpineAnimationPair | null {
  return main ? { main, face: faceVariant(animations, main) } : null;
}

function numberIn(name: string): number {
  const match = animationBase(name).match(/(?:pat|talk|look|touch|pinch)(?:2)?[_ -]?(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function preferRoot(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const aRoot = Number(!a.includes("/") && !/^dev[ _/]/i.test(a));
    const bRoot = Number(!b.includes("/") && !/^dev[ _/]/i.test(b));
    return bRoot - aRoot || numberIn(a) - numberIn(b) || a.localeCompare(b, undefined, { sensitivity: "base" });
  });
}

function mainAnimations(animations: string[], kind: "pat" | "look" | "talk" | "touch" | "pinch"): string[] {
  const pattern = kind === "pat"
    ? /(?:^|\/)(?:s_)?pat(?:2)?[_ -]?\d+_m(?:_|$)/i
    : kind === "touch"
      ? /(?:^|\/)touch[_ -]?\d+_m(?:_|$)/i
      : kind === "pinch"
        ? /(?:^|\/)(?:s_)?pinch[_ -]?\d+(?:_m)?(?:_|$)/i
      : kind === "look"
        ? /(?:^|\/)(?:s_)?look[_ -]?\d+_m(?:_|$)/i
        : /(?:^|\/)talk[_ -]?\d+_m(?:_|$)/i;
  return preferRoot(animations.filter((name) => pattern.test(name) && !/^dev[ _/]/i.test(name)));
}

function endCandidates(main: string, kind: "pat" | "look" | "touch" | "pinch"): string[] {
  const base = animationBase(main);
  const variants: string[] = [];
  if (kind === "look") {
    variants.push(base.replace(/^look/i, "LookEnd"));
  } else if (kind === "touch") {
    variants.push(base.replace(/^touch/i, "TouchEnd"), base.replace(/^touch/i, "Touch_End"));
  } else if (kind === "pinch") {
    const end = base.replace(/^pinch/i, "PinchEnd");
    variants.push(end, `${end}_M`, `${end}_A`, base.replace(/^pinch/i, "Pinch_End"));
  } else if (/^pat2/i.test(base)) {
    variants.push(base.replace(/^pat2/i, "Pat2End"), base.replace(/^pat2/i, "PatEnd2"));
  } else {
    variants.push(base.replace(/^pat/i, "PatEnd"));
  }
  return variants;
}

function findEnd(animations: string[], main: string, kind: "pat" | "look" | "touch" | "pinch"): SpineAnimationPair | null {
  for (const candidate of endCandidates(main, kind)) {
    const found = exactAnimation(animations, candidate);
    if (found) return pair(animations, found);
  }
  return null;
}

function findPreferred(animations: string[], names: string[]): string | null {
  for (const wanted of names) {
    const found = exactAnimation(animations, wanted);
    if (found) return found;
  }
  return null;
}

function followCandidates(main: string): string[] {
  const slash = main.lastIndexOf("/");
  const directory = slash >= 0 ? main.slice(0, slash + 1) : "";
  const base = animationBase(main);
  const match = base.match(/^(.*?)(\d+)(?=_[A-Za-z]+$|$)/);
  if (!match) return [];
  const digits = match[2]!;
  const nextNumber = String(Number(digits) + 1).padStart(digits.length, "0");
  const next = `${match[1]}${nextNumber}${base.slice(match[0].length)}`;
  const candidates = [`${directory}${next}`];
  if (/_M$/i.test(next)) candidates.push(`${directory}${next.replace(/_M$/i, "")}`);
  else candidates.push(`${directory}${next}_M`);
  return candidates;
}

function followPair(animations: string[], start: string): SpineAnimationPair {
  const follow = followCandidates(start)
    .map((candidate) => exactAnimation(animations, candidate))
    .find(Boolean) ?? start;
  return pair(animations, follow)!;
}

function findPat(animations: string[]): SpineInteractionProfile["pat"] {
  const mains = mainAnimations(animations, "pat");
  const main = findPreferred(animations, ["Pat_01_M", "Pat_01_M_all"]) ?? mains[0] ?? null;
  if (!main) return null;
  return { start: pair(animations, main)!, follow: followPair(animations, main), release: findEnd(animations, main, "pat") };
}

function findAction(animations: string[], kind: "touch" | "pinch", preferred: string[]): SpineInteractionAction | null {
  const main = findPreferred(animations, preferred) ?? mainAnimations(animations, kind)[0] ?? null;
  if (!main) return null;
  return { start: pair(animations, main)!, follow: followPair(animations, main), release: findEnd(animations, main, kind) };
}

function findPinch(animations: string[]): SpineInteractionProfile["pinch"] {
  return findAction(animations, "pinch", ["Pinch_01_M", "Pinch_01"]);
}

function findTouch(animations: string[]): SpineInteractionProfile["touch"] {
  return findAction(animations, "touch", ["Touch_01_M"]);
}

function findLook(animations: string[]): SpineInteractionProfile["look"] {
  const main = findPreferred(animations, ["Look_01_M", "Look_01_M_all"])
    ?? mainAnimations(animations, "look")[0]
    ?? null;
  if (!main) return null;
  return { start: pair(animations, main)!, end: findEnd(animations, main, "look") };
}

function findTalks(animations: string[]): SpineAnimationPair[] {
  const seen = new Set<string>();
  const talks: SpineAnimationPair[] = [];
  for (const main of preferRoot(mainAnimations(animations, "talk"))) {
    const key = animationBase(main).toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    talks.push(pair(animations, main)!);
  }
  return talks.sort((a, b) => numberIn(a.main) - numberIn(b.main) || a.main.localeCompare(b.main, undefined, { sensitivity: "base" }));
}

/**
 * Lobby exports use the same interaction naming convention as the game:
 * M carries the main pose and A carries the face/attachment pose. Keep the
 * name matching tolerant because older exports use Pat2/Touch and a few
 * variants put the animation in a subfolder.
 */
export function findInteractionProfile(animations: string[]): SpineInteractionProfile {
  return {
    pat: findPat(animations),
    pinch: findPinch(animations),
    touch: findTouch(animations),
    look: findLook(animations),
    talks: findTalks(animations),
  };
}

export function interactionKind(interaction: Pick<SpineAuthoredInteraction, "name" | "startAnimation">): SpineInteractionKind | null {
  const value = `${interaction.name} ${interaction.startAnimation}`;
  if (/pinch/i.test(value)) return "pinch";
  if (/pat/i.test(value)) return "pat";
  if (/touch/i.test(value)) return "touch";
  return null;
}

export function authoredInteraction(project: SpineInteractionProject | null | undefined, kind: SpineInteractionKind): SpineAuthoredInteraction | null {
  return project?.interactions.find((interaction) => interaction.enabled && interactionKind(interaction) === kind) ?? null;
}

function authoredPair(animations: string[], mainName: string, faceName: string): SpineAnimationPair | null {
  const main = exactAnimation(animations, mainName);
  if (!main) return null;
  return { main, face: faceName ? exactAnimation(animations, faceName) : null };
}

function authoredAction(animations: string[], interaction: SpineAuthoredInteraction): SpineInteractionAction | null {
  const start = authoredPair(animations, interaction.startAnimation, interaction.faceStartAnimation);
  const follow = authoredPair(animations, interaction.followAnimation, interaction.faceFollowAnimation);
  if (!start || !follow) return null;
  return {
    start,
    follow,
    release: interaction.endAnimation
      ? authoredPair(animations, interaction.endAnimation, interaction.faceEndAnimation)
      : null,
  };
}

/** Resolve the saved phases for one interaction, falling back to detected tracks when incomplete. */
export function authoredInteractionAction(animations: string[], interaction: SpineAuthoredInteraction): SpineInteractionAction | null {
  if (!interaction.enabled) return null;
  const kind = interactionKind(interaction);
  if (!kind) return null;
  return authoredAction(animations, interaction) ?? findInteractionProfile(animations)[kind];
}

/** Apply saved editor phases without losing automatic look/talk detection. */
export function profileFromProject(animations: string[], project?: SpineInteractionProject | null): SpineInteractionProfile {
  const detected = findInteractionProfile(animations);
  if (!project) return detected;
  const overrides = new Map<SpineInteractionKind, SpineInteractionAction | null>();
  for (const kind of ["pat", "pinch", "touch"] as const) {
    const candidates = project.interactions.filter((item) => interactionKind(item) === kind);
    if (candidates.length === 0) continue;
    const enabled = candidates.filter((item) => item.enabled);
    if (enabled.length === 0) {
      overrides.set(kind, null);
      continue;
    }
    const authored = enabled
      .map((item) => authoredAction(animations, item))
      .find((action): action is SpineInteractionAction => action !== null);
    overrides.set(kind, authored ?? detected[kind]);
  }
  return {
    ...detected,
    pat: overrides.has("pat") ? overrides.get("pat")! : detected.pat,
    pinch: overrides.has("pinch") ? overrides.get("pinch")! : detected.pinch,
    touch: overrides.has("touch") ? overrides.get("touch")! : detected.touch,
  };
}

export function authoredRegions(project?: SpineInteractionProject | null): SpineAuthoredRegion[] {
  if (!project) return [];
  return project.interactions.flatMap((interaction) => {
    const kind = interactionKind(interaction);
    return kind && interaction.enabled
      ? interaction.regions.filter((region) => region.enabled).map((region) => ({ ...region, kind, interactionId: interaction.id }))
      : [];
  });
}
import type { AnimationState, TrackEntry } from "@esotericsoftware/spine-core";
