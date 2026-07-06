/**
 * Project Sync Engine — scans GitHub issues per repo, auto-maps to projects.
 * Additive only — never removes tasks. Auto-completes when ALL issues closed.
 */
import { loadProjects, saveProjects, type Project } from "./projects";

interface GHIssue {
  number: number;
  title: string;
  state: string; // "open" | "closed"
  node_id: string;
}

/** Run gh CLI to list issues for a repo */
async function ghIssueList(repo: string): Promise<GHIssue[]> {
  try {
    const proc = Bun.spawn(
      ["gh", "issue", "list", "--repo", repo, "--state", "all", "--json", "number,title,state,id", "--limit", "200"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    const issues = JSON.parse(text);
    return issues.map((i: any) => ({ number: i.number, title: i.title, state: i.state, node_id: i.id }));
  } catch {
    return [];
  }
}

export interface SyncResult {
  projectId: string;
  repo: string;
  added: number;
  closed: number;
  total: number;
  autoCompleted: boolean;
}

/** Sync a single project's repos */
async function syncProject(project: Project, allProjects: Project[]): Promise<SyncResult[]> {
  if (!project.repos || project.repos.length === 0) return [];

  const results: SyncResult[] = [];
  const existingTaskIds = new Set(project.tasks.map(t => t.taskId));
  let changed = false;

  for (const repo of project.repos) {
    const issues = await ghIssueList(repo);
    if (issues.length === 0) {
      results.push({ projectId: project.id, repo, added: 0, closed: 0, total: 0, autoCompleted: false });
      continue;
    }

    let added = 0;
    let closed = 0;
    const maxOrder = project.tasks.length > 0 ? Math.max(...project.tasks.map(t => t.order)) : 0;
    let order = maxOrder;

    for (const issue of issues) {
      // Use node_id as taskId (matches board item format)
      const taskId = issue.node_id;

      // Add new issues (additive only)
      if (!existingTaskIds.has(taskId)) {
        // Check if this task is in another project — don't steal it
        const inOther = allProjects.some(p => p.id !== project.id && p.tasks.some(t => t.taskId === taskId));
        if (!inOther) {
          order++;
          project.tasks.push({ taskId, order });
          existingTaskIds.add(taskId);
          added++;
          changed = true;
        }
      }

      if (issue.state.toLowerCase() === "closed") closed++;
    }

    results.push({ projectId: project.id, repo, added, closed, total: issues.length, autoCompleted: false });
  }

  // Auto-complete: if ALL linked issues are closed and project is active
  // Use already-fetched results (don't double-fetch)
  if (project.status === "active" && results.length > 0) {
    const hasIssues = results.some(r => r.total > 0);
    const allClosed = hasIssues && results.every(r => r.total === 0 || r.closed === r.total);
    if (allClosed) {
      project.status = "completed";
      changed = true;
      for (const r of results) r.autoCompleted = true;
    }
  }

  if (changed) project.updatedAt = new Date().toISOString();
  return results;
}

/** Sync all projects that have repos[] defined */
export async function syncAllProjects(): Promise<SyncResult[]> {
  const data = loadProjects();
  const projectsWithRepos = data.projects.filter(p => p.repos && p.repos.length > 0 && p.status === "active");

  const allResults: SyncResult[] = [];
  for (const project of projectsWithRepos) {
    const results = await syncProject(project, data.projects);
    allResults.push(...results);
    // Auto-update status.md
    try {
      const { updateStatus } = await import("./project-files");
      const open = results.reduce((s, r) => s + (r.total - r.closed), 0);
      const closed = results.reduce((s, r) => s + r.closed, 0);
      updateStatus(project.id, { open, closed, lastActivity: new Date().toISOString().slice(0, 19) });
    } catch {}
  }

  saveProjects(data);
  return allResults;
}

/** Sync a single project by ID */
export async function syncProjectById(projectId: string): Promise<SyncResult[]> {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) throw new Error(`Project "${projectId}" not found`);
  if (!project.repos || project.repos.length === 0) throw new Error(`Project "${projectId}" has no repos linked`);

  const results = await syncProject(project, data.projects);
  saveProjects(data);
  // Auto-update status.md
  try {
    const { updateStatus } = await import("./project-files");
    const open = results.reduce((s, r) => s + (r.total - r.closed), 0);
    const closed = results.reduce((s, r) => s + r.closed, 0);
    updateStatus(projectId, { open, closed, lastActivity: new Date().toISOString().slice(0, 19) });
  } catch {}
  return results;
}
