# Peer-Terminal Binding Rewrite — Spec for Distributed Implementation

This is a coordinated rewrite. **cat** is the coordinator. Each peer owns a slice.
Read this whole doc before editing — your slice depends on others' interfaces.

## Goal

Replace the current **PID-ancestor-search** mechanism for binding `Peer ↔ vscode.Terminal`
with **direct env-var binding**, and remove the entire `sleep` / `suspended` peer state.

Requirements (from the user):
1. Opening a `claude` / `codex` session adds a new peer to the sidebar.
2. VSCode extension peers have `source = "extension"`; everything else has `source = "terminal"`.
3. Peer name = randomly assigned animal noun from the unused pool (existing `PEER_NOUNS`).
4. When a peer is named, the editor tab title hosting that session is renamed to
   `<agent> • <peerName>` (e.g. `claude • goat`). Tab title and sidebar name are 1:1 in sync.
5. Closing the session (terminal closed, MCP stdio EOF, or extension host shutdown) **deletes**
   the peer from the sidebar AND resets the terminal title.
6. `sleep` / `suspended` peer states are abolished. A peer is either active or deleted.

## Architecture

```
Extension host (one per VSCode window)
  ├ extHostId = randomUUID() generated once on activate()
  ├ Map<terminalId, vscode.Terminal>   (in-memory)
  ├ creates terminals with env { AGENT_PEERS_TERMINAL_ID, AGENT_PEERS_EXT_HOST }
  └ registers itself as a peer (source="extension", extHostId, no terminalId)

MCP server (CLI side, one per CLI session)
  └ on register: reads env AGENT_PEERS_TERMINAL_ID / AGENT_PEERS_EXT_HOST, sends to broker

Broker
  ├ stores terminal_id, ext_host_id columns on peers
  ├ register: ALWAYS create new peer (no sleep-resume); honor preferredId if free
  ├ on disconnect (WS close + owner PID dead): HARD DELETE peer (no sleep)
  └ stale cleanup: HARD DELETE
```

## Changes already done by cat (coordinator)

- `src/shared/types.ts` —
  - Added `terminalId?: string | null` and `extHostId?: string | null` to `Peer` and `RegisterRequest`.
  - Removed `connected?: boolean` and `suspended?: boolean` from `Peer`.
  - Comment on `HeartbeatRequest.pid` updated (no more sleep-resume).

## Slices

### Slice B — Broker rewrite (owner: **narwhal**)

File: `src/broker/index.ts`

1. **Schema migration** — add columns:
   ```sql
   ALTER TABLE peers ADD COLUMN terminal_id TEXT;
   ALTER TABLE peers ADD COLUMN ext_host_id TEXT;
   ```
   Wrap each in try/catch (column-already-exists). Do NOT drop the `sleep` column
   (SQLite makes that painful) — instead, on startup run:
   ```sql
   DELETE FROM peers WHERE sleep = 1;
   ```
   This wipes all stale sleeping peers (user approved). The column stays at 0 forever after.

2. **Update `RawPeerRow`** — add `terminal_id: string | null; ext_host_id: string | null;`.

3. **Update `rowToPeer`** —
   - Output `terminalId: row.terminal_id` and `extHostId: row.ext_host_id`.
   - **Remove** the `connected` and `suspended` fields from output.

4. **Rewrite `insertPeer` prepared statement** to include the new columns:
   ```ts
   INSERT INTO peers (id, agent_type, source, pid, cwd, git_root, tty,
                      terminal_id, ext_host_id, context_json,
                      registered_at, last_seen)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ```

5. **Rewrite `handleRegister`** — strip the entire sleeping-peer reuse path. New logic:
   ```ts
   function handleRegister(body: RegisterRequest): RegisterResponse {
     const now = new Date().toISOString();
     const source = body.source ?? "terminal";
     db.exec("BEGIN");
     let id: string;
     try {
       const existingIds = new Set((selectAllPeers.all() as RawPeerRow[]).map(r => r.id));
       if (body.preferredId && !existingIds.has(body.preferredId)) {
         id = body.preferredId;
       } else {
         id = generateId(existingIds);
       }
       insertPeer.run(id, body.agentType, source, body.pid, body.cwd, body.gitRoot,
                      body.tty, body.terminalId ?? null, body.extHostId ?? null,
                      JSON.stringify(body.context), now, now);
       db.exec("COMMIT");
     } catch (e) { db.exec("ROLLBACK"); throw e; }
     const peer = rowToPeer(selectPeerById.get(id) as RawPeerRow);
     broadcast({ type: "peer-joined", data: peer, timestamp: now });
     return { id };
   }
   ```
   - Delete `selectActiveByPid`, `selectSuspendedByRepo`, `selectSuspendedByCwd`.
   - Delete `chooseRegisterReuseCandidate`, `getSleepFingerprint`,
     `mergeSleepingPeerIntoCanonical`, `collapseRedundantSleepingPeers`,
     `mergeStoredContexts`, and any helper used only by them.

6. **Rewrite `handleHeartbeat`** — no more `sleep` resume:
   ```ts
   function handleHeartbeat(body: HeartbeatRequest): { ok: boolean } {
     const row = selectPeerById.get(body.id) as RawPeerRow | undefined;
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
   ```

7. **Replace `detachPeer` with `removePeer` everywhere.** Delete `detachPeer` entirely.
   Every prior call site must call `removePeer` instead. `removePeer` already:
   - Deletes the peer row + their messages.
   - Broadcasts `peer-left`.

8. **`cleanStalePeers`** — simplify:
   ```ts
   function cleanStalePeers() {
     const peers = db.prepare("SELECT id, pid, last_seen FROM peers").all() as { id:string; pid:number; last_seen:string }[];
     const now = Date.now();
     for (const peer of peers) {
       const staleByTime = now - new Date(peer.last_seen).getTime() > PEER_TIMEOUT_MS;
       let deadByPid = false;
       if (peer.pid !== process.pid && peer.pid !== 0) {
         try { process.kill(peer.pid, 0); } catch { deadByPid = true; }
       }
       if (staleByTime || deadByPid) removePeer(peer.id);
     }
   }
   ```
   No more `collapseRedundantSleepingPeers` call.

9. **WS close / error handlers** (around line 1715–1747): when WS drops and owner PID is
   dead, call `removePeer(identifiedPeerId)` instead of `detachPeer`.

10. **Send-message validation** — delete the `if (target.sleep) { return ... }` block in
    `handleSendMessage`. There is no sleep state.

11. **Delete handlers** — `handleSuspendPeer`, `handleResumePeer`. Keep the
    `/suspend-peer`, `/resume-peer` HTTP routes but make them no-ops that return `{ok:true}`
    (avoids breaking any old client; the extension UI button will be removed by ant).

12. **`handleCleanup`** — replace its body so it deletes dead peers instead of
    suspending them:
    ```ts
    function handleCleanup(): { suspended: number; remaining: number } {
      const peers = selectAllPeers.all() as RawPeerRow[];
      let removed = 0;
      for (const peer of peers) {
        if (peer.pid === process.pid || peer.pid === 0) continue;
        try { process.kill(peer.pid, 0); } catch {
          removePeer(peer.id);
          removed++;
        }
      }
      return { suspended: removed, remaining: (selectAllPeers.all() as RawPeerRow[]).length };
    }
    ```
    (Keep response shape for backward compat; field name `suspended` is now misleading
    but renaming it ripples too far — leave it.)

13. **`deduplicateExchanges`** — keep as-is, still useful for duplicate peers in the
    same recent-exchange window.

**Constraints:**
- Code must remain OS-independent (see AGENT.md: prohibited patterns).
- All `db.prepare` calls remain inside the broker, no schema work elsewhere.
- Do NOT touch any file outside `src/broker/index.ts`.
- When done, run `bun run build:broker` and report success or paste the error.

---

### Slice E — Extension rewrite (owner: **goat**)

File: `src/extension/index.ts` (and create `src/extension/peer-terminal-bind.ts` if helpful).

1. **Generate `extHostId` once per activation:**
   ```ts
   import { randomUUID } from "crypto";
   const extHostId = randomUUID();
   ```
   Persist to a module-level const inside `activate()`. Pass to broker on every register.

2. **Maintain a Map<terminalId, vscode.Terminal>:**
   ```ts
   const terminalsById = new Map<string, vscode.Terminal>();
   const terminalIdsByTerminal = new WeakMap<vscode.Terminal, string>();
   ```

3. **All `vscode.window.createTerminal` calls** in this file must inject env:
   ```ts
   const terminalId = randomUUID();
   const terminal = vscode.window.createTerminal({
     name,
     env: {
       AGENT_PEERS_TERMINAL_ID: terminalId,
       AGENT_PEERS_EXT_HOST: extHostId,
     },
     // …existing options like location/iconPath
   });
   terminalsById.set(terminalId, terminal);
   terminalIdsByTerminal.set(terminal, terminalId);
   ```
   Search for `createTerminal(` in the file and update each occurrence.
   The "Agent Peers MCP Setup" terminal (around line 920) does NOT need binding —
   no peer runs in it. Skip injecting env there.

4. **Delete** the entire PID-tracking machinery:
   - `getParentPid`, `getAncestorPids`, `findTerminalForPid`
   - `peerTerminalAssignments`, `peerTerminalPids`
   - `pendingGridTerminals`, `enqueuePendingGridTerminal`, `claimPendingGridTerminal`
   - `resolveTerminalForPeer`
   - `schedulePeerTerminalRename` (replaced — see below)
   - `syncPeerTerminalTitles` (replaced — see below)
   - `getTerminalKeyForAgent`, `getTerminalKeyForCommand` (only used by the deleted code)

5. **New `bindPeerToTerminal(peer)`** — only renames if this peer belongs to *us*:
   ```ts
   async function bindPeerToTerminal(peer: Peer): Promise<void> {
     if (peer.source !== "terminal") return;          // only term peers get tab renames
     if (peer.extHostId !== extHostId) return;        // belongs to another VSCode window
     if (!peer.terminalId) return;                    // launched outside the extension (case A1) — skip
     const terminal = terminalsById.get(peer.terminalId);
     if (!terminal || !isKnownTerminal(terminal)) return;
     await renameTerminalWithPeerTitle(terminal, getTerminalPeerTitle(peer));
   }
   ```
   Keep `renameTerminalWithPeerTitle`, `focusTerminalAndRename`, `resetTerminalTitle`,
   `terminalPeerTitles`, `terminalOriginalTitles`, `getTerminalPeerTitle`,
   `getTerminalAgentLabel` — they still work.

6. **New `unbindPeerFromTerminal(peer)`** — fired on `peer-left`:
   ```ts
   async function unbindPeerFromTerminal(peer: Pick<Peer, "terminalId" | "extHostId">): Promise<void> {
     if (peer.extHostId !== extHostId) return;
     if (!peer.terminalId) return;
     const terminal = terminalsById.get(peer.terminalId);
     if (terminal && isKnownTerminal(terminal)) {
       terminalPeerTitles.delete(terminal);
       await resetTerminalTitle(terminal);
     }
   }
   ```
   **Note**: `peer-left` event currently only carries `{ id }`. We need the
   `terminalId`/`extHostId` to reset the title. Solutions:
   - (preferred) Maintain `Map<peerId, terminalId>` in the extension, populated on
     `peer-joined`. On `peer-left`, look up by id, then clean up.
   - This avoids changing the broker event payload.

7. **Wire up events in `activate()`:**
   ```ts
   brokerClient.on("peer-joined", (data) => {
     const peer = data as Peer;
     peerListProvider.refresh();
     memoryProvider.refresh();
     void bindPeerToTerminal(peer);
   });
   brokerClient.on("peer-left", (data) => {
     const { id } = data as { id: string };
     const terminalId = peerTerminalIdById.get(id);
     if (terminalId) {
       void unbindPeerFromTerminal({ terminalId, extHostId });
       peerTerminalIdById.delete(id);
     }
     peerListProvider.refresh();
     memoryProvider.refresh();
   });
   ```
   (`peerTerminalIdById = new Map<string, string>()` populated in `bindPeerToTerminal`.)

8. **`onDidCloseTerminal`** — when a tab is closed, find the bound peer and tell the
   broker to delete it:
   ```ts
   vscode.window.onDidCloseTerminal(async (terminal) => {
     const tid = terminalIdsByTerminal.get(terminal);
     if (!tid) return;
     terminalsById.delete(tid);
     // Find the peer that owned this terminal and ask broker to delete it.
     const peers = await brokerClient.listPeers("machine");
     const owned = peers.find(p => p.terminalId === tid && p.extHostId === extHostId);
     if (owned) {
       await brokerClient.deletePeer(owned.id);  // /delete-peer endpoint
     }
   });
   ```
   `BrokerClient.deletePeer` may not exist yet — add a thin wrapper that POSTs to
   `/delete-peer` with `{ id }` (the broker route already exists). Search
   `src/extension/broker-client.ts` for similar methods.

9. **Register the extension itself as a peer** (already happens? confirm):
   - Search `src/extension/` for code that registers with `source: "extension"`.
   - Whether it goes through `broker-client.ts` or directly: ensure the register
     payload now includes `extHostId` (the `randomUUID()` generated in step 1) and
     no `terminalId`.
   - Use a stable `preferredId` like `extHostId` if you want, but a random animal
     name from broker is also fine. User does not require it to be stable across
     restarts.

10. **Grid-creation flow** (`openTerminalGrid`) — the old code used a "pending grid"
    queue to claim un-assigned peers. With env binding, **no claim needed**: each
    grid terminal gets a unique `terminalId`, and the peer that registers from
    inside it auto-binds. Simplify by removing the queue logic. Just create
    terminals with env-injection (step 3) and run the command.

11. **Periodic `syncPeerTerminalTitles` calls** at lines 432, 544, 705, 1135, 1155 —
    delete them. Replace with: nothing. Binding now happens on `peer-joined` and
    only requires the local Map lookup.

12. **`peer-list.ts`** — leave the `[term]`/`[ext]` source labels and emoji rendering
    as-is unless ant's slice touches them.

**Dependencies:**
- Slice S (moose) must populate `terminalId`/`extHostId` on register, otherwise
  the binding will silently skip every peer. Coordinate with moose.

**Constraints:**
- OS-independent.
- Do NOT touch `src/broker/`, `src/server/`, `src/shared/`, or `src/extension/views/`.
- When done, run `bun run build:extension` and report.

---

### Slice S — MCP server register payload (owner: **moose**)

File: `src/server/index.ts`

1. Find the `register` call (search for `RegisterRequest` or `/register`).
2. Read env vars and add to the payload:
   ```ts
   const terminalId = process.env.AGENT_PEERS_TERMINAL_ID || null;
   const extHostId = process.env.AGENT_PEERS_EXT_HOST || null;
   ```
3. Include `terminalId` and `extHostId` in the register request body.
4. The MCP server normally sets `source: "terminal"` (or omits, defaulting to terminal) — leave that.
5. **Constraints:**
   - OS-independent.
   - Do NOT touch any other file.
   - When done, run `bun run build:server` and report.

---

### Slice U — UI cleanup (owner: **ant**)

File: `src/extension/views/peer-list.ts`. Possibly `src/extension/views/control.ts` too.

1. Open `src/extension/views/peer-list.ts`. Remove anything that renders or branches on:
   - `peer.suspended`
   - `peer.connected`
   - "sleep", "sleeping", "suspended" labels
   - Sleep/wake icons or status pills
2. Search for `suspended`, `sleep`, `connected` across `src/extension/views/`. Remove
   conditional UI for those states. Peers are uniformly active.
3. If there is a "Suspend Peer" / "Resume Peer" command in `package.json` contributes
   or a context menu in `peer-list.ts`, remove it. Same for the command handler in
   `src/extension/index.ts` if you spot it (coordinate with goat — leave it for
   goat to actually delete the handler; you only need to remove the menu/UI entry).
4. **Constraints:**
   - Codex: please do NOT modify `src/extension/index.ts` — that is goat's slice.
     Only touch `src/extension/views/*` and `package.json` (contributes section only).
   - OS-independent.
   - When done, run `bun run build:extension` and report.

---

## Coordination protocol

- All four peers (narwhal, goat, moose, ant) work in **parallel**.
- When you finish your slice, send a `report` (type=report) back to **cat** (peer id `cat`).
- Include in the report: which files you changed, any spec deviations, and the
  build command output.
- Do NOT push to git. cat will integrate, run `just vsix`, and verify in VSCode.
- If you find a contradiction between this spec and the existing code that
  prevents progress, send a `text` message to cat — do NOT improvise around it.

## Files NOT to touch (any peer)

- `src/shared/types.ts` — already updated by cat. Leave it alone.
- `package.json` outside the `contributes` section.
- Anything under `out/`.
- `src/hooks/`, `src/cli/` (if present).
- This spec doc.
