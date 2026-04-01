/**
 * Shared Context tree view provider
 * Shows structured context from all peers: active files, git state, tasks
 */

import * as path from "path";
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

    const projectName = vscode.workspace.workspaceFolders?.[0]?.name ?? "current project";
    const peers = await this.client.listPeers("repo");

    const contextPeers = peers
      .filter((p) => p.connected !== false)
      .filter((p) => isInformativeSummary(p.context.summary, p) || p.context.activeFiles?.length || p.context.git);

    const header = ContextItem.projectHeader(projectName, peers.length);
    return [header, ...contextPeers.map((p) => this.buildPeerContextItem(p))];
  }

  private buildPeerContextItem(peer: Peer): ContextItem {
    const label = `${agentIcon(peer.agentType)} ${peer.agentType} (${peer.id})`;
    const color = agentColor(peer.agentType);
    const item = new ContextItem(label, "symbol-namespace", color);
    const summary = isInformativeSummary(peer.context.summary, peer) ? peer.context.summary! : "";
    item.description = summary;
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

    const children: ContextItem[] = [];

    if (summary) {
      children.push(new ContextItem(
        summary, "note", new vscode.ThemeColor("charts.green"),
      ));
    }

    if (peer.context.currentTask) {
      children.push(new ContextItem(
        `Task: ${peer.context.currentTask}`, "target", new vscode.ThemeColor("charts.red"),
      ));
    }

    if (peer.context.git) {
      const git = peer.context.git;
      const gitItem = new ContextItem(
        `Git: ${git.branch ?? "detached"}`, "git-branch", new vscode.ThemeColor("charts.purple"),
      );
      gitItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      const gitChildren: ContextItem[] = [];

      // Show only files changed by this agent (exclude pre-existing modifications)
      const baseline = new Set(git.baselineModifiedFiles ?? []);
      const agentModified = (git.modifiedFiles ?? []).filter((f) => !baseline.has(f));
      if (agentModified.length) {
        for (const f of agentModified.slice(0, 10)) {
          gitChildren.push(new ContextItem(f, "diff-modified", new vscode.ThemeColor("charts.yellow")));
        }
        if (agentModified.length > 10) {
          gitChildren.push(new ContextItem(`... and ${agentModified.length - 10} more`, "ellipsis"));
        }
      }
      if (git.stagedFiles?.length) {
        for (const f of git.stagedFiles.slice(0, 10)) {
          gitChildren.push(new ContextItem(f, "diff-added", new vscode.ThemeColor("charts.green")));
        }
      }
      if (git.recentCommits?.length) {
        const commitsItem = new ContextItem(
          "Recent commits", "git-commit", new vscode.ThemeColor("charts.foreground"),
        );
        commitsItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        commitsItem.children = git.recentCommits.map((c) =>
          new ContextItem(c, "circle-small-filled", new vscode.ThemeColor("charts.foreground")),
        );
        gitChildren.push(commitsItem);
      }

      gitItem.children = gitChildren;
      children.push(gitItem);
    }

    if (peer.context.activeFiles?.length) {
      const filesItem = new ContextItem(
        `Active files (${peer.context.activeFiles.length})`, "folder-opened", new vscode.ThemeColor("charts.orange"),
      );
      filesItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      filesItem.children = peer.context.activeFiles.map((f) =>
        new ContextItem(
          `${f.relativePath || f.path}${f.isDirty ? " •" : ""}`,
          "file",
          new vscode.ThemeColor("charts.blue"),
        ),
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
    default: return "⚪";
  }
}

/** Returns true if summary is a real work description, not a placeholder/default. */
function isInformativeSummary(summary: string | undefined, peer: Peer): boolean {
  if (!summary) return false;
  const trimmed = summary.trim();
  if (!trimmed || trimmed === "Untitled") return false;
  const defaults = new Set<string>([path.basename(peer.cwd)]);
  if (peer.gitRoot) defaults.add(path.basename(peer.gitRoot));
  return !defaults.has(trimmed);
}

function agentColor(agentType: string): vscode.ThemeColor {
  switch (agentType) {
    case "claude-code": return new vscode.ThemeColor("charts.orange");
    case "codex": return new vscode.ThemeColor("charts.green");
    default: return new vscode.ThemeColor("charts.foreground");
  }
}

class ContextItem extends vscode.TreeItem {
  children?: ContextItem[];

  static projectHeader(projectName: string, peerCount: number): ContextItem {
    const item = new ContextItem(projectName, "root-folder", new vscode.ThemeColor("charts.blue"));
    item.description = `${peerCount} peer${peerCount !== 1 ? "s" : ""}`;
    item.contextValue = "projectHeader";
    return item;
  }

  constructor(label: string, iconId: string, iconColor?: vscode.ThemeColor) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId, iconColor);
  }
}
