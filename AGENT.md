# AGENT.md — Agent Peers MCP

Instructions for AI agents working on this codebase.

---

## Cross-Platform Requirement

**All code must be OS-independent.** This project runs on macOS, Linux, and Windows.

### Prohibited patterns

| Pattern | Reason | Alternative |
|---------|--------|-------------|
| `which <cmd>` | Unix only | `process.platform === "win32" ? "where <cmd>" : "which <cmd>"` |
| `lsof -ti:<port>` | Unix only | Branch on `process.platform` |
| `kill -9` / `xargs` | Unix only | Branch on `process.platform` |
| `cmd &` (background) | Unix only | Branch on `process.platform` |
| `new URL(...).pathname` | Returns `/C:/...` on Windows | Use `fileURLToPath(new URL(...))` |
| `str.replace(cwd + "/", "")` | Hardcoded `/` separator | Use `path.relative(cwd, str)` |
| `/proc/<pid>/cwd` | Linux only | `Bun.spawn(["readlink", ...])` or platform branch |
| `ps aux` | Unix only | Platform branch or `Bun.spawn` with detection |
| `path.join(...)` → TOML/JSON string | Windows `\` breaks config files | Convert to `/` with `.replace(/\\/g, "/")` |

### Safe cross-platform APIs

- `process.platform` — `"win32"` | `"darwin"` | `"linux"`
- `os.homedir()` — cross-platform home directory
- `path.join()` / `path.resolve()` / `path.relative()` — use OS-native separators for filesystem ops
- `fileURLToPath(new URL(..., import.meta.url))` — correct file path from ESM URL on all OS
- `process.kill(pid, 0)` — liveness check, cross-platform
- `process.pid` / `process.ppid` — cross-platform
- `Bun.spawn(["git", ...])` — git is cross-platform
- `bun:sqlite` / `fs` / `os` — all cross-platform

---

## File Path Conventions

### In the VSCode extension (`src/extension/`)

Always resolve runtime asset paths via `extensionContext.extensionUri`, never hardcode absolute paths:

```typescript
// Broker script
vscode.Uri.joinPath(extensionContext.extensionUri, "out", "broker", "index.js").fsPath

// MCP server script
vscode.Uri.joinPath(extensionContext.extensionUri, "out", "server", "index.js").fsPath
```

The `out/` directory is always present in the installed extension. The `src/` directory is NOT present in the installed extension — never reference `src/` in runtime code.

### In the MCP server (`src/server/`)

Use `fileURLToPath` to resolve sibling files:

```typescript
import { fileURLToPath } from "url";

// Dev: resolves to src/broker/index.ts
// Prod: resolves to out/broker/index.js
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const brokerScript = fileURLToPath(new URL(`../broker/index${ext}`, import.meta.url));
```

---

## Build & Install Workflow

The source of truth for verification is the **locally installed VSCode extension**, not `src/` or `out/` directly.

### Build and install

```bash
just vsix
```

This runs:
1. `bun run build` — compiles all TypeScript to `out/`
2. `npx @vscode/vsce package` — packages into `agent-peers-mcp-0.1.0.vsix`
3. `code --install-extension agent-peers-mcp-0.1.0.vsix` — installs into VSCode

The installed extension lives at:
```
~/.vscode/extensions/agent-peers.agent-peers-mcp-0.1.0/
├── out/
│   ├── broker/index.js   ← broker daemon
│   ├── server/index.js   ← MCP server
│   └── extension/index.js ← VSCode extension entry
└── package.json
```

### Verify a change

1. Make code changes in `src/`
2. Run `just vsix` to rebuild and reinstall
3. In VSCode: **Developer: Reload Window** (Ctrl+Shift+P)
4. Observe behavior via the Agent Peers sidebar panel

Do NOT test by running `src/` files directly or inspecting `out/` — always verify through the installed extension after a reload.

---

## Build System

The project uses `esbuild` (not `bun build`). Each component is bundled independently:

```
bun run build:broker    → out/broker/index.js   (platform=node, format=cjs)
bun run build:server    → out/server/index.js   (platform=node, format=cjs)
bun run build:extension → out/extension/index.js (platform=node, format=cjs, external:vscode)
```

- The broker uses `better-sqlite3` (native module) — it is marked `--external` and must be installed in the environment where the broker runs
- The VSCode extension marks `vscode` as external — it is provided by the host

---

## Architecture Summary

```
VSCode Extension (out/extension/index.js)
  └── spawns/connects to →  Broker daemon (out/broker/index.js)  :7899 HTTP / :7900 WS
                                └── SQLite DB (~/.agent-peers.db, shared across workspaces for the current OS user)

AI agent (Claude Code, Codex, etc.)
  └── runs MCP server (out/server/index.js) via stdio
        └── registers with / polls → Broker daemon
```

- The broker is a singleton; multiple MCP server instances all share one broker
- The extension connects to the broker via HTTP (polling) and WebSocket (real-time events)
- Discovered peers (detected via process scan) appear with `connected: false`; registered peers have `connected: true`
