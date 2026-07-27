import assert from "node:assert/strict";
import test from "node:test";
import { overallAgentStatus } from "./agentPresentation";

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
