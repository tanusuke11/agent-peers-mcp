/**
 * Agent Peers — VSCode Extension entry point
 *
 * Provides:
 *   - Sidebar with Peer List, Messages, and Shared Context views
 *   - Real-time updates via WebSocket connection to broker
 *   - Commands: refresh peers, send message, share context, start broker
 */

import * as vscode from "vscode";
import { BrokerClient } from "./broker-client";
import { PeerListProvider } from "./views/peer-list";
import { ControlProvider } from "./views/control";
import { DetailPanelProvider } from "./views/detail-panel";
import { MemoryProvider } from "./views/memory";
import type { MarkdownViewItem } from "./views/webview-content";
import { forceKillProcess, findNodeBinary } from "../shared/process";
import type { Peer } from "../shared/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

let brokerClient: BrokerClient;

// ─── Message batching ─────────────────────────────────────
// Debounce rapid-fire messages per direction (fromId→toId) so that
// multi-part completion reports are delivered as a single sendText().

interface PendingDelivery {
  fromId: string;
  toId: string;
  type: string;
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
}

/** Map key = `${fromId}\0${toId}` */
const pendingDeliveries = new Map<string, PendingDelivery>();

/** How long to wait for additional messages before flushing (ms). */
const MESSAGE_BATCH_DELAY_MS = 600;

// ─── Terminal binding maps ────────────────────────────────

/** Unique ID for this extension host, generated once per activate(). */
let extHostId = "";

/** Maps terminalId (UUID injected via env) → vscode.Terminal instance. */
const terminalsById = new Map<string, vscode.Terminal>();
/** Reverse map: vscode.Terminal → terminalId. */
const terminalIdsByTerminal = new WeakMap<vscode.Terminal, string>();
/** Maps peerId → terminalId, populated on peer-joined for our terminals. */
const peerTerminalIdById = new Map<string, string>();

const terminalPeerTitles = new WeakMap<vscode.Terminal, string>();
/** Stores the original terminal name before peer renaming, so we can restore it on peer-left. */
const terminalOriginalTitles = new WeakMap<vscode.Terminal, string>();

function isKnownTerminal(terminal: vscode.Terminal): boolean {
  return vscode.window.terminals.includes(terminal);
}

function hasActiveTerminalTab(group: vscode.TabGroup): boolean {
  return group.activeTab?.input instanceof vscode.TabInputTerminal;
}

function getTerminalAgentLabel(agentType: Peer["agentType"]): string {
  switch (agentType) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    default:
      return "agent";
  }
}

function getTerminalPeerTitle(peer: Pick<Peer, "agentType" | "id">): string {
  return `${getTerminalAgentLabel(peer.agentType)} • ${peer.id}`;
}

async function focusTerminalAndRename(terminal: vscode.Terminal, name: string): Promise<void> {
  const previouslyActive = vscode.window.activeTerminal;

  terminal.show(false);
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
  await new Promise((resolve) => setTimeout(resolve, 50));

  await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name });

  if (previouslyActive && previouslyActive !== terminal) {
    previouslyActive.show(false);
  }
}

async function renameTerminalWithPeerTitle(terminal: vscode.Terminal, title: string): Promise<void> {
  if (terminal.name === title || terminalPeerTitles.get(terminal) === title) return;

  // Save original title before first peer rename so we can restore on peer-left
  if (!terminalOriginalTitles.has(terminal)) {
    terminalOriginalTitles.set(terminal, terminal.name);
  }

  await focusTerminalAndRename(terminal, title);
  terminalPeerTitles.set(terminal, title);
}

/** Reset a terminal's title back to its original name (before peer renaming). */
async function resetTerminalTitle(terminal: vscode.Terminal): Promise<void> {
  const original = terminalOriginalTitles.get(terminal);
  // Fall back to a generic "Terminal" name if we never captured the original
  const resetName = original || "Terminal";
  await focusTerminalAndRename(terminal, resetName);
  terminalOriginalTitles.delete(terminal);
}

/** Bind a newly-joined peer to its terminal tab (rename). Only acts on our own terminals. */
async function bindPeerToTerminal(peer: Peer): Promise<void> {
  if (peer.source !== "terminal") return;
  if (peer.extHostId !== extHostId) return;
  if (!peer.terminalId) return;
  const terminal = terminalsById.get(peer.terminalId);
  if (!terminal || !isKnownTerminal(terminal)) return;
  peerTerminalIdById.set(peer.id, peer.terminalId);
  await renameTerminalWithPeerTitle(terminal, getTerminalPeerTitle(peer));
}

/** Unbind a peer from its terminal tab (reset title). Only acts on our own terminals. */
async function unbindPeerFromTerminal(peer: Pick<Peer, "terminalId" | "extHostId">): Promise<void> {
  if (peer.extHostId !== extHostId) return;
  if (!peer.terminalId) return;
  const terminal = terminalsById.get(peer.terminalId);
  if (terminal && isKnownTerminal(terminal)) {
    terminalPeerTitles.delete(terminal);
    await resetTerminalTitle(terminal);
  }
}

/**
 * Find and kill a zombie broker process that occupies the port but no longer
 * responds to health checks (e.g. stuck in CLOSE_WAIT).
 * Cross-platform: lsof on macOS/Linux, netstat on Windows.
 */
async function killZombieBroker(port: number): Promise<void> {
  const { execFile } = require("child_process") as typeof import("child_process");

  const pids = await new Promise<number[]>((resolve) => {
    if (process.platform === "win32") {
      execFile("netstat", ["-ano", "-p", "TCP"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const found: number[] = [];
        for (const line of stdout.split("\n")) {
          if (line.includes(`127.0.0.1:${port}`) && line.includes("LISTENING")) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1]!, 10);
            if (pid > 0) found.push(pid);
          }
        }
        resolve(found);
      });
    } else if (process.platform === "darwin") {
      // macOS: lsof is always present
      execFile("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const found = stdout.trim().split(/\s+/).map(Number).filter((n) => n > 0);
        resolve(found);
      });
    } else {
      // Linux: use `ss` (part of iproute2, universally available on modern Linux).
      // `lsof` may not be installed on minimal/container environments.
      // `ss -tlnp sport = :PORT` lists TCP listeners and embeds PIDs in the Process column.
      execFile("ss", ["-tlnp", `sport = :${port}`], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const found: number[] = [];
        for (const m of stdout.matchAll(/pid=(\d+)/g)) {
          const pid = parseInt(m[1]!, 10);
          if (pid > 0) found.push(pid);
        }
        resolve([...new Set(found)]);
      });
    }
  });

  for (const pid of pids) {
    try {
      forceKillProcess(pid);
    } catch { /* already gone */ }
  }

  // Brief wait for OS to release the port
  if (pids.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const GRID_SIZES = [
  { label: "1×1", description: "1 terminal", cols: 1, rows: 1 },
  { label: "2×1", description: "2 side by side", cols: 2, rows: 1 },
  { label: "1×2", description: "2 stacked", cols: 1, rows: 2 },
  { label: "2×2", description: "4 terminals", cols: 2, rows: 2 },
  { label: "3×1", description: "3 side by side", cols: 3, rows: 1 },
  { label: "3×2", description: "6 terminals", cols: 3, rows: 2 },
  { label: "2×3", description: "6 terminals", cols: 2, rows: 3 },
];

async function openTerminalGrid(command: string | undefined): Promise<void> {
  const picked = await vscode.window.showQuickPick(GRID_SIZES, {
    placeHolder: "Select terminal grid size (cols×rows)",
  });
  if (!picked) return;

  const { cols, rows } = picked;
  const total = cols * rows;

  // Build the editor grid layout using vscode.setEditorLayout
  // orientation: 0 = left-right (horizontal), 1 = top-bottom (vertical)
  const buildLayout = (): Record<string, unknown> => {
    if (total === 1) {
      return { orientation: 0, groups: [{ size: 1 }] };
    }
    if (rows === 1) {
      return {
        orientation: 0,
        groups: Array.from({ length: cols }, () => ({ size: 1 })),
      };
    }
    if (cols === 1) {
      return {
        orientation: 1,
        groups: Array.from({ length: rows }, () => ({ size: 1 })),
      };
    }
    return {
      orientation: 1,
      groups: Array.from({ length: rows }, () => ({
        orientation: 0,
        groups: Array.from({ length: cols }, () => ({ size: 1 })),
        size: 1,
      })),
    };
  };

  await vscode.commands.executeCommand("vscode.setEditorLayout", buildLayout());
  await new Promise(resolve => setTimeout(resolve, 300));

  const groups = [...vscode.window.tabGroups.all]
    .sort((a, b) => Number(a.viewColumn) - Number(b.viewColumn))
    .slice(0, total);

  // Create a terminal editor tab only in groups that do not already have an
  // active terminal session. Existing terminal editors are preserved in place
  // and only participate in the arranged layout.
  //
  // We create new terminals with an explicit `location: { viewColumn }` so each
  // one lands in the intended group regardless of which group is currently
  // focused. `createTerminalEditor` (the command) targets the active group
  // only, which is unreliable when some groups are still empty — new empty
  // groups can get merged/collapsed before the command runs.
  for (const group of groups) {
    if (hasActiveTerminalTab(group)) {
      continue;
    }

    const viewColumn = group.viewColumn;

    const terminalId = randomUUID();
    const terminal = vscode.window.createTerminal({
      location: { viewColumn } as vscode.TerminalEditorLocationOptions,
      env: {
        AGENT_PEERS_TERMINAL_ID: terminalId,
        AGENT_PEERS_EXT_HOST: extHostId,
      },
    });
    terminalsById.set(terminalId, terminal);
    terminalIdsByTerminal.set(terminal, terminalId);
    terminal.show(false);

    // Give VS Code a moment to actually open the terminal editor in the group
    // before we move on — otherwise the next iteration's focus/creation can
    // race with it and cause groups to collapse.
    await new Promise(resolve => setTimeout(resolve, 150));

    if (command) {
      terminal.sendText(command);
    }
  }

  // Re-focus the first group so the user lands in a predictable place.
  await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
}

/**
 * Write the UserPromptSubmit hook config to Claude Code's settings.json.
 * Idempotent — skips if the hook is already configured.
 */
function configureConflictHook(extensionUri: vscode.Uri): { configured: boolean; error?: string } {
  const hookScript = vscode.Uri.joinPath(extensionUri, "out", "hooks", "check-conflicts.js").fsPath;
  // Use forward slashes for cross-platform compatibility in the command string
  const hookCommand = `node "${hookScript.replace(/\\/g, "/")}"`;

  const settingsDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");

  try {
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }

    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    if (!Array.isArray(hooks.UserPromptSubmit)) {
      hooks.UserPromptSubmit = [];
    }

    // Check if already configured
    const alreadyExists = hooks.UserPromptSubmit.some((group: unknown) => {
      const g = group as { hooks?: Array<{ command?: string }> };
      return g.hooks?.some(h => h.command?.includes("check-conflicts"));
    });
    if (alreadyExists) {
      return { configured: false };
    }

    hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: hookCommand }],
    });

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { configured: true };
  } catch (e) {
    return { configured: false, error: String(e) };
  }
}

// ─── Message Detail Items ─────────────────────────────────────

interface MessageViewItem extends MarkdownViewItem {
  fromId?: string;
  toId?: string;
  type?: string;
  sentAt?: string;
}

export function activate(extensionContext: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("agentPeers");
  const brokerPort = config.get<number>("brokerPort", 7899);
  const wsPort = brokerPort + 1; // Convention: WS port = HTTP port + 1

  // Generate a unique ID for this extension host (one per activate)
  extHostId = randomUUID();

  // Initialize broker client
  brokerClient = new BrokerClient(brokerPort, wsPort);

  // Initialize tree data providers
  const controlProvider = new ControlProvider(brokerClient);
  const peerListProvider = new PeerListProvider(brokerClient);
  const memoryProvider = new MemoryProvider(brokerClient);
  const detailPanelProvider = new DetailPanelProvider();
  // Register tree views
  const peerListView = vscode.window.createTreeView("agentPeers.peerList", {
    treeDataProvider: peerListProvider,
  });
  extensionContext.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentPeers.control", controlProvider),
    vscode.window.registerTreeDataProvider("agentPeers.memory", memoryProvider),
    vscode.window.registerWebviewViewProvider(DetailPanelProvider.viewId, detailPanelProvider),
    peerListView,
  );

  // Listen to real-time events
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
  brokerClient.on("context-updated", () => {
    peerListProvider.refresh();
  });
  brokerClient.on("memory-added", () => {
    memoryProvider.refresh();
  });
  /**
   * Deliver a prompt string to a terminal, accounting for agent-type differences.
   *
   * Claude Code uses a raw-mode TUI (Ink) that expects `\r` (carriage return)
   * for Enter. The default `terminal.sendText()` appends `\n` (line feed),
   * which raw-mode processes do NOT interpret as Enter — so the text appears
   * in the input but is never submitted.
   *
   * For claude-code peers we disable the automatic newline and explicitly
   * send `\r` to trigger submission. Other agent types use the default behaviour.
   */
  async function deliverToTerminal(terminal: vscode.Terminal, text: string, agentType: string) {
    if (agentType === "claude-code") {
      // Raw-mode TUI: send ESC first to exit any modal state (e.g. "accept edits on"),
      // then send text without trailing LF.
      terminal.sendText("\x1b", false);
      terminal.sendText(text, false);
      // Delay before CR so that bracketed-paste mode finishes processing the
      // multi-line text. Without this, the CR lands inside the paste bracket
      // and the terminal shows "[Pasted text]" without submitting.
      await new Promise(r => setTimeout(r, 80));
      terminal.sendText("\r", false);
    } else {
      terminal.sendText(text);
    }
  }

  // Show a message to the user via VS Code notification (for extension peers or fallback).
  async function showMessageNotification(fromId: string, toId: string, type: string, combined: string) {
    const typeLabel = type === "task-handoff" ? "Task handoff" : type === "context-request" ? "Context request" : "Message";
    const preview = combined.length > 200 ? combined.slice(0, 200) + "…" : combined;
    const choice = await vscode.window.showInformationMessage(
      `${typeLabel} from ${fromId} → ${toId}:\n${preview}`,
      { modal: false },
      "Copy to Clipboard",
      "Open in Sidebar",
    );
    if (choice === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(combined);
    } else if (choice === "Open in Sidebar") {
      try {
        const header = [
          `# Message from ${fromId}`,
          "",
          `- **Type:** ${type}`,
          `- **To:** ${toId}`,
          "",
          "---",
          "",
        ].join("\n");
        await detailPanelProvider.showMessage({
          title: `${typeLabel}: ${fromId}`,
          header,
          text: combined,
        });
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to open message detail: ${e}`);
      }
    }
    peerListProvider.refresh();
  }

  // Flush a batched delivery: combine all queued texts into one sendText().
  async function flushDelivery(key: string) {
    const pending = pendingDeliveries.get(key);
    if (!pending) return;
    pendingDeliveries.delete(key);

    const combined = pending.texts.join("\n\n");
    const prompt = `[Message from ${pending.fromId} (${pending.type})] ${combined}`;

    // Check if the target is an extension peer (no terminal available)
    const peers = await brokerClient.listPeers("machine");
    const peer = peers.find(p => p.id === pending.toId);
    if (peer?.source === "extension") {
      await showMessageNotification(pending.fromId, pending.toId, pending.type, combined);
      return;
    }

    const autoDeliver = vscode.workspace.getConfiguration("agentPeers").get<boolean>("autoDeliveryMessage", true);

    // Resolve terminal for the target peer via terminalId map
    const resolvedTerminal = peer?.terminalId ? terminalsById.get(peer.terminalId) ?? null : null;

    if (!autoDeliver) {
      const typeLabel = pending.type === "task-handoff" ? "Task handoff" : pending.type === "context-request" ? "Context request" : "Message";
      const preview = combined.length > 200 ? combined.slice(0, 200) + "…" : combined;
      const choice = await vscode.window.showInformationMessage(
        `${typeLabel} from ${pending.fromId} → ${pending.toId}:\n${preview}`,
        { modal: false },
        "Deliver to Terminal",
        "Dismiss",
      );
      if (choice === "Deliver to Terminal") {
        if (peer && resolvedTerminal) {
          deliverToTerminal(resolvedTerminal, prompt, peer.agentType);
          resolvedTerminal.show(true);
        }
      }
      peerListProvider.refresh();
      return;
    }

    if (peer && resolvedTerminal) {
      deliverToTerminal(resolvedTerminal, prompt, peer.agentType);
      resolvedTerminal.show(true);
      peerListProvider.refresh();
      return;
    }

    // Fallback: notification with actions
    await showMessageNotification(pending.fromId, pending.toId, pending.type, combined);
  }

  brokerClient.on("message", (data) => {
    peerListProvider.refresh();

    const msg = data as { fromId?: string; toId?: string; text?: string; type?: string } | undefined;

    // Report messages are NOT delivered to terminal — they only update the sidebar.
    if (msg?.type === "report") return;

    if (!msg?.toId || !msg?.fromId || !msg?.text) {
      // No target — show toast immediately
      if (msg?.fromId && msg?.text) {
        const preview = msg.text.length > 120 ? msg.text.slice(0, 120) + "…" : msg.text;
        vscode.window.showInformationMessage(`💬 ${msg.fromId}: ${preview}`);
      }
      return;
    }

    // Batch messages per direction: accumulate texts, reset timer each time.
    const key = `${msg.fromId}\0${msg.toId}`;
    const existing = pendingDeliveries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(msg.text);
      existing.timer = setTimeout(() => flushDelivery(key), MESSAGE_BATCH_DELAY_MS);
    } else {
      const timer = setTimeout(() => flushDelivery(key), MESSAGE_BATCH_DELAY_MS);
      pendingDeliveries.set(key, {
        fromId: msg.fromId,
        toId: msg.toId,
        type: msg.type ?? "text",
        texts: [msg.text],
        timer,
      });
    }
  });

  // Register commands
  extensionContext.subscriptions.push(
    vscode.window.onDidCloseTerminal(async (terminal) => {
      const tid = terminalIdsByTerminal.get(terminal);
      if (!tid) return;
      terminalsById.delete(tid);
      // Find the peer that owned this terminal and ask broker to delete it.
      const peers = await brokerClient.listPeers("machine");
      const owned = peers.find(p => p.terminalId === tid && p.extHostId === extHostId);
      if (owned) {
        await brokerClient.deletePeer(owned.id);
      }
    }),
    vscode.commands.registerCommand("agentPeers.sendMessage", async () => {
      const peers = await brokerClient.listPeers("machine");
      if (peers.length === 0) {
        vscode.window.showInformationMessage("No peers found on this machine.");
        return;
      }

      const items = peers.map((p) => {
        const sourceLabel = p.source === "extension" ? "[ext]" : "[term]";
        return {
          label: `${p.agentType} — ${p.id} ${sourceLabel}`,
          description: p.context.summary || p.cwd,
          detail: `CWD: ${p.cwd}${p.context.git?.branch ? ` | Branch: ${p.context.git.branch}` : ""}`,
          peerId: p.id,
          source: p.source,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a peer to message",
      });
      if (!selected) return;

      const message = await vscode.window.showInputBox({
        placeHolder: "Enter your message...",
        prompt: `Sending to ${selected.label}`,
      });
      if (!message) return;

      try {
        await brokerClient.sendMessage("vscode-extension", selected.peerId, "text", message);
        vscode.window.showInformationMessage(`Message sent to ${selected.peerId}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to send message: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.shareContext", async () => {
      vscode.window.showInformationMessage("Context sharing is handled automatically by the MCP server.");
    }),

    vscode.commands.registerCommand("agentPeers.startBroker", async () => {
      const health = await brokerClient.health(500);
      if (health) {
        vscode.window.showInformationMessage(`Agent Peers broker is already running (${health.peerCount} peers).`);
        return;
      }

      // A previous broker may be occupying the port but unresponsive (CLOSE_WAIT zombie).
      // Try to detect and kill it before spawning a new one.
      await killZombieBroker(brokerPort);

      const brokerPath = vscode.Uri.joinPath(extensionContext.extensionUri, "out", "broker", "index.js").fsPath;
      const { spawn } = require("child_process") as typeof import("child_process");
      const cfg = vscode.workspace.getConfiguration("agentPeers");
      const autoConflict = cfg.get<boolean>("autoConflictCheck", true);
      const proc = spawn(findNodeBinary(), [brokerPath], {
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          AGENT_PEERS_AUTO_CONFLICT_CHECK: String(autoConflict),
        },
      });
      proc.unref();
      // Poll until broker is ready, then immediately reconnect WS
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await brokerClient.health(500)) {
          brokerClient.connectWs();
          vscode.window.showInformationMessage("Agent Peers broker started.");
          return;
        }
      }
      vscode.window.showWarningMessage("Agent Peers broker may not have started. Check logs.");
    }),

    vscode.commands.registerCommand("agentPeers.stopBroker", async () => {
      // Get broker PID before attempting shutdown (for fallback)
      const healthBefore = await brokerClient.health();
      const brokerPid = healthBefore?.pid;

      // Try graceful shutdown via HTTP endpoint
      try {
        await fetch(`http://127.0.0.1:${brokerPort}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* broker may already be gone or unresponsive */ }

      // Wait briefly, then check if it's still alive
      await new Promise((r) => setTimeout(r, 500));
      const still = await brokerClient.health();
      if (still && brokerPid) {
        // Force kill as fallback (cross-platform)
        forceKillProcess(brokerPid);
      }

      vscode.window.showInformationMessage("Agent Peers broker stopped.");
      // WS onclose will detect disconnection automatically
    }),

    vscode.commands.registerCommand("agentPeers.disconnectPeer", async (item?: { peerId?: string; peer?: { id: string } }) => {
      const peerId = item?.peerId || item?.peer?.id;
      if (!peerId) {
        vscode.window.showWarningMessage("No peer selected.");
        return;
      }

      // Suspend functionality has been removed; command kept for compatibility.
      vscode.window.showInformationMessage("Suspend is no longer available.");
    }),

    vscode.commands.registerCommand("agentPeers.deletePeer", async (item?: { peerId?: string; peer?: { id: string } }) => {
      const peerId = item?.peerId || item?.peer?.id;
      if (!peerId) {
        vscode.window.showWarningMessage("No peer selected.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete peer "${peerId}"? All context and messages will be permanently removed.`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;
      try {
        // Close and clean up the terminal associated with this peer, if any.
        const tid = peerTerminalIdById.get(peerId);
        if (tid) {
          const assignedTerminal = terminalsById.get(tid);
          if (assignedTerminal && isKnownTerminal(assignedTerminal)) {
            assignedTerminal.dispose();
          }
          terminalsById.delete(tid);
          peerTerminalIdById.delete(peerId);
        }

        await brokerClient.deletePeer(peerId);
        peerListProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to delete peer: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.connectPeer", async (item?: { peerId?: string; peer?: { id: string } }) => {
      const peerId = item?.peerId || item?.peer?.id;
      if (!peerId) {
        vscode.window.showWarningMessage("No peer selected.");
        return;
      }

      // Resume functionality has been removed; command kept for compatibility.
      vscode.window.showInformationMessage("Resume is no longer available.");
    }),

    vscode.commands.registerCommand("agentPeers.addMcpServer", async () => {
      const serverScript = vscode.Uri.joinPath(extensionContext.extensionUri, "out", "server", "index.js").fsPath;
      const { exec } = require("child_process") as typeof import("child_process");
      const isWin = process.platform === "win32";

      // Check if claude CLI is available (cross-platform)
      const claudeFound = await new Promise<boolean>((resolve) => {
        exec(isWin ? "where claude" : "which claude", (err) => resolve(!err));
      });
      if (!claudeFound) {
        vscode.window.showErrorMessage(
          "Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code",
          "Open Install Guide",
        ).then((action) => {
          if (action) vscode.env.openExternal(vscode.Uri.parse("https://docs.anthropic.com/en/docs/claude-code"));
        });
        return;
      }

      const items = [
        { label: "Claude Code (user scope)", description: "claude mcp add --scope user", scope: "user" },
        { label: "Claude Code (project scope)", description: "claude mcp add --scope project", scope: "project" },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select scope for MCP server registration",
      });
      if (!selected) return;

      const cmd = `claude mcp add --scope ${selected.scope} --transport stdio agent-peers -- node "${serverScript}"`;
      const terminal = vscode.window.createTerminal({ name: "Agent Peers MCP Setup" });
      terminal.sendText(cmd);
      terminal.show();
      vscode.window.showInformationMessage(`Running: ${cmd}`);

      // Auto-configure conflict detection hook
      const hookResult = configureConflictHook(extensionContext.extensionUri);
      if (hookResult.configured) {
        vscode.window.showInformationMessage("Conflict detection hook configured in ~/.claude/settings.json");
      } else if (hookResult.error) {
        vscode.window.showWarningMessage(`Could not configure conflict hook: ${hookResult.error}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.addMcpServerCodex", async () => {
      const serverScript = vscode.Uri.joinPath(extensionContext.extensionUri, "out", "server", "index.js").fsPath;
      const { exec } = require("child_process") as typeof import("child_process");
      const isWin = process.platform === "win32";

      // Check if codex CLI is available (cross-platform)
      const codexFound = await new Promise<boolean>((resolve) => {
        exec(isWin ? "where codex" : "which codex", (err) => resolve(!err));
      });
      if (!codexFound) {
        vscode.window.showErrorMessage(
          "Codex CLI not found. Install it first: npm install -g @openai/codex",
          "Copy Install Command",
        ).then((action) => {
          if (action) vscode.env.clipboard.writeText("npm install -g @openai/codex");
        });
        return;
      }

      const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const userConfigDir = path.join(os.homedir(), ".codex");
      const scopeItems = [
        { label: "Codex (user scope)", description: path.join(userConfigDir, "config.toml"), scope: "user" as const },
        ...(projectDir ? [{ label: "Codex (project scope)", description: path.join(projectDir, ".codex", "config.toml"), scope: "project" as const }] : []),
      ];

      const selectedScope = await vscode.window.showQuickPick(scopeItems, {
        placeHolder: "Select scope for Codex MCP server registration",
      });
      if (!selectedScope) return;

      const configDir = selectedScope.scope === "user"
        ? userConfigDir
        : path.join(projectDir!, ".codex");
      const configFile = path.join(configDir, "config.toml");

      // Codex expects TOML config under [mcp_servers]
      // Use forward slashes in TOML even on Windows (TOML strings, not paths)
      const serverScriptToml = serverScript.replace(/\\/g, "/");
      const mcpBlock = `
[mcp_servers.agent-peers]
command = "node"
args = ["${serverScriptToml}"]
[mcp_servers.agent-peers.env]
AGENT_PEERS_AGENT_TYPE = "codex"
`;

      try {
        if (fs.existsSync(configDir) && !fs.statSync(configDir).isDirectory()) {
          vscode.window.showErrorMessage(
            `Cannot create config directory: "${configDir}" exists as a file. Please remove it manually, then retry.`
          );
          return;
        }
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

        let contents = "";
        if (fs.existsSync(configFile)) {
          contents = fs.readFileSync(configFile, "utf-8");
        }

        // Remove all existing agent-peers entries (main table + sub-tables like .env)
        // Use line-aware pattern: match section header + all following lines that don't start a new section
        contents = contents.replace(/\n*\[mcp_servers\.agent-peers(?:\.[^\]]+)?\][^\n]*(?:\n(?!\[)[^\n]*)*/g, "");
        contents = `${contents.trimEnd()}\n\n${mcpBlock.trim()}\n`;

        fs.writeFileSync(configFile, contents);
        vscode.window.showInformationMessage(`Codex MCP server added to ${configFile}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to configure Codex: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.showDashboard", () => {
      vscode.window.showInformationMessage("Dashboard coming soon!");
    }),

    vscode.commands.registerCommand("agentPeers.toggleAutoStart", async () => {
      const cfg = vscode.workspace.getConfiguration("agentPeers");
      const current = cfg.get<boolean>("autoStartBroker", false);
      await cfg.update("autoStartBroker", !current, vscode.ConfigurationTarget.Global);
      controlProvider.refresh();
    }),

    vscode.commands.registerCommand("agentPeers.toggleAutoDelivery", async () => {
      const cfg = vscode.workspace.getConfiguration("agentPeers");
      const current = cfg.get<boolean>("autoDeliveryMessage", true);
      await cfg.update("autoDeliveryMessage", !current, vscode.ConfigurationTarget.Global);
      controlProvider.refresh();
    }),

    vscode.commands.registerCommand("agentPeers.toggleAutoConflictCheck", async () => {
      const cfg = vscode.workspace.getConfiguration("agentPeers");
      const current = cfg.get<boolean>("autoConflictCheck", true);
      const newValue = !current;
      await cfg.update("autoConflictCheck", newValue, vscode.ConfigurationTarget.Global);
      // Update the running broker in real-time
      await brokerClient.updateConfig({ autoConflictCheck: newValue });
      controlProvider.refresh();
    }),

    vscode.commands.registerCommand("agentPeers.setMaxContextLength", async () => {
      const cfg = vscode.workspace.getConfiguration("agentPeers");
      const current = cfg.get<number>("maxContextLength", 30);
      const input = await vscode.window.showInputBox({
        title: "Max Context Length",
        prompt: "Number of recent conversation exchanges to include in shared context",
        value: String(current),
        validateInput: (v) => {
          const n = parseInt(v, 10);
          return (isNaN(n) || n < 1) ? "Enter a positive integer" : null;
        },
      });
      if (input === undefined) return;
      const newValue = parseInt(input, 10);
      await cfg.update("maxContextLength", newValue, vscode.ConfigurationTarget.Global);
      await brokerClient.updateConfig({ maxContextLength: newValue });
      controlProvider.refresh();
    }),

    vscode.commands.registerCommand("agentPeers.openMessageInEditor", async (item?: MessageViewItem) => {
      if (!item?.text) return;
      const header = item.header ?? [
        `# Message from ${item.fromId ?? "unknown"}`,
        "",
        `- **Type:** ${item.type ?? "text"}`,
        `- **Sent:** ${item.sentAt ?? "unknown"}`,
        item.toId ? `- **To:** ${item.toId}` : "",
        "",
        "---",
        "",
      ].filter(Boolean).join("\n");
      await detailPanelProvider.showMessage({
        title: item.title ?? "Message Detail",
        header,
        text: item.text,
      });
    }),

    vscode.commands.registerCommand("agentPeers.showRepoMemoryDetail", async (item?: MarkdownViewItem) => {
      if (!item?.text) return;
      await detailPanelProvider.showRepoMemory(item);
    }),

    vscode.commands.registerCommand("agentPeers.deleteMessage", async (item?: { messageId?: number; peerId?: string }) => {
      if (!item?.messageId) return;
      try {
        await brokerClient.deleteMessage(item.messageId);
        peerListProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to delete message: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.clearMessages", async (item?: { incomingForPeerId?: string; peerId?: string }) => {
      const peerId = item?.incomingForPeerId ?? item?.peerId;
      if (!peerId) return;
      const confirmation = await vscode.window.showWarningMessage(
        `Clear all messages for peer \"${peerId}\"? This action cannot be undone.`,
        { modal: true },
        "Clear All Messages",
      );
      if (confirmation !== "Clear All Messages") return;
      try {
        await brokerClient.clearMessages(peerId);
        peerListProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to clear messages: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.configConflictHook", async () => {
      const result = configureConflictHook(extensionContext.extensionUri);
      if (result.configured) {
        vscode.window.showInformationMessage("Conflict detection hook configured in ~/.claude/settings.json");
      } else if (result.error) {
        vscode.window.showErrorMessage(`Failed to configure hook: ${result.error}`);
      } else {
        vscode.window.showInformationMessage("Conflict detection hook is already configured.");
      }
    }),

    vscode.commands.registerCommand("agentPeers.openTerminalGrid", () => openTerminalGrid(undefined)),

  );

  // Track broker connection state via WebSocket events
  let brokerConnected = false;
  function setBrokerConnected(connected: boolean) {
    if (connected === brokerConnected) return;
    brokerConnected = connected;
    controlProvider.brokerConnected = connected;
    controlProvider.refresh();
    vscode.commands.executeCommand("setContext", "agentPeers.brokerConnected", connected);
    peerListProvider.refresh();
  }
  vscode.commands.executeCommand("setContext", "agentPeers.brokerConnected", false);

  // React to WebSocket connection state changes
  brokerClient.on("broker-connected", () => {
    setBrokerConnected(true);
    // Register the extension itself as a peer (source="extension", no terminalId)
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    void brokerClient.getGitRoot().then((gitRoot) => {
      void brokerClient.registerPeer("claude-code", process.pid, cwd, gitRoot, "extension", { extHostId });
    });
  });
  brokerClient.on("broker-disconnected", () => {
    setBrokerConnected(false);
  });

  // Periodic health check + timestamp refresh (fallback in case WS events are missed)
  const statusRefreshInterval = setInterval(async () => {
    const h = await brokerClient.health();
    setBrokerConnected(h !== null);
    if (h) {
      peerListProvider.refresh();
    }
  }, 30_000);

  extensionContext.subscriptions.push({
    dispose: () => {
      clearInterval(statusRefreshInterval);
      // Flush any pending batched deliveries immediately
      for (const [key, pending] of pendingDeliveries) {
        clearTimeout(pending.timer);
        pendingDeliveries.delete(key);
      }
      brokerClient.dispose();
    },
  });

  // Connect WebSocket for real-time updates
  brokerClient.connectWs();

  // Auto-start broker if configured, then do initial status check
  if (config.get<boolean>("autoStartBroker", false)) {
    brokerClient.ensureBroker(extensionContext.extensionUri, () => killZombieBroker(brokerPort))
      .catch(() => { /* Broker may already be running, that's fine */ })
      .finally(() => {
        // Initial status check after broker is ready
        brokerClient.health().then((h) => {
          if (h) setBrokerConnected(true);
        });
      });
  } else {
    // Deferred initial status check (WS may not have connected yet)
    setTimeout(async () => {
      const h = await brokerClient.health();
      if (h) setBrokerConnected(true);
    }, 2000);
  }
}

export function deactivate() {
  brokerClient?.dispose();
}
