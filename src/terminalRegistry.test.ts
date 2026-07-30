import assert from "node:assert/strict";
import test from "node:test";
import { TerminalRegistry, type HerdrTerminalTarget } from "./terminalRegistry";

interface TestTerminal {
  exitStatus: number | undefined;
}

const session: HerdrTerminalTarget = { kind: "session" };
const firstAgent: HerdrTerminalTarget = { kind: "agent", paneId: "w1:p1", name: "Claude" };
const secondAgent: HerdrTerminalTarget = { kind: "agent", paneId: "w1:p2", name: "Codex" };

test("tracks one terminal per Agent pane independently from the session", () => {
  const registry = new TerminalRegistry<TestTerminal>();
  const sessionTerminal = { exitStatus: undefined };
  const firstTerminal = { exitStatus: undefined };
  const secondTerminal = { exitStatus: undefined };

  registry.set(session, sessionTerminal);
  registry.set(firstAgent, firstTerminal);
  registry.set(secondAgent, secondTerminal);

  assert.equal(registry.get(session), sessionTerminal);
  assert.equal(registry.get(firstAgent), firstTerminal);
  assert.equal(registry.get(secondAgent), secondTerminal);
});

test("forgets a closed terminal without affecting other panes", () => {
  const registry = new TerminalRegistry<TestTerminal>();
  const firstTerminal = { exitStatus: undefined as number | undefined };
  const secondTerminal = { exitStatus: undefined };
  registry.set(firstAgent, firstTerminal);
  registry.set(secondAgent, secondTerminal);

  firstTerminal.exitStatus = 1;

  assert.equal(registry.get(firstAgent), undefined);
  assert.equal(registry.get(secondAgent), secondTerminal);
});

test("removes a terminal immediately when VS Code reports it closed", () => {
  const registry = new TerminalRegistry<TestTerminal>();
  const terminal = { exitStatus: undefined };
  registry.set(firstAgent, terminal);

  registry.remove(terminal);

  assert.equal(registry.get(firstAgent), undefined);
});

test("a delayed close event cannot remove a replacement terminal", () => {
  const registry = new TerminalRegistry<TestTerminal>();
  const replaced = { exitStatus: undefined };
  const replacement = { exitStatus: undefined };
  registry.set(firstAgent, replaced);
  registry.set(firstAgent, replacement);

  registry.remove(replaced);

  assert.equal(registry.get(firstAgent), replacement);
});
