export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface WorktreeInfo {
  repo_root: string;
  checkout_path: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  tokens?: Record<string, string>;
  worktree?: WorktreeInfo;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  foreground_cwd?: string;
  tokens?: Record<string, string>;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface HerdrAgent {
  terminal_id: string;
  name?: string;
  agent?: string;
  title?: string;
  display_agent?: string;
  agent_status: AgentStatus;
  state_labels?: Record<string, string>;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  tokens?: Record<string, string>;
}

export interface HerdrSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  agents: HerdrAgent[];
}

export interface HerdrResponse<T> {
  id: string;
  result?: T;
  error?: { code: string; message: string };
}

export interface WorkspaceCreatedResult {
  workspace: HerdrWorkspace;
  root_pane: HerdrPane;
}
