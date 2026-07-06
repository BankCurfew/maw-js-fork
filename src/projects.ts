import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BoardItem } from "./board";

// --- Types ---

export interface ProjectTask {
  taskId: string;       // BoardItem.id
  parentTaskId?: string; // for subtasks — another taskId within same project
  order: number;         // sort order within parent
}

export interface Project {
  id: string;            // slug: "bobs-office", "oracle-v2"
  name: string;          // display: "BoB's Office"
  description: string;
  tasks: ProjectTask[];  // ordered task list (with optional parent-child)
  repos?: string[];      // linked GitHub repos: ["YourOrg/LordMS"]
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsData {
  projects: Project[];
  // Reverse index: taskId → projectId (auto-derived on load)
  _taskIndex?: Record<string, string>;
}

// --- Storage ---

const MAW_DIR = join(process.env.HOME || "/home/curfew", ".maw");
const PROJECTS_PATH = join(MAW_DIR, "projects.json");

function ensureDir() {
  if (!existsSync(MAW_DIR)) mkdirSync(MAW_DIR, { recursive: true });
}

export function loadProjects(): ProjectsData {
  ensureDir();
  if (!existsSync(PROJECTS_PATH)) return { projects: [], _taskIndex: {} };
  try {
    const data: ProjectsData = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
    // Build reverse index
    data._taskIndex = {};
    for (const p of data.projects) {
      for (const t of p.tasks) {
        data._taskIndex[t.taskId] = p.id;
      }
    }
    return data;
  } catch {
    return { projects: [], _taskIndex: {} };
  }
}

export function saveProjects(data: ProjectsData): void {
  ensureDir();
  // Strip internal index before saving
  const { _taskIndex, ...clean } = data;
  writeFileSync(PROJECTS_PATH, JSON.stringify(clean, null, 2), "utf-8");
}

// --- CRUD ---

export function createProject(id: string, name: string, description = ""): Project {
  const data = loadProjects();
  if (data.projects.some((p) => p.id === id)) {
    throw new Error(`Project "${id}" already exists`);
  }
  const project: Project = {
    id,
    name,
    description,
    tasks: [],
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.projects.push(project);
  saveProjects(data);
  // Auto-scaffold project directory
  try { const { scaffoldProject } = require("./project-files"); scaffoldProject(project); } catch {}
  return project;
}

export function getProject(id: string): Project | undefined {
  return loadProjects().projects.find((p) => p.id === id);
}

export function updateProject(id: string, updates: Partial<Pick<Project, "name" | "description" | "status">>): Project {
  const data = loadProjects();
  const project = data.projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project "${id}" not found`);
  Object.assign(project, updates, { updatedAt: new Date().toISOString() });
  saveProjects(data);
  return project;
}

export function addTaskToProject(projectId: string, taskId: string, parentTaskId?: string): void {
  const data = loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);

  // Remove from any other project first
  for (const p of data.projects) {
    p.tasks = p.tasks.filter((t) => t.taskId !== taskId);
  }

  // Add to target project
  const maxOrder = project.tasks.length > 0
    ? Math.max(...project.tasks.map((t) => t.order))
    : 0;
  project.tasks.push({ taskId, parentTaskId, order: maxOrder + 1 });
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
}

export function removeTaskFromProject(projectId: string, taskId: string): void {
  const data = loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  // Also remove any subtasks that had this as parent
  project.tasks = project.tasks.filter((t) => t.taskId !== taskId && t.parentTaskId !== taskId);
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
}

export function moveTask(taskId: string, toProjectId: string, parentTaskId?: string): void {
  addTaskToProject(toProjectId, taskId, parentTaskId);
}

export function setTaskParent(projectId: string, taskId: string, parentTaskId: string | undefined): void {
  const data = loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  const task = project.tasks.find((t) => t.taskId === taskId);
  if (!task) throw new Error(`Task not found in project "${projectId}"`);
  task.parentTaskId = parentTaskId;
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
}

export function reorderTasks(projectId: string, taskIds: string[]): void {
  const data = loadProjects();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  for (let i = 0; i < taskIds.length; i++) {
    const task = project.tasks.find((t) => t.taskId === taskIds[i]);
    if (task) task.order = i + 1;
  }
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
}

// --- Query helpers ---

/** Get project for a given task ID */
export function getProjectForTask(taskId: string): Project | undefined {
  const data = loadProjects();
  return data.projects.find((p) => p.tasks.some((t) => t.taskId === taskId));
}

/** Get tree structure: top-level tasks + subtasks */
export function getProjectTree(projectId: string): {
  project: Project;
  tree: { task: ProjectTask; subtasks: ProjectTask[] }[];
} | null {
  const project = getProject(projectId);
  if (!project) return null;

  const sorted = [...project.tasks].sort((a, b) => a.order - b.order);
  const topLevel = sorted.filter((t) => !t.parentTaskId);
  const tree = topLevel.map((task) => ({
    task,
    subtasks: sorted.filter((t) => t.parentTaskId === task.taskId),
  }));

  // Also include orphaned subtasks (parent removed) as top-level
  const allChildIds = new Set(sorted.filter((t) => t.parentTaskId).map((t) => t.taskId));
  const allParentRefs = new Set(sorted.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!));
  const topLevelIds = new Set(topLevel.map((t) => t.taskId));
  for (const t of sorted) {
    if (t.parentTaskId && !topLevelIds.has(t.parentTaskId) && !allChildIds.has(t.taskId)) {
      tree.push({ task: t, subtasks: [] });
    }
  }

  return { project, tree };
}

/** Get full project board data (projects + enriched with board items) */
export function getProjectBoardData(boardItems: BoardItem[]): {
  projects: (Project & { enrichedTasks: (ProjectTask & { boardItem?: BoardItem })[] })[];
  unassigned: BoardItem[];
} {
  const data = loadProjects();
  const boardMap = new Map(boardItems.map((i) => [i.id, i]));

  // Build task→project index
  const assigned = new Set<string>();
  const projects = data.projects.map((p) => ({
    ...p,
    enrichedTasks: p.tasks
      .sort((a, b) => a.order - b.order)
      .map((t) => {
        assigned.add(t.taskId);
        return { ...t, boardItem: boardMap.get(t.taskId) };
      }),
  }));

  // Unassigned = board items not in any project
  const unassigned = boardItems.filter((i) => !assigned.has(i.id));

  return { projects, unassigned };
}

// --- Auto-group helper ---

/** Auto-detect project grouping from board item titles/repos */
export function autoGroupItems(boardItems: BoardItem[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const item of boardItems) {
    const title = item.title.toLowerCase();
    const repo = item.content.repository?.split("/").pop()?.toLowerCase() || "";

    // Detect project from common patterns
    let projectSlug = "general";

    // Oracle-prefixed tasks: "Dev: ..." "QA: ..."
    const oracleMatch = title.match(/^(dev|qa|researcher|writer|designer|hr|bob):\s*/i);
    if (oracleMatch) {
      // Try to detect sub-project from rest of title
      const rest = title.slice(oracleMatch[0].length);
      if (rest.includes("system optimization") || rest.includes("maintenance") || rest.includes("health"))
        projectSlug = "system-maintenance";
      else if (rest.includes("design system") || rest.includes("brand"))
        projectSlug = "design-system";
      else if (rest.includes("testing") || rest.includes("quality"))
        projectSlug = "quality-assurance";
      else if (rest.includes("okr") || rest.includes("onboarding") || rest.includes("performance"))
        projectSlug = "team-ops";
      else if (rest.includes("style guide") || rest.includes("content"))
        projectSlug = "content-strategy";
      else if (rest.includes("market research") || rest.includes("weekly"))
        projectSlug = "research";
      else projectSlug = `${oracleMatch[1].toLowerCase()}-tasks`;
    }
    // BoB's Office related
    else if (title.includes("bob's office") || title.includes("dashboard") || title.includes("board"))
      projectSlug = "bobs-office";
    // Pulse/CLI
    else if (title.includes("pulse") || title.includes("cli"))
      projectSlug = "pulse-cli";
    // Oracle system
    else if (title.includes("oracle") || title.includes("agent"))
      projectSlug = "oracle-system";
    // Health/monitoring
    else if (title.includes("health") || title.includes("monitor"))
      projectSlug = "system-maintenance";
    // Knowledge base
    else if (title.includes("knowledge") || title.includes("aia"))
      projectSlug = "knowledge-base";
    // From repo name
    else if (repo && repo !== "general")
      projectSlug = repo;

    if (!groups[projectSlug]) groups[projectSlug] = [];
    groups[projectSlug].push(item.id);
  }

  return groups;
}

/** Run auto-group and create projects for unassigned items */
export function autoOrganize(boardItems: BoardItem[]): { created: string[]; moved: number } {
  const groups = autoGroupItems(boardItems);
  const data = loadProjects();
  const existing = new Set(data.projects.map((p) => p.id));

  // Build current assignment set
  const alreadyAssigned = new Set<string>();
  for (const p of data.projects) {
    for (const t of p.tasks) alreadyAssigned.add(t.taskId);
  }

  const created: string[] = [];
  let moved = 0;

  const NAMES: Record<string, string> = {
    "bobs-office": "BoB's Office",
    "pulse-cli": "Pulse CLI",
    "oracle-system": "Oracle System",
    "system-maintenance": "System Maintenance",
    "design-system": "Design System",
    "quality-assurance": "Quality Assurance",
    "team-ops": "Team Operations",
    "content-strategy": "Content Strategy",
    "research": "Research",
    "knowledge-base": "Knowledge Base",
    "general": "General",
  };

  for (const [slug, taskIds] of Object.entries(groups)) {
    // Create project if needed
    if (!existing.has(slug)) {
      const name = NAMES[slug] || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      data.projects.push({
        id: slug,
        name,
        description: "",
        tasks: [],
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      created.push(slug);
      existing.add(slug);
    }

    // Add unassigned tasks to project
    const project = data.projects.find((p) => p.id === slug)!;
    const maxOrder = project.tasks.length > 0 ? Math.max(...project.tasks.map((t) => t.order)) : 0;
    let order = maxOrder;
    for (const taskId of taskIds) {
      if (!alreadyAssigned.has(taskId)) {
        order++;
        project.tasks.push({ taskId, order });
        alreadyAssigned.add(taskId);
        moved++;
      }
    }
    if (order > maxOrder) project.updatedAt = new Date().toISOString();
  }

  saveProjects(data);
  return { created, moved };
}

// --- Repo mapping ---

/** Build reverse index: repo → projectId */
export function buildRepoIndex(): Record<string, string> {
  const data = loadProjects();
  const index: Record<string, string> = {};
  for (const p of data.projects) {
    if (p.repos) {
      for (const repo of p.repos) {
        index[repo.toLowerCase()] = p.id;
      }
    }
  }
  return index;
}

/** Get project for a given repo (e.g. "YourOrg/LordMS") */
export function getProjectForRepo(repo: string): Project | undefined {
  const data = loadProjects();
  const key = repo.toLowerCase();
  return data.projects.find(p => p.repos?.some(r => r.toLowerCase() === key));
}

/** Add a repo to a project's repos[] */
export function addRepoToProject(projectId: string, repo: string): void {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  if (!project.repos) project.repos = [];
  const key = repo.toLowerCase();
  if (project.repos.some(r => r.toLowerCase() === key)) return; // already linked
  project.repos.push(repo);
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
  try { const { updateReadmeRepos } = require("./project-files"); updateReadmeRepos(projectId); } catch {}
}

/** Remove a repo from a project */
export function removeRepoFromProject(projectId: string, repo: string): void {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  if (!project.repos) return;
  const key = repo.toLowerCase();
  project.repos = project.repos.filter(r => r.toLowerCase() !== key);
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
}

/** Get all repo mappings */
export function getRepoMappings(): { projectId: string; name: string; repos: string[] }[] {
  const data = loadProjects();
  return data.projects
    .filter(p => p.repos && p.repos.length > 0)
    .map(p => ({ projectId: p.id, name: p.name, repos: p.repos! }));
}

/** Reopen an archived/completed project (BoB#164 — moved from hook) */
export function reopenProject(projectId: string): boolean {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return false;
  if (project.status === "active") return true;
  project.status = "active";
  project.updatedAt = new Date().toISOString();
  saveProjects(data);
  return true;
}

/** Auto-link an issue to a project by repo match + reopen if archived (BoB#164) */
export function autoLinkIssue(repo: string, issueRef: string): { projectId: string; reopened: boolean } | null {
  const project = getProjectForRepo(repo);
  if (!project) return null;
  // Enforce canonical repo#N format (maw-js#100)
  let canonical = issueRef;
  if (canonical.match(/^#\d+$/)) {
    const repoShort = repo.replace(/^[^/]*\//, "");
    canonical = `${repoShort}${canonical}`;
  }
  const reopened = project.status !== "active";
  if (reopened) reopenProject(project.id);
  try { addTaskToProject(project.id, canonical); } catch {}
  return { projectId: project.id, reopened };
}
