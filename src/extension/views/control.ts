/**
 * Control panel tree view provider
 * Shows broker management and MCP connection actions
 */

import * as vscode from "vscode";
import type { BrokerClient } from "../broker-client";

export class ControlProvider implements vscode.TreeDataProvider<ControlItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ControlItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  brokerConnected = false;

  constructor(_client: BrokerClient) {}

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: ControlItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(): Promise<ControlItem[]> {
    const items: ControlItem[] = [];

    // Auto-start toggle
    const autoStart = vscode.workspace.getConfiguration("agentPeers").get<boolean>("autoStartBroker", false);
    items.push(ControlItem.action(
      "Auto-Start Broker", "agentPeers.toggleAutoStart",
      autoStart ? "pass-filled" : "circle-large-outline",
      autoStart ? "charts.green" : "disabledForeground",
      autoStart ? "ON" : "OFF",
    ));

    // Broker actions — disable the irrelevant one based on state
    const status = this.brokerConnected ? "Broker is running" : "Broker is stopped";
    items.push(ControlItem.action(
      "Start Broker", this.brokerConnected ? undefined : "agentPeers.startBroker",
      "play", this.brokerConnected ? "disabledForeground" : "charts.green",
      status,
    ));
    items.push(ControlItem.action(
      "Stop Broker", this.brokerConnected ? "agentPeers.stopBroker" : undefined,
      "debug-stop", this.brokerConnected ? "charts.red" : "disabledForeground",
      status,
    ));

    // MCP connections
    items.push(ControlItem.action(
      "Config Claude Code", "agentPeers.addMcpServer",
      "gear", "charts.blue",
      "Register MCP server",
    ));

    items.push(ControlItem.action(
      "Config Codex", "agentPeers.addMcpServerCodex",
      "gear", "charts.green",
      "Add to Codex config",
    ));

    return items;
  }
}

class ControlItem extends vscode.TreeItem {
  static action(label: string, commandId: string | undefined, iconId: string, colorId: string, detail?: string): ControlItem {
    const item = new ControlItem(label);
    item.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(colorId));
    if (commandId) item.command = { command: commandId, title: label };
    if (detail) item.description = detail;
    return item;
  }

  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}
