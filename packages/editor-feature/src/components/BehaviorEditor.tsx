import { useEffect, useMemo, useState } from "react";
import type { ContextMenuAction } from "@ba-spine/app-ui/ContextMenu";
import { normalizeSpineBehaviorMachine, normalizeSpineBehaviorMachines, type SpineBehaviorAction, type SpineBehaviorCondition, type SpineBehaviorEvent, type SpineBehaviorMachine, type SpineBehaviorState, type SpineBehaviorTransition } from "@ba-spine/spine-runtime/spine/spineBehavior";
import type { SpineInteractionRegion } from "@ba-spine/spine-runtime/spine/spineInteraction";
import type { SpineBehaviorDebugMachine } from "@ba-spine/spine-runtime/spine/spineBehaviorRuntime";
import { applySpineBehaviorPreset, SPINE_BEHAVIOR_PRESETS, type SpineBehaviorPresetId } from "../behaviorPresets";
import { normalizeBehaviorGraphLayouts, type BehaviorMachineGraphLayout, type BehaviorGraphLayouts } from "../behaviorGraph";
import { BehaviorGraph, type BehaviorGraphContextTarget } from "./BehaviorGraph";

const events: SpineBehaviorEvent[] = ["pointer-press", "pointer-release", "pointer-drag", "pointer-cancel", "pointer-leave", "timer-elapsed", "animation-complete", "state-entered", "manual"];
const actions = ["play-animation", "pointer-follow", "drag-bone", "rotate-bone", "play-audio", "show-subtitle", "set-variable", "wait", "restore-resource"] as const;

type BehaviorSelection =
  | { kind: "machine"; id: string }
  | { kind: "region"; id: string }
  | { kind: "state"; id: string }
  | { kind: "action"; stateId: string; phase: "enter" | "exit" | "cancel"; index: number }
  | { kind: "transition"; id: string };

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function blankState(index: number): SpineBehaviorState {
  return { id: makeId("state"), name: `State ${index + 1}`, actions: [], exitActions: [], cancelActions: [], resourceClaims: [] };
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
  graphLayouts?: BehaviorGraphLayouts;
  onChange: (machines: SpineBehaviorMachine[]) => void;
  onGraphLayoutChange: (machineId: string, layout: BehaviorMachineGraphLayout) => void;
  onShowCharacterPreview: () => void;
  onTestEvent: (machineId: string, event: SpineBehaviorEvent, regionId: string | null) => void;
  onCancelTest: () => void;
}

/** Compact graph-and-inspector authoring surface for declarative state machines. */
export function BehaviorEditor({ machines, animations, debug, testFeedback = [], graphLayouts = {}, onChange, onGraphLayoutChange, onShowCharacterPreview, onTestEvent, onCancelTest }: BehaviorEditorProps) {
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [selection, setSelection] = useState<BehaviorSelection | null>(null);
  const [debugEvent, setDebugEvent] = useState<SpineBehaviorEvent>("manual");
  const machine = machines.find((item) => item.id === machineId) ?? machines[0] ?? null;
  const selectedState = selection?.kind === "state" ? machine?.states.find((item) => item.id === selection.id) ?? null : null;
  const selectedTransition = selection?.kind === "transition" ? machine?.transitions.find((item) => item.id === selection.id) ?? null : null;
  const selectedRegion = selection?.kind === "region" && machine?.activation.kind === "pointer-region"
    ? machine.activation.regions.find((item) => item.id === selection.id) ?? null
    : null;
  const selectedActionState = selection?.kind === "action" ? machine?.states.find((item) => item.id === selection.stateId) ?? null : null;
  const selectedAction = selectedActionState && selection?.kind === "action"
    ? (selection.phase === "enter" ? selectedActionState.actions : selection.phase === "exit" ? selectedActionState.exitActions : selectedActionState.cancelActions)[selection.index] ?? null
    : null;
  const graphSelection = selection?.kind === "state" || selection?.kind === "transition" ? selection : null;
  const debugByMachine = useMemo(() => new Map(debug.map((item) => [item.machineId, item])), [debug]);
  const activeDebug = machine ? debugByMachine.get(machine.id) : undefined;
  const graphLayout = machine
    ? graphLayouts[machine.id] ?? normalizeBehaviorGraphLayouts({}, [machine])[machine.id]!
    : null;

  useEffect(() => {
    if (machine) setMachineId(machine.id);
    else setMachineId("");
  }, [machine?.id]);

  function commit(next: SpineBehaviorMachine) {
    const normalized = normalizeSpineBehaviorMachine({ ...next, sourceLegacyInteractionId: null });
    if (!normalized) return;
    onChange(normalizeSpineBehaviorMachines(machines.map((item) => item.id === next.id ? normalized : item)));
  }

  function addMachine(preset: SpineBehaviorPresetId) {
    const applied = applySpineBehaviorPreset(machines, preset);
    onChange(applied.machines);
    setMachineId(applied.machine.id);
    setSelection({ kind: "machine", id: applied.machine.id });
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

  function addTransition(fromStateIdOverride?: string) {
    if (!machine || machine.states.length < 2) return;
    const fromStateId = fromStateIdOverride ?? selectedState?.id ?? machine.initialStateId;
    const toStateId = machine.states.find((state) => state.id !== fromStateId)?.id ?? machine.states[0]!.id;
    const transition = { id: makeId("transition"), fromStateId, toStateId, event: "pointer-release" as const, conditions: [], afterSeconds: 0, priority: 0, blendDuration: 0.14, interruptPolicy: "allow" as const };
    commit({ ...machine, transitions: [...machine.transitions, transition] });
    setSelection({ kind: "transition", id: transition.id });
  }

  function behaviorGraphContextActions(target: BehaviorGraphContextTarget): readonly ContextMenuAction[] {
    if (target.kind === "background") return [
      { label: "Add state", run: addState },
      { label: "Add transition", disabled: machine.states.length < 2, reason: "Add at least two states first.", run: addTransition },
    ];
    if (target.kind === "state") {
      const state = machine.states.find((item) => item.id === target.id);
      if (!state) return [];
      return [
        { label: "Edit state properties", run: () => setSelection({ kind: "state", id: state.id }) },
        { label: "Add transition from state", disabled: machine.states.length < 2, reason: "Add another state first.", run: () => addTransition(state.id) },
        { label: "Set as initial state", disabled: machine.initialStateId === state.id, run: () => commit({ ...machine, initialStateId: state.id }) },
        { label: "Delete state", disabled: machine.states.length <= 1, reason: machine.states.length <= 1 ? "A machine must keep at least one state." : undefined, danger: true, run: () => deleteState(state.id), separatorBefore: true },
      ];
    }
    const transition = machine.transitions.find((item) => item.id === target.id);
    if (!transition) return [];
    return [
      { label: "Edit transition properties", run: () => setSelection({ kind: "transition", id: transition.id }) },
      { label: "Delete transition", danger: true, separatorBefore: true, run: () => { commit({ ...machine, transitions: machine.transitions.filter((item) => item.id !== transition.id) }); setSelection(null); } },
    ];
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

  function updateActivationRegion(regionId: string, patch: Partial<SpineInteractionRegion>) {
    if (!machine || machine.activation.kind !== "pointer-region") return;
    commit({
      ...machine,
      activation: {
        ...machine.activation,
        regions: machine.activation.regions.map((region) => region.id === regionId ? { ...region, ...patch } : region),
      },
    });
  }

  function updateSelectedAction(patch: Record<string, unknown>) {
    if (!selectedActionState || selection?.kind !== "action") return;
    const key = selection.phase === "enter" ? "actions" : selection.phase === "exit" ? "exitActions" : "cancelActions";
    updateState(selectedActionState.id, (state) => ({ ...state, [key]: state[key].map((action, index) => index === selection.index ? { ...action, ...patch } as SpineBehaviorAction : action) }));
  }

  if (!machine) return <section className="behavior-editor-empty"><strong>No behavior machines</strong><span>Start with a blank machine or choose a named behavior preset.</span><div>{SPINE_BEHAVIOR_PRESETS.map((preset) => <button key={preset.id} title={preset.description} onClick={() => addMachine(preset.id)}>{preset.name}</button>)}</div></section>;

  const debugState = activeDebug?.stateId;
  const statusState = activeDebug?.stateName ?? machine.states.find((state) => state.id === machine.initialStateId)?.name ?? "Idle";
  const ownershipStatus = activeDebug?.blockedBy
    ? `Blocked by ${activeDebug.blockedBy.machineId} · ${activeDebug.blockedBy.resource}`
    : activeDebug?.active ? "Resources acquired" : activeDebug?.lastReason ?? "Waiting";
  const activeRegionId = machine.activation.kind === "pointer-region" ? machine.activation.regions.find((region) => region.enabled)?.id ?? null : null;

  function deleteCurrentMachine() {
    const next = machines.filter((item) => item.id !== machine.id);
    onCancelTest();
    onChange(next);
    setMachineId(next[0]?.id ?? "");
    setSelection(null);
  }

  return <section className="behavior-editor" aria-label="Behavior state machine editor">
    <aside className="behavior-nav">
      <div className="behavior-add-menu"><label>New behavior<select aria-label="New behavior preset" value="" onChange={(event) => { if (event.target.value) addMachine(event.target.value as SpineBehaviorPresetId); }}><option value="">Choose a preset…</option>{SPINE_BEHAVIOR_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label></div>
      <div className="behavior-nav-heading"><strong>Machines</strong><span>{machines.length}</span></div>
      <div className="behavior-machine-list">{machines.map((item) => <button key={item.id} className={item.id === machine.id ? "is-selected" : ""} aria-pressed={item.id === machine.id} onClick={() => { setMachineId(item.id); setSelection({ kind: "machine", id: item.id }); }}><span className={`behavior-state-dot${debugByMachine.get(item.id)?.active ? " is-active" : ""}`} /><strong>{item.name}</strong><small>{item.states.length} states</small></button>)}</div>
    </aside>

    <main className="behavior-graph-panel">
      <div className="behavior-graph-toolbar"><div><strong>{machine.name}</strong><small>{machine.enabled ? "Enabled" : "Disabled"}</small></div><div><button onClick={addState}>Add state</button><button onClick={() => addTransition()} disabled={machine.states.length < 2}>Add transition</button><details className="behavior-context-menu"><summary aria-label="Machine actions" title="Machine actions">···</summary><div role="group" aria-label="Machine actions"><button className="danger" onClick={deleteCurrentMachine}>Delete machine</button></div></details></div></div>
      {graphLayout && <BehaviorGraph
        machine={machine}
        layout={graphLayout}
         selected={graphSelection}
        runningStateId={activeDebug?.active ? debugState : undefined}
        onLayoutChange={(layout) => onGraphLayoutChange(machine.id, layout)}
        onSelect={setSelection}
        getContextActions={behaviorGraphContextActions}
      />}
      <section className="behavior-testing" aria-label="Behavior testing">
        <div className="behavior-test-strip" aria-live="polite">
          <b>Test</b><strong className={activeDebug?.active ? "is-active" : ""}>{statusState}</strong>
          <span>{ownershipStatus}</span>
          <details className="behavior-test-details">
            <summary>Test behavior</summary>
            <div className="behavior-test-content">
              <div className="behavior-test-actions" aria-label="Behavior test controls">
                <button onClick={() => onTestEvent(machine.id, "pointer-press", activeRegionId)}>Press</button>
                <button onClick={() => onTestEvent(machine.id, "pointer-release", activeRegionId)}>Release</button>
                <button onClick={() => onTestEvent(machine.id, "pointer-cancel", activeRegionId)}>Cancel</button>
                <button className="danger" onClick={onCancelTest}>Stop test</button>
                <button title="Stop the test and open the character stage in Interactions" onClick={() => { onCancelTest(); onShowCharacterPreview(); }}>Open character preview</button>
              </div>
              <div className="behavior-test-details-grid">
                <span><small>Last transition</small><strong>{activeDebug?.lastTransitionId ?? "—"}</strong></span>
                <span><small>Last event</small><strong>{activeDebug?.lastEvent?.replaceAll("-", " ") ?? "—"}</strong></span>
                <span><small>Ownership</small><strong>{ownershipStatus}</strong></span>
                <span className="behavior-debug-feedback"><small>Action feedback</small><strong>{testFeedback.length ? testFeedback.join(" · ") : "No active audio or subtitle"}</strong></span>
              </div>
              <details className="behavior-debug-advanced">
                <summary>Advanced debugging · raw event injection</summary>
                <div><label>Event<select aria-label="Behavior test event" value={debugEvent} onChange={(event) => setDebugEvent(event.target.value as SpineBehaviorEvent)}>{events.map((item) => <option key={item} value={item}>{item.replaceAll("-", " ")}</option>)}</select></label><button onClick={() => onTestEvent(machine.id, debugEvent, activeRegionId)}>Send event</button></div>
              </details>
            </div>
          </details>
        </div>
      </section>
    </main>

    <aside className="behavior-inspector">
      {selection?.kind === "state" && selectedState ? <>
        <div className="behavior-inspector-heading"><strong>State</strong><div><small>{selectedState.id}</small><DestructiveMenu label="State actions" actionLabel="Delete state" disabled={machine.states.length <= 1} onDelete={() => deleteState(selectedState.id)} /></div></div>
        <label>Name<input value={selectedState.name} onChange={(event) => updateState(selectedState.id, (state) => ({ ...state, name: event.target.value }))} /></label>
        <label>Initial state<select value={machine.initialStateId} onChange={(event) => commit({ ...machine, initialStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <details className="behavior-advanced"><summary>Advanced coordination</summary><label>Resource claims<input aria-label="State resource claims" value={selectedState.resourceClaims.join(", ")} placeholder="track:3, bone:root/Head" onChange={(event) => updateState(selectedState.id, (state) => ({ ...state, resourceClaims: [...new Set(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))] }))} /></label></details>
        <div className="behavior-action-heading"><strong>Actions on enter</strong><label>Add<select value="" aria-label="Add state action" onChange={(event) => { if (!event.target.value) return; const action = initialAction(event.target.value as typeof actions[number]); const index = selectedState.actions.length; updateState(selectedState.id, (state) => ({ ...state, actions: [...state.actions, action] })); setSelection({ kind: "action", stateId: selectedState.id, phase: "enter", index }); event.target.value = ""; }}><option value="">Action…</option>{actions.map((action) => <option key={action} value={action}>{action.replaceAll("-", " ")}</option>)}</select></label></div>
        <div className="behavior-selection-list" aria-label="State actions">{selectedState.actions.map((action, index) => <button key={`${selectedState.id}-${index}`} onClick={() => setSelection({ kind: "action", stateId: selectedState.id, phase: "enter", index })}><strong>{index + 1}. {action.type.replaceAll("-", " ")}</strong><small>{action.type === "play-animation" ? action.mainAnimation || action.faceAnimation || "No animation selected" : action.type === "pointer-follow" || action.type === "drag-bone" || action.type === "rotate-bone" ? action.targetBonePath || "Automatic target" : "Configure action"}</small></button>)}</div>
        <details className="behavior-cleanup"><summary>Exit and cancel cleanup</summary>
          <label>Exit resource<select value="" aria-label="Add exit cleanup" onChange={(event) => { if (!event.target.value) return; const action = { type: "restore-resource", resource: event.target.value } as const; const index = selectedState.exitActions.length; updateState(selectedState.id, (state) => ({ ...state, exitActions: [...state.exitActions, action] })); setSelection({ kind: "action", stateId: selectedState.id, phase: "exit", index }); event.target.value = ""; }}><option value="">Restore on exit…</option><option value="all">All owned resources</option><option value="animation-tracks">Animation tracks</option><option value="controlled-bones">Controlled bones</option><option value="audio">Audio</option><option value="subtitle">Subtitle</option></select></label>
          <div className="behavior-selection-list" aria-label="Exit actions">{selectedState.exitActions.map((action, index) => <button key={index} onClick={() => setSelection({ kind: "action", stateId: selectedState.id, phase: "exit", index })}><strong>{action.type === "restore-resource" ? action.resource : action.type}</strong><small>On exit</small></button>)}</div>
          <label>Cancel behavior<select value={machine.cancelPolicy} onChange={(event) => commit({ ...machine, cancelPolicy: event.target.value as SpineBehaviorMachine["cancelPolicy"] })}><option value="run-exit">Run cleanup, then reset</option><option value="reset">Reset and release ownership</option></select></label>
          <label>Cancel cleanup<select value="" aria-label="Add cancel cleanup" onChange={(event) => { if (!event.target.value) return; const action = { type: "restore-resource", resource: event.target.value } as const; const index = selectedState.cancelActions.length; updateState(selectedState.id, (state) => ({ ...state, cancelActions: [...state.cancelActions, action] })); setSelection({ kind: "action", stateId: selectedState.id, phase: "cancel", index }); event.target.value = ""; }}><option value="">Restore on cancel…</option><option value="all">All owned resources</option><option value="animation-tracks">Animation tracks</option><option value="controlled-bones">Controlled bones</option><option value="audio">Audio</option><option value="subtitle">Subtitle</option></select></label>
          <div className="behavior-selection-list" aria-label="Cancel actions">{selectedState.cancelActions.map((action, index) => <button key={index} onClick={() => setSelection({ kind: "action", stateId: selectedState.id, phase: "cancel", index })}><strong>{action.type === "restore-resource" ? action.resource : action.type}</strong><small>On cancel</small></button>)}</div>
        </details>
      </> : selectedActionState && selectedAction ? <>
        <div className="behavior-inspector-heading"><strong>Action · {selection?.kind === "action" ? selection.phase : "enter"}</strong><small>{selectedAction.type.replaceAll("-", " ")}</small></div>
        <ActionCard
          action={selectedAction}
          index={selection?.kind === "action" ? selection.index : 0}
          animations={animations}
          onChange={updateSelectedAction}
          onDelete={() => {
            if (selection?.kind !== "action") return;
            const key = selection.phase === "enter" ? "actions" : selection.phase === "exit" ? "exitActions" : "cancelActions";
            updateState(selectedActionState.id, (state) => ({ ...state, [key]: state[key].filter((_, index) => index !== selection.index) }));
            setSelection({ kind: "state", id: selectedActionState.id });
          }}
        />
        <button onClick={() => setSelection({ kind: "state", id: selectedActionState.id })}>Back to {selectedActionState.name}</button>
      </> : selectedRegion ? <>
        <div className="behavior-inspector-heading"><strong>Activation region</strong><small>{selectedRegion.id}</small></div>
        <label>Name<input value={selectedRegion.name} onChange={(event) => updateActivationRegion(selectedRegion.id, { name: event.target.value })} /></label>
        <label><span className="behavior-check"><input type="checkbox" checked={selectedRegion.enabled} onChange={(event) => updateActivationRegion(selectedRegion.id, { enabled: event.target.checked })} /> Enabled</span></label>
        <label>Anchor bone path<input value={selectedRegion.anchorBone ?? ""} placeholder="root/Head" onChange={(event) => updateActivationRegion(selectedRegion.id, { anchorBone: event.target.value || null })} /></label>
        <label>Shape<select value={selectedRegion.shape} onChange={(event) => updateActivationRegion(selectedRegion.id, { shape: event.target.value as SpineInteractionRegion["shape"] })}><option value="ellipse">Ellipse</option><option value="rectangle">Rectangle</option></select></label>
        <div className="behavior-two-fields">
          {(["offsetX", "offsetY", "radiusX", "radiusY"] as const).map((field) => <label key={field}>{field}<input type="number" min={field.startsWith("radius") ? 1 : undefined} value={selectedRegion[field]} onChange={(event) => updateActivationRegion(selectedRegion.id, { [field]: Number(event.target.value) })} /></label>)}
        </div>
        <label>Rotation °<input type="number" value={selectedRegion.rotation} onChange={(event) => updateActivationRegion(selectedRegion.id, { rotation: Number(event.target.value) })} /></label>
        <button className="danger" onClick={() => {
          if (machine.activation.kind !== "pointer-region") return;
          commit({ ...machine, activation: { ...machine.activation, regions: machine.activation.regions.filter((region) => region.id !== selectedRegion.id) } });
          setSelection({ kind: "machine", id: machine.id });
        }}>Delete region</button>
        <button onClick={() => setSelection({ kind: "machine", id: machine.id })}>Back to machine</button>
      </> : selectedTransition ? <>
        <div className="behavior-inspector-heading"><strong>Transition</strong><DestructiveMenu label="Transition actions" actionLabel="Delete transition" onDelete={() => { commit({ ...machine, transitions: machine.transitions.filter((item) => item.id !== selectedTransition.id) }); setSelection(null); }} /></div>
        <label>From<select value={selectedTransition.fromStateId} onChange={(event) => updateTransition(selectedTransition.id, { fromStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>To<select value={selectedTransition.toStateId} onChange={(event) => updateTransition(selectedTransition.id, { toStateId: event.target.value })}>{machine.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>Event<select value={selectedTransition.event} onChange={(event) => updateTransition(selectedTransition.id, { event: event.target.value as SpineBehaviorEvent })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label>
        <label>Delay<input type="number" min="0" step="0.05" value={selectedTransition.afterSeconds} onChange={(event) => updateTransition(selectedTransition.id, { afterSeconds: Number(event.target.value) })} /></label>
        <details className="behavior-advanced"><summary>Advanced coordination</summary><label>Priority<input type="number" value={selectedTransition.priority} onChange={(event) => updateTransition(selectedTransition.id, { priority: Number(event.target.value) })} /></label></details>
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
        <div className="behavior-inspector-heading"><strong>Machine</strong><small>Settings</small></div>
        <label>Name<input value={machine.name} onChange={(event) => commit({ ...machine, name: event.target.value })} /></label>
        <label><span className="behavior-check"><input type="checkbox" checked={machine.enabled} onChange={(event) => commit({ ...machine, enabled: event.target.checked })} /> Enabled</span></label>
        <details className="behavior-advanced"><summary>Advanced coordination</summary><label>Priority<input type="number" value={machine.priority} onChange={(event) => commit({ ...machine, priority: Number(event.target.value) })} /></label><label>Exclusive group<input value={machine.exclusiveGroup ?? ""} placeholder="None" onChange={(event) => commit({ ...machine, exclusiveGroup: event.target.value || null })} /></label><label>Machine resource claims<input value={machine.resourceClaims.join(", ")} placeholder="track:3, audio:voice" onChange={(event) => commit({ ...machine, resourceClaims: [...new Set(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))] })} /></label></details>
        <div className="behavior-inspector-heading"><strong>Activation</strong><small>When the machine can start</small></div>
        <label>Input scope<select value={machine.activation.kind} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, kind: event.target.value as typeof machine.activation.kind } })}><option value="pointer-region">Pointer · selected region</option><option value="pointer-canvas">Pointer · anywhere</option><option value="timer">Timer</option><option value="event">Event</option></select></label>
        {machine.activation.kind === "timer" ? <><label>Timer delay<input type="number" min="0" step="0.05" value={machine.activation.timerSeconds} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, timerSeconds: Number(event.target.value) } })} /></label><label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label></>
          : machine.activation.kind === "event" ? <label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label>
              : <><div className="behavior-two-fields"><label>Gesture<select value={machine.activation.trigger} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, trigger: event.target.value as typeof machine.activation.trigger } })}><option value="press">Press</option><option value="hold">Hold</option><option value="drag">Drag</option></select></label><label>Entry event<select value={machine.activation.event} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, event: event.target.value as SpineBehaviorEvent } })}>{events.map((event) => <option key={event} value={event}>{event.replaceAll("-", " ")}</option>)}</select></label></div>
               {machine.activation.trigger === "hold" && <label>Hold delay<input type="number" min="0" step="0.05" value={machine.activation.holdDelay} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, holdDelay: Number(event.target.value) } })} /></label>}
               {machine.activation.trigger === "drag" && <label>Drag threshold<input type="number" min="0" step="1" value={machine.activation.dragThreshold} onChange={(event) => commit({ ...machine, activation: { ...machine.activation, dragThreshold: Number(event.target.value) } })} /></label>}</>}
        {machine.activation.kind === "pointer-region" && <>
          <div className="behavior-region-heading"><strong>Activation regions</strong><button onClick={() => {
            const region = { id: makeId("region"), name: `Region ${machine.activation.regions.length + 1}`, enabled: true, shape: "ellipse" as const, anchorBone: null, offsetX: 0, offsetY: 0, radiusX: 100, radiusY: 75, rotation: 0 };
            commit({ ...machine, activation: { ...machine.activation, regions: [...machine.activation.regions, region] } });
            setSelection({ kind: "region", id: region.id });
          }}>Add</button></div>
          <div className="behavior-selection-list" aria-label="Activation regions">
            {machine.activation.regions.map((region, index) => <button key={region.id} className={selection?.kind === "region" && selection.id === region.id ? "is-selected" : ""} aria-pressed={selection?.kind === "region" && selection.id === region.id} onClick={() => setSelection({ kind: "region", id: region.id })}><strong>{region.name || `Region ${index + 1}`}</strong><small>{region.shape} · {region.enabled ? "enabled" : "disabled"}</small></button>)}
            {!machine.activation.regions.length && <p className="editor-muted">No activation regions yet.</p>}
          </div>
        </>}
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

function DestructiveMenu({ label, actionLabel, disabled = false, onDelete }: { label: string; actionLabel: string; disabled?: boolean; onDelete: () => void }) {
  return <details className="behavior-context-menu">
    <summary aria-label={label} title={label}>···</summary>
    <div role="group" aria-label={label}><button className="danger" type="button" disabled={disabled} onClick={onDelete}>{actionLabel}</button></div>
  </details>;
}
