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
import { MessagesProvider } from "./views/messages";
import { ContextProvider } from "./views/context";

let brokerClient: BrokerClient;

export function activate(extensionContext: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("agentPeers");
  const brokerPort = config.get<number>("brokerPort", 7899);
  const wsPort = brokerPort + 1; // Convention: WS port = HTTP port + 1

  // Initialize broker client
  brokerClient = new BrokerClient(brokerPort, wsPort);

  // Initialize tree data providers
  const peerListProvider = new PeerListProvider(brokerClient);
  const messagesProvider = new MessagesProvider(brokerClient);
  const contextProvider = new ContextProvider(brokerClient);

  // Register tree views
  extensionContext.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentPeers.peerList", peerListProvider),
    vscode.window.registerTreeDataProvider("agentPeers.messages", messagesProvider),
    vscode.window.registerTreeDataProvider("agentPeers.context", contextProvider),
  );

  // Listen to real-time events
  brokerClient.on("peer-joined", () => peerListProvider.refresh());
  brokerClient.on("peer-left", () => peerListProvider.refresh());
  brokerClient.on("message", () => messagesProvider.refresh());
  brokerClient.on("context-updated", () => {
    peerListProvider.refresh();
    contextProvider.refresh();
  });

  // Register commands
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand("agentPeers.refreshPeers", () => {
      peerListProvider.refresh();
      messagesProvider.refresh();
      contextProvider.refresh();
    }),

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
      const terminal = vscode.window.createTerminal("Agent Peers Broker");
      terminal.sendText("bun " + vscode.Uri.joinPath(extensionContext.extensionUri, "src", "broker", "index.ts").fsPath);
      terminal.show();
      vscode.window.showInformationMessage("Broker daemon starting...");
    }),

    vscode.commands.registerCommand("agentPeers.showDashboard", () => {
      vscode.window.showInformationMessage("Dashboard coming soon!");
    }),
  );

  // Auto-refresh periodically
  const refreshInterval = setInterval(() => {
    peerListProvider.refresh();
  }, 5000);

  extensionContext.subscriptions.push({
    dispose: () => {
      clearInterval(refreshInterval);
      brokerClient.dispose();
    },
  });

  // Connect WebSocket for real-time updates
  brokerClient.connectWs();

  // Auto-start broker if configured
  if (config.get<boolean>("autoStartBroker", true)) {
    brokerClient.ensureBroker(extensionContext.extensionUri).catch(() => {
      // Broker may already be running, that's fine
    });
  }

  vscode.window.showInformationMessage("Agent Peers activated");
}

export function deactivate() {
  brokerClient?.dispose();
}
