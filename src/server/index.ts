#!/usr/bin/env bun
/**
 * agent-peers MCP server
 *
 * Spawned by AI tools (Claude Code, Codex, Copilot Chat, etc.) as a stdio MCP server.
 * Connects to the shared broker daemon for peer discovery, messaging, and context sharing.
 *
 * Key differences from claude-peers:
 *   - Multi-agent: registers with agentType so different AI tools can discover each other
 *   - Structured context: shares active files, git state, current task — not just a text summary
 *   - Enhanced tools: share_context, request_context for deep collaboration
 *
 * Usage:
 *   claude mcp add --scope user --transport stdio agent-peers -- bun ~/agent-peers-mcp/src/server/index.ts
 *
 * Environment:
 *   AGENT_PEERS_AGENT_TYPE  — "claude-code" | "codex" | "copilot-chat" | "cursor" | "generic"
 *   AGENT_PEERS_PORT        — broker HTTP port (default 7899)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  AgentType,
  AgentContext,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  MessageType,
} from "../shared/types.ts";
import {
  DEFAULT_BROKER_PORT,
  BROKER_HOST,
  POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "../shared/constants.ts";
import {
  gatherGitContext,
  getGitRoot,
  getTty,
  generateSummary,
  getGitBranch,
  getModifiedFiles,
} from "../shared/context.ts";

// ─── Configuration ─────────────────────────────────────────────

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const AGENT_TYPE = (process.env.AGENT_PEERS_AGENT_TYPE ?? "claude-code") as AgentType;
const BROKER_SCRIPT = new URL("../broker/index.ts", import.meta.url).pathname;

// ─── Broker communication ──────────────────────────────────────

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// ─── Utility ───────────────────────────────────────────────────

function log(msg: string) {
  console.error(`[agent-peers] ${msg}`);
}

// ─── State ─────────────────────────────────────────────────────

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// ─── MCP Server ────────────────────────────────────────────────

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the agent-peers network. Other AI agent instances (Claude Code, Codex, GitHub Copilot Chat, Cursor, etc.) on this machine can discover you, send you messages, and share structured context.

IMPORTANT: When you receive a <channel source="agent-peers" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply using send_message, then resume your work.

Available tools:
- list_peers: Discover other AI agent instances (scope: machine/directory/repo)
- send_message: Send a message or task handoff to another instance
- share_context: Share your current structured context (active files, git state, task)
- request_context: Request another peer's full structured context
- set_summary: Set a brief summary of what you're working on
- check_messages: Manually check for new messages

When you start, proactively call share_context to publish your current state. This helps other agents understand what you're working on.`,
  }
);

// ─── Tool definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other AI agent instances running on this machine. Returns their ID, agent type (claude-code/codex/copilot-chat/cursor), working directory, git repo, and current context summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: '"machine" = all instances. "directory" = same working directory. "repo" = same git repository.',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another AI agent instance. Supports types: 'text' (general), 'context-request' (ask for context), 'task-handoff' (delegate a task).",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target agent (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message text",
        },
        type: {
          type: "string" as const,
          enum: ["text", "context-request", "task-handoff"],
          description: "Message type (default: text)",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "share_context",
    description:
      "Share your current structured context with the network. This publishes: your summary, active files, git state (branch, modified files, diff), and current task. Other agents can see this when listing peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "Brief 1-2 sentence summary of your current work",
        },
        current_task: {
          type: "string" as const,
          description: "Description of the specific task you're working on",
        },
        active_files: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Paths of files you're actively working on",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "request_context",
    description:
      "Request another peer's full structured context (active files, git diff, task description). The response includes everything they've shared.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: {
          type: "string" as const,
          description: "The peer ID to request context from",
        },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "set_summary",
    description: "Set a brief summary (1-2 sentences) of what you are currently working on.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Manually check for new messages from other AI agent instances.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          gitRoot: myGitRoot,
          excludeId: myId,
        });

        if (peers.length === 0) {
          return { content: [{ type: "text" as const, text: `No other agents found (scope: ${scope}).` }] };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Agent: ${p.agentType}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.gitRoot) parts.push(`Repo: ${p.gitRoot}`);
          if (p.context.summary) parts.push(`Summary: ${p.context.summary}`);
          if (p.context.currentTask) parts.push(`Task: ${p.context.currentTask}`);
          if (p.context.activeFiles?.length) {
            parts.push(`Active files: ${p.context.activeFiles.map((f) => f.relativePath || f.path).join(", ")}`);
          }
          if (p.context.git?.branch) parts.push(`Branch: ${p.context.git.branch}`);
          parts.push(`Last seen: ${p.lastSeen}`);
          return parts.join("\n  ");
        });

        return {
          content: [{ type: "text" as const, text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "send_message": {
      const { to_id, message, type: msgType } = args as { to_id: string; message: string; type?: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };

      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          fromId: myId,
          toId: to_id,
          type: (msgType ?? "text") as MessageType,
          text: message,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "share_context": {
      const { summary, current_task, active_files } = args as {
        summary: string;
        current_task?: string;
        active_files?: string[];
      };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };

      try {
        const gitCtx = await gatherGitContext(myCwd);
        const activeFiles = (active_files ?? []).map((f) => ({
          path: f,
          relativePath: f.replace(myCwd + "/", ""),
        }));

        const context: Partial<AgentContext> = {
          summary,
          currentTask: current_task,
          activeFiles,
          git: gitCtx,
          updatedAt: new Date().toISOString(),
        };

        await brokerFetch("/update-context", { id: myId, context });
        return {
          content: [{
            type: "text" as const,
            text: `Context shared. Summary: "${summary}"` +
              (gitCtx ? `\nBranch: ${gitCtx.branch}, Modified: ${gitCtx.modifiedFiles?.length ?? 0} files` : "") +
              (activeFiles.length ? `\nActive files: ${activeFiles.map((f) => f.relativePath).join(", ")}` : ""),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "request_context": {
      const { peer_id } = args as { peer_id: string };
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          gitRoot: myGitRoot,
        });
        const peer = peers.find((p) => p.id === peer_id);
        if (!peer) return { content: [{ type: "text" as const, text: `Peer ${peer_id} not found` }], isError: true };

        const ctx = peer.context;
        const parts = [
          `=== Context for peer ${peer_id} (${peer.agentType}) ===`,
          `CWD: ${peer.cwd}`,
          `Summary: ${ctx.summary || "(none)"}`,
        ];
        if (ctx.currentTask) parts.push(`Task: ${ctx.currentTask}`);
        if (ctx.activeFiles?.length) {
          parts.push(`Active files:\n  ${ctx.activeFiles.map((f) => f.relativePath || f.path).join("\n  ")}`);
        }
        if (ctx.git) {
          parts.push(`Git branch: ${ctx.git.branch}`);
          if (ctx.git.modifiedFiles?.length) parts.push(`Modified files:\n  ${ctx.git.modifiedFiles.join("\n  ")}`);
          if (ctx.git.stagedFiles?.length) parts.push(`Staged files:\n  ${ctx.git.stagedFiles.join("\n  ")}`);
          if (ctx.git.diff) parts.push(`Diff summary:\n${ctx.git.diff}`);
        }
        if (ctx.metadata) {
          parts.push(`Metadata: ${JSON.stringify(ctx.metadata)}`);
        }
        parts.push(`Last updated: ${ctx.updatedAt}`);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        await brokerFetch("/update-context", { id: myId, context: { summary } });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "check_messages": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        const lines = result.messages.map((m) =>
          `[${m.type}] From ${m.fromId} (${m.sentAt}):\n${m.text}`
        );
        return { content: [{ type: "text" as const, text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Polling loop ──────────────────────────────────────────────

async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      let fromSummary = "";
      let fromCwd = "";
      let fromAgent = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, gitRoot: myGitRoot });
        const sender = peers.find((p) => p.id === msg.fromId);
        if (sender) {
          fromSummary = sender.context.summary;
          fromCwd = sender.cwd;
          fromAgent = sender.agentType;
        }
      } catch { /* non-critical */ }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.fromId,
            from_agent: fromAgent,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            message_type: msg.type,
            sent_at: msg.sentAt,
          },
        },
      });
      log(`Pushed message from ${msg.fromId} (${fromAgent}): ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Startup ───────────────────────────────────────────────────

async function main() {
  await ensureBroker();

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`Agent type: ${AGENT_TYPE}`);
  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);

  // Gather initial context
  const gitCtx = await gatherGitContext(myCwd);
  let initialSummary = "";

  // Try auto-summary (non-blocking)
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getModifiedFiles(myCwd);
      const summary = await generateSummary({ cwd: myCwd, gitRoot: myGitRoot, gitBranch: branch, recentFiles });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // Register
  const initialContext: AgentContext = {
    summary: initialSummary,
    activeFiles: [],
    git: gitCtx,
    updatedAt: new Date().toISOString(),
  };

  const reg = await brokerFetch<RegisterResponse>("/register", {
    agentType: AGENT_TYPE,
    pid: process.pid,
    cwd: myCwd,
    gitRoot: myGitRoot,
    tty,
    context: initialContext,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // Late summary update
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/update-context", { id: myId, context: { summary: initialSummary } });
        } catch { /* non-critical */ }
      }
    });
  }

  // Connect MCP
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // Start polling & heartbeat
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try { await brokerFetch("/heartbeat", { id: myId }); } catch { /* */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try { await brokerFetch("/unregister", { id: myId }); log("Unregistered"); } catch { /* */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
