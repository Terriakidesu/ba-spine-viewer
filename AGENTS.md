# Repository Agent Guide

## Project boundaries

- Keep BA Spine Viewer and BA Spine Editor as separate applications with separate native identities and app-data locations.
- Treat repository `data/` as authored user data. Do not write to it, run save-oriented tests against it, or include it in builds. Use disposable fixtures for tests and profiling.
- Preserve unrelated working-tree changes, including profiling work. Do not revert or stage those changes as part of another task.
- Keep `plans/standalone-suite.md` separate from `plans/portable-distribution-and-ui-sync.md`; portable distribution supplements the standalone roadmap.

## Shared UI

- `packages/app-ui/src/styles/tokens.css` and `controls.css` are the shared visual foundation. Keep app-specific layout and behavior in the owning feature package.
- Preserve Viewer browsing, playback, and supported light/dark/system theme preferences when changing its styling.
- Keep shared styles and selectors from leaking across applications.

## Builds and validation

- Use the repository's pinned Bun version (1.4.x).
- Run `bun run typecheck` and `bun test` for code changes.
- Windows x64 portable packaging uses `bun run portable:package`; verify it with `bun run audit:portable` and `bun run audit:release`.
- Electrobun native builds can wait on a project build lock held by a `dev --watch` session. Check for existing watchers before starting builds; do not stop or launch app processes without user authorization.
- Do not launch Viewer or Editor merely to validate a build. The portable package command builds and audits artifacts without launching either application.
- Electrobun 2.0.5 has no built-in hard minimum-window-size API. The portable Windows x64 hosts use a native Win32 hook for the drag constraint; `setSize` correction remains a fallback elsewhere and is not a hard drag limit.

## Portable data safety

- Portable manifests and launchers must use validated relative paths contained within the suite.
- The portable archive must contain only a placeholder under `data/`, never the local library.
- Manual suite updates replace application files together while retaining the existing `data/` directory and OS app-data.
