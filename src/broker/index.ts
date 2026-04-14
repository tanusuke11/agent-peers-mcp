#!/usr/bin/env node
/**
 * agent-peers broker daemon
 *
 * A singleton HTTP + WebSocket server backed by SQLite.
 * Tracks all registered AI agent peers and routes messages between them.
 * Broadcasts real-time events via WebSocket for VSCode extension and other listeners.
 *
 * Enhancements over claude-peers:
 *   - Multi-agent support (Claude Code, Codex, etc.)
 *   - Structured context sharing (active files, git state, tasks)
 *   - WebSocket for real-time push (peer join/leave, messages, context updates)
 *
 * Auto-launched by the MCP server or VSCode extension if not already running.
 * Run directly: node out/broker/index.js
 */

import { DatabaseSync } from "node:sqlite";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  UpdateContextRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
  AgentContext,
  TaskIntent,
  DuplicateTaskInfo,
  BrokerHealthResponse,
  CheckConflictsRequest,
  ConflictResult,
  CheckConflictsResponse,
  WsEvent,
  WsMessageEvent,
  WsPeerJoinedEvent,
  WsPeerLeftEvent,
  WsContextUpdatedEvent,
} from "../shared/types.ts";
import {
  DEFAULT_BROKER_PORT,
  DEFAULT_WS_PORT,
  BROKER_DB_PATH,
  STALE_PEER_CLEANUP_MS,
  PEER_TIMEOUT_MS,
} from "../shared/constants.ts";
import { terminateProcess } from "../shared/process.ts";

const PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const WS_PORT = parseInt(process.env.AGENT_PEERS_WS_PORT ?? String(DEFAULT_WS_PORT), 10);
const DB_PATH = process.env.AGENT_PEERS_DB ?? BROKER_DB_PATH;
let AUTO_CONFLICT_CHECK = process.env.AGENT_PEERS_AUTO_CONFLICT_CHECK !== "false";
const startTime = Date.now();

// ─── Database setup ────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 3000");
db.exec("PRAGMA foreign_keys = OFF");

db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL DEFAULT 'generic',
    source TEXT NOT NULL DEFAULT 'terminal',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    context_json TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    sleep INTEGER NOT NULL DEFAULT 0
  )
`);

// Migration: add sleep column if missing (fresh installs)
try {
  db.exec("ALTER TABLE peers ADD COLUMN sleep INTEGER NOT NULL DEFAULT 0");
} catch { /* column already exists */ }

// Migration: rename suspended → sleep for existing databases
try {
  db.exec("ALTER TABLE peers RENAME COLUMN suspended TO sleep");
} catch { /* column already renamed or does not exist */ }

// Migration: add source column if missing
try {
  db.exec("ALTER TABLE peers ADD COLUMN source TEXT NOT NULL DEFAULT 'terminal'");
} catch { /* column already exists */ }

// Legacy compatibility migration: keep the old read column if it exists in user databases
try {
  db.exec("ALTER TABLE messages ADD COLUMN read INTEGER NOT NULL DEFAULT 0");
} catch { /* column already exists */ }

// Migration: add reply_to column (links report messages to original task-handoff)
try {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id)");
} catch { /* column already exists */ }

// Migration: add from_user column (distinguishes user-initiated from peer-to-peer messages)
try {
  db.exec("ALTER TABLE messages ADD COLUMN from_user INTEGER NOT NULL DEFAULT 0");
} catch { /* column already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL,
    payload_json TEXT,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    from_user INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// ─── WebSocket clients ─────────────────────────────────────────

/** Anonymous clients (e.g. VSCode extension) */
const wsClients = new Set<WebSocket>();
/** Peer-identified clients (MCP servers that sent {"type":"identify","id":"..."}) */
const wsPeerClients = new Map<string, WebSocket>();

function broadcast(event: WsEvent) {
  const json = JSON.stringify(event);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch { wsClients.delete(ws); }
    }
  }
  for (const [id, ws] of wsPeerClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch { wsPeerClients.delete(id); }
    }
  }
}

/** Send an event to a specific peer (if connected via WS) */
function sendToPeer(peerId: string, event: WsEvent): boolean {
  const ws = wsPeerClients.get(peerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(event)); return true; } catch { wsPeerClients.delete(peerId); }
  }
  return false;
}

// ─── Stale peer cleanup ────────────────────────────────────────

function cleanStalePeers() {
  const peers = db.prepare("SELECT id, pid, last_seen, sleep FROM peers").all() as unknown as { id: string; pid: number; last_seen: string; sleep: number }[];
  const now = Date.now();
  for (const peer of peers) {
    // Skip already-sleeping peers — they have no active session, so stale checks don't apply
    if (peer.sleep) continue;

    const staleByTime = now - new Date(peer.last_seen).getTime() > PEER_TIMEOUT_MS;
    let deadByPid = false;
    // Only use PID check when the stored PID is not the broker's own PID
    // (MCP peers are registered with process.pid which is always alive)
    if (peer.pid !== process.pid && peer.pid !== 0) {
      try {
        process.kill(peer.pid, 0);
      } catch {
        deadByPid = true;
      }
    }
    if (staleByTime || deadByPid) {
      detachPeer(peer.id);
    }
  }
}

// NOTE: cleanStalePeers() is called after prepared statements are defined (see below)

// ─── Prepared statements ───────────────────────────────────────

const insertPeer = db.prepare(`
  INSERT INTO peers (id, agent_type, source, pid, cwd, git_root, tty, context_json, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateContext = db.prepare(`UPDATE peers SET context_json = ?, last_seen = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const deleteMessagesForPeer = db.prepare(`DELETE FROM messages WHERE from_id = ? OR to_id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeerById = db.prepare(`SELECT * FROM peers WHERE id = ?`);
const selectActiveByPid = db.prepare(`SELECT * FROM peers WHERE pid = ? AND sleep = 0 LIMIT 1`);
const selectSuspendedByRepo = db.prepare(`SELECT * FROM peers WHERE agent_type = ? AND git_root = ? AND sleep = 1 ORDER BY last_seen DESC LIMIT 1`);
const selectSuspendedByCwd = db.prepare(`SELECT * FROM peers WHERE agent_type = ? AND cwd = ? AND sleep = 1 ORDER BY last_seen DESC LIMIT 1`);
const selectMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, type, text, payload_json, sent_at, delivered, reply_to, from_user)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
`);
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// ─── Stale peer cleanup (deferred until prepared statements are ready) ──
cleanStalePeers();
setInterval(cleanStalePeers, STALE_PEER_CLEANUP_MS);

// ─── Helpers ───────────────────────────────────────────────────

const PEER_NOUNS = [
  "ant", "bat", "bear", "cat", "crab", "crow", "deer", "doe",
  "duck", "elk", "emu", "finch", "fox", "frog", "gnu", "goat",
  "hawk", "hen", "ibis", "impala", "jaguar", "jay", "koala", "koi",
  "lemur", "lynx", "mink", "moose", "narwhal", "newt", "orca", "owl",
  "panda", "pug", "quail", "ram", "robin", "seal", "swan", "tiger",
  "toad", "urchin", "viper", "vole", "wolf", "wren", "yak", "zebu",
];

function generateId(existingIds: Set<string>): string {
  const shuffled = [...PEER_NOUNS].sort(() => Math.random() - 0.5);
  for (const noun of shuffled) {
    if (!existingIds.has(noun)) return noun;
  }
  // All nouns taken — fall back to noun + number
  for (let i = 2; ; i++) {
    const id = `${shuffled[0]}-${i}`;
    if (!existingIds.has(id)) return id;
  }
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

interface RawPeerRow {
  id: string;
  agent_type: string;
  source: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  context_json: string;
  registered_at: string;
  last_seen: string;
  sleep: number;
}

const countAllMessages = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE to_id = ?`);
const selectAllMessagesForPeer = db.prepare(`SELECT * FROM messages WHERE to_id = ? ORDER BY sent_at ASC`);
const deleteMessageById = db.prepare(`DELETE FROM messages WHERE id = ?`);
const clearMessagesForPeer = db.prepare(`DELETE FROM messages WHERE to_id = ?`);

function rowToPeer(row: RawPeerRow): Peer {
  return {
    id: row.id,
    agentType: row.agent_type as Peer["agentType"],
    pid: row.pid,
    cwd: row.cwd,
    gitRoot: row.git_root,
    tty: row.tty,
    source: (row.source ?? "terminal") as Peer["source"],
    context: JSON.parse(row.context_json) as AgentContext,
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
    connected: !row.sleep,
    suspended: !!row.sleep,
    totalMessages: (() => {
      const cnt = (countAllMessages.get(row.id) as unknown as { cnt: number })?.cnt ?? 0;
      return cnt > 0 ? cnt : undefined;
    })(),
  };
}

interface RawMessageRow {
  id: number;
  from_id: string;
  to_id: string;
  type: string;
  text: string;
  payload_json: string | null;
  reply_to: number | null;
  sent_at: string;
  delivered: number;
  from_user: number;
}

function rowToMessage(row: RawMessageRow): Message {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type as Message["type"],
    text: row.text,
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    replyTo: row.reply_to ?? undefined,
    sentAt: row.sent_at,
    delivered: !!row.delivered,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


/**
 * When multiple MCP server instances read the same Claude Code session JSONL file
 * (e.g. because an older MCP server's fallback picked the most-recent file), they
 * report identical session-derived context: summary (session title) AND
 * recentContext.  This function detects duplicates and keeps the data only on
 * the peer that registered earliest (most likely the true session owner).
 */
function deduplicateExchanges(peers: Peer[]): void {
  // Fingerprint each peer's session-derived data (exchanges + summary).
  // Two peers sharing the same session file will have identical fingerprints.
  const seen = new Map<string, string>(); // fingerprint → peerId (earliest owner)

  for (const peer of peers) {
    const exchanges = peer.context.recentContext;
    const hasExchanges = exchanges && exchanges.length > 0;
    if (!hasExchanges) continue;

    const fp = exchanges.map(e => `${e.role}:${e.text}`).join("|");
    const existing = seen.get(fp);
    if (existing === undefined) {
      seen.set(fp, peer.id);
    } else {
      // Duplicate — the later-registered peer is the impostor
      const existingPeer = peers.find(p => p.id === existing);
      if (existingPeer && existingPeer.registeredAt <= peer.registeredAt) {
        clearSessionContext(peer);
      } else if (existingPeer) {
        clearSessionContext(existingPeer);
        seen.set(fp, peer.id);
      }
    }
  }
}

/** Clear context fields that are derived from reading the Claude Code session file. */
function clearSessionContext(peer: Peer): void {
  peer.context.recentContext = [];
  peer.context.summary = "";
  peer.context.conversationDigest = undefined;
}

// ─── Request handlers ──────────────────────────────────────────

function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();
  const contextJson = JSON.stringify(body.context);
  const source = body.source ?? "terminal";

  // Wrap in a transaction so register/resume is atomic.
  db.exec("BEGIN");
  let id: string;
  try {
    // 1. If preferredId is given (e.g. extension peers), use that stable identity.
    // 2. Else, if the same owner PID is already active, keep that identity (prevents ID churn).
    // 3. Else, claim a sleeping peer of the same agentType in the same project.
    let existingRow: RawPeerRow | undefined;
    if (body.preferredId) {
      existingRow = selectPeerById.get(body.preferredId) as unknown as RawPeerRow | undefined;
    } else {
      existingRow = selectActiveByPid.get(body.pid) as unknown as RawPeerRow | undefined;
    }

    if (!existingRow && body.gitRoot) {
      existingRow = selectSuspendedByRepo.get(body.agentType, body.gitRoot) as unknown as RawPeerRow | undefined;
    } else if (!existingRow) {
      existingRow = selectSuspendedByCwd.get(body.agentType, body.cwd) as unknown as RawPeerRow | undefined;
    }

    if (existingRow) {
      // Resume existing peer: reassign session, unsuspend, update connection info
      id = existingRow.id;
      // Merge context: preserve existing data, only overlay non-empty new fields
      const existingContext = JSON.parse(existingRow.context_json) as AgentContext;
      const incoming = body.context;
      const mergedContext: AgentContext = {
        ...existingContext,
        // Only overwrite with incoming values when they carry real data
        summary: (incoming.summary && incoming.summary !== "Untitled")
          ? incoming.summary
          : existingContext.summary ?? "",
        activeFiles: incoming.activeFiles?.length ? incoming.activeFiles : existingContext.activeFiles,
        git: incoming.git ?? existingContext.git,
        currentTask: incoming.currentTask || existingContext.currentTask,
        taskIntent: incoming.taskIntent ?? existingContext.taskIntent,
        recentContext: incoming.recentContext?.length ? incoming.recentContext : existingContext.recentContext,
        conversationDigest: incoming.conversationDigest || existingContext.conversationDigest,
        metadata: incoming.metadata ?? existingContext.metadata,
        updatedAt: now,
      };
      db.prepare(`
        UPDATE peers
        SET pid = ?, cwd = ?, git_root = ?, tty = ?, source = ?,
            agent_type = ?, context_json = ?, last_seen = ?, sleep = 0
        WHERE id = ?
      `).run(body.pid, body.cwd, body.gitRoot, body.tty, source,
             body.agentType, JSON.stringify(mergedContext), now, id);
      log(`Peer ${id} resumed (was sleep=${!!existingRow.sleep})`);
    } else {
      // No sleeping peer of this kind — create new one
      const existingIds = new Set((selectAllPeers.all() as unknown as RawPeerRow[]).map((r) => r.id));
      if (body.preferredId && !existingIds.has(body.preferredId)) {
        id = body.preferredId;
      } else {
        id = generateId(existingIds);
      }
      insertPeer.run(id, body.agentType, source, body.pid, body.cwd, body.gitRoot, body.tty, contextJson, now, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const peer = rowToPeer(selectPeerById.get(id) as unknown as RawPeerRow);
  broadcast({
    type: "peer-joined",
    data: peer,
    timestamp: now,
  } satisfies WsPeerJoinedEvent);

  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };
  const now = new Date().toISOString();
  const pid = body.pid ?? row.pid;
  const source = body.source ?? row.source;
  if (row.sleep) {
    // Peer is alive (sending heartbeats) — resume it
    db.prepare("UPDATE peers SET sleep = 0, pid = ?, source = ?, last_seen = ? WHERE id = ?")
      .run(pid, source, now, body.id);
    const peer = rowToPeer(selectPeerById.get(body.id) as unknown as RawPeerRow);
    broadcast({ type: "peer-joined", data: peer, timestamp: now } satisfies WsPeerJoinedEvent);
    log(`Peer ${body.id} resumed via heartbeat (pid=${pid}, source=${source})`);
  } else {
    // Update PID/source if changed
    if ((body.pid && body.pid !== row.pid) || (body.source && body.source !== row.source)) {
      db.prepare("UPDATE peers SET pid = ?, source = ?, last_seen = ? WHERE id = ?")
        .run(pid, source, now, body.id);
    } else {
      updateLastSeen.run(now, body.id);
    }
  }
  return { ok: true };
}

function handleUpdateContext(body: UpdateContextRequest): void {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return;

  const existing = JSON.parse(row.context_json) as AgentContext;
  // Only bump updatedAt when summary or currentTask actually changes
  const meaningfulChange =
    (body.context.summary !== undefined && body.context.summary !== existing.summary) ||
    (body.context.currentTask !== undefined && body.context.currentTask !== existing.currentTask);
  const merged: AgentContext = {
    ...existing,
    ...body.context,
    updatedAt: meaningfulChange ? new Date().toISOString() : existing.updatedAt,
  };

  const now = new Date().toISOString();
  updateContext.run(JSON.stringify(merged), now, body.id);

  broadcast({
    type: "context-updated",
    data: { id: body.id, context: merged },
    timestamp: now,
  } satisfies WsContextUpdatedEvent);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let rows: RawPeerRow[];

  switch (body.scope) {
    case "machine":
      rows = selectAllPeers.all() as unknown as RawPeerRow[];
      break;
    case "directory":
      rows = selectPeersByDirectory.all(body.cwd) as unknown as RawPeerRow[];
      break;
    case "repo":
      if (body.gitRoot) {
        // Same repo OR gitRoot unknown (can't exclude definitively)
        rows = (selectAllPeers.all() as unknown as RawPeerRow[]).filter(
          (r) => r.git_root === body.gitRoot || r.git_root === null,
        );
      } else {
        rows = selectPeersByDirectory.all(body.cwd) as unknown as RawPeerRow[];
      }
      break;
    default:
      rows = selectAllPeers.all() as unknown as RawPeerRow[];
  }

  if (body.excludeId) {
    rows = rows.filter((r) => r.id !== body.excludeId);
  }

  const peers = rows.map(rowToPeer);

  // Deduplicate recentContext: when multiple peers report identical conversation
  // histories (caused by MCP servers reading the same session file), keep the
  // exchanges only on the peer that registered earliest (most likely the true owner)
  // and clear them from the others.
  deduplicateExchanges(peers);

  return peers;
}

// ─── Duplicate task-handoff detection ─────────────────────────

/** Find recent task-handoff messages from this sender that are still open (no report reply yet). */
const selectRecentOpenTaskHandoffs = db.prepare(`
  SELECT m.*, p.context_json, p.agent_type
  FROM messages m
  JOIN peers p ON p.id = m.to_id
  WHERE m.from_id = ? AND m.type = 'task-handoff'
    AND NOT EXISTS (
      SELECT 1 FROM messages r WHERE r.type = 'report' AND r.reply_to = m.id
    )
  ORDER BY m.sent_at DESC
  LIMIT 20
`);

function checkDuplicateTaskHandoff(fromId: string, text: string): DuplicateTaskInfo[] {
  const duplicates: DuplicateTaskInfo[] = [];
  const textTokens = extractTokens(text);
  if (textTokens.length < 2) return duplicates;

  // Check 1: Recent open task-handoff messages from the same sender
  const recentHandoffs = selectRecentOpenTaskHandoffs.all(fromId) as unknown as (RawMessageRow & { context_json: string; agent_type: string })[];
  for (const row of recentHandoffs) {
    const handoffTokens = extractTokens(row.text);
    const commonTokens = textTokens.filter(t => handoffTokens.includes(t));
    if (commonTokens.length < 3) continue;

    const ratio = commonTokens.length / Math.max(textTokens.length, handoffTokens.length);
    if (ratio < 0.3) continue;

    const confidence = ratio >= 0.6 ? "high" : ratio >= 0.4 ? "medium" : "low";
    duplicates.push({
      peerId: row.to_id,
      agentType: row.agent_type,
      taskDescription: row.text.slice(0, 200),
      reason: `Similar task-handoff already sent to ${row.to_id} (shared keywords: ${commonTokens.slice(0, 5).join(", ")})`,
      confidence,
    });
  }

  // Check 2: Peers whose currentTask/taskIntent overlaps with this handoff
  const allPeers = (selectAllPeers.all() as unknown as RawPeerRow[])
    .filter(r => r.id !== fromId);

  for (const row of allPeers) {
    // Skip peers we already flagged from message check
    if (duplicates.some(d => d.peerId === row.id)) continue;

    const ctx = JSON.parse(row.context_json) as AgentContext;
    const peerTaskText = [ctx.currentTask, ctx.taskIntent?.description].filter(Boolean).join(" ");
    if (!peerTaskText) continue;

    const peerTokens = extractTokens(peerTaskText);
    const commonTokens = textTokens.filter(t => peerTokens.includes(t));
    if (commonTokens.length < 3) continue;

    const ratio = commonTokens.length / Math.max(textTokens.length, peerTokens.length);
    if (ratio < 0.3) continue;

    const confidence = ratio >= 0.6 ? "high" : ratio >= 0.4 ? "medium" : "low";
    duplicates.push({
      peerId: row.id,
      agentType: row.agent_type,
      taskDescription: (ctx.currentTask ?? ctx.taskIntent?.description ?? "").slice(0, 200),
      reason: `Peer is already working on similar task (shared keywords: ${commonTokens.slice(0, 5).join(", ")})`,
      confidence,
    });
  }

  return duplicates;
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  const target = selectPeerById.get(body.toId) as unknown as RawPeerRow | undefined;
  if (!target) {
    return { ok: false, error: `Peer ${body.toId} not found` };
  }

  // Reject messages to sleeping peers — they have no active session to receive them
  if (target.suspended) {
    return {
      ok: false,
      error: `Cannot send message to peer ${body.toId}: peer is currently sleeping. Wait for it to resume or choose a different peer.`,
    };
  }

  // Reject task-handoff to extension peers — they cannot autonomously execute tasks
  const targetSource = target.source ?? "terminal";
  if (targetSource !== "terminal" && body.type === "task-handoff") {
    return {
      ok: false,
      error: `Cannot send task-handoff to extension peer ${body.toId}: extension peers cannot execute tasks autonomously. Choose a terminal peer instead.`,
    };
  }

  // For report messages to extension peers, validate the replyTo chain
  if (targetSource !== "terminal" && body.type === "report") {
    if (!body.replyTo) {
      return { ok: false, error: `Report to ${targetSource} peer ${body.toId} must include replyTo for the original task-handoff.` };
    }

    const original = selectMessageById.get(body.replyTo) as unknown as RawMessageRow | undefined;
    if (!original) {
      return { ok: false, error: `Original message ${body.replyTo} not found.` };
    }

    if (original.type !== "task-handoff") {
      return { ok: false, error: `replyTo ${body.replyTo} must reference a task-handoff when sending a report to an extension peer.` };
    }

    if (original.from_id !== body.toId || original.to_id !== body.fromId) {
      return { ok: false, error: `Report to extension peer ${body.toId} must reply to a task-handoff originally sent from that peer to ${body.fromId}.` };
    }
  }

  // Duplicate task-handoff detection (skip if force flag is set)
  if (body.type === "task-handoff" && !body.force) {
    const duplicates = checkDuplicateTaskHandoff(body.fromId, body.text);
    if (duplicates.length > 0) {
      return {
        ok: false,
        error: `Duplicate task detected: similar work is already assigned or in progress. Use force=true to send anyway.`,
        duplicates,
      };
    }
  }

  const now = new Date().toISOString();
  const payloadJson = body.payload ? JSON.stringify(body.payload) : null;
  const replyTo = body.replyTo ?? null;
  const fromUser = body.fromUser ? 1 : 0;
  insertMessage.run(body.fromId, body.toId, body.type, body.text, payloadJson, now, replyTo, fromUser);

  // Get the inserted message
  const lastId = db.prepare("SELECT last_insert_rowid() as id").get() as unknown as { id: number };
  const msgRow = db.prepare("SELECT * FROM messages WHERE id = ?").get(lastId.id) as unknown as RawMessageRow;
  const msg = rowToMessage(msgRow);

  const event = {
    type: "message",
    data: msg,
    timestamp: now,
  } satisfies WsMessageEvent;

  if (body.type === "report") {
    // Reports are NOT delivered to the recipient's terminal.
    // They accumulate silently — only broadcast to anonymous WS clients (extension UI)
    // so the sidebar can refresh and show the stored message list.
    const broadcastJson = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(broadcastJson); } catch { wsClients.delete(ws); }
      }
    }
  } else {
    // Normal messages: try targeted delivery to the recipient peer via WS
    const delivered = sendToPeer(body.toId, event);
    if (delivered) {
      markDelivered.run(msgRow.id);
    }

    // Also broadcast to anonymous clients (VSCode extension UI etc.)
    const broadcastJson = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(broadcastJson); } catch { wsClients.delete(ws); }
      }
    }
  }

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const exists = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!exists) return { found: false, messages: [] };

  const rows = selectUndelivered.all(body.id) as unknown as unknown as RawMessageRow[];
  for (const row of rows) {
    // Mark delivered when the agent actively polls for new messages
    if (!row.delivered) markDelivered.run(row.id);
  }

  return {
    found: true,
    messages: rows.map((row) => {
      const msg = rowToMessage(row);
      if (msg.type === "task-handoff") {
        msg.text =
          msg.text +
          `\n\n---\n[Agent Peers] This is a task-handoff. Please send a \`report\` message back to "${msg.fromId}" (use reply_to: ${msg.id}) when the task is complete.`;
      }
      return msg;
    }),
  };
}

/** Return pending undelivered messages and mark them delivered.
 *  Used by the MCP server's WS-reconnect drain so already-delivered messages
 *  are not replayed repeatedly across reconnects. */
function handlePeekMessages(body: PollMessagesRequest): PollMessagesResponse {
  const exists = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!exists) return { found: false, messages: [] };

  const rows = selectUndelivered.all(body.id) as unknown as unknown as RawMessageRow[];
  for (const row of rows) {
    if (!row.delivered) markDelivered.run(row.id);
  }

  return { found: true, messages: rows.map(rowToMessage) };
}

/** Detach a session from a peer: put to sleep, clear PID, but keep data & messages. */
function detachPeer(id: string): void {
  const row = selectPeerById.get(id) as unknown as RawPeerRow | undefined;
  if (!row) return;
  if (row.sleep) return; // already detached
  db.prepare("UPDATE peers SET sleep = 1, pid = 0 WHERE id = ?").run(id);
  const now = new Date().toISOString();
  broadcast({
    type: "context-updated",
    data: { id, context: { ...JSON.parse(row.context_json), updatedAt: now } },
    timestamp: now,
  } satisfies WsContextUpdatedEvent);
  log(`Peer ${id} detached (sleep)`);
}

/** Hard-remove a peer and all its messages. */
function removePeer(id: string): void {
  const row = selectPeerById.get(id) as unknown as RawPeerRow | undefined;
  if (!row) return;
  deleteMessagesForPeer.run(id, id);
  deletePeer.run(id);
  broadcast({
    type: "peer-left",
    data: { id },
    timestamp: new Date().toISOString(),
  } satisfies WsPeerLeftEvent);
  log(`Peer ${id} removed`);
}

function handleDeletePeer(body: { id: string }): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };
  removePeer(body.id);
  return { ok: true };
}

function handleUnregister(body: { id: string }): void {
  detachPeer(body.id);
}

function handleSuspendPeer(body: { id: string }): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };
  detachPeer(body.id);
  return { ok: true };
}

function handleResumePeer(body: { id: string }): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };
  if (!row.sleep) return { ok: true }; // already active
  db.prepare("UPDATE peers SET sleep = 0, last_seen = ? WHERE id = ?").run(new Date().toISOString(), body.id);
  const peer = rowToPeer(selectPeerById.get(body.id) as unknown as RawPeerRow);
  broadcast({
    type: "peer-joined",
    data: peer,
    timestamp: new Date().toISOString(),
  } satisfies WsPeerJoinedEvent);
  log(`Peer ${body.id} resumed`);
  return { ok: true };
}

function handlePurge(): { purged: number } {
  const peers = selectAllPeers.all() as unknown as RawPeerRow[];
  for (const peer of peers) {
    // Terminate the MCP server process so orphaned sessions don't re-register
    if (peer.pid !== process.pid) {
      terminateProcess(peer.pid);
    }
    db.prepare("DELETE FROM peers WHERE id = ?").run(peer.id);
    broadcast({ type: "peer-left", data: { id: peer.id }, timestamp: new Date().toISOString() } satisfies WsPeerLeftEvent);
  }
  return { purged: peers.length };
}

function handleCleanup(): { suspended: number; remaining: number } {
  const peers = selectAllPeers.all() as unknown as RawPeerRow[];
  let slept = 0;
  for (const peer of peers) {
    if (peer.sleep) continue; // already sleeping
    let dead = false;
    if (peer.pid !== process.pid && peer.pid !== 0) {
      try { process.kill(peer.pid, 0); } catch { dead = true; }
    }
    if (dead) {
      detachPeer(peer.id);
      slept++;
    }
  }
  return { suspended: slept, remaining: (selectAllPeers.all() as unknown as RawPeerRow[]).length };
}

// ─── Conflict detection ──────────────────────────────────────

const CONFLICT_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","shall","should","may","might","must","can",
  "could","to","of","in","for","on","with","at","by","from","this","that","it",
  "and","or","but","not","no","so","if","then","as","into","about","i","we","you",
  "my","your","its","their","our","all","each","file","files","code","change",
  "changes","make","update","please","want","need","let","use","using","also",
  "like","just","get","set","add","new","now","see","look","check","run","try",
]);

function extractTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !CONFLICT_STOPWORDS.has(t));
}

function handleCheckConflicts(body: CheckConflictsRequest): CheckConflictsResponse {
  const rows = (selectAllPeers.all() as unknown as RawPeerRow[])
    .filter(r => r.id !== body.callerId)
    .filter(r => body.gitRoot ? r.git_root === body.gitRoot : false);

  const conflicts: ConflictResult[] = [];
  const promptLower = body.prompt.toLowerCase();
  const promptTokens = extractTokens(body.prompt);

  for (const row of rows) {
    const peer = rowToPeer(row);
    const intent = peer.context.taskIntent;
    if (!intent || intent.targetFiles.length === 0) continue;

    const reasons: string[] = [];
    let score = 0;

    // Check 1: File path overlap — prompt mentions files the peer is modifying
    const fileMatches = intent.targetFiles.filter(f => {
      const basename = f.split("/").pop()!.toLowerCase();
      const fLower = f.toLowerCase();
      return promptLower.includes(basename) || promptLower.includes(fLower);
    });
    if (fileMatches.length > 0) {
      score += 3 * fileMatches.length;
      reasons.push(`Overlapping files: ${fileMatches.join(", ")}`);
    }

    // Check 2: Directory/module overlap — prompt mentions areas the peer is working in
    const areaMatches = intent.targetAreas.filter(a =>
      promptLower.includes(a.toLowerCase())
    );
    if (areaMatches.length > 0) {
      score += 2 * areaMatches.length;
      reasons.push(`Overlapping areas: ${areaMatches.join(", ")}`);
    }

    // Check 3: Keyword overlap — significant tokens in common
    const intentTokens = extractTokens(intent.description);
    const commonTokens = intentTokens.filter(t => promptTokens.includes(t));
    if (commonTokens.length >= 2) {
      score += commonTokens.length;
      reasons.push(`Related keywords: ${commonTokens.join(", ")}`);
    }

    // Check 4: Recent context overlap — digest or assistant turns vs prompt
    const ctx = peer.context;
    const contextText = ctx.conversationDigest
      ?? ctx.recentContext?.filter(e => e.role === "assistant").map(e => e.text).join(" ")
      ?? "";
    if (contextText) {
      const contextTokens = extractTokens(contextText);
      const contextCommon = contextTokens.filter(t => promptTokens.includes(t));
      if (contextCommon.length >= 2) {
        score += Math.min(contextCommon.length, 3); // cap at +3 to avoid overweight
        reasons.push(`Context overlap: ${contextCommon.slice(0, 5).join(", ")}`);
      }
    }

    if (score >= 3) {
      const confidence = score >= 6 ? "high" : score >= 4 ? "medium" : "low";
      conflicts.push({
        peerId: peer.id,
        agentType: peer.agentType,
        summary: peer.context.summary,
        taskIntent: intent,
        reason: reasons.join("; "),
        confidence,
      });
    }
  }

  return { conflicts };
}

/** List report messages for a peer (reports sent TO this peer). */
function handleListReports(body: { id: string }): { reports: Message[] } {
  const rows = db.prepare("SELECT * FROM messages WHERE to_id = ? AND type = 'report' ORDER BY sent_at ASC").all(body.id) as unknown as RawMessageRow[];
  return { reports: rows.map(rowToMessage) };
}

/** List all stored messages for a peer — used by the sidebar for persistent display. */
function handleListMessages(body: { id: string }): { messages: Message[] } {
  const exists = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!exists) return { messages: [] };
  const rows = selectAllMessagesForPeer.all(body.id) as unknown as RawMessageRow[];
  return { messages: rows.map(rowToMessage) };
}

/** Delete a single message by ID. */
function handleDeleteMessage(body: { id: number }): { ok: boolean } {
  deleteMessageById.run(body.id);
  return { ok: true };
}

/** Delete all messages for a peer. */
function handleClearMessages(body: { peerId: string }): { ok: boolean; cleared: number } {
  const rows = selectAllMessagesForPeer.all(body.peerId) as unknown as RawMessageRow[];
  clearMessagesForPeer.run(body.peerId);
  return { ok: true, cleared: rows.length };
}

function handleWakePeer(body: { id: string }): { ok: boolean; delivered: number } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false, delivered: 0 };

  // Collect undelivered messages for this peer
  const msgs = selectUndelivered.all(body.id) as unknown as RawMessageRow[];

  // Send a wake event with pending messages to the peer's MCP server via WS
  const wakeEvent: WsEvent = {
    type: "wake",
    data: { id: body.id, messages: msgs.map(rowToMessage) },
    timestamp: new Date().toISOString(),
  };
  const sent = sendToPeer(body.id, wakeEvent);

  // Mark messages as delivered if WS delivery succeeded
  let delivered = 0;
  if (sent) {
    for (const msg of msgs) {
      markDelivered.run(msg.id);
      delivered++;
    }
  }

  return { ok: sent, delivered };
}

function handleUpdateConfig(body: { autoConflictCheck?: boolean }): { ok: boolean; autoConflictCheck: boolean } {
  if (body.autoConflictCheck !== undefined) {
    AUTO_CONFLICT_CHECK = body.autoConflictCheck;
  }
  return { ok: true, autoConflictCheck: AUTO_CONFLICT_CHECK };
}

function handleHealth(): BrokerHealthResponse {
  return {
    status: "ok",
    pid: process.pid,
    peerCount: (selectAllPeers.all() as unknown as RawPeerRow[]).length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    autoConflictCheck: AUTO_CONFLICT_CHECK,
  };
}

// ─── HTTP Server ───────────────────────────────────────────────

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Connection": "close",
};

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    if (path === "/health") {
      return jsonResponse(handleHealth(), { headers: corsHeaders });
    }
    return new Response("agent-peers broker v0.1.0", { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    let result: unknown;
    switch (path) {
      case "/register":
        result = handleRegister(body as RegisterRequest);
        break;
      case "/heartbeat":
        result = handleHeartbeat(body as HeartbeatRequest);
        break;
      case "/update-context":
        handleUpdateContext(body as UpdateContextRequest);
        result = { ok: true };
        break;
      case "/list-peers":
        result = handleListPeers(body as ListPeersRequest);
        break;
      case "/send-message":
        result = handleSendMessage(body as SendMessageRequest);
        break;
      case "/poll-messages":
        result = handlePollMessages(body as PollMessagesRequest);
        break;
      case "/peek-messages":
        result = handlePeekMessages(body as PollMessagesRequest);
        break;
      case "/unregister":
        handleUnregister(body as { id: string });
        result = { ok: true };
        break;
      case "/delete-peer":
        result = handleDeletePeer(body as { id: string });
        break;
      case "/suspend-peer":
        result = handleSuspendPeer(body as { id: string });
        break;
      case "/resume-peer":
        result = handleResumePeer(body as { id: string });
        break;
      case "/check-conflicts":
        result = handleCheckConflicts(body as CheckConflictsRequest);
        break;
      case "/list-reports":
        result = handleListReports(body as { id: string });
        break;
      case "/list-messages":
        result = handleListMessages(body as { id: string });
        break;
      case "/delete-message":
        result = handleDeleteMessage(body as { id: number });
        break;
      case "/clear-messages":
        result = handleClearMessages(body as { peerId: string });
        break;
      case "/wake-peer":
        result = handleWakePeer(body as { id: string });
        break;
      case "/cleanup":
        result = handleCleanup();
        break;
      case "/purge":
        result = handlePurge();
        break;
      case "/update-config":
        result = handleUpdateConfig(body as { autoConflictCheck?: boolean });
        break;
      case "/shutdown":
        result = { ok: true };
        // Exit after response is sent
        setTimeout(() => process.exit(0), 100);
        break;
      default:
        return jsonResponse({ error: "not found" }, { status: 404, headers: corsHeaders });
    }

    return jsonResponse(result, { headers: corsHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: msg }, { status: 500, headers: corsHeaders });
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

http.createServer(async (nodeReq, nodeRes) => {
  try {
    const bodyBuf = await readBody(nodeReq);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const webReq = new Request(`http://127.0.0.1:${PORT}${nodeReq.url ?? "/"}`, {
      method: nodeReq.method ?? "GET",
      headers,
      body: bodyBuf.length > 0 && nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? bodyBuf : null,
    });
    const webRes = await handleRequest(webReq);

    webRes.headers.forEach((v, k) => nodeRes.setHeader(k, v));

    // Buffer the full response body instead of streaming via ReadableStream reader.
    // The previous while(true) { reader.read() } loop could spin at 100% CPU
    // due to Node.js 22's experimental Web Response ReadableStream edge cases.
    const responseBody = await webRes.text();
    nodeRes.writeHead(webRes.status);
    nodeRes.end(responseBody);
  } catch (e) {
    if (!nodeRes.headersSent) nodeRes.writeHead(500);
    if (!nodeRes.writableEnded) nodeRes.end(JSON.stringify({ error: String(e) }));
  }
}).on("connection", (socket) => {
  // Prevent CLOSE_WAIT accumulation: destroy idle sockets after 30s.
  // Broker requests are short-lived; no reason to keep connections open.
  socket.setTimeout(30_000, () => socket.destroy());
  socket.setKeepAlive(false);
}).listen(PORT, "127.0.0.1", () => {
  log(`HTTP listening on 127.0.0.1:${PORT}`);
}).on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log(`Port ${PORT} already in use — another broker is running, exiting.`);
    process.exit(0);
  }
  throw err;
});

// ─── WebSocket Server ──────────────────────────────────────────

const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
wss.on("connection", (ws) => {
  // Start as anonymous client; promoted to peer client on "identify" message
  wsClients.add(ws);
  let identifiedPeerId: string | null = null;
  log(`WebSocket client connected (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as { type?: string; id?: string; pid?: number; source?: string };
      if (msg.type === "identify" && msg.id) {
        // Promote from anonymous to peer-identified
        wsClients.delete(ws);
        identifiedPeerId = msg.id;
        wsPeerClients.set(msg.id, ws);
        // Resume sleeping peer on WS re-identify (e.g. after reconnect)
        const row = selectPeerById.get(msg.id) as unknown as RawPeerRow | undefined;
        if (row?.sleep) {
          const pid = typeof msg.pid === "number" ? msg.pid : row.pid;
          const source = (msg.source === "extension" || msg.source === "terminal") ? msg.source : row.source;
          db.prepare("UPDATE peers SET sleep = 0, pid = ?, source = ?, last_seen = ? WHERE id = ?")
            .run(pid, source, new Date().toISOString(), msg.id);
          const peer = rowToPeer(selectPeerById.get(msg.id) as unknown as RawPeerRow);
          broadcast({ type: "peer-joined", data: peer, timestamp: new Date().toISOString() } satisfies WsPeerJoinedEvent);
          log(`Peer ${msg.id} resumed via WS identify (pid=${pid}, source=${source})`);
        } else if (row) {
          // Not sleeping but source/pid may need updating
          const pid = typeof msg.pid === "number" ? msg.pid : row.pid;
          const source = (msg.source === "extension" || msg.source === "terminal") ? msg.source : row.source;
          if (pid !== row.pid || source !== row.source) {
            db.prepare("UPDATE peers SET pid = ?, source = ?, last_seen = ? WHERE id = ?")
              .run(pid, source, new Date().toISOString(), msg.id);
            log(`Peer ${msg.id} updated via WS identify (pid=${pid}, source=${source})`);
          }
        }
        log(`WebSocket peer identified: ${msg.id} (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    if (identifiedPeerId) {
      wsPeerClients.delete(identifiedPeerId);
      // Only suspend if the owner process is dead; skip if still alive
      const row = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow | undefined;
      let ownerAlive = false;
      if (row && row.pid > 0) {
        try { process.kill(row.pid, 0); ownerAlive = true; } catch { /* dead */ }
      }
      if (!ownerAlive) {
        detachPeer(identifiedPeerId);
      } else {
        log(`WebSocket disconnected for ${identifiedPeerId} but owner pid ${row!.pid} alive — not suspending`);
      }
    }
    log(`WebSocket client disconnected (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);
  });
  ws.on("error", (err) => {
    log(`WebSocket client error: ${err.message}`);
    wsClients.delete(ws);
    if (identifiedPeerId) {
      wsPeerClients.delete(identifiedPeerId);
      const row = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow | undefined;
      let ownerAlive = false;
      if (row && row.pid > 0) {
        try { process.kill(row.pid, 0); ownerAlive = true; } catch { /* dead */ }
      }
      if (!ownerAlive) {
        detachPeer(identifiedPeerId);
      }
    }
  });
});
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log(`WS port ${WS_PORT} already in use — another broker is running, exiting.`);
    process.exit(0);
  }
  log(`WebSocket server error: ${err.message}`);
});

function log(msg: string) {
  console.error(`[agent-peers broker] ${msg}`);
}

// ─── Global error guards (keep broker alive) ───────────────────

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

log(`HTTP listening on 127.0.0.1:${PORT}`);
log(`WebSocket listening on 127.0.0.1:${WS_PORT}`);
log(`Database: ${DB_PATH}`);
