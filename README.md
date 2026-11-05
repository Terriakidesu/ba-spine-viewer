# BA Spine Suite

Two desktop tools for browsing, previewing, and authoring Blue Archive Spine content.

| App | Purpose |
| --- | --- |
| **BA Spine Viewer** | Browse a local asset library and play Spine characters, lobby sequences, dialogue, and effects. |
| **BA Spine Editor** | Author and preview lobby interactions and timelines. |

## Features

### Viewer

- Search and browse characters, variants, and lobby assets; keep favorites and revisit recent lobbies.
- Play animations and compositions with playback, camera, voice, subtitle, and Light FX controls.
- Export video at 720p, 1080p, 2K, or 4K while preserving the selected aspect ratio and visual effects.
- Send a lobby and playback context to the Editor, or preview an Editor project in the Viewer.

### Editor

- Build and edit lobby interactions and timelines with animation, color, audio, and subtitle tracks.
- Preview timeline sequences and inspect project diagnostics, including missing or invalid references.
- Find subtitle cues, copy and paste timeline clips, and use keyboard shortcuts for common editing tasks.
- Save authored project data with external-change checks and local recovery support.

### Together

- Preview saved work—or an unsaved, read-only draft—in the other app.
- Keep source skeletons, atlases, textures, and audio separate from authored project files.

## Getting started

### Run from source

Requires [Bun](https://bun.sh/) 1.4.2 and the platform prerequisites for Electrobun.

```sh
bun install
bun run dev:viewer
bun run dev:editor
```

Choose your local asset-library folder when prompted. In development, a recognizable `./data/` folder can also be used.

### Build the portable suite

On Windows x64, create a portable ZIP containing both apps with:

```sh
bun run portable:package
```

The ZIP is written to `release/portable/`. It contains the applications, not your local asset library; select or place the library separately.

## Data and privacy

- Viewer access to the asset library is read-only.
- Editor changes are saved to authored project and workspace files; source Spine assets are left untouched.
- The asset library is local and is not included in application builds or portable packages.
- Viewer–Editor handoffs use a local connection and do not upload projects or assets.

## Development checks

```sh
bun run typecheck
bun test
bun run build
```

`bun run build` builds both desktop apps and audits their release artifacts.
