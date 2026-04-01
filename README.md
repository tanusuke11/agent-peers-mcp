# agent-peers

Cross-agent context sharing for AI coding assistants. Let Claude Code, Codex, GitHub Copilot Chat, and other AI tools discover each other, share structured context, and collaborate in real-time.

```
  Claude Code (poker-engine)        Codex (api-server)           VSCode Extension
  ┌────────────────────────┐       ┌────────────────────────┐   ┌──────────────────┐
  │ "Working on auth flow" │──────▶│ "Refactoring routes"   │   │ 🟠 claude abc123 │
  │ Branch: feat/auth      │       │ Branch: main           │   │ 🟢 codex  def456 │
  │ Files: auth.ts, db.ts  │◀──────│ Files: routes.ts       │   │ 🔵 copilot ghi789│
  └────────────────────────┘       └────────────────────────┘   │                  │
         │                                  │                    │ 📝 Shared Context│
         └──────────────┬───────────────────┘                    │ 💬 Messages      │
                        ▼                                        └──────────────────┘
              ┌───────────────────┐
              │  Broker Daemon    │
              │  HTTP + WebSocket │
              │  SQLite           │
              └───────────────────┘
```

## Features

### 🔗 Multi-Agent Discovery
Discover all AI agent instances on your machine — regardless of which tool they're running in. Each peer registers with its agent type (`claude-code`, `codex`, `copilot-chat`, `cursor`, etc.).

### 📊 Structured Context Sharing
Go beyond text summaries. Share and inspect:
- **Active files** being edited
- **Git state** (branch, modified files, staged files, abbreviated diff)
- **Current task** description
- **Custom metadata** (extensible key-value pairs)

### ⚡ Real-Time Updates
WebSocket connection pushes events instantly:
- Peer join/leave notifications
- New messages arrive immediately
- Context updates broadcast to all listeners

### 🖥️ VSCode Extension
Sidebar with three views:
- **Peers**: See all connected agents with type, summary, and expandable details
- **Messages**: Real-time message feed between agents
- **Shared Context**: Browse each peer's active files, git state, and tasks

## Quick Start

### 1. Install

```bash
git clone <repo-url> ~/agent-peers-mcp
cd ~/agent-peers-mcp
bun install
```

### 2. Register the MCP server

**For Claude Code:**
```bash
claude mcp add --scope user --transport stdio agent-peers -- bun ~/agent-peers-mcp/src/server/index.ts
```

**For Codex:**
```bash
# Set the agent type via environment variable
AGENT_PEERS_AGENT_TYPE=codex claude mcp add --scope user --transport stdio agent-peers -- bun ~/agent-peers-mcp/src/server/index.ts
```

**For any MCP-compatible tool**, add to your MCP config:
```json
{
  "agent-peers": {
    "command": "bun",
    "args": ["/path/to/agent-peers-mcp/src/server/index.ts"],
    "env": {
      "AGENT_PEERS_AGENT_TYPE": "copilot-chat"
    }
  }
}
```

### 3. Run Claude Code with channel support

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers
```

### 4. Open a second session and try it

```
> List all peers on this machine
> Send a message to peer [id]: "what are you working on?"
> Share your current context
> Request context from peer [id]
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_peers` | Discover all AI agent instances (scope: machine/directory/repo) |
| `send_message` | Send text, context-request, task-handoff, or report messages (extension peers accept only report replies to prior task-handoffs) |
| `share_context` | Publish your structured context (files, git, task) |
| `request_context` | Get another peer's full structured context |
| `set_summary` | Set a brief summary of your current work |
| `check_messages` | Manually check for new messages |

## Architecture

```
src/
├── shared/          Shared types, constants, utilities
│   ├── types.ts     All data structures (Peer, Message, AgentContext, WsEvent, etc.)
│   ├── constants.ts Ports, intervals, paths
│   └── context.ts   Git helpers, file context, auto-summary
├── broker/          Singleton daemon (one per machine)
│   └── index.ts     HTTP API + WebSocket server + SQLite
├── server/          MCP server (one per agent instance)
│   └── index.ts     stdio MCP with 6 tools
├── extension/       VSCode extension
│   ├── index.ts     Extension entry point
│   ├── broker-client.ts  HTTP + WebSocket client
│   └── views/       Tree data providers
│       ├── peer-list.ts
│       ├── messages.ts
│       └── context.ts
└── cli.ts           Command-line utility
```

## CLI

```bash
bun src/cli.ts status          # Show broker status
bun src/cli.ts peers           # List all peers with context
bun src/cli.ts send <id> <msg> # Send a message
bun src/cli.ts context <id>    # Show peer's full context
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGENT_PEERS_PORT` | `7899` | Broker HTTP port |
| `AGENT_PEERS_WS_PORT` | `7900` | Broker WebSocket port |
| `AGENT_PEERS_AGENT_TYPE` | `claude-code` | Agent type identifier |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite database path |
| `OPENAI_API_KEY` | — | For auto-summary generation (optional) |

## VSCode Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentPeers.brokerPort` | `7899` | Broker daemon port |
| `agentPeers.autoStartBroker` | `true` | Auto-start broker on activation |
| `agentPeers.pollIntervalMs` | `1000` | Message polling interval |

## License

MIT
