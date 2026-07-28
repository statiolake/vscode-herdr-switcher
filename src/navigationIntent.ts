import type { HerdrClient } from "./herdrClient";
import type { HerdrSnapshot } from "./types";

const SOURCE = "vscode-herdr-switcher";
const TOKEN = "vscode-navigation-intent";
const ATTACH_TOKEN = "vscode-attach-intent";
const CLOSE_TOKEN = "vscode-close-intent";
const WINDOW_PRESENCE_TOKEN = "vscode-window-presence";
export const NAVIGATION_INTENT_TTL_MS = 60_000;

export type NavigationIntent =
  | { requestId: string; workspaceId: string; kind: "workspace" }
  | { requestId: string; workspaceId: string; kind: "attach" }
  | { requestId: string; workspaceId: string; kind: "agent"; paneId: string }
  | { requestId: string; workspaceId: string; kind: "close" };

export class HerdrNavigationIntentStore {
  constructor(private readonly client: HerdrClient) {}

  async publishWorkspace(workspaceId: string): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, TOKEN, requestId(), NAVIGATION_INTENT_TTL_MS);
  }

  async publishAgent(paneId: string): Promise<void> {
    await this.client.setPaneToken(paneId, SOURCE, TOKEN, requestId(), NAVIGATION_INTENT_TTL_MS);
  }

  async publishAttach(workspaceId: string): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, ATTACH_TOKEN, requestId(), NAVIGATION_INTENT_TTL_MS);
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
    if (intent.kind === "agent") {
      await this.client.clearPaneToken(intent.paneId, SOURCE, TOKEN);
      return;
    }
    await this.client.clearWorkspaceToken(
      intent.workspaceId,
      SOURCE,
      intent.kind === "close" ? CLOSE_TOKEN : intent.kind === "attach" ? ATTACH_TOKEN : TOKEN,
    );
  }
}

export class ConsumedNavigationIntents {
  private readonly expirations = new Map<string, number>();

  has(requestId: string, now = Date.now()): boolean {
    this.prune(now);
    return (this.expirations.get(requestId) ?? 0) > now;
  }

  add(requestId: string, now = Date.now()): void {
    this.prune(now);
    this.expirations.set(requestId, now + NAVIGATION_INTENT_TTL_MS);
  }

  private prune(now: number): void {
    for (const [requestId, expiresAt] of this.expirations) {
      if (expiresAt <= now) {
        this.expirations.delete(requestId);
      }
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
  const pane = snapshot.panes.find((candidate) =>
    candidate.workspace_id === workspaceId && candidate.tokens?.[TOKEN],
  );
  const paneRequestId = pane?.tokens?.[TOKEN];
  if (pane && paneRequestId) {
    return { requestId: paneRequestId, workspaceId, kind: "agent", paneId: pane.pane_id };
  }
  const attachRequestId = workspace?.tokens?.[ATTACH_TOKEN];
  if (attachRequestId) {
    return { requestId: attachRequestId, workspaceId, kind: "attach" };
  }
  const workspaceRequestId = workspace?.tokens?.[TOKEN];
  return workspaceRequestId
    ? { requestId: workspaceRequestId, workspaceId, kind: "workspace" }
    : undefined;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
