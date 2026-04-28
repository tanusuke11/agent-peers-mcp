# Peer-Terminal Binding Rewrite — Spec for Distributed Implementation

This is a coordinated rewrite. **cat** is the coordinator. Each peer owns a slice.
Read this whole doc before editing — your slice depends on others' interfaces.

---

## Goal

Replace the current **PID-ancestor-search** mechanism for binding `Peer ↔ vscode.Terminal`
with **terminal-reservation + env-var binding**, and remove `sleep`/`suspended` state.

---

## Requirements (from user)

1. Extension creates a terminal → broker immediately reserves an animal-name peer
   (`status="pending"`). Tab title is set at creation time — no rename-after-the-fact.
2. CLI (`claude`/`codex`) starts inside that terminal → peer becomes `status="active"`.
3. CLI exits (stdio EOF) but terminal is still open → peer returns to `status="pending"`.
4. Terminal is closed → peer hard-deleted, `peer-left` broadcast.
5. VSCode extension peer: **no animal name, one peer regardless of how many windows**.
   - All windows register with the same `preferredId` (e.g. `"vscode-ext"`).
   - Broker keeps one row; `wsPeerClients` maps the id to a `Set<ws>` (not a single ws).
   - `peer-left` fires only when **all** WS connections for that id are gone.
6. Tab title is set via `createTerminal({ name: "claude • goat" })` — **never** via
   `renameWithArg`. Zero focus-stealing, zero timing hacks.
7. Manual `claude` launch (no `AGENT_PEERS_TERMINAL_ID` env): peer appears in sidebar
   as active, but tab title is NOT synced (case A1 from prior agreement). No rename attempt.

---

## Peer status model

```
pending  — terminal exists, CLI not yet running (or CLI just exited)
active   — terminal exists, CLI connected via MCP
(deleted) — terminal closed; hard-deleted from DB
```

`sleep`/`suspended` are abolished. The `sleep` column stays in the DB (SQLite column
drop is painful) but is always 0. On startup, DELETE WHERE sleep=1 (approved by user).

---

## Architecture

```
Extension host (one per VSCode window)
  ├ extHostId = randomUUID() — stable per activation, passed to broker on every register
  ├ Map<terminalId, vscode.Terminal>
  ├ WeakMap<vscode.Terminal, terminalId>
  ├ Map<peerId, terminalId>
  │
  ├ createTerminal flow:
  │   1. POST /reserve-peer { terminalId, extHostId, agentType } → { id, name }
  │   2. vscode.window.createTerminal({ name: "claude • goat", env: { AGENT_PEERS_TERMINAL_ID, AGENT_PEERS_EXT_HOST } })
  │   3. Store in maps; terminal tab is already correctly named.
  │
  ├ onDidCloseTerminal → POST /delete-peer { id }
  │
  └ registers itself (source="extension", preferredId="vscode-ext", no terminalId)
      → wsPeerClients["vscode-ext"] is a Set<ws>; peer-left fires only when Set is empty

MCP server (CLI side)
  └ on startup: reads env AGENT_PEERS_TERMINAL_ID / AGENT_PEERS_EXT_HOST
      → POST /register with terminalId + extHostId
      → broker finds pending peer by terminalId → activates it → peer-joined broadcast

Broker
  ├ New endpoint: POST /reserve-peer
  │     body: { terminalId, extHostId, agentType }
  │     action: generate animal name, INSERT peer with status="pending", return { id, name }
  │
  ├ POST /register (updated)
  │     if terminalId matches a pending peer → UPDATE status="active", broadcast peer-joined
  │     if no terminalId (manual launch) → INSERT new active peer (existing path)
  │
  ├ WS close for MCP peer (CLI exited, terminal still open)
  │     owner PID dead → UPDATE status="pending", broadcast peer-updated (not peer-left)
  │
  ├ POST /delete-peer (terminal closed)
  │     hard DELETE + peer-left broadcast (existing removePeer)
  │
  ├ stale cleanup: pending peers whose terminal is gone → DELETE (ttl: ~5 min no heartbeat)
  │   active peers whose PID is dead AND no WS → DELETE
  │
  └ wsPeerClients: Map<peerId, Set<WebSocket>>  (changed from Map<peerId, WebSocket>)
```

---

## New WS event needed

```ts
// broadcast when pending↔active transitions happen (not a join or leave)
type WsEventType = ... | "peer-updated";

export interface WsPeerUpdatedEvent {
  type: "peer-updated";
  data: Peer;        // full peer object with new status
  timestamp: string;
}
```

Extension listens to `peer-updated` to refresh sidebar without re-running the rename
logic (tab title is already set).

---

## shared/types.ts additions (cat will do this)

```ts
export type PeerStatus = "pending" | "active";

export interface Peer {
  // ... existing fields ...
  status: PeerStatus;        // replaces connected/suspended
  terminalId?: string | null;
  extHostId?: string | null;
}

export interface ReservePeerRequest {
  terminalId: string;
  extHostId: string;
  agentType: AgentType;
}

export interface ReservePeerResponse {
  id: PeerId;
  name: string;   // the animal name, e.g. "goat"
}
```

`RegisterRequest` keeps `terminalId`/`extHostId` (already added). Add nothing else.

---

## Changes already done by cat

- `src/shared/types.ts` — added `terminalId`/`extHostId` to `Peer` and `RegisterRequest`;
  removed `connected`/`suspended`. **cat will add `PeerStatus`, `ReservePeerRequest`,
  `ReservePeerResponse`, and `peer-updated` WS event type shortly.**

---

## Slices

### Slice B — Broker rewrite (owner: **narwhal**)

File: `src/broker/index.ts` only.

**Updated from original spec** — integrate the reservation flow.

1. **Schema**:
   ```sql
   ALTER TABLE peers ADD COLUMN terminal_id TEXT;
   ALTER TABLE peers ADD COLUMN ext_host_id TEXT;
   ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
   ```
   Each in try/catch. On startup:
   ```sql
   DELETE FROM peers WHERE sleep = 1;
   UPDATE peers SET status = 'active' WHERE status IS NULL OR status = '';
   ```

2. **`RawPeerRow`**: add `terminal_id`, `ext_host_id`, `status` fields.

3. **`rowToPeer`**: output `terminalId`, `extHostId`, `status`. Remove `connected`/`suspended`.

4. **New endpoint `POST /reserve-peer`** (`handleReservePeer`):
   ```ts
   function handleReservePeer(body: ReservePeerRequest): ReservePeerResponse {
     const now = new Date().toISOString();
     const existingIds = new Set((selectAllPeers.all() as RawPeerRow[]).map(r => r.id));
     const id = generateId(existingIds);
     insertPeer.run(id, body.agentType, "terminal", 0, "", null,
                    null, body.terminalId, body.extHostId,
                    JSON.stringify({ summary:"", activeFiles:[], git:null, updatedAt:now }),
                    now, now, "pending");
     // Do NOT broadcast peer-joined yet — CLI hasn't started
     return { id, name: id };
   }
   ```
   Wire to `case "/reserve-peer":` in the HTTP router.

5. **Update `insertPeer` statement** to include `status`:
   ```sql
   INSERT INTO peers (id, agent_type, source, pid, cwd, git_root, tty,
                      terminal_id, ext_host_id, context_json,
                      registered_at, last_seen, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ```

6. **Rewrite `handleRegister`**:
   ```ts
   // If terminalId matches a pending reservation → activate it
   const pending = terminalId
     ? db.prepare("SELECT * FROM peers WHERE terminal_id = ? AND status = 'pending' LIMIT 1")
         .get(terminalId) as RawPeerRow | undefined
     : undefined;

   if (pending) {
     // Activate the reserved peer
     db.prepare(`UPDATE peers SET pid=?, cwd=?, git_root=?, tty=?, source=?,
                 agent_type=?, context_json=?, last_seen=?, status='active' WHERE id=?`)
       .run(body.pid, body.cwd, body.gitRoot, body.tty, source,
            body.agentType, JSON.stringify(body.context), now, pending.id);
     id = pending.id;
   } else {
     // Manual launch (no terminalId) or extension peer — create new active peer
     id = body.preferredId && !existingIds.has(body.preferredId)
       ? body.preferredId
       : generateId(existingIds);
     insertPeer.run(id, body.agentType, source, body.pid, body.cwd, body.gitRoot,
                    body.tty, body.terminalId ?? null, body.extHostId ?? null,
                    JSON.stringify(body.context), now, now, "active");
   }
   // broadcast peer-joined (first time CLI connects)
   broadcast({ type: "peer-joined", data: rowToPeer(...), timestamp: now });
   ```

7. **WS close handler** (CLI exits, terminal still alive):
   - Owner PID dead → `UPDATE peers SET status='pending', pid=0 WHERE id=?`
   - Broadcast `{ type: "peer-updated", data: peer }` (NOT peer-left)
   - If peer has no `terminal_id` (manual launch / extension) → `removePeer` as before.

8. **Extension peer multi-window** (`wsPeerClients`):
   - Change `wsPeerClients` from `Map<string, WebSocket>` to `Map<string, Set<WebSocket>>`.
   - On WS identify with a known id: add ws to the Set.
   - On WS close: remove ws from Set; only call `removePeer` when Set is empty.

9. **`detachPeer` → deleted**. Replace all call sites with `removePeer`. Exception: WS
   close with terminal still alive → use the new `status='pending'` UPDATE instead.

10. **`cleanStalePeers`**:
    - `pending` peers with `last_seen` older than 5 min AND PID=0 → `removePeer`
    - `active` peers with stale `last_seen` AND dead PID → `removePeer`
    - No more sleep handling.

11. **`handleSendMessage`**: remove `if (target.sleep)` rejection. Add instead:
    ```ts
    if (target.status === "pending") {
      return { ok: false, error: `Peer ${body.toId} is pending (CLI not running).` };
    }
    ```

12. **`handleSuspendPeer`/`handleResumePeer`**: make no-ops returning `{ ok: true }`.

13. **Delete dead helpers**: `chooseRegisterReuseCandidate`, `getSleepFingerprint`,
    `mergeSleepingPeerIntoCanonical`, `collapseRedundantSleepingPeers`,
    `mergeStoredContexts`, `selectSuspendedByRepo`, `selectSuspendedByCwd`,
    `selectActiveByPid`.

When done: `bun run build:broker` → report to cat.

---

### Slice E — Extension rewrite (owner: **doe**) ✅ COMPLETE

doe has finished. Key outputs:
- `extHostId` generated per activation
- `terminalsById`, `terminalIdsByTerminal`, `peerTerminalIdById` maps in place
- `bindPeerToTerminal`/`unbindPeerFromTerminal` implemented
- PID machinery deleted
- `deliverToTerminal` 80ms delay fix applied

**Pending update** (doe may need a small follow-up, or cat will patch):
- `createTerminal` must now call `/reserve-peer` first and use the returned name
  in `{ name: "claude • goat" }` — eliminating `renameWithArg` entirely.
- `onDidCloseTerminal` already calls `deletePeer`. Keep as-is.
- `peer-updated` event handler needed: refresh sidebar only (no rename).

---

### Slice S — MCP server register payload (owner: **swan**)

File: `src/server/index.ts` only.

Same as original spec — add `terminalId`/`extHostId` to register body. No change needed
for the reservation flow (MCP server doesn't call `/reserve-peer`, extension does).

When done: `bun run build:server` → report to cat.

---

### Slice U — UI cleanup (owner: **orca**)

Files: `src/extension/views/*`, `package.json` contributes only.

Same as original spec — remove sleep/suspended/connected UI.

Additionally:
- Sidebar should show `pending` peers differently from `active` (e.g. greyed out, no
  CLI indicator). Add a simple visual distinction based on `peer.status`.
- Remove Suspend/Resume/Wake command contributes.

When done: `bun run build:extension` → report to cat.

---

### Slice M — Memory categories rewrite (owner: **jay**)

See `/home/ubuntu/projects/agent-peers-mcp/SPEC-memory-rewrite.md`.

Categories: `decision|learning|architecture|bug-fix|convention` → `task|issue|architecture`.

Wait for narwhal's broker report before editing `src/broker/index.ts`.

When done: `bun run build` → report to cat.

---

## Coordination protocol

- Finish your slice → `bun run build:<component>` → send `type=report` to **cat**.
- Contradictions → `type=text` to cat first.
- Do NOT push to git. cat integrates everything.
- Do NOT edit files outside your slice.
