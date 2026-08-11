import assert from "node:assert/strict";
import test from "node:test";
import { terminalInputCommands } from "./terminalInput";

test("translates SGR wheel input into semantic Herdr scroll", () => {
  assert.deepEqual(terminalInputCommands(
    `before\u001b[<68;11;7Mafter`,
    { wheelLines: 3 },
  ), [
    { kind: "input", data: "before" },
    {
      kind: "scroll",
      command: {
        type: "terminal.scroll",
        direction: "up",
        lines: 3,
        source: "wheel",
        column: 10,
        row: 6,
        modifiers: 1,
      },
    },
    { kind: "input", data: "after" },
  ]);
});

test("translates legacy X10 wheel input", () => {
  const x10 = "\u001b[M" + String.fromCharCode(97, 37, 42);
  assert.deepEqual(terminalInputCommands(x10), [{
    kind: "scroll",
    command: {
      type: "terminal.scroll",
      direction: "down",
      lines: 3,
      source: "wheel",
      column: 4,
      row: 9,
      modifiers: 0,
    },
  }]);
});

test("translates plain page keys using the viewport height", () => {
  assert.deepEqual(terminalInputCommands("\u001b[5~\u001b[6~", { rows: 40 }), [
    {
      kind: "scroll",
      command: { type: "terminal.scroll", direction: "up", lines: 39, source: "page_key" },
    },
    {
      kind: "scroll",
      command: { type: "terminal.scroll", direction: "down", lines: 39, source: "page_key" },
    },
  ]);
});

test("drops non-scroll mouse events", () => {
  assert.deepEqual(terminalInputCommands("\u001b[<0;11;7M"), []);
});

test("drops mouse motion, drag, and click events while preserving text input", () => {
  assert.deepEqual(
    terminalInputCommands("before\u001b[<35;11;7M\u001b[<32;12;8M\u001b[<0;12;8Mafter"),
    [
      { kind: "input", data: "before" },
      { kind: "input", data: "after" },
    ],
  );
});
