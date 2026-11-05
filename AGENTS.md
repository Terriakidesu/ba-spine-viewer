# Repository Agent Guide

## Workspace boundaries

- This Bun workspace is pinned to `bun@1.4.2`. Renderer entrypoints are `apps/{viewer,editor}/src/renderer/main.tsx`; native Electrobun entrypoints are `apps/{viewer,editor}/desktop/src/bun/index.ts`.
- Keep Viewer and Editor as separate native apps with separate identities and OS app-data locations. App UI belongs in `packages/{viewer-feature,editor-feature}`; shared Spine behavior in `packages/spine-runtime`; native path/persistence policy in `packages/desktop-host`; shared styles/primitives in `packages/app-ui`.
- Treat repository `data/` as a gitignored, authored asset library: never write/save-test against it or include it in builds. Use disposable fixtures for tests and profiling.
- Preserve unrelated working-tree changes, including profiling work; do not revert or stage them as part of another task.
- Keep `plans/standalone-suite.md` separate from `plans/portable-distribution-and-ui-sync.md`; portable distribution supplements the standalone roadmap.

## Shared UI

- `packages/app-ui/src/styles/tokens.css` and `controls.css` are the shared visual foundation. Keep app-specific layout and behavior in the owning feature package; prevent shared selectors from leaking between apps.
- Preserve Viewer browsing, playback, and supported light/dark/system theme preferences when changing its styling.

## Commands and build behavior

- Run `bun run typecheck` and `bun test` for code changes; focus tests with `bun test <file>` or `bun test packages/<package>`. No root lint or formatter script is defined.
- For renderer-only builds use `bun --cwd=apps/viewer run build:renderer` or `bun --cwd=apps/editor run build:renderer`. `bun run build` builds both native apps, then runs the release artifact audit.
- Electrobun native builds may wait on a build lock held by `dev --watch`. Check for existing watchers first; do not start or stop app processes without user authorization, and do not launch an app just to validate a build.
- Portable packaging is Windows x64 only and requires `go` and `tar` on `PATH`; run `bun run portable:package`, then `bun run audit:portable` and `bun run audit:release`.
- Packaging replaces the versioned ZIP under `release/portable`; if Windows reports `EBUSY` removing it, close the holder of that exact ZIP and rerun rather than deleting broader outputs.
- Electrobun 2.0.5 has no built-in OS hard minimum-size API: Windows x64 uses the native Win32 hook in `packages/desktop-host`; elsewhere `setSize` correction is a fallback, not a hard drag limit.

## Commit messages

- Use Conventional Commits: `<type>(<scope>): <summary>`, for example `feat(editor): add animation length matching`. Scope is optional.
- Use a concise, imperative summary and lowercase types such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, or `chore`.
- Mark breaking changes with `!` after the type or scope and explain them with a `BREAKING CHANGE:` footer.

## Portable data safety

- Keep portable manifest and launcher paths validated, relative, and contained within the suite. The archive may contain only a placeholder under `data/`, never the local library.
- Manual suite updates replace launchers, manifest/docs, and app files together while retaining the existing `data/` directory and OS app-data.
