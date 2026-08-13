import * as path from "node:path";
import type { HerdrAgent, HerdrSnapshot, HerdrWorkspace, PaneProcess, PaneProcessInfo } from "./types";

export interface SpaceBinding {
  root: string;
  workspaceId: string;
  workspaceUri?: string;
}

export function normalizeRoot(value: string): string {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const withoutTrailingSeparator = resolved.length > parsed.root.length
    ? resolved.replace(/[\\/]+$/, "")
    : resolved;
  return process.platform === "win32" ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

export function rootsEqual(left: string | undefined, right: string): boolean {
  return left !== undefined && normalizeRoot(left) === normalizeRoot(right);
}

export function inferWorkspaceRoot(snapshot: HerdrSnapshot, workspace: HerdrWorkspace): string | undefined {
  if (workspace.worktree?.checkout_path) {
    return workspace.worktree.checkout_path;
  }
  const panes = snapshot.panes
    .filter((pane) => pane.workspace_id === workspace.workspace_id && pane.cwd)
    .sort((left, right) => paneOrdinal(left.pane_id) - paneOrdinal(right.pane_id));
  return panes[0]?.cwd;
}

export function findWorkspaceForRoot(
  snapshot: HerdrSnapshot,
  root: string,
  bindings: readonly SpaceBinding[],
): HerdrWorkspace | undefined {
  const normalizedRoot = normalizeRoot(root);
  const binding = bindings.find((candidate) => normalizeRoot(candidate.root) === normalizedRoot);
  if (binding) {
    const bound = snapshot.workspaces.find((workspace) => workspace.workspace_id === binding.workspaceId);
    if (bound) {
      return bound;
    }
  }
  return snapshot.workspaces.find((workspace) => rootsEqual(inferWorkspaceRoot(snapshot, workspace), root));
}

export type WorkspaceNavigationDirection = "next" | "previous";

export function workspacesInDisplayOrder(snapshot: HerdrSnapshot): HerdrWorkspace[] {
  return [...snapshot.workspaces].sort((left, right) =>
    left.number - right.number
    || left.workspace_id.localeCompare(right.workspace_id, undefined, { numeric: true }),
  );
}

/** Returns the Space adjacent to the current VS Code folder in display order. */
export function adjacentWorkspace(
  snapshot: HerdrSnapshot,
  currentWorkspaceId: string | undefined,
  direction: WorkspaceNavigationDirection,
): HerdrWorkspace | undefined {
  const ordered = workspacesInDisplayOrder(snapshot);
  if (ordered.length === 0) {
    return undefined;
  }

  const effectiveWorkspaceId = currentWorkspaceId ?? snapshot.focused_workspace_id;
  const currentIndex = effectiveWorkspaceId
    ? ordered.findIndex((workspace) => workspace.workspace_id === effectiveWorkspaceId)
    : -1;
  if (currentIndex < 0) {
    return direction === "next" ? ordered[0] : ordered[ordered.length - 1];
  }

  const offset = direction === "next" ? 1 : -1;
  return ordered[(currentIndex + offset + ordered.length) % ordered.length];
}

export function agentsForWorkspace(snapshot: HerdrSnapshot, workspaceId: string): HerdrAgent[] {
  return agentsInDisplayOrder(snapshot).filter((agent) => agent.workspace_id === workspaceId);
}

export function agentsInDisplayOrder(snapshot: HerdrSnapshot): HerdrAgent[] {
  return [...snapshot.agents].sort((left, right) =>
    workspaceOrdinal(snapshot, left.workspace_id) - workspaceOrdinal(snapshot, right.workspace_id)
    || tabOrdinal(snapshot, left.tab_id) - tabOrdinal(snapshot, right.tab_id)
    || paneOrdinal(left.pane_id) - paneOrdinal(right.pane_id)
    || left.pane_id.localeCompare(right.pane_id, undefined, { numeric: true }),
  );
}

export type AgentNavigationDirection = "next" | "previous";

/**
 * Returns the agent adjacent to Herdr's current focus in the global Agents
 * order. When focus is not an agent in the current VS Code space, navigation
 * starts at that space's first or last agent instead.
 */
export function adjacentAgent(
  snapshot: HerdrSnapshot,
  currentWorkspaceId: string | undefined,
  direction: AgentNavigationDirection,
): HerdrAgent | undefined {
  const ordered = agentsInDisplayOrder(snapshot);
  if (ordered.length === 0) {
    return undefined;
  }

  const focusedIndex = snapshot.focused_pane_id
    ? ordered.findIndex((agent) => agent.pane_id === snapshot.focused_pane_id)
    : -1;
  const focusedAgent = focusedIndex >= 0 ? ordered[focusedIndex] : undefined;
  if (focusedAgent && (!currentWorkspaceId || focusedAgent.workspace_id === currentWorkspaceId)) {
    const offset = direction === "next" ? 1 : -1;
    return ordered[(focusedIndex + offset + ordered.length) % ordered.length];
  }

  const scoped = currentWorkspaceId
    ? ordered.filter((agent) => agent.workspace_id === currentWorkspaceId)
    : ordered;
  return direction === "next" ? scoped[0] : scoped[scoped.length - 1];
}

export function activeAgentForWorkspace(snapshot: HerdrSnapshot, workspaceId: string): HerdrAgent | undefined {
  if (!snapshot.focused_pane_id) {
    return undefined;
  }
  return snapshot.agents.find((agent) =>
    agent.workspace_id === workspaceId && agent.pane_id === snapshot.focused_pane_id,
  );
}

export interface ActiveTreeSelection {
  workspaceId?: string;
  agentPaneId?: string;
}

export function activeTreeSelection(snapshot: HerdrSnapshot): ActiveTreeSelection {
  const pane = snapshot.focused_pane_id
    ? snapshot.panes.find((candidate) => candidate.pane_id === snapshot.focused_pane_id)
    : undefined;
  const agentPaneId = pane && snapshot.agents.some((agent) => agent.pane_id === pane.pane_id)
    ? pane.pane_id
    : undefined;
  return {
    workspaceId: pane?.workspace_id ?? snapshot.focused_workspace_id,
    agentPaneId,
  };
}

export function nonShellForegroundProcesses(infos: readonly PaneProcessInfo[]): PaneProcess[] {
  return infos.flatMap((info) =>
    info.foreground_processes.filter((process) => process.pid !== info.shell_pid),
  );
}

function paneOrdinal(paneId: string): number {
  const match = /:p([0-9A-Z]+)$/i.exec(paneId);
  if (!match?.[1]) {
    return Number.MAX_SAFE_INTEGER;
  }
  const decimal = Number(match[1]);
  return Number.isFinite(decimal) ? decimal : Number.MAX_SAFE_INTEGER - 1;
}

function workspaceOrdinal(snapshot: HerdrSnapshot, workspaceId: string): number {
  return snapshot.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.number
    ?? Number.MAX_SAFE_INTEGER;
}

function tabOrdinal(snapshot: HerdrSnapshot, tabId: string): number {
  return snapshot.tabs.find((tab) => tab.tab_id === tabId)?.number
    ?? Number.MAX_SAFE_INTEGER;
}
