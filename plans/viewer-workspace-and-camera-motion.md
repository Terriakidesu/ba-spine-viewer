# Viewer Workspace and Editor Camera Motion Plan

## Purpose

Plan the Viewer layout, asset preparation, and Editor camera-authoring improvements raised from the packaged Viewer screenshots. This plan supplements, and does not replace or rewrite, `plans/standalone-suite.md` or `plans/portable-distribution-and-ui-sync.md`.

The work has two feature areas:

1. Make Viewer a window-fitted workspace with selectable output aspect ratios and preloaded character interactions.
2. Add authored camera motion and editable safe bounds to Editor, then use the same camera rules when Viewer previews an authored sequence.

## Confirmed behavior

- Viewer should behave like an editor workspace: the document itself must not scroll at supported window sizes. Content that can exceed its panel—such as the character list or options—may scroll internally.
- Viewer supports **16:9** and **4:3** output frames, with 16:9 as the default. Legacy 1:1 preferences and camera tracks display as 16:9 without rewriting persisted data on load. Fit the selected frame into the available area without stretching; letterbox as necessary.
- Selecting a character should start preparation of the resources needed to use that character. In particular, pressing Talk after selection should not replace the scene with a loading screen.
- Editor should visualize the authored camera during playback and scrubbing, with a red camera-frame rectangle and/or center gizmo.
- Safe bounds constrain the **entire camera frame**, not only its center. If the requested view is too large, zoom in until the whole frame fits; clamp its center to the rectangle; preserve the selected aspect ratio.
- Support both **automatic** bound selection and **manual** named-bound assignment. Keep an explicit unconstrained option for creative shots.

## Repository boundaries

- Keep Viewer browsing, playback, theme preferences, handoff, and read-only behavior intact.
- Keep Editor authoring and save behavior in `packages/editor-feature`; keep reusable camera math and runtime application in `packages/spine-runtime` or another shared runtime module.
- Keep app-specific layout in `packages/viewer-feature`. Scope Viewer styles so they do not affect the Editor or unrelated Viewer routes/tools.
- Viewer stays read-only. Aspect-ratio preferences and preload caches must never be written into the selected asset library.
- Use disposable projects and Spine fixtures for tests and manual verification. Never run write-oriented tests against repository `data/`.
- Preserve existing unrelated working-tree changes. Stage only files belonging to this feature if implementation is later requested.

## Existing architecture and observed causes

### Viewer

- `packages/viewer-feature/src/Spine.tsx` composes the Viewer page, character selection, Spine renderer, voice catalog, interaction controls, and loading states.
- `packages/viewer-feature/src/styles.css` currently gives `.spine-page` natural document height, starts `.spine-layout` with top alignment, and gives `.spine-stage` a fixed 16:9 aspect ratio. Controls follow the stage in normal flow. At the reported window size this lets the whole page grow taller than the viewport, producing the visible page scrollbar and moving controls below the fold.
- The character list already has its own scroll area, and fullscreen already uses a fixed viewport layout. The windowed layout should adopt the useful fixed-workspace behavior without removing those existing browsing and fullscreen workflows.
- The shared `isLoading` calculation includes folder/set/renderer work and voice/composition audio work. Voice assets are cached through `cachedVoiceAudio`, while some audio preloading is started after selection. This is a likely source of an interaction-time loading overlay; implementation should instrument and verify the exact Talk path rather than assume one cause.
- Character and variant selection already provide natural lifecycle boundaries for loading, cancellation, and cache invalidation. Viewer handoff and library refresh also preserve playback state and must continue to do so.

### Editor and Spine runtime

- `packages/editor-feature/src/stageView.ts` and the `stageView` state in `TimelineWorkspace.tsx` represent Editor-canvas pan and zoom. They are workspace navigation, not authored camera motion, and must remain independent from the camera being authored.
- `EditorTimeline` currently has animation, color, subtitle, and audio data but no camera track. The current Editor project schema is version 4.
- `packages/spine-runtime/src/spine/spineCamera.ts` contains scene-bound discovery and `fitScene`; `SpineRuntime` applies the existing fit/fill/game camera modes and exposes camera poses.
- Editor timeline preview renders multiple Spine and color layers as one visual composition. Any authored camera transform must remain aligned across that composition rather than independently drifting each layer. UI elements such as dialogue, subtitles, and controls remain screen-space overlays unless explicitly designed otherwise.

## Viewer workspace design

### Window-fitted layout

1. Recompose the Viewer page as a viewport-height workspace: a compact header and asset-source/status area above a flexible workspace row, with `min-height: 0` at each flexible grid/flex boundary.
2. Let the stage and primary controls share the remaining height. Keep the selected character, output frame, and essential playback/interaction controls reachable without document scrolling.
3. Keep vertical overflow local to the character/navigation list and expanded options/settings. On narrow or short windows, collapse secondary controls or use a compact arrangement rather than allowing the page to grow.
4. Keep the connected library’s folder-change action available while reclaiming vertical space from redundant header copy and padding. Preserve help, handoff, refresh, status, and draft-preview affordances.
5. Scope overflow and viewport sizing to the Viewer workspace; do not globally disable scrolling for other app content. Keep keyboard focus, focus-visible styles, dialogs, responsive behavior, reduced-motion support, and light/system/dark preferences.
6. Preserve the existing fullscreen and clean-presentation modes. The selected aspect ratio should also remain meaningful in fullscreen, with letterboxing rather than stretching.

### Aspect-ratio selection

- Keep a compact, accessible selector with stable values for `16:9` and `4:3`; default to `16:9`.
- Treat the value as the actual rendered camera viewport ratio, not only a CSS decoration. Resize the stage/canvas consistently so the Spine renderer receives the intended output dimensions.
- Center the output frame within the available stage area and show background/letterboxing around it where the window shape differs. Never distort the skeleton or authored scene.
- Keep the chosen Viewer ratio across character and variant changes, library refresh, and same-session handoff reloads. Persist it as a versioned Viewer preference (or within the existing Viewer preference layer), not in library/project data. Invalid or unavailable stored values fall back to 16:9.
- Reuse a shared ratio type/helper for Editor camera framing. Editor sequences may define an authored ratio; Viewer’s selector is an explicit preview override and does not rewrite the project.

## Viewer preloading design

### Readiness contract

For the selected character and active variant, prepare all locally available resources required for the selected experience before enabling Talk and other interaction controls:

- Read and validate the active Spine files, atlas, textures, skeleton, and any selected interaction/composition project.
- Read the selected character’s voice metadata and prepare its available voice clips across the supported language/fallback choices, so changing language or selecting a Talk does not initiate a blocking load.
- Prepare any additional animation or sequence data needed by the active interaction mode.
- Do not eagerly instantiate renderers/WebGL contexts for every character in the library. Active-variant rendering has priority; other variants of the selected character may receive lower-priority byte/metadata prefetch only if profiling shows it is safe and the cache stays within its budget.

“Preload everything” is scoped to the selected character/variant and its available interactions—not the entire library. Missing optional audio must resolve to a clear unavailable state rather than leaving readiness pending forever.

### Lifecycle and memory

- Start preparation when character/variant selection changes, and key cached results by library identity/revision plus asset path.
- Use a monotonically increasing selection generation (and abort signals where the source supports them) so stale work cannot update the newly selected character. Release object URLs, audio elements, renderer resources, and cache entries when no longer retained.
- Bound concurrent file/audio work and cache size. Measure real fixture sizes before choosing limits. Retain the active selection and any audio currently playing; evict older inactive entries with a deterministic policy.
- Invalidate or refresh affected entries after library refresh, source change, draft replacement, or handoff to another library. Preserve playback and camera state for unaffected refreshes.
- Keep one active Spine renderer/context. Preloading an alternate variant must not create an unbounded number of WebGL contexts.

### Loading and interaction UX

- Separate **blocking stage readiness** (initial library/set/renderer load) from **background preparation** (voice clips and future interaction resources).
- A blocking stage overlay may be used while a newly selected character’s primary renderer is not ready. Once the scene is visible, background audio preparation uses a small non-blocking status/progress indicator and never covers the character.
- Do not count voice-only background work as `isLoading` for the full-stage overlay. Do not show that overlay when Talk starts.
- Talk controls are enabled only when the active interaction path is ready. While preparation is incomplete, show a localized “Preparing” state and keep the scene visible; do not accept an action that can unexpectedly replace it with a blocking screen.
- Preserve useful errors and retry actions for missing/invalid required Spine files. Voice-file failures should be reported locally and should not prevent other interactions or playback.

## Editor camera authoring design

### Sequence camera data

Add an optional camera-motion block to each `EditorTimeline`/sequence so its camera data and named bounds travel with the sequence file in both legacy-project and manifest-backed layouts. Sequences without this block retain today’s behavior.

Proposed normalized model (exact names can follow local conventions during implementation):

```ts
type CameraAspectRatio = "16:9" | "4:3";
type CameraConstraint =
  | { mode: "automatic" }
  | { mode: "manual"; boundId: string }
  | { mode: "none" };

interface CameraSafeBound {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  priority?: number;
}

interface CameraKeyframe {
  id: string;
  time: number;
  centerX: number;
  centerY: number;
  frameHeight: number;
  easing?: "linear" | "smooth" | "hold";
  constraint?: CameraConstraint;
}
```

- Bounds use the same scene/world coordinate system as camera poses and are positive finite rectangles. `frameHeight` is the world-space height visible by the camera; frame width is derived from the selected aspect ratio. This makes aspect preservation explicit and avoids independently interpolating width and height.
- The sequence camera block contains the selected output ratio, named safe bounds, a default constraint mode, and ordered camera keyframes. A keyframe’s optional constraint overrides the default from that keyframe onward, allowing different creative choices within one sequence. If this override is too costly for the first slice, ship sequence-level modes first and keep the format extensible.
- New data is optional for backwards compatibility. Bump the Editor project schema only when required by the established migration rules; normalize older v4 data to “no authored camera” without modifying files on load. Explicit save writes the current schema through existing project-save paths.
- Extend Editor and runtime normalizers, sequence serialization, saved preview, and read-only draft preview to preserve and validate camera data. Do not grant Viewer additional write capability.

### Camera motion and viewport gizmos

- Add a Camera track/lane to the sequence timeline. Support adding a keyframe at the playhead, selecting/navigating/removing keyframes, editing center and frame height/zoom, and choosing interpolation/easing. Preserve existing timeline transport, selection, undo/redo, copy/paste, and save semantics.
- Interpolate camera center and frame height from neighboring keyframes at the current playhead. Evaluate continuously during playback and seek/scrub; constrain the evaluated pose after interpolation, not only at keyframe boundaries.
- Add a preview toggle that draws a high-contrast red viewport rectangle and center gizmo over the visual composition. Update it live during playback and scrubbing. Keep it visually distinct from the Editor’s pan/zoom navigation and existing interaction/bone overlays.
- Render enabled safe bounds faintly and highlight the active bound. Provide accessible controls for creating, renaming, enabling, resizing, reordering/prioritizing, and deleting bounds. Support numeric rectangle editing as an alternative to dragging; dragging must convert through the existing scene/stage coordinate transforms.
- Warn before deleting a bound referenced by a manual camera constraint. Prevent zero/negative dimensions, non-finite values, duplicate IDs, invalid times, and unresolved bound references.
- The red frame/gizmo is the required first visualization. A separate cropped camera-output preview can be considered later; it must not replace or interfere with the full Editor composition view.

## Safe-bound selection and solve rules

Centralize all selection and pose-solving in pure shared helpers, independent of React, canvas, and Spine runtime state.

1. Evaluate the desired camera pose and its frame dimensions using the active viewport ratio.
2. **Manual mode:** use the explicitly assigned enabled bound. If the ID is missing or disabled, fall back safely to automatic selection and emit a validation diagnostic; never crash or silently serialize a dangling reference.
3. **Automatic mode:** retain the current active bound while the requested camera center remains inside it (hysteresis). Otherwise, choose among bounds containing the requested center by explicit priority and then stable order. If none contains the center, choose the nearest enabled bound by center-to-rectangle distance, with deterministic tie-breaking.
4. **None mode:** do not constrain the pose.
5. For a selected bound with width `W`, height `H`, and ratio `r`, compute the largest frame height that fits as `min(H, W / r)`. If the requested frame is larger, reduce its world-space height to this limit (zoom in); derive width as `height * r`.
6. Clamp the camera center to `[left + frameWidth/2, right - frameWidth/2]` and `[bottom + frameHeight/2, top - frameHeight/2]`, ensuring the complete camera frame stays inside the rectangle.
7. Return the solved pose, selected bound ID, and any diagnostic (no bounds, invalid manual bound, or clamped pose) so Editor can visualize and explain the result.

Automatic selection should not flicker between overlapping bounds. Authored constraint changes at keyframes are intentional and may switch at the keyframe boundary. If no enabled bounds exist, automatic mode behaves as unconstrained and reports a non-blocking authoring diagnostic.

## Viewer and runtime camera integration

- Reuse the camera interpolation and safe-bound solver from Editor preview in Viewer. Do not implement a second subtly different bounds algorithm.
- When an authored camera track exists and is enabled, offer an **Authored** camera mode and use it for that sequence by default. Retain current Fit/Fill/Game modes as explicit Viewer overrides; sequences without a track retain current defaults.
- Keep camera transforms consistent across all Spine/color layers in a composition. Apply one shared composition camera transform/pose rather than independently panning each layer. Keep subtitles, dialogue, interaction UI, and controls in screen space.
- Drive the camera from the same sequence clock as animation and audio, including pause, speed, loop, seek, handoff, and scrubbing. Resize and aspect-ratio changes must recompute the viewport without changing the authored world-space center or corrupting the track.
- Preserve camera mode/pose across same-selection library refresh and supported handoff reloads. Any new mode state must be normalized and tested against older stored handoff state.
- If the user selects a Viewer ratio different from the authored sequence ratio, recompute the frame and safe-bound solution using the Viewer’s selected ratio. Do not stretch the composition or rewrite the authored sequence.

## Implementation phases and gates

| Phase | Work | Exit gate |
|---|---|---|
| 0. Baseline and instrumentation | Reproduce page scrolling and Talk-time loading with disposable fixtures. Record which state transition turns on the blocking overlay, active-character resource counts, and memory/cache behavior. | Cause is confirmed; a repeatable baseline exists without touching repository `data/`. |
| 1. Viewer workspace | Rework the Viewer’s windowed page into a viewport-fitted shell; retain local scrolling for long panels and all existing controls. | No document-level vertical or horizontal scroll at supported minimum and common desktop viewports; keyboard and compact layouts remain usable. |
| 2. Aspect ratios | Support shared 16:9/4:3 values, stage sizing, canvas resizing, preference persistence, and fullscreen letterboxing; keep a non-destructive 16:9 fallback for legacy 1:1 data. | Both supported ratios render without distortion; legacy data stays unchanged on load; explicit selection/save updates it. |
| 3. Character preload lifecycle | Add selection-scoped preparation, stale-work cancellation, non-blocking progress, interaction readiness, bounded audio/resource caches, and cleanup. | After a character is ready, Talk and other supported interactions do not trigger a full-stage loading overlay; switching rapidly cannot display stale content or leak resources. |
| 4. Camera model and migration | Add pure keyframe interpolation, ratio-aware pose types, safe-bound selection/solve helpers, project normalization, and persistence tests. | Legacy 1:1 camera data falls back in memory to 16:9 without implicit writes; new camera data round-trips through legacy and manifest-backed saves and read-only preview. |
| 5. Editor authoring and gizmo | Add Camera timeline controls, safe-bound editing, active-bound display, validation diagnostics, and red frame/center overlay. | Scrub/play/seek updates the gizmo deterministically; pan/zoom navigation remains independent; invalid data is explained and cannot corrupt a save. |
| 6. Shared runtime playback | Apply authored camera poses to single Spine scenes and layered compositions; expose authored/override modes in Viewer and preserve existing camera modes. | Editor and Viewer show the same evaluated frame/bound for the same sequence, time, and ratio; old projects continue using old camera behavior. |
| 7. Packaged verification | Run automated checks and packaged smoke testing with disposable assets; update documentation and portable artifacts only when requested. | Typecheck, tests, build/audits, aspect/layout/load smoke checks, camera constraint checks, and data-safety audit pass. |

## Automated validation

### Viewer

- Layout tests at the native minimum and representative viewport sizes: no document overflow, no clipped primary controls, and expected internal scroll ownership for character/options panels. Include a short/tall and narrow/wide viewport, sidebar shown/hidden, options expanded, status banners, and fullscreen.
- Verify selected ratio dimensions for 16:9 and 4:3 in windowed and fullscreen modes; canvas backing dimensions and CSS frame dimensions agree within rounding tolerance. Verify legacy 1:1 preferences are not rewritten on read.
- Verify ratio preference defaults, invalid-value fallback, persistence, and preservation through character/variant selection, refresh, and same-session handoff.
- Test preload state transitions: active selection, all required resources ready, missing optional audio, required-file errors, cancellation, rapid character/variant switching, library identity change, refresh invalidation, and cache eviction.
- Assert that pending voice-only work never activates the blocking stage overlay and that Talk is not enabled before its playback path is ready. Test the Talk path for interaction and composition-backed sequences.
- Verify audio elements/object URLs and renderer resources are released on selection/library changes and component teardown; ensure cache limits hold under repeated switching.

### Editor and camera runtime

- Test interpolation endpoints, ordering, duplicate/non-finite/out-of-range keyframes, easing, playhead seeking, loop boundaries, and ratio-derived frame dimensions.
- Test safe-bound math for 16:9 and 4:3 frames using shared world-space bounds; overlapping, disabled, missing, and offstage bounds; oversized requested frames; center clamping at every edge; automatic selection stability/ties/fallback; manual assignment; unconstrained mode; and invalid manual references.
- Verify the entire calculated camera frame is inside its selected safe rectangle and retains its ratio after every solve.
- Test schema migration from existing v4 projects, no-camera defaults, current-schema round-trip, sequence save/load, manifest-backed save/load, draft preview, saved preview, and missing bound diagnostics.
- Verify Editor pan/zoom changes only workspace navigation, while camera-track edits/playback change the camera gizmo and output preview. Ensure camera frame stays correctly registered when stage size and device scale change.
- Integration-test runtime camera state across pause/resume, speed, loop, seek, scrub, resize, Fit/Fill/Game override, authored mode, handoff restoration, and mixed Spine/color compositions.

### Manual packaged smoke test

Use a small valid disposable Spine export and disposable Editor project; do not use the repository library.

1. At the supported minimum window size and a normal desktop size, verify Viewer has no page scrollbar and the stage, character navigation, and essential controls remain usable.
2. Select 16:9 and 4:3; verify the output is undistorted and letterboxed as needed. Verify a legacy 1:1 preference is shown as 16:9 and remains unchanged until a ratio is selected. Hide/show the sidebar and expand options without losing access to the stage or primary controls.
3. Select a character, wait for its ready state, then exercise Talk, autoplay, interaction modes, language choice, and repeated selection. Confirm Talk does not cover the running scene with a loading screen.
4. Rapidly switch character and variant while files/audio are preparing; confirm the visible character, readiness state, dialogue, and active audio all belong to the latest selection.
5. In Editor, add and move camera keyframes while paused, scrubbing, and playing. Confirm the red camera frame/center gizmo tracks the playhead.
6. Create overlapping and non-overlapping shared safe bounds. Exercise Automatic, Manual, and None modes; verify manual assignment, automatic stability/fallback, zoom-in when the frame is too large, and full-frame edge clamping at both supported ratios.
7. Save, close, and reopen a disposable project; verify camera tracks and bounds persist. Preview the saved/draft sequence in Viewer and compare the active frame to Editor.
8. Confirm Viewer did not write to the asset library and that app preferences/cache remain outside it.

Do not launch packaged applications solely to validate a build without user authorization. Automated packaging/audits should not launch Viewer or Editor.

## Safety and compatibility requirements

- All project camera data must pass the existing normalizer and schema/version checks. Validate IDs, numeric finiteness, positive rectangle/frame sizes, timeline times, aspect values, easing values, and manual-bound references.
- A bad camera block must produce a useful diagnostic and a safe legacy/automatic fallback; it must not prevent unrelated authored content from loading or saving.
- Existing projects with no camera block retain current framing. Loading old data must not write or migrate files implicitly.
- Viewer camera tracks remain read-only. Viewer aspect preferences and caches are user/app state, not project/library state.
- Do not alter original Spine skeleton, atlas, texture, audio, or authored source files. Editor writes only supported project/sequence/workspace files through existing save safeguards.
- Keep all test fixtures disposable and outside repository `data/`; preserve user-authored working-tree changes and never stage unrelated profiling work.

## Completion criteria

- Viewer’s supported windowed workspace does not require document scrolling; internal panels handle their own overflow.
- Viewer can select 16:9 and 4:3 without distortion, and the selection survives expected reload/selection workflows. Legacy 1:1 data falls back visibly to 16:9 and remains unmodified until explicit save/selection.
- Selecting a character prepares its active variant and interaction/talk resources; Talk no longer causes a blocking loading screen after readiness.
- Editor can author camera motion and preview the camera frame/center during playback and scrubbing without confusing it with stage pan/zoom.
- Multiple named shared world-space safe bounds support automatic and manual selection plus unconstrained shots. The complete camera frame remains inside the active bound at both supported ratios. Per-ratio overrides stay deferred until a concrete scene demonstrates they are needed.
- Viewer uses the same authored camera evaluation when previewing a camera-enabled sequence, while current modes and projects without camera tracks continue to work.
- Typecheck, tests, builds, release audits, and disposable packaged smoke checks pass without reading or writing repository `data/`.
