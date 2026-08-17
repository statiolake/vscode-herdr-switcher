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

test("terminal session control arguments target one pane with an initial size", () => {
  assert.deepEqual(
    new HerdrClient({ executable: "herdr" }).terminalSessionControlArgs("w1:p1", 120, 40),
    [
      "terminal", "session", "control", "w1:p1", "--takeover",
      "--cols", "120", "--rows", "40",
    ],
  );
  assert.deepEqual(
    new HerdrClient({ executable: "herdr", session: "work" }).terminalSessionControlArgs("w1:p1"),
    [
      "--session", "work", "terminal", "session", "control", "w1:p1", "--takeover",
      "--cols", "80", "--rows", "24",
    ],
  );
});

test("pane read arguments return bounded plain text output", () => {
  assert.deepEqual(
    new HerdrClient({ executable: "herdr" }).paneReadArgs("w1:p1"),
    [
      "pane", "read", "w1:p1",
      "--source", "recent-unwrapped",
      "--lines", "1000",
      "--format", "text",
    ],
  );
  assert.deepEqual(
    new HerdrClient({ executable: "herdr" }).paneReadArgs("w1:p1", {
      source: "recent-unwrapped",
      lines: 200,
    }),
    [
      "pane", "read", "w1:p1",
      "--source", "recent-unwrapped",
      "--lines", "200",
      "--format", "text",
    ],
  );
  assert.deepEqual(
    new HerdrClient({ executable: "herdr", session: "work" }).paneReadArgs("w1:p1", { lines: 9_999 }),
    [
      "pane", "read", "w1:p1",
      "--source", "recent-unwrapped",
      "--lines", "5000",
      "--format", "text",
    ],
  );
});
