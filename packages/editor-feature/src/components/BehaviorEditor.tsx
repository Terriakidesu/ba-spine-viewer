import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS } from "@ba-spine/spine-runtime/spine/spineInteraction";
import { migrateLegacyInteractionsToBehaviors, normalizeSpineBehaviorMachine, normalizeSpineBehaviorMachines, type SpineBehaviorAction, type SpineBehaviorCondition, type SpineBehaviorEvent, type SpineBehaviorMachine, type SpineBehaviorState, type SpineBehaviorTransition } from "@ba-spine/spine-runtime/spine/spineBehavior";
import type { SpineBehaviorDebugMachine } from "@ba-spine/spine-runtime/spine/spineBehaviorRuntime";

const events: SpineBehaviorEvent[] = ["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"];
const actions = ["play-animation", "pointer-follow", "drag-bone", "rotate-bone", "play-audio", "show-subtitle", "set-variable", "wait", "restore-resource"] as const;

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function blankState(index: number): SpineBehaviorState {
  return { id: makeId("state"), name: `State ${index + 1}`, actions: [], exitActions: [], cancelActions: [], resourceClaims: [] };
}

function blankMachine(name = "New behavior"): SpineBehaviorMachine {
  const idle = { ...blankState(0), id: "idle", name: "Idle" };
  return {
    id: makeId("behavior"),
    name,
    enabled: true,
    priority: 0,
    exclusiveGroup: null,
    resourceClaims: [],
    activation: { kind: "pointer-region", trigger: "press", regions: [], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
    initialStateId: idle.id,
    cancelPolicy: "run-exit",
    states: [idle],
    transitions: [],
    sourceLegacyInteractionId: null,
  };
}

function presetMachine(preset: "head" | "look"): SpineBehaviorMachine {
  if (preset === "look") {
    const machine = migrateLegacyInteractionsToBehaviors([], DEFAULT_SPINE_LOOK_FOLLOW_SETTINGS).find((item) => item.name === "Look-follow")!;
    return { ...machine, id: makeId("behavior"), sourceLegacyInteractionId: null };
  }
  const idle = { ...blankState(0), id: "idle", name: "Idle" };
  const start = { ...blankState(1), id: "starting", name: "Starting", actions: [{ type: "play-animation", mainAnimation: null, faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop: false, mixDuration: 0.14 } satisfies SpineBehaviorAction] };
  const active = { ...blankState(2), id: "active", name: "Active", actions: [{ type: "play-animation", mainAnimation: null, faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop: true, mixDuration: 0.14 } satisfies SpineBehaviorAction] };
  const release = { ...blankState(3), id: "releasing", name: "Releasing", actions: [] };
  const region = { id: makeId("region"), name: "Head region", enabled: true, shape: "ellipse" as const, anchorBone: null, offsetX: 0, offsetY: 0, radiusX: 120, radiusY: 90, rotation: 0 };
  return normalizeSpineBehaviorMachine({
    ...blankMachine("Head interaction"),
    exclusiveGroup: "character-input",
    activation: { kind: "pointer-region", trigger: "hold", regions: [region], holdDelay: 0, dragThreshold: 4, timerSeconds: 0, event: "pointer-press" },
    states: [idle, start, active, release],
    transitions: [
      { id: makeId("transition"), fromStateId: "idle", toStateId: "starting", event: "pointer-press", conditions: [{ type: "region-hit", regionIds: [region.id] }], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "deny" },
      { id: makeId("transition"), fromStateId: "starting", toStateId: "active", event: "animation-complete", conditions: [{ type: "pointer-held", value: true }], afterSeconds: 0, priority: 1, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: makeId("transition"), fromStateId: "starting", toStateId: "releasing", event: "animation-complete", conditions: [{ type: "pointer-held", value: false }], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: makeId("transition"), fromStateId: "active", toStateId: "releasing", event: "pointer-release", conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" },
      { id: makeId("transition"), fromStateId: "releasing", toStateId: "idle", event: "animation-complete", conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" },
    ],
    sourceLegacyInteractionId: null,
  })!;
}

function initialAction(type: typeof actions[number]): SpineBehaviorAction {
  switch (type) {
    case "play-animation": return { type, mainAnimation: null, faceAnimation: null, bodyTrack: 3, faceTrack: 4, loop: false, mixDuration: 0.14 };
    case "pointer-follow": return { type, targetBonePath: null, allowX: true, allowY: true, rangeX: null, rangeY: null, smoothing: 14 };
    case "drag-bone": return { type, targetBonePath: null, sensitivity: 0.25, limitX: 90, limitY: 65, allowX: true, allowY: true, smoothing: 8, returnDuration: 0.35 };
    case "rotate-bone": return { type, targetBonePath: null, axis: "x", minimum: -20, maximum: 20, returnDuration: 0.35 };
    case "play-audio": return { type, audioId: "", volume: 1, loop: false };
    case "show-subtitle": return { type, cueId: "" };
    case "set-variable": return { type, name: "value", value: true };
    case "wait": return { type, seconds: 0.5 };
    case "restore-resource": return { type, resource: "" };
  }
}

function scalarFromInput(value: string): string | number | boolean | null {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function blankCondition(type: SpineBehaviorCondition["type"]): SpineBehaviorCondition {
  switch (type) {
    case "pointer-held": return { type, value: true };
    case "region-hit": return { type, regionIds: [] };
    case "held-for": return { type, seconds: 0.25 };
    case "drag-distance": return { type, minimum: 12 };
    case "variable": return { type, name: "value", operator: "equals", value: true };
    case "machine-state": return { type, machineId: "", stateId: "" };
  }
}

export interface BehaviorEditorProps {
  machines: readonly SpineBehaviorMachine[];
  animations: string[];
  debug: readonly SpineBehaviorDebugMachine[];
  testFeedback?: readonly string[];
  onChange: (machines: SpineBehaviorMachine[]) => void;
  onTestEvent: (machineId: string, event: SpineBehaviorEvent, regionId: string | null) => void;
  onCancelTest: () => void;
}

/** Compact graph-and-inspector authoring surface for declarative state machines. */
export function BehaviorEditor({ machines, animations, debug, testFeedback = [], onChange, onTestEvent, onCancelTest }: BehaviorEditorProps) {
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [selection, setSelection] = useState<{ kind: "state" | "transition"; id: string } | null>(null);
  const [debugEvent, setDebugEvent] = useState<SpineBehaviorEvent>("pointer-press");
  const machine = machines.find((item) => item.id === machineId) ?? machines[0] ?? null;
  const selectedState = selection?.kind === "state" ? machine?.states.find((item) => item.id === selection.id) ?? null : null;
  const selectedTransition = selection?.kind === "transition" ? machine?.transitions.find((item) => item.id === selection.id) ?? null : null;
  const debugByMachine = useMemo(() => new Map(debug.map((item) => [item.machineId, item])), [debug]);
  const activeDebug = machine ? debugByMachine.get(machine.id) : undefined;

  useEffect(() => {
    if (machine) setMachineId(machine.id);
    else setMachineId("");
  }, [machine?.id]);

  function commit(next: SpineBehaviorMachine) {
    const normalized = normalizeSpineBehaviorMachine({ ...next, sourceLegacyInteractionId: null });
    if (!normalized) return;
    onChange(normalizeSpineBehaviorMachines(machines.map((item) => item.id === next.id ? normalized : item)));
  }

  function addMachine(preset: "blank" | "head" | "look") {
    const next = preset === "blank" ? blankMachine() : presetMachine(preset);
    const all = normalizeSpineBehaviorMachines([...machines, next]);
    onChange(all);
    const created = all.find((item) => item.id === next.id) ?? all.at(-1);
    setMachineId(created?.id ?? all.at(-1)?.id ?? "");
    setSelection(created?.states[0] ? { kind: "state", id: created.states[0].id } : null);
  }

  function updateState(stateId: string, update: (state: SpineBehaviorState) => SpineBehaviorState) {
    if (!machine) return;
    commit({ ...machine, states: machine.states.map((state) => state.id === stateId ? update(state) : state) });
  }

  function addState() {
    if (!machine) return;
    const state = blankState(machine.states.length);
    commit({ ...machine, states: [...machine.states, state] });
    setSelection({ kind: "state", id: state.id });
  }

  function deleteState(stateId: string) {
    if (!machine || machine.states.length <= 1) return;
    const states = machine.states.filter((state) => state.id !== stateId);
    const initialStateId = machine.initialStateId === stateId ? states[0]!.id : machine.initialStateId;
    commit({
      ...machine,
      initialStateId,
      states,
      transitions: machine.transitions.filter((transition) => transition.fromStateId !== stateId && transition.toStateId !== stateId),
    });
    setSelection(null);
  }

  function addTransition() {
    if (!machine || machine.states.length < 2) return;
    const fromStateId = selectedState?.id ?? machine.initialStateId;
    const toStateId = machine.states.find((state) => state.id !== fromStateId)?.id ?? machine.states[0]!.id;
    const transition = { id: makeId("transition"), fromStateId, toStateId, event: "pointer-release" as const, conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" as const };
    commit({ ...machine, transitions: [...machine.transitions, transition] });
    setSelection({ kind: "transition", id: transition.id });
  }

  function updateTransition(transitionId: string, patch: Partial<SpineBehaviorTransition>) {
    if (!machine) return;
    commit({ ...machine, transitions: machine.transitions.map((item) => item.id === transitionId ? { ...item, ...patch } : item) });
  }

  function updateCondition(index: number, patch: Record<string, unknown>) {
    if (!selectedTransition) return;
    const conditions = selectedTransition.conditions.map((condition, conditionIndex) => conditionIndex === index
      ? { ...condition, ...patch } as SpineBehaviorCondition
      : condition);
    updateTransition(selectedTransition.id, { conditions });
  }

  if (!machine) return <section className="behavior-editor-empty"><strong>No behavior machines</strong><span>Start with a blank machine or use a behavior preset.</span><div><button onClick={() => addMachine("blank")}>Blank</button><button onClick={() => addMachine("head")}>Head interaction</button><button onClick={() => addMachine("look")}>Look-follow</button></div></section>;

  const statePositions = new Map(machine.states.map((state, index) => [state.id, { x: 36 + (index % 3) * 225, y: 38 + Math.floor(index / 3) * 138 }]));
  const debugState = activeDebug?.stateId;

  return <section className="behavior-editor" aria-label="Behavior state machine editor">
    <aside className="behavior-nav">
      <div className="behavior-nav-heading"><strong>Machines</strong><span>{machines.length}</span></div>
      <div className="behavior-machine-list">{machines.map((item) => <button key={item.id} className={item.id === machine.id ? "is-selected" : ""} onClick={() => { setMachineId(item.id); setSelection(null); }}><span className={`behavior-state-dot${debugByMachine.get(item.id)?.active ? " is-active" : ""}`} />{item.name}<small>{item.states.length} states</small></button>)}</div>
      <div className="behavior-add-menu"><label>Add preset<select aria-label="Add behavior preset" value="" onChange={(event) => { if (event.target.value) addMachine(event.target.value as "blank" | "head" | "look"); }}><option value="">Choose…</option><option value="blank">Blank machine</option><option value="head">Head interaction</option><option value="look">Look-follow</option></select></label></div>
    </aside>

    <main className="behavior-graph-panel">
      <div className="behavior-graph-toolbar"><div><strong>{machine.name}</strong><small>{machine.enabled ? "Enabled" : "Disabled"} · Priority {machine.priority}</small></div><div><button onClick={addState}>Add state</button><button onClick={addTransition} disabled={machine.states.length < 2}>Add transition</button><button className="danger" onClick={() => { const next = machines.filter((item) => item.id !== machine.id); onChange([...next]); setMachineId(next[0]?.id ?? ""); setSelection(null); }}>Delete machine</button></div></div>
      <svg className="behavior-graph" viewBox={`0 0 ${Math.max(720, 90 + Math.min(3, machine.states.length) * 225)} ${Math.max(360, 80 + Math.ceil(machine.states.length / 3) * 138)}`} role="img" aria-label={`${machine.name} state graph`}>
        <defs><marker id="behavior-arrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L0,8 L9,4 z" /></marker></defs>
        {machine.transitions.map((transition) => {
          const from = statePositions.get(transition.fromStateId), to = statePositions.get(transition.toStateId);
          if (!from || !to) return null;
          const selected = selection?.kind === "transition" && selection.id === transition.id;
          const startX = from.x + 174, startY = from.y + 48;
          const endX = to.x, endY = to.y + 48;
          const control = Math.max(40, Math.abs(endX - startX) / 2);
          const middleX = (startX + endX) / 2;
          const middleY = (startY + endY) / 2 - 12;
          return <g key={transition.id} className={`behavior-edge${selected ? " is-selected" : ""}`} onClick={() => setSelection({ kind: "transition", id: transition.id })} role="button" tabIndex={0} aria-label={`${from ? machine.states.find((state) => state.id === transition.fromStateId)?.name : "State"} to ${machine.states.find((state) => state.id === transition.toStateId)?.name} on ${transition.event}`}><path d={`M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}`} markerEnd="url(#behavior-arrow)" /><text x={middleX} y={middleY}>{transition.event.replaceAll("-", " ")}</text></g>;
        })}
        {machine.states.map((state) => {
          const position = statePositions.get(state.id)!;
          const selected = selection?.kind === "state" && selection.id === state.id;
          return <g key={state.id} className={`behavior-node${selected ? " is-selected" : ""}${debugState === state.id && activeDebug?.active ? " is-running" : ""}`} transform={`translate(${position.x} ${position.y})`} onClick={() => setSelection({ kind: "state", id: state.id })} role="button" tabIndex={0} aria-label={`Select ${state.name} state`}>
            <rect width="174" height="96" rx="12" />
            <text className="behavior-node-kind" x="14" y="23">{state.id === machine.initialStateId ? "INITIAL STATE" : "STATE"}</text>
            <text className="behavior-node-name" x="14" y="51">{state.name}</text>
            <text className="behavior-node-actions" x="14" y="75">{state.actions.length} action{state.actions.length === 1 ? "" : "s"}</text>
          </g>;
        })}
      </svg>
      <div className="behavior-debug" aria-live="polite">
        <div><b>Live debugger</b><span className={activeDebug?.active ? "is-active" : ""}>{activeDebug?.stateName ?? machine.states.find((state) => state.id === machine.initialStateId)?.name ?? "Idle"}</span></div>
        <div><small>Last transition</small><strong>{activeDebug?.lastTransitionId ?? "—"}</strong></div>
        <div><small>Event</small><strong>{activeDebug?.lastEvent?.replaceAll("-", " ") ?? "-"}</strong></div>
        <div><small>Ownership</small><strong>{activeDebug?.blockedBy ? `Blocked by ${activeDebug.blockedBy.machineId} · ${activeDebug.blockedBy.resource}` : activeDebug?.active ? "Resources acquired" : activeDebug?.lastReason ?? "Waiting"}</strong></div>
        <div className="behavior-debug-feedback"><small>Action feedback</small><strong>{testFeedback.length ? testFeedback.join(" · ") : "No active audio or subtitle"}</strong></div>
        <div className="behavior-debug-actions"><small>Test event</small><div><select aria-label="Behavior test event" value={debugEvent} onChange={(event) => setDebugEvent(event.target.value as SpineBehaviorEvent)}>{events.map((item) => <option key={item} value={item}>{item.replaceAll("-", " ")}</option>)}</select><button onClick={() => onTestEvent(machine.id, debugEvent, machine.activation.regions[0]?.id ?? null)}>Send</button><button onClick={onCancelTest}>Reset</button></div></div>
      </div>
    </main>

    <aside className="behavior-inspector">
      {selection?.kind === "state" && selectedState ? <>
        <div className="behavior-inspector-heading"><strong>State</strong><div><small>{selectedState.id}</small><button className="danger" disabled={machine.states.length <= 1} onClick={() => deleteState(selectedState.id)}>Delete</button></div></div>
        <label>Name<input value={selectedState.name} onChange={(event) => updateState(selectedState.id, (state) => ({ ...state, name: event.target.value }))} /></label>
        <label>Initial state<select value={machine.initialStateId} onChange={(event) => commit({ ...machine, initialStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>Resource claims<input aria-label="State resource claims" value={selectedState.resourceClaims.join(", ")} placeholder="track:3, bone:root/Head" onChange={(event) => updateState(selectedState.id, (state) => ({ ...state, resourceClaims: [...new Set(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))] }))} /></label>
        <div className="behavior-action-heading"><strong>Actions on enter</strong><label>Add<select value="" aria-label="Add state action" onChange={(event) => { if (!event.target.value) return; const action = initialAction(event.target.value as typeof actions[number]); updateState(selectedState.id, (state) => ({ ...state, actions: [...state.actions, action] })); }}><option value="">Action…</option>{actions.map((action) => <option key={action} value={action}>{action.replaceAll("-", " ")}</option>)}</select></label></div>
        {selectedState.actions.map((action, index) => <ActionCard key={`${selectedState.id}-${index}`} action={action} index={index} animations={animations} onChange={(patch) => updateState(selectedState.id, (state) => ({ ...state, actions: state.actions.map((item, actionIndex) => actionIndex === index ? { ...item, ...patch } as SpineBehaviorAction : item) }))} onDelete={() => updateState(selectedState.id, (state) => ({ ...state, actions: state.actions.filter((_, actionIndex) => actionIndex !== index) }))} />)}
        <details className="behavior-cleanup"><summary>Exit and cancel cleanup</summary>
          <label>Exit resource<select value="" aria-label="Add exit cleanup" onChange={(event) => { if (!event.target.value) return; const action = { type: "restore-resource", resource: event.target.value } as const; updateState(selectedState.id, (state) => ({ ...state, exitActions: [...state.exitActions, action] })); }}><option value="">Restore on exit…</option><option value="all">All owned resources</option><option value="animation-tracks">Animation tracks</option><option value="controlled-bones">Controlled bones</option><option value="audio">Audio</option><option value="subtitle">Subtitle</option></select></label>
          <div>{selectedState.exitActions.map((action, index) => <span key={index}>{action.type === "restore-resource" ? action.resource : action.type}<button onClick={() => updateState(selectedState.id, (state) => ({ ...state, exitActions: state.exitActions.filter((_, actionIndex) => actionIndex !== index) }))}>×</button></span>)}</div>
          <label>Cancel behavior<select value={machine.cancelPolicy} onChange={(event) => commit({ ...machine, cancelPolicy: event.target.value as SpineBehaviorMachine["cancelPolicy"] })}><option value="run-exit">Run cleanup, then reset</option><option value="reset">Reset and release ownership</option></select></label>
          <label>Cancel cleanup<select value="" aria-label="Add cancel cleanup" onChange={(event) => { if (!event.target.value) return; const action = { type: "restore-resource", resource: event.target.value } as const; updateState(selectedState.id, (state) => ({ ...state, cancelActions: [...state.cancelActions, action] })); event.target.value = ""; }}><option value="">Restore on cancel…</option><option value="all">All owned resources</option><option value="animation-tracks">Animation tracks</option><option value="controlled-bones">Controlled bones</option><option value="audio">Audio</option><option value="subtitle">Subtitle</option></select></label>
          {selectedState.cancelActions.map((action, index) => <span key={index} className="behavior-cleanup-row">{action.type === "restore-resource" ? action.resource : action.type}<button onClick={() => updateState(selectedState.id, (state) => ({ ...state, cancelActions: state.cancelActions.filter((_, actionIndex) => actionIndex !== index) }))}>Remove</button></span>)}
        </details>
      </> : selectedTransition ? <>
        <div className="behavior-inspector-heading"><strong>Transition</strong><button className="danger" onClick={() => { commit({ ...machine, transitions: machine.transitions.filter((item) => item.id !== selectedTransition.id) }); setSelection(null); }}>Delete</button></div>
        <label>From<select value={selectedTransition.fromStateId} onChange={(event) => updateTransition(selectedTransition.id, { fromStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>To<select value={selectedTransition.toStateId} onChange={(event) => updateTransition(selectedTransition.id, { toStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>Event<select value={selectedTransition.event} onChange={(event) => updateTransition(selectedTransition.id, { event: event.target.value as SpineBehaviorEvent })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label>
        <div className="behavior-two-fields"><label>Priority<input type="number" value={selectedTransition.priority} onChange={(event) => updateTransition(selectedTransition.id, { priority: Number(event.target.value) })} /></label><label>Delay<input type="number" min="0" step="0.05" value={selectedTransition.afterSeconds} onChange={(event) => updateTransition(selectedTransition.id, { afterSeconds: Number(event.target.value) })} /></label></div>
        <label>Blend duration<input type="number" min="0" max="2" step="0.05" value={selectedTransition.blendDuration} onChange={(event) => updateTransition(selectedTransition.id, { blendDuration: Number(event.target.value) })} /></label>
        <label>Interrupt policy<select value={selectedTransition.interruptPolicy} onChange={(event) => updateTransition(selectedTransition.id, { interruptPolicy: event.target.value as typeof selectedTransition.interruptPolicy })}><option value="allow">Allow</option><option value="deny">Deny</option><option value="queue">Queue</option></select></label>
        <div className="behavior-condition-heading"><strong>Conditions · AND</strong><label>Add<select aria-label="Add transition condition" value="" onChange={(event) => { const value = event.target.value as SpineBehaviorCondition["type"] | ""; if (!value) return; updateTransition(selectedTransition.id, { conditions: [...selectedTransition.conditions, blankCondition(value)] }); event.target.value = ""; }}><option value="">Condition…</option><option value="pointer-held">Pointer held</option><option value="region-hit">Region hit</option><option value="held-for">Held for</option><option value="drag-distance">Drag distance</option><option value="variable">Variable</option><option value="machine-state">Machine state</option></select></label></div>
        {selectedTransition.conditions.map((condition, index) => <article className="behavior-condition-card" key={`${selectedTransition.id}-condition-${index}`}>
          <header><strong>{condition.type.replaceAll("-", " ")}</strong><button aria-label={`Remove ${condition.type} condition`} onClick={() => updateTransition(selectedTransition.id, { conditions: selectedTransition.conditions.filter((_, conditionIndex) => conditionIndex !== index) })}>×</button></header>
          {condition.type === "pointer-held" ? <label>Pointer state<select value={String(condition.value)} onChange={(event) => updateCondition(index, { value: event.target.value === "true" })}><option value="true">Held</option><option value="false">Released</option></select></label>
            : condition.type === "region-hit" ? <label>Matching region IDs<input value={condition.regionIds.join(", ")} placeholder="region-a, region-b" onChange={(event) => updateCondition(index, { regionIds: event.target.value.split(",").map((id) => id.trim()).filter(Boolean) })} /></label>
              : condition.type === "held-for" ? <label>Seconds<input type="number" min="0" step="0.05" value={condition.seconds} onChange={(event) => updateCondition(index, { seconds: Number(event.target.value) })} /></label>
                : condition.type === "drag-distance" ? <label>Minimum distance<input type="number" min="0" step="1" value={condition.minimum} onChange={(event) => updateCondition(index, { minimum: Number(event.target.value) })} /></label>
                  : condition.type === "variable" ? <><label>Variable name<input value={condition.name} onChange={(event) => updateCondition(index, { name: event.target.value })} /></label><div className="behavior-two-fields"><label>Comparison<select value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value })}><option value="equals">Equals</option><option value="not-equals">Does not equal</option><option value="greater-than">Greater than</option><option value="less-than">Less than</option></select></label><label>Value<input value={String(condition.value)} onChange={(event) => updateCondition(index, { value: scalarFromInput(event.target.value) })} /></label></div></>
                    : <><label>Machine ID<input value={condition.machineId} onChange={(event) => updateCondition(index, { machineId: event.target.value })} /></label><label>State ID<input value={condition.stateId} onChange={(event) => updateCondition(index, { stateId: event.target.value })} /></label></>}
        </article>)}
      </> : <>
        <div className="behavior-inspector-heading"><strong>Machine</strong><small>Coordination and activation</small></div>
        <label>Name<input value={machine.name} onChange={(event) => commit({ ...machine, name: event.target.value })} /></label>
        <label><span className="behavior-check"><input type="checkbox" checked={machine.enabled} onChange={(event) => commit({ ...machine, enabled: event.target.checked })} /> Enabled</span></label>
        <div className="behavior-two-fields"><label>Priority<input type="number" value={machine.priority} onChange={(event) => commit({ ...machine, priority: Number(event.target.value) })} /></label><label>Exclusive group<input value={machine.exclusiveGroup ?? ""} placeholder="None" onChange={(event) => commit({ ...machine, exclusiveGroup: event.target.value || null })} /></label></div>
        <label>Machine resource claims<input value={machine.resourceClaims.join(", ")} placeholder="track:3, audio:voice" onChange={(event) => commit({ ...machine, resourceClaims: [...new Set(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))] })} /></label>
        <div className="behavior-inspector-heading"><strong>Activation</strong><small>When the machine can start</small></div>
        <label>Input scope<select value={machine.activation.kind} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, kind: event.target.value as typeof machine.activation.kind } })}><option value="pointer-region">Pointer · selected region</option><option value="pointer-canvas">Pointer · anywhere</option><option value="timer">Timer</option><option value="event">Event</option></select></label>
        {machine.activation.kind === "timer" ? <><label>Timer delay<input type="number" min="0" step="0.05" value={machine.activation.timerSeconds} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, timerSeconds: Number(event.target.value) } })} /></label><label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label></>
          : machine.activation.kind === "event" ? <label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label>
            : <><div className="behavior-two-fields"><label>Gesture<select value={machine.activation.trigger} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, trigger: event.target.value as typeof machine.activation.trigger } })}><option value="press">Press</option><option value="hold">Hold</option><option value="drag">Drag</option></select></label><label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label></div>
              <div className="behavior-two-fields"><label>Hold delay<input type="number" min="0" step="0.05" value={machine.activation.holdDelay} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, holdDelay: Number(event.target.value) } })} /></label><label>Drag threshold<input type="number" min="0" step="1" value={machine.activation.dragThreshold} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, dragThreshold: Number(event.target.value) } })} /></label></div></>}
        {machine.activation.kind === "pointer-region" && <><div className="behavior-region-heading"><strong>Regions</strong><button onClick={() => commit({ ...machine, activation: { ...machine.activation, regions: [...machine.activation.regions, { id: makeId("region"), name: `Region ${machine.activation.regions.length + 1}`, enabled: true, shape: "ellipse", anchorBone: null, offsetX: 0, offsetY: 0, radiusX: 100, radiusY: 75, rotation: 0 }] } })}>Add</button></div>
          {machine.activation.regions.map((region, index) => <details className="behavior-region-card behavior-region-details" key={region.id}><summary>{region.name || `Region ${index + 1}`}</summary><label>Name<input value={region.name} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, name: event.target.value } : item) } })} /></label><label><span className="behavior-check"><input type="checkbox" checked={region.enabled} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, enabled: event.target.checked } : item) } })} /> Enabled</span></label><label>Anchor bone path<input value={region.anchorBone ?? ""} placeholder="root/Head" onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, anchorBone: event.target.value || null } : item) } })} /></label><label>Shape<select value={region.shape} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, shape: event.target.value as typeof region.shape } : item) } })}><option value="ellipse">Ellipse</option><option value="rectangle">Rectangle</option></select></label><div className="behavior-two-fields">{(["offsetX", "offsetY", "radiusX", "radiusY", "rotation"] as const).slice(0, 4).map((field) => <label key={field}>{field}<input type="number" value={region[field]} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, [field]: Number(event.target.value) } : item) } })} /></label>)}</div><label>Rotation °<input type="number" value={region.rotation} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.map((item) => item.id === region.id ? { ...item, rotation: Number(event.target.value) } : item) } })} /></label><button className="danger" onClick={() => commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.filter((item) => item.id !== region.id) } })}>Remove region</button></details>)}</>}
      </>}
    </aside>
  </section>;
}

function ActionCard({ action, index, animations, onChange, onDelete }: { action: SpineBehaviorAction; index: number; animations: string[]; onChange: (patch: Record<string, unknown>) => void; onDelete: () => void }) {
  const actionLabel = action.type.replaceAll("-", " ");
  const textField = (label: string, key: string, value: string | null) => <label>{label}<input value={value ?? ""} onChange={(event) => onChange({ [key]: event.target.value || null })} /></label>;
  const numberField = (label: string, key: string, value: number, min = 0, max?: number) => <label>{label}<input type="number" min={min} max={max} value={value} onChange={(event) => onChange({ [key]: Number(event.target.value) })} /></label>;
  return <article className="behavior-action-card"><header><strong>{index + 1}. {actionLabel}</strong><button aria-label={`Remove ${actionLabel} action`} onClick={onDelete}>×</button></header>
    {action.type === "play-animation" ? <><label>Body animation<select value={action.mainAnimation ?? ""} onChange={(event) => onChange({ mainAnimation: event.target.value || null })}><option value="">None</option>{animations.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label>Face animation<select value={action.faceAnimation ?? ""} onChange={(event) => onChange({ faceAnimation: event.target.value || null })}><option value="">None</option>{animations.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><div className="behavior-two-fields">{numberField("Body track", "bodyTrack", action.bodyTrack, 1, 32)}{numberField("Face track", "faceTrack", action.faceTrack, 1, 32)}</div><div className="behavior-two-fields">{numberField("Blend", "mixDuration", action.mixDuration, 0, 2)}<label><span className="behavior-check"><input type="checkbox" checked={action.loop} onChange={(event) => onChange({ loop: event.target.checked })} /> Loop</span></label></div><label>Animation fallback<select value={action.fallbackProfile ?? ""} onChange={(event) => onChange({ fallbackProfile: event.target.value || undefined })}><option value="">None</option><option value="look-start">Detected look start</option><option value="look-end">Detected look release</option></select></label></>
      : action.type === "pointer-follow" ? <>{textField("Target bone path", "targetBonePath", action.targetBonePath)}<div className="behavior-two-fields"><label>Range X <small>(blank = auto)</small><input type="number" min="0" max="512" value={action.rangeX ?? ""} onChange={(event) => onChange({ rangeX: event.target.value === "" ? null : Number(event.target.value) })} /></label><label>Range Y <small>(blank = auto)</small><input type="number" min="0" max="512" value={action.rangeY ?? ""} onChange={(event) => onChange({ rangeY: event.target.value === "" ? null : Number(event.target.value) })} /></label></div><div className="behavior-two-fields">{numberField("Smoothing", "smoothing", action.smoothing, 0.1)}<span className="behavior-check"><label><input type="checkbox" checked={action.allowX} onChange={(event) => onChange({ allowX: event.target.checked })} /> X</label><label><input type="checkbox" checked={action.allowY} onChange={(event) => onChange({ allowY: event.target.checked })} /> Y</label></span></div></>
      : action.type === "drag-bone" ? <>{textField("Target bone path", "targetBonePath", action.targetBonePath)}<div className="behavior-two-fields">{numberField("Sensitivity", "sensitivity", action.sensitivity)}{numberField("Smoothing", "smoothing", action.smoothing, 0.1)}</div><div className="behavior-two-fields">{numberField("Return seconds", "returnDuration", action.returnDuration, 0.05)}{numberField("Limit X", "limitX", action.limitX)}</div><div className="behavior-two-fields">{numberField("Limit Y", "limitY", action.limitY)}<label>Axes<span className="behavior-check"><label><input type="checkbox" checked={action.allowX} onChange={(event) => onChange({ allowX: event.target.checked })} /> X</label><label><input type="checkbox" checked={action.allowY} onChange={(event) => onChange({ allowY: event.target.checked })} /> Y</label></span></label></div></>
      : action.type === "rotate-bone" ? <>{textField("Target bone path", "targetBonePath", action.targetBonePath)}<label>Axis<select value={action.axis} onChange={(event) => onChange({ axis: event.target.value })}><option value="x">X</option><option value="y">Y</option></select></label><div className="behavior-two-fields">{numberField("Minimum °", "minimum", action.minimum, -360)}{numberField("Maximum °", "maximum", action.maximum, 0, 360)}</div>{numberField("Return seconds", "returnDuration", action.returnDuration, 0.05)}</>
      : action.type === "play-audio" ? <>{textField("Audio ID", "audioId", action.audioId)}<div className="behavior-two-fields">{numberField("Volume", "volume", action.volume, 0, 1)}<label><span className="behavior-check"><input type="checkbox" checked={action.loop} onChange={(event) => onChange({ loop: event.target.checked })} /> Loop</span></label></div></>
      : action.type === "show-subtitle" ? textField("Subtitle cue ID", "cueId", action.cueId)
      : action.type === "set-variable" ? <div className="behavior-two-fields">{textField("Variable", "name", action.name)}<label>Value<input value={String(action.value)} onChange={(event) => onChange({ value: scalarFromInput(event.target.value) })} /></label></div>
      : action.type === "wait" ? numberField("Seconds", "seconds", action.seconds)
      : textField("Resource name", "resource", action.resource)}
  </article>;
}
