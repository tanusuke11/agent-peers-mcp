/**
 * Peer List tree view provider
 * Shows all connected AI agent instances with their type, summary, and status
 */

import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";
import type { Peer } from "../../shared/types";

export class PeerListProvider implements vscode.TreeDataProvider<PeerItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PeerItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private client: BrokerClient) {}

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: PeerItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: PeerItem): Promise<PeerItem[]> {
    if (element) {
      // Children of a peer: show detail items
      return element.getDetailItems();
    }

    // Root: fetch all peers
    const peers = await this.client.listPeers("machine");
    if (peers.length === 0) {
      return [new PeerItem("No peers connected", "", "info")];
    }

    return peers.map((p) => new PeerItem(
      `${agentIcon(p.agentType)} ${p.agentType}`,
      p.id,
      "peer",
      p,
    ));
  }
}

function agentIcon(agentType: string): string {
  switch (agentType) {
    case "claude-code": return "🟠";
    case "codex": return "🟢";
    case "copilot-chat": return "🔵";
    case "cursor": return "🟣";
    default: return "⚪";
  }
}

class PeerItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly peerId: string,
    private itemType: "peer" | "info" | "detail",
    public readonly peer?: Peer,
  ) {
    super(
      label,
      itemType === "peer"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    if (itemType === "peer" && peer) {
      this.description = peer.context.summary || peer.cwd;
      this.tooltip = new vscode.MarkdownString(this.buildTooltip(peer));
      this.contextValue = "peer";
      this.iconPath = new vscode.ThemeIcon("person");
    } else if (itemType === "info") {
      this.iconPath = new vscode.ThemeIcon("info");
    } else {
      this.iconPath = new vscode.ThemeIcon("dash");
    }
  }

  getDetailItems(): PeerItem[] {
    if (!this.peer) return [];
    const p = this.peer;
    const items: PeerItem[] = [];

    items.push(new PeerItem(`ID: ${p.id}`, "", "detail"));
    items.push(new PeerItem(`PID: ${p.pid}`, "", "detail"));
    items.push(new PeerItem(`CWD: ${p.cwd}`, "", "detail"));

    if (p.context.summary) {
      items.push(new PeerItem(`Summary: ${p.context.summary}`, "", "detail"));
    }
    if (p.context.currentTask) {
      items.push(new PeerItem(`Task: ${p.context.currentTask}`, "", "detail"));
    }
    if (p.context.git?.branch) {
      items.push(new PeerItem(`Branch: ${p.context.git.branch}`, "", "detail"));
    }
    if (p.context.activeFiles?.length) {
      items.push(new PeerItem(
        `Files: ${p.context.activeFiles.map((f) => f.relativePath || f.path).join(", ")}`,
        "", "detail",
      ));
    }
    if (p.context.git?.modifiedFiles?.length) {
      items.push(new PeerItem(
        `Modified: ${p.context.git.modifiedFiles.length} files`,
        "", "detail",
      ));
    }

    return items;
  }

  private buildTooltip(p: Peer): string {
    const parts = [
      `**${p.agentType}** — \`${p.id}\``,
      `- CWD: \`${p.cwd}\``,
    ];
    if (p.context.summary) parts.push(`- Summary: ${p.context.summary}`);
    if (p.context.currentTask) parts.push(`- Task: ${p.context.currentTask}`);
    if (p.context.git?.branch) parts.push(`- Branch: \`${p.context.git.branch}\``);
    if (p.context.activeFiles?.length) {
      parts.push(`- Active files: ${p.context.activeFiles.map((f) => `\`${f.relativePath}\``).join(", ")}`);
    }
    parts.push(`- Last seen: ${p.lastSeen}`);
    return parts.join("\n");
  }
}
