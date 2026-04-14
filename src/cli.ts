#!/usr/bin/env bun
/**
 * agent-peers CLI
 *
 * Utility commands for inspecting and interacting with the peer network.
 *
 * Usage:
 *   bun src/cli.ts status             — Show broker status and all peers
 *   bun src/cli.ts peers              — List all peers with context
 *   bun src/cli.ts send <id> <msg>    — Send a message to a peer
 *   bun src/cli.ts context <id>       — Show a peer's full context
 *   bun src/cli.ts kill-broker        — Stop the broker daemon
 */

import { DEFAULT_BROKER_PORT, BROKER_HOST } from "./shared/constants.ts";
import type { Peer, BrokerHealthResponse, PollMessagesResponse } from "./shared/types.ts";

const PORT = parseInt(process.env.AGENT_PEERS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOST}:${PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<BrokerHealthResponse>("/health");
      console.log(`Broker: ${health.status}`);
      console.log(`Peers: ${health.peerCount}`);
      console.log(`Uptime: ${health.uptime}s`);
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: process.cwd(),
      gitRoot: null,
    });

    if (peers.length === 0) {
      console.log("No peers connected.");
      break;
    }

    for (const p of peers) {
      console.log(`\n[${ p.agentType}] ${p.id}`);
      console.log(`  PID: ${p.pid}`);
      console.log(`  CWD: ${p.cwd}`);
      if (p.context.summary) console.log(`  Summary: ${p.context.summary}`);
      if (p.context.currentTask) console.log(`  Task: ${p.context.currentTask}`);
      if (p.context.git?.branch) console.log(`  Branch: ${p.context.git.branch}`);
      if (p.context.activeFiles?.length) {
        console.log(`  Active files: ${p.context.activeFiles.map((f) => f.relativePath || f.path).join(", ")}`);
      }
      if (p.context.git?.modifiedFiles?.length) {
        console.log(`  Modified: ${p.context.git.modifiedFiles.join(", ")}`);
      }
      console.log(`  Last seen: ${p.lastSeen}`);
    }
    break;
  }

  case "send": {
    const [toId, ...msgParts] = args;
    if (!toId || msgParts.length === 0) {
      console.error("Usage: bun src/cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      fromId: "cli",
      toId,
      type: "text",
      text: msgParts.join(" "),
      fromUser: true,
    });
    console.log(result.ok ? "Message sent." : `Error: ${result.error}`);
    break;
  }

  case "context": {
    const [peerId] = args;
    if (!peerId) {
      console.error("Usage: bun src/cli.ts context <peer-id>");
      process.exit(1);
    }
    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: process.cwd(),
      gitRoot: null,
    });
    const peer = peers.find((p) => p.id === peerId);
    if (!peer) {
      console.error(`Peer ${peerId} not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(peer.context, null, 2));
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<BrokerHealthResponse>("/health");
      console.log(`Broker is running with ${health.peerCount} peers.`);
      // We can't kill it cleanly via HTTP, but we can find and kill the process
      console.log("Send SIGTERM to the broker process to stop it.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`agent-peers CLI

Commands:
  status          Show broker status
  peers           List all connected peers with context
  send <id> <msg> Send a message to a peer
  context <id>    Show a peer's full structured context
  kill-broker     Stop the broker daemon
`);
}
