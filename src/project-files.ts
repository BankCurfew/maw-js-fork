/**
 * Project Files — auto-managed context files per project.
 * ~/.maw/projects/<project-id>/{README.md, team.md, status.md, notes.md}
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjects, type Project } from "./projects";

const MAW_DIR = join(process.env.HOME || "/home/curfew", ".maw");
const PROJECTS_DIR = join(MAW_DIR, "projects");

function projectDir(projectId: string): string {
  return join(PROJECTS_DIR, projectId);
}

function ensureProjectDir(projectId: string): string {
  const dir = projectDir(projectId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Get path to project context dir */
export function getProjectPath(projectId: string): string {
  return projectDir(projectId);
}

// --- Scaffold ---

/** Create initial project files when a project is created */
export function scaffoldProject(project: Project): void {
  const dir = ensureProjectDir(project.id);

  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(join(dir, "README.md"), [
      `# ${project.name}`,
      "",
      project.description || "_No description yet._",
      "",
      "## Repos",
      ...(project.repos?.map(r => `- ${r}`) || ["_None linked yet._"]),
      "",
      `## Status: ${project.status}`,
      `Created: ${project.createdAt?.slice(0, 10) || "unknown"}`,
      "",
    ].join("\n"));
  }

  if (!existsSync(join(dir, "team.md"))) {
    writeFileSync(join(dir, "team.md"), [
      `# Team — ${project.name}`,
      "",
      "## Active Oracles",
      "_None assigned yet._",
      "",
    ].join("\n"));
  }

  if (!existsSync(join(dir, "status.md"))) {
    writeFileSync(join(dir, "status.md"), [
      `# Status — ${project.name}`,
      "",
      "Issues: 0 open / 0 closed",
      "Last activity: none",
      "Active oracles: none",
      "Blockers: none",
      "",
    ].join("\n"));
  }

  if (!existsSync(join(dir, "notes.md"))) {
    writeFileSync(join(dir, "notes.md"), [
      `# Notes — ${project.name}`,
      "",
      "_Running notes, decisions, and log entries._",
      "",
    ].join("\n"));
  }
}

// --- Auto-update functions ---

/** Update README.md repos section */
export function updateReadmeRepos(projectId: string): void {
  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) return;
  const dir = ensureProjectDir(projectId);
  const readmePath = join(dir, "README.md");

  let content = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : "";
  const reposSection = project.repos?.length
    ? project.repos.map(r => `- ${r}`).join("\n")
    : "_None linked yet._";

  // Replace repos section or append
  if (content.includes("## Repos")) {
    content = content.replace(
      /## Repos\n[\s\S]*?(?=\n## |\n*$)/,
      `## Repos\n${reposSection}\n`,
    );
  } else {
    content += `\n## Repos\n${reposSection}\n`;
  }
  writeFileSync(readmePath, content);
}

/** Update team.md with current active oracles */
export function updateTeam(projectId: string): void {
  const dir = ensureProjectDir(projectId);
  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) return;

  // Read oracle-projects to find who's focused on this project
  let activeOracles: string[] = [];
  try {
    const opPath = join(MAW_DIR, "oracle-projects.json");
    if (existsSync(opPath)) {
      const data = JSON.parse(readFileSync(opPath, "utf-8"));
      for (const [oracle, entry] of Object.entries(data.assignments || {})) {
        if ((entry as any).projectId === projectId) activeOracles.push(oracle);
      }
    }
  } catch {}

  const oracleList = activeOracles.length > 0
    ? activeOracles.map(o => `- ${o}`).join("\n")
    : "_None assigned yet._";

  writeFileSync(join(dir, "team.md"), [
    `# Team — ${project.name}`,
    "",
    "## Active Oracles",
    oracleList,
    "",
    `_Updated: ${new Date().toISOString().slice(0, 19)}_`,
    "",
  ].join("\n"));
}

/** Update status.md with GitHub issue counts */
export function updateStatus(projectId: string, issueStats?: { open: number; closed: number; lastActivity?: string }): void {
  const dir = ensureProjectDir(projectId);
  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) return;

  let activeOracles: string[] = [];
  try {
    const opPath = join(MAW_DIR, "oracle-projects.json");
    if (existsSync(opPath)) {
      const data = JSON.parse(readFileSync(opPath, "utf-8"));
      for (const [oracle, entry] of Object.entries(data.assignments || {})) {
        if ((entry as any).projectId === projectId) activeOracles.push(oracle);
      }
    }
  } catch {}

  const stats = issueStats || { open: 0, closed: 0 };
  writeFileSync(join(dir, "status.md"), [
    `# Status — ${project.name}`,
    "",
    `Issues: ${stats.open} open / ${stats.closed} closed`,
    `Last activity: ${stats.lastActivity || new Date().toISOString().slice(0, 19)}`,
    `Active oracles: ${activeOracles.join(", ") || "none"}`,
    `Blockers: none`,
    "",
    `_Updated: ${new Date().toISOString().slice(0, 19)}_`,
    "",
  ].join("\n"));
}

/** Append a note to notes.md */
export function appendNote(projectId: string, oracle: string, note: string): void {
  const dir = ensureProjectDir(projectId);
  const notesPath = join(dir, "notes.md");
  let content = existsSync(notesPath) ? readFileSync(notesPath, "utf-8") : `# Notes — ${projectId}\n\n`;
  const ts = new Date().toISOString().slice(0, 19);
  content += `- **${ts}** [${oracle}] ${note}\n`;
  writeFileSync(notesPath, content);
}

// --- GitHub Repo Scaffolding ---

function getActiveOracles(projectId: string): string[] {
  const oracles: string[] = [];
  try {
    const opPath = join(MAW_DIR, "oracle-projects.json");
    if (existsSync(opPath)) {
      const data = JSON.parse(readFileSync(opPath, "utf-8"));
      for (const [oracle, entry] of Object.entries(data.assignments || {})) {
        if ((entry as any).projectId === projectId) oracles.push(oracle);
      }
    }
  } catch {}
  return oracles;
}

function generateRepoReadme(project: Project): string {
  const oracles = getActiveOracles(project.id);
  return [
    `# ${project.name}`,
    "",
    `> ${project.description || "Oracle-managed project"}`,
    "",
    "## Status",
    `- **Project**: ${project.status}`,
    `- **Created**: ${project.createdAt?.slice(0, 10) || "unknown"}`,
    "",
    "## Team",
    ...(oracles.length > 0 ? oracles.map(o => `- ${o}`) : ["_No oracles assigned yet._"]),
    "",
    ...(project.repos && project.repos.length > 0 ? [
      "## Linked Repos",
      ...project.repos.map(r => `- [${r}](https://github.com/${r})`),
      "",
    ] : []),
    "---",
    `_Auto-generated by [Oracle Project System](https://github.com/YourOrg/maw-js)_`,
    "",
  ].join("\n");
}

function generateIssueTemplate(project: Project): string {
  return [
    "---",
    `name: "${project.name} Task"`,
    `about: "Task for ${project.name}"`,
    "---",
    "",
    "## Description",
    "",
    "## Acceptance Criteria",
    "- [ ] ",
    "",
    "## Notes",
    "",
  ].join("\n");
}

/** Scaffold a GitHub repo with standard Oracle structure.
 *  Uses gh api to create files. Only creates files that don't exist (additive). */
export async function scaffoldRepo(repo: string, project: Project): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  const files: Record<string, string> = {
    "README.md": generateRepoReadme(project),
    "ψ/inbox/focus.md": `STATE: idle\nTASK: none\nSINCE: 00:00\n`,
    "ψ/memory/logs/.gitkeep": "",
    "ψ/writing/.gitkeep": "",
    "docs/.gitkeep": "",
    ".github/ISSUE_TEMPLATE.md": generateIssueTemplate(project),
  };

  for (const [path, content] of Object.entries(files)) {
    try {
      // Check if file exists
      const checkProc = Bun.spawn(
        ["gh", "api", `repos/${repo}/contents/${path}`, "--silent"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await checkProc.exited;
      if (checkProc.exitCode === 0) {
        skipped.push(path);
        continue;
      }

      // Create file via gh api
      const encoded = Buffer.from(content).toString("base64");
      const createProc = Bun.spawn(
        ["gh", "api", `repos/${repo}/contents/${path}`, "--method", "PUT",
         "-f", `message=chore: scaffold ${path}`,
         "-f", `content=${encoded}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await createProc.exited;
      if (code === 0) created.push(path);
      else skipped.push(path);
    } catch {
      skipped.push(path);
    }
  }

  return { created, skipped };
}

/** Update README.md in a GitHub repo with latest project data */
export async function updateRepoReadme(repo: string, project: Project): Promise<boolean> {
  try {
    // Get current file SHA (required for update)
    const checkProc = Bun.spawn(
      ["gh", "api", `repos/${repo}/contents/README.md`, "--jq", ".sha"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const sha = (await new Response(checkProc.stdout).text()).trim();
    if (!sha) return false;

    const encoded = Buffer.from(generateRepoReadme(project)).toString("base64");
    const updateProc = Bun.spawn(
      ["gh", "api", `repos/${repo}/contents/README.md`, "--method", "PUT",
       "-f", `message=docs: auto-update README from project sync`,
       "-f", `content=${encoded}`,
       "-f", `sha=${sha}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    return (await updateProc.exited) === 0;
  } catch {
    return false;
  }
}
