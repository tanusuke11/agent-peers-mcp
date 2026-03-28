/**
 * Messages tree view provider
 * Shows recent messages between agents with type indicators
 */

import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";
import type { Message } from "../../shared/types";

export class MessagesProvider implements vscode.TreeDataProvider<MessageItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MessageItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private messages: Message[] = [];

  constructor(private client: BrokerClient) {
    // Listen for new messages via broker events
    client.on("message", (data) => {
      this.messages.push(data as Message);
      // Keep last 50
      if (this.messages.length > 50) this.messages = this.messages.slice(-50);
      this.refresh();
    });
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: MessageItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(): Promise<MessageItem[]> {
    if (this.messages.length === 0) {
      const item = new vscode.TreeItem("No messages yet");
      item.iconPath = new vscode.ThemeIcon("info");
      return [item as unknown as MessageItem];
    }

    return this.messages
      .slice()
      .reverse()
      .map((msg) => new MessageItem(msg));
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(msg: Message) {
    const typeIcon = messageTypeIcon(msg.type);
    const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text;
    super(`${typeIcon} ${preview}`, vscode.TreeItemCollapsibleState.None);

    this.description = `${msg.fromId} → ${msg.toId}`;
    this.tooltip = new vscode.MarkdownString([
      `**[${msg.type}]** from \`${msg.fromId}\` to \`${msg.toId}\``,
      `- Sent: ${msg.sentAt}`,
      `---`,
      msg.text,
    ].join("\n"));
    this.iconPath = new vscode.ThemeIcon(messageThemeIcon(msg.type));
  }
}

function messageTypeIcon(type: string): string {
  switch (type) {
    case "text": return "💬";
    case "context-request": return "📋";
    case "context-response": return "📄";
    case "task-handoff": return "🔄";
    default: return "💬";
  }
}

function messageThemeIcon(type: string): string {
  switch (type) {
    case "text": return "comment";
    case "context-request": return "search";
    case "context-response": return "file-code";
    case "task-handoff": return "arrow-swap";
    default: return "comment";
  }
}
