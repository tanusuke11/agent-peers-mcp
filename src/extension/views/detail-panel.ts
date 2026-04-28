import * as vscode from "vscode";
import { buildMarkdownWebviewHtml, type MarkdownViewItem } from "./webview-content";

export class DetailPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "agentPeers.detailPanel";

  private view: vscode.WebviewView | undefined;
  private currentItem: MarkdownViewItem | undefined;
  private currentKind: "message" | "repoMemory" = "message";

  async showMessage(item: MarkdownViewItem): Promise<void> {
    this.currentItem = item;
    this.currentKind = "message";
    await this._focus();
    this._render();
  }

  async showRepoMemory(item: MarkdownViewItem): Promise<void> {
    this.currentItem = item;
    this.currentKind = "repoMemory";
    await this._focus();
    this._render();
  }

  private async _focus(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.agent-peers");
      await vscode.commands.executeCommand(`${DetailPanelProvider.viewId}.focus`);
    } catch {
      // View not yet visible; item is cached and will render on resolveWebviewView.
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false };
    this._render();
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private _render(): void {
    if (!this.view) return;

    const item = this.currentItem;

    let title: string;
    let markdown: string;

    if (this.currentKind === "repoMemory") {
      title = item?.title ?? "Repo Memory Detail";
      markdown = item
        ? `${item.header ?? "# Repo Memory"}${item.text ?? ""}`
        : ["# Repo Memory", "", "Select a memory from the `Peers` view to inspect it here."].join("\n");
      this.view.title = "Detail";
      this.view.description = item?.title ? item.title.slice(0, 40) : undefined;
    } else {
      title = item?.title ?? "Message Detail";
      markdown = item
        ? `${item.header ?? "# Message"}${item.text ?? ""}`
        : ["# Message Detail", "", "Select an incoming message from the `Peers` view to inspect it here."].join("\n");
      this.view.title = "Detail";
      this.view.description = item?.title ? item.title.slice(0, 40) : undefined;
    }

    this.view.webview.html = buildMarkdownWebviewHtml(title, markdown);
  }
}
