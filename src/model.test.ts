import assert from "node:assert/strict";
import test from "node:test";
import { activeTreeSelection, agentsForWorkspace, findWorkspaceForRoot, inferWorkspaceRoot, nonShellForegroundProcesses, normalizeRoot } from "./model";
import type { HerdrSnapshot } from "./types";

const snapshot: HerdrSnapshot = {
  version: "0.7.5",
  protocol: 11,
  workspaces: [
    { workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" },
    { workspace_id: "w2", number: 2, label: "two", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "idle", worktree: { repo_root: "/repo", checkout_path: "/repo-two" } },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: true, pane_count: 2, agent_status: "working" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" },
  ],
  panes: [
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo/subdir" },
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo-one" },
  ],
  agents: [
    { terminal_id: "t2", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", focused: false },
    { terminal_id: "t1", agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true },
  ],
};

test("infers ordinary space root from its first pane and worktree root from provenance", () => {
  assert.equal(inferWorkspaceRoot(snapshot, snapshot.workspaces[0]!), "/repo-one");
  assert.equal(inferWorkspaceRoot(snapshot, snapshot.workspaces[1]!), "/repo-two");
});

test("a valid persistent binding wins over inferred cwd", () => {
  const found = findWorkspaceForRoot(snapshot, "/bound/root", [{ root: "/bound/root/", workspaceId: "w1" }]);
  assert.equal(found?.workspace_id, "w1");
});

test("a stale binding falls back to exact root inference", () => {
  const found = findWorkspaceForRoot(snapshot, "/repo-one", [{ root: "/repo-one", workspaceId: "closed" }]);
  assert.equal(found?.workspace_id, "w1");
});

test("agents are grouped and pane-sorted", () => {
  assert.deepEqual(agentsForWorkspace(snapshot, "w1").map((agent) => agent.pane_id), ["w1:p1", "w1:p2"]);
});

test("normalization removes trailing separators", () => {
  assert.equal(normalizeRoot("/repo-one/"), normalizeRoot("/repo-one"));
});

test("tree selection follows the active agent pane", () => {
  const value = structuredClone(snapshot);
  value.focused_pane_id = "w1:p2";
  assert.deepEqual(activeTreeSelection(value), { workspaceId: "w1", agentPaneId: "w1:p2" });
});

test("tree selection clears the agent for a non-agent pane", () => {
  const value = structuredClone(snapshot);
  value.panes.push({ pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1" });
  value.focused_pane_id = "w1:p3";
  assert.deepEqual(activeTreeSelection(value), { workspaceId: "w1", agentPaneId: undefined });
});

test("close confirmation ignores shells but keeps other foreground processes", () => {
  assert.deepEqual(nonShellForegroundProcesses([
    {
      pane_id: "w1:p1",
      shell_pid: 10,
      foreground_processes: [
        { pid: 10, name: "zsh" },
        { pid: 20, name: "codex" },
      ],
    },
  ]), [{ pid: 20, name: "codex" }]);
});
