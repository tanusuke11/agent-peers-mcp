#!/usr/bin/env bun
/**
 * agent-peers broker daemon
 *
 * A singleton HTTP + WebSocket server backed by SQLite.
 * Tracks all registered AI agent peers and routes messages between them.
 * Broadcasts real-time events via WebSocket for VSCode extension and other listeners.
 *
 * Enhancements over claude-peers:
 *   - Multi-agent support (Claude Code, Codex, Copilot Chat, Cursor, etc.)
 *   - Structured context sharing (active files, git state, tasks)
 *   - WebSocket for real-time push (peer join/leave, messages, context updates)
 *
 * Auto-launched by the MCP server or VSCode extension if not already running.
 * Run directly: bun src/broker/index.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  UpdateContextRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
  AgentContext,
  BrokerHealthResponse,
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
} from "../shared/constants.ts";

const PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const WS_PORT = parseInt(process.env.AGENT_PEERS_WS_PORT ?? String(DEFAULT_WS_PORT), 10);
const DB_PATH = process.env.AGENT_PEERS_DB ?? BROKER_DB_PATH;
const startTime = Date.now();

// ─── Database setup ────────────────────────────────────────────

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL DEFAULT 'generic',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    context_json TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL,
    payload_json TEXT,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// ─── WebSocket clients ─────────────────────────────────────────

const wsClients = new Set<import("bun").ServerWebSocket<unknown>>();

function broadcast(event: WsEvent) {
  const json = JSON.stringify(event);
  for (const ws of wsClients) {
    try {
      ws.send(json);
    } catch {
      wsClients.delete(ws);
    }
  }
}

// ─── Stale peer cleanup ────────────────────────────────────────

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      broadcast({
        type: "peer-left",
        data: { id: peer.id },
        timestamp: new Date().toISOString(),
      } satisfies WsPeerLeftEvent);
    }
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, STALE_PEER_CLEANUP_MS);

// ─── Prepared statements ───────────────────────────────────────

const insertPeer = db.prepare(`
  INSERT INTO peers (id, agent_type, pid, cwd, git_root, tty, context_json, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateContext = db.prepare(`UPDATE peers SET context_json = ?, last_seen = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeersByGitRoot = db.prepare(`SELECT * FROM peers WHERE git_root = ?`);
const selectPeerById = db.prepare(`SELECT * FROM peers WHERE id = ?`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, type, text, payload_json, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// ─── Helpers ───────────────────────────────────────────────────

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

interface RawPeerRow {
  id: string;
  agent_type: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  context_json: string;
  registered_at: string;
  last_seen: string;
}

function rowToPeer(row: RawPeerRow): Peer {
  return {
    id: row.id,
    agentType: row.agent_type as Peer["agentType"],
    pid: row.pid,
    cwd: row.cwd,
    gitRoot: row.git_root,
    tty: row.tty,
    context: JSON.parse(row.context_json) as AgentContext,
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
  };
}

interface RawMessageRow {
  id: number;
  from_id: string;
  to_id: string;
  type: string;
  text: string;
  payload_json: string | null;
  sent_at: string;
  delivered: number;
}

function rowToMessage(row: RawMessageRow): Message {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type as Message["type"],
    text: row.text,
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
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

// ─── Request handlers ──────────────────────────────────────────

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove existing registration for this PID
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  const contextJson = JSON.stringify(body.context);
  insertPeer.run(id, body.agentType, body.pid, body.cwd, body.gitRoot, body.tty, contextJson, now, now);

  const peer = rowToPeer(selectPeerById.get(id) as RawPeerRow);
  broadcast({
    type: "peer-joined",
    data: peer,
    timestamp: now,
  } satisfies WsPeerJoinedEvent);

  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleUpdateContext(body: UpdateContextRequest): void {
  const row = selectPeerById.get(body.id) as RawPeerRow | null;
  if (!row) return;

  const existing = JSON.parse(row.context_json) as AgentContext;
  const merged: AgentContext = {
    ...existing,
    ...body.context,
    updatedAt: new Date().toISOString(),
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
      rows = selectAllPeers.all() as RawPeerRow[];
      break;
    case "directory":
      rows = selectPeersByDirectory.all(body.cwd) as RawPeerRow[];
      break;
    case "repo":
      rows = body.gitRoot
        ? (selectPeersByGitRoot.all(body.gitRoot) as RawPeerRow[])
        : (selectPeersByDirectory.all(body.cwd) as RawPeerRow[]);
      break;
    default:
      rows = selectAllPeers.all() as RawPeerRow[];
  }

  if (body.excludeId) {
    rows = rows.filter((r) => r.id !== body.excludeId);
  }

  // Filter out dead peers
  return rows
    .filter((r) => {
      if (isAlive(r.pid)) return true;
      deletePeer.run(r.id);
      return false;
    })
    .map(rowToPeer);
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = selectPeerById.get(body.toId) as RawPeerRow | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.toId} not found` };
  }

  const now = new Date().toISOString();
  const payloadJson = body.payload ? JSON.stringify(body.payload) : null;
  insertMessage.run(body.fromId, body.toId, body.type, body.text, payloadJson, now);

  // Get the inserted message for broadcast
  const lastId = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  const msgRow = db.query("SELECT * FROM messages WHERE id = ?").get(lastId.id) as RawMessageRow;
  const msg = rowToMessage(msgRow);

  broadcast({
    type: "message",
    data: msg,
    timestamp: now,
  } satisfies WsMessageEvent);

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const rows = selectUndelivered.all(body.id) as RawMessageRow[];

  for (const row of rows) {
    markDelivered.run(row.id);
  }

  return { messages: rows.map(rowToMessage) };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
  broadcast({
    type: "peer-left",
    data: { id: body.id },
    timestamp: new Date().toISOString(),
  } satisfies WsPeerLeftEvent);
}

function handleHealth(): BrokerHealthResponse {
  return {
    status: "ok",
    peerCount: (selectAllPeers.all() as RawPeerRow[]).length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

// ─── HTTP Server ───────────────────────────────────────────────

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers for VSCode extension webview
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json(handleHealth(), { headers: corsHeaders });
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
          handleHeartbeat(body as HeartbeatRequest);
          result = { ok: true };
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
        case "/unregister":
          handleUnregister(body as { id: string });
          result = { ok: true };
          break;
        default:
          return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
      }

      return Response.json(result, { headers: corsHeaders });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
    }
  },
});

// ─── WebSocket Server ──────────────────────────────────────────

Bun.serve({
  port: WS_PORT,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("WebSocket endpoint", { status: 200 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      log(`WebSocket client connected (total: ${wsClients.size})`);
    },
    close(ws) {
      wsClients.delete(ws);
      log(`WebSocket client disconnected (total: ${wsClients.size})`);
    },
    message(_ws, _msg) {
      // Clients don't send messages to broker via WS (use HTTP API)
    },
  },
});

function log(msg: string) {
  console.error(`[agent-peers broker] ${msg}`);
}

log(`HTTP listening on 127.0.0.1:${PORT}`);
log(`WebSocket listening on 127.0.0.1:${WS_PORT}`);
log(`Database: ${DB_PATH}`);
