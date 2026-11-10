# Plan: Full Editor Feature Support over MCP

## Goal

Make every meaningful Editor workflow accessible through typed MCP tools: project management, interactions, behavior graphs, timeline editing, audio, subtitles, camera authoring, preview/testing, undo/redo, and safe persistence.

“Full support” means feature parity—not simulated mouse clicks or arbitrary JavaScript execution.

## Current gaps

The existing server registers 40 tools. It supports asset navigation, timeline inspection, animation clips, subtitle cues/imports, partial layer/color editing, preview controls, and safe saving.

Major missing areas:

- Interaction and region authoring.
- Look-follow and Patting controls.
- Behavior machines, states, actions, transitions, and graph layouts.
- Camera tracks, bounds, and keyframes.
- Audio import, editing, relinking, and subtitle links.
- Sequence creation, deletion, ordering, and settings.
- Complete layer and multi-selection operations.
- Undo/redo and recovery workflows.
- Interaction/behavior inspection and runtime testing.

Two foundation issues also need addressing:

- `editor_capabilities` currently lists only part of the existing tool surface.
- Several tools depend on the Timeline workspace being mounted rather than operating directly on project data.

---

## 1. Establish a complete feature contract

Create a coverage matrix connecting each Editor feature to:

- Its inspection tool.
- Its editing or execution tools.
- Authored versus temporary state.
- Undo behavior.
- Persistence behavior.
- Validation and regression coverage.

Use the existing UI handlers, context menus, command palette, and models as the inventory.

### Completion rule

Every supported UI operation must either have an MCP equivalent or a documented exclusion. Cosmetic UI mechanics—opening a menu or dragging a divider—do not require individual tools when an equivalent semantic operation exists.

---

## 2. Strengthen the command architecture

### Shared typed command registry

Introduce a registry defining each operation’s:

- Input schema and command type.
- Description and MCP annotations.
- Revision requirements.
- Mutation category.
- Applicable workspace/build capabilities.
- Handler and result shape.

Generate MCP registrations and capability reporting from this registry where practical. Keep validation at the native boundary; do not trust MCP-side validation alone.

This eliminates drift between:

- `apps/editor/desktop/scripts/mcp-server.ts`
- `packages/editor-feature/src/editorMcp.ts`
- Renderer command handlers.

### Separate document operations from rendering

Extract reusable authoring operations from `Editor.tsx`, `TimelineWorkspace.tsx`, and `BehaviorEditor.tsx`.

Both UI and MCP should call the same operations so they share:

- Lock enforcement.
- Normalization.
- Reference cleanup.
- Friendly-control synchronization.
- Undo history.
- Dirty-state handling.

Document reads and edits should work regardless of the active workspace. Rendering-dependent operations should explicitly report readiness requirements rather than silently switch workspaces.

### Consistent responses

Return a common envelope containing:

- Project identity.
- Command/request ID.
- Before/after document revisions.
- Affected and created entity IDs.
- Warnings and normalization results.
- Current save state.

Add structured error codes for stale revisions, invalid references, locked entities, unavailable renderers, conflicts, and unsupported capabilities.

---

## 3. Complete inspection and discovery

Extend read tools to expose:

- Full authored project settings.
- All sequences without selecting each one.
- Interactions and regions.
- Canonical behavior machines and graph layouts.
- Camera tracks, bounds, and keyframes.
- Audio metadata and subtitle links.
- Bone paths, hierarchy, and useful runtime metadata.
- Current selection, undo/redo availability, and preview/test state.

Keep `editor_state` lightweight. Use domain-specific detail tools and pagination for large collections.

Capabilities should report the complete registered surface, protocol version, availability, and any build-specific restrictions.

---

## 4. Add interaction and behavior authoring

### Friendly interactions

Support:

- Add, update, duplicate, delete, and select interactions.
- Add, update, duplicate, delete, and select regions.
- Region shape, size, position, rotation, enabled state, and bone anchoring.
- Phase animation settings and detection.
- Head-placement helpers.
- All Look-follow, Patting, drag, rotation, smoothing, and return settings.

### Behavior machines

Support:

- Create from blank or existing presets.
- Update, duplicate, enable/disable, reorder where applicable, and delete machines.
- Edit activation, priorities, exclusive groups, resource claims, initial state, and cancellation policy.
- Create/update/delete states.
- Add/update/remove/reorder enter, exit, and cancel actions.
- Create/update/delete transitions and their conditions.
- Edit graph placement and selection.

Action and condition inputs must be discriminated schemas covering every existing supported type.

Actions currently use array positions rather than IDs. Address them using machine/state/phase/index plus revision checks unless stable IDs become necessary; avoid an unnecessary project-format migration.

### Preserve canonical behavior

Reuse the recently added synchronization helpers:

- Authored machines remain authoritative.
- Friendly controls update compatible machine values.
- Unrelated authored actions remain intact.
- Legacy-generated machines retain their intended compatibility behavior.
- Save/reopen preserves the same values.

State or machine deletion must explicitly handle dependent transitions and cross-machine references. Report cleanup rather than silently dropping unrelated data.

---

## 5. Complete timeline authoring

### Sequences and project settings

Expose:

- Add, delete, and reorder supported sequences.
- Entry-sequence selection.
- Duration mode, duration, looping, and opening settings.
- Talk mix duration and effects strength.
- Subtitle language and applicable timeline settings.
- Playback speed and supported sequence-preview modes.

Preserve Opening ordering and intentional-deletion rules.

### Layers and clips

Complete:

- Spine-layer creation, duplication where supported, and removal.
- Color-layer/clip duplication and deletion.
- All existing inspector fields.
- Animation length matching.
- Clip splitting, trimming, duplication, and movement where supported.
- Multi-selection and bulk enable/disable/delete.
- Copy/paste equivalents through structured payloads, not the OS clipboard.
- Explicit ripple and linked-item policies.

Operations must target explicit IDs rather than depend on whatever the UI currently has selected.

---

## 6. Add audio and finish subtitle workflows

### Audio

Support:

- Discover root-relative audio files and inspect metadata.
- Import existing files into sequences.
- Update timing, enabled state, volume, and automatic/manual endpoints.
- Duplicate, remove, and relink clips.
- Match duration to decoded audio.
- Link/unlink subtitle cues.
- Preview and stop audio.

Reuse current audio duration and one-to-one subtitle-link rules.

### Subtitles

Complete:

- Duplicate, select, search, and navigate cues.
- Supported subtitle-document opening/import workflows.
- Explicit audio-link operations.
- Read source/dirty-state information.

Retain preview-before-apply imports and never invent missing translations.

Root-relative imports must remain contained within the selected asset root, including protection against symlink/junction escapes where filesystem resolution is involved.

---

## 7. Add full camera support

Expose:

- Read/update camera track settings.
- Enable/disable camera.
- Change aspect ratio using the existing width-preserving conversion.
- Set reference layer and global constraint.
- Add/update/duplicate/delete safe bounds.
- Add/update/duplicate/delete/retime keyframes.
- Configure easing and per-shot constraints.
- Fit a shot to a bound and create fitted shots.
- Read the evaluated camera at an explicit time.
- Frame selected shots or bounds in the editor view.

Use explicit world-space coordinates and document units. Keep viewport pan/zoom separate from authored camera changes.

Respect bound locks and existing deletion/reference-repair behavior.

---

## 8. Expand preview, runtime testing, and diagnostics

Add semantic controls for:

- Interaction phase previews.
- Start/release/cancel/replay interaction tests.
- Look-follow testing.
- Behavior event injection and cancellation.
- Runtime machine state, variables, claims, conflicts, and feedback.
- Interaction, camera-output, and behavior-graph captures where technically supported.

Testing must use the same runtime path as the UI—not a separate approximation.

Document coordinate spaces for pointer-driven tests. Ensure tests can be stopped cleanly and do not alter authored data.

Extend validation beyond active-sequence timing to include:

- Missing animations, bones, audio, and subtitle references.
- Invalid behavior targets and initial states.
- Broken cross-machine conditions.
- Camera reference/constraint issues.
- Missing sequence and entry-sequence references.

Offer active-sequence and whole-project scopes with bounded results.

---

## 9. Add undo, reviewed batches, and safe lifecycle tools

### History

Expose undo/redo and history availability through the existing project history.

Each semantic edit should produce one history entry. Temporary selection, playback, and viewport changes should not dirty the project.

### Reviewed batch editing

Add bounded preview/apply batches for authored edits:

1. Validate commands against a draft.
2. Return the proposed diff and warnings.
3. Issue a short-lived change-set token.
4. Apply only to the same host, project, and revision.
5. Commit as one undoable edit.

Reject the whole batch if any operation fails. Exclude filesystem saves and runtime side effects from atomic authoring batches.

### Project lifecycle

Add supported project-file opening and recovery inspection/restoration.

Retain refusal to replace unsaved work by default. Destructive replacement or recovery actions need explicit policies and revision checks; no implicit discard or overwrite.

Keep save explicit, retain external-change conflict detection and read-back verification, and clearly report partial write failures if they occur.

---

## 10. Harden concurrency and transport behavior

- Preserve existing explicit host selection.
- Bind reviewed change sets to host and project identity.
- Recheck revisions immediately before execution.
- Serialize authored edits.
- Add request IDs and bounded deduplication so retries do not duplicate creations.
- Distinguish canceled-before-start from started-with-unknown-outcome.
- Apply queue, body, batch, and result-size limits.
- Keep tokens private and preserve authenticated loopback access.
- Never add arbitrary shell, JavaScript, or unrestricted filesystem tools.

Preserve existing tool names and inputs where possible. Advertise additions through capabilities; introduce a protocol version change only for genuinely incompatible contracts.

---

## Implementation order

| Phase | Deliverable |
|---|---|
| 1 | Feature inventory, shared registry, accurate capabilities, structured results |
| 2 | Workspace-independent project inspection and command operations |
| 3 | Interactions, friendly controls, behavior machines, and graph editing |
| 4 | Camera authoring |
| 5 | Sequence/layer/clip completeness, audio, and subtitle workflows |
| 6 | Runtime testing, captures, and whole-project diagnostics |
| 7 | Undo/redo, reviewed batches, lifecycle safety, and documentation |

Add tests alongside each phase rather than postponing them.

## Verification

### Automated coverage

- Schema acceptance/rejection and registry completeness.
- UI/MCP operation parity.
- Revision conflicts and concurrent edits.
- Lock enforcement and reference cleanup.
- Undo/redo and batch rollback.
- Behavior/friendly-control synchronization.
- Save/reopen and legacy migration.
- Camera conversion and constraint behavior.
- Audio/subtitle linking and duration handling.
- Path containment, host isolation, timeouts, and retry deduplication.
- MCP client-to-bridge-to-handler integration using disposable fixtures.

### Required checks

```text
bun run typecheck
bun test
bun --cwd=apps/editor run build:renderer
bun --cwd=apps/viewer run build:renderer
git diff --check
```

No save tests against repository `data/`. Live app validation only with authorization and disposable assets.

## Acceptance criteria

The work is complete when an MCP client can author and verify a project containing interactions, custom behaviors, multiple sequences, animation/color layers, linked audio/subtitles, and camera motion; undo/redo its changes; and explicitly save/reopen it without losing settings.

Every supported feature must appear in capabilities and have regression coverage or a documented limitation.
