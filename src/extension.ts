import * as path from "node:path";
import * as vscode from "vscode";
import { agentShellCommand, configuredAgents, type ConfiguredAgent } from "./agentConfiguration";
import { agentDisplayName } from "./agentPresentation";
import { decodeDevContainerHostPath } from "./devContainer";
import { GitBranchProvider } from "./gitBranchProvider";
import { HerdrClient, HerdrCommandError } from "./herdrClient";
import { HerdrDirectTerminal } from "./directTerminal";
import { HerdrEventSubscriber } from "./herdrEvents";
import {
  activeAgentForWorkspace,
  activeTreeSelection,
  adjacentAgent,
  adjacentWorkspace,
  agentInAdjacentWorkspace,
  findWorkspaceForRoot,
  inferWorkspaceRoot,
  isFocusedWorkspace,
  nonShellForegroundProcesses,
  normalizeRoot,
  type ActiveTreeSelection,
  type AgentNavigationContext,
  type AgentNavigationDirection,
  type SpaceBinding,
  type WorkspaceNavigationDirection,
} from "./model";
import { ConsumedNavigationIntents, HerdrNavigationIntentStore } from "./navigationIntent";
import { OverallStatusBar } from "./overallStatusBar";
import { HerdrOutputDocumentProvider, HERDR_OUTPUT_SCHEME, outputDocumentUri } from "./outputDocument";
import { RootLock } from "./rootLock";
import { TerminalRegistry, type HerdrTerminalTarget } from "./terminalRegistry";
import {
  AgentsTreeProvider,
  HerdrSnapshotStore,
  SpacesTreeProvider,
  type AgentNode,
  type SpaceNode,
} from "./treeProvider";
import type { HerdrAgent, HerdrSnapshot } from "./types";

const BINDINGS_KEY = "herdr.spaceBindings.v1";
const TERMINAL_NAME = "Herdr";
const DEFAULT_OUTPUT_LINES = 1_000;

interface WorkspaceLocation {
  root: string;
  workspaceUri: vscode.Uri;
}

type HerdrTerminalLocation = "panel" | "editor";
type AgentTerminalMode = "herdr" | "direct";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Herdr", { log: true });
  const store = new HerdrSnapshotStore();
  const spaces = new SpacesTreeProvider(store);
  const agents = new AgentsTreeProvider(store);
  const spacesView = vscode.window.createTreeView("herdr.spaces", { treeDataProvider: spaces });
  const agentsView = vscode.window.createTreeView("herdr.agents", { treeDataProvider: agents });
  const outputDocuments = new HerdrOutputDocumentProvider();
  const outputDocumentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    HERDR_OUTPUT_SCHEME,
    outputDocuments,
  );
  const controller = new HerdrController(context, store, output, outputDocuments);
  const overallStatus = new OverallStatusBar();
  const syncSelection = () => synchronizeTreeSelection(
    store,
    spaces,
    agents,
    spacesView,
    agentsView,
    output,
    controller.treeSelection(),
  );
  context.subscriptions.push(
    output,
    outputDocuments,
    outputDocumentRegistration,
    store,
    spaces,
    agents,
    spacesView,
    agentsView,
    overallStatus,
    store.onDidChange(() => { void syncSelection(); }),
    controller.onDidRefresh((snapshot) => overallStatus.update(snapshot)),
    spacesView.onDidChangeVisibility(() => { void syncSelection(); }),
    agentsView.onDidChangeVisibility(() => { void syncSelection(); }),
    vscode.commands.registerCommand("herdr.refresh", () => controller.refresh(true)),
    vscode.commands.registerCommand("herdr.openSpace", (node: SpaceNode) => controller.openSpace(node)),
    vscode.commands.registerCommand("herdr.nextSpace", () => controller.nextSpace()),
    vscode.commands.registerCommand("herdr.previousSpace", () => controller.previousSpace()),
    vscode.commands.registerCommand("herdr.openAgent", (node: AgentNode) => controller.openAgent(node)),
    vscode.commands.registerCommand("herdr.nextAgent", () => controller.nextAgent()),
    vscode.commands.registerCommand("herdr.previousAgent", () => controller.previousAgent()),
    vscode.commands.registerCommand("herdr.focusActiveAgent", () => controller.focusActiveAgent()),
    vscode.commands.registerCommand("herdr.focusActiveAgentOrNext", () => controller.focusActiveAgentOrNext()),
    vscode.commands.registerCommand("herdr.focusActiveAgentOrPrevious", () => controller.focusActiveAgentOrPrevious()),
    vscode.commands.registerCommand("herdr.renameAgent", (node: AgentNode) => controller.renameAgent(node)),
    vscode.commands.registerCommand("herdr.renameTab", (node: AgentNode) => controller.renameTab(node)),
    vscode.commands.registerCommand("herdr.closeAgent", (node: AgentNode) => controller.closeAgent(node)),
    vscode.commands.registerCommand("herdr.copyAgentOutput", (node?: AgentNode) => controller.copyAgentOutput(node)),
    vscode.commands.registerCommand("herdr.openAgentOutput", (node?: AgentNode) => controller.openAgentOutput(node)),
    vscode.commands.registerCommand("herdr.openActiveAgent", () => controller.openActiveAgent()),
    vscode.commands.registerCommand("herdr.openAgentByPane", (paneId: string) => controller.openAgentByPane(paneId)),
    vscode.commands.registerCommand("herdr.attachSpace", (node: SpaceNode) => controller.attachSpace(node)),
    vscode.commands.registerCommand("herdr.closeSpace", (node: SpaceNode) => controller.closeSpace(node)),
    vscode.commands.registerCommand("herdr.addAgent", () => controller.addAgent()),
    vscode.commands.registerCommand("herdr.addDefaultAgent", () => controller.addDefaultAgent()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void controller.reconcileWorkspace().then(syncSelection);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void controller.handleWindowActivated().then(syncSelection);
      }
    }),
    vscode.window.onDidChangeActiveTerminal(() => { void syncSelection(); }),
    vscode.window.onDidCloseTerminal(() => { void syncSelection(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("herdr")) {
        controller.reconfigure();
        void syncSelection();
      }
    }),
    controller,
  );
  await controller.start();
}

export function deactivate(): void {}

class HerdrController implements vscode.Disposable {
  private readonly refreshEmitter = new vscode.EventEmitter<HerdrSnapshot | undefined>();
  readonly onDidRefresh = this.refreshEmitter.event;
  private client = this.createClient();
  private navigationIntents = new HerdrNavigationIntentStore(this.client);
  private snapshot: HerdrSnapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private navigationIntentPromise: Promise<boolean> | undefined;
  private disposed = false;
  private readonly terminals = new TerminalRegistry<vscode.Terminal>();
  private readonly terminalPreparations = new Map<string, Promise<vscode.Terminal>>();
  private readonly terminalCloseSubscription: vscode.Disposable;
  private readonly agentTerminalMode: AgentTerminalMode;
  private eventSubscriber: HerdrEventSubscriber | undefined;
  private eventStreamAvailable = false;
  private eventStreamAttemptAt = 0;
  private eventRefreshTimer: NodeJS.Timeout | undefined;
  private serverStartAttempted = false;
  private readonly consumedNavigationIntents = new ConsumedNavigationIntents();
  private readonly reportedSpaceCreationErrors = new Set<string>();
  private readonly reportedWorkspaceLocationErrors = new Set<string>();
  private readonly closingRoots = new Set<string>();
  private readonly gitBranches = new GitBranchProvider();
  private windowPresenceError: string | undefined;
  private readonly spaceCreationLock: RootLock;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: HerdrSnapshotStore,
    private readonly output: vscode.LogOutputChannel,
    private readonly outputDocuments: HerdrOutputDocumentProvider,
  ) {
    this.spaceCreationLock = new RootLock(path.join(context.globalStorageUri.fsPath, "space-creation-locks"));
    this.agentTerminalMode = vscode.workspace.getConfiguration("herdr")
      .get<AgentTerminalMode>("agentTerminalMode", "herdr");
    this.terminalCloseSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      this.terminals.remove(terminal);
    });
  }

  async start(): Promise<void> {
    await this.handleWindowActivated();
    await this.ensureEventStream();
    this.schedule();
  }

  activeAgent() {
    const association = this.currentWorkspaceAssociation();
    return association && this.snapshot
      ? this.activeAgentForCurrentWindow(association.workspace.workspace_id)
      : undefined;
  }

  treeSelection(): ActiveTreeSelection {
    if (!this.snapshot) {
      return {};
    }
    if (this.synchronizeState()) {
      return activeTreeSelection(this.snapshot);
    }
    const association = this.currentWorkspaceAssociation();
    const agent = association ? this.activeAgentForCurrentWindow(association.workspace.workspace_id) : undefined;
    return { agentPaneId: agent?.pane_id };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (this.eventRefreshTimer) {
      clearTimeout(this.eventRefreshTimer);
    }
    this.eventSubscriber?.dispose();
    this.terminalCloseSubscription.dispose();
    this.refreshEmitter.dispose();
  }

  reconfigure(): void {
    this.client = this.createClient();
    this.navigationIntents = new HerdrNavigationIntentStore(this.client);
    this.eventSubscriber?.dispose();
    this.eventSubscriber = undefined;
    this.eventStreamAvailable = false;
    this.eventStreamAttemptAt = 0;
    this.serverStartAttempted = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    void this.refresh(true).then(() => this.reconcileWorkspace());
    this.schedule();
  }

  async refresh(showError: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    const refresh = this.performRefresh(showError);
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = undefined;
      }
    }
  }

  private async performRefresh(showError: boolean): Promise<void> {
    try {
      const snapshot = await this.client.snapshot();
      const branches = await this.gitBranches.forSnapshot(snapshot);
      this.snapshot = snapshot;
      this.store.setSnapshot(snapshot, branches);
      if (this.eventSubscriber?.setPaneIds(snapshot.agents.map((agent) => agent.pane_id))) {
        // A newly discovered pane needs its parameterized status subscription
        // immediately; do not wait for the ordinary reconnect backoff.
        this.eventStreamAttemptAt = 0;
      }
      this.refreshEmitter.fire(snapshot);
      this.serverStartAttempted = false;
    } catch (error) {
      const message = errorMessage(error);
      this.snapshot = undefined;
      this.output.debug(`Snapshot failed: ${message}`);
      if (this.synchronizeState()) {
        this.store.setError("Herdr is not running");
      } else {
        this.store.setOffline();
      }
      this.refreshEmitter.fire(undefined);
      if (showError && this.synchronizeState()) {
        void vscode.window.showErrorMessage(`Herdr: ${message}`);
      }
    }
  }

  async reconcileFolders(): Promise<void> {
    if (!this.synchronizeState()) {
      return;
    }
    if (!vscode.workspace.getConfiguration("herdr").get("createSpaceOnOpen", true)) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return;
    }
    if (!this.snapshot) {
      await this.ensureServer();
      await this.refresh(false);
    }
    let created = false;
    for (const folder of folders) {
      const location = this.workspaceLocation(folder);
      if (!location) {
        this.reportWorkspaceLocationError(folder);
        continue;
      }
      this.reportedWorkspaceLocationErrors.delete(folder.uri.toString());
      created = await this.ensureSpace(location, folder.name) || created;
    }
    if (created) {
      await this.refresh(false);
    }
  }

  async reconcileWorkspace(): Promise<void> {
    await this.reconcileFolders();
    await this.reportWindowPresence();
  }

  async openSpace(node: SpaceNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Herdr space “${node.workspace.label}” has no folder association.`);
      return;
    }
    if (this.isCurrentRoot(root)) {
      if (this.synchronizeState()) {
        await this.focusSpace(node.workspace.workspace_id);
      }
      return;
    }
    if (this.synchronizeState()) {
      await this.publishWorkspaceNavigation(node.workspace.workspace_id);
    }
    await vscode.commands.executeCommand(
      "vscode.openFolder", this.workspaceUri(node.workspace.workspace_id, root), { forceNewWindow: true },
    );
  }

  async openAgent(node: AgentNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Agent “${node.agent.name ?? node.agent.pane_id}” has no folder association.`);
      return;
    }
    if (!this.isCurrentRoot(root)) {
      await this.publishAgentNavigation(node.workspace.workspace_id, node.agent.pane_id);
      await vscode.commands.executeCommand(
        "vscode.openFolder", this.workspaceUri(node.workspace.workspace_id, root), { forceNewWindow: true },
      );
      return;
    }
    try {
      await this.focusAgent(node.agent.pane_id);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus Herdr agent: ${errorMessage(error)}`);
    }
  }

  async renameAgent(node: AgentNode): Promise<void> {
    const currentName = agentDisplayName(node.agent);
    const name = await vscode.window.showInputBox({
      title: "Rename Herdr Agent",
      prompt: `Enter a name for ${node.workspace.label}`,
      value: currentName,
      valueSelection: [0, currentName.length],
      validateInput: (value) => value.trim() ? undefined : "Agent name cannot be empty.",
    });
    if (name === undefined || name.trim() === currentName) {
      return;
    }
    try {
      await this.client.renamePane(node.agent.pane_id, name.trim());
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not rename Herdr agent: ${errorMessage(error)}`);
    }
  }

  async renameTab(node: AgentNode): Promise<void> {
    const tab = this.snapshot?.tabs.find((candidate) => candidate.tab_id === node.agent.tab_id);
    if (!tab) {
      void vscode.window.showWarningMessage(`Could not find the Herdr tab for ${agentDisplayName(node.agent)}.`);
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "Rename Herdr Tab",
      prompt: `Enter a name for the tab containing ${agentDisplayName(node.agent)}`,
      value: tab.label,
      valueSelection: [0, tab.label.length],
      validateInput: (value) => value.trim() ? undefined : "Tab name cannot be empty.",
    });
    if (name === undefined || name.trim() === tab.label) {
      return;
    }
    try {
      await this.client.renameTab(tab.tab_id, name.trim());
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not rename Herdr tab: ${errorMessage(error)}`);
    }
  }

  async closeAgent(node: AgentNode): Promise<void> {
    try {
      await this.client.closePane(node.agent.pane_id);
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not close Herdr agent: ${errorMessage(error)}`);
    }
  }

  async copyAgentOutput(node?: AgentNode): Promise<void> {
    const result = await this.readAgentOutput(node);
    if (!result) {
      return;
    }
    if (!result.output.trim()) {
      void vscode.window.showInformationMessage(`No recent output for ${agentDisplayName(result.agent)}.`);
      return;
    }
    await vscode.env.clipboard.writeText(result.output);
    void vscode.window.setStatusBarMessage(
      `Copied recent output from ${agentDisplayName(result.agent)}.`,
      3_000,
    );
  }

  async openAgentOutput(node?: AgentNode): Promise<void> {
    const result = await this.readAgentOutput(node);
    if (!result) {
      return;
    }
    const uri = outputDocumentUri(result.agent.pane_id);
    this.outputDocuments.set(uri, result.output);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }

  async openActiveAgent(): Promise<void> {
    const agent = this.activeAgent();
    if (!agent) {
      return;
    }
    try {
      await this.focusAgent(agent.pane_id);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus Herdr agent: ${errorMessage(error)}`);
    }
  }

  async openAgentByPane(paneId: string): Promise<void> {
    const agent = this.snapshot?.agents.find((candidate) => candidate.pane_id === paneId);
    const workspace = agent
      ? this.snapshot?.workspaces.find((candidate) => candidate.workspace_id === agent.workspace_id)
      : undefined;
    if (!agent || !workspace || !this.snapshot) {
      return;
    }
    await this.openAgent({
      kind: "agent",
      agent,
      workspace,
      root: inferWorkspaceRoot(this.snapshot, workspace),
    });
  }

  async nextAgent(): Promise<void> {
    await this.moveAgent("next");
  }

  async previousAgent(): Promise<void> {
    await this.moveAgent("previous");
  }

  async nextSpace(): Promise<void> {
    await this.moveSpace("next");
  }

  async previousSpace(): Promise<void> {
    await this.moveSpace("previous");
  }

  private async moveAgent(direction: AgentNavigationDirection): Promise<void> {
    await this.refresh(false);
    if (!this.snapshot) {
      return;
    }
    const currentWorkspace = this.currentWorkspace();
    const context = this.agentNavigationContext(currentWorkspace?.workspace_id);
    const agent = adjacentAgent(this.snapshot, currentWorkspace?.workspace_id, direction, context);
    if (!agent) {
      return;
    }
    try {
      await this.openAgentByPane(agent.pane_id);
    } catch (error) {
      const label = direction === "next" ? "next" : "previous";
      void vscode.window.showErrorMessage(`Could not open ${label} Herdr agent: ${errorMessage(error)}`);
    }
  }

  private async moveSpace(direction: WorkspaceNavigationDirection): Promise<void> {
    await this.refresh(false);
    if (!this.snapshot) {
      return;
    }
    const currentWorkspace = this.currentWorkspace();
    const workspace = adjacentWorkspace(this.snapshot, currentWorkspace?.workspace_id, direction);
    if (!workspace) {
      return;
    }
    try {
      await this.openSpace({
        kind: "space",
        workspace,
        root: inferWorkspaceRoot(this.snapshot, workspace),
      });
    } catch (error) {
      const label = direction === "next" ? "next" : "previous";
      void vscode.window.showErrorMessage(`Could not open ${label} Herdr space: ${errorMessage(error)}`);
    }
  }

  private async focusAgent(paneId: string): Promise<void> {
    if (this.agentTerminalMode === "direct") {
      if (this.shouldFocusHerdrAgent()) {
        await this.retryFocus(() => this.client.focusAgent(paneId));
      }
      await this.prepareTerminal(this.agentTerminalTarget(paneId));
    } else {
      await this.prepareTerminal();
      await this.retryFocus(() => this.client.focusAgent(paneId));
    }
    await this.refresh(false);
  }

  async focusActiveAgent(): Promise<void> {
    await this.refresh(false);
    const workspace = this.currentWorkspace();
    if (!workspace || !this.snapshot) {
      return;
    }
    const agent = this.synchronizeState()
      ? isFocusedWorkspace(this.snapshot, workspace.workspace_id)
        ? activeAgentForWorkspace(this.snapshot, workspace.workspace_id)
        : undefined
      : this.activeAgentForCurrentWindow(workspace.workspace_id);
    if (!agent) {
      return;
    }
    try {
      await this.focusAgent(agent.pane_id);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus active Herdr agent: ${errorMessage(error)}`);
    }
  }

  async focusActiveAgentOrNext(): Promise<void> {
    await this.focusActiveAgentOr("next");
  }

  async focusActiveAgentOrPrevious(): Promise<void> {
    await this.focusActiveAgentOr("previous");
  }

  private async focusActiveAgentOr(direction: AgentNavigationDirection): Promise<void> {
    await this.refresh(false);
    const workspace = this.currentWorkspace();
    if (!workspace || !this.snapshot) {
      return;
    }
    const activeAgent = this.synchronizeState()
      ? isFocusedWorkspace(this.snapshot, workspace.workspace_id)
        ? activeAgentForWorkspace(this.snapshot, workspace.workspace_id)
        : undefined
      : this.activeAgentForCurrentWindow(workspace.workspace_id);
    const target = activeAgent ?? agentInAdjacentWorkspace(this.snapshot, workspace.workspace_id, direction);
    if (!target) {
      return;
    }
    try {
      if (target.workspace_id === workspace.workspace_id) {
        await this.focusAgent(target.pane_id);
      } else {
        await this.openAgentByPane(target.pane_id);
      }
    } catch (error) {
      const label = direction === "next" ? "next" : "previous";
      void vscode.window.showErrorMessage(`Could not focus active or ${label} Herdr agent: ${errorMessage(error)}`);
    }
  }

  async attachSpace(node: SpaceNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Herdr space “${node.workspace.label}” has no folder association.`);
      return;
    }
    if (!this.isCurrentRoot(root)) {
      try {
        await this.navigationIntents.publishAttach(node.workspace.workspace_id);
        await this.client.focusWorkspace(node.workspace.workspace_id);
        await vscode.commands.executeCommand(
          "vscode.openFolder", this.workspaceUri(node.workspace.workspace_id, root), { forceNewWindow: true },
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not attach to Herdr space: ${errorMessage(error)}`);
      }
      return;
    }
    try {
      await this.prepareTerminal();
      await this.retryFocus(() => this.client.focusWorkspace(node.workspace.workspace_id));
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not attach to Herdr space: ${errorMessage(error)}`);
    }
  }

  async closeSpace(node: SpaceNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Herdr space “${node.workspace.label}” has no folder association.`);
      return;
    }
    let running;
    try {
      await this.refresh(false);
      running = await this.runningProcesses(node.workspace.workspace_id);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not inspect Herdr space processes: ${errorMessage(error)}`);
      return;
    }
    if (running.length > 0) {
      const preview = running.slice(0, 5).map((process) => `${process.name} (PID ${process.pid})`).join(", ");
      const more = running.length > 5 ? ` and ${running.length - 5} more` : "";
      const closeWindow = this.synchronizeState();
      const accepted = await vscode.window.showWarningMessage(
        `“${node.workspace.label}” has running processes: ${preview}${more}. `
          + (closeWindow ? "Close the space and its VS Code window?" : "Close the space but keep its VS Code window open?"),
        { modal: true },
        "Close Anyway",
      );
      if (accepted !== "Close Anyway") {
        return;
      }
    }
    try {
      if (this.isCurrentRoot(root)) {
        await this.closeCurrentWindowSpace(node.workspace.workspace_id, root, this.synchronizeState());
      } else if (
        this.synchronizeState()
        && this.snapshot
        && this.navigationIntents.hasWindowPresence(this.snapshot, node.workspace.workspace_id)
      ) {
        await this.navigationIntents.publishClose(node.workspace.workspace_id);
        await vscode.commands.executeCommand(
          "vscode.openFolder", this.workspaceUri(node.workspace.workspace_id, root), { forceNewWindow: true },
        );
      } else {
        await this.closeUnopenedSpace(node.workspace.workspace_id, root);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not close Herdr space: ${errorMessage(error)}`);
    }
  }

  async addAgent(): Promise<void> {
    const agents = this.configuredAgentList();
    if (agents.length === 0) {
      void vscode.window.showWarningMessage("No valid agents are configured in herdr.agents.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      agents.map((agent) => ({ label: agent.name, description: agent.command.join(" "), agent })),
      { title: "Add Herdr Agent", placeHolder: "Choose an agent to start" },
    );
    if (selected) {
      await this.startConfiguredAgent(selected.agent);
    }
  }

  async addDefaultAgent(): Promise<void> {
    const name = vscode.workspace.getConfiguration("herdr").get<string>("defaultAgent", "Claude Code");
    const agent = this.configuredAgentList().find((candidate) => candidate.name === name);
    if (!agent) {
      void vscode.window.showWarningMessage(`Default agent “${name}” is not present in herdr.agents.`);
      return;
    }
    await this.startConfiguredAgent(agent);
  }

  async handleWindowActivated(): Promise<void> {
    await this.refresh(false);
    await this.reconcileWorkspace();
    if (!await this.consumeNavigationIntent()) {
      await this.activateCurrentSpace();
    }
  }

  private async focusSpace(workspaceId: string): Promise<void> {
    try {
      if (this.synchronizeState()) {
        await vscode.commands.executeCommand("workbench.view.extension.herdr");
        await vscode.commands.executeCommand("herdr.spaces.focus");
        await this.retryFocus(() => this.client.focusWorkspace(workspaceId));
      }
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus Herdr space: ${errorMessage(error)}`);
    }
  }

  private async activateCurrentSpace(): Promise<void> {
    if (!this.synchronizeState()) {
      return;
    }
    const workspace = this.currentWorkspace();
    if (workspace) {
      await this.focusSpace(workspace.workspace_id);
    }
  }

  private async publishWorkspaceNavigation(workspaceId: string): Promise<void> {
    try {
      await this.navigationIntents.publishWorkspace(workspaceId);
      await this.client.focusWorkspace(workspaceId);
    } catch (error) {
      this.output.warn(`Could not publish workspace navigation intent: ${errorMessage(error)}`);
    }
  }

  private async publishAgentNavigation(workspaceId: string, paneId: string): Promise<void> {
    try {
      await this.navigationIntents.publishAgent(workspaceId, paneId);
      if (this.synchronizeState()) {
        await this.client.focusAgent(paneId);
      }
    } catch (error) {
      this.output.warn(`Could not publish agent navigation intent: ${errorMessage(error)}`);
    }
  }

  private async consumeNavigationIntent(): Promise<boolean> {
    if (this.navigationIntentPromise) {
      return this.navigationIntentPromise;
    }
    const consumption = this.consumeNavigationIntentOnce();
    this.navigationIntentPromise = consumption;
    try {
      return await consumption;
    } finally {
      if (this.navigationIntentPromise === consumption) {
        this.navigationIntentPromise = undefined;
      }
    }
  }

  private async consumeNavigationIntentOnce(): Promise<boolean> {
    if (!this.snapshot) {
      return false;
    }
    const workspace = this.currentWorkspace();
    if (!workspace) {
      return false;
    }
    const intent = this.navigationIntents.find(this.snapshot, workspace.workspace_id);
    if (!intent) {
      return false;
    }
    if (intent.kind !== "close" && !vscode.window.state.focused) {
      return false;
    }
    if (this.consumedNavigationIntents.has(intent.requestId)) {
      return true;
    }
    try {
      if (intent.kind === "close") {
        const association = this.currentWorkspaceAssociation();
        if (!association || association.workspace.workspace_id !== intent.workspaceId) {
          return false;
        }
        await this.navigationIntents.acknowledge(intent);
        this.consumedNavigationIntents.add(intent.requestId);
        this.output.debug(`Consuming Herdr navigation intent ${intent.requestId} (${intent.kind}).`);
        await this.closeCurrentWindowSpace(intent.workspaceId, association.root, this.synchronizeState());
        return true;
      }
      await this.navigationIntents.acknowledge(intent);
      this.consumedNavigationIntents.add(intent.requestId);
      this.output.debug(`Consuming Herdr navigation intent ${intent.requestId} (${intent.kind}).`);
      if (intent.kind === "workspace" && !this.synchronizeState()) {
        await this.refresh(false);
        return true;
      }
      if (intent.kind === "agent" || intent.kind === "attach") {
        if (intent.kind === "agent") {
          await this.focusAgent(intent.paneId);
        } else {
          await this.prepareTerminal();
          await this.retryFocus(() => this.client.focusWorkspace(intent.workspaceId));
          await this.refresh(false);
        }
      } else {
        await this.retryFocus(() => this.client.focusWorkspace(intent.workspaceId));
        await this.refresh(false);
      }
      return true;
    } catch (error) {
      this.output.warn(`Could not consume navigation intent ${intent.requestId}: ${errorMessage(error)}`);
      return false;
    }
  }

  private prepareTerminal(target: HerdrTerminalTarget = { kind: "session" }): Promise<vscode.Terminal> {
    const key = terminalTargetKey(target);
    const pending = this.terminalPreparations.get(key);
    if (pending) {
      return pending;
    }
    const preparation = this.prepareTerminalUnserialized(target).finally(() => {
      if (this.terminalPreparations.get(key) === preparation) {
        this.terminalPreparations.delete(key);
      }
    });
    this.terminalPreparations.set(key, preparation);
    return preparation;
  }

  private async prepareTerminalUnserialized(target: HerdrTerminalTarget): Promise<vscode.Terminal> {
    if (target.kind === "agent" && this.agentTerminalMode === "direct") {
      return this.prepareDirectTerminalUnserialized(target);
    }
    const terminalLocation = this.terminalLocation();
    const config = vscode.workspace.getConfiguration("herdr");
    const executable = config.get("executable", "herdr");
    const name = this.terminalName(target);
    const args = target.kind === "agent"
      ? this.client.agentAttachArgs(target.paneId)
      : this.client.terminalArgs();
    const workspaceLocation = this.currentWorkspaceLocation();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tracked = this.terminals.get(target);
      const candidate = tracked
        ?? vscode.window.terminals.find((terminal) => terminalMatches(
          terminal, name, executable, args, terminalLocation,
        ));
      if (candidate && !terminalMatches(candidate, name, executable, args, terminalLocation)) {
        this.terminals.remove(candidate);
        if (candidate === tracked || isOwnedHerdrTerminal(candidate, name)) {
          candidate.dispose();
        }
      } else if (candidate) {
        this.terminals.set(target, candidate);
        await this.showTerminal(candidate, terminalLocation);
        if (this.terminals.isCurrent(target, candidate)) {
          return candidate;
        }
      }

      const created = vscode.window.createTerminal({
        name,
        shellPath: executable,
        shellArgs: args,
        cwd: workspaceLocation ? vscode.Uri.file(workspaceLocation.root) : undefined,
        iconPath: new vscode.ThemeIcon("terminal"),
        location: terminalLocation === "panel"
          ? vscode.TerminalLocation.Panel
          : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        isTransient: true,
      });
      this.terminals.set(target, created);
      await this.showTerminal(created, terminalLocation);
      if (this.terminals.isCurrent(target, created)) {
        return created;
      }
    }
    throw new Error(`Herdr terminal for ${name} closed while it was opening.`);
  }

  private async prepareDirectTerminalUnserialized(target: Extract<HerdrTerminalTarget, { kind: "agent" }>): Promise<vscode.Terminal> {
    const terminalLocation = this.terminalLocation();
    const tracked = this.terminals.get(target);
    if (tracked) {
      await this.showTerminal(tracked, terminalLocation);
      if (this.terminals.isCurrent(target, tracked)) {
        return tracked;
      }
    }

    const config = vscode.workspace.getConfiguration("herdr");
    const executable = config.get("executable", "herdr");
    let created: vscode.Terminal | undefined;
    const pty = new HerdrDirectTerminal({
      executable,
      args: (columns, rows) => this.client.terminalSessionControlArgs(target.paneId, columns, rows),
      onClosed: () => {
        if (created) {
          this.terminals.remove(created);
        }
      },
      onError: (message) => this.output.warn(`${this.terminalName(target)}: ${message}`),
    });
    created = vscode.window.createTerminal({
      name: this.terminalName(target),
      pty,
      iconPath: new vscode.ThemeIcon("terminal"),
      location: terminalLocation === "panel"
        ? vscode.TerminalLocation.Panel
        : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      isTransient: true,
    });
    this.terminals.set(target, created);
    await this.showTerminal(created, terminalLocation);
    if (this.terminals.isCurrent(target, created)) {
      return created;
    }
    created.dispose();
    throw new Error(`Herdr terminal for ${this.terminalName(target)} closed while it was opening.`);
  }

  private async showTerminal(terminal: vscode.Terminal, location = this.terminalLocation()): Promise<void> {
    terminal.show(false);
    await waitForTerminalProcess(terminal);
    if (location === "editor") {
      await vscode.commands.executeCommand("workbench.action.pinEditor");
    }
  }

  private async runningProcesses(workspaceId: string) {
    const panes = this.snapshot?.panes.filter((pane) => pane.workspace_id === workspaceId) ?? [];
    const infos = await Promise.all(panes.map((pane) => this.client.paneProcessInfo(pane.pane_id)));
    return nonShellForegroundProcesses(infos);
  }

  private async closeCurrentWindowSpace(workspaceId: string, root: string, closeWindow: boolean): Promise<void> {
    const normalized = normalizeRoot(root);
    this.closingRoots.add(normalized);
    await this.removeBinding(root, workspaceId);
    try {
      await this.client.closeWorkspace(workspaceId);
      if (closeWindow) {
        await vscode.commands.executeCommand("workbench.action.closeWindow");
      } else {
        await this.refresh(false);
        this.closingRoots.delete(normalized);
        return;
      }
    } catch (error) {
      this.closingRoots.delete(normalized);
      throw error;
    }
    setTimeout(() => {
      if (!this.disposed) {
        this.closingRoots.delete(normalized);
        void this.reconcileFolders();
      }
    }, 3_000);
  }

  private async closeUnopenedSpace(workspaceId: string, root: string): Promise<void> {
    await this.removeBinding(root, workspaceId);
    await this.client.closeWorkspace(workspaceId);
    await this.refresh(false);
  }

  private async startConfiguredAgent(agent: ConfiguredAgent): Promise<void> {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      void vscode.window.showErrorMessage(
        "Could not start Herdr agent: No folder is open in this VS Code window. Open a folder first.",
      );
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${agent.name} in Herdr…` },
        async () => {
          await this.refresh(false);
          await this.reconcileFolders();
          if (!this.synchronizeState()) {
            await this.ensureCurrentSpaceForAgent();
          }
          const association = this.currentWorkspaceAssociation();
          if (!association || !this.snapshot) {
            throw new Error("The current VS Code folder is not associated with a Herdr space.");
          }
          const { workspace, root } = association;
          if (this.agentTerminalMode === "herdr") {
            await this.prepareTerminal();
          }
          await this.client.focusWorkspace(workspace.workspace_id);
          const created = await this.client.createTab(workspace.workspace_id, root);
          try {
            if (agent.kind) {
              await this.client.startAgent(
                uniqueHerdrAgentName(agent, created.root_pane.pane_id, this.snapshot?.agents.map((candidate) => candidate.name)),
                agent.kind,
                created.root_pane.pane_id,
                agent.command.slice(1),
              );
            } else {
              await this.client.runPane(created.root_pane.pane_id, agentShellCommand(agent.command));
            }
          } catch (error) {
            try {
              await this.client.closeTab(created.tab.tab_id);
            } catch (rollbackError) {
              this.output.warn(`Could not roll back tab ${created.tab.tab_id}: ${errorMessage(rollbackError)}`);
            }
            throw error;
          }
          if (this.agentTerminalMode === "direct") {
            await this.prepareTerminal({
              kind: "agent",
              paneId: created.root_pane.pane_id,
              name: agent.name,
            });
          } else {
            await this.refresh(false);
          }
        },
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not start Herdr agent: ${errorMessage(error)}`);
    }
  }

  private async ensureCurrentSpaceForAgent(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const location = folder ? this.workspaceLocation(folder) : undefined;
    if (!location) {
      if (folder) {
        this.reportWorkspaceLocationError(folder);
      }
      return;
    }
    if (!this.snapshot) {
      await this.ensureServer();
      await this.refresh(false);
    }
    if (!this.snapshot) {
      return;
    }
    const created = await this.ensureSpace(location, folder?.name || path.basename(location.root));
    if (created) {
      await this.refresh(false);
    }
  }

  private configuredAgentList(): ConfiguredAgent[] {
    return configuredAgents(vscode.workspace.getConfiguration("herdr").get("agents"));
  }

  private currentWorkspace() {
    return this.currentWorkspaceAssociation()?.workspace;
  }

  private currentWorkspaceAssociation() {
    if (!this.snapshot) {
      return undefined;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const location = this.workspaceLocation(folder);
      if (!location) {
        continue;
      }
      const workspace = findWorkspaceForRoot(this.snapshot, location.root, this.bindings());
      if (workspace) {
        return { workspace, root: location.root };
      }
    }
    return undefined;
  }

  private activeAgentForCurrentWindow(workspaceId: string): HerdrAgent | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    if (this.synchronizeState()) {
      return activeAgentForWorkspace(this.snapshot, workspaceId);
    }

    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return undefined;
    }
    const paneId = this.terminals.agentPaneId(terminal);
    if (paneId) {
      return this.snapshot.agents.find((agent) =>
        agent.workspace_id === workspaceId && agent.pane_id === paneId,
      );
    }
    if (this.terminals.isSessionTerminal(terminal)) {
      return activeAgentForWorkspace(this.snapshot, workspaceId);
    }
    return undefined;
  }

  private agentNavigationContext(workspaceId: string | undefined): AgentNavigationContext | undefined {
    if (this.synchronizeState()) {
      return undefined;
    }
    if (!this.snapshot || !workspaceId) {
      return {};
    }

    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return {};
    }
    const paneId = this.terminals.agentPaneId(terminal);
    if (paneId) {
      const agent = this.snapshot.agents.find((candidate) =>
        candidate.workspace_id === workspaceId && candidate.pane_id === paneId,
      );
      return agent ? { focusedPaneId: paneId } : {};
    }
    if (this.terminals.isSessionTerminal(terminal)) {
      const agent = activeAgentForWorkspace(this.snapshot, workspaceId);
      return { focusedPaneId: agent?.pane_id };
    }
    return {};
  }

  private async retryFocus(operation: () => Promise<void>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw lastError;
  }

  private async ensureSpace(location: WorkspaceLocation, label: string): Promise<boolean> {
    const { root } = location;
    if (this.closingRoots.has(normalizeRoot(root))) {
      return false;
    }
    if (!this.snapshot) {
      return false;
    }
    const bindings = this.bindings();
    const existing = findWorkspaceForRoot(this.snapshot, root, bindings);
    if (existing) {
      this.reportedSpaceCreationErrors.delete(normalizeRoot(root));
      await this.saveBinding(location, existing.workspace_id);
      return false;
    }
    try {
      return await this.spaceCreationLock.run(normalizeRoot(root), async () => {
        // Re-read inside the cross-window lock before mutating Herdr.
        this.snapshot = await this.client.snapshot();
        const rechecked = findWorkspaceForRoot(this.snapshot, root, this.bindings());
        if (rechecked) {
          this.reportedSpaceCreationErrors.delete(normalizeRoot(root));
          await this.saveBinding(location, rechecked.workspace_id);
          return false;
        }
        const created = await this.client.createWorkspace(root, label || path.basename(root));
        this.reportedSpaceCreationErrors.delete(normalizeRoot(root));
        await this.saveBinding(location, created.workspace.workspace_id);
        this.output.info(`Created Herdr space ${created.workspace.workspace_id} for ${root}`);
        return true;
      });
    } catch (error) {
      this.output.error(`Could not create a Herdr space for ${root}: ${errorMessage(error)}`);
      const normalized = normalizeRoot(root);
      if (!this.reportedSpaceCreationErrors.has(normalized)) {
        this.reportedSpaceCreationErrors.add(normalized);
        void vscode.window.showWarningMessage(`Could not create Herdr space for ${label}: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.serverStartAttempted) {
      return;
    }
    this.serverStartAttempted = true;
    this.output.info("Starting the Herdr headless server");
    try {
      await this.client.startServer();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(100);
        try {
          this.snapshot = await this.client.snapshot();
          this.store.setSnapshot(this.snapshot);
          return;
        } catch {
          // The socket is created asynchronously by the headless server.
        }
      }
      this.serverStartAttempted = false;
    } catch (error) {
      this.serverStartAttempted = false;
      this.output.error(`Could not start Herdr: ${errorMessage(error)}`);
    }
  }

  private async ensureEventStream(): Promise<void> {
    if (this.disposed || this.eventStreamAvailable) {
      return;
    }
    const now = Date.now();
    if (now - this.eventStreamAttemptAt < 5_000) {
      return;
    }
    this.eventStreamAttemptAt = now;
    if (!this.eventSubscriber) {
      this.eventSubscriber = new HerdrEventSubscriber(this.client, {
        onEvent: () => this.scheduleEventRefresh(),
        onConnected: () => {
          this.eventStreamAvailable = true;
          this.output.info("Connected to Herdr event stream");
        },
        onDisconnected: () => {
          this.eventStreamAvailable = false;
          this.eventStreamAttemptAt = 0;
          this.scheduleEventRefresh();
          this.output.debug("Herdr event stream disconnected; using fallback refresh until it reconnects.");
        },
      });
      this.eventSubscriber.setPaneIds(this.snapshot?.agents.map((agent) => agent.pane_id) ?? []);
    }
    try {
      await this.eventSubscriber.connectIfNeeded();
      this.eventStreamAvailable = this.eventSubscriber.isConnected;
    } catch (error) {
      this.eventStreamAvailable = false;
      this.output.debug(`Could not connect to Herdr event stream: ${errorMessage(error)}`);
    }
  }

  private scheduleEventRefresh(): void {
    if (this.disposed || this.eventRefreshTimer) {
      return;
    }
    this.eventRefreshTimer = setTimeout(() => {
      this.eventRefreshTimer = undefined;
      void this.refreshAndReconcile().catch((error) => {
        this.output.warn(`Event-triggered Herdr refresh failed: ${errorMessage(error)}`);
      });
    }, 50);
  }

  private async refreshAndReconcile(): Promise<void> {
    await this.refresh(false);
    await this.reconcileWorkspace();
    await this.consumeNavigationIntent();
    await this.ensureEventStream();
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    const configuredInterval = vscode.workspace.getConfiguration("herdr").get("refreshInterval", 1000);
    const interval = this.eventStreamAvailable
      ? Math.max(5_000, configuredInterval * 10)
      : configuredInterval;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshAndReconcile()
        .catch((error) => {
          this.output.warn(`Scheduled Herdr refresh failed: ${errorMessage(error)}`);
        })
        .finally(() => this.schedule());
    }, interval);
  }

  private createClient(): HerdrClient {
    const config = vscode.workspace.getConfiguration("herdr");
    const session = config.get<string>("session", "").trim();
    return new HerdrClient({ executable: config.get("executable", "herdr"), session: session || undefined });
  }

  private synchronizeState(): boolean {
    return vscode.workspace.getConfiguration("herdr").get<boolean>("synchronizeState", false);
  }

  private shouldFocusHerdrAgent(): boolean {
    return this.synchronizeState() || this.agentTerminalMode !== "direct";
  }

  private async reportWindowPresence(): Promise<void> {
    if (!this.synchronizeState()) {
      return;
    }
    const workspace = this.currentWorkspace();
    if (!workspace) {
      return;
    }
    const refreshInterval = vscode.workspace.getConfiguration("herdr").get("refreshInterval", 1000);
    try {
      await this.navigationIntents.reportWindowPresence(
        workspace.workspace_id,
        Math.max(5_000, refreshInterval * 3),
      );
      this.windowPresenceError = undefined;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== this.windowPresenceError) {
        this.windowPresenceError = message;
        this.output.debug(`Could not report VS Code window presence: ${message}`);
      }
    }
  }

  private bindings(): SpaceBinding[] {
    return this.context.globalState.get<SpaceBinding[]>(BINDINGS_KEY, []);
  }

  private async saveBinding(location: WorkspaceLocation, workspaceId: string): Promise<void> {
    const { root } = location;
    const normalized = normalizeRoot(root);
    const current = this.bindings();
    const workspaceUri = location.workspaceUri.toString();
    if (current.some((binding) =>
      normalizeRoot(binding.root) === normalized
      && binding.workspaceId === workspaceId
      && binding.workspaceUri === workspaceUri
    )) {
      return;
    }
    const next = current.filter((binding) => normalizeRoot(binding.root) !== normalized && binding.workspaceId !== workspaceId);
    next.push({ root, workspaceId, workspaceUri });
    await this.context.globalState.update(BINDINGS_KEY, next);
  }

  private async removeBinding(root: string, workspaceId: string): Promise<void> {
    const normalized = normalizeRoot(root);
    const next = this.bindings().filter((binding) =>
      normalizeRoot(binding.root) !== normalized && binding.workspaceId !== workspaceId,
    );
    await this.context.globalState.update(BINDINGS_KEY, next);
  }

  private boundRoot(workspaceId: string): string | undefined {
    return this.bindings().find((binding) => binding.workspaceId === workspaceId)?.root;
  }

  private workspaceLocation(folder: vscode.WorkspaceFolder): WorkspaceLocation | undefined {
    if (!vscode.env.remoteName) {
      return { root: folder.uri.fsPath, workspaceUri: folder.uri };
    }
    if (vscode.env.remoteName !== "dev-container" || folder.uri.scheme !== "vscode-remote") {
      return undefined;
    }
    const root = decodeDevContainerHostPath(folder.uri.authority);
    return root ? { root, workspaceUri: folder.uri } : undefined;
  }

  private currentWorkspaceLocation(): WorkspaceLocation | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const location = this.workspaceLocation(folder);
      if (location) {
        return location;
      }
    }
    return undefined;
  }

  private workspaceUri(workspaceId: string, fallbackRoot: string): vscode.Uri {
    const serialized = this.bindings().find((binding) => binding.workspaceId === workspaceId)?.workspaceUri;
    if (serialized) {
      try {
        return vscode.Uri.parse(serialized, true);
      } catch (error) {
        this.output.warn(`Could not parse the VS Code URI for Herdr space ${workspaceId}: ${errorMessage(error)}`);
      }
    }
    return vscode.Uri.file(fallbackRoot);
  }

  private reportWorkspaceLocationError(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    if (this.reportedWorkspaceLocationErrors.has(key)) {
      return;
    }
    this.reportedWorkspaceLocationErrors.add(key);
    const detail = vscode.env.remoteName === "dev-container"
      ? "the local host path could not be decoded from the Dev Container URI"
      : `remote type “${vscode.env.remoteName ?? "unknown"}” is not supported`;
    const message = `Could not associate “${folder.name}” with Herdr because ${detail}.`;
    this.output.error(`${message} URI: ${folder.uri.toString()}`);
    void vscode.window.showWarningMessage(message);
  }

  private isCurrentRoot(root: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
      const location = this.workspaceLocation(folder);
      return location && normalizeRoot(location.root) === normalizeRoot(root);
    });
  }

  private terminalName(target: HerdrTerminalTarget): string {
    if (target.kind === "agent") {
      return `${TERMINAL_NAME}: ${target.name}`;
    }
    const session = vscode.workspace.getConfiguration("herdr").get<string>("session", "").trim();
    return session ? `${TERMINAL_NAME} (${session})` : TERMINAL_NAME;
  }

  private agentTerminalTarget(paneId: string): HerdrTerminalTarget {
    const agent = this.snapshot?.agents.find((candidate) => candidate.pane_id === paneId);
    return {
      kind: "agent",
      paneId,
      name: agent ? agentDisplayName(agent) : paneId,
    };
  }

  private terminalLocation(): HerdrTerminalLocation {
    return vscode.workspace.getConfiguration("herdr").get<HerdrTerminalLocation>("terminalLocation", "panel");
  }

  private async readAgentOutput(node?: AgentNode): Promise<{ agent: HerdrAgent; output: string } | undefined> {
    const agent = node?.kind === "agent" ? node.agent : this.activeAgent();
    if (!agent) {
      void vscode.window.showWarningMessage("No active Herdr agent is available.");
      return undefined;
    }
    try {
      const output = await this.client.readPane(agent.pane_id, {
        source: "recent-unwrapped",
        lines: this.outputLineCount(),
      });
      return { agent, output };
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not read Herdr agent output: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private outputLineCount(): number {
    const value = vscode.workspace.getConfiguration("herdr").get<number>("outputLines", DEFAULT_OUTPUT_LINES);
    return Number.isFinite(value)
      ? Math.max(1, Math.min(5_000, Math.floor(value)))
      : DEFAULT_OUTPUT_LINES;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HerdrCommandError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function terminalMatchesLocation(terminal: vscode.Terminal, expected: HerdrTerminalLocation): boolean {
  const location = terminal.creationOptions.location;
  return expected === "panel"
    ? location === vscode.TerminalLocation.Panel
    : typeof location === "object";
}

async function synchronizeTreeSelection(
  store: HerdrSnapshotStore,
  spaces: SpacesTreeProvider,
  agents: AgentsTreeProvider,
  spacesView: vscode.TreeView<SpaceNode | { kind: "message"; label: string; icon: string }>,
  agentsView: vscode.TreeView<AgentNode | { kind: "message"; label: string; icon: string }>,
  output: vscode.LogOutputChannel,
  selection: ActiveTreeSelection,
): Promise<void> {
  // Tree change events are delivered synchronously, while VS Code rebuilds the
  // visible rows asynchronously. Reveal only after that rebuild can observe the
  // provider's new node generation.
  await delay(0);
  const snapshot = store.snapshot;
  if (!snapshot) {
    return;
  }
  try {
    const space = selection.workspaceId && spaces.nodeForWorkspace(selection.workspaceId);
    if (spacesView.visible && space) {
      await spacesView.reveal(space, { select: true, focus: false });
    }
    const agent = selection.agentPaneId && agents.nodeForPane(selection.agentPaneId);
    if (agentsView.visible && agent) {
      await agentsView.reveal(agent, { select: true, focus: false });
    }
  } catch (error) {
    output.debug(`Could not synchronize Herdr tree selection: ${errorMessage(error)}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTerminalProcess(terminal: vscode.Terminal): Promise<void> {
  await Promise.race([
    terminal.processId.then(() => undefined),
    delay(2_000),
  ]);
}

function isTransientTerminal(terminal: vscode.Terminal): boolean {
  return "isTransient" in terminal.creationOptions && terminal.creationOptions.isTransient === true;
}

function isOwnedHerdrTerminal(terminal: vscode.Terminal, expectedName: string): boolean {
  return terminal.name === expectedName
    && "shellPath" in terminal.creationOptions
    && terminal.creationOptions.shellPath !== undefined;
}

function terminalMatches(
  terminal: vscode.Terminal,
  expectedName: string,
  expectedExecutable: string,
  expectedArgs: readonly string[],
  expectedLocation: HerdrTerminalLocation,
): boolean {
  if (
    terminal.name !== expectedName
    || !isTransientTerminal(terminal)
    || !terminalMatchesLocation(terminal, expectedLocation)
    || !("shellPath" in terminal.creationOptions)
    || terminal.creationOptions.shellPath !== expectedExecutable
    || !Array.isArray(terminal.creationOptions.shellArgs)
  ) {
    return false;
  }
  return terminal.creationOptions.shellArgs.length === expectedArgs.length
    && terminal.creationOptions.shellArgs.every((value, index) => value === expectedArgs[index]);
}

function terminalTargetKey(target: HerdrTerminalTarget): string {
  return target.kind === "session" ? "session" : `agent:${target.paneId}`;
}

function uniqueHerdrAgentName(agent: ConfiguredAgent, paneId: string, existingNames: readonly (string | undefined)[] = []): string {
  const base = slugifyHerdrAgentName(agent.name || agent.kind || agent.command[0] || "agent");
  const existing = new Set(existingNames.filter((name): name is string => typeof name === "string"));
  if (!existing.has(base)) {
    return base;
  }
  const suffix = slugifyHerdrAgentName(paneId).slice(0, 20);
  for (let attempt = 0; ; attempt += 1) {
    const attemptSuffix = attempt === 0 ? suffix : `${suffix}-${attempt + 1}`;
    const baseLength = Math.max(1, 31 - attemptSuffix.length);
    const candidate = `${base.slice(0, baseLength)}-${attemptSuffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function slugifyHerdrAgentName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const withLeadingLetter = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
  return (withLeadingLetter || "agent").slice(0, 32);
}
