import {
  arbitrateSpineBehaviors,
  evaluateSpineBehaviorTransition,
  normalizeSpineBehaviorMachines,
  type SpineActiveBehavior,
  type SpineBehaviorAction,
  type SpineBehaviorEvent,
  type SpineBehaviorMachine,
  type SpineBehaviorScalar,
  type SpineBehaviorState,
  type SpineBehaviorTransition,
  type SpineBehaviorTransitionContext,
} from "./spineBehavior";

export type SpineBehaviorActionPhase = "enter" | "update" | "exit" | "cancel";

export interface SpineBehaviorRuntimeContext extends Omit<SpineBehaviorTransitionContext, "elapsedSeconds" | "machineStates"> {
  elapsedSeconds?: number;
  machineStates?: Readonly<Record<string, string>>;
}

export interface SpineBehaviorDebugMachine {
  machineId: string;
  machineName: string;
  stateId: string;
  stateName: string;
  priority: number;
  active: boolean;
  blockedBy: { machineId: string; resource: string } | null;
  lastEvent: SpineBehaviorEvent | null;
  lastTransitionId: string | null;
  lastReason: "ready" | "disabled" | "waiting" | "condition-failed" | "resource-conflict";
  stateElapsed: number;
}

export interface SpineBehaviorRuntimeHandlers {
  onActions?: (machine: SpineBehaviorMachine, state: SpineBehaviorState, actions: readonly SpineBehaviorAction[], phase: SpineBehaviorActionPhase) => void;
  onTransition?: (machine: SpineBehaviorMachine, transition: SpineBehaviorTransition, from: SpineBehaviorState, to: SpineBehaviorState) => void;
  onOwnershipChange?: (machine: SpineBehaviorMachine, state: SpineBehaviorState, owned: boolean, ownerMachineId: string | null) => void;
}

interface PendingEvent {
  event: SpineBehaviorEvent;
  elapsed: number;
  context: SpineBehaviorTransitionContext;
}

interface MachineInstance {
  machine: SpineBehaviorMachine;
  stateId: string;
  stateElapsed: number;
  pending: PendingEvent | null;
  activationPending: { event: SpineBehaviorEvent; context: SpineBehaviorTransitionContext } | null;
  queuedEvents: PendingEvent[];
  lastEvent: SpineBehaviorEvent | null;
  lastTransitionId: string | null;
  lastReason: SpineBehaviorDebugMachine["lastReason"];
  accepted: boolean;
  ownsResources: boolean;
  blockedBy: { machineId: string; resource: string } | null;
  animationCompleteSent: boolean;
  animationBusy: boolean;
}

interface AnimationCompletionTrack {
  track: number;
  channel: "body" | "face";
  animation: string | null;
  fallbackProfile?: "look-start" | "look-end";
}

function hasNonLoopAnimation(state: SpineBehaviorState): boolean {
  return state.actions.some((action) => action.type === "play-animation" && !action.loop
    && Boolean(action.mainAnimation || action.faceAnimation || action.fallbackProfile));
}

function withTransitionBlend(actions: readonly SpineBehaviorAction[], blendDuration: number): SpineBehaviorAction[] {
  return actions.map((action) => action.type === "play-animation" ? { ...action, mixDuration: blendDuration } : action);
}

const EMPTY_CONTEXT: SpineBehaviorRuntimeContext = {
  pointerHeld: false,
  regionId: null,
  heldSeconds: 0,
  dragDistance: 0,
  variables: {},
};

function currentState(instance: MachineInstance): SpineBehaviorState {
  return instance.machine.states.find((state) => state.id === instance.stateId)
    ?? instance.machine.states[0]!;
}

/**
 * Data-only state-machine scheduler shared by Viewer and Editor preview.
 * Hosts perform typed actions and own the concrete Spine/audio/subtitle resources.
 */
export class SpineBehaviorRuntime {
  private readonly instances = new Map<string, MachineInstance>();
  private variables: Record<string, SpineBehaviorScalar> = {};
  private lastContext: SpineBehaviorRuntimeContext = EMPTY_CONTEXT;
  private disposed = false;
  private started = false;
  private stateEnteredPending = false;
  private processingStateEntered = false;

  constructor(machines: readonly SpineBehaviorMachine[], private readonly handlers: SpineBehaviorRuntimeHandlers = {}) {
    for (const machine of normalizeSpineBehaviorMachines(machines)) {
      const instance: MachineInstance = {
        machine,
        stateId: machine.initialStateId,
        stateElapsed: 0,
        pending: null,
        activationPending: null,
        queuedEvents: [],
        lastEvent: null,
        lastTransitionId: null,
        lastReason: machine.enabled ? "ready" : "disabled",
        accepted: true,
        ownsResources: false,
        blockedBy: null,
        animationCompleteSent: false,
        animationBusy: hasNonLoopAnimation(machine.states.find((state) => state.id === machine.initialStateId)!),
      };
      this.instances.set(machine.id, instance);
    }
    this.resolveOwnership();
  }

  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    for (const instance of this.instances.values()) {
      const state = currentState(instance);
      if (instance.machine.enabled && instance.ownsResources && state.actions.length) this.handlers.onActions?.(instance.machine, state, state.actions, "enter");
    }
  }

  get machineIds(): string[] {
    return [...this.instances.keys()];
  }

  getActivation(machineId: string): SpineBehaviorMachine["activation"] | null {
    return this.instances.get(machineId)?.machine.activation ?? null;
  }

  getActivationMachineIds(trigger: "press" | "hold" | "drag", regionId: string | null, dragDistance = 0): string[] {
    return [...this.instances.values()]
      .filter(({ machine }) => machine.enabled && machine.activation.trigger === trigger
        && (trigger !== "drag" || dragDistance >= machine.activation.dragThreshold)
        && (machine.activation.kind === "pointer-canvas"
          || machine.activation.kind === "pointer-region" && regionId !== null
            && machine.activation.regions.some((region) => region.enabled && region.id === regionId)))
      .sort((left, right) => right.machine.priority - left.machine.priority || left.machine.id.localeCompare(right.machine.id))
      .map(({ machine }) => machine.id);
  }

  getDebugSnapshot(): SpineBehaviorDebugMachine[] {
    return [...this.instances.values()]
      .sort((left, right) => right.machine.priority - left.machine.priority || left.machine.id.localeCompare(right.machine.id))
      .map((instance) => {
        const state = currentState(instance);
        return {
          machineId: instance.machine.id,
          machineName: instance.machine.name,
          stateId: state.id,
          stateName: state.name,
          priority: instance.machine.priority,
          active: instance.machine.enabled && this.isEngaged(instance) && instance.accepted && !(instance.pending && instance.lastReason === "resource-conflict"),
          blockedBy: instance.blockedBy ? { ...instance.blockedBy } : null,
          lastEvent: instance.lastEvent,
          lastTransitionId: instance.lastTransitionId,
          lastReason: instance.lastReason,
          stateElapsed: Math.round(instance.stateElapsed * 10) / 10,
        };
      });
  }

  getActiveStates(): Array<{ machine: SpineBehaviorMachine; state: SpineBehaviorState; active: boolean }> {
    return [...this.instances.values()].map((instance) => ({
      machine: instance.machine,
      state: currentState(instance),
      active: instance.machine.enabled && this.isEngaged(instance) && instance.accepted,
    }));
  }

  /**
   * Check whether a compatibility executor may use the resources its mirrored
   * machine would claim on activation. This also handles delayed/drag triggers
   * whose mirror is still in its initial state when the legacy path is queried.
   */
  canExecuteMachine(machineId: string): boolean {
    const target = this.instances.get(machineId);
    if (!target) return true;
    if (!target.machine.enabled) return false;

    const current = currentState(target);
    const activationState = this.isEngaged(target)
      ? current
      : target.machine.states.find((state) => state.id !== target.machine.initialStateId
        && (state.actions.length > 0 || state.resourceClaims.length > 0));
    if (!activationState) return true;

    const candidates: SpineActiveBehavior[] = [...this.instances.values()]
      .filter((instance) => instance !== target && this.isEngaged(instance))
      .map((instance) => ({ machine: instance.machine, stateId: instance.stateId }));
    candidates.push({ machine: target.machine, stateId: activationState.id });
    return arbitrateSpineBehaviors(candidates).accepted.some((candidate) => candidate.machine.id === machineId);
  }

  getAnimationCompletions(): Array<{ machineId: string; tracks: AnimationCompletionTrack[] }> {
    return [...this.instances.values()].flatMap((instance) => {
      if (!instance.machine.enabled || !instance.accepted || instance.animationCompleteSent) return [];
      const channels = new Map<number, AnimationCompletionTrack & { loop: boolean }>();
      let hasNonLoopAction = false;
      for (const action of currentState(instance).actions) {
        if (action.type !== "play-animation") continue;
        if (!action.loop) hasNonLoopAction = true;
        const fallback = action.fallbackProfile ? { fallbackProfile: action.fallbackProfile } : {};
        channels.set(action.bodyTrack, { track: action.bodyTrack, channel: "body", animation: action.mainAnimation, ...fallback, loop: action.loop });
        channels.set(action.faceTrack, { track: action.faceTrack, channel: "face", animation: action.faceAnimation, ...fallback, loop: action.loop });
      }
      if (!hasNonLoopAction) return [];
      const tracks = [...channels.values()].filter((item) => !item.loop).map(({ loop: _loop, ...track }) => track);
      return [{ machineId: instance.machine.id, tracks }];
    });
  }

  notifyAnimationComplete(machineId: string, context: SpineBehaviorRuntimeContext = this.lastContext): void {
    const instance = this.instances.get(machineId);
    if (!instance || instance.animationCompleteSent) return;
    const queued = instance.queuedEvents.shift() ?? null;
    instance.animationCompleteSent = true;
    instance.animationBusy = false;
    this.dispatch("animation-complete", context, [machineId]);
    if (queued && this.instances.has(machineId)) this.dispatch(queued.event, { ...context, regionId: queued.context.regionId }, [machineId]);
  }

  dispatch(event: SpineBehaviorEvent, context: SpineBehaviorRuntimeContext = EMPTY_CONTEXT, machineIds?: readonly string[], options: { bypassActivation?: boolean } = {}): void {
    if (this.disposed) return;
    this.start();
    this.lastContext = { ...context, variables: context.variables ?? this.variables };
    for (const instance of this.instances.values()) {
      if (machineIds && !machineIds.includes(instance.machine.id)) continue;
      if (!instance.machine.enabled) {
        instance.lastReason = "disabled";
        continue;
      }
      const state = currentState(instance);
      const atEntry = state.id === instance.machine.initialStateId;
      if (atEntry && !options.bypassActivation && !this.activationMatches(instance.machine, event, this.lastContext)) {
        if (event === "pointer-release" || event === "pointer-cancel" || event === "pointer-leave") {
          instance.pending = null;
          instance.activationPending = null;
          instance.blockedBy = null;
          instance.lastReason = "ready";
        }
        continue;
      }
      if (atEntry && !options.bypassActivation && instance.machine.activation.kind.startsWith("pointer-")
        && instance.machine.activation.trigger === "hold"
        && this.lastContext.heldSeconds < instance.machine.activation.holdDelay) {
        instance.activationPending = {
          event,
          context: this.transitionContext(this.lastContext, this.machineStateMap()),
        };
        instance.lastEvent = event;
        instance.lastReason = "waiting";
        continue;
      }
      if (atEntry && !options.bypassActivation && instance.machine.activation.kind.startsWith("pointer-")
        && instance.machine.activation.trigger === "drag"
        && this.lastContext.dragDistance < instance.machine.activation.dragThreshold) continue;
      if (!atEntry && instance.animationBusy && event !== "animation-complete") {
        const candidate = instance.machine.transitions
          .filter((transition) => transition.fromStateId === instance.stateId && transition.event === event)
          .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
        if (candidate?.interruptPolicy === "deny") {
          instance.lastEvent = event;
          instance.lastReason = "waiting";
          continue;
        }
        if (candidate?.interruptPolicy === "queue") {
          if (instance.queuedEvents.length === 0) {
            instance.queuedEvents.push({
              event,
              elapsed: 0,
              context: this.transitionContext(this.lastContext, this.machineStateMap()),
            });
          }
          instance.lastEvent = event;
          instance.lastReason = "waiting";
          continue;
        }
      }
      const machineStates = this.machineStateMap();
      const pendingContext = this.transitionContext(this.lastContext, machineStates);
      instance.lastEvent = event;
      instance.pending = { event, elapsed: 0, context: pendingContext };
      instance.lastReason = "waiting";
    }
    this.processPending();
  }

  update(deltaSeconds: number, context: SpineBehaviorRuntimeContext = this.lastContext): void {
    if (this.disposed) return;
    this.start();
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(1, deltaSeconds)) : 0;
    this.lastContext = { ...context, variables: context.variables ?? this.variables };
    for (const instance of this.instances.values()) {
      instance.stateElapsed += delta;
      let activationJustStarted = false;
      if (instance.activationPending) {
        if (!this.lastContext.pointerHeld) {
          instance.activationPending = null;
          instance.lastReason = "ready";
        } else if (this.lastContext.heldSeconds >= instance.machine.activation.holdDelay) {
          const activation = instance.activationPending;
          instance.activationPending = null;
          instance.pending = {
            event: activation.event,
            elapsed: 0,
            context: this.transitionContext({ ...this.lastContext, regionId: activation.context.regionId }, this.machineStateMap()),
          };
          activationJustStarted = true;
          instance.lastReason = "waiting";
        }
      }
      if (instance.pending) {
        if (!activationJustStarted) instance.pending.elapsed += delta;
        instance.pending.context = this.transitionContext({ ...this.lastContext, regionId: instance.pending.context.regionId }, this.machineStateMap());
      } else if (instance.machine.activation.kind === "timer" && instance.stateId === instance.machine.initialStateId
        && instance.stateElapsed >= instance.machine.activation.timerSeconds) {
        instance.lastEvent = instance.machine.activation.event;
        instance.pending = {
          event: instance.machine.activation.event,
          elapsed: instance.stateElapsed - instance.machine.activation.timerSeconds,
          context: this.transitionContext(this.lastContext, this.machineStateMap()),
        };
      }
    }
    this.processPending();
    this.processStateTimers();
    this.resolveOwnership();
    for (const instance of this.instances.values()) {
      if (!instance.machine.enabled || !instance.accepted) continue;
      const state = currentState(instance);
      if (state.actions.length) this.handlers.onActions?.(instance.machine, state, state.actions, "update");
    }
  }

  setVariable(name: string, value: SpineBehaviorScalar): void {
    if (!name) return;
    this.variables[name] = value;
    this.lastContext = { ...this.lastContext, variables: this.variables };
  }

  cancel(machineId: string, reason: "cancel" | "disable" | "reset" | "dispose" = "cancel"): void {
    const instance = this.instances.get(machineId);
    if (!instance) return;
    const oldState = currentState(instance);
    if (reason !== "reset" && reason !== "disable" && instance.machine.cancelPolicy === "run-exit") {
      if (oldState.actions.length) this.handlers.onActions?.(instance.machine, oldState, oldState.actions, "cancel");
      if (oldState.exitActions.length) this.handlers.onActions?.(instance.machine, oldState, oldState.exitActions, "exit");
      if (oldState.cancelActions.length) this.handlers.onActions?.(instance.machine, oldState, oldState.cancelActions, "cancel");
    }
    if (instance.ownsResources) this.handlers.onOwnershipChange?.(instance.machine, oldState, false, null);
    instance.ownsResources = false;
    instance.stateId = instance.machine.initialStateId;
    instance.stateElapsed = 0;
    instance.animationBusy = false;
    instance.animationCompleteSent = false;
    instance.pending = null;
    instance.activationPending = null;
    instance.queuedEvents = [];
    instance.lastReason = instance.machine.enabled ? "ready" : "disabled";
    instance.accepted = true;
    instance.blockedBy = null;
    this.resolveOwnership();
    if ((reason === "cancel" || reason === "reset") && instance.machine.enabled && instance.ownsResources) {
      const initial = currentState(instance);
      instance.animationBusy = hasNonLoopAnimation(initial);
      if (initial.actions.length) this.handlers.onActions?.(instance.machine, initial, initial.actions, "enter");
    }
  }

  cancelAll(reason: "cancel" | "disable" | "reset" | "dispose" = "cancel"): void {
    for (const machineId of this.instances.keys()) this.cancel(machineId, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAll("dispose");
    this.disposed = true;
    this.instances.clear();
  }

  private activationMatches(machine: SpineBehaviorMachine, event: SpineBehaviorEvent, context: SpineBehaviorRuntimeContext): boolean {
    const activation = machine.activation;
    if (activation.kind === "timer") return event === activation.event;
    if (activation.kind === "event") return event === activation.event;
    if (event !== activation.event) return false;
    if (activation.trigger === "drag" && context.dragDistance < activation.dragThreshold) return false;
    if (activation.trigger === "hold" && !context.pointerHeld) return false;
    if (activation.kind === "pointer-canvas") return true;
    if (!context.regionId) return false;
    return activation.regions.some((region) => region.enabled && region.id === context.regionId);
  }

  private transitionContext(context: SpineBehaviorRuntimeContext, machineStates: Readonly<Record<string, string>>, elapsedSeconds = 0): SpineBehaviorTransitionContext {
    return {
      pointerHeld: context.pointerHeld,
      regionId: context.regionId,
      heldSeconds: context.heldSeconds,
      dragDistance: context.dragDistance,
      elapsedSeconds,
      variables: context.variables ?? this.variables,
      machineStates,
    };
  }

  private machineStateMap(): Record<string, string> {
    return Object.fromEntries([...this.instances].map(([id, instance]) => [id, instance.stateId]));
  }

  private processPending(): void {
    const states = this.machineStateMap();
    const proposals = new Map<string, SpineBehaviorTransition>();
    for (const instance of this.instances.values()) {
      const pending = instance.pending;
      if (!pending || !instance.machine.enabled) continue;
      const context = this.transitionContext(pending.context, states, pending.elapsed);
      const transition = evaluateSpineBehaviorTransition(instance.machine, instance.stateId, pending.event, context);
      if (transition) proposals.set(instance.machine.id, transition);
      else {
        const candidates = instance.machine.transitions.filter((candidate) => candidate.fromStateId === instance.stateId && candidate.event === pending.event);
        const waitingForDelay = candidates.some((candidate) => candidate.afterSeconds > pending.elapsed);
        const waitingForCondition = candidates.some((candidate) => candidate.conditions.some((condition) =>
          condition.type === "pointer-held" || condition.type === "held-for" || condition.type === "drag-distance"
            || condition.type === "variable" || condition.type === "machine-state",
        ));
        instance.lastReason = waitingForDelay ? "waiting" : "condition-failed";
        if (!waitingForDelay && !waitingForCondition) instance.pending = null;
      }
    }
    if (!proposals.size) return;

    const projected = [...this.instances.values()]
      .map((instance): SpineActiveBehavior => ({
        machine: instance.machine,
        stateId: proposals.get(instance.machine.id)?.toStateId ?? instance.stateId,
      }))
      .filter((candidate) => this.isEngaged(this.instances.get(candidate.machine.id)!, candidate.stateId));
    const arbitration = arbitrateSpineBehaviors(projected);
    const accepted = new Set(arbitration.accepted.map((item) => item.machine.id));
    const committed: Array<{ instance: MachineInstance; transition: SpineBehaviorTransition; from: SpineBehaviorState; to: SpineBehaviorState }> = [];
    for (const [machineId, transition] of proposals) {
      const instance = this.instances.get(machineId)!;
      const willBeEngaged = this.isEngaged(instance, transition.toStateId);
      if (willBeEngaged && !accepted.has(machineId)) {
        const conflict = arbitration.blocked.find((item) => item.machineId === machineId);
        instance.lastReason = "resource-conflict";
        instance.blockedBy = conflict ? { machineId: conflict.ownerMachineId, resource: conflict.resource } : null;
        continue;
      }
      const from = currentState(instance);
      const to = instance.machine.states.find((state) => state.id === transition.toStateId);
      if (!to) continue;
      if (from.actions.length) this.handlers.onActions?.(instance.machine, from, withTransitionBlend(from.actions, transition.blendDuration), "exit");
      if (from.exitActions.length) this.handlers.onActions?.(instance.machine, from, from.exitActions, "exit");
      committed.push({ instance, transition, from, to });
    }
    if (!committed.length) {
      this.resolveOwnership();
      return;
    }
    for (const { instance, transition, to } of committed) {
      instance.stateId = to.id;
      instance.stateElapsed = 0;
      instance.animationBusy = hasNonLoopAnimation(to);
      instance.animationCompleteSent = false;
      instance.pending = null;
      instance.activationPending = null;
      instance.queuedEvents = [];
      instance.lastTransitionId = transition.id;
      instance.lastReason = "ready";
      instance.blockedBy = null;
    }
    // Release previous owners before entering the new state, so a preempted
    // machine cannot clear tracks after its replacement has acquired them.
    this.resolveOwnership();
    for (const { instance, transition, from, to } of committed) {
      this.handlers.onTransition?.(instance.machine, transition, from, to);
      if (to.actions.length) this.handlers.onActions?.(instance.machine, to, withTransitionBlend(to.actions, transition.blendDuration), "enter");
    }
    this.stateEnteredPending = true;
    this.flushStateEnteredEvents();
  }

  private flushStateEnteredEvents(): void {
    if (this.processingStateEntered || this.disposed) return;
    this.processingStateEntered = true;
    let dispatched = 0;
    while (this.stateEnteredPending && dispatched < 32) {
      this.stateEnteredPending = false;
      dispatched += 1;
      this.dispatch("state-entered", this.lastContext);
    }
    this.stateEnteredPending = false;
    this.processingStateEntered = false;
  }

  private processStateTimers(): void {
    const proposals = new Map<string, SpineBehaviorTransition>();
    const states = this.machineStateMap();
    for (const instance of this.instances.values()) {
      if (!instance.machine.enabled || instance.pending) continue;
      if (instance.stateId === instance.machine.initialStateId && instance.machine.activation.kind === "timer") continue;
      const state = currentState(instance);
      const waitThreshold = state.actions.filter((action) => action.type === "wait").reduce<number>(
        (maximum, action) => Math.max(maximum, action.seconds),
        0,
      );
      if (instance.stateElapsed < waitThreshold) continue;
      const hasDueTimer = instance.machine.transitions.some((transition) => transition.fromStateId === instance.stateId
        && transition.event === "timer-elapsed" && transition.afterSeconds <= instance.stateElapsed);
      if (!hasDueTimer) continue;
      const context = this.transitionContext(this.lastContext, states, instance.stateElapsed);
      const transition = evaluateSpineBehaviorTransition(instance.machine, instance.stateId, "timer-elapsed", context);
      if (transition) proposals.set(instance.machine.id, transition);
    }
    if (!proposals.size) return;
    for (const [machineId, transition] of proposals) {
      const instance = this.instances.get(machineId)!;
      instance.lastEvent = "timer-elapsed";
      instance.pending = { event: "timer-elapsed", elapsed: instance.stateElapsed, context: this.lastContext as SpineBehaviorTransitionContext };
    }
    this.processPending();
  }

  private resolveOwnership(): void {
    const candidates: SpineActiveBehavior[] = [...this.instances.values()]
      .filter((instance) => this.isEngaged(instance))
      .map((instance) => ({ machine: instance.machine, stateId: instance.stateId }));
    const resolution = arbitrateSpineBehaviors(candidates);
    const accepted = new Set(resolution.accepted.map((candidate) => candidate.machine.id));
    for (const instance of this.instances.values()) {
      const engaged = this.isEngaged(instance);
      const nextAccepted = !engaged || instance.machine.enabled && accepted.has(instance.machine.id);
      const conflict = resolution.blocked.find((item) => item.machineId === instance.machine.id);
      const proposalBlock = instance.pending && instance.lastReason === "resource-conflict" ? instance.blockedBy : null;
      const nextBlock = conflict ? { machineId: conflict.ownerMachineId, resource: conflict.resource } : proposalBlock;
      const nextOwnsResources = engaged && instance.machine.enabled && accepted.has(instance.machine.id);
      if (instance.ownsResources !== nextOwnsResources) {
        this.handlers.onOwnershipChange?.(instance.machine, currentState(instance), nextOwnsResources, nextBlock?.machineId ?? null);
      }
      instance.accepted = nextAccepted;
      instance.ownsResources = nextOwnsResources;
      instance.blockedBy = nextBlock;
      if (!instance.machine.enabled) instance.lastReason = "disabled";
      else if (!nextAccepted) instance.lastReason = "resource-conflict";
      else if (instance.lastReason === "resource-conflict" && !instance.blockedBy) instance.lastReason = instance.pending ? "waiting" : "ready";
    }
  }

  private isEngaged(instance: MachineInstance, stateId = instance.stateId): boolean {
    const state = instance.machine.states.find((item) => item.id === stateId);
    return Boolean(state && (stateId !== instance.machine.initialStateId || state.actions.length > 0 || state.resourceClaims.length > 0));
  }
}
