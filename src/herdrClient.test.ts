import assert from "node:assert/strict";
import test from "node:test";
import { HerdrClient } from "./herdrClient";

test("agent attach arguments target one pane and take over input", () => {
  assert.deepEqual(
    new HerdrClient({ executable: "herdr" }).agentAttachArgs("w1:t1:p1"),
    ["agent", "attach", "w1:t1:p1", "--takeover"],
  );
  assert.deepEqual(
    new HerdrClient({ executable: "herdr", session: "work" }).agentAttachArgs("w1:t1:p1"),
    ["--session", "work", "agent", "attach", "w1:t1:p1", "--takeover"],
  );
});
