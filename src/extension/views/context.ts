/**
 * Shared Context tree view provider
 * Shows structured context from all peers: active files, git state, tasks
 */

import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";
import type { Peer } from "../../shared/types";

export class ContextProvider implements vscode.TreeDataProvider<ContextItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ContextItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private client: BrokerClient) {}

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: ContextItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: ContextItem): Promise<ContextItem[]> {
    if (element) {
      return element.children ?? [];
    }

    const peers = await this.client.listPeers("machine");
    if (peers.length === 0) {
      return [new ContextItem("No peers sharing context", "info")];
    }

    return peers
      .filter((p) => p.context.summary || p.context.activeFiles?.length || p.context.git)
      .map((p) => this.buildPeerContextItem(p));
  }

  private buildPeerContextItem(peer: Peer): ContextItem {
    const label = `${agentIcon(peer.agentType)} ${peer.agentType} (${peer.id})`;
    const item = new ContextItem(label, "peer-context");
    item.description = peer.context.summary || "";
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

    const children: ContextItem[] = [];

    // Summary
    if (peer.context.summary) {
      const s = new ContextItem(`📝 ${peer.context.summary}`, "detail");
      children.push(s);
    }

    // Current task
    if (peer.context.currentTask) {
      const t = new ContextItem(`🎯 Task: ${peer.context.currentTask}`, "detail");
      children.push(t);
    }

    // Git info
    if (peer.context.git) {
      const git = peer.context.git;
      const gitItem = new ContextItem(`🔀 Git: ${git.branch ?? "detached"}`, "git");
      gitItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      const gitChildren: ContextItem[] = [];

      if (git.modifiedFiles?.length) {
        for (const f of git.modifiedFiles.slice(0, 10)) {
          gitChildren.push(new ContextItem(`  M ${f}`, "file-modified"));
        }
        if (git.modifiedFiles.length > 10) {
          gitChildren.push(new ContextItem(`  ... and ${git.modifiedFiles.length - 10} more`, "detail"));
        }
      }
      if (git.stagedFiles?.length) {
        for (const f of git.stagedFiles.slice(0, 10)) {
          gitChildren.push(new ContextItem(`  S ${f}`, "file-staged"));
        }
      }
      if (git.recentCommits?.length) {
        const commitsItem = new ContextItem("Recent commits", "commits");
        commitsItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        commitsItem.children = git.recentCommits.map((c) => new ContextItem(`  ${c}`, "detail"));
        gitChildren.push(commitsItem);
      }

      gitItem.children = gitChildren;
      children.push(gitItem);
    }

    // Active files
    if (peer.context.activeFiles?.length) {
      const filesItem = new ContextItem(`📂 Active files (${peer.context.activeFiles.length})`, "files");
      filesItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      filesItem.children = peer.context.activeFiles.map((f) =>
        new ContextItem(`  ${f.relativePath || f.path}${f.isDirty ? " •" : ""}`, "file"),
      );
      children.push(filesItem);
    }

    item.children = children;
    return item;
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

class ContextItem extends vscode.TreeItem {
  children?: ContextItem[];

  constructor(
    label: string,
    private itemType: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    switch (itemType) {
      case "info":
        this.iconPath = new vscode.ThemeIcon("info");
        break;
      case "peer-context":
        this.iconPath = new vscode.ThemeIcon("symbol-namespace");
        break;
      case "git":
        this.iconPath = new vscode.ThemeIcon("git-branch");
        break;
      case "file-modified":
        this.iconPath = new vscode.ThemeIcon("diff-modified");
        break;
      case "file-staged":
        this.iconPath = new vscode.ThemeIcon("diff-added");
        break;
      case "file":
        this.iconPath = new vscode.ThemeIcon("file");
        break;
      case "files":
        this.iconPath = new vscode.ThemeIcon("folder-opened");
        break;
      case "commits":
        this.iconPath = new vscode.ThemeIcon("git-commit");
        break;
      default:
        break;
    }
  }
}
