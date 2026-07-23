import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { HerdrPane, HerdrResponse, HerdrSnapshot, PaneProcessInfo, WorkspaceCreatedResult } from "./types";

export interface HerdrClientOptions {
  executable: string;
  session?: string;
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

  createWorkspace(cwd: string, label: string): Promise<WorkspaceCreatedResult> {
    return this.runJson<WorkspaceCreatedResult>([
      "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
    ]);
  }

  async focusAgent(target: string): Promise<void> {
    await this.runJson(["agent", "focus", target]);
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.runJson(["workspace", "focus", workspaceId]);
  }

  async setWorkspaceToken(workspaceId: string, source: string, key: string, value: string, ttlMs: number): Promise<void> {
    await this.runJson([
      "workspace", "report-metadata", workspaceId,
      "--source", source, "--token", `${key}=${value}`, "--ttl-ms", String(ttlMs),
    ]);
  }

  async clearWorkspaceToken(workspaceId: string, source: string, key: string): Promise<void> {
    await this.runJson([
      "workspace", "report-metadata", workspaceId,
      "--source", source, "--clear-token", key,
    ]);
  }

  async setPaneToken(paneId: string, source: string, key: string, value: string, ttlMs: number): Promise<void> {
    await this.runJson([
      "pane", "report-metadata", paneId,
      "--source", source, "--token", `${key}=${value}`, "--ttl-ms", String(ttlMs),
    ]);
  }

  async clearPaneToken(paneId: string, source: string, key: string): Promise<void> {
    await this.runJson([
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

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.runJson(["workspace", "close", workspaceId]);
  }

  async splitPane(paneId: string, cwd: string): Promise<HerdrPane> {
    const result = await this.runJson<{ pane: HerdrPane }>([
      "pane", "split", "--pane", paneId, "--direction", "right", "--cwd", cwd, "--focus",
    ]);
    return result.pane;
  }

  async runPane(paneId: string, command: string): Promise<void> {
    await this.runJson(["pane", "run", paneId, command]);
  }

  async closePane(paneId: string): Promise<void> {
    await this.runJson(["pane", "close", paneId]);
  }

  terminalArgs(): string[] {
    return this.options.session ? ["--session", this.options.session] : [];
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

  private sessionArgs(): string[] {
    return this.options.session ? ["--session", this.options.session] : [];
  }
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
