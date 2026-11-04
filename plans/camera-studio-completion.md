# Camera Studio and Viewer Completion Plan

## Goal

Deliver a complete camera-authoring workflow:

**Choose correct animations → author boundaries and camera shots → edit and retime existing shots → save → reproduce the same result in Viewer.**

The existing Camera Studio work is partial. Rendering correctness, selection, keyframe editing, and Viewer integration must be verified together before considering it complete.

## Reported issues to resolve

- `LookEnd_01_M` appears to be chosen as the idle animation.
- The Scene pane crops the sprite or appears to follow the game's authored camera.
- Middle-drag does not pan in Select mode.
- Boundaries and shots cannot be deselected, making settings such as aspect ratio inaccessible.
- Selecting a shot can leave the boundary inspector visible.
- “Fit camera here” creates a keyframe rather than reframing the existing selected keyframe.
- Context menus are missing.
- Saved camera changes are not reflected in Viewer.
- Output can be blank at the end of a sequence; determine whether that is expected clip visibility or a rendering regression.

## 1. Investigate and establish regression cases

Trace the reported failures before changing behavior:

- Follow idle selection and fallback paths across runtime, Editor, and Viewer.
- Follow selection state and inspector rendering for both shots and boundaries.
- Follow “Fit camera here” from UI event through keyframe mutation.
- Follow save, reload, composition refresh, and Viewer camera-mode selection.
- Check full-artwork framing during intro, idle, and talk playback, including animation-authored camera-like transforms.
- Reproduce the blank sequence endpoint with a disposable fixture.

Add focused tests for each discovered cause. Never save-test against repository `data/`; use disposable fixtures.

## 2. Correct idle and animation defaults

### Automatic detection

- Prefer legitimate idle animations.
- Never automatically use Look/LookEnd, Talk, Pat, Pinch, Touch, or other interaction clips as idle.
- Audit first-animation and layer-animation fallbacks in all apps.
- Distinguish **automatic idle**, **explicitly selected animation**, and **no idle available**.

### User control and feedback

- Provide an explicit idle override where needed.
- Show which animation was selected automatically and why.
- Display **No idle detected** rather than silently choosing an unrelated animation.
- Keep interaction-return animations available for their intended transitions.

### Existing projects

- Preserve intentional authored animation choices.
- Flag suspicious existing defaults rather than silently rewriting them.
- Add persisted override data only if existing project settings cannot represent the choice.

**Acceptance:** `LookEnd_01_M` is never selected as idle merely because of animation order or a generic fallback.

## 3. Fix selection and inspector access

### Explicit inspector target

Use one clear inspector target:

- Camera settings
- Boundary
- Shot

Keep contextual highlights separate. A shot's assigned boundary can remain highlighted without taking over the inspector.

### Deselect behavior

- Clicking empty Scene space clears selection.
- Escape cancels an active operation first; otherwise it clears selection.
- Panning, zooming, and dragging do not accidentally deselect.
- Provide a permanent **Camera settings** button.
- Selecting a shot always opens its shot inspector.
- Selecting a boundary opens its inspector without changing shot-edit state.

### Persistent settings

Keep camera enable/disable, Output aspect ratio, Camera settings, and guide visibility accessible regardless of the current selection. Put the actual aspect-ratio selector in the Output header.

**Acceptance:** selecting any boundary or shot never traps the user away from Camera settings or aspect-ratio controls.

## 4. Make existing shots fully editable

### Shot inspector

Expose:

- Time
- Center X/Y
- Frame height/zoom
- Boundary assignment
- Outgoing interpolation: Linear, Smooth, or Hold
- Duplicate and Delete

Selecting a shot pauses playback, seeks to its time, and opens its inspector.

### Direct scene manipulation

- Drag the selected shot frame to change its center.
- Resize its frame while preserving the chosen output aspect ratio.
- Keep handles usable at different workspace zoom levels.
- Show authored framing and constrained output distinctly.
- Explain when a boundary clamps position or frame size.

### Separate editing from creation

| Action | Result |
| --- | --- |
| **Add shot at playhead** | Creates a shot at the playhead. |
| **Update selected shot** | Updates the selected shot without changing its time or ID. |
| **Fit selected shot to boundary** | Reframes the selected shot inside the boundary. |
| **Create fitted shot here** | Explicitly creates a shot at the playhead. |
| **Frame in scene** | Changes workspace navigation only. |

Handle occupied times explicitly. Never silently create duplicates or overwrite another shot. Scrubbing must not silently change which shot subsequent edits target.

**Acceptance:** repeatedly reframing one shot leaves the shot count unchanged.

## 5. Finish Scene and Output rendering correctness

### Independent Scene workspace

- Fit complete relevant artwork rather than the game's viewport.
- Verify intro, idle, and talk playback—not only the initial idle pose.
- Investigate clipping attachments and animation-authored transforms.
- Keep Scene navigation stable while scrubbing.
- Avoid continuous automatic fitting that makes the artwork drift.
- Preserve Viewer game/fit/fill behavior outside authored-camera playback.

### Consistent coordinates

Centralize projection and inverse projection for boundary drawing/transforms, shot framing/transforms, layer position/scale, workspace zoom/pan, window resizing, and display scaling. Drawing, moving, and resizing must agree with the displayed guides.

### Accurate Output

- Render the exact selected aspect ratio.
- Evaluate constraints consistently before and after shots exist.
- Use a stable, defined no-shot fallback.
- Explain missing references, disabled cameras, and unconstrained output.
- Keep messages and controls outside the artwork.
- Investigate blank end-of-sequence output without arbitrarily changing clip semantics.

**Acceptance:** visible guides, inspector values, and rendered output describe the same world-space frame.

## 6. Make Viewer honor authored camera changes

Treat Viewer parity as a release blocker.

### Shared evaluation

- Use the same camera sampling, interpolation, boundary solving, and fallback policy in Editor and Viewer.
- Avoid separate Editor-only camera behavior.
- Respect the saved reference scene and output ratio.

### Save and reload

Verify round-trip preservation of camera enabled state, aspect ratio, reference layer, shot times/framing/interpolation, boundaries/assignments, and automatic/manual/unconstrained behavior.

Ensure Viewer refreshes after saved project changes instead of retaining stale camera state.

### Playback and handoff

- Make Authored camera mode discoverable.
- Clearly explain when game/fit/fill overrides authored framing.
- Verify opening/talk sequence switching and Editor-to-Viewer handoff.
- Match constrained framing throughout transitions, not just at keyframes.

**Acceptance:** save an edited shot, open or refresh Viewer, and obtain matching framing at matching sequence times.

## 7. Add context menus

### Shot menu

- Edit properties
- Seek to shot
- Frame in Scene
- Duplicate
- Fit to assigned/chosen boundary
- Delete

### Boundary menu

- Edit properties
- Frame in Scene
- Fit selected shot
- Create fitted shot at playhead
- Duplicate
- Lock/unlock
- Show/hide guide
- Enable/disable
- Delete

### Empty Scene menu

- Deselect
- Camera settings
- Add shot at playhead
- Draw boundary
- Fit Scene

### Camera timeline menu

- Add shot at clicked time
- Paste or duplicate shot
- Delete selected shot

### Menu behavior

- Target the right-clicked item deterministically.
- Never silently change the shot-edit target when opening a boundary menu.
- Stay within window bounds and close on Escape/outside click.
- Support keyboard navigation and accessible alternatives.
- Disable unavailable actions with an explanation.

## 8. Add a usable camera timeline

Provide a compact shot strip beneath the previews with:

- Visible keyframe markers and readable timestamps
- Selection and drag-to-retime
- Snapping to playhead, neighboring shots, and sequence endpoints
- A modifier to bypass snapping
- Previous/next navigation based on playhead position
- Duplicate/copy/paste shot properties
- Explicit collision feedback
- Clear outgoing interpolation indication

Keep Camera Studio and Timeline playheads synchronized.

**Acceptance:** users can create, edit, duplicate, and retime a camera move without leaving Camera Studio.

## 9. Improve boundary authoring

- Keep guide visibility separate from constraint enablement.
- Add locking against accidental transforms.
- Rename, duplicate, delete, and frame boundaries.
- Offer optional aspect-locked drawing/resizing.
- Show active constraint, selection, and assignment distinctly.
- Explain automatic boundary priority.
- Warn before deleting a referenced boundary.
- Provide predictable behavior for missing or disabled assignments.
- Label boundaries as allowable camera regions—not shots.

## 10. Navigation and layout QoL

- Keep zoom controls in the header, with editable percentage and reset.
- Fit the Scene, selected boundary, or selected shot.
- Support middle-drag and Space-drag in every tool.
- Scope V/H/B/F shortcuts to the Scene workspace.
- Preserve navigation when selecting items.
- Persist preview split and guide preferences.
- Provide independent toggles for boundaries, shot frames, centers, and composition guides.
- Offer optional thirds/center guides and compact shortcut help.
- Show clear cursor feedback and prevent controls/messages from covering artwork.

## 11. Undo, cancellation, and data safety

- One drag or numeric scrub produces one undo step.
- Escape restores pre-operation state.
- Pointer cancellation/lost capture releases tools safely.
- Navigation and selection do not dirty the project.
- Shot edits preserve identity and timing unless explicitly changed.
- Validate finite coordinates, positive dimensions, unique times, and valid references.
- Preserve old projects and intentional animation choices.
- Add migrations only when necessary and cover them with tests.

## 12. Implementation boundaries

Extract focused Camera Studio components and helpers rather than continuing to grow `TimelineWorkspace.tsx`:

- Selection/editing state
- Coordinate/projection helpers
- Scene toolbar and manipulators
- Shot and boundary inspectors
- Camera timeline
- Context menus

Keep shared playback/camera evaluation in `packages/spine-runtime`, editor interactions in `packages/editor-feature`, Viewer integration in `packages/viewer-feature`, and native save/reload policy in the existing host boundaries.

## Delivery order

1. **Immediate blockers:** idle diagnosis, deselection, permanent settings access, correct shot inspector, explicit update/create actions.
2. **Camera correctness:** visual shot editing, stable artwork framing, coordinate fixes, endpoint visibility investigation.
3. **Viewer parity:** shared evaluation, save/reload, authored-camera selection, sequence switching, and handoff.
4. **Authoring workflow:** context menus, keyframe strip, retiming, duplication, and boundary locking.
5. **Polish:** persistent layout, guide options, shortcut help, accessibility, and final interaction cleanup.

## Validation

- Unit tests for idle detection, selection, shot updates, projection round-trips, constraints, retiming, collisions, and serialization.
- Interaction tests for deselection, menus, dragging, cancellation, inspector switching, and undo.
- Editor/Viewer parity tests using the same saved fixture and timestamps.
- Visual checks at narrow/wide sizes and normal/high DPI, with authorization before launching apps.
- Run `bun run typecheck`, `bun test`, and both renderer builds.
- Use disposable fixtures; never save-test against repository `data/`.
- If portable packaging is requested, run its portable and release audits afterward.

## Completion criteria

Select an existing shot, reframe it without creating another, change aspect ratio at any time, use context menus, retime and undo reliably, save, and see matching playback in Viewer—with correct idle behavior.
