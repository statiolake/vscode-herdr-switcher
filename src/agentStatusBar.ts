import * as vscode from "vscode";
import { agentDisplayName, agentStatusPresentation } from "./agentPresentation";
import type { AgentOutputPreview } from "./outputPreview";
import type { HerdrAgent } from "./types";

interface AgentStatusEntry {
  item: vscode.StatusBarItem;
  generation: number;
  preview: AgentOutputPreview;
  renderKey?: string;
}

export class AgentStatusBar implements vscode.Disposable {
  private readonly entries = new Map<string, AgentStatusEntry>();

  constructor(private readonly command: string) {}

  update(
    agents: readonly HerdrAgent[],
    readPreview: (paneId: string) => Promise<AgentOutputPreview>,
  ): void {
    const paneIds = new Set(agents.map((agent) => agent.pane_id));
    for (const [paneId, entry] of this.entries) {
      if (!paneIds.has(paneId)) {
        entry.item.dispose();
        this.entries.delete(paneId);
      }
    }
    for (const agent of agents) {
      const entry = this.entry(agent.pane_id);
      entry.generation += 1;
      const generation = entry.generation;
      this.render(entry, agent);
      void readPreview(agent.pane_id).then((preview) => {
        if (this.entries.get(agent.pane_id) !== entry || entry.generation !== generation) {
          return;
        }
        if (JSON.stringify(preview) !== JSON.stringify(entry.preview)) {
          entry.preview = preview;
          this.render(entry, agent);
        }
      });
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.item.dispose();
    }
    this.entries.clear();
  }

  private entry(paneId: string): AgentStatusEntry {
    const existing = this.entries.get(paneId);
    if (existing) {
      return existing;
    }
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = {
      command: this.command,
      title: "Open Herdr Agent",
      arguments: [paneId],
    };
    const created: AgentStatusEntry = {
      item,
      generation: 0,
      preview: { kind: "loading" },
    };
    this.entries.set(paneId, created);
    return created;
  }

  private render(entry: AgentStatusEntry, agent: HerdrAgent): void {
    const name = agentDisplayName(agent);
    const renderKey = JSON.stringify([agent.agent_status, name, entry.preview]);
    if (renderKey === entry.renderKey) {
      return;
    }
    entry.renderKey = renderKey;
    const presentation = agentStatusPresentation(agent.agent_status);
    entry.item.text = `$(${presentation.icon}) ${name}`;
    entry.item.color = presentation.color ? new vscode.ThemeColor(presentation.color) : undefined;
    entry.item.tooltip = tooltip(name, entry.preview);
    entry.item.show();
  }
}

function tooltip(name: string, preview: AgentOutputPreview): string | vscode.MarkdownString {
  if (preview.kind === "output") {
    const value = new vscode.MarkdownString();
    value.appendText(name);
    value.appendMarkdown("\n\n");
    value.appendCodeblock(preview.text, "text");
    return value;
  }
  const detail = preview.kind === "loading"
    ? "reading terminal…"
    : preview.kind === "empty"
      ? "terminal has no output"
      : "failed to read terminal";
  return `${name} - ${detail}`;
}
