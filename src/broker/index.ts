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
  PEER_TIMEOUT_MS,
} from "../shared/constants.ts";

const PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const WS_PORT = parseInt(process.env.AGENT_PEERS_WS_PORT ?? String(DEFAULT_WS_PORT), 10);
const DB_PATH = process.env.AGENT_PEERS_DB ?? BROKER_DB_PATH;
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
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    context_json TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    suspended INTEGER NOT NULL DEFAULT 0
  )
`);

// Migration: add suspended column if missing
try {
  db.exec("ALTER TABLE peers ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0");
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
  const peers = db.prepare("SELECT id, pid, last_seen FROM peers").all() as unknown as { id: string; pid: number; last_seen: string }[];
  const now = Date.now();
  for (const peer of peers) {
    const staleByTime = now - new Date(peer.last_seen).getTime() > PEER_TIMEOUT_MS;
    let deadByPid = false;
    // Only use PID check when the stored PID is not the broker's own PID
    // (MCP peers are registered with process.pid which is always alive)
    if (peer.pid !== process.pid) {
      try {
        process.kill(peer.pid, 0);
      } catch {
        deadByPid = true;
      }
    }
    if (staleByTime || deadByPid) {
      db.prepare("DELETE FROM peers WHERE id = ?").run(peer.id);
      db.prepare("DELETE FROM messages WHERE to_id = ? OR from_id = ?").run(peer.id, peer.id);
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
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  context_json: string;
  registered_at: string;
  last_seen: string;
  suspended: number;
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
    connected: true,
    suspended: !!row.suspended,
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
  const now = new Date().toISOString();
  const contextJson = JSON.stringify(body.context);

  // Wrap in a transaction so the read-delete-insert is atomic.
  // Without this, two processes starting simultaneously (e.g. Codex probing + real session)
  // can both find no existing peer and both insert, resulting in duplicate registrations.
  db.exec("BEGIN");
  let id: string;
  try {
    db.prepare("DELETE FROM peers WHERE pid = ?").run(body.pid);
    const existingIds = new Set((selectAllPeers.all() as unknown as unknown as RawPeerRow[]).map((r) => r.id));
    id = generateId(existingIds);
    insertPeer.run(id, body.agentType, body.pid, body.cwd, body.gitRoot, body.tty, contextJson, now, now);
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
  updateLastSeen.run(new Date().toISOString(), body.id);
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
  const target = selectPeerById.get(body.toId) as unknown as RawPeerRow | undefined;
  if (!target) {
    return { ok: false, error: `Peer ${body.toId} not found` };
  }

  const now = new Date().toISOString();
  const payloadJson = body.payload ? JSON.stringify(body.payload) : null;
  insertMessage.run(body.fromId, body.toId, body.type, body.text, payloadJson, now);

  // Get the inserted message
  const lastId = db.prepare("SELECT last_insert_rowid() as id").get() as unknown as { id: number };
  const msgRow = db.prepare("SELECT * FROM messages WHERE id = ?").get(lastId.id) as unknown as RawMessageRow;
  const msg = rowToMessage(msgRow);

  const event = {
    type: "message",
    data: msg,
    timestamp: now,
  } satisfies WsMessageEvent;

  // Try targeted delivery to the recipient peer via WS
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

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const exists = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!exists) return { found: false, messages: [] };

  const rows = selectUndelivered.all(body.id) as unknown as unknown as RawMessageRow[];
  for (const row of rows) {
    markDelivered.run(row.id);
  }

  return { found: true, messages: rows.map(rowToMessage) };
}

function removePeer(id: string): void {
  const row = selectPeerById.get(id) as unknown as RawPeerRow | undefined;
  if (!row) return;
  deletePeer.run(id);
  broadcast({
    type: "peer-left",
    data: { id },
    timestamp: new Date().toISOString(),
  } satisfies WsPeerLeftEvent);
  log(`Peer ${id} removed`);
}

function handleUnregister(body: { id: string }): void {
  removePeer(body.id);
}

function handleSuspendPeer(body: { id: string }): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };

  // Clear context and mark as suspended
  const emptyContext: AgentContext = { summary: "", activeFiles: [], git: null, updatedAt: new Date().toISOString() };
  const now = new Date().toISOString();
  db.prepare("UPDATE peers SET suspended = 1, context_json = ?, last_seen = ? WHERE id = ?").run(JSON.stringify(emptyContext), now, body.id);

  broadcast({
    type: "context-updated",
    data: { id: body.id, context: emptyContext },
    timestamp: now,
  } satisfies WsContextUpdatedEvent);

  return { ok: true };
}

function handleResumePeer(body: { id: string }): { ok: boolean } {
  const row = selectPeerById.get(body.id) as unknown as RawPeerRow | undefined;
  if (!row) return { ok: false };

  const now = new Date().toISOString();
  db.prepare("UPDATE peers SET suspended = 0, last_seen = ? WHERE id = ?").run(now, body.id);

  broadcast({
    type: "context-updated",
    data: { id: body.id, context: JSON.parse(row.context_json) },
    timestamp: now,
  } satisfies WsContextUpdatedEvent);

  return { ok: true };
}

function handlePurge(): { purged: number } {
  const peers = selectAllPeers.all() as unknown as RawPeerRow[];
  for (const peer of peers) {
    // Terminate the MCP server process so orphaned sessions don't re-register
    if (peer.pid !== process.pid) {
      try { process.kill(peer.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    db.prepare("DELETE FROM peers WHERE id = ?").run(peer.id);
    broadcast({ type: "peer-left", data: { id: peer.id }, timestamp: new Date().toISOString() } satisfies WsPeerLeftEvent);
  }
  return { purged: peers.length };
}

function handleCleanup(): { removed: number; remaining: number } {
  const peers = selectAllPeers.all() as unknown as RawPeerRow[];
  let removed = 0;
  for (const peer of peers) {
    let dead = false;
    if (peer.pid !== process.pid) {
      try { process.kill(peer.pid, 0); } catch { dead = true; }
    }
    if (dead) {
      db.prepare("DELETE FROM peers WHERE id = ?").run(peer.id);
      db.prepare("DELETE FROM messages WHERE to_id = ? AND delivered = 0").run(peer.id);
      broadcast({ type: "peer-left", data: { id: peer.id }, timestamp: new Date().toISOString() } satisfies WsPeerLeftEvent);
      removed++;
    }
  }
  return { removed, remaining: (selectAllPeers.all() as unknown as RawPeerRow[]).length };
}

function handleHealth(): BrokerHealthResponse {
  return {
    status: "ok",
    pid: process.pid,
    peerCount: (selectAllPeers.all() as unknown as RawPeerRow[]).length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

// ─── HTTP Server ───────────────────────────────────────────────

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
      case "/unregister":
        handleUnregister(body as { id: string });
        result = { ok: true };
        break;
      case "/suspend-peer":
        result = handleSuspendPeer(body as { id: string });
        break;
      case "/resume-peer":
        result = handleResumePeer(body as { id: string });
        break;
      case "/cleanup":
        result = handleCleanup();
        break;
      case "/purge":
        result = handlePurge();
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
      const msg = JSON.parse(String(data)) as { type?: string; id?: string };
      if (msg.type === "identify" && msg.id) {
        // Promote from anonymous to peer-identified
        wsClients.delete(ws);
        identifiedPeerId = msg.id;
        wsPeerClients.set(msg.id, ws);
        log(`WebSocket peer identified: ${msg.id} (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    if (identifiedPeerId) {
      wsPeerClients.delete(identifiedPeerId);
      // Peer WS disconnected — remove from DB immediately
      removePeer(identifiedPeerId);
    }
    log(`WebSocket client disconnected (anonymous: ${wsClients.size}, peers: ${wsPeerClients.size})`);
  });
  ws.on("error", (err) => {
    log(`WebSocket client error: ${err.message}`);
    wsClients.delete(ws);
    if (identifiedPeerId) {
      wsPeerClients.delete(identifiedPeerId);
      removePeer(identifiedPeerId);
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
