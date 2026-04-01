#!/usr/bin/env node
/**
 * agent-peers MCP server
 *
 * Spawned by AI tools (Claude Code, Codex, etc.) as a stdio MCP server.
 * Connects to the shared broker daemon for peer discovery, messaging, and context sharing.
 *
 * Key differences from claude-peers:
 *   - Multi-agent: registers with agentType so different AI tools can discover each other
 *   - Structured context: shares active files, git state, current task — not just a text summary
 *   - Enhanced tools: share_context, request_context for deep collaboration
 *
 * Usage:
 *   claude mcp add --scope user --transport stdio agent-peers -- node ~/.vscode/extensions/agent-peers.agent-peers-mcp-0.1.0/out/server/index.js
 *
 * Environment:
 *   AGENT_PEERS_AGENT_TYPE  — "claude-code" | "codex" | "generic"
 *   AGENT_PEERS_PORT        — broker HTTP port (default 7899)
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type {
  PeerId,
  Peer,
  AgentType,
  AgentContext,
  TaskIntent,
  ActiveFile,
  Message,
  RegisterResponse,
  PollMessagesResponse,
  MessageType,
  WsEvent,
  WsMessageEvent,
  GitContext,
} from "../shared/types.ts";
import path from "path";
import WebSocket from "ws";
import {
  DEFAULT_BROKER_PORT,
  DEFAULT_WS_PORT,
  BROKER_HOST,
  HEARTBEAT_INTERVAL_MS,
} from "../shared/constants.ts";
import { onProcessTermination } from "../shared/process.ts";
import {
  gatherGitContext,
  getGitRoot,
  getTty,
} from "../shared/context.ts";

// ─── Configuration ─────────────────────────────────────────────

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const WS_PORT = parseInt(process.env.AGENT_PEERS_WS_PORT ?? String(DEFAULT_WS_PORT), 10);
const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const BROKER_WS_URL = `ws://${BROKER_HOST}:${WS_PORT}`;
const AGENT_TYPE = (process.env.AGENT_PEERS_AGENT_TYPE ?? "claude-code") as AgentType;
const BROKER_SCRIPT = path.join(__dirname, "..", "broker", "index.js");

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

const BROKER_LOCK = path.join(os.tmpdir(), "agent-peers-broker.lock");

/**
 * Read the Claude Code session title (ai-title) from the session JSONL file.
 * Works by finding `--resume <sessionId>` in the parent process's command line.
 */
/**
 * Get the command-line arguments of a process by PID (cross-platform).
 * Linux: reads /proc/<pid>/cmdline
 * macOS: uses `ps -o args=`
 * Windows: uses `wmic`
 */
function getProcessArgs(pid: number): string[] | null {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    }
    const { execSync } = require("child_process") as typeof import("child_process");
    if (process.platform === "darwin") {
      return execSync(`ps -o args= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim().split(/\s+/);
    }
    if (process.platform === "win32") {
      const out = execSync(`wmic process where ProcessId=${pid} get CommandLine /format:list`, { encoding: "utf8", timeout: 3000 }).trim();
      const match = out.match(/CommandLine=(.*)/);
      return match ? match[1]!.split(/\s+/) : null;
    }
    return null;
  } catch { return null; }
}

/**
 * Get the parent PID of a process (cross-platform).
 * Linux: reads /proc/<pid>/status
 * macOS: uses `ps -o ppid=`
 * Windows: uses `wmic`
 */
function getParentPid(pid: number): number {
  try {
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const match = status.match(/PPid:\s*(\d+)/);
      return match ? parseInt(match[1]!, 10) : 0;
    }
    const { execSync } = require("child_process") as typeof import("child_process");
    if (process.platform === "darwin") {
      return parseInt(execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim(), 10) || 0;
    }
    if (process.platform === "win32") {
      const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /format:list`, { encoding: "utf8", timeout: 3000 }).trim();
      const match = out.match(/ParentProcessId=(\d+)/);
      return match ? parseInt(match[1]!, 10) : 0;
    }
    return 0;
  } catch { return 0; }
}

/** Find the Claude Code session JSONL file path by walking up the process tree. */
function findSessionFile(): string | null {
  try {
    let pid = process.ppid;
    let sessionId: string | null = null;

    for (let depth = 0; depth < 5 && pid > 1; depth++) {
      const cmdArgs = getProcessArgs(pid);
      if (!cmdArgs) break;

      const resumeIdx = cmdArgs.indexOf("--resume");
      if (resumeIdx !== -1 && cmdArgs[resumeIdx + 1]) {
        sessionId = cmdArgs[resumeIdx + 1]!;
        break;
      }
      pid = getParentPid(pid);
    }

    // If --resume not found, try ~/.claude/sessions/<PID>.json lookup
    // Claude Code writes {pid, sessionId, cwd} files there for every session.
    if (!sessionId) {
      let searchPid = process.ppid;
      for (let depth = 0; depth < 5 && searchPid > 1; depth++) {
        const sessionMeta = path.join(os.homedir(), ".claude", "sessions", `${searchPid}.json`);
        if (fs.existsSync(sessionMeta)) {
          try {
            const meta = JSON.parse(fs.readFileSync(sessionMeta, "utf8")) as { sessionId?: string };
            if (meta.sessionId) { sessionId = meta.sessionId; break; }
          } catch { /* skip */ }
        }
        searchPid = getParentPid(searchPid);
      }
    }

    const candidates = [myGitRoot, myCwd].filter(Boolean) as string[];

    // If we found a session ID, look for that specific session file
    if (sessionId) {
      for (const base of candidates) {
        const projectHash = base.replace(/[\\/]/g, "-");
        const sessionFile = path.join(os.homedir(), ".claude", "projects", projectHash, `${sessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) return sessionFile;
      }
    }

    // Fallback: find the most recently modified JSONL file in the project directory
    for (const base of candidates) {
      const projectHash = base.replace(/[\\/]/g, "-");
      const projectDir = path.join(os.homedir(), ".claude", "projects", projectHash);
      if (!fs.existsSync(projectDir)) continue;

      const files = fs.readdirSync(projectDir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => {
          const full = path.join(projectDir, f);
          return { path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

      if (files.length > 0) return files[0]!.path;
    }

    return null;
  } catch { return null; }
}

async function getClaudeSessionTitle(): Promise<string | null> {
  try {
    const file = findSessionFile();
    if (!file) return null;

    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line) as { type?: string; aiTitle?: string };
        if (obj.type === "ai-title" && obj.aiTitle) return obj.aiTitle;
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

const EXCHANGE_MAX_CHARS = 200;
const EXCHANGE_MAX_COUNT = 5;

/** Read recent human/assistant exchanges from the Claude Code session JSONL. */
function getRecentExchanges(): import("../shared/types.ts").RecentExchange[] {
  // Only Claude Code writes the ~/.claude session JSONL files we inspect below.
  // Other agent types (e.g., Codex) should not scrape these logs, otherwise they
  // may accidentally surface another tool's conversation history (as seen when a
  // Codex peer picked up the latest Claude session file in the same repo).
  if (AGENT_TYPE !== "claude-code") return [];

  try {
    const file = findSessionFile();
    if (!file) return [];

    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const exchanges: import("../shared/types.ts").RecentExchange[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if ((obj.type === "user" || obj.type === "assistant") && obj.message) {
          const msg = obj.message;
          const role = msg.role as "human" | "assistant" | undefined;
          if (role !== "human" && role !== "assistant") continue;

          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((b: { type?: string }) => b.type === "text")
              .map((b: { text?: string }) => b.text ?? "")
              .join(" ");
          }
          if (!text) continue;

          exchanges.push({
            role,
            text: text.length > EXCHANGE_MAX_CHARS ? text.slice(0, EXCHANGE_MAX_CHARS) + "…" : text,
            timestamp: obj.timestamp ?? new Date().toISOString(),
          });
        }
      } catch { /* skip */ }
    }

    return exchanges.slice(-EXCHANGE_MAX_COUNT);
  } catch { return []; }
}

// ─── Task Intent computation ────────────────────────────────

function computeTaskIntent(
  summary: string,
  currentTask: string | undefined,
  activeFiles: ActiveFile[],
  git: GitContext | null,
  baseline: string[],
): TaskIntent {
  const description = currentTask || summary || "";

  // targetFiles = (git modified - baseline) + activeFile relative paths
  const gitModified = git?.modifiedFiles ?? [];
  const baselineSet = new Set(baseline);
  const agentModified = gitModified.filter(f => !baselineSet.has(f));
  const activeRelPaths = activeFiles
    .map(f => f.relativePath)
    .filter((p): p is string => !!p);
  const targetFiles = [...new Set([...agentModified, ...activeRelPaths])];

  // targetAreas = unique directory prefixes (first 2 path segments)
  const targetAreas = [...new Set(targetFiles.map(f => {
    const parts = f.replace(/\\/g, "/").split("/");
    return parts.length > 1
      ? parts.slice(0, Math.min(2, parts.length - 1)).join("/")
      : ".";
  }))];

  // action heuristic from description text
  const text = `${summary} ${currentTask ?? ""}`.toLowerCase();
  let action = "update";
  if (/\brefactor/.test(text)) action = "refactor";
  else if (/\b(add|create|new|implement)\b/.test(text)) action = "add";
  else if (/\b(fix|bug|patch|repair)\b/.test(text)) action = "fix";
  else if (/\b(delete|remove|drop)\b/.test(text)) action = "delete";

  return { description, targetFiles, targetAreas, action };
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  // Use a lock file to prevent concurrent spawns across multiple MCP instances
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(BROKER_LOCK, "wx"); // exclusive create — fails if exists
  } catch {
    // Another process holds the lock — wait for broker to come up
    log("Another process is starting the broker, waiting...");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isBrokerAlive()) {
        log("Broker started by another process");
        return;
      }
    }
    throw new Error("Timed out waiting for broker started by another process");
  }

  try {
    log("Starting broker daemon...");
    const proc = spawn("node", [BROKER_SCRIPT], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
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
  } finally {
    fs.closeSync(lockFd);
    try { fs.unlinkSync(BROKER_LOCK); } catch { /* already removed */ }
  }
}

// ─── Utility ───────────────────────────────────────────────────

function log(msg: string) {
  console.error(`[agent-peers] ${msg}`);
}



// ─── State ─────────────────────────────────────────────────────

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
/** Files already modified at registration time — used to compute agent-only changes */
let baselineModifiedFiles: string[] = [];
/** Cached session title for taskIntent computation */
let cachedSessionTitle: string | null = null;

// ─── MCP Server ────────────────────────────────────────────────

const mcp = new McpServer(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: `You are connected to the agent-peers network. Other AI agent instances (Claude Code, Codex, etc.) on this machine can discover you, send you messages, and share structured context.

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

// ─── Tool handlers ─────────────────────────────────────────────

mcp.registerTool("list_peers", {
  description: "List other AI agent instances running on this machine. Returns their ID, agent type (claude-code/codex), working directory, git repo, and current context summary.",
  inputSchema: { scope: z.enum(["machine", "directory", "repo"]).describe('"machine" = all instances. "directory" = same working directory. "repo" = same git repository.') },
}, async ({ scope }) => {
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope, cwd: myCwd, gitRoot: myGitRoot, excludeId: myId });
    if (peers.length === 0) return { content: [{ type: "text" as const, text: `No other agents found (scope: ${scope}).` }] };
    const lines = peers.map((p) => {
      const parts = [`ID: ${p.id}`, `Agent: ${p.agentType}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
      if (p.gitRoot) parts.push(`Repo: ${p.gitRoot}`);
      if (p.context.summary) parts.push(`Summary: ${p.context.summary}`);
      if (p.context.currentTask) parts.push(`Task: ${p.context.currentTask}`);
      if (p.context.activeFiles?.length) parts.push(`Active files: ${p.context.activeFiles.map((f) => f.relativePath || f.path).join(", ")}`);
      if (p.context.git?.branch) parts.push(`Branch: ${p.context.git.branch}`);
      parts.push(`Last seen: ${p.lastSeen}`);
      return parts.join("\n  ");
    });
    return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

mcp.registerTool("send_message", {
  description: "Send a message to another AI agent instance. Supports types: 'text' (general), 'context-request' (ask for context), 'task-handoff' (delegate a task).",
  inputSchema: {
    to_id: z.string().describe("The peer ID of the target agent (from list_peers)"),
    message: z.string().describe("The message text"),
    type: z.enum(["text", "context-request", "task-handoff"]).optional().describe("Message type (default: text)"),
  },
}, async ({ to_id, message, type: msgType }) => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  try {
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      fromId: myId, toId: to_id, type: (msgType ?? "text") as MessageType, text: message,
    });
    if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
    return { content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

mcp.registerTool("share_context", {
  description: "Share your current structured context with the network. This publishes: your summary, active files, git state (branch, modified files, diff), and current task. Other agents can see this when listing peers.",
  inputSchema: {
    summary: z.string().optional().describe("Brief 1-2 sentence summary of your current work. If omitted, auto-generated from active_files."),
    current_task: z.string().optional().describe("Description of the specific task you're working on"),
    active_files: z.array(z.string()).optional().describe("Paths of files you're actively working on"),
  },
}, async ({ summary, current_task, active_files }) => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  try {
    const gitCtx = await gatherGitContext(myCwd);
    if (gitCtx) {
      gitCtx.baselineModifiedFiles = baselineModifiedFiles;
    }
    const activeFiles = (active_files ?? []).map((f) => ({ path: f, relativePath: path.relative(myCwd, f) }));
    const resolvedSummary = summary
      ?? (activeFiles.length
        ? activeFiles.map((f) => f.relativePath || path.basename(f.path)).join(", ")
        : undefined);
    const taskIntent = computeTaskIntent(
      resolvedSummary ?? cachedSessionTitle ?? "",
      current_task,
      activeFiles,
      gitCtx,
      baselineModifiedFiles,
    );
    const context: Partial<AgentContext> = { summary: resolvedSummary, currentTask: current_task, activeFiles, git: gitCtx, taskIntent, updatedAt: new Date().toISOString() };
    await brokerFetch("/update-context", { id: myId, context });
    return {
      content: [{
        type: "text" as const,
        text: `Context shared. Summary: "${resolvedSummary ?? ""}"` +
          (gitCtx ? `\nBranch: ${gitCtx.branch}, Modified: ${gitCtx.modifiedFiles?.length ?? 0} files` : "") +
          (activeFiles.length ? `\nActive files: ${activeFiles.map((f) => f.relativePath).join(", ")}` : ""),
      }],
    };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

mcp.registerTool("request_context", {
  description: "Request another peer's full structured context (active files, git diff, task description). The response includes everything they've shared.",
  inputSchema: { peer_id: z.string().describe("The peer ID to request context from") },
}, async ({ peer_id }) => {
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, gitRoot: myGitRoot });
    const peer = peers.find((p) => p.id === peer_id);
    if (!peer) return { content: [{ type: "text" as const, text: `Peer ${peer_id} not found` }], isError: true };
    const ctx = peer.context;
    const parts = [`=== Context for peer ${peer_id} (${peer.agentType}) ===`, `CWD: ${peer.cwd}`, `Summary: ${ctx.summary || "(none)"}`];
    if (ctx.currentTask) parts.push(`Task: ${ctx.currentTask}`);
    if (ctx.activeFiles?.length) parts.push(`Active files:\n  ${ctx.activeFiles.map((f) => f.relativePath || f.path).join("\n  ")}`);
    if (ctx.git) {
      parts.push(`Git branch: ${ctx.git.branch}`);
      if (ctx.git.modifiedFiles?.length) parts.push(`Modified files:\n  ${ctx.git.modifiedFiles.join("\n  ")}`);
      if (ctx.git.stagedFiles?.length) parts.push(`Staged files:\n  ${ctx.git.stagedFiles.join("\n  ")}`);
      if (ctx.git.diff) parts.push(`Diff summary:\n${ctx.git.diff}`);
    }
    if (ctx.recentExchanges?.length) {
      parts.push(`\nRecent conversation (last ${ctx.recentExchanges.length} exchanges):`);
      for (const ex of ctx.recentExchanges) {
        parts.push(`  [${ex.role}] ${ex.text}`);
      }
    }
    if (ctx.metadata) parts.push(`Metadata: ${JSON.stringify(ctx.metadata)}`);
    parts.push(`Last updated: ${ctx.updatedAt}`);
    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

mcp.registerTool("set_summary", {
  description: "Set a brief summary (1-2 sentences) of what you are currently working on.",
  inputSchema: { summary: z.string().describe("A 1-2 sentence summary of your current work") },
}, async ({ summary }) => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  try {
    await brokerFetch("/update-context", { id: myId, context: { summary } });
    return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

mcp.registerTool("check_messages", {
  description: "Manually check for new messages from other AI agent instances.",
}, async () => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (result.messages.length === 0) return { content: [{ type: "text" as const, text: "No new messages." }] };
    const lines = result.messages.map((m) => `[${m.type}] From ${m.fromId} (${m.sentAt}):\n${m.text}`);
    return { content: [{ type: "text" as const, text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

// ─── WebSocket connection to broker ────────────────────────────

let brokerWs: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function handleIncomingMessage(msg: Message) {
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

  await mcp.server.notification({
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

function connectBrokerWs() {
  if (brokerWs) {
    try { brokerWs.close(); } catch { /* */ }
  }

  try {
    brokerWs = new WebSocket(BROKER_WS_URL);

    brokerWs.on("open", () => {
      log("WebSocket connected to broker");
      // Identify ourselves so the broker can deliver messages directly
      if (myId) {
        brokerWs!.send(JSON.stringify({ type: "identify", id: myId }));
      }
      // Drain any messages that arrived while disconnected
      drainUndeliveredMessages();
    });

    brokerWs.on("message", (data) => {
      try {
        const event = JSON.parse(String(data)) as WsEvent;
        if (event.type === "message") {
          const msg = (event as WsMessageEvent).data;
          // Only handle messages targeted at us
          if (msg.toId === myId) {
            handleIncomingMessage(msg);
          }
        }
      } catch { /* ignore malformed messages */ }
    });

    brokerWs.on("close", () => {
      log("WebSocket disconnected from broker, reconnecting...");
      scheduleWsReconnect();
    });

    brokerWs.on("error", () => {
      try { brokerWs?.close(); } catch { /* */ }
    });
  } catch {
    scheduleWsReconnect();
  }
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectBrokerWs();
  }, 3000);
}

/** Drain any undelivered messages (e.g. sent while WS was disconnected) */
async function drainUndeliveredMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (!result.found) {
      log("Peer entry gone from broker (purged), re-registering...");
      await registerWithBroker();
      return;
    }
    for (const msg of result.messages) {
      await handleIncomingMessage(msg);
    }
  } catch (e) {
    log(`Drain error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Startup ───────────────────────────────────────────────────

let myTty: string | null = null;

async function registerWithBroker(): Promise<void> {
  const gitCtx = await gatherGitContext(myCwd);
  // Capture baseline: files already modified before this agent session started
  baselineModifiedFiles = gitCtx?.modifiedFiles ?? [];
  if (gitCtx) {
    gitCtx.baselineModifiedFiles = baselineModifiedFiles;
  }
  const initialSummary = "Untitled";
  const context: AgentContext = {
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
    tty: myTty,
    context,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // Try to restore session title immediately after (re-)registration
  if (AGENT_TYPE === "claude-code") {
    try {
      const title = await getClaudeSessionTitle();
      if (title) {
        await brokerFetch("/update-context", { id: myId, context: { summary: title } });
        log(`Session title restored: ${title}`);
      }
    } catch { /* non-critical */ }
  }
}

async function main() {
  await ensureBroker();

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  myTty = getTty();

  log(`Agent type: ${AGENT_TYPE}`);
  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);

  await registerWithBroker();

  // Connect MCP
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // Watch for Claude Code session title (ai-title) and update summary when found.
  // Other agent types (codex, etc.) stay "Untitled" until they call set_summary.
  // Uses exponential backoff instead of fixed 3s polling to reduce I/O pressure.
  let sessionTitleSet = false;
  let titleWatchTimer: ReturnType<typeof setTimeout> | null = null;
  if (AGENT_TYPE === "claude-code") {
    const trySetTitle = async (attempt: number) => {
      if (sessionTitleSet || !myId || attempt > 5) return;
      const title = await getClaudeSessionTitle();
      if (title) {
        sessionTitleSet = true;
        cachedSessionTitle = title;
        try {
          await brokerFetch("/update-context", { id: myId, context: { summary: title } });
          log(`Session title set: ${title}`);
        } catch { /* non-critical */ }
        return;
      }
      // Exponential backoff: 5s, 10s, 20s, 40s, 80s
      const delay = 5000 * Math.pow(2, attempt);
      titleWatchTimer = setTimeout(() => trySetTitle(attempt + 1), delay);
    };
    // First attempt after 5s (session file needs time to be written)
    titleWatchTimer = setTimeout(() => trySetTitle(0), 5000);
  } else {
    // For other agents (e.g., Codex), set a reasonable summary once after startup.
    const desiredTitle = myGitRoot ? path.basename(myGitRoot) : path.basename(myCwd);
    const setOnce = async () => {
      if (!myId || !desiredTitle || desiredTitle === "home" || desiredTitle === "Untitled") return;
      try {
        cachedSessionTitle = desiredTitle;
        await brokerFetch("/update-context", { id: myId, context: { summary: desiredTitle } });
        log(`Session title set (auto): ${desiredTitle}`);
      } catch {
        /* non-critical */
      }
    };
    setTimeout(setOnce, 3000);
  }

  // Watch .git/HEAD for instant branch-change detection
  let gitWatcher: fs.FSWatcher | null = null;
  let gitUpdatePending = false;
  if (myGitRoot) {
    const gitHeadPath = path.join(myGitRoot, ".git", "HEAD");
    try {
      gitWatcher = fs.watch(gitHeadPath, { persistent: false }, async () => {
        if (gitUpdatePending || !myId) return;
        gitUpdatePending = true;
        // Small debounce — git may write HEAD multiple times during checkout
        setTimeout(async () => {
          gitUpdatePending = false;
          try {
            const gitCtx = await gatherGitContext(myCwd);
            if (gitCtx) {
              gitCtx.baselineModifiedFiles = baselineModifiedFiles;
            }
            await brokerFetch("/update-context", { id: myId, context: { git: gitCtx } });
            log("Git context updated (branch change detected)");
          } catch { /* broker may be down */ }
        }, 300);
      });
      log(`Watching ${gitHeadPath} for branch changes`);
    } catch {
      log("Could not watch .git/HEAD — branch changes will be detected via heartbeat");
    }
  }

  // Start WebSocket connection & heartbeat
  connectBrokerWs();
  let lastGitJson = ""; // Cache to avoid redundant context updates
  let lastExchangesJson = ""; // Cache to avoid redundant exchange updates
  let lastTaskIntentJson = ""; // Cache to avoid redundant taskIntent updates
  const heartbeatTimer = setInterval(async () => {
    if (!myId) return;
    try {
      const result = await brokerFetch<{ ok: boolean }>("/heartbeat", { id: myId });
      if (!result.ok) {
        // Broker restarted and lost our entry — re-register and re-identify on WS
        log("Peer entry gone from broker, re-registering...");
        await ensureBroker();
        await registerWithBroker();
        if (brokerWs?.readyState === WebSocket.OPEN && myId) {
          brokerWs.send(JSON.stringify({ type: "identify", id: myId }));
        } else {
          connectBrokerWs();
        }
        return;
      }
      const contextUpdate: Record<string, unknown> = {};

      // Only send git context update if something actually changed
      const gitCtx = await gatherGitContext(myCwd);
      if (gitCtx) {
        gitCtx.baselineModifiedFiles = baselineModifiedFiles;
      }
      const gitJson = JSON.stringify(gitCtx);
      if (gitJson !== lastGitJson) {
        lastGitJson = gitJson;
        contextUpdate.git = gitCtx;
      }

      // Update recent exchanges (only if changed)
      const exchanges = getRecentExchanges();
      const exchangesJson = JSON.stringify(exchanges);
      if (exchangesJson !== lastExchangesJson) {
        lastExchangesJson = exchangesJson;
        contextUpdate.recentExchanges = exchanges;
      }

      // Update taskIntent (only if changed)
      // We need the current summary/task from the broker context; approximate with cached session title
      const currentSummary = cachedSessionTitle ?? "";
      const taskIntent = computeTaskIntent(
        currentSummary,
        undefined, // currentTask is set explicitly via share_context, not available here
        [], // activeFiles not tracked automatically in heartbeat
        gitCtx,
        baselineModifiedFiles,
      );
      const taskIntentJson = JSON.stringify(taskIntent);
      if (taskIntentJson !== lastTaskIntentJson) {
        lastTaskIntentJson = taskIntentJson;
        contextUpdate.taskIntent = taskIntent;
      }

      if (Object.keys(contextUpdate).length > 0) {
        await brokerFetch("/update-context", { id: myId, context: contextUpdate });
      }
    } catch {
      // Broker temporarily down — will retry next heartbeat
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on exit
  let cleanedUp = false;
  let parentWatchTimer: ReturnType<typeof setInterval>;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    try { brokerWs?.close(); } catch { /* */ }
    clearInterval(heartbeatTimer);
    if (titleWatchTimer) clearTimeout(titleWatchTimer);
    gitWatcher?.close();
    clearInterval(parentWatchTimer);
    if (myId) {
      try { await brokerFetch("/unregister", { id: myId }); log("Unregistered"); } catch { /* */ }
    }
    process.exit(0);
  };
  onProcessTermination(cleanup);

  // Claude closes stdin when it exits (without necessarily sending a signal).
  // Detect this so we unregister immediately instead of leaving a stale peer.
  process.stdin.on("close", cleanup);
  process.stdin.on("end", cleanup);

  // Watch for parent process death. When the parent (Claude/Codex) exits without
  // sending SIGTERM, this MCP server becomes an orphan reparented to init (PID 1).
  // Detect both cases:
  //   1. process.ppid changed → reparented to init, original parent is gone
  //   2. process.kill(parentPid, 0) throws → parent PID no longer exists
  const originalPpid = process.ppid;
  parentWatchTimer = setInterval(() => {
    const currentPpid = process.ppid;
    if (currentPpid !== originalPpid) {
      log(`Parent process ${originalPpid} is gone (reparented to ${currentPpid}), exiting`);
      cleanup();
      return;
    }
    try {
      process.kill(originalPpid, 0);
    } catch {
      log(`Parent process ${originalPpid} is gone, exiting`);
      cleanup();
    }
  }, 5000);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
