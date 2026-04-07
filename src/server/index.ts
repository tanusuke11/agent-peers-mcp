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
 *   AGENT_PEERS_MAX_MESSAGES_PER_DIRECTION — max messages from A→B (default 50, min 1)
 *   AGENT_PEERS_TRUST_BROKER_ID_ONLY — "false" to disable the strict broker-ID instruction (default: enabled)
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
  CheckConflictsResponse,
  ConflictResult,
  SendMessageResponse,
  DuplicateTaskInfo,
  PeerSource,
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
const TRUST_BROKER_ID_ONLY = process.env.AGENT_PEERS_TRUST_BROKER_ID_ONLY !== "false"; // default: true
const BROKER_SCRIPT = path.join(__dirname, "..", "broker", "index.js");
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

// ─── Broker communication ──────────────────────────────────────

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connection": "close" },
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
 * Windows: uses PowerShell Get-WmiObject (wmic is deprecated in Windows 11)
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
      // wmic is deprecated/removed in Windows 11 — use PowerShell instead
      const out = execSync(
        `powershell -NoProfile -Command "(Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      return out ? out.split(/\s+/) : null;
    }
    return null;
  } catch { return null; }
}

/**
 * Get the parent PID of a process (cross-platform).
 * Linux: reads /proc/<pid>/status
 * macOS: uses `ps -o ppid=`
 * Windows: uses PowerShell Get-WmiObject (wmic is deprecated in Windows 11)
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
      // wmic is deprecated/removed in Windows 11 — use PowerShell instead
      const out = execSync(
        `powershell -NoProfile -Command "(Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      return parseInt(out, 10) || 0;
    }
    return 0;
  } catch { return 0; }
}

/**
 * Walk up the process tree to find the CLI session (Claude Code / Codex) PID.
 * This is the long-lived process whose liveness indicates the session is active.
 * Falls back to process.ppid if the CLI process cannot be identified.
 */
function findOwnerPid(): number {
  let pid = process.ppid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    const cmdArgs = getProcessArgs(pid);
    if (cmdArgs) {
      const cmdLine = cmdArgs.join(" ").toLowerCase();
      // Match Claude Code CLI (node-based) or Codex CLI
      if (cmdLine.includes("claude") || cmdLine.includes("codex")) {
        return pid;
      }
    }
    pid = getParentPid(pid);
  }
  // Fallback: the immediate parent is the best guess
  return process.ppid;
}

/** Cached owner PID — resolved once at startup */
let ownerPid = 0;

function looksLikeExtensionOwner(cmdLine: string): boolean {
  const cmd = cmdLine.toLowerCase();
  return (
    cmd.includes("/.vscode/extensions/") ||
    cmd.includes("\\.vscode\\extensions\\") ||
    cmd.includes("openai.chatgpt-") ||
    cmd.includes("anthropic.claude-code-")
  );
}

function resolvePeerSource(owner: number): PeerSource {
  const override = process.env.AGENT_PEERS_SOURCE;
  if (override === "extension" || override === "terminal") return override;

  // True extension-host launches are extension peers.
  if (process.env.ELECTRON_RUN_AS_NODE) return "extension";

  // VSCode integrated terminals also set VSCODE_PID, so don't rely on it alone.
  // Instead, inspect the owner process command line for extension binary paths.
  const ownerArgs = getProcessArgs(owner);
  const ownerCmd = ownerArgs?.join(" ") ?? "";
  if (ownerCmd && looksLikeExtensionOwner(ownerCmd)) return "extension";

  return "terminal";
}

/**
 * Find the Claude Code session JSONL file path for THIS MCP server instance.
 *
 * Strategy:
 *  1. Walk the process tree to find a `--resume <sessionId>` arg.
 *  2. Look up `~/.claude/sessions/<PID>.json` for ancestor PIDs.
 *  3. If a session ID is found, resolve it to a `.jsonl` file in the project dir.
 *
 * A successful (non-null) result is cached permanently so the instance never
 * drifts to another peer's file.  A null result is NOT cached because the
 * JSONL file may not exist yet at startup (Claude Code creates it lazily).
 *
 * There is intentionally NO "most recent file" fallback.  That heuristic caused
 * every peer in the same repo to converge on the same file, producing identical
 * conversation histories across peers.
 */
let cachedSessionFile: string | null | undefined;
/** Session ID detected from process tree (cached even when the JSONL doesn't exist yet) */
let cachedSessionId: string | null | undefined;
let cachedCodexSessionFile: string | null | undefined;

function findSessionFile(): string | null {
  // If we previously found a concrete file, return it immediately.
  if (cachedSessionFile) return cachedSessionFile;

  const result = findSessionFileUncached();
  if (result) {
    cachedSessionFile = result;
  }
  return result;
}

function findSessionFileUncached(): string | null {
  try {
    // Resolve session ID from process tree.  The process tree itself won't
    // change, but the session metadata file (~/.claude/sessions/<pid>.json) may
    // not exist yet at startup (Claude Code writes it lazily).  So we retry on
    // each call until we get a non-null result, then cache permanently.
    if (!cachedSessionId) {
      cachedSessionId = resolveSessionId();
    }

    const candidates = [myGitRoot, myCwd].filter(Boolean) as string[];

    if (cachedSessionId) {
      for (const base of candidates) {
        const projectHash = base.replace(/[\\/]/g, "-");
        const sessionFile = path.join(os.homedir(), ".claude", "projects", projectHash, `${cachedSessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) return sessionFile;
      }
    }

    // No fallback — return null rather than guessing.
    return null;
  } catch { return null; }
}

/** Walk the process tree to discover the Claude Code session ID. */
function resolveSessionId(): string | null {
  // Method 1: look for --resume <sessionId> in ancestor command lines.
  let pid = process.ppid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    const cmdArgs = getProcessArgs(pid);
    if (!cmdArgs) break;

    const resumeIdx = cmdArgs.indexOf("--resume");
    if (resumeIdx !== -1 && cmdArgs[resumeIdx + 1]) {
      return cmdArgs[resumeIdx + 1]!;
    }
    pid = getParentPid(pid);
  }

  // Method 2: look up ~/.claude/sessions/<PID>.json for ancestor PIDs.
  let searchPid = process.ppid;
  for (let depth = 0; depth < 5 && searchPid > 1; depth++) {
    const sessionMeta = path.join(os.homedir(), ".claude", "sessions", `${searchPid}.json`);
    if (fs.existsSync(sessionMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sessionMeta, "utf8")) as { sessionId?: string };
        if (meta.sessionId) return meta.sessionId;
      } catch { /* skip */ }
    }
    searchPid = getParentPid(searchPid);
  }

  return null;
}

async function getClaudeSessionTitle(): Promise<string | null> {
  try {
    const file = findSessionFile();
    if (!file) return null;

    const content = fs.readFileSync(file, "utf8");
    // Priority: custom-title > agent-name > ai-title (most specific wins)
    let aiTitle: string | null = null;
    let customTitle: string | null = null;
    let agentName: string | null = null;
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
          aiTitle = obj.aiTitle;
        } else if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
          customTitle = obj.customTitle;
        } else if (obj.type === "agent-name" && typeof obj.agentName === "string") {
          agentName = obj.agentName;
        }
      } catch { /* skip */ }
    }
    return customTitle ?? agentName ?? aiTitle ?? null;
  } catch { return null; }
}

function parsePsElapsedSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const [daysPart, timePart] = trimmed.includes("-")
    ? trimmed.split("-", 2)
    : [null, trimmed];
  const timeParts = timePart.split(":").map((part) => parseInt(part, 10));
  if (timeParts.some((part) => Number.isNaN(part))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (timeParts.length === 3) {
    [hours, minutes, seconds] = timeParts;
  } else if (timeParts.length === 2) {
    [minutes, seconds] = timeParts;
  } else {
    return null;
  }

  const days = daysPart ? parseInt(daysPart, 10) : 0;
  if (Number.isNaN(days)) return null;
  return (days * 24 * 60 * 60) + (hours * 60 * 60) + (minutes * 60) + seconds;
}

function getProcessStartTimeMs(pid: number): number | null {
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    if (process.platform === "linux") {
      const elapsed = execSync(`ps -o etimes= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim();
      const seconds = parseInt(elapsed, 10);
      return Number.isFinite(seconds) ? Date.now() - (seconds * 1000) : null;
    }
    if (process.platform === "darwin") {
      const elapsed = execSync(`ps -o etime= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim();
      const seconds = parsePsElapsedSeconds(elapsed);
      return seconds !== null ? Date.now() - (seconds * 1000) : null;
    }
    if (process.platform === "win32") {
      // wmic is deprecated/removed in Windows 11 — use PowerShell instead
      const out = execSync(
        `powershell -NoProfile -Command "(Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}').CreationDate"`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      // PowerShell returns a WMI datetime string like "20240101120000.000000+000"
      const match = out.match(/(\d{14})/);
      if (!match) return null;
      const raw = match[1]!;
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  } catch { return null; }
}

function walkFiles(root: string, predicate: (file: string) => boolean): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

function readFileHead(file: string, maxBytes = 8192): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function extractCwdFromEnvironmentContext(text: string): string | null {
  const match = text.match(/Current working directory:\s*(.+)/);
  return match?.[1]?.trim() ?? null;
}

function extractCodexMessageText(content: unknown, role: "user" | "assistant"): string {
  if (!Array.isArray(content)) return "";
  const allowedTypes = role === "user"
    ? new Set(["input_text", "text"])
    : new Set(["output_text", "text"]);
  return content
    .filter((block): block is { type?: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => typeof block.type === "string" && allowedTypes.has(block.type))
    .map((block) => typeof block.text === "string" ? block.text : "")
    .join(" ")
    .trim();
}

type CodexSessionMeta = {
  cwd: string | null;
  startedAtMs: number | null;
};

function readCodexSessionMeta(file: string): CodexSessionMeta {
  try {
    const head = readFileHead(file);
    let cwd: string | null = null;
    let startedAtMs: number | null = null;

    for (const line of head.split("\n").filter(Boolean).slice(0, 12)) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!startedAtMs) {
          const directTimestamp = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
          if (!Number.isNaN(directTimestamp)) {
            startedAtMs = directTimestamp;
          } else if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
            const payload = obj.payload as Record<string, unknown>;
            const payloadTimestamp = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
            if (!Number.isNaN(payloadTimestamp)) startedAtMs = payloadTimestamp;
          }
        }

        if (!cwd && obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
          const payload = obj.payload as Record<string, unknown>;
          if (typeof payload.cwd === "string") cwd = payload.cwd;
        }

        if (!cwd && obj.type === "message" && obj.role === "user") {
          const text = extractCodexMessageText(obj.content, "user");
          if (text.includes("<environment_context>")) {
            cwd = extractCwdFromEnvironmentContext(text);
          }
        }

        if (cwd && startedAtMs) break;
      } catch { /* skip */ }
    }

    return { cwd, startedAtMs };
  } catch {
    return { cwd: null, startedAtMs: null };
  }
}

function findCodexSessionFile(): string | null {
  if (cachedCodexSessionFile) return cachedCodexSessionFile;

  const result = findCodexSessionFileUncached();
  if (result) cachedCodexSessionFile = result;
  return result;
}

function findCodexSessionFileUncached(): string | null {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;

  const targetCwd = myCwd;
  const ownerStartTimeMs = getProcessStartTimeMs(process.ppid);
  const candidates = walkFiles(CODEX_SESSIONS_DIR, (file) => file.endsWith(".jsonl") && path.basename(file).startsWith("rollout-"))
    .map((file) => ({ file, ...readCodexSessionMeta(file) }))
    .filter((session) => session.cwd === targetCwd);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (ownerStartTimeMs && a.startedAtMs && b.startedAtMs) {
      const deltaA = Math.abs(a.startedAtMs - ownerStartTimeMs);
      const deltaB = Math.abs(b.startedAtMs - ownerStartTimeMs);
      if (deltaA !== deltaB) return deltaA - deltaB;
    }
    return (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0);
  });

  return candidates[0]?.file ?? null;
}

const EXCHANGE_MAX_CHARS = 200;
const EXCHANGE_MAX_COUNT = 5;

/** Read recent human/assistant exchanges from the Claude Code session JSONL. */
function getRecentExchanges(): import("../shared/types.ts").RecentExchange[] {
  if (AGENT_TYPE === "codex") {
    try {
      const file = findCodexSessionFile();
      if (!file) return [];

      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const exchanges: import("../shared/types.ts").RecentExchange[] = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type !== "message") continue;

          const role = obj.role as "user" | "assistant" | undefined;
          if (role !== "user" && role !== "assistant") continue;

          const text = extractCodexMessageText(obj.content, role);
          if (!text || text.includes("<environment_context>")) continue;

          exchanges.push({
            role: role === "user" ? "human" : "assistant",
            text: text.length > EXCHANGE_MAX_CHARS ? text.slice(0, EXCHANGE_MAX_CHARS) + "…" : text,
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
          });
        } catch { /* skip */ }
      }

      return exchanges.slice(-EXCHANGE_MAX_COUNT);
    } catch { return []; }
  }

  // Only Claude Code writes the ~/.claude session JSONL files we inspect below.
  // Other agent types should explicitly add their own reader rather than falling
  // back to another tool's session logs.
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

// ─── Conversation Digest (AI-generated summary) ─────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DIGEST_MODEL = "claude-haiku-4-5-20251001";

/**
 * Generate a 1-2 sentence digest of recent conversation exchanges using the
 * Anthropic Messages API (Haiku for low cost/latency).  Returns null if no
 * API key is configured or the call fails — callers should treat this as a
 * best-effort enrichment.
 */
async function generateConversationDigest(
  exchanges: import("../shared/types.ts").RecentExchange[],
): Promise<string | null> {
  if (exchanges.length === 0) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const conversation = exchanges
    .map((ex) => `[${ex.role}] ${ex.text}`)
    .join("\n");

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: DIGEST_MODEL,
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `Summarize this AI agent conversation in 1-2 concise sentences. Focus on what was decided, what is being worked on, and any key outcomes. Write in the same language as the conversation.\n\n${conversation}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log(`Digest API error: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return text || null;
  } catch (err) {
    log(`Digest generation failed: ${err}`);
    return null;
  }
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

const TRUST_BROKER_ID_INSTRUCTION = TRUST_BROKER_ID_ONLY
  ? "\nIMPORTANT: Your peer ID is assigned exclusively by the broker. NEVER assume or guess your own peer ID — always call `whoami` to retrieve it. Do not rely on your training knowledge or conversation context to determine who you are on the network."
  : "";

const mcp = new McpServer(
  { name: "agent-peers", version: "0.1.0" },
  {
    instructions: `You are connected to the agent-peers network. Other AI agent instances (Claude Code, Codex, etc.) on this machine can discover you, send you messages, and share structured context.

IMPORTANT: When you receive a <channel source="agent-peers" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply using send_message, then resume your work.${TRUST_BROKER_ID_INSTRUCTION}

Available tools:
- whoami: Get your own broker-assigned peer ID and registration info. Use this to know your identity on the network.
- list_peers: Discover other AI agent instances (scope: machine/directory/repo)
- send_message: Send a message or task handoff to another instance
- share_context: Share your current structured context (active files, git state, task). Also runs an automatic conflict check.
- request_context: Request another peer's full structured context
- set_summary: Set a brief summary of what you're working on
- check_messages: Manually check for new messages
- check_conflicts: Check if planned work conflicts with other agents before starting

When you start, proactively call share_context to publish your current state. This helps other agents understand what you're working on. Before starting a new task, use check_conflicts to verify no other agents are working on the same files.`,
  }
);

// ─── Tool handlers ─────────────────────────────────────────────

mcp.registerTool("whoami", {
  description: "Get your own broker-assigned peer ID and registration info. Always use this to determine your identity on the agent-peers network — never assume or guess your peer ID.",
  inputSchema: {},
}, async () => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet — broker registration is pending." }], isError: true };
  const parts = [
    `Your peer ID: ${myId}`,
    `Agent type: ${AGENT_TYPE}`,
    `CWD: ${myCwd}`,
    `Git root: ${myGitRoot ?? "(none)"}`,
    `Source: ${mySource}`,
    `Owner PID: ${ownerPid}`,
  ];
  if (TRUST_BROKER_ID_ONLY) {
    parts.push("\nNote: This ID is assigned by the broker and is the authoritative source of your identity on the network.");
  }
  return { content: [{ type: "text" as const, text: parts.join("\n") }] };
});

mcp.registerTool("list_peers", {
  description: "List AI agent instances running on this machine, including yourself (marked with '(you)'). Returns their ID, agent type (claude-code/codex), working directory, git repo, and current context summary.",
  inputSchema: { scope: z.enum(["machine", "directory", "repo"]).describe('"machine" = all instances. "directory" = same working directory. "repo" = same git repository.') },
}, async ({ scope }) => {
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope, cwd: myCwd, gitRoot: myGitRoot });
    if (peers.length === 0) return { content: [{ type: "text" as const, text: `No agents found (scope: ${scope}).` }] };
    const lines = peers.map((p) => {
      const isSelf = p.id === myId;
      const parts = [`ID: ${p.id}${isSelf ? " (you)" : ""}`, `Agent: ${p.agentType}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
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
  description: "Send a message to another AI agent instance. Supports types: 'text' (general), 'context-request' (ask for context), 'task-handoff' (delegate a task), 'report' (reply to a task-handoff with a work report — NOT delivered to the requester's terminal, only visible in their UI). All peer types (terminal and extension) accept all message types. For 'report' messages to extension peers, reply_to must point to the original task-handoff. For task-handoff, the broker checks for duplicate/similar tasks already in progress and blocks if found — use force=true to override. Suspended/sleeping peers (suspended=true in list_peers) are not valid recipients — messages to them will be rejected.",
  inputSchema: {
    to_id: z.string().describe("The peer ID of the target agent (from list_peers)"),
    message: z.string().describe("The message text"),
    type: z.enum(["text", "context-request", "task-handoff", "report"]).optional().describe("Message type (default: text). Use 'report' to reply to a task-handoff with a work report."),
    reply_to: z.number().optional().describe("Message ID this is a reply to (used with type='report' to link back to original task-handoff; required when sending a report to an extension peer)"),
    force: z.boolean().optional().describe("Force send even if duplicate task-handoff is detected (default: false)"),
  },
}, async ({ to_id, message, type: msgType, reply_to, force }) => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  try {
    const result = await brokerFetch<SendMessageResponse>("/send-message", {
      fromId: myId, toId: to_id, type: (msgType ?? "text") as MessageType, text: message, replyTo: reply_to, force: !!force,
    });
    if (!result.ok) {
      // Format duplicate task warnings
      if (result.duplicates && result.duplicates.length > 0) {
        const lines = result.duplicates.map((d: DuplicateTaskInfo) =>
          `⚠ ${d.peerId} (${d.agentType}): "${d.taskDescription}"\n  → ${d.reason} [${d.confidence}]`
        );
        return { content: [{ type: "text" as const, text: `Blocked: duplicate task-handoff detected.\n\n${lines.join("\n\n")}\n\nTo send anyway, set force=true.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
    }
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

    let statusText = `Context shared. Summary: "${resolvedSummary ?? ""}"` +
      (gitCtx ? `\nBranch: ${gitCtx.branch}, Modified: ${gitCtx.modifiedFiles?.length ?? 0} files` : "") +
      (activeFiles.length ? `\nActive files: ${activeFiles.map((f) => f.relativePath).join(", ")}` : "");

    // Proactive conflict check: warn the agent if their work overlaps with others
    // Only runs when autoConflictCheck is enabled in the broker
    try {
      const healthRes = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1000) });
      const health = healthRes.ok ? await healthRes.json() as { autoConflictCheck?: boolean } : null;
      if (health?.autoConflictCheck !== false) {
        const conflictPrompt = [resolvedSummary, current_task, ...activeFiles.map(f => f.relativePath)].filter(Boolean).join(" ");
        if (conflictPrompt.length >= 10) {
          const conflictResult = await brokerFetch<CheckConflictsResponse>("/check-conflicts", {
            prompt: conflictPrompt,
            callerId: myId,
            gitRoot: myGitRoot,
          });
          if (conflictResult.conflicts && conflictResult.conflicts.length > 0) {
            const warnings = conflictResult.conflicts.map(c =>
              `- Peer "${c.peerId}" (${c.agentType}): ${c.summary}\n  Files: ${c.taskIntent.targetFiles.slice(0, 5).join(", ")}\n  Conflict: ${c.reason} (${c.confidence})`
            );
            statusText += `\n\n⚠ Conflict warning — other agent(s) are working on overlapping files/areas:\n${warnings.join("\n")}`;
            statusText += "\nUse check_conflicts or send_message to coordinate.";
          }
        }
      }
    } catch { /* non-critical: don't fail share_context if conflict check fails */ }

    return { content: [{ type: "text" as const, text: statusText }] };
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
    if (ctx.conversationDigest) {
      parts.push(`\nConversation digest: ${ctx.conversationDigest}`);
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

mcp.registerTool("check_conflicts", {
  description: "Check if your current or planned work conflicts with other agents in the same repo. Returns a list of peers whose work overlaps with the given prompt/description. Use this BEFORE starting work on a task to avoid merge conflicts.",
  inputSchema: {
    prompt: z.string().describe("Description of what you plan to do, or the user's request text"),
  },
}, async ({ prompt }) => {
  if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
  if (!prompt || prompt.length < 10) {
    return { content: [{ type: "text" as const, text: "Prompt too short — provide a description of the planned work (at least 10 characters)." }], isError: true };
  }
  try {
    const result = await brokerFetch<CheckConflictsResponse>("/check-conflicts", {
      prompt,
      callerId: myId,
      gitRoot: myGitRoot,
    });
    if (!result.conflicts || result.conflicts.length === 0) {
      return { content: [{ type: "text" as const, text: "No conflicts detected. Safe to proceed." }] };
    }
    const lines = ["⚠ Potential conflict(s) detected:\n"];
    for (const c of result.conflicts) {
      lines.push(`- Peer "${c.peerId}" (${c.agentType}): ${c.summary}`);
      lines.push(`  Working on: ${c.taskIntent.description}`);
      const files = c.taskIntent.targetFiles.slice(0, 5);
      lines.push(`  Files: ${files.join(", ")}${c.taskIntent.targetFiles.length > 5 ? " ..." : ""}`);
      lines.push(`  Conflict: ${c.reason} (confidence: ${c.confidence})`);
    }
    lines.push("");
    lines.push("Consider:");
    lines.push("1. Coordinate with the other agent (use send_message)");
    lines.push("2. Revise your approach to avoid overlapping files/areas");
    lines.push("3. Proceed anyway (risk merge conflicts later)");
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error checking conflicts: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

// ─── WebSocket connection to broker ────────────────────────────

let brokerWs: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function handleIncomingMessage(msg: Message) {
  // Messages are delivered to agent terminals by the VSCode extension
  // via terminal.sendText(). The MCP server just logs receipt here.
  log(`Received message from ${msg.fromId}: ${msg.text.slice(0, 80)}`);
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
        brokerWs!.send(JSON.stringify({ type: "identify", id: myId, pid: ownerPid, source: mySource }));
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
        } else if (event.type === "wake") {
          // Wake signal from extension — re-deliver pending messages as channel notifications
          const wakeData = event.data as { id: string; messages: Message[] };
          if (wakeData.id === myId && wakeData.messages?.length) {
            log(`Wake signal received with ${wakeData.messages.length} pending message(s)`);
            for (const msg of wakeData.messages) {
              handleIncomingMessage(msg);
            }
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
    // Use peek-messages (not poll-messages) so messages stay unread.
    // read is only marked when the extension delivers via terminal injection.
    const result = await brokerFetch<PollMessagesResponse>("/peek-messages", { id: myId });
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
let mySource: PeerSource = "terminal";

async function registerWithBroker(): Promise<void> {
  const gitCtx = await gatherGitContext(myCwd);
  // Capture baseline: files already modified before this agent session started
  baselineModifiedFiles = gitCtx?.modifiedFiles ?? [];
  if (gitCtx) {
    gitCtx.baselineModifiedFiles = baselineModifiedFiles;
  }
  const initialSummary = "";
  const context: AgentContext = {
    summary: initialSummary,
    activeFiles: [],
    git: gitCtx,
    updatedAt: new Date().toISOString(),
  };
  const source = mySource;
  // Let the broker decide: claim a suspended peer of the same kind, or create a new one.
  // Register with the owner (CLI session) PID so liveness checks target the long-lived process.
  const reg = await brokerFetch<RegisterResponse>("/register", {
    agentType: AGENT_TYPE,
    source,
    pid: ownerPid,
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
  ownerPid = findOwnerPid();
  mySource = resolvePeerSource(ownerPid);

  log(`Agent type: ${AGENT_TYPE}`);
  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Owner PID: ${ownerPid}`);
  log(`Source: ${mySource}`);

  await registerWithBroker();

  // Connect MCP
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // Watch for Claude Code session title (ai-title) and update summary when found.
  // Other agent types (codex, etc.) stay "Untitled" until they call set_summary.
  // Single early attempt; if missed, the 15s heartbeat loop retries indefinitely.
  let sessionTitleSet = false;
  let titleWatchTimer: ReturnType<typeof setTimeout> | null = null;
  if (AGENT_TYPE === "claude-code") {
    titleWatchTimer = setTimeout(async () => {
      if (sessionTitleSet || !myId) return;
      const title = await getClaudeSessionTitle();
      if (title) {
        sessionTitleSet = true;
        cachedSessionTitle = title;
        try {
          await brokerFetch("/update-context", { id: myId, context: { summary: title } });
          log(`Session title set: ${title}`);
        } catch { /* non-critical */ }
      }
    }, 5000);
  } else {
    // Non-Claude agents: summary stays empty until the agent calls set_summary
    // with actual work content. Do NOT auto-set repo/cwd name as summary.
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
      const result = await brokerFetch<{ ok: boolean }>("/heartbeat", { id: myId, pid: ownerPid, source: mySource });
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

      // Update recent exchanges (only if changed) and regenerate digest
      const exchanges = getRecentExchanges();
      const exchangesJson = JSON.stringify(exchanges);
      if (exchangesJson !== lastExchangesJson) {
        lastExchangesJson = exchangesJson;
        contextUpdate.recentExchanges = exchanges;
        // Generate digest asynchronously — don't block heartbeat
        generateConversationDigest(exchanges).then((digest) => {
          if (digest && myId) {
            brokerFetch("/update-context", {
              id: myId,
              context: { conversationDigest: digest },
            }).catch((err) => log(`Failed to push digest: ${err}`));
          }
        });
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

      // Retry title if still unset (ai-title may appear later in the session)
      if (!sessionTitleSet && AGENT_TYPE === "claude-code") {
        const title = await getClaudeSessionTitle();
        if (title) {
          sessionTitleSet = true;
          cachedSessionTitle = title;
          contextUpdate.summary = title;
          log(`Session title set (heartbeat): ${title}`);
        }
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
      try { await brokerFetch("/suspend-peer", { id: myId }); log("Sleep (session detached)"); } catch { /* */ }
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
