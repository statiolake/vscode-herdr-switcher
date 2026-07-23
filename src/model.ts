import * as path from "node:path";
import type { HerdrAgent, HerdrSnapshot, HerdrWorkspace, PaneProcess, PaneProcessInfo } from "./types";

export interface SpaceBinding {
  root: string;
  workspaceId: string;
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

export function agentsForWorkspace(snapshot: HerdrSnapshot, workspaceId: string): HerdrAgent[] {
  return snapshot.agents
    .filter((agent) => agent.workspace_id === workspaceId)
    .sort((left, right) => left.pane_id.localeCompare(right.pane_id, undefined, { numeric: true }));
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
