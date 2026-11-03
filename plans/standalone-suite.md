# Standalone BA Spine Viewer + Editor — implementation plan

## Goal and boundaries

Build two independent Electrobun desktop applications in this workspace:

- **BA Spine Viewer** — browse and play Blue Archive Spine lobby assets.
- **BA Spine Editor** — author interactions, compositions, timelines, audio, and subtitles.

The applications share implementation packages and project formats. A shared fix propagates to both when rebuilt; neither app launches the other as its UI.

This is a standalone project. `shittim-chest` is only a one-time source reference for extracting the existing viewer/editor code. Do not add runtime imports, symlinks, build dependencies, or ongoing synchronization with that workspace, and do not modify it. The Spine library at `data/` is local user data, not source code or a distributable asset bundle.

## Current local asset library

The library copied from `D:\Misc\ba-spine` is in `./data/`. It contains approximately 6,969 files / 3.37 GB, including:

```text
data/
├── .editor/                 # Existing editor projects/workspace state
├── .editorignore            # Excludes sprites/ from asset discovery
├── audios/
├── catalog.json
├── characters.json
├── lobbies/
│   └── <lobby>/             # manifest.json, spine/, sequences/, project data
└── sprites/                 # Retained on disk; ignored by the library catalog
```

The existing catalog and lobby manifests are the source of truth for asset and project paths. Preserve their relative paths and schema. Honor `.editorignore`. Do not migrate, normalize, or write to the real library as part of app startup or automated tests.

`/data/` is rooted in `.gitignore`. It must remain untracked and excluded from application build/package inputs. Do not force-add it. Test persistence and migration against small synthetic fixtures or a disposable copy, never against `./data/`.

For local development, the apps may offer `./data/` as the default library when it exists. Packaged builds must not assume the library is beside the executable: prompt for a library, remember its selected path in app settings, and support relocation. Keep the path configurable; do not bake this machine-specific location into code.

## Target codebase

```text
apps/
├── viewer/
│   ├── src/main/             # Electrobun startup, menus, window lifecycle
│   └── src/renderer/         # Viewer composition and app-specific UI
└── editor/
    ├── src/main/
    └── src/renderer/         # Editor composition and app-specific UI
packages/
├── spine-core/               # Schemas, validation, project models, timeline rules
├── spine-runtime/            # Spine renderer, playback, camera, effects, audio
├── spine-ui/                 # Shared viewport, composition, subtitles, controls
├── asset-library/            # Catalog, manifest, character/variant lookup
├── viewer-feature/           # Viewer browsing and presentation behavior
├── editor-feature/           # Feature-oriented editor modules
├── platform-contracts/       # Typed filesystem/settings/companion interfaces
├── desktop-client/           # Renderer-side implementations of those interfaces
├── desktop-host/             # Native filesystem, dialogs, IPC, watchers
├── wasm-kernels/             # Optional Rust→WASM CPU kernels and worker adapters
└── app-ui/                   # Shared primitives, theme, icons, localization
scripts/
tests/
├── fixtures/                 # Small, synthetic Spine/project fixtures
└── integration/              # Cross-package and packaged-app workflow tests
plans/
data/                         # Local library; gitignored and never packaged
```

### Dependency rules

- `spine-core` is pure domain code: no React, DOM, filesystem, or Electrobun.
- `spine-runtime` owns Spine rendering/playback, not editor state.
- `spine-ui` is shared by both apps; its subtitle rendering matches in both.
- Features depend on platform contracts, not on native host implementations.
- Native filesystem access is confined to `desktop-host`; inject it through typed capabilities.
- Viewer and editor do not import each other. App entrypoints are thin composition roots.
- Use explicit package exports; do not use deep relative imports across package boundaries.
- Keep Spine runtime package versions pinned and synchronized during the initial extraction.
- Keep Spine rendering on the existing WebGL runtime; use WebAssembly only for measured CPU-bound batch work, not as a replacement renderer.
- Run WASM workloads in workers with a typed JavaScript fallback; transfer batches/buffers rather than making per-item JS↔WASM calls.
- Keep tests next to the module they exercise; reserve `tests/integration/` for true app/package boundaries.

Editor feature modules should be grouped by responsibility, not left as an expanding flat directory:

```text
editor-feature/src/
├── workspace/  assets/       interactions/  bones/
├── timeline/   subtitles/    audio/         inspector/
├── commands/   persistence/  diagnostics/
```

### WebAssembly optimization strategy

Use WASM deliberately, behind stable TypeScript interfaces, and only where profiling shows CPU time—not filesystem I/O, Spine rendering, or image/audio decoding—is a material bottleneck. The first candidate is **batch waveform-envelope generation** from already-decoded PCM if/when the editor adds waveform displays. Bulk metadata/project normalization is a secondary candidate only if profiling the real library shows meaningful CPU cost. Do not move directory traversal, filesystem access, WebGL rendering, or native media decoding into WASM.

- Establish JavaScript baselines first with representative synthetic fixtures and read-only profiling of `data/`; separate disk time, decode time, UI work, and pure computation.
- Put Rust source and worker glue in `packages/wasm-kernels/`. Build for `wasm32-unknown-unknown`, bind the small public API with `wasm-bindgen`, and optimize release artifacts. Keep generated `.wasm` output out of Git; package it as a lazy-loaded app resource.
- Run compute in a bounded Web Worker pool so large jobs never block input/animation. Pass validated, transferable typed-array batches; keep filesystem paths and native capabilities entirely in TypeScript host code.
- Keep a tested JS implementation as the correctness oracle and compatibility fallback. WASM and JS results must match on golden fixtures, malformed inputs, boundary sizes, and cancellation.
- Enable a kernel by default only when repeatable benchmarks show at least 20% lower kernel CPU time and either a measurable end-to-end win (target ≥5% for the user-visible operation) or removal of a main-thread task exceeding one frame. Otherwise keep it opt-in or defer it.
- Load kernels on demand, version cache keys with the kernel/API version and input identity, and store derived data outside `data/`. Avoid copying the same large buffer repeatedly between JS and WASM.
- Do not make Rust a prerequisite for ordinary app development or runtime use. Rust/WASM toolchains are needed only to rebuild kernels; checked-in source plus a reproducible build script produces the packaged artifact.

#### JavaScript baseline (2026-11-03)

`bun run profile:wasm-candidates` measures the production PCM-envelope helper over synthetic decoded mono PCM at 48 kHz (Bun 1.4.2, Windows x64, Intel i3-1115G4). It deliberately excludes file I/O, audio decoding, and UI rendering:

| Workload | Median JS kernel time | p95 |
| --- | ---: | ---: |
| One 5-second clip, 160 peaks | 0.571 ms | 0.751 ms |
| One 10-second clip, 160 peaks | 1.252 ms | 1.552 ms |
| One 30-second clip, 160 peaks | 3.723 ms | 4.583 ms |
| Synthetic batch of 32 five-second clips | 19.591 ms | 21.240 ms |

Keep WASM deferred: individual clips stay well below a 16.67 ms frame, and the only over-frame result is a deliberately synchronous 32-clip aggregate, not yet observed as one production UI task. Profile actual timeline interaction and decode scheduling before considering worker/WASM batching; any candidate must still beat the JS kernel by the documented gate and demonstrate an end-to-end win.

## Shared app and data contracts

### Project and library compatibility

- Read the current `catalog.json` / `characters.json` and manifest-based lobby layout directly.
- Preserve existing sequence, interaction, subtitle, and workspace formats on initial release.
- Support legacy editor projects through explicit, tested read/migration paths; never silently rewrite them.
- Keep authored project data beside its existing manifest-defined assets. Keep app settings, indexes, caches, and recovery snapshots under OS app-data paths.
- Preserve asset-relative references so moving the library does not invalidate projects.
- Version future shared protocols and project schemas; reject or explain unsupported versions rather than corrupting data.

### Read/write capabilities

- Viewer gets read-only library access. Its settings and caches live outside the library.
- Editor gets scoped write access only for supported authored project files and established editor workspace state.
- Keep original `.skel`, `.atlas`, texture, and audio files untouched.
- Confine resolved paths to the selected library, including symlink/junction handling; reject traversal.
- No network requests, uploads, telemetry, or LAN-exposed local services.

### Companion workflow contract

Define a versioned local handoff message with at least: request ID, target app, library identity/path, lobby ID, sequence ID, optional language/playhead, and optional draft session ID. Validate every message. Prefer a supported local IPC/URL handoff; if a loopback transport is needed, bind to loopback only and require an unpredictable per-session token. Expose the transport behind `platform-contracts` so it can change without feature rewrites.

## Viewer/editor quality-of-life features

### Shared library and navigation

- Search character, variant, lobby ID, and asset ID; keyboard navigation; favorites and recent lobbies.
- Remember last library, selected lobby/sequence, viewer language, and window state.
- Provide clear loading, retry, missing-resource, and invalid-manifest states with relative paths.
- Generate thumbnails asynchronously into an external cache; invalidate only affected entries.
- Debounce file watching, cancel stale loads, and provide a manual refresh fallback.

#### Desktop library refresh slice (2026-11-03)

The Viewer host watches the selected library recursively, coalesces filesystem events over a 300 ms quiet period, ignores `.editorignore`-excluded paths, and reports a revision through its authenticated loopback API. The Viewer polls for changes and shows a non-disruptive "Changes available" status; **Refresh library** remains available if watching is unsupported. Refresh rebuilds the catalog and preserves the selected lobby and still-valid playback, sequence, playhead, camera, language, volume, and playback settings. Primary and composition asset requests are aborted when their load becomes stale. Fake-timer tests cover debounce/cancel behavior; authenticated bridge tests cover change status, refresh, and request cancellation. Manual two-app GUI smoke testing remains a release gate.

#### Timeline diagnostics slice (2026-11-04)

The Editor timeline inspector validates the active sequence without writing files: layer availability and manifest-declared file references, loaded animation names, unsupported manifest versions, clip and sequence bounds, subtitle overlaps and preview-language gaps, missing audio, and stale explicit subtitle links. Each issue navigates to its affected timeline item. Manifest reference checks reuse the already-loaded file set rather than rereading asset bytes; fixes remain explicit authoring actions. Future project schema versions remain rejected with a clear load error.

#### Timeline selection QoL slice (2026-11-04)

The timeline **Fit selection** control calculates a viewport-aware zoom and horizontal scroll for the selected items, preserving the authored timeline and the existing whole-sequence fit action. Unit tests cover padding, zoom limits, and unusable ranges.

The Editor transport also plays the combined selected range once or loops within its start/end; pause/resume retains the loop, while a new selection or seek clears it. Range-clock tests cover start positioning, wraparound, speed, and invalid bounds.

Ctrl/Cmd+C copies selected animation, color, subtitle, and audio clips to an in-memory sequence-local clipboard; Ctrl/Cmd+V pastes at the playhead with relative offsets, link remapping, locked-track skips, and color-track collision handling. It does not use the OS clipboard or write library files until the user saves.

### Editor-to-viewer handoff

- **Open in Viewer** focuses or starts the viewer and opens the selected lobby/sequence.
- Offer **Preview saved files** and **Preview unsaved draft** explicitly.
- Draft preview is read-only, visibly marked as unsaved, debounced, and never written to the library. It has a clear return-to-saved action and ends safely when the editor disconnects.
- Viewer preserves language, camera, volume, and play state when reloading. It does not restart the opening unless asked.
- Viewer can turn automatic refresh off and show “Changes available” instead.

### Viewer-to-editor handoff

- **Edit this lobby** opens/focuses the editor with the same library, lobby, sequence, and optional playback context.
- Never replace an editor project with unsaved changes without confirmation.
- Reuse an existing editor instance where safe; prevent accidental duplicate edits to the same project.
- If the companion app is missing or the library cannot be resolved, show a useful selection/recovery action.

### Viewer experience

- Playback controls: play/pause, restart, speed, loop, sequence selection, intro replay, and frame/time stepping where feasible.
- Subtitle language and fallback, voice volume/mute, camera fit/reset, fullscreen, and hide-UI presentation mode.
- Optional developer overlay for active tracks and interaction regions.
- Clear missing-file details, cancellable loading, and proper audio/WebGL resource cleanup on switch/minimize.
- Optional screenshot export; keep it out of the first parity milestone if it risks delaying reliable playback.

### Editor experience and safety

- Preserve current editor functionality before adding new authoring features.
- Dirty/saved/error states, reliable undo/redo, close/switch confirmation, and crash-recovery snapshots.
- Detect external edits and concurrent editor saves; present a conflict decision instead of silently overwriting.
- Save linked files with staging/atomic replacement where supported; validate all outputs before writing and report partial multi-file failures honestly.
- Recovery autosaves are separate snapshots, not silent canonical-project overwrites. Add bounded backups and an explicit restore prompt.
- Timeline QoL: range loop/play selection, snapping controls/feedback, exact time fields, duplicate/copy/paste, multi-select, track lock/mute/visibility, zoom-to-selection, and fit timeline.
- Subtitle/audio QoL: language-aware search, jump-to-cue, viewer-matched subtitle preview, missing-translation visibility, overlap/duplicate checks, linked-file preview, and waveform as a later enhancement.
- Workspace QoL: command palette, searchable animation/bone pickers, panel presets, shortcut help, focus-safe shortcuts, and DPI/monitor-safe window restoration.
- Validation panel: broken manifest references, missing files/audio, invalid timeline ranges, unknown animations, missing bones, subtitle bounds, and unsupported versions. Repairs require confirmation and should be undoable.

## Commit-oriented implementation sequence

Keep commits small, reviewable, and buildable. Each commit should include its focused tests and documentation for any changed behavior. Do not combine a broad file move with unrelated UX work. The local `data/` library must never appear in a commit.

### 1. `docs(plan): define standalone spine suite roadmap`

- Add this implementation plan and root `.gitignore` rules for `/data/` and generated outputs.
- Confirm `git check-ignore data/catalog.json` reports the root ignore rule once Git is initialized.
- No application behavior changes.

### 2. `chore: scaffold standalone bun workspace`

- Add root workspace scripts, pinned package manager/runtime versions, shared TypeScript configuration, package export conventions, and empty app/package shells.
- Add separate Electrobun configurations and distinct application IDs for Viewer and Editor.
- Add build checks proving `data/` is not copied into `dist/`, Electrobun resources, or release staging.
- Verify workspace install/typecheck/build works with no reference to the original workspace.

### 3. `test: capture spine behavior and compatibility fixtures`

- Copy only relevant existing tests and create small synthetic manifest/project fixtures.
- Capture character discovery, manifest references, runtime playback, interaction/timeline behavior, subtitle parsing, and persistence round trips.
- Record supported legacy formats and source provenance/license notices.
- Tests must not read or write the real `data/` library.

### 4. `refactor(core): extract shared spine domain packages`

- Move schemas, normalizers, project models, manifest/catalog rules, timeline calculations, interactions, and subtitle logic into `spine-core` / `asset-library`.
- Replace deep relative imports with package exports.
- Keep serialized output compatible; no feature additions in this commit.
- Run core tests and workspace typecheck.

### 5. `refactor(runtime): share spine playback and viewport`

- Move Spine renderer, camera, effects, playback, audio scheduling, composition layers, viewport, and subtitle presentation into shared packages.
- Ensure both app feature layers can mount the same viewport/runtime.
- Compare viewer/editor playback and subtitle visuals against the existing implementation.
- Run runtime tests and both renderer builds.

### 6. `refactor(editor): modularize editor feature boundaries`

- Move editor UI into workspace, assets, interactions, bones, timeline, subtitles, audio, inspector, commands, persistence, and diagnostics modules.
- Keep existing interactions, shortcuts, autosave semantics, and project format intact at this stage.
- Add dependency-boundary checks so editor-only UI is not pulled into the viewer bundle.

### 7. `feat(desktop): add scoped native library services`

- Isolate native dialogs, settings, file access, library scanning, path confinement, optional watchers, and companion transport in `desktop-host`.
- Add a read-only Viewer capability and a narrowly scoped Editor write capability.
- Add tests for traversal, symlink/junction escape policy, ignored paths, missing files, and denied viewer writes.
- Development can default to `./data/`; packaged builds prompt for the library and store its path in app settings.

### 8. `feat(viewer): ship standalone spine viewer`

- Build the first independent Electrobun app using shared runtime/UI and the native read-only asset service.
- Add library selection, catalog browsing, search, sequence playback, subtitle/audio controls, and robust loading/error states.
- Verify on the real library in read-only smoke tests; verify no library file changes.
- Verify the packaged app contains no `data/` assets.

### 9. `feat(editor): ship standalone spine editor`

- Build the second independent Electrobun app using the modular editor and scoped native writes.
- Restore existing editing, timeline, subtitle, audio, project-save, and workspace behavior.
- Round-trip against disposable fixtures; test a real-library open without saving.
- Verify separate application identity/preferences and no bundled library data.

### 10. `feat(integration): add safe viewer-editor handoff`

- Add versioned local companion messages, open/focus behavior, project/sequence context, duplicate-instance policy, and dirty-project prompts.
- Add saved-file reload with debounce and state preservation.
- Add explicitly marked unsaved draft preview and return-to-saved behavior.
- Test app-missing, app-disconnected, invalid-message, unsaved-project, and stale-draft cases.

### 11. `feat(editor): add conflict-safe saving and recovery`

- Add external-change detection, staged serialization, safe replacement, bounded backups, and recoverable snapshots.
- Make linked subtitle/project write effects visible before save.
- Test interruption and partial-failure behavior using fixtures; never run write tests on `data/`.

### 12. `feat(viewer): add library and presentation QoL`

- Add favorites/recent items, thumbnail cache, keyboard browsing, fullscreen/hide-UI, presentation controls, and optional screenshot export if ready.
- Keep cache outside `data/`; add invalidation and resource-release tests.

### 13. `feat(editor): add timeline and validation QoL`

- Add prioritized timeline editing affordances, diagnostics navigation, searchable pickers, and workspace presets.
- Add shortcut/accessibility help and verify shortcuts do not intercept text input.
- Separate any large optional features (waveforms, screenshot tooling) into their own commits.

### 14. `perf(wasm): add a profiled worker kernel`

- First capture and retain JS benchmark baselines. Do not introduce a kernel unless a representative workload is demonstrably CPU-bound.
- Implement the highest-value measured kernel (initial candidate: waveform-envelope generation), its worker adapter, cancellable batched protocol, JS fallback, and reproducible Rust/WASM build.
- Test parity against golden fixtures, malformed/edge inputs, cancellation, unavailable-WASM fallback, package loading, and bounded worker/memory behavior.
- Record before/after numbers and enable WASM by default only when the gates in the WebAssembly strategy section pass; otherwise ship the plumbing behind an opt-in flag or defer the kernel.

### 15. `test(release): harden packaged suite and document workflows`

- Test clean install, relocation, paths containing spaces/non-ASCII characters, companion discovery, app updates, and both packaged executables.
- Audit bundle contents and build logs for `data/` or source-workspace paths.
- Document installation, selecting/moving the library, project saves, recovery, shortcuts, and troubleshooting.
- Verify the packaged WASM artifact is lazy-loaded and that the JS fallback works when WASM initialization fails.
- Run full tests/typecheck/builds and a final read-only smoke test against the real library.

## Verification gates

Run the narrowest relevant tests for each commit, then the full workspace checks at integration points. Final release gate:

1. Clean dependency install succeeds from this workspace alone.
2. Viewer and Editor typecheck, test, build, and launch independently.
3. Shared runtime behavior and subtitle appearance match in both apps.
4. Existing manifests/projects open without required conversion.
5. Viewer cannot write to the selected library; Editor writes only intended authored/workspace files.
6. Handoff, live reload, draft preview, dirty-state protection, and recovery work as described.
7. Packaged artifacts contain no library files and no dependency on the original workspace path.
8. `/data/` remains ignored; test saves used disposable fixtures, not the real library.
9. WASM is used only for a benchmark-proven CPU hotspot, worker execution is cancellable, and JS/WASM outputs match; normal app runtime remains usable if the WASM module fails to load.
