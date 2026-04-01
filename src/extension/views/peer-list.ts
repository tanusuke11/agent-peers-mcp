/**
 * Peer List tree view provider
 * Shows all connected AI agent instances with their type, summary, and status.
 * Includes inline context: git state (with modified/staged file trees), active files, etc.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";
import type { Peer, Message } from "../../shared/types";

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
      // Lazily load report items when a "reports" node is expanded
      if (element.reportsForPeerId) {
        const reports = await this.client.listReports(element.reportsForPeerId);
        return reports.map((r) => {
          const preview = r.text.length > 80 ? r.text.slice(0, 80) + "…" : r.text;
          const item = leaf(`${r.fromId}: ${preview}`, undefined, "mail-read", new vscode.ThemeColor("charts.green"));
          item.tooltip = `[report] from ${r.fromId}\nSent: ${r.sentAt}\n\n${r.text}`;
          return item;
        });
      }
      // Lazily load unread message items when a "messages" node is expanded
      if (element.messagesForPeerId) {
        const messages = await this.client.peekMessages(element.messagesForPeerId);
        return messages.map((m) => {
          const preview = m.text.length > 80 ? m.text.slice(0, 80) + "…" : m.text;
          const icon = m.type === "task-handoff" ? "arrow-swap" : "comment";
          const color = m.type === "task-handoff"
            ? new vscode.ThemeColor("charts.red")
            : new vscode.ThemeColor("charts.blue");
          const item = leaf(`${m.fromId}: ${preview}`, undefined, icon, color);
          item.tooltip = `[${m.type}] from ${m.fromId}\nSent: ${m.sentAt}\n\n${m.text}`;
          return item;
        });
      }
      return element.children ?? [];
    }

    const workspaceGitRoot = await this.client.getGitRoot();
    const peers = await this.client.listPeers("machine");

    // Group peers by git root (or cwd if no git root)
    const groups = new Map<string, { label: string; isLocal: boolean; peers: Peer[] }>();
    for (const p of peers) {
      const key = p.gitRoot ?? p.cwd;
      if (!groups.has(key)) {
        const dirName = path.basename(key) || key;
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
      const header = PeerItem.projectHeader(group.label, group.peers.length);
      header.children = group.peers
        .map((p) => {
          const displayType = agentDisplayName(p.agentType);
          const tag = sourceTag(p.source);
          const label = p.suspended
            ? `${displayType} (${p.id})${tag}`
            : `${agentEmoji(p.agentType)} ${displayType} (${animalEmoji(p.id)}${p.id})${tag}`;
          return new PeerItem(label, p.id, "peer", p);
        })
        .sort((a, b) => {
          const rank = (p: Peer | undefined) => (p?.suspended ? 2 : 1);
          return rank(a.peer) - rank(b.peer);
        });
      items.push(header);
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

function sourceTag(source: string | undefined): string {
  return source === "extension" ? " [ext]" : " [term]";
}

function defaultTitles(peer: Peer): Set<string> {
  const titles = new Set<string>([path.basename(peer.cwd), "Untitled"]);
  if (peer.gitRoot) titles.add(path.basename(peer.gitRoot));
  return titles;
}

function isInformativeSummary(summary: string | undefined, peer: Peer): boolean {
  if (!summary) return false;
  const trimmed = summary.trim();
  if (!trimmed) return false;
  return !defaultTitles(peer).has(trimmed);
}

/**
 * Returns true if the peer's context was updated recently (within `thresholdMs`).
 * Uses `context.updatedAt` as the primary signal (set when the agent shares new context),
 * falling back to `lastSeen` (heartbeat timestamp).
 */
function isRecentlyActive(peer: Peer, thresholdMs: number): boolean {
  const ts = peer.context.updatedAt || peer.lastSeen;
  if (!ts) return false;
  const age = Date.now() - new Date(ts).getTime();
  return age < thresholdMs;
}

function preferredConversationCue(peer: Peer): string | undefined {
  const digest = peer.context.conversationDigest?.trim();
  const summary = peer.context.summary?.trim();
  if (digest && digest !== summary) return digest;
  return undefined;
}

function formatPeerDescription(peer: Peer): string {
  const parts: string[] = [];
  const task = peer.context.currentTask?.trim();
  const summary = peer.context.summary?.trim();

  if (task) parts.push(`🎯 ${task}`);

  if (isInformativeSummary(summary, peer)) {
    parts.push(summary!);
  } else {
    const digest = preferredConversationCue(peer);
    if (digest) parts.push(digest);
  }

  return parts.join(" · ");
}


const DIM_COLOR = new vscode.ThemeColor("disabledForeground");

/** Build the nested context item tree for a peer (detail rows + git/file sub-trees). */
function buildContextItems(peer: Peer): PeerItem[] {
  const isSuspended = !!peer.suspended;
  const dim = isSuspended ? DIM_COLOR : undefined;
  const items: PeerItem[] = [];

  items.push(leaf("PID", String(peer.pid), "terminal", dim ?? new vscode.ThemeColor("charts.foreground")));
  items.push(leaf("Dir", peer.cwd, "folder", dim ?? new vscode.ThemeColor("charts.blue")));

  if (!isSuspended) {
    if (peer.context.currentTask) {
      items.push(leaf(peer.context.currentTask, undefined, "target", new vscode.ThemeColor("charts.red")));
    }

    if (peer.context.git) {
      const git = peer.context.git;
      const gitItem = leaf("Git", git.branch ?? "detached", "git-branch", new vscode.ThemeColor("charts.purple"));

      const gitChildren: PeerItem[] = [];
      // Show only files changed by this agent (exclude pre-existing modifications)
      const baseline = new Set(git.baselineModifiedFiles ?? []);
      const agentModified = (git.modifiedFiles ?? []).filter((f) => !baseline.has(f));
      for (const f of agentModified) {
        gitChildren.push(leaf(f, undefined, "diff-modified", new vscode.ThemeColor("charts.yellow")));
      }
      if (git.stagedFiles?.length) {
        for (const f of git.stagedFiles) {
          gitChildren.push(leaf(f, undefined, "diff-added", new vscode.ThemeColor("charts.green")));
        }
      }

      if (gitChildren.length > 0) {
        gitItem.children = gitChildren;
        gitItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      }
      items.push(gitItem);
    } else {
      items.push(leaf("Git", "(not a repo)", "git-branch", dim ?? new vscode.ThemeColor("charts.foreground")));
    }

    if (peer.context.activeFiles?.length) {
      const filesItem = leaf(`Active files (${peer.context.activeFiles.length})`, undefined, "folder-opened", new vscode.ThemeColor("charts.orange"));
      filesItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      filesItem.children = peer.context.activeFiles.map((f) =>
        leaf(
          `${f.relativePath || f.path}${f.isDirty ? " •" : ""}`,
          undefined,
          "file",
          new vscode.ThemeColor("charts.blue"),
        ),
      );
      items.push(filesItem);
    }

    const exchanges = peer.context.recentExchanges ?? [];
    const digest = peer.context.conversationDigest;
    const chatChildren: PeerItem[] = [];

    // Show AI-generated digest prominently at top
    if (digest) {
      const digestItem = leaf(`📋 ${digest}`, undefined, "lightbulb", new vscode.ThemeColor("charts.yellow"));
      digestItem.tooltip = `Conversation digest:\n\n${digest}`;
      chatChildren.push(digestItem);
    }

    // Raw exchanges beneath, grouped as a collapsible sub-tree
    if (exchanges.length > 0) {
      const rawItem = leaf(
        `Recent Context (${exchanges.length})`,
        undefined,
        "history",
        new vscode.ThemeColor("charts.foreground"),
      );
      rawItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      rawItem.children = exchanges.map((ex) => {
        const icon = ex.role === "human" ? "account" : "hubot";
        const color = ex.role === "human"
          ? new vscode.ThemeColor("charts.blue")
          : new vscode.ThemeColor("charts.green");
        const item = leaf(ex.text, undefined, icon, color);
        item.tooltip = `[${ex.role}] ${ex.timestamp}\n\n${ex.text}`;
        return item;
      });
      chatChildren.push(rawItem);
    }

    if (chatChildren.length === 1) {
      items.push(chatChildren[0]!);
    } else if (chatChildren.length > 1) {
      const chatItem = leaf(
        "Conversation",
        undefined,
        "comment-discussion",
        new vscode.ThemeColor("charts.foreground"),
      );
      chatItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      chatItem.children = chatChildren;
      items.push(chatItem);
    }

    // Messages subtree — lazily loaded when expanded
    const messageCount = peer.pendingMessages ?? 0;
    if (messageCount > 0) {
      const messagesItem = new PeerItem(
        `💬 Messages (${messageCount} unread)`,
        peer.id,
        "detail",
        undefined,
        "mail",
        new vscode.ThemeColor("notificationsInfoIcon.foreground"),
      );
      messagesItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      messagesItem.messagesForPeerId = peer.id;
      items.push(messagesItem);
    }

    // Reports subtree — lazily loaded when expanded
    const reportCount = peer.pendingReports ?? 0;
    if (reportCount > 0) {
      const reportsItem = new PeerItem(
        `📨 Reports (${reportCount} unread)`,
        peer.id,
        "detail",
        undefined,
        "inbox",
        new vscode.ThemeColor("charts.orange"),
      );
      reportsItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      reportsItem.reportsForPeerId = peer.id;
      items.push(reportsItem);
    }
  }

  return items;
}

/** Shorthand: create a leaf detail PeerItem with optional description. */
function leaf(label: string, value: string | undefined, iconId: string, iconColor?: vscode.ThemeColor): PeerItem {
  const item = new PeerItem(label, "", "detail", undefined, iconId, iconColor);
  if (value !== undefined) {
    item.description = value;
  }
  return item;
}

class PeerItem extends vscode.TreeItem {
  children?: PeerItem[];
  /** When set, getChildren will lazily fetch reports for this peer ID */
  reportsForPeerId?: string;
  /** When set, getChildren will lazily fetch unread messages for this peer ID */
  messagesForPeerId?: string;

  static projectHeader(projectName: string, peerCount: number): PeerItem {
    const item = new PeerItem(projectName, "", "header");
    item.description = `${peerCount} peer${peerCount !== 1 ? "s" : ""}`;
    item.iconPath = new vscode.ThemeIcon("root-folder", new vscode.ThemeColor("charts.blue"));
    item.contextValue = "projectHeader";
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
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
        this.iconPath = new vscode.ThemeIcon("circle-outline", DIM_COLOR);
      } else {
        const summary = peer.context.summary ?? "";
        const task = peer.context.currentTask ?? "";
        const pending = peer.pendingMessages ?? 0;
        const reports = peer.pendingReports ?? 0;
        let description = formatPeerDescription(peer);
        if (pending > 0) description += ` 💬${pending}`;
        if (reports > 0) description += ` 📨${reports}`;
        if (description) this.description = description;
        this.contextValue = "peer";
        const hasInformativeSummary = isInformativeSummary(summary, peer);
        const hasConversationCue = !!preferredConversationCue(peer);
        const recentlyActive = isRecentlyActive(peer, 2 * 60_000);
        const isWorking = !!task || hasInformativeSummary || hasConversationCue || recentlyActive;
        if (reports > 0) {
          this.iconPath = new vscode.ThemeIcon("inbox", new vscode.ThemeColor("notificationsInfoIcon.foreground"));
        } else if (pending > 0) {
          this.iconPath = new vscode.ThemeIcon("mail", new vscode.ThemeColor("notificationsInfoIcon.foreground"));
        } else if (isWorking) {
          this.iconPath = new vscode.ThemeIcon("sync~spin", agentColor(peer.agentType));
        } else {
          this.iconPath = new vscode.ThemeIcon("circle-filled", agentColor(peer.agentType));
        }
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
      `- Source: ${p.source === "extension" ? "VSCode extension" : "Terminal (MCP)"}`,
      `- CWD: \`${p.cwd}\``,
    ];
    if (isInformativeSummary(p.context.summary, p)) parts.push(`- Summary: ${p.context.summary}`);
    const digest = preferredConversationCue(p);
    if (digest) parts.push(`- Digest: ${digest}`);
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
