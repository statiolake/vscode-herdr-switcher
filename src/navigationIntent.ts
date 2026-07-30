import type { HerdrClient } from "./herdrClient";
import type { HerdrSnapshot } from "./types";

const SOURCE = "vscode-herdr-switcher";
const TOKEN = "vscode-navigation-intent";
const CLOSE_TOKEN = "vscode-close-intent";
const WINDOW_PRESENCE_TOKEN = "vscode-window-presence";
export const NAVIGATION_INTENT_TTL_MS = 60_000;
const CONSUMED_INTENT_LIMIT = 256;

export type NavigationIntent =
  | { requestId: string; workspaceId: string; kind: "workspace" }
  | { requestId: string; workspaceId: string; kind: "attach" }
  | { requestId: string; workspaceId: string; kind: "agent"; paneId: string }
  | { requestId: string; workspaceId: string; kind: "close" };

export class HerdrNavigationIntentStore {
  constructor(private readonly client: HerdrClient) {}

  async publishWorkspace(workspaceId: string): Promise<void> {
    await this.publish(workspaceId, "workspace");
  }

  async publishAgent(workspaceId: string, paneId: string): Promise<void> {
    await this.publish(workspaceId, "agent", paneId);
  }

  async publishAttach(workspaceId: string): Promise<void> {
    await this.publish(workspaceId, "attach");
  }

  async publishClose(workspaceId: string): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, CLOSE_TOKEN, requestId(), NAVIGATION_INTENT_TTL_MS);
  }

  async reportWindowPresence(workspaceId: string, ttlMs: number): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, WINDOW_PRESENCE_TOKEN, "open", ttlMs);
  }

  hasWindowPresence(snapshot: HerdrSnapshot, workspaceId: string): boolean {
    return snapshot.workspaces
      .find((workspace) => workspace.workspace_id === workspaceId)
      ?.tokens?.[WINDOW_PRESENCE_TOKEN] === "open";
  }

  find(snapshot: HerdrSnapshot, workspaceId: string): NavigationIntent | undefined {
    return findNavigationIntent(snapshot, workspaceId);
  }

  async acknowledge(intent: NavigationIntent): Promise<void> {
    await this.client.clearWorkspaceToken(
      intent.workspaceId,
      SOURCE,
      intent.kind === "close" ? CLOSE_TOKEN : TOKEN,
    );
  }

  private async publish(workspaceId: string, kind: "workspace" | "attach" | "agent", paneId?: string): Promise<void> {
    const value = encodeNavigationIntent(requestId(), kind, paneId);
    await this.client.setWorkspaceToken(workspaceId, SOURCE, TOKEN, value, NAVIGATION_INTENT_TTL_MS);
  }
}

export class ConsumedNavigationIntents {
  private readonly requestIds = new Set<string>();

  has(requestId: string): boolean {
    return this.requestIds.has(requestId);
  }

  add(requestId: string): void {
    this.requestIds.delete(requestId);
    this.requestIds.add(requestId);
    while (this.requestIds.size > CONSUMED_INTENT_LIMIT) {
      const oldest = this.requestIds.values().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.requestIds.delete(oldest);
    }
  }
}

export function findNavigationIntent(
  snapshot: HerdrSnapshot,
  workspaceId: string,
): NavigationIntent | undefined {
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  const closeRequestId = workspace?.tokens?.[CLOSE_TOKEN];
  if (closeRequestId) {
    return { requestId: closeRequestId, workspaceId, kind: "close" };
  }
  const value = workspace?.tokens?.[TOKEN];
  return value ? decodeNavigationIntent(value, workspaceId, snapshot) : undefined;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function encodeNavigationIntent(
  requestId: string,
  kind: "workspace" | "attach" | "agent",
  paneId?: string,
): string {
  const code = kind === "workspace" ? "w" : kind === "attach" ? "t" : "a";
  return paneId ? `v1|${requestId}|${code}|${paneId}` : `v1|${requestId}|${code}`;
}

function decodeNavigationIntent(
  value: string,
  workspaceId: string,
  snapshot: HerdrSnapshot,
): NavigationIntent | undefined {
  const [version, requestId, code, paneId] = value.split("|");
  if (version !== "v1" || !requestId) {
    return undefined;
  }
  if (code === "w") {
    return { requestId, workspaceId, kind: "workspace" };
  }
  if (code === "t") {
    return { requestId, workspaceId, kind: "attach" };
  }
  if (
    code === "a"
    && paneId
    && snapshot.panes.some((pane) => pane.pane_id === paneId && pane.workspace_id === workspaceId)
  ) {
    return { requestId, workspaceId, kind: "agent", paneId };
  }
  return undefined;
}
