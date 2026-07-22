import * as path from "node:path";
import * as vscode from "vscode";
import { GitBranchProvider } from "./gitBranchProvider";
import { HerdrClient, HerdrCommandError } from "./herdrClient";
import { findWorkspaceForRoot, normalizeRoot, type SpaceBinding } from "./model";
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
  const controller = new HerdrController(context, store, output);
  context.subscriptions.push(
    output,
    store,
    spaces,
    agents,
    vscode.window.registerTreeDataProvider("herdr.spaces", spaces),
    vscode.window.registerTreeDataProvider("herdr.agents", agents),
    vscode.commands.registerCommand("herdr.refresh", () => controller.refresh(true)),
    vscode.commands.registerCommand("herdr.openSpace", (node: SpaceNode) => controller.openSpace(node)),
    vscode.commands.registerCommand("herdr.openAgent", (node: AgentNode) => controller.openAgent(node)),
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
    if (!vscode.window.state.focused || !this.snapshot) {
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
    if (this.handlingNavigationIntent === intent.requestId) {
      return true;
    }
    this.handlingNavigationIntent = intent.requestId;
    try {
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

  private currentWorkspace() {
    if (!this.snapshot) {
      return undefined;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const workspace = findWorkspaceForRoot(this.snapshot, folder.uri.fsPath, this.bindings());
      if (workspace) {
        return workspace;
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
