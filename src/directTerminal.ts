import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import { terminalInputCommands } from "./terminalInput";

export interface DirectTerminalOptions {
  executable: string;
  args(columns: number, rows: number): readonly string[];
  onClosed?(): void;
  onError?(message: string): void;
}

interface TerminalFrameRecord {
  type?: string;
  bytes?: string;
}

// `herdr terminal session control` forwards rendered ANSI frames and input
// commands as JSON, but Herdr 0.8 does not expose its separate MouseCapture
// server message through that JSON stream. Enable button/wheel reporting so
// xterm.js reports scroll input to the pseudoterminal. Deliberately omit
// motion/drag reporting: those events would reset Herdr's viewport and would
// prevent VS Code's native text selection from working.
const ENABLE_MOUSE_CAPTURE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_CAPTURE = "\u001b[?1006l\u001b[?1000l";

/** A VS Code terminal backed by Herdr's terminal session control bridge. */
export class HerdrDirectTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private lineBuffer = "";
  private readonly decoder = new TextDecoder("utf-8");
  private dimensions: { columns: number; rows: number } | undefined;
  private closeTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private closing = false;
  private stderr = "";
  private mouseCaptureEnabled = false;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(private readonly options: DirectTerminalOptions) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (this.child || this.closed) {
      return;
    }
    const columns = positiveDimension(initialDimensions?.columns, 80);
    const rows = positiveDimension(initialDimensions?.rows, 24);
    this.dimensions = { columns, rows };
    try {
      const child = spawn(this.options.executable, [...this.options.args(columns, rows)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.writeEmitter.fire(ENABLE_MOUSE_CAPTURE);
      this.mouseCaptureEnabled = true;
      child.stdout.on("data", (chunk: Buffer | string) => this.handleOutput(chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        this.stderr += chunk;
        if (this.stderr.length > 4_096) {
          this.stderr = this.stderr.slice(-4_096);
        }
      });
      child.stdin.on("error", (error) => {
        if (!this.closing) {
          this.reportError(`Herdr terminal input failed: ${error.message}`);
        }
      });
      child.once("error", (error) => {
        this.reportError(`Could not start Herdr terminal control: ${error.message}`);
        this.finish();
      });
      child.once("close", () => {
        if (this.stderr.trim()) {
          this.reportError(this.stderr.trim());
        }
        this.finish();
      });
    } catch (error) {
      this.reportError(`Could not start Herdr terminal control: ${errorMessage(error)}`);
      this.finish();
    }
  }

  close(): void {
    if (this.closed || this.closing) {
      return;
    }
    this.closing = true;
    if (!this.child) {
      this.finish();
      return;
    }
    this.send({ type: "terminal.release" });
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.child?.kill();
    }, 750);
  }

  handleInput(data: string): void {
    if (this.closed || this.closing || !data) {
      return;
    }
    for (const command of terminalInputCommands(data, { rows: this.dimensions?.rows })) {
      if (command.kind === "input") {
        this.send({
          type: "terminal.input",
          bytes: Buffer.from(command.data, "utf8").toString("base64"),
        });
      } else {
        this.send(command.command);
      }
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const next = {
      columns: positiveDimension(dimensions.columns, 80),
      rows: positiveDimension(dimensions.rows, 24),
    };
    if (this.dimensions?.columns === next.columns && this.dimensions?.rows === next.rows) {
      return;
    }
    this.dimensions = next;
    if (!this.closed && !this.closing) {
      this.send({ type: "terminal.resize", cols: next.columns, rows: next.rows });
    }
  }

  dispose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private handleOutput(chunk: Buffer | string): void {
    this.lineBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.handleRecord(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private handleRecord(line: string): void {
    if (!line.trim()) {
      return;
    }
    let record: TerminalFrameRecord;
    try {
      record = JSON.parse(line) as TerminalFrameRecord;
    } catch (error) {
      this.reportError(`Herdr terminal control returned invalid JSON: ${String(error)}`);
      return;
    }
    if (record.type === "terminal.frame" && typeof record.bytes === "string") {
      try {
        const bytes = Buffer.from(record.bytes, "base64");
        const text = this.decoder.decode(bytes, { stream: true });
        if (text) {
          this.writeEmitter.fire(text);
        }
      } catch (error) {
        this.reportError(`Could not decode Herdr terminal frame: ${String(error)}`);
      }
      return;
    }
    if (record.type === "terminal.closed") {
      this.finish();
    }
  }

  private send(command: object): void {
    if (!this.child?.stdin.writable || this.closed) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.reportError(`Could not send input to Herdr terminal: ${errorMessage(error)}`);
    }
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closing = true;
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    const trailing = this.decoder.decode();
    if (trailing) {
      this.writeEmitter.fire(trailing);
    }
    if (this.mouseCaptureEnabled) {
      this.writeEmitter.fire(DISABLE_MOUSE_CAPTURE);
      this.mouseCaptureEnabled = false;
    }
    this.closeEmitter.fire();
    this.options.onClosed?.();
  }

  private reportError(message: string): void {
    this.options.onError?.(message);
  }
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
