/**
 * Shared constants for agent-peers
 */

export const DEFAULT_BROKER_PORT = 7899;
export const DEFAULT_WS_PORT = 7900;
export const BROKER_HOST = "127.0.0.1";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_PEER_CLEANUP_MS = 60_000;
export const PEER_TIMEOUT_MS = 30_000;

import os from "os";
export const BROKER_DB_PATH = `${os.homedir()}/.agent-peers.db`;

export function getBrokerUrl(port?: number): string {
  return `http://${BROKER_HOST}:${port ?? DEFAULT_BROKER_PORT}`;
}

export const DEFAULT_MAX_MESSAGES_PER_DIRECTION = 50;

export function getWsUrl(port?: number): string {
  return `ws://${BROKER_HOST}:${port ?? DEFAULT_WS_PORT}`;
}
