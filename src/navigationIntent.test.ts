import assert from "node:assert/strict";
import test from "node:test";
import { findNavigationIntent } from "./navigationIntent";
import type { HerdrSnapshot } from "./types";

function snapshot(): HerdrSnapshot {
  return {
    version: "0.7.5",
    protocol: 11,
    workspaces: [
      { workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
      { workspace_id: "w2", number: 2, label: "two", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "idle" },
    ],
    tabs: [],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" },
    ],
    agents: [],
  };
}

test("finds an agent intent only in the target workspace", () => {
  const value = snapshot();
  value.panes[1]!.tokens = { "vscode-navigation-intent": "request-2" };
  assert.equal(findNavigationIntent(value, "w1"), undefined);
  assert.deepEqual(findNavigationIntent(value, "w2"), {
    requestId: "request-2", workspaceId: "w2", kind: "agent", paneId: "w2:p1",
  });
});

test("prefers a pane intent over a workspace intent", () => {
  const value = snapshot();
  value.workspaces[0]!.tokens = { "vscode-navigation-intent": "space-request" };
  value.panes[0]!.tokens = { "vscode-navigation-intent": "agent-request" };
  assert.equal(findNavigationIntent(value, "w1")?.requestId, "agent-request");
});

test("falls back to the target workspace intent", () => {
  const value = snapshot();
  value.workspaces[0]!.tokens = { "vscode-navigation-intent": "space-request" };
  assert.deepEqual(findNavigationIntent(value, "w1"), {
    requestId: "space-request", workspaceId: "w1", kind: "workspace",
  });
});
