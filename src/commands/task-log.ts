import { appendActivity, readTaskLog, getAllLogSummaries, type TaskActivityType } from "../task-log";
import { fetchBoardData, setFieldByName, type BoardItem } from "../board";

// --- Helpers ---

/** Resolve #42 → board item ID by matching content.number */
async function resolveTaskId(ref: string): Promise<{ taskId: string; item?: BoardItem }> {
  const num = ref.replace(/^#/, "");
  if (/^\d+$/.test(num)) {
    try {
      const items = await fetchBoardData();
      const item = items.find((i) => i.content.number === +num);
      if (item) return { taskId: item.id, item };
    } catch { /* board fetch failed, use raw */ }
  }
  // Fallback: use raw string as taskId
  return { taskId: ref };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

const TYPE_ICONS: Record<TaskActivityType, string> = {
  message: "\x1b[34m💬\x1b[0m",
  commit: "\x1b[32m📦\x1b[0m",
  status_change: "\x1b[33m🔄\x1b[0m",
  note: "\x1b[37m📝\x1b[0m",
  blocker: "\x1b[31m🚫\x1b[0m",
  comment: "\x1b[34m🗨\x1b[0m",
};

// --- Commands ---

/** maw task log <issue#> "message" [--commit hash msg] [--blocker "desc"] */
export async function cmdTaskLog(args: string[]) {
  const ref = args[0];
  if (!ref) {
    console.error("usage: maw task log <issue#> \"message\" [--commit \"hash msg\"] [--blocker \"desc\"]");
    process.exit(1);
  }

  const { taskId, item } = await resolveTaskId(ref);

  let type: TaskActivityType = "note";
  let content = "";
  let meta: Record<string, string> | undefined;

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--commit" && args[i + 1]) {
      type = "commit";
      const commitStr = args[++i];
      const spaceIdx = commitStr.indexOf(" ");
      if (spaceIdx > 0) {
        meta = { commitHash: commitStr.slice(0, spaceIdx) };
        content = commitStr.slice(spaceIdx + 1);
      } else {
        meta = { commitHash: commitStr };
        content = commitStr;
      }
    } else if (args[i] === "--blocker" && args[i + 1]) {
      type = "blocker";
      content = args[++i];
    } else if (args[i] === "--status" && args[i + 1]) {
      type = "status_change";
      content = args[++i];
    } else if (!content) {
      content = args[i];
    }
  }

  if (!content) {
    console.error("usage: maw task log <issue#> \"message\"");
    process.exit(1);
  }

  // Detect oracle from environment or default
  const oracle = process.env.MAW_ORACLE || "cli";

  const activity = appendActivity({ taskId, type, oracle, content, meta });

  // Auto-set project focus based on task → project mapping
  if (oracle !== "cli") {
    try {
      const { autoSetProjectFromTask } = await import("../oracle-projects");
      const projectId = autoSetProjectFromTask(oracle, taskId);
      if (projectId) {
        console.log(`  \x1b[35m→ focus: ${projectId}\x1b[0m [auto]`);
      }
    } catch {}
  }

  const label = item ? `#${item.content.number} ${item.title}` : taskId;
  console.log(`\x1b[32m✓\x1b[0m Logged ${type} on ${label}`);
  console.log(`  ${TYPE_ICONS[type]} ${content}`);
}

/** maw task ls — board table with activity counts */
export async function cmdTaskLs() {
  const summaries = getAllLogSummaries();
  let items: BoardItem[] = [];
  try {
    items = await fetchBoardData();
  } catch (e: any) {
    const msg = e?.message || "";
    if (msg.includes("read:project")) {
      console.error("\x1b[33m⚠\x1b[0m Board API: missing scope — run: gh auth refresh -s read:project");
    } else {
      console.error(`\x1b[33m⚠\x1b[0m Could not fetch board data: ${msg}`);
    }
  }

  if (items.length === 0 && Object.keys(summaries).length === 0) {
    console.log("No tasks or activity logs found.");
    return;
  }

  console.log(`\n\x1b[36mTask Board + Activity\x1b[0m\n`);
  console.log(
    `  ${"#".padEnd(6)} ${"Title".padEnd(40)} ${"Oracle".padEnd(12)} ${"Status".padEnd(14)} ${"Logs".padEnd(6)} ${"Last"}`
  );
  console.log("  " + "─".repeat(100));

  for (const item of items) {
    const summary = summaries[item.id];
    const logCount = summary ? String(summary.count) : "-";
    const lastTime = summary ? formatDate(summary.lastActivity) + " " + formatTime(summary.lastActivity) : "-";
    const blockerFlag = summary?.hasBlockers ? " \x1b[31m!\x1b[0m" : "";

    const num = item.content.number > 0 ? `#${item.content.number}` : "-";
    console.log(
      `  ${num.padEnd(6)} ${item.title.slice(0, 38).padEnd(40)} ${(item.oracle || "-").padEnd(12)} ${(item.status || "-").padEnd(14)} ${logCount.padEnd(6)} ${lastTime}${blockerFlag}`
    );
  }

  // Show orphaned logs (logs without board items)
  const boardIds = new Set(items.map((i) => i.id));
  const orphaned = Object.entries(summaries).filter(([id]) => !boardIds.has(id));
  if (orphaned.length > 0) {
    console.log(`\n  \x1b[33mOrphaned logs:\x1b[0m`);
    for (const [id, s] of orphaned) {
      console.log(`  ${id.slice(0, 20).padEnd(22)} ${String(s.count).padEnd(6)} ${formatDate(s.lastActivity)} (${s.contributors.join(", ")})`);
    }
  }

  console.log();
}

/** maw task comment <issue#> "message" — comment for cross-oracle discussion */
export async function cmdTaskComment(args: string[]) {
  const ref = args[0];
  const message = args[1];
  if (!ref || !message) {
    console.error('usage: maw task comment <issue#> "message"');
    process.exit(1);
  }

  const { taskId, item } = await resolveTaskId(ref);
  const oracle = process.env.MAW_ORACLE || "cli";

  appendActivity({ taskId, type: "comment", oracle, content: message });

  const label = item ? `#${item.content.number} ${item.title}` : taskId;
  console.log(`\x1b[32m✓\x1b[0m Comment on ${label}`);
  console.log(`  \x1b[34m💬\x1b[0m \x1b[36m${oracle}\x1b[0m: ${message}`);
}

/** maw task show <issue#> — full activity timeline */
export async function cmdTaskShow(args: string[]) {
  const ref = args[0];
  if (!ref) {
    console.error("usage: maw task show <issue#>");
    process.exit(1);
  }

  const { taskId, item } = await resolveTaskId(ref);
  const activities = readTaskLog(taskId);

  if (activities.length === 0) {
    console.log(`No activity log for ${ref}`);
    return;
  }

  const title = item ? `#${item.content.number} ${item.title}` : taskId;
  console.log(`\n\x1b[36m${title}\x1b[0m`);
  if (item) {
    console.log(`  Status: ${item.status || "-"} | Oracle: ${item.oracle || "-"} | Priority: ${item.priority || "-"}`);
    if (item.content.url) console.log(`  ${item.content.url}`);
  }
  console.log();

  // Group by date
  let lastDate = "";
  for (const a of activities) {
    const date = formatDate(a.ts);
    if (date !== lastDate) {
      console.log(`  \x1b[90m── ${date} ──\x1b[0m`);
      lastDate = date;
    }
    const icon = TYPE_ICONS[a.type] || "·";
    const time = formatTime(a.ts);
    const oracle = a.oracle ? `\x1b[36m${a.oracle}\x1b[0m` : "";
    let extra = "";
    if (a.type === "commit" && a.meta?.commitHash) {
      extra = ` \x1b[33m${a.meta.commitHash}\x1b[0m`;
    }
    if (a.type === "blocker") {
      extra = a.meta?.resolved ? " \x1b[32m(resolved)\x1b[0m" : " \x1b[31m(open)\x1b[0m";
    }
    console.log(`  ${time}  ${icon} ${oracle} ${a.content}${extra}`);
  }

  // Contributors
  const contributors = [...new Set(activities.map((a) => a.oracle).filter(Boolean))];
  console.log(`\n  Contributors: ${contributors.join(", ")}`);
  console.log();
}

/** maw task own <issue#> <oracle> — set exclusive owner + notify previous */
export async function cmdTaskOwn(args: string[]) {
  const ref = args[0];
  const newOracle = args[1];
  if (!ref || !newOracle) {
    console.error('usage: maw task own <issue#> <oracle>');
    process.exit(1);
  }

  const { taskId, item } = await resolveTaskId(ref);
  if (!item) {
    console.error(`\x1b[31m✗\x1b[0m Task ${ref} not found on board`);
    process.exit(1);
  }

  const prevOracle = item.oracle || "";
  const label = `#${item.content.number} ${item.title}`;

  // Set oracle field on GitHub Projects board
  try {
    await setFieldByName(item.id, "Oracle", newOracle);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m Failed to set Oracle: ${e.message}`);
    process.exit(1);
  }

  // Log the ownership change
  appendActivity({
    taskId,
    type: "status_change",
    oracle: process.env.MAW_ORACLE || "cli",
    content: `Ownership: ${prevOracle || "(none)"} → ${newOracle}`,
    meta: { oldStatus: prevOracle, newStatus: newOracle },
  });

  console.log(`\x1b[32m✓\x1b[0m ${label} → \x1b[36m${newOracle}\x1b[0m (exclusive owner)`);

  // If previous owner exists and is different, send STOP notification
  if (prevOracle && prevOracle.toLowerCase() !== newOracle.toLowerCase()) {
    const stopMsg = `STOP: ${label} reassigned to ${newOracle}. You are OFF this task.`;
    console.log(`  \x1b[33m→ notifying ${prevOracle}: ${stopMsg}\x1b[0m`);
    try {
      const { execSync } = await import("child_process");
      const prevLower = prevOracle.toLowerCase().replace(/-oracle$/, "");
      execSync(
        `maw hey ${prevLower}-oracle '${stopMsg.replace(/'/g, "'\\''")}'`,
        { timeout: 10000, stdio: "ignore" }
      );
    } catch {
      console.log(`  \x1b[33m⚠ Could not notify ${prevOracle} (maw hey failed)\x1b[0m`);
    }
  }
}
