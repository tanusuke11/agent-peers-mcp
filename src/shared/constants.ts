/**
 * Shared constants for agent-peers
 */

import os from "os";
import path from "path";

export const DEFAULT_BROKER_PORT = 7899;
export const DEFAULT_WS_PORT = 7900;
export const BROKER_HOST = "127.0.0.1";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_PEER_CLEANUP_MS = 20_000;
export const PEER_TIMEOUT_MS = 30_000;
/** Sleeping peers older than this are hard-deleted (not just kept indefinitely). */
export const SLEEPING_PEER_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export const BROKER_DB_PATH = path.join(os.homedir(), ".agent-peers.db");

export function getBrokerUrl(port?: number): string {
  return `http://${BROKER_HOST}:${port ?? DEFAULT_BROKER_PORT}`;
}

export function getWsUrl(port?: number): string {
  return `ws://${BROKER_HOST}:${port ?? DEFAULT_WS_PORT}`;
}
