export type HerdrTerminalTarget =
  | { kind: "session" }
  | { kind: "agent"; paneId: string; name: string };

export interface TerminalHandle {
  readonly exitStatus: unknown | undefined;
}

export class TerminalRegistry<T extends TerminalHandle> {
  private session: T | undefined;
  private readonly agents = new Map<string, T>();

  get(target: HerdrTerminalTarget): T | undefined {
    const terminal = target.kind === "session" ? this.session : this.agents.get(target.paneId);
    if (terminal?.exitStatus !== undefined) {
      this.remove(terminal);
      return undefined;
    }
    return terminal;
  }

  set(target: HerdrTerminalTarget, terminal: T): void {
    if (target.kind === "session") {
      this.session = terminal;
    } else {
      this.agents.set(target.paneId, terminal);
    }
  }

  isCurrent(target: HerdrTerminalTarget, terminal: T): boolean {
    return this.get(target) === terminal;
  }

  remove(terminal: T): void {
    if (this.session === terminal) {
      this.session = undefined;
    }
    for (const [paneId, candidate] of this.agents) {
      if (candidate === terminal) {
        this.agents.delete(paneId);
      }
    }
  }
}
