# Portable Suite Distribution and Shared UI Plan

## Purpose

Define a portable release that ships BA Spine Editor and BA Spine Viewer together, uses one adjacent asset library, and gives both applications the same visual design system.

The Editor is the styling source of truth. Viewer keeps its own browsing and playback workflows, but its colors, typography, controls, spacing, menus, dialogs, focus states, and feedback should match the Editor rather than maintain a second visual system.

This plan is separate from `plans/standalone-suite.md`. It supplements that plan with portable packaging and cross-app UI synchronization; it does not replace or rewrite the existing standalone roadmap.

## Goals

- Distribute both applications in one relocatable directory.
- Provide root-level launchers for Editor and Viewer.
- Make both applications discover the same suite-local `data/` directory by default.
- Keep runtime dependencies isolated in each app bundle.
- Preserve user assets when applications are updated.
- Use Editor styling as the canonical shared UI foundation.
- Enforce a practical minimum native window size while handling smaller displays safely.
- Preserve each app's existing behavior, project formats, playback, editing, and handoff workflows.

## Non-goals

- Merging Editor and Viewer into one application or window.
- Replacing the Spine renderer or changing authored asset formats.
- Bundling the multi-gigabyte local asset library into application resources.
- Moving settings, caches, logs, or recovery snapshots into the asset library.
- Adding automatic online updates in the first portable release.
- Reworking Viewer navigation or playback behavior merely to make its layout identical to Editor's.

## Proposed release structure

```text
BA-Spine-Suite/
├── Editor.exe                 # Small suite-aware launcher
├── Viewer.exe                 # Small suite-aware launcher
├── apps/
│   ├── editor/                 # Complete Electrobun Editor bundle
│   └── viewer/                 # Complete Electrobun Viewer bundle
├── data/                       # Shared asset library; may be empty in the app ZIP
├── suite.json                  # Versioned manifest with relative bundle paths
├── README.txt
└── licenses/
```

The launcher files start the native app bundles under `apps/`; they are not substitutes for or renamed copies of Electrobun's internal launchers. Keep each complete bundle intact so its resources and runtime remain together.

Offer the application ZIP independently of the asset library. Users with a large library can copy or download it into `data/`; updates replace launchers and `apps/` without replacing `data/`.

## Minimum window size

### Requirement

- Enforce a native minimum window size of **760 × 560 logical pixels** for both Editor and Viewer on ordinary displays.
- Keep the first-run default frame larger than the minimum and center it in the available display work area.
- Clamp restored/default geometry to the current display work area. If the work area is smaller than 760 × 560, allow the effective minimum to shrink to the available area and ensure the UI remains usable through responsive layout and scrolling rather than positioning controls off-screen.
- Treat the minimum in logical/DIP pixels, not physical pixels, and verify it at multiple display scale factors.
- The renderer's CSS minimum width is not a substitute for a native minimum window constraint.

### Current implementation note

Electrobun 2.0.5 exposes the native HWND but has no minimum-size API. The Windows x64 hosts compile a small `bun:ffi` Win32 hook at startup and install a thread-specific `WH_CALLWNDPROC` hook for the native window. It updates `WM_GETMINMAXINFO` on the window-owning thread, without calling JavaScript from the resize path. The hook converts the logical minimum using `GetDpiForWindow` and limits it to the current monitor work area. Shared frame geometry remains responsible for first-run and restored positions; the existing resize correction remains a fallback on platforms without this Windows hook. Treat the hook as a hard constraint only on Windows x64, and retain packaged drag verification as the release gate.

### Minimum-size verification

- Try to resize each app below 760 × 560 and confirm the native window stops at the limit.
- Verify a smaller work area clamps safely and does not trap the window off-screen.
- Verify keyboard focus, toolbar menus, dialogs, and status content at the minimum size.
- Test 100%, 125%, 150%, and 200% display scaling where available.
- Add unit tests for geometry clamping and a packaged manual test for the native resize limit.

The Windows x64 automated test compiles the same native source and registers the hook on a disposable hidden window. Separate assertions cover 100%, 125%, 150%, and 200% DPI conversion and work-area clamping. Packaged drag testing verifies the integrated native resize constraint.

## Portable path and data behavior

### Suite manifest and launcher

Add a small versioned `suite.json` containing only validated relative bundle paths and suite metadata. Root launchers must:

- Resolve the suite root from their own executable path, independent of the current working directory.
- Parse and validate the manifest; reject absolute paths, traversal, unsupported versions, and paths escaping the suite root.
- Launch the expected app bundle without invoking a shell.
- Pass a documented suite-root/data path to the app host using a defined environment or native-host contract.
- Report a clear error if the manifest or requested app bundle is absent or invalid.
- Preserve any explicitly supported launch arguments without accepting arbitrary executable commands from the manifest.

### Shared library discovery

Use a bounded, explicit discovery order:

1. Valid explicit library override/selection.
2. A validated library path included in an incoming app handoff.
3. The app's remembered library path, if it still exists and is valid.
4. The suite-local `data/` directory, if it contains a recognizable library.
5. A folder picker when no usable library is found.

If the suite is moved, a stale remembered absolute path must not prevent discovery of the new suite-local `data/`. If `data/` is empty or invalid, show a clear selection state rather than silently creating or modifying assets.

### User data and safety

- Keep preferences, window state, logs, thumbnail caches, and recovery snapshots in OS app-data locations, separated by application.
- Keep the asset library read-only in Viewer and restrict Editor writes to its existing supported project/workspace files.
- Keep all resolved paths inside the selected library; preserve traversal and symlink/junction protections.
- Do not write into `data/` as a side effect of startup, discovery, profiling, or theme migration.
- Never overwrite or remove `data/` during install, update, or uninstall.
- Keep the repository's local `/data/` ignored and out of all bundles and test fixtures.

## Companion app behavior

When Editor or Viewer requests its companion:

1. Prefer the other app bundle in the same validated suite.
2. Fall back to a valid existing installed-app registration/launch plan.
3. Show a useful recovery action if neither target can be started.

The launch plan must be recalculated from the current suite location rather than persisting a stale absolute bundle path. Keep the current validated handoff protocol, single-instance behavior, unsaved-change confirmation, saved preview, and read-only unsaved draft preview. Do not place project contents or arbitrary paths on an unvalidated command line.

Standalone installed builds remain supported; portable discovery is additive.

## Editor-based shared UI system

### Source of truth

The current Editor is the visual reference. First extract its existing design values and reusable styles; do not create a new theme unrelated to the shipped Editor.

Create a small shared design-system surface in `packages/app-ui`, for example:

```text
packages/app-ui/src/
├── icons.tsx
├── styles/
│   ├── tokens.css
│   ├── base.css
│   └── controls.css
└── components/                # Add only genuinely shared primitives
```

Use semantic shared tokens such as `--suite-bg`, `--suite-surface`, `--suite-line`, `--suite-text`, `--suite-muted`, `--suite-accent`, and shared spacing/radius/control-size tokens. Avoid coupling Viewer to Editor-private `--editor-*` variables.

Extract only the primitives actually shared by both apps, such as icon buttons, buttons, text fields, tabs, compact toolbars, dropdown/popover surfaces, notices, and dialog framing. Keep application-specific layout and specialized controls in their existing feature packages.

### Styling rules

- Editor's dark navy/cyan visual language is the default for both applications.
- Viewer must use the shared tokens and controls rather than retain a parallel set of visually different defaults.
- Preserve Viewer-specific information architecture and useful browsing/playback controls; synchronize their visual treatment, not their exact screen composition.
- Keep shared base styles in `app-ui`; neither app should import the other's application stylesheet.
- Keep app-specific selectors scoped to the owning app to prevent style leakage.
- Use the shared inline SVG icon set; icon-only controls need accessible labels and tooltips.
- Match interaction states: hover, active/selected, focus-visible, disabled, loading, success, warning, and error.
- Keep menus and dialogs keyboard-accessible and within the viewport at the minimum window size.

### Theme preference

Make the Editor-derived dark appearance the shared default. If Viewer retains its existing light/system theme options, express them as variants of the same semantic tokens and keep the layout/control styling identical. Preserve or explicitly migrate the Viewer theme preference; do not silently discard it. Cross-app live theme synchronization is not required for the first release.

### Editor migration

1. Inventory Editor global variables, button styles, controls, focus rules, and dialogs.
2. Move their canonical values into shared tokens and reusable base styles.
3. Preserve existing Editor appearance through compatibility aliases during migration.
4. Migrate Editor components incrementally and compare screenshots at desktop and minimum sizes.
5. Remove temporary aliases only after both app renderers use the shared system.

The migration is not an opportunity to change Editor behavior or project data. Existing compact toolbar actions, menus, save status, layout selection, keyboard shortcuts, and Viewer handoff must remain available.

### Viewer migration

Audit `apps/viewer/src/renderer/viewer.css`, `packages/viewer-feature/src/styles.css`, and Viewer components. Replace Viewer-specific colors and duplicate control rules with shared styles while preserving:

- Character/lobby browsing, search, filters, favorites, recents, and thumbnails.
- Animation and sequence selection, playback, subtitle/language controls, volume, camera, and fullscreen behavior.
- Loading, error, missing-file, companion handoff, and read-only draft-preview feedback.
- Existing supported keyboard and navigation behavior.

Visually review the Viewer header, library navigation, playback controls, settings, dialogs, and empty/error states alongside equivalent Editor controls. No Viewer behavior should be removed solely to simplify the styling migration.

## Packaging and update strategy

Add a dedicated suite packaging command while keeping per-app builds:

1. Build production Editor and Viewer bundles.
2. Stage complete bundles beneath `apps/editor/` and `apps/viewer/`.
3. Add the two suite launchers, `SuiteUpdater.exe`, validated `suite.json`, README, and license notices.
4. Include an empty `data/` placeholder, not the repository's local library.
5. Audit staged content and create one versioned suite ZIP plus checksum.

Portable apps use one GitHub stable release and one suite ZIP/checksum; do not configure separate Hutch update feeds for Editor and Viewer. Either app may download and verify the same ZIP into `.ba-spine-update/`. Installation is always confirmed, refuses to proceed while Editor reports unsaved or recoverable work, asks the user to close both apps, and waits for their processes to exit. The updater swaps both root launchers, `apps/`, manifest, docs, and licenses as a recoverable transaction while retaining `data/` and OS app-data. It never relocates either app to an independent install location.

The running `SuiteUpdater.exe` is intentionally retained during its own transaction; the staged helper is not used to replace the currently executing image. Keep the updater command and archive contracts backward-compatible. A future updater-protocol change or helper fix requires a coordinated manual suite replacement. Portable suites predating `SuiteUpdater.exe` likewise require one manual update before automatic installs are available. The current public releases predate this helper, so a complete live update-cycle test still requires an updater-enabled baseline release and a newer suite ZIP. Do not publish either release without explicit authorization.

## Release audit requirements

Extend or reuse the existing release audit to verify:

- Both launchers and complete app bundles are present.
- A non-empty regular `SuiteUpdater.exe` is packaged for portable suite installation.
- Manifest app paths are valid, relative, and contained in the suite.
- No local `data/`, catalog, authored project, cache, recovery, or profiling fixture is packaged.
- No developer-machine absolute paths or source-workspace requirements remain.
- Production builds do not expose development profiling or MCP-only features unintentionally.
- App versions and suite manifest versions are compatible.
- The packaged apps launch without Bun/Node installed.
- The ZIP update procedure preserves an existing `data/` directory.
- Suite update download and installation contracts validate the GitHub assets, SHA-256, suite version, archive paths, Editor save state, and interrupted-swap recovery.

## Test plan

### Automated tests

- Manifest schema, unsupported version, traversal, absolute paths, and missing bundle cases.
- Suite-root discovery with spaces, Unicode, relocation, and unrelated current working directories.
- Explicit, handoff, remembered, suite-local, and picker library precedence.
- Empty, missing, unavailable, or read-only suite-local `data/` behavior.
- Companion preference for the same suite and fallback to standalone app registration.
- App-data isolation for Editor and Viewer; no writes into the asset library from discovery.
- Window default/restore geometry and 760 × 560 logical minimum, including smaller work areas and DPI changes.
- Shared tokens/control states and accessibility labels/focus behavior.
- Existing Viewer light/system theme preference migration, if those modes remain supported.
- Existing typecheck, tests, independent renderer builds, native builds, and release audits.

### Packaged manual smoke tests

Use a clean Windows environment without developer tooling and a small disposable valid library fixture:

1. Extract the suite and launch each root executable.
2. Confirm both apps use the same `data/` library and can hand off to each other.
3. Confirm Viewer remains read-only and Editor save behavior is unchanged.
4. Confirm saved preview, read-only draft preview, and return-to-saved behavior.
5. Move the whole suite to a different path, including paths with spaces; launch both again.
6. Resize each app to its minimum and test menus, dialogs, focus, and responsive content.
7. Download a disposable newer suite ZIP, confirm installation, close both apps, and verify both app bundles update while `data/` and OS app-data remain intact. Also verify cancel, dirty Editor, checksum failure, and interrupted-update recovery.
8. Verify both apps have the Editor-derived styling without visual regressions in Viewer playback/browsing.

Do not run write-oriented tests or save commands against the existing authored profiling session or repository `data/` library.

## Implementation phases and gates

| Phase | Work | Exit gate |
|---|---|---|
| 1. Bundle proof | Inspect Electrobun bundle layout, launcher contract, app-data paths, and update behavior; verify minimum-window API. | A relocatable two-app proof launches without developer tooling; native minimum-size behavior is understood. |
| 2. Suite discovery | Add validated manifest, root launchers, suite-root propagation, bounded path discovery, and shared `data/` fallback. | Both apps discover a moved suite and never write discovery state into `data/`. |
| 3. Companion launch | Resolve same-suite companion first and retain standalone fallback. | Both directions of handoff work after relocation; stale installed paths do not win. |
| 4. Shared UI foundation | Extract Editor-derived tokens and genuinely shared controls from `app-ui`. | Editor visual parity holds; both builds consume one shared style source. |
| 5. Editor migration | Move Editor incrementally onto shared tokens/components. | Existing actions, keyboard behavior, and appearance remain intact. |
| 6. Viewer migration | Restyle Viewer header, browser, playback, menus, feedback, and dialogs. | Viewer uses Editor visual styling with its workflows and playback intact. |
| 7. Window constraints | Apply native 760 × 560 logical minimum and responsive small-work-area fallback. | Resize, restore, DPI, and small-display checks pass on packaged builds. |
| 8. Release pipeline | Add suite staging, ZIP, checksum, manifest checks, confirmed suite updates, and asset-preserving recovery. | Audit excludes local assets, confirms app/data separation, and updater tests cover checksums, transaction rollback, and dirty-state protection. |
| 9. Final validation | Run automated suites and clean-machine packaged smoke tests, including an updater-enabled baseline followed by a newer suite artifact. | Both launchers, companion handoff, relocation, minimum sizing, and the complete update cycle pass. |

## Completion criteria

- The directory structure matches the portable suite layout above.
- Root launchers start the complete sibling bundles from any working directory.
- Both apps use suite-local `data/` by default when it is valid, with a clear picker fallback.
- Moving/updating the app suite preserves authored data and OS app-data.
- Companion handoff resolves the sibling app in the same suite first.
- The native window minimum is 760 × 560 logical pixels on ordinary displays, with safe behavior on smaller work areas.
- Viewer uses the Editor's shared visual system; there is no separately maintained default styling system.
- Editor and Viewer functionality, formats, safety boundaries, and existing standalone releases remain supported.
- Builds, tests, audits, and packaged smoke tests pass without accessing or modifying the real `data/` library.
- Automatic updates never install without confirmation, update the two portable apps together, preserve suite `data/` and OS app-data, and leave a recoverable journal if replacement is interrupted.

## Execution evidence (2026-11-04)

- Bun 1.4.2: `bun run typecheck` passed; `bun test` passed (389 tests, 2,847 assertions).
- `bun run portable:package` completed. `bun run audit:portable` and `bun run audit:release` passed. Portable ZIP SHA-256: `e457e17a336fe5959bf9bd9d83165ef46f94a950ad72e2b3d7b9bed8ddad51ac`.
- Windows Shell ZIP enumeration confirmed the archive is no longer displayed as empty: it shows all seven root items (`Editor.exe`, `Viewer.exe`, `README.txt`, `suite.json`, `apps`, `data`, and `licenses`). 7-Zip verified 21 folders and 51 files; its archive test passed.
- Windows x64 native-hook tests compiled and registered the thread-specific hook on a disposable hidden window. Scaling assertions passed at 96, 120, 144, and 192 DPI; the 96-DPI minimum correctly clamps to a 720 × 500 work area.
- Packaged smoke launch used an extracted suite and isolated app-data under disposable paths containing spaces, with a non-suite working directory. Both root launchers started their bundled `bun.exe` processes. After moving the suite to a second path containing spaces, both launchers started again.
- On the current 120-DPI display, a real bottom-right drag toward 500 × 400 stopped both packaged windows at 950 × 700 physical pixels (760 × 560 logical). The disposable suite data tree remained byte-for-byte unchanged during launch and resize.
- A simulated coordinated app-file update overlaid the two launchers, manifest, documentation, licenses, and `apps/` from the package. Hash snapshots confirmed the disposable suite `data/` and isolated OS app-data were retained.

The packaged interactive run used a valid, disposable Spine 4.2 Spineboy export (binary skeleton, atlas, and texture) in the extracted suite at `C:\Users\Asus\AppData\Local\Temp\opencode\Portable Interactive Smoke 3e2268fde80a49b5854a3e3537231be3`; app data was isolated under that suite's `Smoke App Data` directory. No fixture assets were added to the repository.

- Viewer rendered the skeleton and reported 11 Spine 4.2 animations. Playback pause/resume, seeking, animation/options controls, folder help, and theme selection (Light/System/Dark, restored to Dark) were exercised. Viewer asset/library requests were GETs; the only observed POST was the explicit companion handoff. Missing optional voice-index files returned 400 and absent Editor-project probes returned 404 because this small fixture contains no voice library or project before the Editor save.
- **Edit this lobby** launched the sibling packaged Editor against the same suite. A native Editor save created the expected disposable project, interaction, manifest, sequence, workspace, and backup files. **Preview saved**, an unsaved region-name change, **Preview unsaved draft**, and **Return to saved files** were exercised. A 12-file path/length/SHA-256 snapshot before return matched the final tree exactly; the saved region remained `Patting area`, and `Smoke Draft Region` was absent from disk.
- At the current 120-DPI display, both packaged windows were measured at the 950 × 700 physical-pixel minimum (760 × 560 logical); each client area was 932 × 628 physical pixels, approximately 746 × 502 CSS pixels. At the matching compact viewport, Editor command/workspace/action menus, shortcut dialog, keyboard selection, playback controls, inspector, and the native folder picker (opened then canceled) were exercised. Viewer options/help, theme, sidebar, playback, and seek controls were reachable; its content scrolls vertically at this size, and hiding the browsing sidebar gives the player more width.
- Same-size captures showed the shared dark surfaces, cyan accents, borders, and control styling in both apps. Editor's **Balanced** three-panel layout is notably cramped at the minimum: the canvas shrinks to about 181 CSS pixels and playback controls clip. Selecting **Canvas focus** hides both side panels and restores a full-width canvas and usable playback controls. Treat Canvas focus as the practical minimum-size Editor layout; the Balanced-layout squeeze remains a usability caveat.
- Live sizing at 100%, 150%, 200%, and on a physically smaller display remains unverified; DPI/work-area conversions are covered by the automated native tests but those do not replace live checks. Packaged smoke testing was performed on the development Windows host, not a separate clean Windows machine, so the clean-machine gate also remains outstanding.

## Suite update implementation verification (2026-11-08)

- Added shared GitHub suite-release asset validation/download, bounded ZIP staging, checksum verification, confirmed install UI, Editor dirty/recovery-state protection shared through a common per-user roaming app-data coordination folder, and a Windows transactional updater with rollback/recovery. The updater preserves `data/` and the existing `SuiteUpdater.exe`; the latter is not replaced while it is running, so changes to the updater protocol still require a manual suite replacement.
- The suite, both apps, and private workspace packages are aligned at **0.3.0** (minor SemVer bump). `bun run typecheck` passed; `bun test` passed (500 tests across 79 files, 3,661 assertions); suite-updater and portable-launcher Go tests passed.
- An updater-enabled ZIP and extracted folder were packaged only under `C:\Users\Asus\AppData\Local\Temp\opencode\portable-suite-update-validation-0.3.0-20261108`. Package-time checks, `bun scripts/auditPortableSuite.ts` and `bun run audit:release` passed. ZIP SHA-256: `bb097380a974df643010c0848bd8c1831cff896e8b8049a8b6c42944dd1fcb1b`.
- No live update cycle was run or release published. Existing public releases predate `SuiteUpdater.exe`; the cycle remains gated on an authorized updater-enabled baseline release and a newer suite artifact. Keep using disposable fixtures; never validate against repository `data/`.
