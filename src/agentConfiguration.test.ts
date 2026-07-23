import assert from "node:assert/strict";
import test from "node:test";
import { configuredAgents, shellCommand } from "./agentConfiguration";

test("configured agents reject malformed and duplicate entries", () => {
  assert.deepEqual(configuredAgents([
    { name: " Claude Code ", command: ["claude"] },
    { name: "Claude Code", command: ["duplicate"] },
    { name: "Broken", command: [] },
    null,
  ]), [{ name: "Claude Code", command: ["claude"] }]);
});

test("agent argv is safely serialized for a POSIX shell", () => {
  assert.equal(shellCommand(["claude", "hello world", "it's"], "darwin"),
    `'claude' 'hello world' 'it'"'"'s'`);
});

test("agent argv is safely serialized for PowerShell", () => {
  assert.equal(shellCommand(["claude", "it's"], "win32"), `'claude' 'it''s'`);
});
