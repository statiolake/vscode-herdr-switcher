import assert from "node:assert/strict";
import test from "node:test";
import { snapshotViewKey } from "./snapshotView";
import type { HerdrSnapshot } from "./types";

function snapshot(): HerdrSnapshot {
  return {
    version: "test",
    protocol: 1,
    focused_workspace_id: "w1",
    focused_tab_id: "t1",
    focused_pane_id: "p1",
    workspaces: [{
      workspace_id: "w1",
      number: 1,
      label: "Project",
      focused: true,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: "t1",
      agent_status: "working",
      tokens: { intent: "one" },
    }],
    tabs: [{
      tab_id: "t1",
      workspace_id: "w1",
      label: "Agent",
      number: 1,
      focused: true,
      pane_count: 1,
      agent_status: "working",
    }],
    panes: [{
      pane_id: "p1",
      workspace_id: "w1",
      tab_id: "t1",
      cwd: "/project",
      tokens: { intent: "one" },
    }],
    agents: [{
      terminal_id: "terminal-1",
      name: "Claude",
      agent_status: "working",
      workspace_id: "w1",
      tab_id: "t1",
      pane_id: "p1",
      focused: true,
      tokens: { metadata: "one" },
    }],
  };
}

test("view key ignores metadata that is not rendered", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.workspaces[0]!.tokens = { intent: "two" };
  after.panes[0]!.tokens = { intent: "two" };
  after.agents[0]!.tokens = { metadata: "two" };
  assert.equal(snapshotViewKey(before, new Map()), snapshotViewKey(after, new Map()));
});

test("view key changes for rendered agent and branch state", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.agents[0]!.agent_status = "done";
  assert.notEqual(snapshotViewKey(before, new Map()), snapshotViewKey(after, new Map()));
  assert.notEqual(
    snapshotViewKey(before, new Map([["w1", "main"]])),
    snapshotViewKey(before, new Map([["w1", "feature"]])),
  );
});
