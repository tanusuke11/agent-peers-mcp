/**
 * Broker client for the VSCode extension
 * Handles HTTP API calls and WebSocket real-time connection
 */

import * as vscode from "vscode";
import type {
  Peer,
  Message,
  MessageType,
  BrokerHealthResponse,
  RepoMemory,
  SearchMemoryResponse,
  ListMemoriesResponse,
  WsEvent,
} from "../shared/types";
import { findNodeBinary } from "../shared/process";

type EventHandler = (data: unknown) => void;

export class BrokerClient {
  private baseUrl: string;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedGitRoot: string | null | undefined = undefined; // undefined = not yet resolved

  constructor(
    private httpPort: number,
    private wsPort: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${httpPort}`;
    this.wsUrl = `ws://127.0.0.1:${wsPort}`;
  }

  // ─── HTTP API ──────────────────────────────────────────

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Connection": "close" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Broker error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async health(timeoutMs = 2000): Promise<BrokerHealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Connection": "close" },
      });
      if (res.ok) return res.json() as Promise<BrokerHealthResponse>;
    } catch { /* broker not running */ }
    return null;
  }

  async getGitRoot(): Promise<string | null> {
    if (this.cachedGitRoot === undefined) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      try {
        const { execFile } = require("child_process") as typeof import("child_process");
        this.cachedGitRoot = await new Promise<string | null>((resolve) => {
          execFile("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceFolder, timeout: 3000 }, (err, stdout) => {
            resolve(err ? null : stdout.trim());
          });
        });
      } catch { this.cachedGitRoot = null; }
    }
    return this.cachedGitRoot;
  }

  async listPeers(scope: "machine" | "directory" | "repo" = "machine"): Promise<Peer[]> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      let gitRoot: string | null = null;
      if (scope === "repo") {
        // Resolve git root once and cache — avoids execSync on every call
        if (this.cachedGitRoot === undefined) {
          try {
            const { execFile } = require("child_process") as typeof import("child_process");
            gitRoot = await new Promise<string | null>((resolve) => {
              execFile("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceFolder, timeout: 3000 }, (err, stdout) => {
                resolve(err ? null : stdout.trim());
              });
            });
          } catch { gitRoot = null; }
          this.cachedGitRoot = gitRoot;
        } else {
          gitRoot = this.cachedGitRoot;
        }
      }
      return await this.post<Peer[]>("/list-peers", {
        scope,
        cwd: workspaceFolder,
        gitRoot,
      });
    } catch {
      return [];
    }
  }

  async sendMessage(fromId: string, toId: string, type: MessageType, text: string): Promise<void> {
    await this.post("/send-message", { fromId, toId, type, text });
  }

  async unregisterPeer(id: string): Promise<void> {
    await this.post("/unregister", { id });
  }

  async deletePeer(id: string): Promise<void> {
    await this.post("/delete-peer", { id });
  }

  async suspendPeer(id: string): Promise<void> {
    await this.post("/suspend-peer", { id });
  }

  async resumePeer(id: string): Promise<void> {
    await this.post("/resume-peer", { id });
  }

  async cleanup(): Promise<{ removed: number; remaining: number } | null> {
    try {
      return await this.post<{ removed: number; remaining: number }>("/cleanup", {});
    } catch {
      return null;
    }
  }

  async wakePeer(id: string): Promise<{ ok: boolean; delivered: number } | null> {
    try {
      return await this.post<{ ok: boolean; delivered: number }>("/wake-peer", { id });
    } catch {
      return null;
    }
  }

  async pollMessages(id: string): Promise<{ found: boolean; messages: Message[] } | null> {
    try {
      return await this.post<{ found: boolean; messages: Message[] }>("/poll-messages", { id });
    } catch {
      return null;
    }
  }

  async peekMessages(id: string): Promise<Message[]> {
    try {
      const result = await this.post<{ found: boolean; messages: Message[] }>("/peek-messages", { id });
      return result.messages;
    } catch {
      return [];
    }
  }

  async listMessages(peerId: string): Promise<Message[]> {
    try {
      const result = await this.post<{ messages: Message[] }>("/list-messages", { id: peerId });
      return result.messages;
    } catch {
      return [];
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    await this.post("/delete-message", { id: messageId });
  }

  async clearMessages(peerId: string): Promise<void> {
    await this.post("/clear-messages", { peerId });
  }

  async purge(): Promise<{ purged: number } | null> {
    try {
      return await this.post<{ purged: number }>("/purge", {});
    } catch {
      return null;
    }
  }

  async updateConfig(config: { autoConflictCheck?: boolean; maxContextLength?: number }): Promise<{ ok: boolean; autoConflictCheck: boolean; maxContextLength: number } | null> {
    try {
      return await this.post<{ ok: boolean; autoConflictCheck: boolean; maxContextLength: number }>("/update-config", config);
    } catch {
      return null;
    }
  }

  async registerPeer(agentType: string, pid: number, cwd: string, gitRoot: string | null, source: "terminal" | "extension" = "extension", opts?: { extHostId?: string; terminalId?: string }): Promise<{ id: string }> {
    const now = new Date().toISOString();
    return await this.post<{ id: string }>("/register", {
      agentType,
      source,
      pid,
      cwd,
      gitRoot,
      tty: null,
      terminalId: opts?.terminalId ?? null,
      extHostId: opts?.extHostId ?? null,
      context: { summary: "", activeFiles: [], git: null, updatedAt: now },
    });
  }

  /**
   * Ensure the broker is running. Non-blocking: spawns the process and polls
   * in the background without blocking extension activation.
   */
  async ensureBroker(extensionUri: vscode.Uri, killZombie?: () => Promise<void>): Promise<void> {
    const h = await this.health(500);
    if (h) return; // Already running

    // Kill zombie broker that may be occupying the port but not responding
    if (killZombie) await killZombie();

    // Start broker as a detached background process (no terminal needed)
    const brokerPath = vscode.Uri.joinPath(extensionUri, "out", "broker", "index.js").fsPath;
    const { spawn } = require("child_process") as typeof import("child_process");
    const cfg = vscode.workspace.getConfiguration("agentPeers");
    const autoConflict = cfg.get<boolean>("autoConflictCheck", true);
    const maxContextLength = cfg.get<number>("maxContextLength", 30);
    const proc = spawn(findNodeBinary(), [brokerPath], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        AGENT_PEERS_AUTO_CONFLICT_CHECK: String(autoConflict),
        AGENT_PEERS_MAX_CONTEXT_LENGTH: String(maxContextLength),
      },
    });
    proc.unref();

    // Poll with short intervals — broker typically starts in <500ms
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const h2 = await this.health(500);
      if (h2) {
        this.connectWs();
        return;
      }
    }

    vscode.window.showWarningMessage(
      "Agent Peers: Broker failed to start within timeout. Check the terminal output or start it manually.",
    );
  }

  // ─── WebSocket ─────────────────────────────────────────

  connectWs() {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log("[agent-peers] WebSocket connected");
        this.emit("broker-connected", null);
      };

      this.ws.onmessage = (event) => {
        try {
          const wsEvent = JSON.parse(String(event.data)) as WsEvent;
          this.emit(wsEvent.type, wsEvent.data);
        } catch { /* ignore bad messages */ }
      };

      this.ws.onclose = () => {
        console.log("[agent-peers] WebSocket disconnected, reconnecting...");
        this.emit("broker-disconnected", null);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.emit("broker-disconnected", null);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, 3000);
  }

  // ─── Event emitter ────────────────────────────────────

  on(event: string, handler: EventHandler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  private emit(event: string, data: unknown) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  // ─── Repo Memory ────────────────────────────────────────

  async listRepoMemories(gitRoot: string, category?: string, limit?: number): Promise<RepoMemory[]> {
    const result = await this.post<ListMemoriesResponse>("/repo-memory/list", { gitRoot, category, limit });
    return result.memories;
  }

  async searchRepoMemories(gitRoot: string, query: string): Promise<RepoMemory[]> {
    const result = await this.post<SearchMemoryResponse>("/repo-memory/search", { gitRoot, query });
    return result.memories;
  }

  // ─── Cleanup ──────────────────────────────────────────

  dispose() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.listeners.clear();
  }
}
