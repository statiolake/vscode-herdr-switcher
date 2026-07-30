import assert from "node:assert/strict";
import test from "node:test";
import { ConsumedNavigationIntents, findNavigationIntent, HerdrNavigationIntentStore } from "./navigationIntent";
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
  value.workspaces[1]!.tokens = { "vscode-navigation-intent": "v1|request-2|a|w2:p1" };
  assert.equal(findNavigationIntent(value, "w1"), undefined);
  assert.deepEqual(findNavigationIntent(value, "w2"), {
    requestId: "request-2", workspaceId: "w2", kind: "agent", paneId: "w2:p1",
  });
});

test("decodes a workspace intent from the single navigation slot", () => {
  const value = snapshot();
  value.workspaces[0]!.tokens = { "vscode-navigation-intent": "v1|space-request|w" };
  assert.deepEqual(findNavigationIntent(value, "w1"), {
    requestId: "space-request", workspaceId: "w1", kind: "workspace",
  });
});

test("decodes an attach intent from the single navigation slot", () => {
  const value = snapshot();
  value.workspaces[0]!.tokens = { "vscode-navigation-intent": "v1|attach-request|t" };
  assert.deepEqual(findNavigationIntent(value, "w1"), {
    requestId: "attach-request", workspaceId: "w1", kind: "attach",
  });
});

test("a close intent takes precedence over focus intents", () => {
  const value = snapshot();
  value.workspaces[0]!.tokens = {
    "vscode-navigation-intent": "v1|space-request|w",
    "vscode-close-intent": "close-request",
  };
  assert.deepEqual(findNavigationIntent(value, "w1"), {
    requestId: "close-request", workspaceId: "w1", kind: "close",
  });
});

test("window presence is scoped to its workspace", () => {
  const value = snapshot();
  value.workspaces[1]!.tokens = { "vscode-window-presence": "open" };
  const store = new HerdrNavigationIntentStore({} as never);
  assert.equal(store.hasWindowPresence(value, "w1"), false);
  assert.equal(store.hasWindowPresence(value, "w2"), true);
});

test("all non-destructive navigation kinds publish to one replaceable token", async () => {
  const writes: Array<{ workspaceId: string; key: string; value: string }> = [];
  const client = {
    setWorkspaceToken: async (workspaceId: string, _source: string, key: string, value: string) => {
      writes.push({ workspaceId, key, value });
    },
  };
  const store = new HerdrNavigationIntentStore(client as never);

  await store.publishWorkspace("w1");
  await store.publishAgent("w1", "w1:p1");
  await store.publishAttach("w1");

  assert.deepEqual(writes.map(({ workspaceId, key }) => ({ workspaceId, key })), [
    { workspaceId: "w1", key: "vscode-navigation-intent" },
    { workspaceId: "w1", key: "vscode-navigation-intent" },
    { workspaceId: "w1", key: "vscode-navigation-intent" },
  ]);
  assert.match(writes[0]!.value, /^v1\|[^|]+\|w$/);
  assert.match(writes[1]!.value, /^v1\|[^|]+\|a\|w1:p1$/);
  assert.match(writes[2]!.value, /^v1\|[^|]+\|t$/);
});

test("consumed intent receipts do not become executable again with age", () => {
  const consumed = new ConsumedNavigationIntents();
  consumed.add("request-1");
  assert.equal(consumed.has("request-1"), true);
});

test("consumed intent receipts retain a bounded recent history", () => {
  const consumed = new ConsumedNavigationIntents();
  for (let index = 0; index < 257; index += 1) {
    consumed.add(`request-${index}`);
  }
  assert.equal(consumed.has("request-0"), false);
  assert.equal(consumed.has("request-1"), true);
  assert.equal(consumed.has("request-256"), true);
});
