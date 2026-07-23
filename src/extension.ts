import * as path from "node:path";
import * as vscode from "vscode";
import { configuredAgents, shellCommand, type ConfiguredAgent } from "./agentConfiguration";
import { GitBranchProvider } from "./gitBranchProvider";
import { HerdrClient, HerdrCommandError } from "./herdrClient";
import { activeTreeSelection, findWorkspaceForRoot, nonShellForegroundProcesses, normalizeRoot, type SpaceBinding } from "./model";
import { HerdrNavigationIntentStore } from "./navigationIntent";
import {
  AgentsTreeProvider,
  HerdrSnapshotStore,
  SpacesTreeProvider,
  type AgentNode,
  type SpaceNode,
} from "./treeProvider";
import type { HerdrSnapshot } from "./types";

const BINDINGS_KEY = "herdr.spaceBindings.v1";
const TERMINAL_NAME = "Herdr";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Herdr", { log: true });
  const store = new HerdrSnapshotStore();
  const spaces = new SpacesTreeProvider(store);
  const agents = new AgentsTreeProvider(store);
  const spacesView = vscode.window.createTreeView("herdr.spaces", { treeDataProvider: spaces });
  const agentsView = vscode.window.createTreeView("herdr.agents", { treeDataProvider: agents });
  const controller = new HerdrController(context, store, output);
  const syncSelection = () => synchronizeTreeSelection(store, spaces, agents, spacesView, agentsView, output);
  context.subscriptions.push(
    output,
    store,
    spaces,
    agents,
    spacesView,
    agentsView,
    store.onDidChange(() => { void syncSelection(); }),
    spacesView.onDidChangeVisibility(() => { void syncSelection(); }),
    agentsView.onDidChangeVisibility(() => { void syncSelection(); }),
    vscode.commands.registerCommand("herdr.refresh", () => controller.refresh(true)),
    vscode.commands.registerCommand("herdr.openSpace", (node: SpaceNode) => controller.openSpace(node)),
    vscode.commands.registerCommand("herdr.openAgent", (node: AgentNode) => controller.openAgent(node)),
    vscode.commands.registerCommand("herdr.attachSpace", (node: SpaceNode) => controller.attachSpace(node)),
    vscode.commands.registerCommand("herdr.spaceActions", (node: SpaceNode) => controller.showSpaceActions(node)),
    vscode.commands.registerCommand("herdr.closeSpace", (node: SpaceNode) => controller.closeSpace(node)),
    vscode.commands.registerCommand("herdr.addAgent", () => controller.addAgent()),
    vscode.commands.registerCommand("herdr.addDefaultAgent", () => controller.addDefaultAgent()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.reconcileFolders()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void controller.handleWindowActivated();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("herdr")) {
        controller.reconfigure();
      }
    }),
    controller,
  );
  await controller.start();
}

export function deactivate(): void {}

class HerdrController implements vscode.Disposable {
  private client = this.createClient();
  private navigationIntents = new HerdrNavigationIntentStore(this.client);
  private snapshot: HerdrSnapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private disposed = false;
  private terminal: vscode.Terminal | undefined;
  private serverStartAttempted = false;
  private handlingNavigationIntent: string | undefined;
  private readonly reportedSpaceCreationErrors = new Set<string>();
  private readonly closingRoots = new Set<string>();
  private readonly gitBranches = new GitBranchProvider();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: HerdrSnapshotStore,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  async start(): Promise<void> {
    await this.refresh(false);
    await this.reconcileFolders();
    await this.handleWindowActivated();
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  reconfigure(): void {
    this.client = this.createClient();
    this.navigationIntents = new HerdrNavigationIntentStore(this.client);
    this.serverStartAttempted = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    void this.refresh(true).then(() => this.reconcileFolders());
    this.schedule();
  }

  async refresh(showError: boolean): Promise<void> {
    if (this.refreshing || this.disposed) {
      return;
    }
    this.refreshing = true;
    try {
      const snapshot = await this.client.snapshot();
      const branches = await this.gitBranches.forSnapshot(snapshot);
      this.snapshot = snapshot;
      this.store.setSnapshot(snapshot, branches);
      this.serverStartAttempted = false;
    } catch (error) {
      const message = errorMessage(error);
      this.snapshot = undefined;
      this.output.debug(`Snapshot failed: ${message}`);
      this.store.setError("Herdr is not running");
      if (showError) {
        void vscode.window.showErrorMessage(`Herdr: ${message}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  async reconcileFolders(): Promise<void> {
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
      created = await this.ensureSpace(folder.uri.fsPath, folder.name) || created;
    }
    if (created) {
      await this.refresh(false);
    }
  }

  async openSpace(node: SpaceNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Herdr space “${node.workspace.label}” has no folder association.`);
      return;
    }
    if (this.isCurrentRoot(root)) {
      await this.focusSpace(node.workspace.workspace_id, true);
      return;
    }
    await this.publishWorkspaceNavigation(node.workspace.workspace_id);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
  }

  async openAgent(node: AgentNode): Promise<void> {
    const root = this.boundRoot(node.workspace.workspace_id) ?? node.root;
    if (!root) {
      void vscode.window.showWarningMessage(`Agent “${node.agent.name ?? node.agent.pane_id}” has no folder association.`);
      return;
    }
    if (!this.isCurrentRoot(root)) {
      await this.publishAgentNavigation(node.agent.pane_id);
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
      return;
    }
    try {
      await this.prepareTerminal();
      await this.retryFocus(() => this.client.focusAgent(node.agent.pane_id));
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus Herdr agent: ${errorMessage(error)}`);
    }
  }

  async attachSpace(node: SpaceNode): Promise<void> {
    try {
      await this.prepareTerminal();
      await this.retryFocus(() => this.client.focusWorkspace(node.workspace.workspace_id));
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not attach to Herdr space: ${errorMessage(error)}`);
    }
  }

  async showSpaceActions(node: SpaceNode): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [{
        label: "$(trash) Close Space",
        description: node.workspace.label,
        action: "close" as const,
      }],
      { title: `Herdr Space: ${node.workspace.label}`, placeHolder: "Choose an action" },
    );
    if (selected?.action === "close") {
      await this.closeSpace(node);
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
      const accepted = await vscode.window.showWarningMessage(
        `“${node.workspace.label}” has running processes: ${preview}${more}. Close the space and its VS Code window?`,
        { modal: true },
        "Close Anyway",
      );
      if (accepted !== "Close Anyway") {
        return;
      }
    }
    try {
      if (this.isCurrentRoot(root)) {
        await this.closeCurrentWindowSpace(node.workspace.workspace_id, root);
      } else {
        await this.navigationIntents.publishClose(node.workspace.workspace_id);
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
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
    await this.reconcileFolders();
    if (!await this.consumeNavigationIntent()) {
      await this.activateCurrentSpace();
    }
  }

  private async focusSpace(workspaceId: string, revealSidebar: boolean): Promise<void> {
    try {
      if (revealSidebar) {
        await vscode.commands.executeCommand("workbench.view.extension.herdr");
        await vscode.commands.executeCommand("herdr.spaces.focus");
      }
      await this.retryFocus(() => this.client.focusWorkspace(workspaceId));
      await this.refresh(false);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not focus Herdr space: ${errorMessage(error)}`);
    }
  }

  private async activateCurrentSpace(): Promise<void> {
    const workspace = this.currentWorkspace();
    if (workspace) {
      await this.focusSpace(workspace.workspace_id, false);
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

  private async publishAgentNavigation(paneId: string): Promise<void> {
    try {
      await this.navigationIntents.publishAgent(paneId);
      await this.client.focusAgent(paneId);
    } catch (error) {
      this.output.warn(`Could not publish agent navigation intent: ${errorMessage(error)}`);
    }
  }

  private async consumeNavigationIntent(): Promise<boolean> {
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
    if (this.handlingNavigationIntent === intent.requestId) {
      return true;
    }
    this.handlingNavigationIntent = intent.requestId;
    try {
      if (intent.kind === "close") {
        const association = this.currentWorkspaceAssociation();
        if (!association || association.workspace.workspace_id !== intent.workspaceId) {
          return false;
        }
        await this.navigationIntents.acknowledge(intent);
        await this.closeCurrentWindowSpace(intent.workspaceId, association.root);
        return true;
      }
      await vscode.commands.executeCommand("workbench.view.extension.herdr");
      await vscode.commands.executeCommand(intent.kind === "agent" ? "herdr.agents.focus" : "herdr.spaces.focus");
      if (intent.kind === "agent") {
        await this.prepareTerminal();
        await this.retryFocus(() => this.client.focusAgent(intent.paneId));
      } else {
        await this.retryFocus(() => this.client.focusWorkspace(intent.workspaceId));
      }
      await this.navigationIntents.acknowledge(intent);
      await this.refresh(false);
      return true;
    } catch (error) {
      this.output.warn(`Could not consume navigation intent ${intent.requestId}: ${errorMessage(error)}`);
      return false;
    } finally {
      this.handlingNavigationIntent = undefined;
    }
  }

  private async prepareTerminal(): Promise<vscode.Terminal> {
    const candidate = this.terminal && !this.terminal.exitStatus
      ? this.terminal
      : vscode.window.terminals.find((terminal) => terminal.name === this.terminalName());
    const existing = candidate && isTransientTerminal(candidate) ? candidate : undefined;
    if (existing) {
      this.terminal = existing;
      existing.show(false);
      await waitForTerminalProcess(existing);
      return existing;
    }
    if (candidate && isOwnedHerdrTerminal(candidate, this.terminalName())) {
      candidate.dispose();
    }
    const config = vscode.workspace.getConfiguration("herdr");
    this.terminal = vscode.window.createTerminal({
      name: this.terminalName(),
      shellPath: config.get("executable", "herdr"),
      shellArgs: this.client.terminalArgs(),
      iconPath: new vscode.ThemeIcon("terminal"),
      location: {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
      isTransient: true,
    });
    this.terminal.show(false);
    await waitForTerminalProcess(this.terminal);
    return this.terminal;
  }

  private async runningProcesses(workspaceId: string) {
    const panes = this.snapshot?.panes.filter((pane) => pane.workspace_id === workspaceId) ?? [];
    const infos = await Promise.all(panes.map((pane) => this.client.paneProcessInfo(pane.pane_id)));
    return nonShellForegroundProcesses(infos);
  }

  private async closeCurrentWindowSpace(workspaceId: string, root: string): Promise<void> {
    const normalized = normalizeRoot(root);
    this.closingRoots.add(normalized);
    await this.removeBinding(root, workspaceId);
    try {
      await this.client.closeWorkspace(workspaceId);
      await vscode.commands.executeCommand("workbench.action.closeWindow");
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

  private async startConfiguredAgent(agent: ConfiguredAgent): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${agent.name} in Herdr…` },
        async () => {
          await this.refresh(false);
          await this.reconcileFolders();
          const association = this.currentWorkspaceAssociation();
          if (!association || !this.snapshot) {
            throw new Error("The current VS Code folder is not associated with a Herdr space.");
          }
          const { workspace, root } = association;
          await this.prepareTerminal();
          await this.client.focusWorkspace(workspace.workspace_id);
          const created = await this.client.createTab(workspace.workspace_id, root, agent.name);
          try {
            await this.client.runPane(created.root_pane.pane_id, shellCommand(agent.command));
          } catch (error) {
            try {
              await this.client.closeTab(created.tab.tab_id);
            } catch (rollbackError) {
              this.output.warn(`Could not roll back tab ${created.tab.tab_id}: ${errorMessage(rollbackError)}`);
            }
            throw error;
          }
          await this.refresh(false);
        },
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not start Herdr agent: ${errorMessage(error)}`);
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
      const workspace = findWorkspaceForRoot(this.snapshot, folder.uri.fsPath, this.bindings());
      if (workspace) {
        return { workspace, root: folder.uri.fsPath };
      }
    }
    return undefined;
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

  private async ensureSpace(root: string, label: string): Promise<boolean> {
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
      await this.saveBinding(root, existing.workspace_id);
      return false;
    }
    try {
      // Re-read immediately before mutation to reduce duplicate creation across windows.
      this.snapshot = await this.client.snapshot();
      const rechecked = findWorkspaceForRoot(this.snapshot, root, this.bindings());
      if (rechecked) {
        this.reportedSpaceCreationErrors.delete(normalizeRoot(root));
        await this.saveBinding(root, rechecked.workspace_id);
        return false;
      }
      const created = await this.client.createWorkspace(root, label || path.basename(root));
      this.reportedSpaceCreationErrors.delete(normalizeRoot(root));
      await this.saveBinding(root, created.workspace.workspace_id);
      this.output.info(`Created Herdr space ${created.workspace.workspace_id} for ${root}`);
      return true;
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

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    const interval = vscode.workspace.getConfiguration("herdr").get("refreshInterval", 1000);
    this.timer = setTimeout(async () => {
      await this.refresh(false);
      await this.reconcileFolders();
      await this.consumeNavigationIntent();
      this.schedule();
    }, interval);
  }

  private createClient(): HerdrClient {
    const config = vscode.workspace.getConfiguration("herdr");
    const session = config.get<string>("session", "").trim();
    return new HerdrClient({ executable: config.get("executable", "herdr"), session: session || undefined });
  }

  private bindings(): SpaceBinding[] {
    return this.context.globalState.get<SpaceBinding[]>(BINDINGS_KEY, []);
  }

  private async saveBinding(root: string, workspaceId: string): Promise<void> {
    const normalized = normalizeRoot(root);
    const current = this.bindings();
    if (current.some((binding) => normalizeRoot(binding.root) === normalized && binding.workspaceId === workspaceId)) {
      return;
    }
    const next = current.filter((binding) => normalizeRoot(binding.root) !== normalized && binding.workspaceId !== workspaceId);
    next.push({ root, workspaceId });
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

  private isCurrentRoot(root: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((folder) => normalizeRoot(folder.uri.fsPath) === normalizeRoot(root));
  }

  private terminalName(): string {
    const session = vscode.workspace.getConfiguration("herdr").get<string>("session", "").trim();
    return session ? `${TERMINAL_NAME} (${session})` : TERMINAL_NAME;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HerdrCommandError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function synchronizeTreeSelection(
  store: HerdrSnapshotStore,
  spaces: SpacesTreeProvider,
  agents: AgentsTreeProvider,
  spacesView: vscode.TreeView<SpaceNode | { kind: "message"; label: string; icon: string }>,
  agentsView: vscode.TreeView<AgentNode | { kind: "message"; label: string; icon: string }>,
  output: vscode.LogOutputChannel,
): Promise<void> {
  // Tree change events are delivered synchronously, while VS Code rebuilds the
  // visible rows asynchronously. Reveal only after that rebuild can observe the
  // provider's new node generation.
  await delay(0);
  const snapshot = store.snapshot;
  if (!snapshot) {
    return;
  }
  const selection = activeTreeSelection(snapshot);
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
