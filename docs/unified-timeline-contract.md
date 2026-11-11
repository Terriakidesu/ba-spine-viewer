# Unified timeline contracts

This document records the shared schema/evaluator contracts and the current integration boundary. The Editor can explicitly migrate a caller-supplied legacy schedule into an unsaved composition draft, preview it in Timeline and Camera, and author Camera data against its composition track. The Viewer can select and preview the canonical composition and export its authored range. Legacy timeline editing and legacy Opening/Talk arrangement export remain supported. These integrations are not a claim of full first-release parity: composition authoring/section routing and rendering parity fixtures remain incomplete.

## Schema and clocks

- `SpineComposition.schemaVersion` is version 1. Authored time is seconds; export code should derive sample time from integer frame indices rather than repeatedly add frame deltas.
- Composition, transport, and section-instance clocks are separate. Animation clip activation uses `clock`; its source sampling independently uses `sourceClock` (`clip-source`, composition, transport, or a section instance). Animation-name binding and transform parenting are separate layer fields and do not copy time, speed, or loop state.
- Sections are half-open `[start, end)` ranges. A composition explicitly chooses whether its endpoint is included. Property keys at the final authored time remain sampleable; discrete selection changes are stepped.
- Same-time property keys resolve to the lexicographically greatest stable key ID. Stable track evaluation order is ascending priority, then typed target/property key, then track ID. Higher priorities therefore apply later.
- Before/after-key behavior is explicit on each property track. With `holdBefore`/`holdAfter` false, an absent track value does not contribute; with them true, the nearest key is held. A track's `baseValue` is the value before its first key and when a track has no keys.

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
- Talk owns body, face, audio, subtitles, camera, effects, and skeletal overrides; persistent scene/background tracks are not owned by the Talk.

The legacy full-sequence arrangement helper uses the existing Viewer defaults: include Opening when available, one initial idle loop, `0.5s` between Talks, and one final idle loop (at least one second). Persistent backgrounds use continuous output phase by default. `migrateLegacyTimelinesToComposition` does not infer these settings: callers pass the resulting schedule explicitly, and the schedule plus assumptions are included in the report.

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

The v1 stateful policy is reset plus fixed-step preroll at `1/60s`, capped at 36,000 steps (10 minutes). `runFixedStepPreroll` evaluates the initial pose at zero, advances exact integer step times, and performs one deterministic residual step for an off-grid sample. The Editor and Viewer composition renderers call this helper when a loaded skeleton has physics constraints; each callback resamples animation and overrides, with Spine's `Physics.reset` used at the initial sample and `Physics.update` for subsequent steps. Seek/playback parity still requires asset-fixture verification and is not claimed here.

## Migration guarantees and limits

- Migration is an explicit Editor/MCP operation with a caller-supplied schedule and time-mapping policy. It never saves, edits, or rewrites the legacy project or Spine library; the resulting composition is an undoable in-memory edit until the ordinary explicit save operation.
- The caller supplies the exact arrangement ranges and source offsets. Migration preserves source sequence JSON in `migrationMetadata`, emits assumptions/diagnostics, and creates stable layer IDs only when legacy ID, role, asset directory, and duplicate ordinal match.
- Layer transforms, animation clips, audio, subtitles, color clips, and camera keyframes are placed at explicit output offsets. Legacy follower state becomes separate transform-parent and animation-name binding fields.
- If animation duration metadata is unavailable, the migration uses the authored clip span only as a provisional source range and reports it. Non-direct Opening modes, continuation/character-hide behavior, unresolved idle underlays, and path-derived asset identity are surfaced for review.
- The Editor project model and private/manifest persistence retain supported v1 composition documents; Viewer project normalization retains them for preview and authored-range export. Newer or malformed composition schemas are refused instead of silently stripped. The MCP migration operation returns its report, and whole-project validation includes composition diagnostics.
- Unified export samples exact integer frame times from the canonical composition duration. Desktop FFmpeg audio uses authored clip placement, source offsets, and base volume; per-key audio gain automation is not yet represented in the FFmpeg mix schedule. Subtitle spans are clipped to the authored composition range.
- Remaining plan work includes a composition-native authoring/dope-sheet UI and typed MCP editing for composition sections/tracks/keys, interactive Viewer Talk routing against section IDs, audio-gain automation in export, migration review UI, and parity/performance fixtures. Legacy timeline editing and playback have not been removed.
