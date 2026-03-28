# Agent Peers MCP

This is the agent-peers-mcp project — a cross-agent context sharing system.

## Project Structure

```
src/
  shared/     — Shared types, constants, utilities
  broker/     — Broker daemon (HTTP + WebSocket, SQLite-backed)
  server/     — MCP server (stdio, spawned per agent instance)
  extension/  — VSCode extension (sidebar UI, real-time updates)
```

## Key Concepts

- **Broker**: Singleton daemon on localhost:7899 (HTTP) + :7900 (WebSocket)
- **Peers**: AI agent instances (Claude Code, Codex, Copilot Chat, etc.)
- **Context**: Structured data (summary, active files, git state, current task)
- **Messages**: Text, context-request, context-response, task-handoff

## Development

```bash
bun install
bun run dev:broker    # Start broker daemon
bun run dev:server    # Start MCP server (for testing)
bun run watch         # Watch-build VSCode extension
```

## Environment Variables

- `AGENT_PEERS_PORT` — Broker HTTP port (default: 7899)
- `AGENT_PEERS_WS_PORT` — Broker WebSocket port (default: 7900)
- `AGENT_PEERS_AGENT_TYPE` — Agent type: claude-code, codex, copilot-chat, cursor, generic
- `OPENAI_API_KEY` — For auto-summary generation (optional)
