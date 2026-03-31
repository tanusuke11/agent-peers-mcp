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

let brokerClient: BrokerClient;

export function activate(extensionContext: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("agentPeers");
  const brokerPort = config.get<number>("brokerPort", 7899);
  const wsPort = brokerPort + 1; // Convention: WS port = HTTP port + 1

  // Initialize broker client
  brokerClient = new BrokerClient(brokerPort, wsPort);

  // Initialize tree data providers
  const controlProvider = new ControlProvider(brokerClient);
  const peerListProvider = new PeerListProvider(brokerClient);
  // Register tree views
  extensionContext.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentPeers.control", controlProvider),
    vscode.window.registerTreeDataProvider("agentPeers.peerList", peerListProvider),
  );

  // Listen to real-time events
  brokerClient.on("peer-joined", () => peerListProvider.refresh());
  brokerClient.on("peer-left", () => peerListProvider.refresh());
  brokerClient.on("context-updated", () => {
    peerListProvider.refresh();
  });

  // Register commands
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand("agentPeers.sendMessage", async () => {
      const peers = await brokerClient.listPeers("machine");
      if (peers.length === 0) {
        vscode.window.showInformationMessage("No peers found on this machine.");
        return;
      }

      const items = peers.map((p) => ({
        label: `${p.agentType} — ${p.id}`,
        description: p.context.summary || p.cwd,
        detail: `CWD: ${p.cwd}${p.context.git?.branch ? ` | Branch: ${p.context.git.branch}` : ""}`,
        peerId: p.id,
      }));

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
      const health = await brokerClient.health();
      if (health) {
        vscode.window.showInformationMessage(`Agent Peers broker is already running (${health.peerCount} peers).`);
        return;
      }
      const brokerPath = vscode.Uri.joinPath(extensionContext.extensionUri, "out", "broker", "index.js").fsPath;
      const { spawn } = require("child_process") as typeof import("child_process");
      const proc = spawn("node", [brokerPath], { stdio: "ignore", detached: true });
      proc.unref();
      vscode.window.showInformationMessage("Agent Peers broker starting...");
      // WS reconnect will detect the broker automatically
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
        try { process.kill(brokerPid, "SIGKILL"); } catch { /* already dead */ }
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

      const confirm = await vscode.window.showWarningMessage(
        `Suspend peer "${peerId}" from context sharing?\n\nThe peer's shared context will be cleared. The session itself will remain active.`,
        { modal: true },
        "Suspend",
      );
      if (confirm !== "Suspend") return;

      try {
        await brokerClient.suspendPeer(peerId);
        vscode.window.showInformationMessage(`Peer "${peerId}" suspended. Shared context cleared.`);
        peerListProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to suspend peer: ${e}`);
      }
    }),

    vscode.commands.registerCommand("agentPeers.connectPeer", async (item?: { peerId?: string; peer?: { id: string } }) => {
      const peerId = item?.peerId || item?.peer?.id;
      if (!peerId) {
        vscode.window.showWarningMessage("No peer selected.");
        return;
      }

      try {
        await brokerClient.resumePeer(peerId);
        vscode.window.showInformationMessage(`Peer "${peerId}" resumed. Context sharing is active again.`);
        peerListProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to resume peer: ${e}`);
      }
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
    }),

    vscode.commands.registerCommand("agentPeers.addMcpServerCodex", async () => {
      const serverScript = vscode.Uri.joinPath(extensionContext.extensionUri, "out", "server", "index.js").fsPath;
      const { exec } = require("child_process") as typeof import("child_process");
      const os = require("os") as typeof import("os");
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
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
  brokerClient.on("broker-connected", () => setBrokerConnected(true));
  brokerClient.on("broker-disconnected", () => setBrokerConnected(false));

  // Periodic health check + timestamp refresh (fallback in case WS events are missed)
  const statusRefreshInterval = setInterval(async () => {
    const h = await brokerClient.health();
    setBrokerConnected(h !== null);
    if (h) peerListProvider.refresh();
  }, 30_000);

  extensionContext.subscriptions.push({
    dispose: () => {
      clearInterval(statusRefreshInterval);
      brokerClient.dispose();
    },
  });

  // Connect WebSocket for real-time updates
  brokerClient.connectWs();

  // Auto-start broker if configured, then do initial status check
  if (config.get<boolean>("autoStartBroker", false)) {
    brokerClient.ensureBroker(extensionContext.extensionUri)
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
