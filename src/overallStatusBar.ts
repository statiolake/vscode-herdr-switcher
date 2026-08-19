import * as vscode from "vscode";
import {
  agentDescription,
  agentDisplayName,
  agentStatusPresentation,
  overallAgentStatus,
  type OverallAgentStatus,
} from "./agentPresentation";
import type { HerdrSnapshot } from "./types";

const OPEN_AGENT_COMMAND = "herdr.openAgentByPane";

export class OverallStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  private renderKey: string | undefined;

  constructor() {
    this.item.name = "Herdr Overall Status";
    this.item.command = "herdr.agents.focus";
  }

  update(snapshot: HerdrSnapshot | undefined): void {
    const renderKey = JSON.stringify(snapshot
      ? snapshot.agents.map((agent) => {
        const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === agent.workspace_id);
        return [
          agent.pane_id,
          agent.agent_status,
          workspace?.label ?? agent.workspace_id,
          agentDescription(snapshot, agent),
        ];
      })
      : null);
    if (renderKey === this.renderKey) {
      return;
    }
    this.renderKey = renderKey;
    if (!snapshot) {
      this.item.text = "$(circle-outline) Herdr";
      this.item.color = undefined;
      this.item.tooltip = "Herdr is not running";
      this.item.show();
      return;
    }
    const status = overallAgentStatus(snapshot.agents.map((agent) => agent.agent_status));
    const presentation = overallPresentation(status);
    this.item.text = `$(${presentation.icon}) Herdr`;
    this.item.color = presentation.color ? new vscode.ThemeColor(presentation.color) : undefined;
    this.item.tooltip = overallTooltip(snapshot);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function overallPresentation(status: OverallAgentStatus): { icon: string; color?: string } {
  switch (status) {
    case "blocked": return { icon: "warning", color: "testing.iconFailed" };
    case "attention": return { icon: "circle-filled", color: "charts.blue" };
    case "working": return { icon: "loading~spin", color: "charts.yellow" };
    case "idle": return { icon: "check", color: "testing.iconPassed" };
  }
}

function overallTooltip(snapshot: HerdrSnapshot): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = { enabledCommands: [OPEN_AGENT_COMMAND] };
  tooltip.supportThemeIcons = true;
  tooltip.supportHtml = true;
  const agents = [...snapshot.agents].sort((left, right) => {
    const leftWorkspace = snapshot.workspaces.find((workspace) => workspace.workspace_id === left.workspace_id);
    const rightWorkspace = snapshot.workspaces.find((workspace) => workspace.workspace_id === right.workspace_id);
    return (leftWorkspace?.number ?? Number.MAX_SAFE_INTEGER)
      - (rightWorkspace?.number ?? Number.MAX_SAFE_INTEGER)
      || left.pane_id.localeCompare(right.pane_id, undefined, { numeric: true });
  });
  if (agents.length === 0) {
    tooltip.appendText("No agents");
    return tooltip;
  }
  tooltip.appendMarkdown(agents.map((agent) => {
    const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === agent.workspace_id);
    const name = agentDisplayName(agent);
    const description = agentDescription(snapshot, agent);
    const statusPresentation = agentStatusPresentation(agent.agent_status);
    const icon = statusPresentation.color
      ? `<span style="color:${themeColorVariable(statusPresentation.color)};">$(${statusPresentation.icon})</span>`
      : `$(${statusPresentation.icon})`;
    const command = `command:${OPEN_AGENT_COMMAND}?${encodeURIComponent(JSON.stringify([agent.pane_id]))}`;
    const workspaceLabel = escapeMarkdown(workspace?.label ?? agent.workspace_id);
    const descriptionLabel = `<span style="color:var(--vscode-descriptionForeground);">${escapeMarkdown(description)}</span>`;
    const row = `${icon} ${workspaceLabel} ${descriptionLabel}`;
    return `<a href="${escapeAttribute(command)}" title="Open ${escapeAttribute(name)}">`
      + `<span style="color:var(--vscode-foreground);">${row}</span></a>`;
  }).join("<br>\n"));
  return tooltip;
}

function themeColorVariable(color: string): string {
  return `var(--vscode-${color.replaceAll(".", "-")})`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&amp;").replace(/[\\`*_[\]()<>]/g, "\\$&");
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[character] ?? character);
}
