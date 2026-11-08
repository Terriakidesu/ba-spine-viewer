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

### Shared interaction parity and look-follow

- Keep the existing shared interaction model, hit testing, and runtime behavior in `spine-runtime`; do not plan a wholesale re-extraction.
- The Editor already exposes follow target, sensitivity, translation/rotation limits, axes, smoothing, and release-return controls. Treat this authoring UI as implemented, not a new feature.
- Audit differences among Editor test mode, Viewer playback, and unsaved-draft preview. Add focused parity coverage and consolidate only behavior that is actually duplicated or divergent.
- Define and test precedence with opening and Talk sequences, patting/pinch, pointer exit/cancel, sequence changes, and return-to-neutral.

### Aspect ratios and camera boundaries

- Remove **1:1** from Viewer, Editor camera-authoring, and recording choices; retain **16:9** and **4:3**.
- For saved projects or preferences containing 1:1, use a visible 16:9 compatibility fallback without rewriting persisted data until the user explicitly saves.
- Use named camera bounds as shared world-space safe areas across ratios by default; ratio changes affect fitting/clamping, not the bounds. Add per-ratio overrides only where a real scene needs different safe areas.
- Keep shot composition separate from safe bounds. Use shot framing for aspect-specific center/zoom changes; make override scope clear in the UI and provide reset-to-shared behavior.
- Test legacy fallback/no-write behavior, both output ratios, shared-bound inheritance, and override reset.

### Suggested order

1. Complete the interaction parity and edge-case audit.
2. Remove 1:1 from the user-facing choices and add the non-destructive legacy fallback.
3. Add optional boundary overrides only if shared bounds prove insufficient.

## Validation and known gaps

- For code changes, run `bun run typecheck` and `bun test`; `bun run build` builds both apps and runs the release-artifact audit.
- The last recorded release review (2026-11-04) still listed an interactive Viewer–Editor GUI handoff smoke test with a disposable Spine fixture and a Windows build from a Japanese-character workspace path as unverified.
- Update-cycle testing still needs a configured release `baseUrl`/feed.
- WASM remains deferred; no worker or WASM kernel is planned without new profiling evidence.
