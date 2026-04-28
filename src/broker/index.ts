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
import crypto from "crypto";
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
  ConflictAdvisory,
  AddMemoryRequest,
  AddMemoryResponse,
  SearchMemoryRequest,
  SearchMemoryResponse,
  ListMemoriesRequest,
  ListMemoriesResponse,
  DeleteMemoryRequest,
  DeleteMemoryResponse,
  RepoMemory,
  WsEvent,
  WsMessageEvent,
  WsPeerJoinedEvent,
  WsPeerLeftEvent,
  WsPeerUpdatedEvent,
  WsContextUpdatedEvent,
  WsMemoryAddedEvent,
  ReservePeerRequest,
  ReservePeerResponse,
  PeerStatus,
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
let MAX_CONTEXT_LENGTH = parseInt(process.env.AGENT_PEERS_MAX_CONTEXT_LENGTH ?? "30", 10) || 30;
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

// Migration: copy stale suspended values into sleep and drop the old column.
// The ADD + RENAME sequence above can leave both columns when the DB already
// had a "suspended" column — the RENAME fails because "sleep" already exists.
try {
  db.exec("UPDATE peers SET sleep = suspended WHERE suspended = 1 AND sleep = 0");
  db.exec("ALTER TABLE peers DROP COLUMN suspended");
} catch { /* suspended column may not exist */ }

// Migration: add source column if missing
try {
  db.exec("ALTER TABLE peers ADD COLUMN source TEXT NOT NULL DEFAULT 'terminal'");
} catch { /* column already exists */ }

// Migration: add terminal_id and ext_host_id columns
try {
  db.exec("ALTER TABLE peers ADD COLUMN terminal_id TEXT");
} catch { /* column already exists */ }
try {
  db.exec("ALTER TABLE peers ADD COLUMN ext_host_id TEXT");
} catch { /* column already exists */ }
// Migration: add status column
try {
  db.exec("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch { /* column already exists */ }

// Wipe all stale sleeping peers — sleep state is abolished
db.exec("DELETE FROM peers WHERE sleep = 1");
db.exec("UPDATE peers SET status = 'active' WHERE status IS NULL OR status = ''")

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

// ─── Repo Memory tables ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS repo_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    git_root TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'architecture',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    files_json TEXT DEFAULT '[]',
    areas_json TEXT DEFAULT '[]',
    source_peer_id TEXT,
    source_exchange TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_repo_memories_git_root ON repo_memories(git_root)");
db.exec("CREATE INDEX IF NOT EXISTS idx_repo_memories_hash ON repo_memories(content_hash)");

// One-shot migration: collapse old 5 categories → 3 (task, issue, architecture)
try {
  db.exec(`
    UPDATE repo_memories SET category = 'issue' WHERE category = 'bug-fix';
    UPDATE repo_memories SET category = 'architecture' WHERE category IN ('decision','convention','learning');
  `);
} catch { /* safe to re-run */ }

// FTS5 full-text search (may not be available in all SQLite builds)
let hasFts5 = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS repo_memories_fts USING fts5(
      title, content,
      content=repo_memories, content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  // Sync triggers
  db.exec(`CREATE TRIGGER IF NOT EXISTS repo_memories_ai AFTER INSERT ON repo_memories BEGIN
    INSERT INTO repo_memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS repo_memories_ad AFTER DELETE ON repo_memories BEGIN
    INSERT INTO repo_memories_fts(repo_memories_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS repo_memories_au AFTER UPDATE ON repo_memories BEGIN
    INSERT INTO repo_memories_fts(repo_memories_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
    INSERT INTO repo_memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END`);
  hasFts5 = true;
} catch {
  // FTS5 not available — fall back to token-based search
}

// ─── WebSocket clients ─────────────────────────────────────────

/** Anonymous clients (e.g. VSCode extension) */
const wsClients = new Set<WebSocket>();
/** Peer-identified clients (MCP servers that sent {"type":"identify","id":"..."}) */
const wsPeerClients = new Map<string, Set<WebSocket>>();

function broadcast(event: WsEvent) {
  const json = JSON.stringify(event);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch { wsClients.delete(ws); }
    }
  }
  for (const [id, wsSet] of wsPeerClients) {
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(json); } catch { wsSet.delete(ws); }
      }
    }
    if (wsSet.size === 0) wsPeerClients.delete(id);
  }
}

/** Send an event to a specific peer (if connected via WS) */
function sendToPeer(peerId: string, event: WsEvent): boolean {
  const wsSet = wsPeerClients.get(peerId);
  if (!wsSet || wsSet.size === 0) return false;
  const json = JSON.stringify(event);
  let sent = false;
  for (const ws of wsSet) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); sent = true; } catch { wsSet.delete(ws); }
    }
  }
  return sent;
}

// ─── Stale peer cleanup ────────────────────────────────────────

function cleanStalePeers() {
  const peers = db.prepare("SELECT id, pid, last_seen, status FROM peers").all() as { id: string; pid: number; last_seen: string; status: string }[];
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  for (const peer of peers) {
    const staleByTime = now - new Date(peer.last_seen).getTime() > PEER_TIMEOUT_MS;
    const staleByFiveMin = now - new Date(peer.last_seen).getTime() > fiveMin;
    let deadByPid = false;
    if (peer.pid !== process.pid && peer.pid !== 0) {
      try { process.kill(peer.pid, 0); } catch { deadByPid = true; }
    }
    if (peer.status === "pending") {
      // Pending peers: clean up if last_seen > 5 min AND pid=0
      if (staleByFiveMin && peer.pid === 0) removePeer(peer.id);
    } else {
      // Active peers: clean up if stale by time AND dead pid
      if (staleByTime && deadByPid) removePeer(peer.id);
    }
  }
}

// NOTE: cleanStalePeers() is called after prepared statements are defined (see below)

// ─── Prepared statements ───────────────────────────────────────

const insertPeer = db.prepare(`
  INSERT INTO peers (id, agent_type, source, pid, cwd, git_root, tty,
                     terminal_id, ext_host_id, context_json, registered_at, last_seen, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateContext = db.prepare(`UPDATE peers SET context_json = ?, last_seen = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const deleteMessagesForPeer = db.prepare(`DELETE FROM messages WHERE from_id = ? OR to_id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeerById = db.prepare(`SELECT * FROM peers WHERE id = ?`);
const selectMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, type, text, payload_json, sent_at, delivered, reply_to, from_user)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
`);
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// ─── Repo Memory prepared statements ────────────────────────

const insertMemory = db.prepare(`
  INSERT INTO repo_memories (git_root, category, title, content, files_json, areas_json, source_peer_id, source_exchange, content_hash, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectMemoryByHash = db.prepare(`SELECT id FROM repo_memories WHERE content_hash = ? AND git_root = ?`);
const selectMemoryById = db.prepare(`SELECT * FROM repo_memories WHERE id = ?`);
const selectMemoriesByRepo = db.prepare(`SELECT * FROM repo_memories WHERE git_root = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`);
const selectMemoriesByRepoAndCategory = db.prepare(`SELECT * FROM repo_memories WHERE git_root = ? AND category = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`);
const countMemoriesByRepo = db.prepare(`SELECT COUNT(*) as cnt FROM repo_memories WHERE git_root = ?`);
const deleteMemoryById = db.prepare(`DELETE FROM repo_memories WHERE id = ?`);
const updateMemoryTimestamp = db.prepare(`UPDATE repo_memories SET updated_at = ? WHERE id = ?`);
const selectRecentMemoriesByRepo = db.prepare(`SELECT * FROM repo_memories WHERE git_root = ? ORDER BY updated_at DESC LIMIT ?`);

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
  terminal_id: string | null;
  ext_host_id: string | null;
  context_json: string;
  registered_at: string;
  last_seen: string;
  sleep: number;
  status: string;
}

const countAllMessages = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE to_id = ?`);
const selectAllMessagesForPeer = db.prepare(`SELECT * FROM messages WHERE to_id = ? ORDER BY sent_at ASC`);
const deleteMessageById = db.prepare(`DELETE FROM messages WHERE id = ?`);
const clearMessagesForPeer = db.prepare(`DELETE FROM messages WHERE to_id = ?`);

// ─── Stale peer cleanup (deferred until prepared statements are ready) ──
cleanStalePeers();
setInterval(cleanStalePeers, STALE_PEER_CLEANUP_MS);

function rowToPeer(row: RawPeerRow): Peer {
  return {
    id: row.id,
    agentType: row.agent_type as Peer["agentType"],
    pid: row.pid,
    cwd: row.cwd,
    gitRoot: row.git_root,
    tty: row.tty,
    terminalId: row.terminal_id,
    extHostId: row.ext_host_id,
    source: (row.source ?? "terminal") as Peer["source"],
    status: (row.status ?? "active") as PeerStatus,
    context: JSON.parse(row.context_json) as AgentContext,
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
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


/**
 * When multiple MCP server instances read the same Claude Code session JSONL file
 * (e.g. because an older MCP server's fallback picked the most-recent file), they
 * report identical session-derived context: summary (session title) AND
 * recentExchange.  This function detects duplicates and keeps the data only on
 * the peer that registered earliest (most likely the true session owner).
 */
function deduplicateExchanges(peers: Peer[]): void {
  // Fingerprint each peer's session-derived data (recentExchange markdown + summary).
  // Two peers sharing the same session file will have identical fingerprints.
  const seen = new Map<string, string>(); // fingerprint → peerId (earliest owner)

  for (const peer of peers) {
    const recentExchange = peer.context.recentExchange;
    if (!recentExchange) continue;

    const fp = recentExchange;
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
  peer.context.recentExchange = undefined;
  peer.context.summary = "";
  peer.context.conversationDigest = undefined;
}


// ─── Request handlers ──────────────────────────────────────────

function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();
  const source = body.source ?? "terminal";
  const terminalId = body.terminalId ?? null;

  let id: string;

  // If terminalId matches a pending reservation → activate it
  const pending = terminalId
    ? db.prepare("SELECT * FROM peers WHERE terminal_id = ? AND status = 'pending' LIMIT 1")
        .get(terminalId) as RawPeerRow | undefined
    : undefined;

  if (pending) {
    db.prepare(`UPDATE peers SET pid=?, cwd=?, git_root=?, tty=?, source=?,
                agent_type=?, context_json=?, last_seen=?, status='active' WHERE id=?`)
      .run(body.pid, body.cwd, body.gitRoot, body.tty, source,
           body.agentType, JSON.stringify(body.context), now, pending.id);
    id = pending.id;
  } else {
    // Manual launch (no terminalId) or extension peer — create or update peer
    db.exec("BEGIN");
    try {
      const allRows = selectAllPeers.all() as unknown as RawPeerRow[];
      const existingIds = new Set(allRows.map(r => r.id));

      if (body.preferredId && existingIds.has(body.preferredId)) {
        // preferredId already exists → UPDATE in place (e.g. ext peer re-registering)
        db.prepare(`UPDATE peers SET pid=?, cwd=?, git_root=?, tty=?, source=?, terminal_id=?,
                    agent_type=?, ext_host_id=?, context_json=?, last_seen=?, status='active'
                    WHERE id=?`)
          .run(body.pid, body.cwd, body.gitRoot, body.tty, source,
               terminalId, body.agentType, body.extHostId ?? null,
               JSON.stringify(body.context), now, body.preferredId);
        id = body.preferredId;
      } else {
        id = body.preferredId && !existingIds.has(body.preferredId)
          ? body.preferredId
          : generateId(existingIds);
        insertPeer.run(id, body.agentType, source, body.pid, body.cwd, body.gitRoot,
                       body.tty, terminalId, body.extHostId ?? null,
                       JSON.stringify(body.context), now, now, "active");
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  const peer = rowToPeer(selectPeerById.get(id) as unknown as RawPeerRow);
  // Re-registration of an existing preferredId → peer-updated (not peer-joined) to avoid sidebar duplication
  if (body.preferredId && peer.id === body.preferredId) {
    broadcast({ type: "peer-updated", data: peer, timestamp: now } satisfies WsPeerUpdatedEvent);
  } else {
    broadcast({ type: "peer-joined", data: peer, timestamp: now } satisfies WsPeerJoinedEvent);
  }
  return { id };
}

function handleReservePeer(body: ReservePeerRequest): ReservePeerResponse {
  const now = new Date().toISOString();
  const existingIds = new Set((selectAllPeers.all() as unknown as RawPeerRow[]).map(r => r.id));
  const id = generateId(existingIds);
  insertPeer.run(id, body.agentType, "terminal", 0, "", null,
                 null, body.terminalId, body.extHostId,
                 JSON.stringify({ summary: "", activeFiles: [], git: null, updatedAt: now }),
                 now, now, "pending");
  // Do NOT broadcast peer-joined yet — CLI hasn't started
  return { id, name: id };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };
  const now = new Date().toISOString();
  const pid = body.pid ?? row.pid;
  const source = body.source ?? row.source;
  if ((body.pid && body.pid !== row.pid) || (body.source && body.source !== row.source)) {
    db.prepare("UPDATE peers SET pid=?, source=?, last_seen=? WHERE id=?")
      .run(pid, source, now, body.id);
  } else {
    updateLastSeen.run(now, body.id);
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

  // Deduplicate recentExchange: when multiple peers report identical conversation
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

  if (target.status === "pending") {
    return { ok: false, error: `Peer ${body.toId} is pending (CLI not running).` };
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
  removePeer(body.id);
}

function handleSuspendPeer(_body: { id: string }): { ok: boolean } {
  return { ok: true };
}

function handleResumePeer(_body: { id: string }): { ok: boolean } {
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
  let removed = 0;
  for (const peer of peers) {
    if (peer.pid === process.pid || peer.pid === 0) continue;
    try { process.kill(peer.pid, 0); } catch {
      removePeer(peer.id);
      removed++;
    }
  }
  return { suspended: removed, remaining: (selectAllPeers.all() as unknown as RawPeerRow[]).length };
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
      ?? ctx.recentExchange?.filter(e => e.role === "assistant").map(e => e.text).join(" ")
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

  // Check 5: Historical memory overlap — past memories about the same files/areas
  const advisories: ConflictAdvisory[] = [];
  if (body.gitRoot) {
    const repoMemories = (selectRecentMemoriesByRepo.all(body.gitRoot, 100) as unknown as RawMemoryRow[]);
    for (const row of repoMemories) {
      const memFiles = JSON.parse(row.files_json || "[]") as string[];
      const memAreas = JSON.parse(row.areas_json || "[]") as string[];
      const memTokens = extractTokens(`${row.title} ${row.content}`);
      const tokenOverlap = memTokens.filter(t => promptTokens.includes(t)).length;
      const fileOverlap = memFiles.filter(f => {
        const basename = f.split("/").pop()!.toLowerCase();
        return promptLower.includes(basename) || promptLower.includes(f.toLowerCase());
      }).length;
      const areaOverlap = memAreas.filter(a => promptLower.includes(a.toLowerCase())).length;

      const memScore = fileOverlap * 3 + areaOverlap * 2 + Math.min(tokenOverlap, 3);
      if (memScore >= 3) {
        if (row.category === "issue") {
          // Issue entries overlapping current task files → blocking-style warning
          for (const c of conflicts) {
            c.relatedMemories = c.relatedMemories ?? [];
            c.relatedMemories.push({ id: row.id, category: row.category, title: row.title, createdAt: row.created_at });
          }
        }
        if (row.category === "task") {
          // Recent task entries from other peers → "currently in progress" notice
          for (const c of conflicts) {
            c.relatedMemories = c.relatedMemories ?? [];
            c.relatedMemories.push({ id: row.id, category: row.category, title: row.title, createdAt: row.created_at });
          }
        }
        // Advisory surfacing — architecture entries as non-blocking background knowledge
        if (row.category === "architecture") {
          advisories.push({
            memoryId: row.id,
            category: row.category,
            title: row.title,
            content: row.content.length > 200 ? row.content.slice(0, 200) + "\u2026" : row.content,
          });
        }
      }
    }
  }

  return { conflicts, advisories: advisories.length > 0 ? advisories : undefined };
}

// ─── Repo Memory handlers ────────────────────────────────────

interface RawMemoryRow {
  id: number;
  git_root: string;
  category: string;
  title: string;
  content: string;
  files_json: string;
  areas_json: string;
  source_peer_id: string | null;
  source_exchange: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: RawMemoryRow): RepoMemory {
  return {
    id: row.id,
    gitRoot: row.git_root,
    category: row.category as RepoMemory["category"],
    title: row.title,
    content: row.content,
    files: JSON.parse(row.files_json || "[]") as string[],
    areas: JSON.parse(row.areas_json || "[]") as string[],
    sourcePeerId: row.source_peer_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function computeContentHash(category: string, title: string, content: string): string {
  const normalized = `${category}|${title.toLowerCase().trim()}|${content.toLowerCase().trim().slice(0, 500)}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Sanitize user query for FTS5 MATCH syntax */
function sanitizeFtsQuery(query: string): string {
  // Extract meaningful tokens and join with OR for broad matching
  const tokens = extractTokens(query);
  if (tokens.length === 0) return '""'; // empty query
  // Escape double quotes, wrap each token for safe FTS5 matching
  return tokens.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function handleAddMemory(body: AddMemoryRequest): AddMemoryResponse {
  const hash = computeContentHash(body.category, body.title, body.content);
  const existing = selectMemoryByHash.get(hash, body.gitRoot) as unknown as { id: number } | undefined;
  if (existing) {
    updateMemoryTimestamp.run(new Date().toISOString(), existing.id);
    return { ok: true, id: existing.id, duplicate: true };
  }
  const now = new Date().toISOString();
  insertMemory.run(
    body.gitRoot, body.category, body.title, body.content,
    JSON.stringify(body.files ?? []), JSON.stringify(body.areas ?? []),
    body.sourcePeerId ?? null, body.sourceExchange ?? null,
    hash, now, now,
  );
  const lastId = (db.prepare("SELECT last_insert_rowid() as id").get() as unknown as { id: number }).id;
  broadcast({
    type: "memory-added",
    data: { gitRoot: body.gitRoot, memoryId: lastId },
    timestamp: now,
  } satisfies WsMemoryAddedEvent);
  return { ok: true, id: lastId };
}

function handleSearchMemory(body: SearchMemoryRequest): SearchMemoryResponse {
  const limit = Math.min(body.limit ?? 20, 100);
  const queryTokens = extractTokens(body.query);
  if (queryTokens.length === 0) return { memories: [] };

  let candidates: RawMemoryRow[];

  // Try FTS5 search first
  if (hasFts5) {
    try {
      const ftsQuery = sanitizeFtsQuery(body.query);
      const stmt = body.category
        ? db.prepare(`SELECT m.*, fts.rank FROM repo_memories_fts fts JOIN repo_memories m ON m.id = fts.rowid WHERE repo_memories_fts MATCH ? AND m.git_root = ? AND m.category = ? ORDER BY fts.rank LIMIT ?`)
        : db.prepare(`SELECT m.*, fts.rank FROM repo_memories_fts fts JOIN repo_memories m ON m.id = fts.rowid WHERE repo_memories_fts MATCH ? AND m.git_root = ? ORDER BY fts.rank LIMIT ?`);
      candidates = (body.category
        ? stmt.all(ftsQuery, body.gitRoot, body.category, limit * 2)
        : stmt.all(ftsQuery, body.gitRoot, limit * 2)
      ) as unknown as RawMemoryRow[];
    } catch {
      // FTS5 query error — fall back to token-based
      candidates = getFallbackCandidates(body);
    }
  } else {
    candidates = getFallbackCandidates(body);
  }

  // Post-score with file/area overlap
  const scored = candidates.map(row => {
    let score = (row as unknown as { rank?: number }).rank ? Math.abs((row as unknown as { rank: number }).rank) : 0;
    const memTokens = extractTokens(`${row.title} ${row.content}`);
    score += memTokens.filter(t => queryTokens.includes(t)).length;

    if (body.files?.length) {
      const memFiles = JSON.parse(row.files_json || "[]") as string[];
      const overlap = body.files.filter(f => memFiles.some(mf => mf === f || f.endsWith(mf) || mf.endsWith(f)));
      score += overlap.length * 3;
    }
    if (body.areas?.length) {
      const memAreas = JSON.parse(row.areas_json || "[]") as string[];
      const overlap = body.areas.filter(a => memAreas.some(ma => ma.includes(a) || a.includes(ma)));
      score += overlap.length * 1.5;
    }
    // Recency bonus
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) score += 0.5;

    return { ...rowToMemory(row), score };
  });

  scored.sort((a, b) => b.score - a.score);
  return { memories: scored.slice(0, limit) };
}

function getFallbackCandidates(body: SearchMemoryRequest): RawMemoryRow[] {
  return body.category
    ? selectMemoriesByRepoAndCategory.all(body.gitRoot, body.category, 200, 0) as unknown as RawMemoryRow[]
    : selectMemoriesByRepo.all(body.gitRoot, 200, 0) as unknown as RawMemoryRow[];
}

function handleListMemories(body: ListMemoriesRequest): ListMemoriesResponse {
  const limit = Math.min(body.limit ?? 20, 100);
  const offset = body.offset ?? 0;
  const rows = body.category
    ? selectMemoriesByRepoAndCategory.all(body.gitRoot, body.category, limit, offset) as unknown as RawMemoryRow[]
    : selectMemoriesByRepo.all(body.gitRoot, limit, offset) as unknown as RawMemoryRow[];
  const total = (countMemoriesByRepo.get(body.gitRoot) as unknown as { cnt: number }).cnt;
  return { memories: rows.map(rowToMemory), total };
}

function handleDeleteMemory(body: DeleteMemoryRequest): DeleteMemoryResponse {
  const row = selectMemoryById.get(body.id) as unknown as RawMemoryRow | undefined;
  if (!row) return { ok: false };
  deleteMemoryById.run(body.id);
  return { ok: true };
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

function handleUpdateConfig(body: { autoConflictCheck?: boolean; maxContextLength?: number }): { ok: boolean; autoConflictCheck: boolean; maxContextLength: number } {
  if (body.autoConflictCheck !== undefined) {
    AUTO_CONFLICT_CHECK = body.autoConflictCheck;
  }
  if (body.maxContextLength !== undefined && body.maxContextLength > 0) {
    MAX_CONTEXT_LENGTH = body.maxContextLength;
  }
  return { ok: true, autoConflictCheck: AUTO_CONFLICT_CHECK, maxContextLength: MAX_CONTEXT_LENGTH };
}

function handleHealth(): BrokerHealthResponse {
  return {
    status: "ok",
    pid: process.pid,
    peerCount: (selectAllPeers.all() as unknown as RawPeerRow[]).length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    autoConflictCheck: AUTO_CONFLICT_CHECK,
    maxContextLength: MAX_CONTEXT_LENGTH,
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
      case "/reserve-peer":
        result = handleReservePeer(body as ReservePeerRequest);
        break;
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
      case "/repo-memory/add":
        result = handleAddMemory(body as AddMemoryRequest);
        break;
      case "/repo-memory/search":
        result = handleSearchMemory(body as SearchMemoryRequest);
        break;
      case "/repo-memory/list":
        result = handleListMemories(body as ListMemoriesRequest);
        break;
      case "/repo-memory/delete":
        result = handleDeleteMemory(body as DeleteMemoryRequest);
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
        // Add to Set (extension may have multiple windows connecting with same id)
        if (!wsPeerClients.has(msg.id)) {
          wsPeerClients.set(msg.id, new Set());
        }
        wsPeerClients.get(msg.id)!.add(ws);
        // Update PID/source if changed on WS re-identify
        const row = selectPeerById.get(msg.id) as unknown as RawPeerRow | undefined;
        if (row) {
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
      const wsSet = wsPeerClients.get(identifiedPeerId);
      if (wsSet) {
        wsSet.delete(ws);
        if (wsSet.size === 0) {
          wsPeerClients.delete(identifiedPeerId);
          // All WS connections for this peer are gone — decide what to do
          const row = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow | undefined;
          if (row) {
            let ownerAlive = false;
            if (row.pid > 0) {
              try { process.kill(row.pid, 0); ownerAlive = true; } catch { /* dead */ }
            }
            if (row.terminal_id && !ownerAlive) {
              // CLI exited but terminal still exists → go pending
              const now = new Date().toISOString();
              db.prepare("UPDATE peers SET status='pending', pid=0, last_seen=? WHERE id=?")
                .run(now, identifiedPeerId);
              const updatedRow = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow;
              broadcast({
                type: "peer-updated",
                data: rowToPeer(updatedRow),
                timestamp: now,
              } satisfies WsPeerUpdatedEvent);
              log(`Peer ${identifiedPeerId} went pending (CLI exited, terminal alive)`);
            } else {
              // No terminal_id (manual launch or extension) → hard remove
              removePeer(identifiedPeerId);
            }
          }
        }
      }
    }
    log(`WebSocket client disconnected (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);
  });
  ws.on("error", (err) => {
    log(`WebSocket client error: ${err.message}`);
    wsClients.delete(ws);
    if (identifiedPeerId) {
      const wsSet = wsPeerClients.get(identifiedPeerId);
      if (wsSet) {
        wsSet.delete(ws);
        if (wsSet.size === 0) {
          wsPeerClients.delete(identifiedPeerId);
          const row = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow | undefined;
          if (row) {
            let ownerAlive = false;
            if (row.pid > 0) {
              try { process.kill(row.pid, 0); ownerAlive = true; } catch { /* dead */ }
            }
            if (row.terminal_id && !ownerAlive) {
              const now = new Date().toISOString();
              db.prepare("UPDATE peers SET status='pending', pid=0, last_seen=? WHERE id=?")
                .run(now, identifiedPeerId);
              const updatedRow = selectPeerById.get(identifiedPeerId) as unknown as RawPeerRow;
              broadcast({
                type: "peer-updated",
                data: rowToPeer(updatedRow),
                timestamp: now,
              } satisfies WsPeerUpdatedEvent);
            } else {
              removePeer(identifiedPeerId);
            }
          }
        }
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
