import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  HerdrResponse,
  HerdrSnapshot,
  PaneProcessInfo,
  TabCreatedResult,
  WorkspaceCreatedResult,
} from "./types";

export interface HerdrClientOptions {
  executable: string;
  session?: string;
}

export interface HerdrServerStatus {
  running: boolean;
  socket: string;
  version?: string | null;
  protocol?: number | null;
  session?: string | null;
}

export type HerdrPaneReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export interface HerdrPaneReadOptions {
  source?: HerdrPaneReadSource;
  lines?: number;
}

export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

export class HerdrClient {
  constructor(private readonly options: HerdrClientOptions) {}

  async snapshot(): Promise<HerdrSnapshot> {
    const result = await this.runJson<{ snapshot: HerdrSnapshot }>(["api", "snapshot"]);
    return result.snapshot;
  }

  async serverStatus(): Promise<HerdrServerStatus> {
    const result = await this.runRawJson<HerdrServerStatus>(["status", "server", "--json"]);
    if (typeof result.socket !== "string" || result.socket.trim() === "") {
      throw new HerdrCommandError("herdr status did not report an API socket", "", 0);
    }
    return result;
  }

  createWorkspace(cwd: string, label: string): Promise<WorkspaceCreatedResult> {
    return this.runJson<WorkspaceCreatedResult>([
      "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
    ]);
  }

  async focusAgent(target: string): Promise<void> {
    await this.runVoid(["agent", "focus", target]);
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.runVoid(["workspace", "focus", workspaceId]);
  }

  async setWorkspaceToken(workspaceId: string, source: string, key: string, value: string, ttlMs: number): Promise<void> {
    await this.runVoid([
      "workspace", "report-metadata", workspaceId,
      "--source", source, "--token", `${key}=${value}`, "--ttl-ms", String(ttlMs),
    ]);
  }

  async clearWorkspaceToken(workspaceId: string, source: string, key: string): Promise<void> {
    await this.runVoid([
      "workspace", "report-metadata", workspaceId,
      "--source", source, "--clear-token", key,
    ]);
  }

  async setPaneToken(paneId: string, source: string, key: string, value: string, ttlMs: number): Promise<void> {
    await this.runVoid([
      "pane", "report-metadata", paneId,
      "--source", source, "--token", `${key}=${value}`, "--ttl-ms", String(ttlMs),
    ]);
  }

  async clearPaneToken(paneId: string, source: string, key: string): Promise<void> {
    await this.runVoid([
      "pane", "report-metadata", paneId,
      "--source", source, "--clear-token", key,
    ]);
  }

  async paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
    const result = await this.runJson<{ process_info: PaneProcessInfo }>([
      "pane", "process-info", "--pane", paneId,
    ]);
    return { ...result.process_info, foreground_processes: result.process_info.foreground_processes ?? [] };
  }

  paneReadArgs(paneId: string, options: HerdrPaneReadOptions = {}): string[] {
    const source = options.source ?? "recent-unwrapped";
    const lines = normalizeReadLines(options.lines ?? 1_000);
    return [
      "pane", "read", paneId,
      "--source", source,
      "--lines", String(lines),
      "--format", "text",
    ];
  }

  async readPane(paneId: string, options: HerdrPaneReadOptions = {}): Promise<string> {
    return this.runText(this.paneReadArgs(paneId, options));
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await this.runVoid(["pane", "rename", paneId, label]);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.runVoid(["tab", "rename", tabId, label]);
  }

  async closePane(paneId: string): Promise<void> {
    await this.runVoid(["pane", "close", paneId]);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.runVoid(["workspace", "close", workspaceId]);
  }

  createTab(workspaceId: string, cwd: string, label?: string): Promise<TabCreatedResult> {
    const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd];
    if (label !== undefined) {
      args.push("--label", label);
    }
    args.push("--focus");
    return this.runJson<TabCreatedResult>(args);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.runVoid(["tab", "close", tabId]);
  }

  async startAgent(name: string, kind: string, paneId: string, args: readonly string[] = []): Promise<void> {
    const command = ["agent", "start", name, "--kind", kind, "--pane", paneId];
    if (args.length > 0) {
      command.push("--", ...args);
    }
    await this.runJson<unknown>(command);
  }

  async runPane(paneId: string, command: string): Promise<void> {
    await this.runVoid(["pane", "run", paneId, command]);
  }

  terminalArgs(): string[] {
    return this.options.session ? ["--session", this.options.session] : [];
  }

  agentAttachArgs(target: string): string[] {
    return [...this.sessionArgs(), "agent", "attach", target, "--takeover"];
  }

  terminalSessionControlArgs(target: string, columns = 80, rows = 24): string[] {
    return [
      ...this.sessionArgs(),
      "terminal", "session", "control", target,
      "--takeover",
      "--cols", String(Math.max(1, Math.floor(columns))),
      "--rows", String(Math.max(1, Math.floor(rows))),
    ];
  }

  startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, [...this.sessionArgs(), "server"], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.removeListener("error", reject);
        child.on("error", () => undefined);
        child.unref();
        resolve();
      });
    });
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const { stdout, stderr, exitCode } = await run(this.options.executable, [...this.sessionArgs(), ...args]);
    if (exitCode !== 0) {
      throw new HerdrCommandError(stderr.trim() || `herdr exited with code ${exitCode}`, stderr, exitCode);
    }
    let response: HerdrResponse<T>;
    try {
      response = JSON.parse(stdout) as HerdrResponse<T>;
    } catch (error) {
      throw new HerdrCommandError(`herdr returned invalid JSON: ${String(error)}`, stderr, exitCode);
    }
    if (response.error || response.result === undefined) {
      throw new HerdrCommandError(response.error?.message ?? "herdr returned no result", stderr, exitCode);
    }
    return response.result;
  }

  private async runRawJson<T>(args: string[]): Promise<T> {
    const { stdout, stderr, exitCode } = await run(this.options.executable, [...this.sessionArgs(), ...args]);
    if (exitCode !== 0) {
      throw new HerdrCommandError(stderr.trim() || `herdr exited with code ${exitCode}`, stderr, exitCode);
    }
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new HerdrCommandError(`herdr returned invalid JSON: ${String(error)}`, stderr, exitCode);
    }
  }

  private async runVoid(args: string[]): Promise<void> {
    const { stdout, stderr, exitCode } = await run(this.options.executable, [...this.sessionArgs(), ...args]);
    if (exitCode !== 0) {
      throw new HerdrCommandError(stderr.trim() || `herdr exited with code ${exitCode}`, stderr, exitCode);
    }
    if (stdout.trim() === "") {
      return;
    }
    let response: HerdrResponse<unknown>;
    try {
      response = JSON.parse(stdout) as HerdrResponse<unknown>;
    } catch (error) {
      throw new HerdrCommandError(`herdr returned invalid JSON: ${String(error)}`, stderr, exitCode);
    }
    if (response.error) {
      throw new HerdrCommandError(response.error.message, stderr, exitCode);
    }
  }

  private async runText(args: string[]): Promise<string> {
    const { stdout, stderr, exitCode } = await run(this.options.executable, [...this.sessionArgs(), ...args]);
    if (exitCode !== 0) {
      throw new HerdrCommandError(stderr.trim() || `herdr exited with code ${exitCode}`, stderr, exitCode);
    }
    return stdout;
  }

  private sessionArgs(): string[] {
    return this.options.session ? ["--session", this.options.session] : [];
  }
}

function normalizeReadLines(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(5_000, Math.floor(value))) : 1_000;
}

function run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, { stdio: "pipe" });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
