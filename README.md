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

`bun run build` builds both native applications (Viewer, then Editor).

In desktop development, `./data/` is offered as the default asset library when present. To use another library, set `BA_SPINE_DATA` to its root. The app also supports choosing a library from its native dialog.

## Asset and project data

`data/` is a local, gitignored library. It is not application source, not included in builds, and should never be force-added to Git. The viewer has read-only access. The editor saves only authored project and established workspace files; source Spine skeletons, atlases, textures, and audio remain untouched.

Automated persistence tests must use synthetic fixtures under `tests/fixtures/` or a disposable copy—not `data/`.

## Viewer and Editor handoff

When both applications are running, **Edit this lobby** in Viewer sends the selected library/lobby and available playback context to Editor. **Preview saved in Viewer** sends the Editor's selected library/lobby and timeline context back to Viewer; save authored changes first. Handoffs use a versioned, authenticated loopback-only channel and do not upload data. Handoffs and duplicate app launches activate the existing window. If the target app is not running, the sender reports that it is unavailable; automatic app launch and unsaved-draft preview are not implemented yet.

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
