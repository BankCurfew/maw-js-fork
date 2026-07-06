export interface Window {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
}

export interface Session {
  name: string;
  windows: Window[];
}

export type PaneStatus = "ready" | "busy" | "idle";

export interface AgentState {
  target: string;
  name: string;
  session: string;
  windowIndex: number;
  active: boolean;
  preview: string;
  status: PaneStatus;
  project?: string;
  contextPercent?: number;
}

export interface AgentEvent {
  time: number;
  target: string;
  type: "status" | "command";
  detail: string;
}

export type AskType = "input" | "attention" | "plan" | "report" | "meeting" | "handoff";

// Board types
export interface BoardItem {
  id: string;
  index: number;
  title: string;
  status: string;
  oracle: string;
  priority: string;
  client: string;
  startDate: string;
  targetDate: string;
  content: { body: string; number: number; repository: string; title: string; type: string; url: string };
}

export interface BoardField {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string }[];
}

export interface ScanResult {
  repo: string;
  issues: { number: number; title: string; url: string; labels: string[] }[];
}

export interface ScanMineResult {
  oracle: string;
  oracleName: string;
  commits: { hash: string; message: string; date: string }[];
}

export interface TimelineItem {
  id: string;
  title: string;
  oracle: string;
  priority: string;
  status: string;
  startDate: string;
  targetDate: string;
  startOffset: number;
  width: number;
}

export interface PulseBoard {
  active: { number: number; title: string; oracle: string }[];
  projects: { number: number; title: string; oracle: string }[];
  tools: { number: number; title: string; oracle: string }[];
  total: number;
  threads: any[];
}

export interface AskItem {
  id: string;
  oracle: string;
  target: string;      // tmux target e.g. "01-oracles:0"
  type: AskType;
  message: string;
  ts: number;
  dismissed?: boolean;
}

// Task activity log types
export type TaskActivityType = "message" | "commit" | "status_change" | "note" | "blocker" | "comment";

// Project hierarchy types
export interface ProjectTask {
  taskId: string;
  parentTaskId?: string;
  order: number;
  boardItem?: BoardItem; // enriched from server
}

export interface Project {
  id: string;
  name: string;
  description: string;
  tasks: ProjectTask[];
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
  enrichedTasks?: ProjectTask[]; // enriched from server
}

export interface TaskActivity {
  id: string;
  taskId: string;
  type: TaskActivityType;
  oracle: string;
  ts: string;
  content: string;
  meta?: {
    commitHash?: string;
    repo?: string;
    oldStatus?: string;
    newStatus?: string;
    resolved?: boolean;
  };
}

export interface TaskLogSummary {
  taskId: string;
  count: number;
  lastActivity: string;
  lastOracle: string;
  hasBlockers: boolean;
  contributors: string[];
}

export interface ConfigData {
  host: string;
  port: number;
  ghqRoot: string;
  oracleUrl: string;
  envMasked: Record<string, string>;
  commands: Record<string, string>;
  sessions: Record<string, string>;
}
