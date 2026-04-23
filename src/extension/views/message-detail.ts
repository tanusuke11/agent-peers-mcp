import * as vscode from "vscode";
import { buildMarkdownWebviewHtml, type MarkdownViewItem } from "./webview-content";

export class MessageDetailProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "agentPeers.messageDetail";

  private view: vscode.WebviewView | undefined;
  private currentItem: MarkdownViewItem | undefined;

  async show(item: MarkdownViewItem): Promise<void> {
    this.currentItem = item;

    try {
      await vscode.commands.executeCommand("workbench.view.extension.agent-peers");
      await vscode.commands.executeCommand(`${MessageDetailProvider.viewId}.focus`);
    } catch {
      // If the view isn't visible yet, keep the item cached and render on resolve.
    }

    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: false,
    };
    this.render();
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const item = this.currentItem;
    const title = item?.title ?? "Message Detail";
    const markdown = item
      ? `${item.header ?? "# Message"}${item.text ?? ""}`
      : [
        "# Message Detail",
        "",
        "Select an incoming message from the `Peers` view to inspect it here.",
      ].join("\n");

    this.view.title = "Message Detail";
    this.view.description = item?.title ? item.title.slice(0, 40) : undefined;
    this.view.webview.html = buildMarkdownWebviewHtml(title, markdown);
  }
}
