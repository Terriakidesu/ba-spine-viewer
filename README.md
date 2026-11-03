# BA Spine Suite

Standalone Electrobun apps for viewing and editing Blue Archive Spine assets:

- **BA Spine Viewer** — read-only playback, browsing, dialogue, and composition preview.
- **BA Spine Editor** — interaction and timeline authoring.

Both apps use the shared modules under `packages/`. The viewer and editor have separate native application identities and build outputs.

## Local development

This workspace expects Bun 1.4.x and Windows/macOS/Linux desktop build prerequisites for Electrobun.

```sh
bun install
bun run typecheck
bun test
bun run build
bun run dev:viewer
bun run dev:editor
```

`bun run build` builds both native applications (Viewer, then Editor) and audits the packaged outputs for bundled `data/` directories, catalog paths, and the current source-workspace path. `bun run audit:release` reruns that audit; optionally provide OS-delimited `BA_SPINE_FORBIDDEN_PATHS` and `BA_SPINE_BUILD_LOGS` lists to check additional source paths and captured build logs.

In desktop development, `./data/` is offered as the fallback library when present. To use another library, set `BA_SPINE_DATA` to its root. The app also supports choosing a library from its native dialog. Startup priority is explicit `BA_SPINE_DATA`, then the app's last-selected library from OS app data, then the development-only `./data/` fallback. If a drive is unavailable or the library moved, choose its new folder and the preference is updated. Only the path is remembered—not an asset copy—and project-relative references remain rooted in the selected library.

## Asset and project data

`data/` is a local, gitignored library. It is not application source, not included in builds, and should never be force-added to Git. The viewer has read-only access. The editor saves only authored project and established workspace files; source Spine skeletons, atlases, textures, and audio remain untouched. Remembered library paths are stored separately per app under OS app data, never in the library.

Viewer library search matches character names, variants, lobby IDs, and asset IDs. Use the character list's arrow keys or Home/End to browse; mark the selected lobby as a favorite or reopen it from recent lobbies. Desktop favorites and recents are stored locally per library identity. Browser-picked folders use session-only navigation preferences because they do not expose a reliable persistent library identity.

The desktop Viewer creates small previews lazily for visible character rows, using a single serialized idle-time WebGL capture lane. Fingerprinted thumbnails are stored in the Viewer’s OS app-data cache (bounded to 256 images / 128 MB), never under the selected library; a changed lobby replaces only that lobby’s cache entries. Thumbnail failures do not block browsing or playback.

The desktop Viewer debounces selected-library filesystem events and marks changes as available without interrupting playback. Use **Refresh library** to reload; the current lobby, sequence, playhead, camera, language, voice volume, and playback settings are retained where still valid. The manual action remains available if filesystem watching is unsupported or unavailable.

Viewer and Editor save their window size, position, and maximized state separately in OS app data. On restart, the saved frame is adjusted for the current display scale and clamped to a connected monitor's work area; invalid state or a disconnected display safely falls back to the default/primary display. First-run defaults are also centered and shrunk to fit. This state never touches the asset library.

Automated persistence tests must use synthetic fixtures under `tests/fixtures/` or a disposable copy—not `data/`.

Editor saves stage the project and linked subtitle JSON as one batch, compare each file with its session baseline, and ask before overwriting external edits. Replacements are atomic per file, prior project JSON is kept in a bounded `.editor/backups/` history, and a failed multi-file commit attempts rollback and reports any incomplete rollback. Local recovery snapshots are separate, bounded browser storage; the Editor always prompts before restoring them, and restore marks the project unsaved. Linked subtitle files are not written until **Save to root**.

The timeline inspector provides read-only, navigable diagnostics for unavailable layers, missing manifest-declared files or audio, unknown Spine animations, unsupported manifest versions, invalid/out-of-duration ranges, overlapping or exact same-time duplicate subtitles, missing preview-language translations, and stale audio-to-subtitle links. Unsupported project schemas are rejected with a load error. Diagnostics select the affected item; fixes remain explicit Editor actions.

Use **Find subtitle cue** in the timeline inspector to search English, Japanese, Korean, or all translations. Results are case-insensitive and ordered by cue time; selecting a result selects the cue, stops playback, moves the playhead, and scrolls the timeline to it. Search and navigation do not edit subtitle data.

Timeline selections can be played once or looped between their combined start and end. Pause/resume preserves selection playback; changing the selection or seeking exits the loop. **Fit selection** zooms and scrolls the timeline to the selected items without changing authored timing.

Copy selected animation, color, subtitle, or audio clips with **Ctrl/Cmd+C**, then paste at the playhead with **Ctrl/Cmd+V**. Pasting preserves relative timing, remaps links when both audio and its cue are copied, skips locked tracks, and moves color clips around occupied same-track ranges. Links to cues not copied are cleared. The clipboard stays in memory for the current sequence and does not use the OS clipboard.

Animation fields in the interaction and timeline editors use searchable pickers. Type to filter names, then use the arrow keys and Enter to choose; existing animation names that are missing from the loaded rig remain visible and marked rather than being silently cleared.

## Viewer and Editor handoff

**Edit this lobby** in Viewer sends the selected library/lobby and available playback context to Editor. **Preview saved in Viewer** sends the Editor's selected library/lobby and timeline context back to Viewer; save authored changes first. When the Editor project is dirty, **Preview unsaved draft in Viewer** sends a debounced, read-only project snapshot through the authenticated loopback companion channel. Draft data is held in Editor memory only, never written to the asset library; Viewer visibly marks draft mode and offers **Return to saved files**. Draft preview ends when its session is revoked or Editor disconnects. Handoffs do not upload data. If the target is not running, the sender starts it from its per-user launch plan (or discovers the Electrobun install) and waits up to 12 seconds for registration. Handoffs and duplicate app launches activate the existing window. On same-lobby saved-file reloads, Viewer keeps its language, camera framing/pose, voice volume, and playback position/speed/loop/pause state; explicit handoff sequence/time takes precedence when supplied. Editor asks before replacing a dirty project and refuses replacement during a save or save error.

## Workspace map

```text
apps/viewer/                 Viewer renderer and Electrobun host
apps/editor/                 Editor renderer and Electrobun host
packages/spine-runtime/      Shared Spine models, runtime, and viewport modules
packages/viewer-feature/     Viewer screen and desktop asset adapter
packages/editor-feature/     Modular editor UI, project logic, and tests
packages/app-ui/             Shared icons and UI primitives
packages/asset-library/      Shared catalog and manifest discovery
packages/desktop-host/       Shared native host boundary and path policy
packages/wasm-kernels/       Deferred until a CPU-bound workload is profiled
plans/                       Architecture and commit-oriented roadmap
data/                        Local asset library; ignored
```

See [`plans/standalone-suite.md`](plans/standalone-suite.md) for migration phases, integration QoL, safety requirements, and release acceptance criteria.
