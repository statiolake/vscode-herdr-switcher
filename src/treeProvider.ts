import * as vscode from "vscode";
import { inferWorkspaceRoot } from "./model";
import type { AgentStatus, HerdrAgent, HerdrSnapshot, HerdrWorkspace } from "./types";

export interface SpaceNode {
  kind: "space";
  workspace: HerdrWorkspace;
  root?: string;
}

export interface AgentNode {
  kind: "agent";
  agent: HerdrAgent;
  workspace: HerdrWorkspace;
  root?: string;
}

interface MessageNode {
  kind: "message";
  label: string;
  icon: string;
}

type SpaceTreeNode = SpaceNode | MessageNode;
type AgentTreeNode = AgentNode | MessageNode;

/** The single live Herdr model shared by the independent Spaces and Agents views. */
export class HerdrSnapshotStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  snapshot: HerdrSnapshot | undefined;
  error: string | undefined;
  branches = new Map<string, string>();

  setSnapshot(snapshot: HerdrSnapshot, branches = this.branches): void {
    this.snapshot = snapshot;
    this.branches = branches;
    this.error = undefined;
    this.changeEmitter.fire();
  }

  setError(message: string): void {
    this.error = message;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

export class SpacesTreeProvider implements vscode.TreeDataProvider<SpaceTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<SpaceTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly storeSubscription: vscode.Disposable;

  constructor(private readonly store: HerdrSnapshotStore) {
    this.storeSubscription = store.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(node: SpaceTreeNode): vscode.TreeItem {
    if (node.kind === "message") {
      return messageItem(node);
    }
    const item = new vscode.TreeItem(node.workspace.label, vscode.TreeItemCollapsibleState.None);
    item.id = `space:${node.workspace.workspace_id}`;
    item.description = this.store.branches.get(node.workspace.workspace_id);
    item.iconPath = spaceStatusIcon(node.workspace.agent_status);
    item.tooltip = node.root
      ? `${node.root}\n${node.workspace.workspace_id} · ${node.workspace.agent_status}`
      : `${node.workspace.workspace_id} · ${node.workspace.agent_status}\nNo folder association is available`;
    item.contextValue = "herdrSpace";
    item.command = { command: "herdr.openSpace", title: "Open Space", arguments: [node] };
    return item;
  }

  getChildren(node?: SpaceTreeNode): SpaceTreeNode[] {
    if (node) {
      return [];
    }
    const unavailable = unavailableNode(this.store, "No Herdr spaces");
    if (unavailable) {
      return [unavailable];
    }
    const snapshot = this.store.snapshot!;
    return [...snapshot.workspaces]
      .sort((left, right) => left.number - right.number)
      .map((workspace) => ({
        kind: "space" as const,
        workspace,
        root: inferWorkspaceRoot(snapshot, workspace),
      }));
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<AgentTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly storeSubscription: vscode.Disposable;

  constructor(private readonly store: HerdrSnapshotStore) {
    this.storeSubscription = store.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(node: AgentTreeNode): vscode.TreeItem {
    if (node.kind === "message") {
      return messageItem(node);
    }
    const agentName = node.agent.name ?? node.agent.display_agent ?? node.agent.agent ?? node.agent.title ?? node.agent.pane_id;
    const tab = this.store.snapshot?.tabs.find((candidate) => candidate.tab_id === node.agent.tab_id);
    const primaryLabel = tab && (tab.label !== "1" || node.workspace.tab_count > 1)
      ? `${node.workspace.label} / ${tab.label}`
      : node.workspace.label;
    const item = new vscode.TreeItem(primaryLabel, vscode.TreeItemCollapsibleState.None);
    item.id = `agent:${node.agent.terminal_id}`;
    item.description = agentName;
    item.iconPath = agentStatusIcon(node.agent.agent_status);
    const stateLabel = node.agent.state_labels?.[node.agent.agent_status] ?? node.agent.agent_status;
    item.tooltip = `${agentName}\n${node.agent.pane_id} · ${node.workspace.label}\n${stateLabel}`;
    item.contextValue = "herdrAgent";
    item.command = { command: "herdr.openAgent", title: "Open Agent", arguments: [node] };
    return item;
  }

  getChildren(node?: AgentTreeNode): AgentTreeNode[] {
    if (node) {
      return [];
    }
    const unavailable = unavailableNode(this.store, "No Herdr agents", true);
    if (unavailable) {
      return [unavailable];
    }
    const snapshot = this.store.snapshot!;
    return [...snapshot.agents]
      .sort((left, right) => {
        const leftWorkspace = workspaceNumber(snapshot, left.workspace_id);
        const rightWorkspace = workspaceNumber(snapshot, right.workspace_id);
        return leftWorkspace - rightWorkspace
          || left.pane_id.localeCompare(right.pane_id, undefined, { numeric: true });
      })
      .flatMap((agent): AgentNode[] => {
        const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === agent.workspace_id);
        return workspace
          ? [{ kind: "agent", agent, workspace, root: inferWorkspaceRoot(snapshot, workspace) }]
          : [];
      });
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

function workspaceNumber(snapshot: HerdrSnapshot, workspaceId: string): number {
  return snapshot.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.number
    ?? Number.MAX_SAFE_INTEGER;
}

function unavailableNode(
  store: HerdrSnapshotStore,
  emptyLabel: string,
  agents = false,
): MessageNode | undefined {
  if (store.error && !store.snapshot) {
    return { kind: "message", label: store.error, icon: "warning" };
  }
  if (!store.snapshot) {
    return { kind: "message", label: "Connecting to Herdr…", icon: "loading~spin" };
  }
  const empty = agents ? store.snapshot.agents.length === 0 : store.snapshot.workspaces.length === 0;
  return empty ? { kind: "message", label: emptyLabel, icon: "info" } : undefined;
}

function messageItem(node: MessageNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label);
  item.iconPath = new vscode.ThemeIcon(node.icon);
  return item;
}

function agentStatusIcon(status: AgentStatus): vscode.ThemeIcon {
  switch (status) {
    case "blocked": return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconFailed"));
    case "working": return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow"));
    case "done": return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.blue"));
    case "idle": return new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
    case "unknown": return new vscode.ThemeIcon("circle-outline");
  }
}

function spaceStatusIcon(status: AgentStatus): vscode.ThemeIcon {
  switch (status) {
    case "blocked": return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconFailed"));
    case "working": return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
    case "done": return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.blue"));
    case "idle": return new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("testing.iconPassed"));
    case "unknown": return new vscode.ThemeIcon("circle-small");
  }
}
