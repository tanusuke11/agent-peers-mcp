/**
 * Memory tree view provider
 * Shows repo-level shared memory entries grouped by project (git root) and category.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";
import type { Peer, RepoMemory } from "../../shared/types";

const CATEGORY_ICONS: Record<string, { icon: string; color: string }> = {
  "task": { icon: "tasklist", color: "charts.blue" },
  "issue": { icon: "bug", color: "charts.orange" },
  "architecture": { icon: "symbol-structure", color: "charts.purple" },
};

export class MemoryProvider implements vscode.TreeDataProvider<MemoryItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MemoryItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private client: BrokerClient) {}

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: MemoryItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: MemoryItem): Promise<MemoryItem[]> {
    if (element) {
      if (element.gitRootForLoad) {
        return this.loadRepoMemories(element.gitRootForLoad);
      }
      return element.children ?? [];
    }

    // Top level: list one project group per git root that has registered peers
    const workspaceGitRoot = await this.client.getGitRoot();
    const peers = await this.client.listPeers("machine");

    const groups = new Map<string, { label: string; isLocal: boolean; gitRoot: string }>();
    for (const p of peers) {
      const gitRoot = p.gitRoot;
      if (!gitRoot) continue;
      if (groups.has(gitRoot)) continue;
      const dirName = path.basename(gitRoot) || gitRoot;
      groups.set(gitRoot, { label: dirName, isLocal: gitRoot === workspaceGitRoot, gitRoot });
    }

    if (groups.size === 0) {
      return [MemoryItem.info("No repositories with peers yet")];
    }

    // Sort: local repo first, then alphabetical
    const sorted = [...groups.values()].sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    return sorted.map((g) => MemoryItem.projectHeader(g.label, g.gitRoot));
  }

  private async loadRepoMemories(gitRoot: string): Promise<MemoryItem[]> {
    try {
      const memories = await this.client.listRepoMemories(gitRoot, undefined, 30);
      if (memories.length === 0) {
        return [MemoryItem.info("No memories yet")];
      }

      const byCategory = new Map<string, RepoMemory[]>();
      for (const m of memories) {
        const list = byCategory.get(m.category) ?? [];
        list.push(m);
        byCategory.set(m.category, list);
      }

      const items: MemoryItem[] = [];
      for (const [category, mems] of byCategory) {
        const cfg = CATEGORY_ICONS[category] ?? { icon: "note", color: "charts.foreground" };
        const catItem = new MemoryItem(
          `${category} (${mems.length})`,
          cfg.icon,
          new vscode.ThemeColor(cfg.color),
        );
        catItem.id = `memory:${gitRoot}:cat:${category}`;
        catItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        catItem.children = mems.map((m) => {
          const item = new MemoryItem(m.title, cfg.icon, new vscode.ThemeColor(cfg.color));
          item.id = `memory:${gitRoot}:${m.id}`;
          item.description = m.sourcePeerId ?? undefined;
          item.tooltip = new vscode.MarkdownString(
            `**[${m.category}] ${m.title}**\n\n${m.content}\n\n` +
              (m.files.length ? `Files: ${m.files.join(", ")}\n\n` : "") +
              `By: ${m.sourcePeerId ?? "unknown"} · ${m.updatedAt}`,
          );
          item.command = {
            command: "agentPeers.showRepoMemoryDetail",
            title: "Show Repo Memory Detail",
            arguments: [{
              title: `Memory #${m.id}: ${m.title}`,
              header: [
                `# Repo Memory #${m.id}`,
                "",
                `- **Category:** ${m.category}`,
                `- **By:** ${m.sourcePeerId ?? "unknown"}`,
                `- **Created:** ${m.createdAt}`,
                `- **Updated:** ${m.updatedAt}`,
                m.files.length ? `- **Files:** ${m.files.join(", ")}` : "",
                m.areas.length ? `- **Areas:** ${m.areas.join(", ")}` : "",
                "",
                "---",
                "",
              ].filter(Boolean).join("\n"),
              text: m.content,
            }],
          };
          return item;
        });
        items.push(catItem);
      }
      return items;
    } catch {
      return [MemoryItem.info("Failed to load memories", "warning", "charts.red")];
    }
  }
}

class MemoryItem extends vscode.TreeItem {
  children?: MemoryItem[];
  /** When set, getChildren will lazily fetch repo memories for this git root */
  gitRootForLoad?: string;

  static projectHeader(projectName: string, gitRoot: string): MemoryItem {
    const item = new MemoryItem(projectName, "root-folder", new vscode.ThemeColor("charts.blue"));
    item.id = `memory-project:${gitRoot}`;
    item.contextValue = "memoryProjectHeader";
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    item.gitRootForLoad = gitRoot;
    return item;
  }

  static info(label: string, iconId = "info", colorId = "charts.foreground"): MemoryItem {
    return new MemoryItem(label, iconId, new vscode.ThemeColor(colorId));
  }

  constructor(label: string, iconId?: string, iconColor?: vscode.ThemeColor) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (iconId) {
      this.iconPath = new vscode.ThemeIcon(iconId, iconColor);
    }
  }
}
