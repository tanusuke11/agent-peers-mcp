# agent-peers

Cross-agent context sharing for AI coding assistants. Let Claude Code, Codex, GitHub Copilot Chat, and other AI tools discover each other, share structured context, and collaborate in real-time.

```
  Claude Code (poker-engine)        Codex (api-server)           VSCode Extension
  ┌────────────────────────┐       ┌────────────────────────┐   ┌──────────────────┐
  │ "Working on auth flow" │──────▶│ "Refactoring routes"   │   │ 🟠 claude abc123 │
  │ Branch: feat/auth      │       │ Branch: main           │   │ 🟢 codex  def456 │
  │ Files: auth.ts, db.ts  │◀──────│ Files: routes.ts       │   │                  │
  └────────────────────────┘       └────────────────────────┘   │ 💬 Messages      │
         │                                  │                    │ ⚠ Conflicts      │
         └──────────────┬───────────────────┘                    └──────────────────┘
                        ▼
              ┌───────────────────┐
              │  Broker Daemon    │
              │  HTTP + WebSocket │
              │  SQLite           │
              └───────────────────┘
```

## Features

### 🔗 Multi-Agent Discovery
Discover all AI agent instances on your machine — regardless of which tool they're running in. Each peer registers with its agent type (`claude-code`, `codex`, `copilot-chat`, `cursor`, etc.) and is shown with a unique animal emoji nickname.

### 📊 Structured Context Sharing
Go beyond text summaries. Share and inspect:
- **Active files** being edited
- **Git state** (branch, modified files, staged files, abbreviated diff)
- **Current task** description
- **Recent conversation digest** (last N exchanges, configurable)

### ⚡ Real-Time Updates
WebSocket connection pushes events instantly:
- Peer join/leave notifications
- New messages arrive immediately
- Context updates broadcast to all listeners

### ⚠ Conflict Detection
Automatically checks for file/area overlap with other agents:
- **Auto-check on every prompt** via a pre-tool-use hook (configurable)
- **Auto-check when sharing context** via `share_context`
- **Manual check** via the `check_conflicts` tool
- **Duplicate task-handoff guard**: broker blocks sending the same task twice (overridable with `force=true`)

### 🖥️ VSCode Extension
Sidebar with two views:
- **Control**: broker status, toggle auto-start, auto-delivery, auto-conflict-check; configure MCP for Claude Code / Codex
- **Peers**: all peers grouped by repo, with type, emoji nickname, expandable git state / active files / incoming messages

## Quick Start

### 1. Install

```bash
git clone <repo-url> ~/agent-peers-mcp
cd ~/agent-peers-mcp
bun install
just vsix            # build, package, and install the VSCode extension
```

### 2. Register the MCP server

The easiest way is to open the Agent Peers sidebar in VSCode and click **Config Claude Code to MCP** or **Config Codex to MCP** in the Control panel.

Alternatively, run the commands manually:

**For Claude Code:**
```bash
claude mcp add --scope user --transport stdio agent-peers \
  -- node ~/.vscode/extensions/agent-peers.agent-peers-mcp-0.1.0/out/server/index.js
```

**For Codex:**
```bash
AGENT_PEERS_AGENT_TYPE=codex \
claude mcp add --scope user --transport stdio agent-peers \
  -- node ~/.vscode/extensions/agent-peers.agent-peers-mcp-0.1.0/out/server/index.js
```

**For any MCP-compatible tool**, add to your MCP config:
```json
{
  "agent-peers": {
    "command": "node",
    "args": ["/home/you/.vscode/extensions/agent-peers.agent-peers-mcp-0.1.0/out/server/index.js"],
    "env": {
      "AGENT_PEERS_AGENT_TYPE": "copilot-chat"
    }
  }
}
```

### 3. Start a session

```bash
claude
```

The MCP server auto-starts the broker daemon on first use. No manual daemon management needed.

### 4. Try it

```
> List all peers on this machine
> Share your current context
> Send a message to peer [id]: "what are you working on?"
> Request context from peer [id]
> Check if my planned work conflicts with other agents
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `whoami` | Get your broker-assigned peer ID and registration info |
| `list_peers` | Discover all AI agent instances (scope: machine/directory/repo) |
| `send_message` | Send text, context-request, task-handoff, or report messages |
| `share_context` | Publish your structured context (files, git, task) + auto conflict check |
| `request_context` | Get another peer's full structured context |
| `set_summary` | Set a brief summary of your current work |
| `check_messages` | Manually check for new messages |
| `check_conflicts` | Check if planned work conflicts with other agents in the same repo |

### Message types

| Type | Description |
|------|-------------|
| `text` | General-purpose message |
| `context-request` | Ask a peer to share their current context |
| `task-handoff` | Delegate a task to another peer (duplicate guard applies) |
| `report` | Reply to a task-handoff with a work report (requires `reply_to`) |

> **Sleeping peers** (`suspended: true` in `list_peers`) cannot receive messages.

## Architecture

```
src/
├── shared/          Shared types, constants, utilities
│   ├── types.ts     All data structures (Peer, Message, AgentContext, WsEvent, etc.)
│   ├── constants.ts Ports, intervals, paths
│   ├── context.ts   Git helpers, file context, auto-summary
│   └── process.ts   Cross-platform process utilities
├── broker/          Singleton daemon (one per machine)
│   └── index.ts     HTTP API + WebSocket server + SQLite
├── server/          MCP server (one per agent instance)
│   └── index.ts     stdio MCP with 8 tools
├── extension/       VSCode extension
│   ├── index.ts     Extension entry point
│   ├── broker-client.ts  HTTP + WebSocket client
│   └── views/
│       ├── peer-list.ts  Peers tree view
│       └── control.ts    Control panel
└── hooks/
    └── check-conflicts.ts  Pre-tool-use conflict check hook
```

## CLI

```bash
bun src/cli.ts status          # Show broker status
bun src/cli.ts peers           # List all peers with context
bun src/cli.ts send <id> <msg> # Send a message
bun src/cli.ts context <id>    # Show peer's full context
```

## Configuration

### Environment variables (MCP server)

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PEERS_PORT` | `7899` | Broker HTTP port |
| `AGENT_PEERS_WS_PORT` | `7900` | Broker WebSocket port |
| `AGENT_PEERS_AGENT_TYPE` | `claude-code` | Agent type identifier |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite database path |
| `AGENT_PEERS_SOURCE` | auto-detected | Force peer source: `terminal` or `extension` |
| `AGENT_PEERS_TRUST_BROKER_ID_ONLY` | `true` | Instruct the agent to always call `whoami` for its peer ID |

### VSCode Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentPeers.brokerPort` | `7899` | Broker daemon port |
| `agentPeers.autoStartBroker` | `false` | Auto-start broker on extension activation |
| `agentPeers.pollIntervalMs` | `1000` | Message polling interval (ms) |
| `agentPeers.autoDeliveryMessage` | `true` | Auto-deliver incoming messages to the terminal; when off, messages require manual approval |
| `agentPeers.autoConflictCheck` | `true` | Run conflict check automatically before every prompt (via hook) and on `share_context` |
| `agentPeers.maxContextLength` | `10` | Number of recent conversation exchanges to include in the shared context digest |

## Build & Install

```bash
just vsix   # build all components, package VSIX, install extension
```

After installing, reload the VSCode window (**Developer: Reload Window**) and check the Agent Peers sidebar.

## License

MIT
