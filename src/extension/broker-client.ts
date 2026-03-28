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
  WsEvent,
} from "../shared/types";

type EventHandler = (data: unknown) => void;

export class BrokerClient {
  private baseUrl: string;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Broker error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async health(): Promise<BrokerHealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return res.json() as Promise<BrokerHealthResponse>;
    } catch { /* broker not running */ }
    return null;
  }

  async listPeers(scope: "machine" | "directory" | "repo" = "machine"): Promise<Peer[]> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      return await this.post<Peer[]>("/list-peers", {
        scope,
        cwd: workspaceFolder,
        gitRoot: null,
      });
    } catch {
      return [];
    }
  }

  async sendMessage(fromId: string, toId: string, type: MessageType, text: string): Promise<void> {
    await this.post("/send-message", { fromId, toId, type, text });
  }

  async ensureBroker(extensionUri: vscode.Uri): Promise<void> {
    const h = await this.health();
    if (h) return; // Already running

    // Try to start it
    const brokerPath = vscode.Uri.joinPath(extensionUri, "src", "broker", "index.ts").fsPath;
    const terminal = vscode.window.createTerminal({
      name: "Agent Peers Broker",
      hideFromUser: true,
    });
    terminal.sendText(`bun "${brokerPath}" &`);

    // Wait for it to come up
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const h2 = await this.health();
      if (h2) return;
    }
  }

  // ─── WebSocket ─────────────────────────────────────────

  connectWs() {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log("[agent-peers] WebSocket connected");
      };

      this.ws.onmessage = (event) => {
        try {
          const wsEvent = JSON.parse(String(event.data)) as WsEvent;
          this.emit(wsEvent.type, wsEvent.data);
        } catch { /* ignore bad messages */ }
      };

      this.ws.onclose = () => {
        console.log("[agent-peers] WebSocket disconnected, reconnecting...");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
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

  // ─── Cleanup ──────────────────────────────────────────

  dispose() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.listeners.clear();
  }
}
