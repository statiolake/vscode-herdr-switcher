import assert from "node:assert/strict";
import test from "node:test";
import { agentShellCommand, configuredAgents, shellCommand } from "./agentConfiguration";

test("configured agents reject malformed and duplicate entries", () => {
  assert.deepEqual(configuredAgents([
    { name: " Claude Code ", command: ["claude"] },
    { name: "Claude Code", command: ["duplicate"] },
    { name: "Broken", command: [] },
    null,
  ]), [{ name: "Claude Code", command: ["claude"] }]);
});

test("configured agents preserve an optional Herdr agent kind", () => {
  assert.deepEqual(configuredAgents([
    { name: "Claude Code", command: ["claude"], kind: " claude " },
    { name: "Custom", command: ["my-agent"], kind: 42 },
  ]), [
    { name: "Claude Code", command: ["claude"], kind: "claude" },
    { name: "Custom", command: ["my-agent"] },
  ]);
});

test("agent argv is safely serialized for a POSIX shell", () => {
  assert.equal(shellCommand(["claude", "hello world", "it's"], "darwin"),
    `'claude' 'hello world' 'it'"'"'s'`);
});

test("agent argv is safely serialized for PowerShell", () => {
  assert.equal(shellCommand(["claude", "it's"], "win32"), `'claude' 'it''s'`);
});

test("an agent replaces its POSIX shell", () => {
  assert.equal(
    agentShellCommand(["claude", "hello world"], "darwin"),
    `exec 'claude' 'hello world'`,
  );
});

test("an agent exits its PowerShell while preserving its status", () => {
  assert.equal(
    agentShellCommand(["claude", "hello world"], "win32"),
    `& 'claude' 'hello world'; exit $LASTEXITCODE`,
  );
});
