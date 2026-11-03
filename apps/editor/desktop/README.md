# BA Spine Editor desktop host

This package embeds the editor renderer in an Electrobun window and provides native folder/file dialogs plus the scoped local filesystem bridge.

Run from the workspace root:

```sh
bun run dev:editor
bun run build:editor
```

For development, `BA_SPINE_DATA` may point to a library root; otherwise the app offers `./data/` as its initial folder. The host binds only to loopback, injects a per-run API token into its renderer, and permits writes only to supported authored project, sequence, workspace, and subtitle JSON files. The viewer host has no write endpoint.

Optional editor MCP tools are available with `--mcp`; they remain local and are disabled by default.
