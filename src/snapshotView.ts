import { agentDisplayName } from "./agentPresentation";
import type { HerdrSnapshot } from "./types";

/** A stable projection containing only state rendered by VS Code views. */
export function snapshotViewKey(
  snapshot: HerdrSnapshot,
  branches: ReadonlyMap<string, string>,
): string {
  return JSON.stringify({
    focus: [
      snapshot.focused_workspace_id,
      snapshot.focused_tab_id,
      snapshot.focused_pane_id,
    ],
    workspaces: snapshot.workspaces
      .map((workspace) => [
        workspace.workspace_id,
        workspace.number,
        workspace.label,
        workspace.tab_count,
        workspace.agent_status,
        workspace.worktree?.checkout_path,
      ])
      .sort(compareFirstString),
    tabs: snapshot.tabs
      .map((tab) => [
        tab.tab_id,
        tab.workspace_id,
        tab.number,
        tab.label,
      ])
      .sort(compareFirstString),
    panes: snapshot.panes
      .map((pane) => [
        pane.pane_id,
        pane.workspace_id,
        pane.tab_id,
        pane.cwd,
      ])
      .sort(compareFirstString),
    agents: snapshot.agents
      .map((agent) => [
        agent.pane_id,
        agent.workspace_id,
        agent.tab_id,
        agent.terminal_id,
        agentDisplayName(agent),
        agent.agent_status,
        agent.state_labels?.[agent.agent_status],
      ])
      .sort(compareFirstString),
    branches: [...branches].sort(([left], [right]) => left.localeCompare(right)),
  });
}

function compareFirstString(
  left: readonly unknown[],
  right: readonly unknown[],
): number {
  return String(left[0]).localeCompare(String(right[0]), undefined, { numeric: true });
}
