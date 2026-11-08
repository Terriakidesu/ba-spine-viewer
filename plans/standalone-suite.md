# Standalone BA Spine Viewer + Editor — active roadmap

## Suite scope

The suite consists of two independent Electrobun desktop applications:

- **BA Spine Viewer** — browse and play Blue Archive Spine lobby assets.
- **BA Spine Editor** — author interactions, compositions, timelines, audio, and subtitles.

The applications share implementation packages and project formats. A shared fix propagates to both when rebuilt; neither app launches the other as its UI.

Keep this suite independent of any legacy source workspace. The Spine library at `data/` is user data, not source code or a distributable asset bundle.

## Current architecture and data safety

Viewer and Editor are separate Electrobun apps composed from shared packages, including `spine-runtime`, `asset-library`, `platform-contracts`, `desktop-host`, and `app-ui`. App-specific UI and workflows stay in `viewer-feature` and `editor-feature`; native filesystem access stays behind the desktop host.

The selected library's catalogs and manifests remain authoritative. Preserve relative paths and schemas, honor `.editorignore`, and support library relocation. The local `/data/` library is user data: keep it ignored and out of packages, never migrate or write to it during startup or tests, and use synthetic fixtures or disposable copies for persistence tests. Viewer access remains read-only; Editor writes stay scoped to authored project/workspace files. Keep app settings, caches, and recovery data outside the library.

Preserve existing project compatibility and reject path traversal. Do not add asset uploads or telemetry.

## WebAssembly candidates (deferred)

WASM is an optimization option, not an implementation goal. Keep it out of the runtime until profiling identifies a CPU-bound batch kernel. A Web Worker may solve responsiveness without WASM; do not move filesystem access, decoding, Spine/WebGL rendering, or UI state into WASM.

| Suitability | Candidate | Scope |
| --- | --- | --- |
| High | Batched waveform envelopes | PCM peak generation only; decoding, fetching, and playback stay in the host. |
| High | Future batch PCM analysis | RMS/peak, normalization, silence detection, or resampling for large batches; no codecs or FFmpeg work. |
| Moderate | Geometry calculations | Batched transforms, hit tests, and overlap checks; DOM and ordinary interaction state remain TypeScript. |
| Moderate | Camera bounds and constraints | Numeric bounds/clamping over batches; Spine objects and rendering remain in the runtime. |
| Moderate | Bulk project validation | Repeated in-memory numeric/timing checks; parsing, paths, migration, and error presentation remain TypeScript. |

Profiling is implemented (`bun run profile:wasm-candidates`, `bun run profile:timeline-waveforms`, and the opt-in native Editor waveform profile). A fresh Bun 1.4.2 / Windows x64 baseline measured four decoded 8-second clips at 4.032 ms median / 6.046 ms p95; a synthetic 32×5-second stress batch took 18.235 / 19.553 ms, but that batch is not representative of observed projects. Together with prior foreground Editor captures (sub-millisecond median envelope work per clip and no repeatable end-to-end bottleneck), this does not justify a WASM port. Keep worker and WASM work deferred; revisit only with representative evidence. Any future kernel must match JavaScript and demonstrate at least 20% repeatable kernel CPU improvement plus a user-visible win (target ≥5% end-to-end or removal of a blocking main-thread task over one frame).

## Implemented baseline

The standalone apps, shared runtime, asset-library access, library refresh/search, Viewer playback and presentation, Editor timeline/diagnostics, scoped project saving and recovery, and authenticated Viewer–Editor handoff (including read-only draft preview) are implemented. Release builds also audit packaged artifacts for local library and source-workspace leakage. These are context, not future milestones; change them only to address a demonstrated gap.

## Active roadmap

### Shared interaction parity and look-follow — completed 2026-11-08

- Kept the shared interaction model and hit testing in `spine-runtime`; no wholesale re-extraction.
- Preserved the Editor’s follow target, sensitivity, translation/rotation limits, axes, smoothing, and release-return controls. Editor test mode remains gesture-focused and shares the same motion evaluator as Viewer playback.
- Opening intro playback gates gestures until the intro ends. Talk and gestures do not replace an active runtime interaction; authored Talk sequences suppress new gestures. Changing timeline sequences clears held input and overlay tracks.
- Pointer exit drops the temporary follow pose without ending a captured gesture; only the active pointer can release/cancel it. Return-to-neutral and Editor/Viewer motion parity have focused coverage. Unsaved drafts continue through Viewer’s normal read-only project/runtime path.

### Aspect ratios and camera boundaries — completed 2026-11-08

- Removed **1:1** from Viewer, Editor camera-authoring, and recording choices; **16:9** and **4:3** remain.
- Legacy 1:1 preferences and saved camera tracks visibly fall back to 16:9 without writes on load. Selecting a Viewer ratio updates its preference; explicitly saving in Editor updates the project. Camera fallback preserves the authored shot’s world-space width.
- Named camera bounds remain shared world-space safe areas. Both supported ratios fit/clamp against the same bounds, and ratio changes preserve the bounds and shot center.
- Per-ratio boundary overrides were assessed and deferred: shared bounds satisfy both supported ratios, and no representative scene evidence justifies the added schema/UI complexity.
- Added coverage for both ratios, legacy fallback/no-write behavior, shared-bound inheritance, interaction precedence, pointer lifecycle, and motion return.

## Validation and known gaps

- For code changes, run `bun run typecheck` and `bun test`; `bun run build` builds both apps and runs the release-artifact audit.
- 2026-11-08 verification: `bun run typecheck` passed; `bun test` passed (492 tests across 77 files); Viewer and Editor renderer builds passed. The Editor renderer build emitted the existing >500 kB chunk-size advisory.
- The last recorded release review (2026-11-04) still listed an interactive Viewer–Editor GUI handoff smoke test with a disposable Spine fixture and a Windows build from a Japanese-character workspace path as unverified.
- Update-cycle testing still needs a configured release `baseUrl`/feed.
- WASM assessment was completed before the remaining roadmap work (2026-11-08): representative profiling did not reveal a bottleneck that justifies WASM, so WASM/worker optimization is deferred until new profiling evidence identifies a hot path.
