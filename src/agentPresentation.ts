import type { AgentStatus, HerdrAgent } from "./types";

export interface AgentStatusPresentation {
  icon: string;
  color?: string;
}

export type OverallAgentStatus = "attention" | "working" | "idle";

export function agentDisplayName(agent: HerdrAgent): string {
  return agent.name ?? agent.display_agent ?? agent.agent ?? agent.title ?? agent.pane_id;
}

export function agentStatusPresentation(status: AgentStatus): AgentStatusPresentation {
  switch (status) {
    case "blocked": return { icon: "circle-filled", color: "testing.iconFailed" };
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
