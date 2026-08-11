import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { HerdrClient } from "./herdrClient";

export interface HerdrEventRecord {
  event?: string;
  data?: unknown;
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface HerdrEventSubscriberCallbacks {
  onEvent(event: HerdrEventRecord): void;
  onConnected(): void;
  onDisconnected(): void;
}

const EVENT_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

export function eventSubscriptionRequest(requestId: string, paneIds: readonly string[]): string {
  const subscriptions = [
    ...EVENT_SUBSCRIPTIONS.map((type) => ({ type })),
    ...[...new Set(paneIds)].sort().map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
  ];
  return JSON.stringify({
    id: requestId,
    method: "events.subscribe",
    params: { subscriptions },
  }) + "\n";
}

/**
 * Maintains one long-lived raw Herdr socket subscription.
 *
 * The CLI intentionally has no streaming-events wrapper, so this small
 * adapter is kept separate from HerdrClient's request/response helpers. It
 * reconnects only when the controller asks it to connect again; the
 * controller's normal fallback refresh then remains the recovery mechanism
 * when a Herdr server restarts.
 */
export class HerdrEventSubscriber {
  private socket: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private connected = false;
  private disposed = false;
  private paneIds: string[] = [];

  constructor(
    private readonly client: HerdrClient,
    private readonly callbacks: HerdrEventSubscriberCallbacks,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  setPaneIds(paneIds: readonly string[]): boolean {
    const next = [...new Set(paneIds)].sort();
    if (next.length === this.paneIds.length && next.every((value, index) => value === this.paneIds[index])) {
      return false;
    }
    this.paneIds = next;
    // Parameterized agent-status subscriptions are part of the initial
    // events.subscribe request, so reconnect when the set of agents changes.
    this.disconnect();
    return true;
  }

  async connectIfNeeded(): Promise<void> {
    if (this.disposed || this.connected) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }
    const attempt = this.connectOnce();
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = undefined;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  private async connectOnce(): Promise<void> {
    const status = await this.client.serverStatus();
    if (!status.running) {
      throw new Error("Herdr server is not running");
    }

    const socket = connect(status.socket);
    this.socket = socket;
    socket.setEncoding("utf8");

    const requestId = `vscode-herdr-switcher:${randomUUID()}`;
    const request = eventSubscriptionRequest(requestId, this.paneIds);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let lineBuffer = "";
      const timeout = setTimeout(() => {
        fail(new Error("timed out subscribing to Herdr events"));
      }, 5_000);

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          this.connected = true;
          this.callbacks.onConnected();
          resolve();
        }
      };

      const fail = (error: Error): void => {
        this.closeSocket(socket);
        finish(error);
      };

      const handleLine = (line: string): void => {
        if (!line.trim()) {
          return;
        }
        let value: HerdrEventRecord;
        try {
          value = JSON.parse(line) as HerdrEventRecord;
        } catch (error) {
          fail(new Error(`Herdr event stream returned invalid JSON: ${String(error)}`));
          return;
        }
        if (value.id === requestId) {
          if (value.error) {
            fail(new Error(value.error.message ?? value.error.code ?? "Herdr rejected event subscription"));
          } else {
            finish();
          }
          return;
        }
        if (typeof value.event === "string") {
          this.callbacks.onEvent(value);
        }
      };

      socket.on("connect", () => {
        socket.write(request, (error) => {
          if (error) {
            fail(error);
          }
        });
      });
      socket.on("data", (chunk: string | Buffer) => {
        lineBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          handleLine(line.replace(/\r$/, ""));
          newline = lineBuffer.indexOf("\n");
        }
      });
      socket.once("error", (error) => {
        fail(error);
      });
      socket.once("close", () => {
        this.clearSocket(socket);
        if (!settled) {
          finish(new Error("Herdr event socket closed before subscription was acknowledged"));
        }
      });
    });
  }

  private disconnect(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.clearSocket(socket);
    socket.destroy();
  }

  private closeSocket(socket: Socket): void {
    if (this.socket === socket) {
      this.clearSocket(socket);
    }
    socket.destroy();
  }

  private clearSocket(socket: Socket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) {
      this.callbacks.onDisconnected();
    }
  }
}
