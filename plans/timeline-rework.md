# Unified Timeline Rework

## Status and agreed scope

This document plans a replacement of the separate Opening/Talk timeline model with one continuous, editable composition. It is a design and delivery plan, not a record of completed implementation.

Confirmed requirements:

- Opening, idle, Talk animations, scenes, backgrounds, overlays, camera, audio, and subtitles belong to one connected timeline, comparable to the Viewer's current full-sequence export.
- All supported runtime-editable values can be animated, including animation selection and playback parameters.
- Bone and constraint keyframing is included in the first release, not deferred to a later release.
- Talk sections remain independently triggerable in the interactive Viewer and return to a designated idle state.
- Timeline preview, Camera preview, Viewer playback, and export use the same evaluation rules.
- Changes to bones, constraints, and attachments are non-destructive composition overrides; original Spine assets are not rewritten.

## 1. Problem statement

The current document and runtime distinguish Opening and individual Talk sequences. Each sequence carries its own layers, clips, camera data, audio, subtitles, duration, and local playhead. Full-sequence export then builds a separate schedule to connect these documents with idle intervals.

This creates several competing sources of timing and state:

- Character clip time, sequence time, recording time, and persistent idle time.
- Layer state copied or reconstructed across sequence transitions.
- Opening continuation, Talk mixing, idle tails, and camera holds implemented as special cases.
- Export assembly rules that are not directly visible or editable in the main timeline.
- Limited property animation, with camera-specific keyframes and mostly static layer settings.

Recent follower fixes illustrate the issue: transform inheritance, animation-name matching, and clock synchronization were coupled under one follow setting. A follower must be able to inherit the character transform without accidentally inheriting a clip-local clock.

The replacement should make time, ownership, animation composition, and state transitions explicit rather than adding more sequence-specific conditions.

## 2. Goals

1. Author the complete presentation on one continuous timeline.
2. Preserve stable layer identities across Opening, idle, and Talk boundaries.
3. Animate all supported visual/audio runtime properties through a common track system.
4. Include skeletal bone and constraint animation in the first release.
5. Support deterministic random-access sampling for scrubbing, preview, and export.
6. Keep Talk sections reusable and independently playable in the interactive Viewer.
7. Preserve continuous persistent background motion during interactive Talks.
8. Migrate existing authored work without silently dropping data or rewriting source libraries.
9. Keep Viewer and Editor separate applications, sharing timeline behavior through the runtime package.

### Non-goals

- Editing or exporting replacement Spine skeleton/animation source files.
- Treating document identity, filesystem paths, editor locks, or UI preferences as animatable properties.
- Implementing arbitrary executable expressions in property tracks in the first release.
- Assuming every Spine version exposes identical constraints or attachment features.
- Replacing the behavior-machine system wholesale; integrate it with explicit timeline actions and ownership instead.
- Reworking portable packaging or merging unrelated roadmap documents.

## 3. Authoring model

### 3.1 Composition

A composition is the canonical authored timeline. It owns:

- Stable layers and asset bindings.
- Animation, property, skeletal override, camera, audio, subtitle, and event tracks.
- Sections and markers.
- Duration policy and playback/export ranges.
- Interactive entry, idle, and Talk routing metadata.
- Optional reusable clip definitions and their instances.

The active playhead, selection, zoom, expanded tracks, and curve-editor state are editor session state rather than alternate copies of authored composition data.

### 3.2 Layers

Layers represent persistent scene entities: character, scene, background, overlay, and color layers. Role is organizational metadata and a source of authoring presets, not a hidden timing engine.

Each layer has a stable ID, asset binding, base property values, tracks, and optional transform parent. Visibility windows and animation clips determine when it contributes; changing section does not recreate the layer or its renderer by default.

Separate these formerly coupled controls:

- **Transform parent:** inherit another layer's evaluated transform.
- **Animation binding:** optionally resolve an animation by another layer's selected animation name.
- **Clock source:** choose composition, section-instance, or clip-source time.

Define local transform composition explicitly. Validate parent references and reject cycles. Reparenting offers explicit preserve-world or preserve-local behavior.

### 3.3 Sections

Sections are named timeline ranges such as Scene, Opening, Idle, Talk 1, Talk 2, and Ending. They provide navigation, playback ranges, export selection, and interactive entry points.

Sections do not own duplicate scenes or introduce implicit resets. A section may include routing metadata such as:

- Entry and exit markers.
- Talk/idle classification.
- Interactive track ownership mask.
- Return-to-idle target and transition settings.
- Interruption policy.

Markers label meaningful instants without adding playback behavior unless explicitly referenced by an event or route.

### 3.4 Reusable content

Support reusable clip instances with stable source references, placement, trim, rate, and parameter overrides. Establish the schema and evaluator contract early; avoid making nested composition editing a prerequisite for the initial unified timeline UI.

Sections in the canonical timeline are ranges. Reusing their content in an export arrangement creates explicit instances, not destructive movement of their original tracks.

## 4. Time model

Use distinct named clocks:

| Clock | Meaning |
| --- | --- |
| Composition time | Continuous authored time shared by the composition |
| Section-instance time | Elapsed time within a selected or triggered section instance |
| Clip source time | Source sampling after trim, offset, rate, and loop mapping |
| Transport time | Monotonic elapsed playback time used to schedule events and live section instances |

Rules:

- Persistent backgrounds default to composition time during linear playback and the persistent transport mapping during interactive playback.
- A Talk trigger advances its section-instance clock without seeking or restarting the persistent transport.
- Animation clips normally map their active range to source time; global-phase clips explicitly sample the composition/transport mapping.
- Transform inheritance never implicitly changes a clock source.
- Animation-name bindings never implicitly copy source time, speed, or looping.
- Clip source offsets, trims, speed, looping, and end behavior are explicit.
- Store authored time in seconds with stable serialization precision. Use frame-based snapping and integer frame indices for export sampling rather than accumulating frame deltas.
- Define clip activity with half-open intervals, with an explicit final-frame policy at the composition endpoint.
- Define loop seam behavior, zero-duration/discrete keys, and duplicate-time key replacement consistently.

Time remapping must be deterministic. Variable playback-rate tracks require a defined integrated source-time mapping, not `currentTime * currentRate`. Forward, reverse, zero-rate, and loop behavior must be specified and tested before exposing those controls; unsupported modes must be disabled rather than approximate silently.

## 5. Typed property registry

Introduce a registry shared by the document schema, evaluator, inspector, timeline UI, validation, and MCP operations.

Each property definition provides:

- Stable typed target and property identifiers.
- Value type, units, defaults, valid range, and normalization.
- Supported interpolation and blending modes.
- Whether it supports additive overrides.
- Evaluation stage and runtime capability requirements.
- UI labels, grouping, and editing metadata.

Use typed target references for layers, cameras, clips, bones, constraints, slots, and audio instances. Do not expose unrestricted object-path writes.

### 5.1 Continuous properties

- Layer position, rotation, scale, opacity, and supported tint/color channels.
- Camera position, zoom/frame size, and rotation if supported by the rendering path.
- Color layer and color clip properties.
- Audio volume and supported mix parameters.
- Animation speed and blend weight.
- Supported effect strengths and interaction presentation parameters.
- Bone local position, rotation, scale, and shear.
- Supported numeric constraint parameters and mix weights.

### 5.2 Discrete properties

- Visibility and runtime enabled state.
- Blend mode and compositing order.
- Animation and face animation selection.
- Skin and attachment selection where supported.
- Loop mode and other categorical runtime settings with a defined evaluation contract.

Discrete properties use stepped keys. Animating structural bindings such as transform parents requires cycle validation and explicit switching semantics; keep unsafe structural changes non-animatable until that contract is implemented.

### 5.3 Non-animatable fields

IDs, names, asset/file paths, locks, selection, expansion state, editor preferences, and persistence metadata remain document or UI settings. Section boundary edits and clip placement are structural edits, not ordinary automation channels.

### 5.4 Keyframe representation

Keys contain stable IDs, time, typed values, interpolation, and optional tangent data. Support:

- Stepped interpolation.
- Linear interpolation.
- Cubic Bézier interpolation with editable handles.
- Hold behavior before the first and after the last key, explicitly defined per track.
- Rotation policy that distinguishes shortest-path interpolation from intentional multi-turn values.
- Defined color space for color interpolation.

Base values apply when no track contributes. Track conflicts, priorities, blend modes, and weights must have a stable order independent of UI selection or renderer mount order.

## 6. Animation clips and mixing

Animation changes are first-class animation clips rather than interpolated animation-name strings. An animation-selection key in the inspector creates or edits a stepped clip boundary using the same underlying model.

Animation clips support:

- Animation reference and optional face animation reference.
- Start/end, source trim/offset, speed, loop, and end/hold policy.
- Explicit clock binding.
- Blend-in/out, weight automation, priority, and supported mixing mode.
- Independent body/face tracks and an explicit idle underlay.

Overlaps have defined mixing rules. Crossfades are authored and visible. Do not leave Opening continuation, Talk fade-out, and final idle recovery as hidden role-based branches.

Presets can create familiar Opening, Talk-with-idle-underlay, and scene-first layouts. Once created, these are ordinary editable tracks and transitions.

Missing animations produce clear diagnostics and a deliberate fallback policy. Name matching is an optional binding with an explicit fallback, not a substitute for asset validation.

## 7. Bone, slot, and constraint keyframing

This is required for the first release.

### 7.1 Non-destructive overrides

Store skeletal edits in composition tracks targeting a layer plus a stable skeleton target reference. Prefer validated hierarchy/path references with asset identity metadata; never rely solely on ambiguous display names.

Support absolute local-value overrides and additive local offsets where meaningful. Specify additive scale/shear/rotation semantics rather than treating every numeric value as ordinary addition.

Bone edits affect the evaluated pose without modifying source skeleton or animation files. Slot color/attachment and skin choices use the same capability-aware target model.

### 7.2 Evaluation stages

The conceptual order is:

1. Resolve time, active clips, source samples, and weights.
2. Restore a known skeleton baseline and sample/mix Spine animations.
3. Apply keyed local bone channels and supported constraint parameter overrides.
4. Evaluate Spine world transforms and constraints in the runtime's supported order.
5. Apply layer parenting, camera projection, and compositing.

Audit the actual Spine API before implementing the adapter. Constraint ownership and update order must be respected; do not promise that a keyed constrained bone will bypass its solver. Any post-constraint override requires its own supported stage and descendant-update policy.

### 7.3 Capability matrix

Inventory the loaded Spine runtime and supported asset versions. Define supported properties for IK, transform, path, physics, and other constraints actually available. Distinguish animatable numeric parameters, stepped settings, and unsupported values.

Unavailable targets or unsupported channels are retained in the document with warnings and disabled editing, not silently discarded.

Physics/stateful constraints need a deterministic sampling policy. Where a single-time solve is insufficient, use a documented reset plus fixed-step preroll/checkpoint strategy shared by preview and export. Test seek parity with tolerances; do not claim random-access equivalence without validating stateful simulation.

## 8. Shared deterministic evaluation architecture

Place canonical schema, normalization, clock mapping, sampling, and evaluation in `packages/spine-runtime`. Keep editor interactions and layout in `packages/editor-feature`, Viewer transport/export UI in `packages/viewer-feature`, and filesystem policy in `packages/desktop-host`.

Suggested boundaries, with final filenames chosen during implementation:

- Composition document and migration types.
- Property registry and target validation.
- Time/source mapping.
- Keyframe and curve sampling.
- Clip resolution and animation mix plans.
- Bone/constraint runtime adapters.
- Frame evaluation and diagnostics.
- Transport/event scheduling and interactive section routing.

Data flow:

```text
Document + asset metadata + explicit playback context + sample time
                              |
                              v
                    Shared frame evaluator
                              |
                              v
      Layer/animation/pose/camera/audio/subtitle evaluation plan
                              |
             +----------------+----------------+
             |                |                |
       Editor previews      Viewer           Export
```

Keep document evaluation pure where possible. Stateful runtime adapters have explicit reset/checkpoint contracts. Evaluated state is derived and never written back into authored base values during playback.

Separate sampling from side effects:

- Scrubbing evaluates visuals and cue activity without firing playback events.
- Forward transport dispatches events crossed in a defined interval exactly once per instance/loop.
- Seek, loop, interruption, and replay have explicit event policies.
- Audio uses scheduled clip instances, source offsets, and gain automation, with resynchronization rules rather than restarting every frame.
- Subtitles derive visibility from the same schedule and language selection.

## 9. Interactive Viewer sections

Preserve independently triggered Talks while keeping the composition as the authored source of truth.

The Viewer owns a persistent playback context and explicit temporary section instances. Triggering a Talk activates its section-bound tracks without seeking continuous background tracks.

Required policies:

- Talk entry point and return-to-idle target.
- Blend-in and return blend-out.
- Track ownership: character body/face, audio/subtitles, camera, effects, and scene layers as explicitly authored.
- Repeated trigger behavior: ignore, restart, queue, or replace, chosen explicitly.
- Interruption behavior, audio cancellation/fade, and subtitle cleanup.
- Completion based on the authored section and cue tails, not animation duration alone.
- Camera ownership and whether section camera output returns, holds, or blends to persistent camera output.
- Interaction gesture/behavior ownership and priority relative to authored skeletal overrides.

Recommended defaults are one active Talk, ignore duplicate triggers while active, blend back to the designated idle, and preserve persistent background phase. Make policies visible and configurable rather than rely on special sequence IDs.

Behavior machines can trigger section instances through stable section IDs. Define how existing intro/Talk actions migrate and how live interaction overlays coexist with deterministic composition playback.

## 10. Editor experience

Rework `packages/editor-feature/src/TimelineWorkspace.tsx` around one composition rather than expanding its current sequence conditionals.

### Timeline

- One ruler/playhead for the complete composition.
- Section lane and markers; selecting a section navigates or sets a playback range without changing documents.
- Persistent layer rows with expandable animation/property/bone/constraint tracks.
- Clip trimming, moving, splitting, duplicating, and visible blend regions.
- Keyframe multi-select, move, duplicate, copy/paste, delete, and snapping.
- Ripple edits with an explicit scope for tracks, sections, linked audio/subtitles, and markers.
- Mute/solo/lock and clear distinction between runtime visibility and editing controls.

### Inspector and skeletal tools

- Keyframe diamonds beside animatable controls.
- Explicit auto-key toggle with clear keyed/currently-animated states.
- Editing an unanimated property changes its base value.
- Editing an animated property creates/updates a key only under an explicit key/auto-key action; otherwise offer a deliberate base/edit-track choice.
- Bone/constraint selection synchronized with the viewport and track list.
- Numeric controls and gizmos create the same typed commands and respect override mode.
- Filter tracks to selected/keyed targets so large skeletons remain usable.

### Dope sheet and curves

- A dope-sheet view for property and skeletal keys.
- Curve editor with stepped/linear/Bézier interpolation, tangent handles, value/time editing, and useful framing.
- Consistent undo/redo transactions for scrubs, drags, bulk changes, and auto-key operations.
- Keyboard access, selection feedback, and scalable virtualization of large track trees.

Timeline and Camera workspaces render the same evaluated composition and camera. Workspace switching must not change timing, authored state, or frame selection.

## 11. Export integration

Move canonical composition scheduling out of Viewer-specific recording code. `packages/viewer-feature/src/videoRecorder.ts` and `Spine.tsx` should consume shared schedules rather than define a parallel timeline engine.

- Full-sequence export defaults to the authored composition range.
- Opening/Talk selection becomes section/range selection.
- Optional arrangements instantiate selected sections and idle gaps into an explicit schedule.
- Arrangement policy states whether persistent tracks use continuous output time or original authored time; use continuous output phase for persistent backgrounds by default.
- Camera continuity, audio, subtitle timing, source offsets, and mix tails come from the same schedule as preview.
- Export samples exact frame times and uses the shared stateful-constraint preroll policy.
- Preserve existing resolution, quality, format, aspect ratio, audio, and subtitle options.
- Validate missing assets/capabilities before recording and report diagnostics without partial silent substitutions.

An arrangement preview must be available so export is not the first place a different schedule is evaluated.

## 12. Migration and compatibility

Introduce a new versioned schema. Read old projects through a migration adapter; write the new schema only through an explicit save/migration flow.

Migration steps:

1. Inventory legacy Opening/Talk sequences, authored sequence order, entry sequence, layer identities, asset paths, and deleted-sequence metadata.
2. Construct the full composition schedule using documented legacy export defaults where the project does not contain arrangement settings. Report assumptions because export settings may be user preferences rather than saved project data.
3. Map corresponding layers to stable persistent IDs. Do not merge distinct layers merely because they share an asset directory or display name.
4. Place legacy animation clips, audio, subtitles, color clips, camera keys, and transitions at explicit global offsets.
5. Convert continuation, Talk mixing, idle tails, hide-character flags, and camera holds into explicit clips/keys/transitions.
6. Preserve legacy resets/holds where required for fidelity; flag ambiguous behavior instead of silently choosing a different result.
7. Convert the overloaded follow setting into separate transform, animation-binding, and clock settings.
8. Create section metadata and interactive routes for existing independently playable Talks.
9. Validate target references, timing, missing assets, locked content, and unsupported channels.
10. Present a migration report and retain access to the original document/backup.

Guarantees:

- No migration or validation writes into repository `data/`.
- No automatic source-library rewrite on load.
- No silent deletion of unsupported or unresolved authored data.
- No silent downgrade of new-schema files by older readers.
- Save conflict detection and verification remain intact.
- Use disposable fixtures for migration tests and write tests.

## 13. MCP and command integration

Update typed editor commands and MCP inspection/editing alongside the schema, rather than bolt them on after the UI.

Required operations include:

- Inspect composition, sections, property definitions, capabilities, tracks, keys, and evaluated frames.
- Create/edit/remove sections, clips, tracks, keys, and bindings using stable IDs.
- Set base values or insert keys explicitly.
- Batch edits as atomic undoable transactions.
- Validate target types, numeric ranges, asset capabilities, locks, parent cycles, and overlap policy.
- Trigger/cancel section previews without modifying authored data.
- Preserve document revisions, external-save conflict protection, and workspace-independent authored edits.

Keep workspace mounting requirements limited to rendered preview and interactive viewport operations; document/evaluator queries should not require the Timeline workspace.

## 14. Delivery milestones

### Milestone 1 — Contracts, inventory, and fixtures

- Inventory current timeline, composition, camera, recorder, behavior, and persistence code paths.
- Document the runtime capability matrix for bone/slot/constraint properties.
- Finalize clock semantics, interval rules, mixing/ownership, physics policy, and property targets.
- Create representative disposable legacy/new-schema fixtures.

Exit: executable schema/validation prototypes and agreed timing examples, including continuous backgrounds and independent Talks.

### Milestone 2 — Schema, registry, and migration foundation

- Add versioned composition types, normalization, typed registry, and validation.
- Separate editor session state from authored data.
- Implement legacy conversion with diagnostics and stable reference mapping.
- Add round-trip and migration tests before enabling new-schema writes in the UI.

Exit: fixture conversions preserve all represented legacy content and produce explicit reports for ambiguity.

### Milestone 3 — Shared evaluator and skeletal automation

- Implement clocks, curves, active clips, mixing plans, parenting, and camera evaluation.
- Implement bone/slot/constraint adapters, weighted overrides, and deterministic stateful evaluation.
- Add transport events, audio/subtitle schedule evaluation, and interactive instance ownership.

Exit: evaluator tests demonstrate seek/playback parity and correct skeletal/constraint behavior. Bone/constraint support is mandatory here, not a post-release add-on.

### Milestone 4 — Unified editor

- Add the continuous composition timeline and section lane.
- Add animation/property/bone/constraint tracks, inspector keys, auto-key, dope sheet, and curve editor.
- Connect viewport gizmos and typed commands to the same edit model.
- Keep Timeline and Camera previews on the shared evaluator.

Exit: a complete scene/opening/idle/Talk presentation can be authored, scrubbed, saved, and reloaded without legacy sequence switching.

### Milestone 5 — Viewer interactive routing

- Integrate shared evaluation and persistent transport.
- Implement Talk triggers, ownership, interruption, and return-to-idle policies.
- Bridge behavior actions and existing interaction overlays.
- Preserve Viewer browsing, playback controls, and light/dark/system theme preferences.

Exit: triggering Talks does not reset background phase, leak cues, or leave unintended pose/camera state.

### Milestone 6 — Export, parity, and migration release

- Switch full-sequence recording and optional arrangements to shared schedules.
- Add arrangement preview and exact-frame sampling.
- Run migration and rendering parity fixtures across all consuming surfaces.
- Remove legacy playback branches only after callers and fixtures demonstrate compatibility.

Exit: all first-release requirements pass, including bone/constraint authoring and independent Talk playback.

## 15. Validation strategy

### Unit and property tests

- Global/section/source clock mapping, trim, loops, boundary frames, offsets, and rate integration.
- Step/linear/Bézier curves, tangent normalization, rotation wrapping, and color interpolation.
- Animation overlap, underlays, face tracks, weights, and crossfades.
- Transform inheritance, parent cycles, and explicit reparenting behavior.
- Bone override modes, constraints, slot/attachment switches, and unsupported targets.
- Stateful simulation reset/preroll/checkpoint parity.
- Event dispatch across seeks, loops, replay, interruptions, and duplicate triggers.
- Audio/subtitle scheduling and cleanup.
- Schema validation, deterministic serialization, migration assumptions, and round trips.

### Integration and visual tests

- The same timestamp produces equivalent evaluated state in Timeline, Camera, Viewer, and export.
- Direct seeking matches sequential playback, including skeletal poses and stateful constraints under the documented policy.
- Background phase remains continuous across scene/opening/idle/Talk transitions.
- Interactive Talks preserve persistent channels and correctly release owned channels on return/interruption.
- Camera holds/blends, compositing order, visibility, and keyed attachments match the authoring view.
- Missing assets and unsupported capabilities produce visible diagnostics without data loss.
- Large skeletons and dense keyframe documents remain responsive.

Use disposable fixtures. Run `bun run typecheck` and `bun test` for code changes, plus focused package tests during development. Use renderer-only builds where appropriate. Native build validation must respect existing Electrobun watchers and locks; do not launch/stop applications without authorization.

## 16. First-release acceptance criteria

- [ ] One authored timeline contains scenes, opening, idle, Talks, backgrounds, camera, audio, and subtitles.
- [ ] Sections navigate and play ranges without creating separate scene documents.
- [ ] Stable layer identity and continuous background phase survive section transitions.
- [ ] Transform inheritance, animation binding, and clock choice are independent.
- [ ] All supported runtime-editable properties are registered and keyframeable; exclusions are documented.
- [ ] Animation selection, source timing, looping, speed, and blending are editable.
- [ ] Bone and constraint keyframing works in the first release with non-destructive overrides.
- [ ] Supported skin/attachment and discrete property changes use explicit stepped semantics.
- [ ] Deterministic seek behavior includes an implemented policy for stateful constraints.
- [ ] Timeline, Camera, Viewer, and export agree on evaluated frames.
- [ ] Independently triggered Talks have explicit interruption and return-to-idle behavior.
- [ ] Interactive Talks do not restart persistent backgrounds or leak audio/subtitles.
- [ ] Full-sequence export uses the shared schedule and offers an accurate arrangement preview.
- [ ] Existing projects migrate with reports, original-data preservation, and no silent writes.
- [ ] Undo/redo, save/reload, validation, and MCP support the new model.
- [ ] Typecheck, unit/integration tests, parity fixtures, and performance checks pass.

## 17. Risks and implementation decisions

- **Scope:** skeletal automation is substantial but required for the first release. Deliver incremental milestones without declaring the feature complete before it works.
- **Stateful constraints:** a pure timestamp is not always sufficient for physical simulation. Resolve reset/preroll/checkpoint behavior early.
- **Legacy fidelity:** old export behavior includes implicit state and user settings; migration must identify assumptions and retain originals.
- **Track conflicts:** define ownership and priority once, especially between live gestures, Talk sections, bone overrides, and animation constraints.
- **Performance:** compile/index tracks, resolve stable target references once per asset revision, virtualize track UI, and avoid full-document cloning or renderer remounts per frame.
- **API drift:** keep one registry and evaluator across UI/MCP/export so new properties cannot acquire divergent semantics.
- **Structural keyframes:** not every writable setting is safely animatable. Document unsupported structural changes instead of accepting keys that cannot be evaluated correctly.

Before implementation, choose exact defaults for override weights, Talk interruption, return transitions, migration idle-gap placement, and arrangement time mapping. These choices must be visible configuration or documented contracts, not hidden heuristics.
