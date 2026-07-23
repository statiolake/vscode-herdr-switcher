import type { HerdrClient } from "./herdrClient";
import type { HerdrSnapshot } from "./types";

const SOURCE = "vscode-herdr-switcher";
const TOKEN = "vscode-navigation-intent";
const CLOSE_TOKEN = "vscode-close-intent";
const TTL_MS = 60_000;

export type NavigationIntent =
  | { requestId: string; workspaceId: string; kind: "workspace" }
  | { requestId: string; workspaceId: string; kind: "agent"; paneId: string }
  | { requestId: string; workspaceId: string; kind: "close" };

export class HerdrNavigationIntentStore {
  constructor(private readonly client: HerdrClient) {}

  async publishWorkspace(workspaceId: string): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, TOKEN, requestId(), TTL_MS);
  }

  async publishAgent(paneId: string): Promise<void> {
    await this.client.setPaneToken(paneId, SOURCE, TOKEN, requestId(), TTL_MS);
  }

  async publishClose(workspaceId: string): Promise<void> {
    await this.client.setWorkspaceToken(workspaceId, SOURCE, CLOSE_TOKEN, requestId(), TTL_MS);
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
      intent.workspaceId, SOURCE, intent.kind === "close" ? CLOSE_TOKEN : TOKEN,
    );
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
  const workspaceRequestId = workspace?.tokens?.[TOKEN];
  return workspaceRequestId
    ? { requestId: workspaceRequestId, workspaceId, kind: "workspace" }
    : undefined;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
