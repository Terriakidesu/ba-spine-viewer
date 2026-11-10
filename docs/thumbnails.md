# Saved lobby thumbnails

The Viewer reads `lobbies/<directory>/thumbnail.png`. Missing or unreadable images
remain placeholders: browsing never loads Spine models to generate previews.
Both list styles use this saved image (the compact character row is circular).

Generate thumbnails explicitly with an installed Microsoft Edge (Windows) or
Google Chrome (other platforms):

```sh
bun run thumbnails:generate --root "D:/Misc/ba-spine"
bun run thumbnails:generate --root "D:/Misc/ba-spine" --directory Airi_home --force
```

Use `--browser <executable>` to select another Chromium-compatible executable.
The generator uses a separate headless browser, not either running native app.

- Each image is a **640×360 (16:9) PNG**, from **`Idle_01` at time zero**, framed
  without stretching, against the Viewer background color.
- Only the manifest's primary Spine set is loaded. Missing `Idle_01`, identity
  mismatches, empty renders and invalid assets are reported rather than guessed.
- Default batches include only `*_home` directories, not scene/background sets.
  `--directory` can explicitly target any single set.
- One lobby is processed at a time. Its textures, images, context and page are
  released before processing the next lobby.
- Existing images are skipped unless `--force` is supplied. Files are published
  atomically; failed rendering does not replace an existing thumbnail.
- The script writes only thumbnail images, not manifests, sequences or subtitles.
  Repository `data/` is forbidden. Tests use disposable fixtures.
- A summary reports generated, skipped and failed counts. Any failures cause a
  nonzero exit code, while other lobbies continue processing.

After changing Spine artwork, regenerate that lobby with `--force`. Reopen or
refresh the Viewer library to load the updated image; there is no automatic
regeneration during browsing.
