# BA Spine Editor desktop host

This package embeds the editor renderer in an Electrobun window and provides native folder/file dialogs plus the scoped local filesystem bridge.

Run from the workspace root:

```sh
bun run dev:editor
bun run build:editor
```

For development, `BA_SPINE_DATA` may point to a library root; otherwise the app offers `./data/` as its initial folder. The host binds only to loopback, injects a per-run API token into its renderer, and permits writes only to supported authored project, sequence, workspace, and subtitle JSON files. The viewer host has no write endpoint.

Optional Editor MCP tools are available with `bun run dev:editor -- --mcp`; they remain local and are disabled by default. From the workspace root, `bun run mcp` starts the stdio bridge (the repo-local OpenCode config in `.opencode/opencode.json` does the same) and attaches to that running development Editor. Start with `editor_state`, `editor_get_sequence`, and `editor_get_animation_info`; subtitle imports require an explicit preview policy before apply. Clip and cue edits are undoable in the Editor and remain in memory until `editor_save`. MCP saves refuse external file conflicts and read back each written file for verification.
