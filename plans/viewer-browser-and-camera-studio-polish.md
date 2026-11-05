# Viewer Browser and Camera Studio Polish

## Purpose

Implement the UI and interaction follow-up reported after the Viewer fullscreen work. This plan supplements `plans/viewer-workspace-and-camera-motion.md` and `plans/camera-studio-completion.md`; it does not replace or rewrite either roadmap, nor the standalone or portable-distribution plans.

## Scope

1. Make Viewer settings and character/variant browsing easier without sacrificing preview space.
2. Improve Viewer character identity thumbnails, with robust fallbacks for Spine rigs that cannot produce reliable face crops.
3. Make Editor Camera Studio gizmos, shot controls, region resizing, and feedback stable and directly manipulable.

Keep Viewer changes in `packages/viewer-feature`, reusable Spine/head detection or camera math in `packages/spine-runtime` when appropriate, and Editor interactions in `packages/editor-feature`. Preserve Viewer browsing, playback, read-only behavior, theme preferences, and existing project compatibility.

## Viewer settings drawer

- Replace the expanding settings block in the playback/control flow with a right-side **overlay drawer** on desktop. Opening or closing it must not resize the stage, alter its camera pose, or hide the main toolbar, playback row, or dialogue selector.
- Keep a fixed drawer header with a clear title and close button. Scroll only the drawer body. Avoid a dim backdrop and do not pause playback.
- Use a compact modal-like presentation on narrow windows; keep the live preview visible where practical and let the settings content scroll internally.
- Close with the Options control and Escape. Escape closes the drawer before it exits fullscreen; do not steal Escape from an active input or another higher-priority interaction.
- Keep output aspect ratio as an explicit setting, not as a side effect of region resizing. Continue respecting authored-camera constraints and existing settings availability.
- Organize controls into compact, consistently sized sections. Avoid document-level scrolling and prevent drawer contents from pushing or covering essential playback controls.

## Character and variant browser

- Make character and variant selection a single browsable hierarchy in the left panel. Character rows show identity, a useful thumbnail, and a subtle variant count; expanding a character reveals its variants directly below.
- Make the active variant obvious. Keep favorite actions associated with the relevant character/variant, and retain recent/favorites and search workflows.
- Search both character and variant names. A variant-only match should reveal its parent and matching child rather than hiding the result.
- Remove the redundant bottom variant dropdown when the hierarchical browser can select the same variants. Preserve keyboard operation, accessible names, and narrow/fullscreen behavior.
- Do not make the browser wider at the expense of the stage without a responsive limit; retain collapse/show behavior.

## Face thumbnails and safe fallback

- Character rows should prefer square face/head previews when detection is reliable. Use existing dedicated portrait art if available; otherwise derive a crop from a stable captured idle pose and detected visible head artwork/bones.
- Keep adequate padding for hair and accessories. Do not mistake interaction/controller bones such as `Touch_Point` for a head anchor.
- Fall back to the existing full-lobby preview, contained rather than aggressively cropped, when face detection or capture is uncertain. A poor crop is worse than a recognizable full-scene thumbnail.
- Cache face and lobby thumbnails separately, include an algorithm/version component in the cache identity, and keep thumbnail generation bounded/cancelable. Never write thumbnail assets into repository `data/` or the selected read-only library.
- Provide an accessible textual identity even when no thumbnail is available.

## Camera Studio gizmos and selection

- Prevent boundary and shot guides from competing for pointer input. Add explicit **Edit boundaries** and **Edit shots** modes (or equivalent unambiguous tool state); only the active tool's selected object receives interactive handles.
- Use distinct visual language: amber dashed boundary guides and cyan solid camera-shot frames. De-emphasize non-selected guides; clearly label the selected target and support deterministic cycling/selecting when outlines overlap.
- Keep handles a stable screen size across workspace zoom. Maintain separate workspace pan/zoom and authored-camera geometry.
- Keep status/diagnostic text in a reserved-height area outside the canvas sizing flow. In particular, “Frame clamped to fit Safe bound 1.” may update or wrap but must not move or resize the stage, camera preview, or gizmos.
- Keep selection, tool mode, and guide visibility accessible without requiring users to click through overlapping geometry.

## Region resize and drag gestures

- Drag inside a selected region to move it; corner/edge handles resize it. The opposite edge/corner remains anchored by default.
- Preserve the active output aspect ratio during corner resize by default for an aspect-locked camera. For unlocked regions, **Shift** temporarily preserves the ratio captured at drag start. **Alt** resizes around the region center. **Shift+Alt** combines centered and aspect-preserving resize.
- Modifier changes during a drag must not cause jumps. Keep the unmodified anchor or center stationary and clamp through the shared camera/bound rules.
- Keep gestures scoped to the active Camera Studio tool so they do not interfere with stage navigation or other editor tools.
- Escape cancels a gesture and restores its initial region. Pointer cancel/lost capture must release the gesture safely. A completed drag is one undo step.
- Provide a live dimensions/ratio readout and keyboard nudging; Shift+arrow uses a larger nudge. Output ratio remains a separate explicit project/sequence setting.

## Shot inspector controls

- Provide directly editable numeric inputs for shot **Time, Center X, Center Y, and Frame height**, with units, bounds, and precision appropriate to each field.
- Numeric fields support direct typing, arrow-key increments, and visible horizontal drag-scrubbing. Shift fine-tunes; Alt applies a coarser multiplier. Use one undo operation per completed scrub, not one per pointer event.
- Provide a bounded timeline slider for Time and a useful frame-height/zoom slider. Keep slider values synchronized with numeric fields and the selected shot gizmo.
- Replace repeated “Drag” helper labels with concise, contextual modifier hints beside the controls. Preserve existing `NumberField` conventions and accessibility where possible.
- Editing or scrubbing an existing shot must preserve its ID and time unless Time is intentionally changed; retiming must use existing collision/validation behavior. Do not silently create a shot or change the edit target.

## Validation and completion criteria

- Add focused unit/model tests for region resize anchors, ratio-preserving and centered modifier combinations, modifier transitions during drag, clamping, cancellation, and undo grouping.
- Add focused tests for numeric shot control bounds/steps and for thumbnail/head-detection fallback and cache-version behavior where existing test seams permit.
- Run `bun run typecheck`, `bun test`, and Viewer/Editor renderer builds. Run `git diff --check`.
- Verify responsive layouts and pointer/keyboard interactions if a safe existing test/browser path is available. Do not launch or stop desktop apps without authorization; do not use repository `data/` for writes or fixtures.
- Preserve unrelated working-tree changes and stage only this task's implementation and plan files.

Completion means the drawer does not reflow the Viewer, character and variant selection is directly discoverable, face crops fail safely, Camera Studio guides no longer compete, numeric shot controls are genuinely draggable/editable, resize modifiers behave without jumps, and status feedback does not shift the preview.
