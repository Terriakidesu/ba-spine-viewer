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

Profiling is implemented (`bun run profile:wasm-candidates`, `bun run profile:timeline-waveforms`, and the opt-in native Editor waveform profile). Fresh WASM-first measurements on 2026-11-08:

- `bun run profile:wasm-candidates`, three sequential runs on Bun 1.4.2 / Windows x64 / 11th Gen Intel Core i3-1115G4, measured the pure JavaScript absolute-peak kernel on in-memory decoded 48 kHz mono PCM (160 peaks per clip). The data-informed batch of four 8-second clips measured 2.551 / 3.514 / 3.466 ms median and 3.389 / 4.343 / 4.233 ms p95 across runs (0.153–0.211 of a 16.67 ms frame). The deliberately oversized 32×5-second synthetic batch measured 14.116–16.203 ms median and 17.159–20.224 ms p95; it remains stress-only, not representative workload.
- `bun run profile:timeline-waveforms` with the development-only production `TimelineWorkspace` fixture, four 8-second synthetic WAV clips, and five trials (Chrome 156, four reported hardware threads; generated 2026-11-08T07:15:20Z) recorded 20 envelope samples at 0.8 ms median / 1.3 ms p95 (11.9 ms maximum outlier). Decode was 35.5 / 62.6 ms median/p95. All trials completed with zero waveform-stage errors and adequate frame sampling. The harness also reported 11 main-thread long tasks (78 ms median / 299 ms p95) and frame gaps up to 300 ms; it cannot attribute those automation/dev-page stalls to the envelope kernel, and explicitly warns that these are not representative production evidence.
- The ordinary four-clip kernel batch is far below a frame, and a 20% reduction would save under 0.71 ms per batch; no user-visible gain or WASM speedup was demonstrated. Therefore no WASM kernel or worker was added. The separate UI long-task signal remains un-attributed and merits foreground native profiling with a representative project before any targeted optimization.

Keep worker and WASM work deferred until a representative, attributed CPU-bound batch kernel is identified. Any future kernel must match JavaScript and demonstrate at least 20% repeatable kernel CPU improvement plus a user-visible win (target at least 5% end-to-end or removal of a blocking main-thread task over one frame).

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
- 2026-11-08 verification: `bun run typecheck` passed; `bun test` passed (492 tests across 77 files, 3,638 assertions); Viewer and Editor renderer builds passed. The Editor renderer build emitted the existing >500 kB chunk-size advisory. One timing-sensitive companion-test assertion failed in a concurrent run; the isolated test and subsequent full suite both passed.
- `bun run build` passed from the ASCII-path workspace: both stable native bundles completed and `audit:release` passed. The verified FFmpeg cache was reused and prepared successfully. Hutch reported that no `release.baseUrl` is configured and skipped delta-patch generation.
- The interactive Viewer–Editor handoff smoke is covered by the disposable-fixture evidence in `plans/portable-distribution-and-ui-sync.md` (Execution evidence, 2026-11-04): saved preview, unsaved-draft preview, return to saved files, and before/after SHA-256 verification all passed. Reuse this evidence rather than repeating the write-oriented smoke test.
- Windows Japanese-character workspace verification used the detached worktree at `97a71ad` after a frozen install. Viewer renderer compilation and verified FFmpeg extraction passed with the ASCII-temp archive workaround in `apps/viewer/desktop/scripts/download-ffmpeg.ts`. The full native build did not pass: Hutch 0.28.2 invokes `%SystemRoot%\System32\tar.exe` with the canonical Japanese path for `BASpineViewer.tar`, and Windows `tar.exe` cannot open it. Source inspection confirms `buildFolder`/`artifactFolder` must remain safe relative paths under the project root, and Hutch has no tar-path override. Windows `tar.exe` can read the verified cache through its 8.3 alias, but Hutch canonicalizes the workspace path before invoking it. The attempted tar shim broke Hutch config loading/runtime. No supported project-level output-path workaround is available; keep the full Unicode-path native build and release audit blocked pending a Hutch fix or an explicitly approved staging/fork workaround.
- Follow-up source check (2026-11-08): Electrobun 2.0.6 pairs Hutch 0.29.0. Hutch 0.29.0 still selects `%SystemRoot%\System32\tar.exe` and passes the canonical bundle/archive paths to it; no Unicode-path fix or tar-path override was found. This is source inspection, not a successful 2.0.6 native build, so Japanese-path native packaging remains blocked pending an upstream fix or an explicitly approved staging/fork workaround.
- Update-cycle testing remains pending. The configured origin and Viewer release-checker point to `Terriakidesu/ba-spine-viewer`, which has stable releases `v0.1.0` and `v0.2.0`; their only assets are the portable suite ZIP and checksum, not Hutch update manifests or app archives. Hutch names the Windows stable update manifest `stable-win-x64-update.json` for each app, so the two apps need distinct feed base URLs; one shared GitHub `releases/latest/download` URL would collide. Configure only after the per-app release host/URLs are selected, then publish a baseline and a newer artifact before running the update cycle. Do not guess a host or publish externally without authorization.
- WASM-first assessment and fresh evidence are recorded in the candidate section; no measured waveform-kernel optimization met the adoption threshold. WASM/worker implementation remains deferred pending attributed native profiling, not because the UI long-task signal was absent.
