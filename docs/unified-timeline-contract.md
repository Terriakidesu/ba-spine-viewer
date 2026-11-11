# Unified timeline contracts

This document records the shared schema/evaluator contracts and the current integration boundary. The Editor can explicitly migrate a caller-supplied legacy schedule into an unsaved composition draft, review its schedule, assumptions, and diagnostics before applying it, preview it in Timeline and Camera, author Camera data against its composition track, and use the composition authoring panel for sections, animation clips, property/skeletal tracks and keys, audio, subtitles, and duration. The composition dope sheet supports multi-key selection, frame-snapped movement, copy/paste, duplication, deletion, and Bézier curve/tangent editing. Typed MCP composition edits are available. The Viewer can select and preview the canonical composition, trigger Talk sections with return-to-idle routing, and export its authored range or an optional section arrangement. Arrangement preview samples rendered frames from the same shared schedule used for section-local audio and subtitle export. Legacy timeline editing and legacy Opening/Talk arrangement export remain supported. Runtime physics seek parity and cached-sampling performance have been checked on a representative real asset. Exact-sample tests now compare canonical Viewer export-plan frames with the Timeline adapter and Camera solve, and a synthetic 128-layer/1,024-track/16,384-key fixture evaluates 90 output frames under a 15-second test limit; rendered-frame parity across Timeline, Camera, Viewer, and export, plus dense rendered-composition performance, remain outstanding.

## Schema and clocks

- `SpineComposition.schemaVersion` is version 1. Authored time is seconds; export code should derive sample time from integer frame indices rather than repeatedly add frame deltas.
- Composition, transport, and section-instance clocks are separate. Animation clip activation uses `clock`; its source sampling independently uses `sourceClock` (`clip-source`, composition, transport, or a section instance). Animation-name binding and transform parenting are separate layer fields and do not copy time, speed, or loop state.
- Sections are half-open `[start, end)` ranges. A composition explicitly chooses whether its endpoint is included. Property keys at the final authored time remain sampleable; discrete selection changes are stepped.
- Section-instance clocks on property tracks and animation clips must reference an existing section. Validation warns about keys and clip ranges beyond that section's local duration, and about section-local audio/subtitle cues that start outside or extend past their section; cues starting at the section endpoint are unreachable under half-open cue timing.
- Same-time property keys resolve to the lexicographically greatest stable key ID. Stable track evaluation order is ascending priority, then typed target/property key, then track ID. Higher priorities therefore apply later.
- Before/after-key behavior is explicit on each property track. With `holdBefore`/`holdAfter` false, an absent track value does not contribute; with them true, the nearest key is held. A track's `baseValue` is the value before its first key and when a track has no keys.

### Dope-sheet key editing

- Key selection is track-local for Shift range selection and may span tracks with Ctrl/Command selection. Dragging moves the selection as one group and clamps the shared delta to every owning composition/section range.
- Drag movement snaps to the composition frame grid; holding Alt temporarily disables snapping. Arrow keys move selected keys by one frame, or ten frames with Shift. Ctrl/Command+D duplicates by one frame; Ctrl/Command+C/V copy and paste at the playhead. Delete/Backspace removes the selected keys. Escape cancels an active drag or clears selection.
- Numeric tracks expose a curve view. Bézier handles can be dragged, nudged by keyboard, or edited numerically; the left key's interpolation controls the segment shape.

## Property and mixing rules

- `COMPOSITION_PROPERTY_REGISTRY` is the common typed inventory. Unknown property IDs remain in authored tracks and validate with a warning; unrestricted object-path writes are not part of the schema.
- Continuous scalar values support linear and cubic Bézier interpolation when registered. Bézier time handles are normalized fractions of the segment; stepped properties only accept step interpolation.
- Rotation tracks use the shortest angular path by default. `rotationMode: "continuous"` preserves intentional turns. Additive translation/rotation/shear are offsets; additive scale uses a multiplicative factor where `1` is neutral. Discrete properties do not support additive blending.
- Color track channels are linear-light sRGB in `[0, 1]`; legacy hex colors are converted from sRGB on migration.
- Animation clips have explicit activation range, source range/offset, source clock, non-negative speed, loop, hold/clear end behavior, blend in/out, weight, priority, and replace/add mixing mode. Speed automation is step/linear only and integrated over time; reverse rates and Bézier rate curves are rejected rather than approximated.
- Looping maps the exact source-range seam back to `sourceStart`. Non-looping clips clamp to `sourceEnd`. Activation itself remains half-open except when the composition explicitly includes its endpoint.

## Interactive defaults

`defaultTalkSectionRoute` records the first-release default route:

- One active Talk; ignore duplicate triggers while it is active.
- A new interaction replaces an active Talk.
- Blend in and return blend out over `0.14s` (the existing shared Talk mix default).
- Return to the explicitly designated idle section; camera output blends back to persistent camera output.
- Talk owns body, face, audio, subtitles, camera, effects, and skeletal overrides; scene/background tracks are not owned by the default Talk route. A route may opt into those channels explicitly.

The legacy full-sequence arrangement helper uses the existing Viewer defaults: include Opening when available, one initial idle loop, `0.5s` between Talks, and one final idle loop (at least one second). Persistent backgrounds use continuous output phase by default. `migrateLegacyTimelinesToComposition` does not infer these settings: callers pass the resulting schedule explicitly, and the schedule plus assumptions are included in the report.

## Shared composition schedules

- `spineCompositionSchedule.ts` provides both the canonical authored-range schedule and explicit section-instance arrangements. The canonical composition remains the export default; arrangements preserve the supplied section order, reject duplicate/missing section IDs, and can insert initial/final idle loops plus between-section idle spans.
- Arrangement section clocks restart at each section instance. Section-local audio and subtitle cues map through that instance's local time and are included only when the route owns their channel; composition-global cues map through each segment's authored source range. An unfilled gap has no authored source range and, consistently with the evaluator, samples global composition/persistent clocks at output time.
- Persistent scene/background clocks can use continuous output time (default) or original authored time. The schedule carries this mapping into preview, frame recording, audio gain automation, and subtitle/audio span generation; frame sampling uses the exact output timestamp rather than accumulated deltas.
- The Viewer settings preview renders a sample when a schedule segment is selected. This verifies the schedule at representative points, but is not a substitute for full rendered parity fixtures across Timeline, Camera, Viewer, and export.

## Spine 4.2.120 capability inventory

The installed runtime is `@esotericsoftware/spine-core@4.2.120`.

| Target | Runtime surface | Registered first-release channels | Evaluation note |
| --- | --- | --- | --- |
| Bone | `Bone.x/y/rotation/scaleX/scaleY/shearX/shearY` | All seven local channels | Overrides are applied after animation sampling and before `Skeleton.updateWorldTransform`. A later Spine constraint solve may change the constrained bone again. |
| IK constraint | `IkConstraint.mix/softness/bendDirection/compress/stretch` | All five fields | Mix/softness are numeric; bend direction and toggles are stepped. |
| Transform constraint | `mixRotate/mixX/mixY/mixScaleX/mixScaleY/mixShearY` | All six mix weights | Values are normalized to `[0, 1]`. Constraint ordering remains Spine-owned. |
| Path constraint | `position/spacing/mixRotate/mixX/mixY` | All five fields | Numeric position/spacing; mix channels are normalized. |
| Physics constraint | `inertia/strength/damping/massInverse/wind/gravity/mix` | All seven runtime fields | Stateful; direct arbitrary-time equivalence is not assumed. Use the fixed-step reset/preroll contract below. |
| Slot | `Slot.color` and `Skeleton.setAttachment` | RGBA channels and stepped attachment name | Attachment/slot identity must be capability-validated against the loaded skeleton. |
| Skin | `SkeletonData.findSkin` / `Skeleton.setSkin` | Stepped skin name | Runtime skin changes can affect attachments and update cache; apply in the authored stage and validate before editing. |

Bone paths are hierarchy paths, not display names. Bone/constraint/slot references include a layer ID and asset identity. A missing asset, mismatched identity, missing target, or unsupported channel produces a diagnostic; authored keys are retained.

### Constraint solve and physics

1. Resolve composition/section/source times and active clips.
2. Sample/mix Spine animations.
3. Apply local bone and constraint property overrides.
4. Call the Spine world-transform/constraint solve once for that sample.
5. Apply parent transforms, camera, and compositing.

The v1 stateful policy is reset plus fixed-step preroll at `1/60s`, capped at 36,000 steps (10 minutes). `runFixedStepPreroll` evaluates the initial pose at zero, advances exact integer step times, and performs one deterministic residual step for an off-grid sample. Reset clears every runtime physics constraint, including constraints whose current mix is zero. The Editor and Viewer composition renderers call this helper when a loaded skeleton has physics constraints; each callback resamples animation and overrides, with Spine's `Physics.reset` used at the initial sample and `Physics.update` for subsequent steps.

Per-renderer caches are an optimization of that same reset/preroll result: they retain exact one-second physics-state checkpoints (up to 600), plus recent/frontier states for nearby and forward samples. A shared viewport restores only a checkpoint timestamp present for every physics layer, then replays the remaining exact steps and residual. The cache is scoped to the composition, schedule, active section instance, and loaded skeleton; live interaction sampling bypasses it. A cached state at the requested grid time is reapplied with `Physics.pose`, without advancing simulation. The synthetic regression verifies cached seeks against fresh preroll and sequential sampling.

Manual validation on read-only `CH0320_home` (`Idle_01_R`, 400 bones, 134 physics constraints) produced a maximum pose delta of `0` between a 2-second preroll and sequential 1/60-second samples when both use integer-frame timestamps. A cold 10-second sample took about `0.5s` in this environment; a subsequent off-grid playback sample took about `3ms` with one or two runtime samples, and repeating that sample took about `1.6ms`. These timings are indicative only and do not replace dense-composition performance fixtures.

## Migration guarantees and limits

- Migration is an explicit Editor/MCP operation with a caller-supplied schedule and time-mapping policy. It never saves, edits, or rewrites the legacy project or Spine library; the resulting composition is an undoable in-memory edit until the ordinary explicit save operation.
- The caller supplies the exact arrangement ranges and source offsets. Migration preserves source sequence JSON in `migrationMetadata`, emits assumptions/diagnostics, and creates stable layer IDs only when legacy ID, role, asset directory, and duplicate ordinal match.
- Layer transforms, animation clips, audio, subtitles, color clips, and camera keyframes are placed at explicit output offsets. Legacy follower state becomes separate transform-parent and animation-name binding fields.
- If animation duration metadata is unavailable, the migration uses the authored clip span only as a provisional source range and reports it. Non-direct Opening modes, continuation/character-hide behavior, unresolved idle underlays, and path-derived asset identity are surfaced for review.
- The Editor project model and private/manifest persistence retain supported v1 composition documents; Viewer project normalization retains them for preview and authored-range export. Newer or malformed composition schemas are refused instead of silently stripped. The MCP migration operation returns its report, and whole-project validation includes composition diagnostics.
- Unified export samples exact integer frame times from the canonical composition duration. Desktop FFmpeg audio uses authored clip placement and source offsets. Enabled `audio.volume` property tracks are sampled at output-frame times, including canonical section-local clocks, simplified to at most 512 gain points within `0.001` linear gain error, and passed as piecewise-linear FFmpeg volume automation. The terminal gain sample preserves an ending section's local clock without activating its half-open cue range. Section-local subtitle/audio cues are offset to their authored section in linear preview and export.
- Typed MCP composition edits, migration review, Viewer Talk section routing, evaluated camera property tracks, composition key editing, shared canonical/arrangement schedules, schedule-driven arrangement preview, and desktop FFmpeg audio-gain automation are implemented. Legacy timeline editing and playback have not been removed. Physics seek/playback parity and cached sampling have been verified on a representative real asset. Exact-sample Viewer export-plan parity and a synthetic large-evaluator fixture are covered by tests; full rendered parity across Timeline, Camera, Viewer, and export, plus dense rendered-composition profiling, remain outstanding.
