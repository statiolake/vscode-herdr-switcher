export interface TerminalScrollCommand {
  type: "terminal.scroll";
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page_key";
  column?: number;
  row?: number;
  modifiers?: number;
}

export type TerminalInputCommand =
  | { kind: "input"; data: string }
  | { kind: "scroll"; command: TerminalScrollCommand };

interface TerminalInputOptions {
  rows?: number;
  wheelLines?: number;
}

/**
 * Translate scroll input emitted by xterm.js into Herdr's semantic scroll
 * command. Session control deliberately treats terminal.input as application
 * input, while the Herdr client normally intercepts wheel/page keys before
 * they reach the pane.
 */
export function terminalInputCommands(
  data: string,
  options: TerminalInputOptions = {},
): TerminalInputCommand[] {
  if (!data) {
    return [];
  }
  const wheelLines = boundedLines(options.wheelLines ?? 3);
  const pageLines = boundedLines((options.rows ?? 24) - 1);
  const commands: TerminalInputCommand[] = [];
  let inputStart = 0;
  let index = 0;

  const flushInput = (end: number): void => {
    if (end <= inputStart) {
      return;
    }
    commands.push({ kind: "input", data: data.slice(inputStart, end) });
  };

  while (index < data.length) {
    if (data.startsWith("\u001b[<", index)) {
      const match = /^\u001b\[<(\d+);(\d+);(\d+)([mM])/.exec(data.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      const consumed = match[0].length;
      const scroll = wheelScroll(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]) - 1,
        wheelLines,
      );
      if (scroll) {
        flushInput(index);
        commands.push({ kind: "scroll", command: scroll });
        index += consumed;
        inputStart = index;
      } else if (mouseEvent(Number(match[1]))) {
        flushInput(index);
        index += consumed;
        inputStart = index;
      } else {
        index += consumed;
      }
      continue;
    }

    // xterm.js can use the legacy X10 mouse encoding when SGR mode is not
    // enabled. It has a fixed three-byte payload after ESC [ M.
    if (data.startsWith("\u001b[M", index) && index + 6 <= data.length) {
      const button = data.charCodeAt(index + 3) - 32;
      const column = data.charCodeAt(index + 4) - 33;
      const row = data.charCodeAt(index + 5) - 33;
      const scroll = wheelScroll(button, column, row, wheelLines);
      if (scroll) {
        flushInput(index);
        commands.push({ kind: "scroll", command: scroll });
        index += 6;
        inputStart = index;
      } else if (mouseEvent(button)) {
        flushInput(index);
        index += 6;
        inputStart = index;
      } else {
        index += 6;
      }
      continue;
    }

    if (data.startsWith("\u001b[5~", index) || data.startsWith("\u001b[6~", index)) {
      flushInput(index);
      commands.push({
        kind: "scroll",
        command: {
          type: "terminal.scroll",
          direction: data[index + 2] === "5" ? "up" : "down",
          lines: pageLines,
          source: "page_key",
        },
      });
      index += 4;
      inputStart = index;
      continue;
    }

    index += 1;
  }

  flushInput(data.length);
  return commands;
}

function wheelScroll(
  button: number,
  column: number,
  row: number,
  lines: number,
): TerminalScrollCommand | undefined {
  if (!Number.isInteger(button) || button < 0 || (button & 0x40) === 0) {
    return undefined;
  }
  const wheelDirection = button & 0x03;
  if (wheelDirection !== 0 && wheelDirection !== 1) {
    // 66/67 are horizontal wheel events; Herdr's session-control protocol
    // currently exposes vertical scroll only, so drop those too.
    return undefined;
  }
  return {
    type: "terminal.scroll",
    direction: wheelDirection === 0 ? "up" : "down",
    lines,
    source: "wheel",
    column: Math.max(0, Math.min(65535, Math.floor(column))),
    row: Math.max(0, Math.min(65535, Math.floor(row))),
    modifiers: sgrModifiers(button),
  };
}

function mouseEvent(button: number): boolean {
  // Every SGR/X10 mouse event that is not a vertical wheel event is dropped.
  // This includes clicks, motion, drag, and horizontal wheel events. The
  // direct terminal deliberately exposes only semantic vertical scrolling;
  // forwarding the rest would reset Herdr's viewport or compete with VS
  // Code's own selection handling.
  return Number.isInteger(button);
}

function sgrModifiers(button: number): number {
  // xterm mouse bits are Shift=4, Alt=8, Ctrl=16. Herdr uses crossterm's
  // KeyModifiers bitset: Shift=1, Ctrl=2, Alt=4.
  return (button & 4 ? 1 : 0) | (button & 16 ? 2 : 0) | (button & 8 ? 4 : 0);
}

function boundedLines(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(65535, Math.floor(value))) : 1;
}
