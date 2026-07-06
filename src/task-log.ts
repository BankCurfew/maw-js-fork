import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// --- Types ---

export type TaskActivityType = "message" | "commit" | "status_change" | "note" | "blocker" | "comment";

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
  lastActivity: string; // ISO timestamp
  lastOracle: string;
  hasBlockers: boolean;
  contributors: string[];
}

// --- Storage ---

const LOG_DIR = join(process.env.HOME || "/home/curfew", ".maw", "task-logs");

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function logPath(taskId: string): string {
  // Sanitize taskId for filesystem
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(LOG_DIR, `${safe}.jsonl`);
}

// --- Core functions ---

export function appendActivity(activity: Omit<TaskActivity, "id" | "ts">): TaskActivity {
  ensureDir();
  const ts = new Date().toISOString();
  const id = `${ts.replace(/[:.]/g, "-")}-${activity.oracle || "system"}`;
  const full: TaskActivity = { ...activity, id, ts };
  appendFileSync(logPath(activity.taskId), JSON.stringify(full) + "\n", "utf-8");
  return full;
}

export function readTaskLog(taskId: string): TaskActivity[] {
  const path = logPath(taskId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as TaskActivity[];
}

export function getTaskLogSummary(taskId: string): TaskLogSummary | null {
  const activities = readTaskLog(taskId);
  if (activities.length === 0) return null;
  const last = activities[activities.length - 1];
  const contributors = [...new Set(activities.map((a) => a.oracle).filter(Boolean))];
  const hasBlockers = activities.some(
    (a) => a.type === "blocker" && !a.meta?.resolved
  );
  return {
    taskId,
    count: activities.length,
    lastActivity: last.ts,
    lastOracle: last.oracle,
    hasBlockers,
    contributors,
  };
}

export function getAllLogSummaries(): Record<string, TaskLogSummary> {
  ensureDir();
  const summaries: Record<string, TaskLogSummary> = {};
  try {
    const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const taskId = file.replace(/\.jsonl$/, "");
      const summary = getTaskLogSummary(taskId);
      if (summary) summaries[taskId] = summary;
    }
  } catch { /* empty dir or read error */ }
  return summaries;
}
