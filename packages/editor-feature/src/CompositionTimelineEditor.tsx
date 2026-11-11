import { useMemo, useState, type RefObject } from "react";
import {
  COMPOSITION_PROPERTY_REGISTRY,
  type CompositionAnimationClip,
  type CompositionPropertyTrack,
  type CompositionSection,
  type CompositionTarget,
  type CompositionValue,
  type SpineComposition,
} from "@ba-spine/spine-runtime/spine/spineComposition";
import type { CompositionEditOperation } from "./compositionEdits";
import { NumberField } from "./components/NumberField";
import "./compositionTimelineEditor.css";

interface CompositionTimelineEditorProps {
  composition: SpineComposition;
  currentTime: number;
  animationNames: Record<string, string[]>;
  animationDurations: Record<string, number>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSeek: (seconds: number) => void;
  onEdit: (operations: CompositionEditOperation[]) => void;
}

function itemId(prefix: string): string {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function initialValue(value: CompositionValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function CompositionTimelineEditor({ composition, currentTime, animationNames, animationDurations, scrollRef, onSeek, onEdit }: CompositionTimelineEditorProps) {
  const [sectionName, setSectionName] = useState("New section");
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState(composition.layers[0]?.id ?? "");
  const [selectedAnimation, setSelectedAnimation] = useState("");
  const [animationSectionId, setAnimationSectionId] = useState("");
  const [targetKind, setTargetKind] = useState<CompositionTarget["kind"]>("layer");
  const [targetItemId, setTargetItemId] = useState("");
  const [propertySectionId, setPropertySectionId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [constraintType, setConstraintType] = useState<"ik" | "transform" | "path" | "physics">("ik");
  const [targetName, setTargetName] = useState("");
  const [selectedProperty, setSelectedProperty] = useState("layer.position.x");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [keyValueDraft, setKeyValueDraft] = useState("");
  const [keyTimeDraft, setKeyTimeDraft] = useState("0");
  const [keyInterpolation, setKeyInterpolation] = useState<"step" | "linear" | "bezier">("linear");
  const [audioPath, setAudioPath] = useState("");
  const [audioSectionId, setAudioSectionId] = useState("");
  const [subtitleSectionId, setSubtitleSectionId] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [selectedAnimationClipId, setSelectedAnimationClipId] = useState<string | null>(null);
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  const [selectedSubtitleCueId, setSelectedSubtitleCueId] = useState<string | null>(null);

  const scale = 72;
  const trackWidth = Math.max(640, Math.ceil(composition.duration * scale));
  const selectedSection = composition.sections.find((section) => section.id === selectedSectionId) ?? null;
  const selectedAnimationSection = composition.sections.find((section) => section.id === animationSectionId) ?? null;
  const selectedPropertySection = composition.sections.find((section) => section.id === propertySectionId) ?? null;
  const selectedTrack = composition.propertyTracks.find((track) => track.id === selectedTrackId) ?? null;
  const selectedKey = selectedTrack?.keys.find((key) => key.id === selectedKeyId) ?? null;
  const selectedAnimationClip = composition.animationClips.find((clip) => clip.id === selectedAnimationClipId) ?? null;
  const selectedAudioClip = composition.audio.find((clip) => clip.id === selectedAudioClipId) ?? null;
  const selectedSubtitleCue = composition.subtitles.find((cue) => cue.id === selectedSubtitleCueId) ?? null;
  const selectedLayer = composition.layers.find((layer) => layer.id === selectedLayerId) ?? composition.layers[0] ?? null;
  const availableAnimations = selectedLayer ? animationNames[selectedLayer.id] ?? [] : [];
  const availableProperties = useMemo(() => COMPOSITION_PROPERTY_REGISTRY.filter((property) => property.targetKinds.includes(targetKind)), [targetKind]);
  const selectedDefinition = COMPOSITION_PROPERTY_REGISTRY.find((property) => property.id === selectedProperty) ?? null;
  const selectedTrackDefinition = selectedTrack ? COMPOSITION_PROPERTY_REGISTRY.find((property) => property.id === selectedTrack.property) ?? null : null;

  function edit(operation: CompositionEditOperation) {
    onEdit([operation]);
  }

  function addSection() {
    const start = Math.min(composition.duration - 0.01, Math.max(0, currentTime));
    const end = Math.min(composition.duration, Math.max(start + 0.01, start + 2));
    const section: CompositionSection = { id: itemId("section"), name: sectionName.trim() || "New section", start, end };
    edit({ kind: "upsert_section", section });
    setSelectedSectionId(section.id);
  }

  function addAnimation() {
    if (!selectedLayer || !selectedAnimation) return;
    const length = animationDurations[`${selectedLayer.id}:${selectedAnimation}`] ?? 1;
    const clock = selectedAnimationSection
      ? { kind: "section-instance" as const, sectionId: selectedAnimationSection.id }
      : { kind: "composition" as const };
    const rangeDuration = selectedAnimationSection ? selectedAnimationSection.end - selectedAnimationSection.start : composition.duration;
    const clockTime = selectedAnimationSection ? Math.max(0, currentTime - selectedAnimationSection.start) : currentTime;
    const start = Math.min(clockTime, Math.max(0, rangeDuration - 0.01));
    const end = Math.min(rangeDuration, start + Math.max(0.01, length));
    if (end <= start) return;
    const clip: CompositionAnimationClip = {
      id: itemId("animation"), layerId: selectedLayer.id, animation: selectedAnimation,
      clock, sourceClock: { kind: "clip-source" }, start, end,
      sourceStart: 0, sourceEnd: Math.max(0.01, length), sourceOriginTime: start, sourceOffset: 0, speed: 1,
      loop: false, endBehavior: "clear", blendIn: 0.14, blendOut: 0.14, mixingMode: "replace", weight: 1, priority: 0, enabled: true,
    };
    edit({ kind: "upsert_animation_clip", clip });
    setSelectedAnimationClipId(clip.id);
  }

  function makeTarget(): CompositionTarget | null {
    if (targetKind === "camera") return { kind: "camera" };
    if (targetKind === "layer") return selectedLayer ? { kind: "layer", layerId: selectedLayer.id } : null;
    if (targetKind === "audio") return targetItemId ? { kind: "audio", audioId: targetItemId } : null;
    if (targetKind === "clip") return targetItemId ? { kind: "clip", clipId: targetItemId } : null;
    if (!selectedLayer) return null;
    if (targetKind === "bone") return targetPath.trim() ? { kind: "bone", layerId: selectedLayer.id, path: targetPath.trim(), assetIdentity: selectedLayer.assetIdentity } : null;
    if (targetKind === "constraint") return targetName.trim() ? { kind: "constraint", layerId: selectedLayer.id, type: constraintType, name: targetName.trim(), assetIdentity: selectedLayer.assetIdentity } : null;
    if (targetKind === "slot") return targetName.trim() ? { kind: "slot", layerId: selectedLayer.id, name: targetName.trim(), assetIdentity: selectedLayer.assetIdentity } : null;
    return null;
  }

  function addPropertyTrack() {
    const target = makeTarget();
    if (!target || !selectedDefinition || !selectedDefinition.targetKinds.includes(target.kind)) return;
    const clock = selectedPropertySection
      ? { kind: "section-instance" as const, sectionId: selectedPropertySection.id }
      : { kind: "composition" as const };
    const track: CompositionPropertyTrack = {
      id: itemId("track"), target, property: selectedDefinition.id, clock, enabled: true,
      priority: 0, blendMode: "override", weight: 1, baseValue: selectedDefinition.defaultValue, holdBefore: false, holdAfter: true, keys: [],
    };
    edit({ kind: "upsert_property_track", track });
    setSelectedTrackId(track.id);
    setSelectedKeyId(null);
    setKeyTimeDraft((selectedPropertySection ? Math.max(0, currentTime - selectedPropertySection.start) : currentTime).toFixed(3));
    setKeyValueDraft(initialValue(selectedDefinition.defaultValue));
  }

  function keyValue(): CompositionValue | null {
    if (selectedTrackDefinition?.valueType === "number") {
      const value = Number(keyValueDraft);
      return Number.isFinite(value) ? value : null;
    }
    if (selectedTrackDefinition?.valueType === "boolean") return keyValueDraft === "true";
    if (selectedTrackDefinition?.valueType === "color") {
      try {
        const parsed = JSON.parse(keyValueDraft) as unknown;
        if (parsed && typeof parsed === "object" && ["r", "g", "b", "a"].every((key) => typeof (parsed as Record<string, unknown>)[key] === "number")) return parsed as CompositionValue;
      } catch { /* Keep the current key when the color draft is invalid. */ }
      return null;
    }
    return keyValueDraft;
  }

  function keyTimeAtPlayhead(): number {
    const clock = selectedTrack?.clock;
    if (!clock || clock.kind !== "section-instance") return currentTime;
    const sectionId = clock.sectionId;
    const section = composition.sections.find((item) => item.id === sectionId);
    return Math.max(0, currentTime - (section?.start ?? 0));
  }

  function addKeyframe(timeOverride = Number(keyTimeDraft)) {
    if (!selectedTrack) return;
    const value = keyValue();
    const time = timeOverride;
    if (value === null || !Number.isFinite(time) || time < 0) return;
    const interpolation = selectedTrackDefinition?.interpolations.includes(keyInterpolation) ? keyInterpolation
      : selectedTrackDefinition?.interpolations.includes("linear") ? "linear" : "step";
    const key = { id: itemId("key"), time: Number(time.toFixed(3)), value, interpolation };
    edit({ kind: "upsert_keyframe", trackId: selectedTrack.id, key });
    setSelectedKeyId(key.id);
  }

  function updateSelectedKey() {
    if (!selectedTrack || !selectedKey) return;
    const value = keyValue();
    const time = Number(keyTimeDraft);
    if (value === null || !Number.isFinite(time) || time < 0) return;
    const interpolation = selectedTrackDefinition?.interpolations.includes(keyInterpolation) ? keyInterpolation : selectedKey.interpolation;
    edit({ kind: "upsert_keyframe", trackId: selectedTrack.id, key: { ...selectedKey, time: Number(time.toFixed(3)), value, interpolation } });
  }

  function updateAnimationClip(patch: Partial<CompositionAnimationClip>) {
    if (selectedAnimationClip) edit({ kind: "upsert_animation_clip", clip: { ...selectedAnimationClip, ...patch } });
  }

  function updateAudioClip(patch: Partial<SpineComposition["audio"][number]>) {
    if (selectedAudioClip) edit({ kind: "upsert_audio_clip", clip: { ...selectedAudioClip, ...patch } });
  }

  function updateSubtitleCue(patch: Partial<SpineComposition["subtitles"][number]>) {
    if (selectedSubtitleCue) edit({ kind: "upsert_subtitle_cue", cue: { ...selectedSubtitleCue, ...patch } });
  }

  function globalSectionTime(sectionId: string | undefined, time: number): number {
    return sectionId ? (composition.sections.find((section) => section.id === sectionId)?.start ?? 0) + time : time;
  }

  function updateSection(section: CompositionSection, patch: Partial<CompositionSection>) {
    edit({ kind: "upsert_section", section: { ...section, ...patch } });
  }

  const laneStyle = { width: `${trackWidth}px` };

  return <div className="composition-editor-panel" ref={scrollRef} aria-label="Unified composition timeline">
    <div className="composition-editor-toolbar">
      <strong>Unified composition timeline</strong>
      <NumberField label="Composition duration" value={composition.duration} min={0.01} step={0.1} precision={3} unit="s" onCommit={(duration) => edit({ kind: "set_duration", duration })} />
      <span>{composition.sections.length} sections · {composition.layers.length} layers · {composition.animationClips.length} animation clips</span>
    </div>
    <div className="composition-lanes-scroll">
      <div className="composition-lanes" style={laneStyle}>
        <div className="composition-ruler" aria-label="Composition time ruler">
          {Array.from({ length: Math.ceil(composition.duration) + 1 }, (_, second) => <button key={second} type="button" style={{ left: second * scale }} onClick={() => onSeek(Math.min(composition.duration, second))}>{second}s</button>)}
          <i className="composition-playhead" style={{ left: currentTime * scale }} />
        </div>
        <div className="composition-lane-row">
          <b>Sections</b>
          <div className="composition-lane-content">
            {composition.sections.map((section) => <button key={section.id} type="button" className={`composition-section-clip${selectedSection?.id === section.id ? " is-selected" : ""}`} style={{ left: section.start * scale, width: Math.max(8, (section.end - section.start) * scale) }} title={`${section.name}: ${section.start.toFixed(3)}–${section.end.toFixed(3)}s`} onClick={() => { setSelectedSectionId(section.id); onSeek(section.start); }}>{section.name}</button>)}
            <i className="composition-playhead" style={{ left: currentTime * scale }} />
          </div>
        </div>
        {composition.layers.map((layer) => <div className="composition-lane-row" key={layer.id}>
          <b title={`${layer.role} · ${layer.assetDirectory}`}>{layer.name}</b>
          <div className="composition-lane-content">
            {composition.animationClips.filter((clip) => clip.layerId === layer.id).map((clip) => {
              const start = globalSectionTime(clip.clock.kind === "section-instance" ? clip.clock.sectionId : undefined, clip.start);
              const end = globalSectionTime(clip.clock.kind === "section-instance" ? clip.clock.sectionId : undefined, clip.end);
              return <button key={clip.id} type="button" className={`composition-animation-clip${selectedAnimationClipId === clip.id ? " is-selected" : ""}`} style={{ left: start * scale, width: Math.max(8, (end - start) * scale) }} title={`${clip.animation} · ${start.toFixed(3)}–${end.toFixed(3)}s${clip.clock.kind === "section-instance" ? ` · ${clip.clock.sectionId} instance` : ""}`} onClick={() => { setSelectedAnimationClipId(clip.id); onSeek(start); }}>{clip.animation}</button>;
            })}
            <i className="composition-playhead" style={{ left: currentTime * scale }} />
          </div>
        </div>)}
        {composition.propertyTracks.map((track) => {
          const sectionId = track.clock.kind === "section-instance" ? track.clock.sectionId : undefined;
          const section = sectionId ? composition.sections.find((item) => item.id === sectionId) : null;
          return <div className="composition-lane-row" key={track.id}>
          <button type="button" className={`composition-track-label${selectedTrackId === track.id ? " is-selected" : ""}`} title={`${track.target.kind} · ${track.property}`} onClick={() => { setSelectedTrackId(track.id); setSelectedKeyId(null); setSelectedProperty(track.property); setTargetKind(track.target.kind); setPropertySectionId(sectionId ?? ""); setKeyTimeDraft((section ? Math.max(0, currentTime - section.start) : currentTime).toFixed(3)); if (track.target.kind === "audio") setTargetItemId(track.target.audioId); else if (track.target.kind === "clip") setTargetItemId(track.target.clipId); else if (track.target.kind === "layer" || track.target.kind === "bone" || track.target.kind === "constraint" || track.target.kind === "slot") setSelectedLayerId(track.target.layerId); setKeyValueDraft(initialValue(track.keys.at(-1)?.value ?? track.baseValue ?? COMPOSITION_PROPERTY_REGISTRY.find((property) => property.id === track.property)?.defaultValue ?? 0)); }}>{track.property}</button>
          <div className="composition-lane-content composition-key-lane">
            {track.keys.map((key) => {
              const time = globalSectionTime(track.clock.kind === "section-instance" ? track.clock.sectionId : undefined, key.time);
              return <button key={key.id} type="button" className={`composition-keyframe${selectedKeyId === key.id ? " is-selected" : ""}`} style={{ left: time * scale }} title={`${time.toFixed(3)}s · ${initialValue(key.value)}`} aria-label={`${track.property} key at ${time.toFixed(3)} seconds`} onClick={() => { setSelectedTrackId(track.id); setSelectedKeyId(key.id); setKeyValueDraft(initialValue(key.value)); setKeyTimeDraft(key.time.toFixed(3)); setKeyInterpolation(key.interpolation); onSeek(time); }} />;
            })}
            <i className="composition-playhead" style={{ left: currentTime * scale }} />
          </div>
        </div>;
        })}
        <div className="composition-lane-row">
          <b>Audio</b>
          <div className="composition-lane-content">
            {composition.audio.map((clip) => {
              const start = globalSectionTime(clip.sectionId, clip.start);
              const end = globalSectionTime(clip.sectionId, clip.end);
              return <button key={clip.id} type="button" className={`composition-audio-clip${selectedAudioClipId === clip.id ? " is-selected" : ""}`} style={{ left: start * scale, width: Math.max(8, (end - start) * scale) }} title={clip.path} onClick={() => { setSelectedAudioClipId(clip.id); setTargetKind("audio"); setTargetItemId(clip.id); onSeek(start); }}>{clip.name}</button>;
            })}
            <i className="composition-playhead" style={{ left: currentTime * scale }} />
          </div>
        </div>
        <div className="composition-lane-row">
          <b>Subtitles</b>
          <div className="composition-lane-content">
            {composition.subtitles.map((cue) => {
              const start = globalSectionTime(cue.sectionId, cue.start);
              const end = globalSectionTime(cue.sectionId, cue.end);
              return <button key={cue.id} type="button" className={`composition-subtitle-clip${selectedSubtitleCueId === cue.id ? " is-selected" : ""}`} style={{ left: start * scale, width: Math.max(8, (end - start) * scale) }} title={cue.text.en} onClick={() => { setSelectedSubtitleCueId(cue.id); onSeek(start); }}>{cue.text.en || cue.text.ja || cue.text.ko || "Subtitle"}</button>;
            })}
            <i className="composition-playhead" style={{ left: currentTime * scale }} />
          </div>
        </div>
      </div>
    </div>
    <div className="composition-authoring-tools">
      <section className="composition-authoring-section">
        <strong>Sections</strong>
        <div className="composition-tool-row"><input aria-label="New section name" value={sectionName} onChange={(event) => setSectionName(event.target.value)} /><button type="button" className="editor-button" onClick={addSection}>Add at playhead</button></div>
        {selectedSection && <>
          <label>Name<input key={selectedSection.id} defaultValue={selectedSection.name} onBlur={(event) => { if (event.currentTarget.value.trim() && event.currentTarget.value !== selectedSection.name) updateSection(selectedSection, { name: event.currentTarget.value.trim() }); }} /></label>
          <div className="composition-tool-row">
            <NumberField label="Start" value={selectedSection.start} min={0} max={selectedSection.end - 0.01} step={0.01} precision={3} unit="s" onCommit={(start) => updateSection(selectedSection, { start })} />
            <NumberField label="End" value={selectedSection.end} min={selectedSection.start + 0.01} max={composition.duration} step={0.01} precision={3} unit="s" onCommit={(end) => updateSection(selectedSection, { end })} />
            <button type="button" className="editor-button danger" onClick={() => { edit({ kind: "remove_section", sectionId: selectedSection.id }); setSelectedSectionId(null); }}>Remove section</button>
          </div>
          <div className="composition-tool-row">
            <button type="button" className="editor-button" onClick={() => edit({ kind: "upsert_section", section: { ...selectedSection, route: { role: "idle", returnToSectionId: null, ownedChannels: [], duplicateTrigger: "ignore", interruption: "replace", blendIn: 0.14, blendOut: 0.14, cameraReturn: "persistent" } } })}>Mark as idle</button>
            <button type="button" className="editor-button" onClick={() => edit({ kind: "upsert_section", section: { ...selectedSection, route: { role: "talk", returnToSectionId: composition.idleSectionId, ownedChannels: ["body", "face", "audio", "subtitles", "camera", "effects", "skeletal-overrides"], duplicateTrigger: "ignore", interruption: "replace", blendIn: 0.14, blendOut: 0.14, cameraReturn: "blend" } } })}>Mark as Talk</button>
            <button type="button" className="editor-button" disabled={selectedSection.route?.role !== "idle"} onClick={() => edit({ kind: "set_idle_section", sectionId: selectedSection.id })}>Set idle route target</button>
            <button type="button" className="editor-button" onClick={() => edit({ kind: "set_entry_section", sectionId: selectedSection.id })}>Set entry section</button>
          </div>
        </>}
      </section>
      <section className="composition-authoring-section">
        <strong>Animation clip</strong>
        <div className="composition-tool-row">
          <select aria-label="Composition layer" value={selectedLayer?.id ?? ""} onChange={(event) => { setSelectedLayerId(event.target.value); setSelectedAnimation(""); }}>
            {composition.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
          </select>
          <select aria-label="Animation" value={selectedAnimation} onChange={(event) => setSelectedAnimation(event.target.value)}>
            <option value="">Choose animation</option>{availableAnimations.map((animation) => <option key={animation} value={animation}>{animation}</option>)}
          </select>
          <select aria-label="Animation clip clock" value={animationSectionId} onChange={(event) => setAnimationSectionId(event.target.value)}>
            <option value="">Composition clock</option>{composition.sections.map((section) => <option key={section.id} value={section.id}>{section.name} instance</option>)}
          </select>
          <button type="button" className="editor-button" disabled={!selectedAnimation} onClick={addAnimation}>Add at playhead</button>
        </div>
        {selectedAnimationClip && <>
          <div className="composition-tool-row">
            <NumberField label="Clip start" value={selectedAnimationClip.start} min={0} max={selectedAnimationClip.end - 0.01} step={0.01} precision={3} unit="s" onCommit={(start) => updateAnimationClip({ start })} />
            <NumberField label="Clip end" value={selectedAnimationClip.end} min={selectedAnimationClip.start + 0.01} step={0.01} precision={3} unit="s" onCommit={(end) => updateAnimationClip({ end })} />
            <NumberField label="Speed" value={selectedAnimationClip.speed} min={0} max={8} step={0.1} precision={2} unit="×" onCommit={(speed) => updateAnimationClip({ speed })} />
          </div>
          <div className="composition-tool-row">
            <NumberField label="Blend in" value={selectedAnimationClip.blendIn} min={0} step={0.01} precision={3} unit="s" onCommit={(blendIn) => updateAnimationClip({ blendIn })} />
            <NumberField label="Blend out" value={selectedAnimationClip.blendOut} min={0} step={0.01} precision={3} unit="s" onCommit={(blendOut) => updateAnimationClip({ blendOut })} />
            <label className="composition-inline-check"><input type="checkbox" checked={selectedAnimationClip.loop} onChange={(event) => updateAnimationClip({ loop: event.target.checked })} /> Loop source</label>
            <button type="button" className="editor-button danger" onClick={() => { edit({ kind: "remove_animation_clip", clipId: selectedAnimationClip.id }); setSelectedAnimationClipId(null); }}>Remove clip</button>
          </div>
        </>}
      </section>
      <section className="composition-authoring-section">
        <strong>Property and skeletal track</strong>
        <div className="composition-tool-row">
          <select aria-label="Track target type" value={targetKind} onChange={(event) => { const next = event.target.value as CompositionTarget["kind"]; setTargetKind(next); setTargetItemId(""); const first = COMPOSITION_PROPERTY_REGISTRY.find((property) => property.targetKinds.includes(next)); if (first) setSelectedProperty(first.id); }}>
            <option value="layer">Layer</option><option value="clip">Animation/clip</option><option value="audio">Audio</option><option value="bone">Bone</option><option value="constraint">Constraint</option><option value="slot">Slot</option><option value="camera">Camera</option>
          </select>
          {(targetKind === "layer" || targetKind === "bone" || targetKind === "constraint" || targetKind === "slot") && <select aria-label="Target layer" value={selectedLayer?.id ?? ""} onChange={(event) => setSelectedLayerId(event.target.value)}>{composition.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select>}
          {(targetKind === "clip" || targetKind === "audio") && <select aria-label="Track target item" value={targetItemId} onChange={(event) => setTargetItemId(event.target.value)}>
            <option value="">Choose target</option>
            {targetKind === "clip"
              ? composition.animationClips.map((clip) => <option key={clip.id} value={clip.id}>{clip.animation} · {clip.id}</option>)
              : composition.audio.map((clip) => <option key={clip.id} value={clip.id}>{clip.name} · {clip.id}</option>)}
          </select>}
          {targetKind === "bone" && <input aria-label="Bone hierarchy path" placeholder="root/arm/hand" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} />}
          {targetKind === "constraint" && <><select aria-label="Constraint type" value={constraintType} onChange={(event) => setConstraintType(event.target.value as typeof constraintType)}><option value="ik">IK</option><option value="transform">Transform</option><option value="path">Path</option><option value="physics">Physics</option></select><input aria-label="Constraint name" placeholder="constraint name" value={targetName} onChange={(event) => setTargetName(event.target.value)} /></>}
          {targetKind === "slot" && <input aria-label="Slot name" placeholder="slot name" value={targetName} onChange={(event) => setTargetName(event.target.value)} />}
          <select aria-label="Track property" value={selectedProperty} onChange={(event) => setSelectedProperty(event.target.value)}>{availableProperties.map((property) => <option key={property.id} value={property.id}>{property.label}</option>)}</select>
          <button type="button" className="editor-button" onClick={addPropertyTrack} disabled={!makeTarget() || !selectedDefinition}>Add track</button>
        </div>
        <div className="composition-tool-row"><label>Track clock<select aria-label="Property track clock" value={propertySectionId} onChange={(event) => setPropertySectionId(event.target.value)}><option value="">Composition clock</option>{composition.sections.map((section) => <option key={section.id} value={section.id}>{section.name} instance</option>)}</select></label></div>
        {selectedTrack && <div className="composition-tool-row">
          {selectedTrackDefinition?.valueType === "boolean" ? <select aria-label="Key value" value={keyValueDraft} onChange={(event) => setKeyValueDraft(event.target.value)}><option value="true">True</option><option value="false">False</option></select>
            : selectedTrackDefinition?.enumValues ? <select aria-label="Key value" value={keyValueDraft} onChange={(event) => setKeyValueDraft(event.target.value)}>{selectedTrackDefinition.enumValues.map((value) => <option key={value} value={value}>{value || "None"}</option>)}</select>
              : <input aria-label="Key value" type={selectedTrackDefinition?.valueType === "number" ? "number" : "text"} step={selectedTrackDefinition?.valueType === "number" ? "any" : undefined} value={keyValueDraft} onChange={(event) => setKeyValueDraft(event.target.value)} />}
          <NumberField label="Key time" value={Number(keyTimeDraft) || 0} min={0} max={composition.duration} step={0.001} precision={3} unit="s" onCommit={(time) => setKeyTimeDraft(time.toFixed(3))} />
          <select aria-label="Key interpolation" value={keyInterpolation} onChange={(event) => setKeyInterpolation(event.target.value as typeof keyInterpolation)}>{(selectedTrackDefinition?.interpolations ?? ["step"]).map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select>
          <button type="button" className="editor-button" onClick={() => addKeyframe()}>Add key at time</button>
          <button type="button" className="editor-button" onClick={() => addKeyframe(keyTimeAtPlayhead())}>Key at playhead</button>
          <button type="button" className="editor-button" disabled={!selectedKey} onClick={updateSelectedKey}>Update selected key</button>
          <button type="button" className="editor-button danger" disabled={!selectedKey} onClick={() => { if (!selectedKey) return; edit({ kind: "remove_keyframe", trackId: selectedTrack.id, keyId: selectedKey.id }); setSelectedKeyId(null); }}>Remove key</button>
          <button type="button" className="editor-button danger" onClick={() => { edit({ kind: "remove_property_track", trackId: selectedTrack.id }); setSelectedTrackId(null); }}>Remove track</button>
        </div>}
      </section>
      <section className="composition-authoring-section">
        <strong>Audio and subtitle cues</strong>
        <div className="composition-tool-row">
          <select aria-label="Audio cue section" value={audioSectionId} onChange={(event) => setAudioSectionId(event.target.value)}><option value="">Composition time</option>{composition.sections.map((section) => <option key={section.id} value={section.id}>{section.name} instance</option>)}</select>
          <input aria-label="Audio asset path" placeholder="audio/voice.ogg" value={audioPath} onChange={(event) => setAudioPath(event.target.value)} />
          <button type="button" className="editor-button" disabled={!audioPath.trim()} onClick={() => {
            const section = composition.sections.find((item) => item.id === audioSectionId);
            const time = section ? Math.max(0, currentTime - section.start) : currentTime;
            const duration = section ? section.end - section.start : composition.duration;
            const start = Math.min(time, duration - 0.01);
            const clip = { id: itemId("audio"), name: audioPath.split(/[\\/]/).at(-1) ?? "Audio", path: audioPath.trim(), start, end: Math.min(duration, start + 1), sourceOffset: 0, volume: 1, enabled: true, ...(section ? { sectionId: section.id } : {}) };
            edit({ kind: "upsert_audio_clip", clip }); setSelectedAudioClipId(clip.id); setTargetKind("audio"); setTargetItemId(clip.id);
          }}>Add audio at playhead</button>
        </div>
        <div className="composition-tool-row">
          <select aria-label="Subtitle cue section" value={subtitleSectionId} onChange={(event) => setSubtitleSectionId(event.target.value)}><option value="">Composition time</option>{composition.sections.map((section) => <option key={section.id} value={section.id}>{section.name} instance</option>)}</select>
          <input aria-label="Subtitle text" placeholder="Subtitle text" value={subtitleText} onChange={(event) => setSubtitleText(event.target.value)} />
          <button type="button" className="editor-button" disabled={!subtitleText.trim()} onClick={() => {
            const section = composition.sections.find((item) => item.id === subtitleSectionId);
            const time = section ? Math.max(0, currentTime - section.start) : currentTime;
            const duration = section ? section.end - section.start : composition.duration;
            const start = Math.min(time, duration - 0.01);
            const cue = { id: itemId("subtitle"), start, end: Math.min(duration, start + 2), enabled: true, text: { en: subtitleText, ja: "", ko: "" }, ...(section ? { sectionId: section.id } : {}) };
            edit({ kind: "upsert_subtitle_cue", cue }); setSelectedSubtitleCueId(cue.id); setSubtitleText("");
          }}>Add subtitle at playhead</button>
        </div>
        {selectedAudioClip && <>
          <strong>{selectedAudioClip.name}</strong>
          <div className="composition-tool-row">
            <NumberField label="Audio start" value={selectedAudioClip.start} min={0} max={selectedAudioClip.end - 0.01} step={0.01} precision={3} unit="s" onCommit={(start) => updateAudioClip({ start })} />
            <NumberField label="Audio end" value={selectedAudioClip.end} min={selectedAudioClip.start + 0.01} step={0.01} precision={3} unit="s" onCommit={(end) => updateAudioClip({ end })} />
            <NumberField label="Source offset" value={selectedAudioClip.sourceOffset} min={0} step={0.01} precision={3} unit="s" onCommit={(sourceOffset) => updateAudioClip({ sourceOffset })} />
            <NumberField label="Base volume" value={selectedAudioClip.volume} min={0} max={1} step={0.01} precision={3} onCommit={(volume) => updateAudioClip({ volume })} />
            <button type="button" className="editor-button danger" onClick={() => { edit({ kind: "remove_audio_clip", clipId: selectedAudioClip.id }); setSelectedAudioClipId(null); }}>Remove audio</button>
          </div>
        </>}
        {selectedSubtitleCue && <>
          <strong>Selected subtitle</strong>
          <div className="composition-tool-row">
            <input aria-label="English subtitle" value={selectedSubtitleCue.text.en} onChange={(event) => updateSubtitleCue({ text: { ...selectedSubtitleCue.text, en: event.target.value } })} />
            <NumberField label="Subtitle start" value={selectedSubtitleCue.start} min={0} max={selectedSubtitleCue.end - 0.01} step={0.01} precision={3} unit="s" onCommit={(start) => updateSubtitleCue({ start })} />
            <NumberField label="Subtitle end" value={selectedSubtitleCue.end} min={selectedSubtitleCue.start + 0.01} step={0.01} precision={3} unit="s" onCommit={(end) => updateSubtitleCue({ end })} />
            <button type="button" className="editor-button danger" onClick={() => { edit({ kind: "remove_subtitle_cue", cueId: selectedSubtitleCue.id }); setSelectedSubtitleCueId(null); }}>Remove subtitle</button>
          </div>
        </>}
      </section>
    </div>
  </div>;
}
