import { ssh } from "./ssh";
import { cmdWake, detectSession } from "./commands/wake";
import { loadConfig } from "./config";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const FEED_LOG = join(process.env.HOME || "/home/curfew", ".oracle", "feed.log");

/** Write a notification to feed.log — picked up by dashboard inbox */
export function writeFeedNotification(oracle: string, message: string) {
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const host = "VuttiServer";
  // feed.log is one line per event — replace newlines with ␤ for dashboard to split back
  const flat = message.replace(/\n/g, " ␤ ");
  const line = `${ts} | ${oracle} | ${host} | Notification | ${oracle} | autopilot » ${flat}\n`;
  try {
    appendFileSync(FEED_LOG, line);
  } catch {}
}

interface BoardItem {
  id: string;
  title: string;
  status: string;
  oracle: string;
  priority: string;
  content: {
    body: string;
    number: number;
    repository: string;
    title: string;
    type: string;
    url: string;
  };
}

export interface AutopilotOpts {
  dryRun?: boolean;
  parallel?: boolean;
  skipBoard?: boolean;
  sync?: boolean;
  watch?: boolean;
  watchInterval?: number; // minutes
  owner?: string;
  project?: number;
}

export const ORACLE_MAP: Record<string, string> = {
  bob: "BoB-Oracle",
  dev: "Dev-Oracle",
  qa: "QA-Oracle",
  researcher: "Researcher-Oracle",
  writer: "Writer-Oracle",
  designer: "Designer-Oracle",
  aia: "AIA-Oracle",
  data: "Data-Oracle",
  admin: "Admin-Oracle",
  botdev: "BotDev-Oracle",
  creator: "Creator-Oracle",
  doccon: "DocCon-Oracle",
  editor: "Editor-Oracle",
  security: "Security-Oracle",
  fe: "FE-Oracle",
  pa: "PA-Oracle",
  fa: "FA-Oracle",
  cost: "Cost-Oracle",
  pulse: "Pulse-Oracle",
  hr: "HR-Oracle",
};

export const RESULT_CHAINS: Record<string, string[]> = {
  dev: ["qa"],
  botdev: ["qa"],
  fe: ["qa"],
  designer: ["dev"],
  researcher: ["writer"],
  writer: ["doccon"],
  admin: ["qa"],
  data: ["dev"],
  security: ["bob"],
  qa: [],
  hr: [],
  bob: [],
  aia: [],
  doccon: [],
  editor: [],
  creator: [],
  pa: [],
  fa: [],
  cost: [],
  pulse: [],
};

const ROUTING_RULES: { keywords: string[]; oracle: string }[] = [
  { keywords: ["code", "api", "feature", "implement", "build", "backend", "architecture", "refactor", "migration"], oracle: "dev" },
  { keywords: ["bot", "webhook", "line", "discord bot", "fa tools", "iplan", "ijourney", "fatools"], oracle: "botdev" },
  { keywords: ["test", "qa", "quality", "bug", "fix", "suite", "regression", "verify"], oracle: "qa" },
  { keywords: ["research", "analyze", "benchmark", "compare", "competitor", "explore", "market"], oracle: "researcher" },
  { keywords: ["write", "blog", "content", "document", "readme", "post", "article", "copy", "caption"], oracle: "writer" },
  { keywords: ["design", "ui", "ux", "mockup", "logo", "brand", "visual", "creative", "poster", "banner"], oracle: "designer" },
  { keywords: ["hire", "recruit", "onboard", "interview", "candidate", "people", "performance", "okr"], oracle: "hr" },
  { keywords: ["react", "css", "tailwind", "frontend", "seo", "backlink", "html", "responsive"], oracle: "fe" },
  { keywords: ["deploy", "pm2", "infra", "cloudflare", "tunnel", "server", "systemd"], oracle: "admin" },
  { keywords: ["aia", "epos", "portal", "agent", "insurance", "policy", "customer"], oracle: "aia" },
  { keywords: ["data", "pipeline", "embedding", "supabase", "scrape", "extract", "kb"], oracle: "data" },
  { keywords: ["security", "pdpa", "rls", "secret", "audit", "vulnerability"], oracle: "security" },
  { keywords: ["edit", "review", "style", "tone", "proofread", "grammar"], oracle: "editor" },
  { keywords: ["conduct", "email format", "template", "stamp", "compliance"], oracle: "doccon" },
  { keywords: ["cost", "token", "budget", "spending", "optimization"], oracle: "cost" },
  { keywords: ["calendar", "schedule", "meeting", "reminder", "personal"], oracle: "pa" },
  { keywords: ["curriculum", "workshop", "tutorial", "starter", "academy"], oracle: "creator" },
];

export function routeTask(title: string): string {
  const lower = title.toLowerCase();
  for (const rule of ROUTING_RULES) {
    if (rule.keywords.some(k => lower.includes(k))) return rule.oracle;
  }
  return "dev";
}

async function fetchBoard(owner: string, project: number): Promise<BoardItem[]> {
  const json = await ssh(`gh project item-list ${project} --owner ${owner} --format json`);
  const data = JSON.parse(json);
  return data.items || [];
}

// --- Cached project metadata ---
let cachedProjectMeta: { projectId: string; statusFieldId: string; options: Record<string, string> } | null = null;

async function getProjectMeta(owner: string, project: number) {
  if (cachedProjectMeta) return cachedProjectMeta;
  const projectJson = await ssh(`gh project view ${project} --owner ${owner} --format json`);
  const proj = JSON.parse(projectJson);
  const fieldsJson = await ssh(`gh project field-list ${project} --owner ${owner} --format json`);
  const fields = JSON.parse(fieldsJson);
  const statusField = fields.fields.find((f: any) => f.name === "Status");
  const options: Record<string, string> = {};
  for (const opt of statusField?.options || []) options[opt.name] = opt.id;
  cachedProjectMeta = { projectId: proj.id, statusFieldId: statusField?.id || "", options };
  return cachedProjectMeta;
}

export async function setItemStatus(owner: string, project: number, itemId: string, status: string) {
  const meta = await getProjectMeta(owner, project);
  if (!meta.statusFieldId) return;
  const optionId = meta.options[status];
  if (!optionId) return;
  await ssh(`gh project item-edit --project-id '${meta.projectId}' --id '${itemId}' --field-id '${meta.statusFieldId}' --single-select-option-id '${optionId}'`);
}

// --- Assignee management ---
export async function assignIssue(repo: string, issueNumber: number, assignee: string) {
  try {
    await ssh(`gh issue edit ${issueNumber} --repo '${repo}' --add-assignee '${assignee}'`);
  } catch { /* assignee might not exist as GitHub user */ }
}

// --- Link result to issue ---
export async function commentResult(repo: string, issueNumber: number, resultSummary: string) {
  const escaped = resultSummary.replace(/'/g, "'\\''");
  await ssh(`gh issue comment ${issueNumber} --repo '${repo}' --body '${escaped}'`);
}

export async function closeIssue(repo: string, issueNumber: number) {
  await ssh(`gh issue close ${issueNumber} --repo '${repo}' --reason completed`);
}

// --- Check if oracle finished its task ---
export async function checkOracleResult(oracle: string): Promise<{ done: boolean; summary: string; commitHash: string } | null> {
  const oracleName = ORACLE_MAP[oracle.toLowerCase()];
  if (!oracleName) return null;
  const ghqRoot = loadConfig().ghqRoot;
  const repoPath = `${ghqRoot}/YourOrg/${oracleName}`;

  try {
    // Check if tmux pane shows a completed session (bash prompt visible = claude exited)
    const session = await detectSession(oracle.toLowerCase());
    if (!session) return { done: true, summary: "", commitHash: "" };

    // Check latest commit
    const log = await ssh(`git -C '${repoPath}' log --oneline -1`);
    const hash = log.split(" ")[0] || "";
    const msg = log.slice(hash.length + 1).trim();

    // Check if claude is still running in the tmux pane
    try {
      const winList = await ssh(`tmux list-windows -t '${session}' -F '#{window_name}:#{pane_current_command}' 2>/dev/null`);
      const oracleWin = winList.split("\n").find(l => l.startsWith(oracle.toLowerCase() + ":"));
      if (oracleWin) {
        const cmd = oracleWin.split(":")[1] || "";
        // If running bash/zsh (not claude/node), the agent finished
        if (/^(bash|zsh)$/.test(cmd)) {
          return { done: true, summary: msg, commitHash: hash };
        }
        return { done: false, summary: "", commitHash: "" };
      }
    } catch {}

    return { done: true, summary: msg, commitHash: hash };
  } catch {
    return null;
  }
}

// --- Get recent commits for an oracle since a reference time ---
export async function getRecentCommits(oracle: string, since?: string): Promise<string[]> {
  const oracleName = ORACLE_MAP[oracle.toLowerCase()];
  if (!oracleName) return [];
  const ghqRoot = loadConfig().ghqRoot;
  const repoPath = `${ghqRoot}/YourOrg/${oracleName}`;
  try {
    const sinceArg = since ? `--since='${since} 00:00:00'` : "--since='12 hours ago'";
    const log = await ssh(`git -C '${repoPath}' log --oneline ${sinceArg}`);
    return log.split("\n").filter(Boolean);
  } catch { return []; }
}

// --- Scan repo for related files ---
async function scanRepoContext(oracle: string, task: string): Promise<{ files: string[]; structure: string }> {
  const oracleName = ORACLE_MAP[oracle.toLowerCase()];
  if (!oracleName) return { files: [], structure: "" };
  const ghqRoot = loadConfig().ghqRoot;
  const repoPath = `${ghqRoot}/YourOrg/${oracleName}`;

  const files: string[] = [];
  const taskLower = task.toLowerCase();

  // Get repo file tree (top 2 levels, excluding node_modules/.git)
  let structure = "";
  try {
    structure = await ssh(`find '${repoPath}' -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.tmp/*' -type f | sed 's|${repoPath}/||' | sort | head -30`);
  } catch {}

  // Find potentially related files by keyword matching
  const keywords = taskLower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !["that", "this", "with", "from", "have", "been", "will", "should", "could", "would", "about", "into", "their", "them", "they", "than", "then", "when", "what", "which", "where", "your", "each", "make", "like", "just", "over", "such", "take", "also", "back", "after", "only", "most", "other", "some", "very", "more", "need", "does"].includes(w));

  for (const kw of keywords.slice(0, 5)) {
    try {
      const matches = await ssh(`grep -rl '${kw}' '${repoPath}/src' '${repoPath}/CLAUDE.md' '${repoPath}/README.md' 2>/dev/null | sed 's|${repoPath}/||' | head -5`);
      for (const f of matches.split("\n").filter(Boolean)) {
        if (!files.includes(f)) files.push(f);
      }
    } catch {}
  }

  // Always include CLAUDE.md and README.md if they exist
  try {
    const core = await ssh(`ls '${repoPath}/CLAUDE.md' '${repoPath}/README.md' '${repoPath}/package.json' 2>/dev/null | sed 's|${repoPath}/||'`);
    for (const f of core.split("\n").filter(Boolean)) {
      if (!files.includes(f)) files.unshift(f);
    }
  } catch {}

  // Get recent git activity for context
  try {
    const recent = await ssh(`git -C '${repoPath}' log --oneline -5`);
    if (recent.trim()) {
      files.push(`(recent commits: ${recent.split("\n").length})`);
    }
  } catch {}

  return { files: files.slice(0, 10), structure };
}

// --- Create structured dispatch issue ---
export async function createDispatchIssue(oracle: string, task: string, item?: BoardItem): Promise<{ issueUrl: string; issueNum: number; boardItemId: string }> {
  const oracleName = ORACLE_MAP[oracle.toLowerCase()];
  if (!oracleName) throw new Error(`Unknown oracle: ${oracle}`);
  const repo = `YourOrg/${oracleName}`;

  // Scan repo for context
  const ctx = await scanRepoContext(oracle, task);

  // Build detailed issue body
  const lines: string[] = [];

  // --- What ---
  lines.push(`## What`);
  lines.push(``);
  lines.push(task);
  lines.push(``);
  lines.push(`### Scope`);
  lines.push(``);
  lines.push(`1. Understand the current codebase and existing patterns`);
  lines.push(`2. Plan the implementation approach before writing code`);
  lines.push(`3. Implement with clean, tested code`);
  lines.push(`4. Ensure no regressions — existing functionality must still work`);
  lines.push(``);
  lines.push(`### Expected Output`);
  lines.push(``);
  lines.push(`- [ ] Implementation complete and working`);
  lines.push(`- [ ] Code committed with clear commit message`);
  lines.push(`- [ ] Pushed to remote`);
  lines.push(`- [ ] Report posted on this issue`);
  lines.push(``);

  // --- Related ---
  if (ctx.files.length > 0) {
    lines.push(`## Related`);
    lines.push(``);
    for (const f of ctx.files) {
      if (f.startsWith("(")) {
        lines.push(`- ${f}`);
      } else {
        lines.push(`- \`${f}\``);
      }
    }
    lines.push(``);
  }

  // --- Delegation Protocol ---
  lines.push(`## Delegation Protocol`);
  lines.push(``);
  lines.push(`1. \`/recap\` — orient yourself in the repo`);
  lines.push(`2. Read related files listed above to understand context`);
  lines.push(`3. \`/plan\` before implementing — get alignment on approach`);
  lines.push(`4. Implement after plan is clear`);
  lines.push(`5. Commit with a clear message and push to remote`);
  lines.push(`6. **Report back on this issue**: commit hash, files changed, summary`);
  lines.push(`7. **⚠️ MANDATORY: \`/talk-to bob "done: [สรุปสิ่งที่ทำ] — commits: [hash] PR: [url]"\`**`);
  lines.push(``);
  lines.push(`> **LAW #7: ทุกครั้งที่เสร็จงาน หรือต้องการประสานงาน MUST /talk-to bob**`);
  lines.push(`> ห้ามจบ session โดยไม่ report bob เด็ดขาด — งานจะไม่ไหลต่อ`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Created by BoB-Oracle — delegated to ${oracleName}*`);

  const body = lines.join("\n");
  const escapedTitle = task.replace(/'/g, "'\\''");
  const escapedBody = body.replace(/'/g, "'\\''");

  const issueUrl = (await ssh(
    `gh issue create --repo '${repo}' --title '${escapedTitle}' --body '${escapedBody}' --label 'oracle:${oracle.toLowerCase()}'`
  )).trim();

  const m = issueUrl.match(/\/(\d+)$/);
  const issueNum = m ? +m[1] : 0;

  // Add to project board and capture item ID
  let boardItemId = "";
  try {
    const addOutput = await ssh(`gh project item-add 1 --owner YourOrg --url '${issueUrl}'`);
    // gh project item-add outputs the item ID
    boardItemId = addOutput.trim();
  } catch { /* board add optional */ }

  return { issueUrl, issueNum, boardItemId };
}

// --- Dispatch ---
export async function dispatchToOracle(oracle: string, task: string, item?: BoardItem, supervisor?: import("./supervisor").BobSupervisor): Promise<string> {
  const oracleName = ORACLE_MAP[oracle.toLowerCase()];

  // Create structured GitHub issue
  let issueNum = 0;
  let issueUrl = "";
  let boardItemId = "";
  try {
    const issue = await createDispatchIssue(oracle, task, item);
    issueNum = issue.issueNum;
    issueUrl = issue.issueUrl;
    boardItemId = issue.boardItemId;
    console.log(`  \x1b[32m+\x1b[0m issue #${issueNum}: ${issueUrl}`);
  } catch (e: any) {
    console.log(`  \x1b[33mwarn\x1b[0m: could not create issue: ${e.message}`);
  }

  // Set board item status to "In Progress"
  if (boardItemId) {
    try {
      await setItemStatus("YourOrg", 1, boardItemId, "In Progress");
      console.log(`  \x1b[33m●\x1b[0m board → In Progress`);
    } catch { /* status update optional */ }
  }

  // Build prompt that references the issue
  const promptLines = [
    `You have been assigned a task.`,
    issueNum ? `Issue: ${issueUrl} (#${issueNum})` : "",
    ``,
    `## Task`,
    task,
    ``,
    `## Protocol`,
    `1. Understand the task fully`,
    `2. Plan before implementing`,
    `3. Implement and commit with clear message`,
    `4. Push to remote`,
    issueNum ? `5. Report back on issue #${issueNum} with: commit hash, files changed, summary` : `5. Report what you did`,
    `6. **⚠️ MANDATORY: /talk-to bob "done: [สรุป] — commits: [hash] PR: [url]"**`,
    ``,
    `> LAW #7: ทุกครั้งที่เสร็จงาน/ติดปัญหา/ต้องประสานงาน → MUST /talk-to bob`,
    `> ห้ามจบ session โดยไม่ report bob — งานจะไม่ไหลต่อ`,
  ].filter(Boolean).join("\n");

  const target = await cmdWake(oracle.toLowerCase(), { prompt: promptLines });

  // Write feed notification so dashboard inbox picks it up
  writeFeedNotification(oracleName || oracle, `Task dispatched: ${task}${issueNum ? ` (issue #${issueNum})` : ""}`);

  // Track with supervisor if provided
  if (supervisor) {
    supervisor.track(oracle, target, task, issueUrl, issueNum, boardItemId);
    // Verify dispatch in background
    const { verifyDispatch } = await import("./supervisor");
    verifyDispatch(oracle, target).catch(() => {});
  }

  return target;
}

// --- Sync: reconcile board with actual repo state ---
export async function cmdAutopilotSync(opts: AutopilotOpts = {}) {
  const owner = opts.owner || "YourOrg";
  const project = opts.project || 1;

  console.log("\n  \x1b[36mBoB's Office — Board Sync\x1b[0m\n");

  const items = await fetchBoard(owner, project);
  let updated = 0;

  for (const item of items) {
    const oracle = (item.oracle || "").toLowerCase();
    if (!oracle || !ORACLE_MAP[oracle]) continue;
    const repo = item.content.repository;
    const issueNum = item.content.number;
    if (!repo || !issueNum) continue;

    // Get recent commits from this oracle
    const commits = await getRecentCommits(oracle, "2026-03-14");
    const hasNewCommits = commits.length > 0;

    if (item.status === "Todo" && hasNewCommits) {
      // Oracle committed work — update to Done
      const commitSummary = commits.slice(0, 3).map(c => `- \`${c}\``).join("\n");
      const body = `## Task completed by ${ORACLE_MAP[oracle]}\n\n${commitSummary}\n\nAutomatically closed by BoB's Autopilot.`;

      if (!opts.dryRun) {
        // Assign the issue to YourOrg (owner)
        await assignIssue(repo, issueNum, "YourOrg");
        // Comment with result
        await commentResult(repo, issueNum, body);
        // Close the issue
        await closeIssue(repo, issueNum);
        // Update board status
        await setItemStatus(owner, project, item.id, "Done");
      }

      console.log(`  \x1b[32m✓\x1b[0m ${item.title}`);
      console.log(`    → ${oracle}: ${commits[0]}`);
      console.log(`    → issue #${issueNum} closed, board → Done`);
      updated++;
    } else if (item.status === "Done") {
      console.log(`  \x1b[90m●\x1b[0m ${item.title} — already done`);
    } else if (item.status === "In Progress") {
      // Check if agent finished
      const result = await checkOracleResult(oracle);
      if (result?.done && hasNewCommits) {
        const commitSummary = commits.slice(0, 3).map(c => `- \`${c}\``).join("\n");
        const body = `## Task completed by ${ORACLE_MAP[oracle]}\n\n${commitSummary}\n\nAutomatically closed by BoB's Autopilot.`;
        if (!opts.dryRun) {
          await assignIssue(repo, issueNum, "YourOrg");
          await commentResult(repo, issueNum, body);
          await closeIssue(repo, issueNum);
          await setItemStatus(owner, project, item.id, "Done");
        }
        console.log(`  \x1b[32m✓\x1b[0m ${item.title} — finished, closing`);
        updated++;
      } else {
        console.log(`  \x1b[33m●\x1b[0m ${item.title} — still in progress`);
      }
    } else {
      console.log(`  \x1b[90m○\x1b[0m ${item.title} — no commits yet`);
    }
  }

  console.log(`\n  \x1b[32m${updated} items updated.\x1b[0m\n`);

  // Show final board
  const final = await fetchBoard(owner, project);
  for (const item of final) {
    const statusColor = item.status === "Done" ? "\x1b[32m" : item.status === "In Progress" ? "\x1b[33m" : "\x1b[90m";
    console.log(`  ${statusColor}●\x1b[0m ${item.title.slice(0, 50).padEnd(50)} ${statusColor}${item.status}\x1b[0m → ${item.oracle || "-"}`);
  }
  console.log();

  // --- Compile and send report to inbox ---
  const doneItems = final.filter(i => i.status === "Done");
  const inProgressItems = final.filter(i => i.status === "In Progress");
  const todoItems = final.filter(i => i.status === "Todo");

  const reportLines: string[] = [];
  reportLines.push(`Board Sync Complete — ${doneItems.length}/${final.length} tasks done`);
  reportLines.push("");

  for (const item of final) {
    const oracle = (item.oracle || "").toLowerCase();
    const commits = oracle && ORACLE_MAP[oracle] ? await getRecentCommits(oracle) : [];
    const lastCommit = commits[0] || "(no commits)";
    const icon = item.status === "Done" ? "+" : item.status === "In Progress" ? "~" : "-";
    reportLines.push(`${icon} ${item.oracle || "?"}: ${item.title}`);
    if (item.status === "Done" && commits.length > 0) {
      reportLines.push(`  ${lastCommit}`);
    }
  }

  if (todoItems.length > 0) {
    reportLines.push("");
    reportLines.push(`${todoItems.length} tasks remaining.`);
  } else if (inProgressItems.length === 0) {
    reportLines.push("");
    reportLines.push("All tasks complete!");
  }

  const report = reportLines.join("\n");

  if (!opts.dryRun) {
    writeFeedNotification("BoB-Oracle", `[report] ${report}`);
    console.log("  \x1b[36m📬\x1b[0m Report sent to inbox\n");
  }
}

// --- Watch mode: BoB checks board on a schedule ---
export async function cmdAutopilotWatch(opts: AutopilotOpts = {}) {
  const intervalMin = opts.watchInterval || 10;
  const owner = opts.owner || "YourOrg";
  const project = opts.project || 1;

  console.log("\n\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m     BoB's Office — Watch Mode                \x1b[36m║\x1b[0m");
  console.log(`\x1b[36m║\x1b[0m     Checking every ${String(intervalMin).padEnd(2)}min                       \x1b[36m║\x1b[0m`);
  console.log("\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m\n");

  const check = async () => {
    const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    console.log(`\n  \x1b[36m[${now}]\x1b[0m BoB checking the board...\n`);

    try {
      const items = await fetchBoard(owner, project);
      const todos = items.filter(i => i.status?.toLowerCase() === "todo");
      const inProgress = items.filter(i => i.status?.toLowerCase() === "in progress");

      // 1. Check in-progress items — are they done?
      for (const item of inProgress) {
        const oracle = (item.oracle || "").toLowerCase();
        if (!oracle) continue;

        const result = await checkOracleResult(oracle);
        const commits = await getRecentCommits(oracle, "2026-03-14");

        if (result?.done && commits.length > 0) {
          const repo = item.content.repository;
          const issueNum = item.content.number;
          const commitSummary = commits.slice(0, 3).map(c => `- \`${c}\``).join("\n");
          const body = `## Task completed by ${ORACLE_MAP[oracle]}\n\n${commitSummary}\n\nAutomatically closed by BoB's Autopilot.`;

          await assignIssue(repo, issueNum, "YourOrg");
          await commentResult(repo, issueNum, body);
          await closeIssue(repo, issueNum);
          await setItemStatus(owner, project, item.id, "Done");
          console.log(`  \x1b[32m✓\x1b[0m ${oracle} finished: ${item.title}`);
        } else if (!result?.done) {
          console.log(`  \x1b[33m⏳\x1b[0m ${oracle} still working: ${item.title}`);
        }
      }

      // 2. Dispatch new todo items
      if (todos.length > 0) {
        console.log(`\n  \x1b[33m${todos.length}\x1b[0m new Todo items — dispatching...\n`);

        const byOracle = new Map<string, BoardItem>();
        for (const item of todos) {
          const oracle = (item.oracle || routeTask(item.title)).toLowerCase();
          if (!byOracle.has(oracle)) byOracle.set(oracle, item);
        }

        await Promise.allSettled(
          [...byOracle.entries()].map(async ([oracle, item]) => {
            try {
              await setItemStatus(owner, project, item.id, "In Progress");
              const target = await dispatchToOracle(oracle, item.title);
              console.log(`  \x1b[36m⚡\x1b[0m ${oracle} → ${target}: ${item.title}`);
            } catch (e: any) {
              console.log(`  \x1b[31m✗\x1b[0m ${oracle} failed: ${e.message}`);
              try { await setItemStatus(owner, project, item.id, "Todo"); } catch {}
            }
          })
        );
      } else if (inProgress.length === 0) {
        console.log("  \x1b[32m✓\x1b[0m All clear — no pending tasks.");
      }

      // Summary
      const finalItems = await fetchBoard(owner, project);
      const done = finalItems.filter(i => i.status === "Done").length;
      const prog = finalItems.filter(i => i.status === "In Progress").length;
      const todo = finalItems.filter(i => i.status === "Todo").length;
      console.log(`\n  Board: \x1b[32m${done} done\x1b[0m | \x1b[33m${prog} in progress\x1b[0m | \x1b[90m${todo} todo\x1b[0m`);

      // If everything is done, send report and exit watch
      if (todo === 0 && prog === 0) {
        const reportLines = [`All ${done} tasks complete!`, ""];
        for (const item of finalItems) {
          const o = (item.oracle || "").toLowerCase();
          const commits = o && ORACLE_MAP[o] ? await getRecentCommits(o) : [];
          reportLines.push(`+ ${item.oracle}: ${item.title}`);
          if (commits[0]) reportLines.push(`  ${commits[0]}`);
        }
        writeFeedNotification("BoB-Oracle", `[report] ${reportLines.join("\n")}`);
        console.log("\n  \x1b[32m🎉 All tasks complete! BoB signing off.\x1b[0m");
        console.log("  \x1b[36m📬\x1b[0m Report sent to inbox\n");
        return false; // signal to stop
      }
    } catch (e: any) {
      console.log(`  \x1b[31merror\x1b[0m: ${e.message}`);
    }

    return true; // continue watching
  };

  // Run first check immediately
  let shouldContinue = await check();

  // Then run on interval
  if (shouldContinue) {
    const intervalId = setInterval(async () => {
      shouldContinue = await check();
      if (!shouldContinue) clearInterval(intervalId);
    }, intervalMin * 60_000);
  }
}

// --- Main autopilot command ---
export async function cmdAutopilot(opts: AutopilotOpts = {}) {
  // Route to subcommands
  if (opts.sync) return cmdAutopilotSync(opts);
  if (opts.watch) return cmdAutopilotWatch(opts);

  const owner = opts.owner || "YourOrg";
  const project = opts.project || 1;
  const skipBoard = opts.skipBoard || false;

  console.log();
  console.log("\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m     BoB's Office — Autopilot Mode            \x1b[36m║\x1b[0m");
  console.log(`\x1b[36m║\x1b[0m     ${new Date().toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }).padEnd(37)}\x1b[36m║\x1b[0m`);
  if (skipBoard) {
    console.log("\x1b[36m║\x1b[0m     \x1b[33m--skip-board\x1b[0m  (no GitHub API calls)     \x1b[36m║\x1b[0m");
  }
  console.log("\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m");
  console.log();

  let todos: BoardItem[];
  if (skipBoard) {
    todos = getOfflineTodos();
  } else {
    const items = await fetchBoard(owner, project);
    todos = items.filter(i => i.status?.toLowerCase() === "todo");
  }

  if (todos.length === 0) {
    console.log("  \x1b[32m✓\x1b[0m No Todo items on the board. All clear!");
    return;
  }

  todos.sort((a, b) => (a.priority || "P9").localeCompare(b.priority || "P9"));

  console.log(`  Found \x1b[33m${todos.length}\x1b[0m Todo items:\n`);
  for (const item of todos) {
    const oracle = item.oracle || routeTask(item.title);
    const assigned = item.oracle ? oracle : `${oracle} (auto)`;
    console.log(`  [\x1b[33m${item.priority || "-"}\x1b[0m] ${item.title} → \x1b[36m${assigned}\x1b[0m`);
  }
  console.log();

  if (opts.dryRun) {
    console.log("  \x1b[33m--dry-run\x1b[0m: No tasks dispatched.");
    return;
  }

  if (opts.parallel) {
    console.log("  Mode: \x1b[36mPARALLEL\x1b[0m (all oracles simultaneously)\n");
    const byOracle = new Map<string, BoardItem>();
    for (const item of todos) {
      const oracle = (item.oracle || routeTask(item.title)).toLowerCase();
      if (!byOracle.has(oracle)) byOracle.set(oracle, item);
    }

    await Promise.allSettled(
      [...byOracle.entries()].map(async ([oracle, item]) => {
        console.log(`  \x1b[36m⚡\x1b[0m Dispatching to ${oracle}: ${item.title}`);
        if (!skipBoard) {
          try { await setItemStatus(owner, project, item.id, "In Progress"); } catch {}
        }
        try {
          const target = await dispatchToOracle(oracle, item.title);
          console.log(`  \x1b[32m✓\x1b[0m ${oracle} → ${target}`);
        } catch (e: any) {
          console.log(`  \x1b[31m✗\x1b[0m ${oracle} failed: ${e.message}`);
          if (!skipBoard) {
            try { await setItemStatus(owner, project, item.id, "Todo"); } catch {}
          }
        }
      })
    );
  } else {
    console.log("  Mode: \x1b[36mSEQUENTIAL\x1b[0m (one at a time, by priority)\n");
    for (const item of todos) {
      const oracle = (item.oracle || routeTask(item.title)).toLowerCase();
      console.log(`  \x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
      console.log(`  Dispatching: ${item.title}`);
      console.log(`  Oracle: \x1b[36m${oracle}\x1b[0m | Priority: ${item.priority || "-"}`);
      console.log(`  \x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
      if (!skipBoard) {
        try { await setItemStatus(owner, project, item.id, "In Progress"); } catch {}
      }
      try {
        const target = await dispatchToOracle(oracle, item.title);
        console.log(`  \x1b[32m✓\x1b[0m Dispatched → ${target}`);
      } catch (e: any) {
        console.log(`  \x1b[31m✗\x1b[0m Failed: ${e.message}`);
        if (!skipBoard) {
          try { await setItemStatus(owner, project, item.id, "Todo"); } catch {}
        }
      }
      console.log();
    }
  }

  console.log("\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m     Autopilot complete                        \x1b[36m║\x1b[0m");
  console.log("\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m");
  console.log();

  if (!skipBoard) {
    console.log("  \x1b[90mBoard status:\x1b[0m");
    const final = await fetchBoard(owner, project);
    for (const item of final) {
      const statusColor = item.status === "Done" ? "\x1b[32m" : item.status === "In Progress" ? "\x1b[33m" : "\x1b[90m";
      console.log(`  ${statusColor}●\x1b[0m ${item.title.slice(0, 50).padEnd(50)} ${statusColor}${item.status}\x1b[0m → ${item.oracle || "-"}`);
    }
    console.log();
  }
}

// --- Supervise mode: dispatch + actively supervise agents ---
export async function cmdAutopilotSupervise(opts: AutopilotOpts = {}) {
  const { BobSupervisor } = await import("./supervisor");
  const owner = opts.owner || "YourOrg";
  const project = opts.project || 1;

  console.log();
  console.log("\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m     BoB's Office — Supervise Mode             \x1b[36m║\x1b[0m");
  console.log(`\x1b[36m║\x1b[0m     ${new Date().toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }).padEnd(37)}\x1b[36m║\x1b[0m`);
  console.log("\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m");
  console.log();

  const supervisor = new BobSupervisor();

  const items = await fetchBoard(owner, project);
  const todos = items.filter(i => i.status?.toLowerCase() === "todo");
  const inProgress = items.filter(i => i.status?.toLowerCase() === "in progress");

  // Track already in-progress items
  for (const item of inProgress) {
    const oracle = (item.oracle || "").toLowerCase();
    if (!oracle || !ORACLE_MAP[oracle]) continue;
    supervisor.track(oracle, "", item.title, item.content.url, item.content.number, item.id);
    console.log(`  \x1b[33m●\x1b[0m Tracking in-progress: ${oracle} — ${item.title}`);
  }

  if (todos.length > 0) {
    console.log(`\n  Found \x1b[33m${todos.length}\x1b[0m Todo items — dispatching...\n`);

    if (opts.dryRun) {
      for (const item of todos) {
        const oracle = item.oracle || routeTask(item.title);
        console.log(`  \x1b[90m○\x1b[0m Would dispatch: ${item.title} → ${oracle}`);
      }
      console.log("\n  \x1b[33m--dry-run\x1b[0m: No tasks dispatched.");
      return;
    }

    const byOracle = new Map<string, BoardItem>();
    for (const item of todos) {
      const oracle = (item.oracle || routeTask(item.title)).toLowerCase();
      if (!byOracle.has(oracle)) byOracle.set(oracle, item);
    }

    await Promise.allSettled(
      [...byOracle.entries()].map(async ([oracle, item]) => {
        try {
          await setItemStatus(owner, project, item.id, "In Progress");
          const target = await dispatchToOracle(oracle, item.title, item, supervisor);
          console.log(`  \x1b[32m✓\x1b[0m ${oracle} → ${target}: ${item.title}`);
        } catch (e: any) {
          console.log(`  \x1b[31m✗\x1b[0m ${oracle} failed: ${e.message}`);
          try { await setItemStatus(owner, project, item.id, "Todo"); } catch {}
        }
      })
    );
  }

  // Start supervisor loop
  supervisor.start();
  console.log(`\n  Supervising ${supervisor.getTracked().length} agents. Press Ctrl+C to stop.\n`);
}

// Offline fallback
function getOfflineTodos(): BoardItem[] {
  const tasks: { title: string; oracle: string; priority: string }[] = [
    { title: "Setup pulse-cli integration for daily standups", oracle: "BoB", priority: "P1" },
    { title: "Write test suite for pulse-cli integration", oracle: "QA", priority: "P2" },
    { title: "Research competitor AI workforce tools", oracle: "Researcher", priority: "P2" },
    { title: "Design BoB's Office logo and brand identity", oracle: "Designer", priority: "P2" },
    { title: "Create onboarding guide for new Oracle agents", oracle: "HR", priority: "P2" },
    { title: "Write blog post: How BoB's Office was born", oracle: "Writer", priority: "P3" },
  ];
  return tasks.map((t, i) => ({
    id: `offline-${i}`,
    title: t.title,
    status: "Todo",
    oracle: t.oracle,
    priority: t.priority,
    content: { body: "", number: 0, repository: "", title: t.title, type: "Issue", url: "" },
  }));
}
