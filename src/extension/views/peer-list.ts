/**
 * Peer List tree view provider
 * Shows all connected AI agent instances with their type, summary, and status.
 * Includes inline context: git state (with modified/staged file trees), active files, etc.
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
      return element.children ?? [];
    }

    const workspaceGitRoot = await this.client.getGitRoot();
    const peers = await this.client.listPeers("machine");

    // Group peers by git root (or cwd if no git root)
    const groups = new Map<string, { label: string; isLocal: boolean; peers: Peer[] }>();
    for (const p of peers) {
      const key = p.gitRoot ?? p.cwd;
      if (!groups.has(key)) {
        const dirName = key.split("/").pop() || key;
        groups.set(key, { label: dirName, isLocal: key === workspaceGitRoot, peers: [] });
      }
      groups.get(key)!.peers.push(p);
    }

    // Sort groups: local repo first, then alphabetical
    const sortedGroups = [...groups.entries()].sort(([, a], [, b]) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    const items: PeerItem[] = [];
    for (const [, group] of sortedGroups) {
      items.push(PeerItem.projectHeader(group.label, group.peers.length));
      const sorted = group.peers
        .map((p) => {
          const displayType = agentDisplayName(p.agentType);
          const label = p.suspended
            ? `${displayType} (${p.id})`
            : `${agentEmoji(p.agentType)} ${displayType} (${animalEmoji(p.id)}${p.id})`;
          return new PeerItem(label, p.id, "peer", p);
        })
        .sort((a, b) => {
          const rank = (p: Peer | undefined) => (p?.suspended ? 2 : 1);
          return rank(a.peer) - rank(b.peer);
        });
      items.push(...sorted);
    }

    return items;
  }
}


const ANIMAL_EMOJI: Record<string, string> = {
  ant: "🐜", bat: "🦇", bear: "🐻", bee: "🐝", bird: "🐦",
  bull: "🐂", butterfly: "🦋", cat: "🐱", cobra: "🐍", cow: "🐄",
  crab: "🦀", crane: "🦢", crocodile: "🐊", crow: "🐦‍⬛", deer: "🦌",
  dog: "🐶", dolphin: "🐬", dove: "🕊️", duck: "🦆", eagle: "🦅",
  elephant: "🐘", elk: "🫎", falcon: "🦅", fish: "🐟", fox: "🦊",
  frog: "🐸", giraffe: "🦒", goat: "🐐", gorilla: "🦍", hawk: "🦅",
  heron: "🦢", hippo: "🦛", horse: "🐴", ibis: "🦤", jaguar: "🐆",
  kangaroo: "🦘", koala: "🐨", lemur: "🐒", leopard: "🐆", lion: "🦁",
  lizard: "🦎", lobster: "🦞", lynx: "🐱", monkey: "🐒", moose: "🫎",
  octopus: "🐙", owl: "🦉", panda: "🐼", parrot: "🦜", penguin: "🐧",
  pig: "🐷", rabbit: "🐰", raccoon: "🦝", ram: "🐏", raven: "🐦‍⬛",
  rhino: "🦏", seal: "🦭", shark: "🦈", sheep: "🐑", sloth: "🦥",
  snake: "🐍", sparrow: "🐦", swan: "🦢", tiger: "🐯", turtle: "🐢",
  walrus: "🦭", whale: "🐋", wolf: "🐺", wombat: "🦘", zebra: "🦓",
};

function animalEmoji(id: string): string {
  const key = id.toLowerCase().split(/[-_\s]/)[0] ?? "";
  return ANIMAL_EMOJI[key] ?? "🐾";
}

function agentDisplayName(agentType: string): string {
  switch (agentType) {
    case "claude-code": return "claude";
    default: return agentType;
  }
}

function agentEmoji(agentType: string): string {
  switch (agentType) {
    case "claude-code": return "🟠";
    case "codex": return "🟢";
    default: return "⚪";
  }
}

function agentColor(agentType: string): vscode.ThemeColor {
  switch (agentType) {
    case "claude-code": return new vscode.ThemeColor("charts.orange");
    case "codex": return new vscode.ThemeColor("charts.green");
    default: return new vscode.ThemeColor("charts.foreground");
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const DIM_COLOR = new vscode.ThemeColor("disabledForeground");

/** Build the nested context item tree for a peer (detail rows + git/file sub-trees). */
function buildContextItems(peer: Peer): PeerItem[] {
  const isSuspended = !!peer.suspended;
  const dim = isSuspended ? DIM_COLOR : undefined;
  const items: PeerItem[] = [];

  items.push(detail(`PID: ${peer.pid}`, "terminal", dim ?? new vscode.ThemeColor("charts.foreground")));
  items.push(detail(peer.cwd, "folder", dim ?? new vscode.ThemeColor("charts.blue")));

  if (!isSuspended) {
    if (peer.context.currentTask) {
      items.push(detail(peer.context.currentTask, "target", new vscode.ThemeColor("charts.red")));
    }

    if (peer.context.git) {
      const git = peer.context.git;
      const gitItem = detail(
        `Git: ${git.branch ?? "detached"}`,
        "git-branch",
        new vscode.ThemeColor("charts.purple"),
      );

      const gitChildren: PeerItem[] = [];
      // Show only files changed by this agent (exclude pre-existing modifications)
      const baseline = new Set(git.baselineModifiedFiles ?? []);
      const agentModified = (git.modifiedFiles ?? []).filter((f) => !baseline.has(f));
      if (agentModified.length) {
        for (const f of agentModified) {
          gitChildren.push(detail(f, "diff-modified", new vscode.ThemeColor("charts.yellow")));
        }
      }
      if (git.stagedFiles?.length) {
        for (const f of git.stagedFiles) {
          gitChildren.push(detail(f, "diff-added", new vscode.ThemeColor("charts.green")));
        }
      }

      if (gitChildren.length > 0) {
        gitItem.children = gitChildren;
        gitItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      }
      items.push(gitItem);
    } else {
      // Keep indentation aligned even when the peer isn't inside a git repo
      items.push(detail("Git: (not a repo)", "git-branch", dim ?? new vscode.ThemeColor("charts.foreground")));
    }

    if (peer.context.activeFiles?.length) {
      const filesItem = detail(
        `Active files (${peer.context.activeFiles.length})`,
        "folder-opened",
        new vscode.ThemeColor("charts.orange"),
      );
      filesItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      filesItem.children = peer.context.activeFiles.map((f) =>
        detail(
          `${f.relativePath || f.path}${f.isDirty ? " •" : ""}`,
          "file",
          new vscode.ThemeColor("charts.blue"),
        ),
      );
      items.push(filesItem);
    }
  }

  return items;
}

/** Shorthand: create a leaf/branch detail PeerItem. */
function detail(label: string, iconId: string, iconColor?: vscode.ThemeColor): PeerItem {
  return new PeerItem(label, "", "detail", undefined, iconId, iconColor);
}

class PeerItem extends vscode.TreeItem {
  children?: PeerItem[];

  static projectHeader(projectName: string, peerCount: number): PeerItem {
    const item = new PeerItem(projectName, "", "header");
    item.description = `${peerCount} peer${peerCount !== 1 ? "s" : ""}`;
    item.iconPath = new vscode.ThemeIcon("root-folder", new vscode.ThemeColor("charts.blue"));
    item.contextValue = "projectHeader";
    return item;
  }

  constructor(
    label: string,
    public readonly peerId: string,
    private itemType: "peer" | "info" | "detail" | "header",
    public readonly peer?: Peer,
    iconId?: string,
    iconColor?: vscode.ThemeColor,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    if (itemType === "peer" && peer) {
      const isSuspended = !!peer.suspended;
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

      if (isSuspended) {
        this.description = "(suspended)";
        this.contextValue = "peerSuspended";
        this.iconPath = new vscode.ThemeIcon("circle-outline", DIM_COLOR);
      } else {
        const summary = peer.context.summary && peer.context.summary !== "Untitled" ? peer.context.summary : "";
        const ago = relativeTime(peer.context.updatedAt || peer.registeredAt);
        this.description = summary ? `${summary} · ${ago}` : ago;
        this.contextValue = "peerActive";
      }
      this.tooltip = new vscode.MarkdownString(this.buildTooltip(peer));
      this.children = buildContextItems(peer);
    } else if (itemType === "info") {
      this.iconPath = new vscode.ThemeIcon("info");
    } else if (iconId) {
      this.iconPath = new vscode.ThemeIcon(iconId, iconColor);
    } else {
      this.iconPath = new vscode.ThemeIcon("dash");
    }
  }

  // Kept for backwards-compat; callers should prefer .children directly.
  getDetailItems(): PeerItem[] {
    return this.children ?? [];
  }

  private buildTooltip(p: Peer): string {
    const parts = [
      `**${p.agentType}** — \`${p.id}\``,
      `- Status: ${p.suspended ? "Suspended" : "Active"}`,
      `- CWD: \`${p.cwd}\``,
    ];
    if (p.context.summary) parts.push(`- Summary: ${p.context.summary}`);
    if (p.context.currentTask) parts.push(`- Task: ${p.context.currentTask}`);
    if (p.context.git?.branch) parts.push(`- Branch: \`${p.context.git.branch}\``);
    if (p.context.activeFiles?.length) {
      parts.push(`- Active files: ${p.context.activeFiles.map((f) => `\`${f.relativePath}\``).join(", ")}`);
    }
    if (p.context.git?.modifiedFiles?.length) {
      parts.push(`- Modified: ${p.context.git.modifiedFiles.length} files`);
    }
    parts.push(`- Last seen: ${p.lastSeen}`);
    return parts.join("\n");
  }
}
