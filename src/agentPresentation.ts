import type { AgentStatus, HerdrAgent, HerdrSnapshot, HerdrTab } from "./types";

export interface AgentStatusPresentation {
  icon: string;
  color?: string;
}

export type OverallAgentStatus = "attention" | "working" | "idle";

export function agentDisplayName(agent: HerdrAgent): string {
  return agent.name ?? agent.display_agent ?? agent.agent ?? agent.title ?? agent.pane_id;
}

/** The compact secondary label shared by the Agents view and status hover. */
export function agentDescription(snapshot: HerdrSnapshot | undefined, agent: HerdrAgent): string {
  const tab = snapshot?.tabs.find((candidate) => candidate.tab_id === agent.tab_id);
  const tabLabel = tab && !isDefaultTabLabel(tab) ? tab.label.trim() : "";
  const name = agentDisplayName(agent);
  return tabLabel ? `${tabLabel} ${name}` : name;
}

export function isDefaultTabLabel(tab: Pick<HerdrTab, "label" | "number">): boolean {
  return tab.label === String(tab.number);
}

export function agentStatusPresentation(status: AgentStatus): AgentStatusPresentation {
  switch (status) {
    case "blocked": return { icon: "warning", color: "testing.iconFailed" };
    case "working": return { icon: "loading~spin", color: "charts.yellow" };
    case "done": return { icon: "circle-filled", color: "charts.blue" };
    case "idle": return { icon: "check", color: "testing.iconPassed" };
    case "unknown": return { icon: "circle-outline" };
  }
}

export function overallAgentStatus(statuses: readonly AgentStatus[]): OverallAgentStatus {
  if (statuses.includes("done")) {
    return "attention";
  }
  if (statuses.includes("working")) {
    return "working";
  }
  return "idle";
}
