import assert from "node:assert/strict";
import test from "node:test";
import { agentDescription, overallAgentStatus } from "./agentPresentation";
import type { HerdrAgent, HerdrSnapshot } from "./types";

const agent = { tab_id: "tab-1", pane_id: "pane-1", name: "Claude" } as HerdrAgent;

test("overall status prioritizes unseen completed agents", () => {
  assert.equal(overallAgentStatus(["idle", "working", "done"]), "attention");
});

test("overall status shows working when no completed agent is unseen", () => {
  assert.equal(overallAgentStatus(["idle", "working"]), "working");
});

test("overall status is idle when every agent is acknowledged", () => {
  assert.equal(overallAgentStatus(["idle", "idle"]), "idle");
  assert.equal(overallAgentStatus([]), "idle");
});

test("agent descriptions omit auto-numbered tabs", () => {
  const snapshot = { tabs: [{ tab_id: "tab-1", label: "1", number: 1 }] } as HerdrSnapshot;
  assert.equal(agentDescription(snapshot, agent), "Claude");
});

test("agent descriptions include manually named tabs", () => {
  const snapshot = { tabs: [{ tab_id: "tab-1", label: "Review", number: 1 }] } as HerdrSnapshot;
  assert.equal(agentDescription(snapshot, agent), "Review Claude");
});
