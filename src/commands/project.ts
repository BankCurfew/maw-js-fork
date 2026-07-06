import {
  loadProjects,
  createProject,
  addTaskToProject,
  removeTaskFromProject,
  setTaskParent,
  updateProject,
  autoOrganize,
  getProjectTree,
  getProjectBoardData,
  addRepoToProject,
  removeRepoFromProject,
  getRepoMappings,
  type Project,
} from "../projects";
import { fetchBoardData, type BoardItem } from "../board";
import { readTaskLog, appendActivity, getTaskLogSummary } from "../task-log";
import { loadOracleAssignments, setOracleProject, clearOracleProject, type OracleProjectEntry } from "../oracle-projects";

// --- Helpers ---

function statusIcon(status: string): string {
  if (status === "Done") return "\x1b[32m✓\x1b[0m";
  if (status === "In Progress") return "\x1b[33m●\x1b[0m";
  if (status === "Todo") return "\x1b[37m○\x1b[0m";
  return "\x1b[90m·\x1b[0m";
}

function projectStatusColor(status: string): string {
  if (status === "active") return "\x1b[32m";
  if (status === "completed") return "\x1b[36m";
  return "\x1b[90m";
}

/** Resolve #42 → board item by matching content.number */
async function resolveItem(ref: string): Promise<BoardItem | undefined> {
  const num = ref.replace(/^#/, "");
  if (/^\d+$/.test(num)) {
    try {
      const items = await fetchBoardData();
      return items.find((i) => i.content.number === +num);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// --- Commands ---

/** maw project ls — list all projects with task counts */
export async function cmdProjectLs() {
  const data = loadProjects();
  let items: BoardItem[] = [];
  try { items = await fetchBoardData(); } catch {}
  const boardMap = new Map(items.map((i) => [i.id, i]));

  if (data.projects.length === 0) {
    console.log("No projects yet. Use \x1b[36mmaw project create <id> \"Name\"\x1b[0m to create one.");
    console.log("Or use \x1b[36mmaw project auto-organize\x1b[0m to auto-group existing tasks.");
    return;
  }

  console.log(`\n\x1b[36mProjects\x1b[0m\n`);

  for (const project of data.projects) {
    const color = projectStatusColor(project.status);
    const taskCount = project.tasks.length;
    const topLevel = project.tasks.filter((t) => !t.parentTaskId);
    const subtaskCount = project.tasks.filter((t) => t.parentTaskId).length;

    // Status breakdown
    let done = 0, inProgress = 0, todo = 0;
    for (const t of project.tasks) {
      const item = boardMap.get(t.taskId);
      if (!item) continue;
      if (item.status === "Done") done++;
      else if (item.status === "In Progress") inProgress++;
      else todo++;
    }
    const progress = taskCount > 0 ? Math.round((done / taskCount) * 100) : 0;
    const progressBar = "█".repeat(Math.round(progress / 10)) + "░".repeat(10 - Math.round(progress / 10));

    console.log(`  ${color}${project.status.toUpperCase().padEnd(10)}\x1b[0m \x1b[1m${project.name}\x1b[0m \x1b[90m(${project.id})\x1b[0m`);
    console.log(`  ${" ".repeat(10)} ${taskCount} tasks (${topLevel.length} top + ${subtaskCount} sub) | \x1b[32m${done}\x1b[0m done \x1b[33m${inProgress}\x1b[0m wip \x1b[37m${todo}\x1b[0m todo`);
    console.log(`  ${" ".repeat(10)} [${progressBar}] ${progress}%`);
    if (project.description) console.log(`  ${" ".repeat(10)} \x1b[90m${project.description}\x1b[0m`);
    console.log();
  }

  // Show unassigned count
  const assigned = new Set<string>();
  for (const p of data.projects) for (const t of p.tasks) assigned.add(t.taskId);
  const unassigned = items.filter((i) => !assigned.has(i.id));
  if (unassigned.length > 0) {
    console.log(`  \x1b[33m${unassigned.length} unassigned task${unassigned.length !== 1 ? "s" : ""}\x1b[0m — use \x1b[36mmaw project auto-organize\x1b[0m or \x1b[36mmaw project add <project> #<issue>\x1b[0m`);
    console.log();
  }
}

/** maw project show <id> — show project with task tree */
export async function cmdProjectShow(args: string[]) {
  const projectId = args[0];
  if (!projectId) {
    console.error("usage: maw project show <project-id>");
    process.exit(1);
  }

  const tree = getProjectTree(projectId);
  if (!tree) {
    console.error(`Project "${projectId}" not found`);
    process.exit(1);
  }

  let items: BoardItem[] = [];
  try { items = await fetchBoardData(); } catch {}
  const boardMap = new Map(items.map((i) => [i.id, i]));

  const { project } = tree;
  console.log(`\n\x1b[36m${project.name}\x1b[0m \x1b[90m(${project.id})\x1b[0m`);
  if (project.description) console.log(`  ${project.description}`);
  console.log(`  Status: ${projectStatusColor(project.status)}${project.status}\x1b[0m | Tasks: ${project.tasks.length}`);
  console.log();

  for (const { task, subtasks } of tree.tree) {
    const item = boardMap.get(task.taskId);
    const num = item?.content.number ? `#${item.content.number}` : "";
    const title = item?.title || task.taskId;
    const oracle = item?.oracle ? `\x1b[36m${item.oracle}\x1b[0m` : "";
    const priority = item?.priority || "";
    const si = statusIcon(item?.status || "");
    const logSummary = getTaskLogSummary(task.taskId);
    const logBadge = logSummary ? ` \x1b[90m[${logSummary.count} logs]\x1b[0m` : "";

    console.log(`  ${si} ${num.padEnd(6)} ${title.slice(0, 50).padEnd(52)} ${oracle.padEnd(18)} ${priority}${logBadge}`);

    for (const sub of subtasks) {
      const subItem = boardMap.get(sub.taskId);
      const subNum = subItem?.content.number ? `#${subItem.content.number}` : "";
      const subTitle = subItem?.title || sub.taskId;
      const subOracle = subItem?.oracle ? `\x1b[36m${subItem.oracle}\x1b[0m` : "";
      const subSi = statusIcon(subItem?.status || "");
      const subLog = getTaskLogSummary(sub.taskId);
      const subBadge = subLog ? ` \x1b[90m[${subLog.count}]\x1b[0m` : "";

      console.log(`    └─ ${subSi} ${subNum.padEnd(6)} ${subTitle.slice(0, 46).padEnd(48)} ${subOracle.padEnd(18)} ${subBadge}`);
    }
  }
  console.log();
}

/** Check if caller is BoB (only BoB can create/delete/archive projects).
 *  Fail-closed: empty/unset MAW_ORACLE = denied. */
function requireBob(action: string): void {
  const caller = (process.env.MAW_ORACLE || process.env.CLAUDE_AGENT_NAME || "").toLowerCase().replace(/-oracle$/, "");
  if (caller !== "bob" && caller !== "cli") {
    console.error(`\x1b[31m✗ Permission denied:\x1b[0m only BoB can ${action} projects (caller: ${caller || "unknown"})`);
    process.exit(1);
  }
}

/** maw project create <id> "Name" --repo <org/repo|new> [--draft] ["description"] */
export async function cmdProjectCreate(args: string[]) {
  requireBob("create");
  const id = args[0];
  const name = args[1];
  let repo: string | undefined;
  let isDraft = false;
  const descParts: string[] = [];

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === "--draft") { isDraft = true; continue; }
    descParts.push(args[i]);
  }
  const description = descParts.join(" ");

  if (!id || !name) {
    console.error('usage: maw project create <id> "Name" --repo <org/repo|new> [--draft]');
    process.exit(1);
  }
  if (!repo && !isDraft) {
    console.error('\x1b[31m✗\x1b[0m --repo required (link existing or "new" to create). Use --draft to skip.');
    process.exit(1);
  }

  try {
    const project = createProject(id, name, description);
    console.log(`\x1b[32m✓\x1b[0m Created project: \x1b[1m${project.name}\x1b[0m (${project.id})`);

    if (repo) {
      const { ssh: sshExec } = await import("../ssh");
      let repoSlug = repo;

      // Create new repo if --repo new
      if (repo === "new") {
        repoSlug = `YourOrg/${id}`;
        try {
          await sshExec(`gh repo create ${repoSlug} --private --description '${name.replace(/'/g, "'\\''")}'`);
          console.log(`  \x1b[32m+\x1b[0m Created repo: ${repoSlug}`);
        } catch (e: any) {
          console.log(`  \x1b[33m⚠\x1b[0m Repo create failed: ${e.message} — continuing`);
        }
      }

      // Link repo to project
      try {
        addRepoToProject(id, repoSlug);
        console.log(`  \x1b[32m+\x1b[0m Linked repo: ${repoSlug}`);
      } catch {}

      // Scaffold standard docs
      const DOCS = [
        { path: "README.md", content: `# ${name}\n\n> ${description || "Project description"}\n\n## Owner\n\n- TBD\n\n## Status\n\nActive\n\n## Links\n\n- [Board](https://github.com/orgs/YourOrg/projects/1)\n` },
        { path: "CHECKLIST.md", content: `# ${name} — Doc Completeness\n\n- [x] README.md\n- [ ] docs/SOP-${id}.md\n- [ ] CLAUDE.md\n- [ ] docs/ARCHITECTURE.md\n- [ ] .gitignore\n- [x] CHECKLIST.md\n` },
        { path: `docs/SOP-${id}.md`, content: `# SOP: ${name}\n\n---\nowner: TBD\nupdated: ${new Date().toISOString().slice(0, 10)}\nstatus: draft\n---\n\n## Purpose\n\n## Daily Operations\n\n## Escalation\n` },
        { path: "CLAUDE.md", content: `# ${name}\n\n## Context for Oracles\n\n${description || "Project-specific instructions."}\n\n## Standards\n\n- Follow Golden Rules\n- Use canonical repo#N refs\n` },
      ];

      for (const doc of DOCS) {
        try {
          await sshExec(`gh api repos/${repoSlug}/contents/${doc.path} --method PUT -f message='scaffold: ${doc.path}' -f content='${Buffer.from(doc.content).toString("base64")}' 2>/dev/null`);
          console.log(`  \x1b[32m+\x1b[0m ${doc.path}`);
        } catch {
          console.log(`  \x1b[90m·\x1b[0m ${doc.path} (exists or skipped)`);
        }
      }
    } else {
      console.log(`  \x1b[33m⚠\x1b[0m Draft project — no repo linked. Use: maw project repos add ${id} <org/repo>`);
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project add <project-id> #<issue> [--parent #<issue>] */
export async function cmdProjectAdd(args: string[]) {
  const projectId = args[0];
  const taskRef = args[1];
  if (!projectId || !taskRef) {
    console.error("usage: maw project add <project-id> #<issue> [--parent #<issue>]");
    process.exit(1);
  }

  // Validate ref format: must be #N or repo#N (BoB#164 — reject bad refs)
  if (!taskRef.match(/^#?\d+$/) && !taskRef.match(/^[A-Za-z0-9_.-]+#\d+$/)) {
    console.error(`\x1b[31m✗\x1b[0m invalid ref: ${taskRef} — use #N or repo#N format`);
    process.exit(1);
  }

  // Validate project exists
  const projects = loadProjects();
  if (!projects.projects.find(p => p.id === projectId)) {
    console.error(`\x1b[31m✗\x1b[0m project not found: ${projectId}`);
    process.exit(1);
  }

  let parentTaskId: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--parent" && args[i + 1]) {
      const parentItem = await resolveItem(args[++i]);
      if (parentItem) parentTaskId = parentItem.id;
    }
  }

  const item = await resolveItem(taskRef);
  if (!item) {
    // Use canonical repo#N format as taskId
    addTaskToProject(projectId, taskRef, parentTaskId);
    console.log(`\x1b[32m✓\x1b[0m Added ${taskRef} to project ${projectId}`);
    return;
  }

  try {
    addTaskToProject(projectId, item.id, parentTaskId);
    console.log(`\x1b[32m✓\x1b[0m Added #${item.content.number} "${item.title}" to project ${projectId}${parentTaskId ? " (as subtask)" : ""}`);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project remove <project-id> #<issue> */
export async function cmdProjectRemove(args: string[]) {
  const projectId = args[0];
  const taskRef = args[1];
  if (!projectId || !taskRef) {
    console.error("usage: maw project remove <project-id> #<issue>");
    process.exit(1);
  }

  const item = await resolveItem(taskRef);
  const taskId = item?.id || taskRef;

  try {
    removeTaskFromProject(projectId, taskId);
    const label = item ? `#${item.content.number}` : taskRef;
    console.log(`\x1b[32m✓\x1b[0m Removed ${label} from project ${projectId}`);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project auto-organize — auto-group unassigned board items */
export async function cmdProjectAutoOrganize() {
  let items: BoardItem[] = [];
  try { items = await fetchBoardData(); } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m Could not fetch board: ${e.message}`);
    process.exit(1);
  }

  const result = autoOrganize(items);

  if (result.created.length > 0) {
    console.log(`\x1b[32m✓\x1b[0m Created ${result.created.length} project(s): ${result.created.join(", ")}`);
  }
  if (result.moved > 0) {
    console.log(`\x1b[32m✓\x1b[0m Organized ${result.moved} task(s) into projects`);
  }
  if (result.created.length === 0 && result.moved === 0) {
    console.log("All tasks are already organized into projects.");
  }
}

/** maw project comment <project-id> "message" — comment visible to all oracles */
export async function cmdProjectComment(args: string[]) {
  const projectId = args[0];
  const message = args[1];
  if (!projectId || !message) {
    console.error('usage: maw project comment <project-id> "message"');
    process.exit(1);
  }

  const oracle = process.env.MAW_ORACLE || "cli";

  // Log comment on the project itself (use project ID as task ID)
  appendActivity({
    taskId: `project:${projectId}`,
    type: "comment",
    oracle,
    content: message,
  });

  console.log(`\x1b[32m✓\x1b[0m Comment added to project ${projectId}`);
}

/** Known oracles for default display. */
const KNOWN_ORACLES = [
  "bob", "dev", "qa", "designer", "researcher", "writer", "hr", "aia",
  "admin", "security", "doccon", "nobi", "echo", "pulse", "neo",
  ,
];

const DEFAULT_PROJECT = "team-ops";
const DEFAULT_PROJECT_NAME = "Team Operations";

/** maw project focus [id] [--oracle name] [--clear] [--audit] — set/show active project per oracle */
export async function cmdProjectFocus(args: string[]) {
  let projectId: string | undefined;
  let oracle: string | undefined;
  let clear = false;
  let audit = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--oracle" && args[i + 1]) { oracle = args[++i]; }
    else if (args[i] === "--clear") { clear = true; }
    else if (args[i] === "--audit") { audit = true; }
    else if (!args[i].startsWith("--") && !projectId) { projectId = args[i]; }
  }

  // --audit mode: show stale, missing, and fresh assignments
  if (audit) {
    const data = loadOracleAssignments();
    const projects = loadProjects();
    const projMap = new Map(projects.projects.map((p) => [p.id, p.name]));
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;

    const stale: { oracle: string; pid: string; age: string; source: string }[] = [];
    const fresh: { oracle: string; pid: string; age: string; source: string }[] = [];
    const missing: string[] = [];

    for (const orc of KNOWN_ORACLES) {
      const entry = data.assignments[orc] as OracleProjectEntry | undefined;
      if (!entry) {
        missing.push(orc);
        continue;
      }
      const age = now - new Date(entry.updatedAt).getTime();
      const ageStr = age < 60_000 ? "<1m" : age < 3600_000 ? `${Math.round(age / 60_000)}m` : `${Math.round(age / 3600_000)}h`;
      if (entry.source === "auto" && age > TWO_HOURS) {
        stale.push({ oracle: orc, pid: entry.projectId, age: `${ageStr} ago`, source: entry.source });
      } else {
        fresh.push({ oracle: orc, pid: entry.projectId, age: `${ageStr} ago`, source: entry.source });
      }
    }

    console.log("\n\x1b[36mProject Focus Audit\x1b[0m\n");

    if (stale.length > 0) {
      console.log("\x1b[31mSTALE (>2h, auto):\x1b[0m");
      for (const s of stale) {
        console.log(`  \x1b[1m${s.oracle.padEnd(16)}\x1b[0m \x1b[35m${s.pid.padEnd(20)}\x1b[0m \x1b[90m(set ${s.age}, ${s.source})\x1b[0m`);
      }
      console.log();
    }

    if (missing.length > 0) {
      console.log("\x1b[33mMISSING (no focus):\x1b[0m");
      for (const m of missing) {
        console.log(`  \x1b[1m${m.padEnd(16)}\x1b[0m \x1b[90m(no focus)\x1b[0m`);
      }
      console.log();
    }

    if (fresh.length > 0) {
      console.log("\x1b[32mFRESH:\x1b[0m");
      for (const f of fresh) {
        const name = projMap.get(f.pid) || f.pid;
        console.log(`  \x1b[1m${f.oracle.padEnd(16)}\x1b[0m \x1b[35m${f.pid.padEnd(20)}\x1b[0m \x1b[90m(set ${f.age}, ${f.source})\x1b[0m`);
      }
      console.log();
    }

    console.log(`\x1b[90mTotal: ${fresh.length} fresh, ${stale.length} stale, ${missing.length} missing\x1b[0m`);
    return;
  }

  // Show all assignments if no args
  if (!projectId && !clear) {
    const data = loadOracleAssignments();
    const projects = loadProjects();
    const projMap = new Map(projects.projects.map((p) => [p.id, p.name]));

    console.log("\n\x1b[36mOracle Project Focus\x1b[0m\n");

    // Show all known oracles — assigned ones with their project, unassigned with default
    for (const orc of KNOWN_ORACLES) {
      const entry = data.assignments[orc] as OracleProjectEntry | undefined;
      if (entry) {
        // Check if auto-focus is stale (>2h)
        const age = Date.now() - new Date(entry.updatedAt).getTime();
        const isStale = entry.source === "auto" && age > 2 * 60 * 60 * 1000;
        if (isStale) {
          // Stale auto-focus — show as default
          console.log(`  \x1b[1m${orc.padEnd(16)}\x1b[0m \x1b[90m${DEFAULT_PROJECT}\x1b[0m \x1b[90m(${DEFAULT_PROJECT_NAME})\x1b[0m \x1b[90m[default]\x1b[0m`);
        } else {
          const pid = entry.projectId;
          const src = entry.source;
          const name = projMap.get(pid) || pid;
          const srcBadge = src === "auto" ? " \x1b[90m[auto]\x1b[0m" : "";
          console.log(`  \x1b[1m${orc.padEnd(16)}\x1b[0m \x1b[35m${pid}\x1b[0m \x1b[90m(${name})\x1b[0m${srcBadge}`);
        }
      } else {
        // No assignment — show default
        console.log(`  \x1b[1m${orc.padEnd(16)}\x1b[0m \x1b[90m${DEFAULT_PROJECT}\x1b[0m \x1b[90m(${DEFAULT_PROJECT_NAME})\x1b[0m \x1b[90m[default]\x1b[0m`);
      }
    }

    // Show any extra oracles not in KNOWN_ORACLES
    for (const [orc, entry] of Object.entries(data.assignments)) {
      if (KNOWN_ORACLES.includes(orc)) continue;
      const pid = (entry as OracleProjectEntry).projectId;
      const src = (entry as OracleProjectEntry).source;
      const name = projMap.get(pid) || pid;
      const srcBadge = src === "auto" ? " \x1b[90m[auto]\x1b[0m" : "";
      console.log(`  \x1b[1m${orc.padEnd(16)}\x1b[0m \x1b[35m${pid}\x1b[0m \x1b[90m(${name})\x1b[0m${srcBadge}`);
    }
    console.log();
    return;
  }

  // Detect oracle name from env or cwd if not specified
  if (!oracle) {
    // Try MAW_ORACLE env, or derive from cwd
    oracle = process.env.MAW_ORACLE
      || process.cwd().match(/([^/]+)-[Oo]racle/)?.[1]?.toLowerCase()
      || undefined;
    if (!oracle) {
      console.error("\x1b[31m✗\x1b[0m Could not detect oracle name. Use --oracle <name>");
      process.exit(1);
    }
  }

  if (clear) {
    clearOracleProject(oracle);
    console.log(`\x1b[32m✓\x1b[0m Cleared project focus for ${oracle}`);
    return;
  }

  try {
    const entry = setOracleProject(oracle, projectId!, "manual");
    const projects = loadProjects();
    const name = projects.projects.find((p) => p.id === projectId)?.name || projectId;
    console.log(`\x1b[32m✓\x1b[0m ${oracle} → \x1b[35m${projectId}\x1b[0m (${name}) [${entry.source}]`);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project archive <id> / maw project complete <id> */
export async function cmdProjectSetStatus(args: string[], status: "completed" | "archived") {
  requireBob(status === "archived" ? "archive" : "complete");
  const projectId = args[0];
  if (!projectId) {
    console.error(`usage: maw project ${status === "completed" ? "complete" : "archive"} <project-id>`);
    process.exit(1);
  }
  try {
    updateProject(projectId, { status });
    console.log(`\x1b[32m✓\x1b[0m Project "${projectId}" marked as ${status}`);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project repos [id] [--add repo] [--remove repo] [--map] */
export async function cmdProjectRepos(args: string[]) {
  let projectId: string | undefined;
  let addRepo: string | undefined;
  let removeRepo: string | undefined;
  let showMap = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add" && args[i + 1]) addRepo = args[++i];
    else if (args[i] === "--remove" && args[i + 1]) removeRepo = args[++i];
    else if (args[i] === "--map") showMap = true;
    else if (!args[i].startsWith("--") && !projectId) projectId = args[i];
  }

  // Show all mappings
  if (showMap || (!projectId && !addRepo && !removeRepo)) {
    const mappings = getRepoMappings();
    if (mappings.length === 0) {
      console.log("\x1b[90mNo repo mappings yet.\x1b[0m Use: maw project repos <id> --add Owner/Repo");
      return;
    }
    console.log("\n\x1b[36mRepo → Project Mappings\x1b[0m\n");
    for (const m of mappings) {
      console.log(`  \x1b[1m${m.projectId.padEnd(24)}\x1b[0m \x1b[90m${m.name}\x1b[0m`);
      for (const r of m.repos) {
        console.log(`    └─ \x1b[33m${r}\x1b[0m`);
      }
    }
    console.log();
    return;
  }

  if (!projectId) {
    console.error("usage: maw project repos <id> [--add Owner/Repo] [--remove Owner/Repo] [--map]");
    process.exit(1);
  }

  if (addRepo) {
    try {
      addRepoToProject(projectId, addRepo);
      console.log(`\x1b[32m✓\x1b[0m Linked \x1b[33m${addRepo}\x1b[0m → project ${projectId}`);
      // Auto-scaffold repo structure
      const { scaffoldRepo } = await import("../project-files");
      const project = loadProjects().projects.find(p => p.id === projectId);
      if (project) {
        console.log(`\x1b[36m  scaffolding ${addRepo}...\x1b[0m`);
        const result = await scaffoldRepo(addRepo, project);
        if (result.created.length > 0) console.log(`  \x1b[32m+\x1b[0m ${result.created.join(", ")}`);
        if (result.skipped.length > 0) console.log(`  \x1b[90m~ ${result.skipped.join(", ")} (exist)\x1b[0m`);
      }
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (removeRepo) {
    try {
      removeRepoFromProject(projectId, removeRepo);
      console.log(`\x1b[32m✓\x1b[0m Unlinked \x1b[33m${removeRepo}\x1b[0m from project ${projectId}`);
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // Show repos for specific project
  const data = loadProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) { console.error(`Project "${projectId}" not found`); process.exit(1); }
  if (!project.repos || project.repos.length === 0) {
    console.log(`\x1b[90mNo repos linked to ${projectId}.\x1b[0m Use: maw project repos ${projectId} --add Owner/Repo`);
    return;
  }
  console.log(`\n\x1b[36m${project.name}\x1b[0m repos:\n`);
  for (const r of project.repos) console.log(`  \x1b[33m${r}\x1b[0m`);
  console.log();
}

/** maw project sync [id] — sync GitHub issues into projects */
export async function cmdProjectSync(args: string[]) {
  const projectId = args[0];

  console.log("\x1b[36mSyncing GitHub issues → projects...\x1b[0m\n");

  try {
    const { syncAllProjects, syncProjectById } = await import("../project-sync");
    const results = projectId
      ? await syncProjectById(projectId)
      : await syncAllProjects();

    if (results.length === 0) {
      console.log("\x1b[90mNo projects with repos to sync.\x1b[0m Use: maw project repos <id> --add Owner/Repo");
      return;
    }

    for (const r of results) {
      const badge = r.autoCompleted ? " \x1b[32m[AUTO-COMPLETED]\x1b[0m" : "";
      console.log(`  \x1b[1m${r.projectId.padEnd(20)}\x1b[0m \x1b[33m${r.repo}\x1b[0m — +${r.added} added, ${r.closed}/${r.total} closed${badge}`);
    }

    const totalAdded = results.reduce((s, r) => s + r.added, 0);
    console.log(`\n\x1b[32m✓\x1b[0m Sync complete — ${totalAdded} issues added`);

    // Auto-update repo READMEs
    const { updateRepoReadme } = await import("../project-files");
    const projects = loadProjects();
    const synced = new Set(results.map(r => r.projectId));
    for (const pid of synced) {
      const project = projects.projects.find(p => p.id === pid);
      if (project?.repos) {
        for (const repo of project.repos) {
          const ok = await updateRepoReadme(repo, project);
          if (ok) console.log(`  \x1b[90m↻ updated ${repo}/README.md\x1b[0m`);
        }
      }
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }
}

/** maw project scaffold <id> — scaffold all linked repos */
export async function cmdProjectScaffold(args: string[]) {
  const projectId = args[0];
  if (!projectId) {
    console.error("usage: maw project scaffold <project-id>");
    process.exit(1);
  }

  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) { console.error(`Project "${projectId}" not found`); process.exit(1); }
  if (!project.repos || project.repos.length === 0) {
    console.error(`Project "${projectId}" has no repos linked`);
    process.exit(1);
  }

  const { scaffoldRepo } = await import("../project-files");
  for (const repo of project.repos) {
    console.log(`\x1b[36mScaffolding ${repo}...\x1b[0m`);
    const result = await scaffoldRepo(repo, project);
    if (result.created.length > 0) console.log(`  \x1b[32m+\x1b[0m ${result.created.join(", ")}`);
    if (result.skipped.length > 0) console.log(`  \x1b[90m~ ${result.skipped.join(", ")} (exist)\x1b[0m`);
  }
  console.log(`\x1b[32m✓\x1b[0m Done`);
}
