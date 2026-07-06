/**
 * Oracle Project Assignments — per-oracle active project tracking.
 * Storage: ~/.maw/oracle-projects.json
 *
 * Supports MANUAL (dashboard/CLI) and AUTO (task-start triggers) modes.
 * Manual overrides auto (within 1 hour).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProjects } from "./projects";

// --- Types ---

export interface OracleProjectEntry {
  projectId: string;
  source: "manual" | "auto";
  updatedAt: string;
}

export interface OracleProjectAssignments {
  assignments: Record<string, OracleProjectEntry>; // oracle → assignment
  updatedAt: string;
}

// --- Storage ---

const MAW_DIR = join(process.env.HOME || "/home/curfew", ".maw");
const ORACLE_PROJECTS_PATH = join(MAW_DIR, "oracle-projects.json");

function ensureDir() {
  if (!existsSync(MAW_DIR)) mkdirSync(MAW_DIR, { recursive: true });
}

function normalizeOracle(oracle: string): string {
  return oracle.toLowerCase().replace(/-oracle$/, "").replace(/[^a-z0-9-]/g, "");
}

export function loadOracleAssignments(): OracleProjectAssignments {
  ensureDir();
  if (!existsSync(ORACLE_PROJECTS_PATH)) return { assignments: {}, updatedAt: "" };
  try {
    const raw = JSON.parse(readFileSync(ORACLE_PROJECTS_PATH, "utf-8"));
    // Migrate old format (string values) to new format (OracleProjectEntry)
    if (raw.assignments) {
      for (const [k, v] of Object.entries(raw.assignments)) {
        if (typeof v === "string") {
          raw.assignments[k] = { projectId: v, source: "manual", updatedAt: raw.updatedAt || "" };
        }
      }
    }
    return raw;
  } catch {
    return { assignments: {}, updatedAt: "" };
  }
}

function saveOracleAssignments(data: OracleProjectAssignments): void {
  ensureDir();
  data.updatedAt = new Date().toISOString();
  writeFileSync(ORACLE_PROJECTS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Set the active project for an oracle. Validates projectId exists.
 *  source: "manual" (CLI/dashboard) or "auto" (task-start trigger).
 *  Auto won't override a recent manual assignment (within 1 hour). */
export function setOracleProject(oracle: string, projectId: string, source: "manual" | "auto" = "manual"): OracleProjectEntry {
  const key = normalizeOracle(oracle);
  const projects = loadProjects();
  const project = projects.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const data = loadOracleAssignments();

  // Auto won't override recent manual
  const existing = data.assignments[key];
  if (source === "auto" && existing?.source === "manual") {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (age < 3600_000) return existing; // respect manual for 1 hour
  }

  const entry: OracleProjectEntry = {
    projectId,
    source,
    updatedAt: new Date().toISOString(),
  };
  data.assignments[key] = entry;
  saveOracleAssignments(data);
  // Auto-scaffold project dir if missing + update team.md
  try {
    const { scaffoldProject, updateTeam } = require("./project-files");
    scaffoldProject(project);
    updateTeam(projectId);
  } catch {}
  return entry;
}

/** Auto-focus TTL: 2 hours. After this, auto-set focus is considered stale and cleared. */
const AUTO_FOCUS_TTL_MS = 2 * 60 * 60 * 1000;

/** Get the active project for an oracle (or null).
 *  Auto-focus entries expire after 2 hours of inactivity.
 *  Manual focus never auto-expires. */
export function getOracleProject(oracle: string): OracleProjectEntry | null {
  const key = normalizeOracle(oracle);
  const data = loadOracleAssignments();
  const entry = data.assignments[key];
  if (!entry) return null;

  // Auto-focus expires after TTL
  if (entry.source === "auto") {
    const age = Date.now() - new Date(entry.updatedAt).getTime();
    if (age > AUTO_FOCUS_TTL_MS) {
      clearOracleProject(oracle);
      return null;
    }
  }
  return entry;
}

/** Clear the active project for an oracle. */
export function clearOracleProject(oracle: string): void {
  const key = normalizeOracle(oracle);
  const data = loadOracleAssignments();
  const oldProjectId = data.assignments[key]?.projectId;
  delete data.assignments[key];
  saveOracleAssignments(data);
  // Auto-update old project's team.md
  if (oldProjectId) {
    try { const { updateTeam } = require("./project-files"); updateTeam(oldProjectId); } catch {}
  }
}

/** Find which project a task belongs to (by board item ID). */
export function findProjectForTask(taskId: string): string | null {
  const projects = loadProjects();
  for (const p of projects.projects) {
    if (p.status !== "active") continue;
    for (const t of p.tasks) {
      if (t.taskId === taskId) return p.id;
    }
  }
  return null;
}

/** Auto-set project focus when an oracle starts a task.
 *  Returns the project ID if found and set, null otherwise. */
export function autoSetProjectFromTask(oracle: string, taskId: string): string | null {
  const projectId = findProjectForTask(taskId);
  if (!projectId) return null;
  try {
    setOracleProject(oracle, projectId, "auto");
    return projectId;
  } catch {
    return null;
  }
}
