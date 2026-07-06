import { setItemStatus, closeIssue, commentResult } from "../autopilot";

interface BoardItem {
  id: string;
  title: string;
  status: string;
  oracle: string;
  content?: { number?: number; repository?: string };
}

interface EnrichedTask {
  taskId: string;
  boardItem: BoardItem;
}

interface BoardProject {
  name: string;
  enrichedTasks: EnrichedTask[];
}

/**
 * maw board done #<issue> ["message"]
 *
 * Marks a board item as Done + closes the GitHub issue.
 * Looks up by issue number across all projects.
 */
export async function cmdBoardDone(args: string[]) {
  const issueArg = args[0]?.replace("#", "");
  const issueNum = parseInt(issueArg);
  const message = args.slice(1).join(" ") || undefined;

  if (!issueNum) {
    console.error("usage: maw board done #<issue> [\"message\"]");
    console.error("       e.g. maw board done #5 \"เสร็จแล้ว — push commit abc\"");
    process.exit(1);
  }

  console.log(`\x1b[36m⚡\x1b[0m Looking up issue #${issueNum} on board...`);

  // Fetch board data
  let boardData: { projects: BoardProject[] };
  try {
    const res = await fetch("http://localhost:3456/api/project-board");
    if (!res.ok) throw new Error(`Board API returned ${res.status}`);
    boardData = await res.json() as { projects: BoardProject[] };
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Cannot reach board API: ${err}`);
    process.exit(1);
  }

  // Find the board item by issue number
  let found: { item: BoardItem; repo: string } | null = null;
  for (const proj of boardData.projects || []) {
    for (const task of proj.enrichedTasks || []) {
      const b = task.boardItem;
      if (b?.content?.number === issueNum) {
        found = { item: b, repo: b.content.repository || "" };
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    console.error(`\x1b[31m✗\x1b[0m Issue #${issueNum} not found on board`);
    process.exit(1);
  }

  const { item, repo } = found;
  console.log(`\x1b[90m  Found: "${item.title}" (${item.status}) in ${repo}\x1b[0m`);

  // Skip if already done
  if (item.status === "Done") {
    console.log(`\x1b[33m⚠\x1b[0m Issue #${issueNum} is already Done`);
    return;
  }

  // 1. Update board status → Done
  try {
    await setItemStatus("YourOrg", 1, item.id, "Done");
    console.log(`\x1b[32m✓\x1b[0m Board status → Done`);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Failed to update board: ${err}`);
  }

  // 2. Comment if message provided
  if (message && repo) {
    try {
      await commentResult(repo, issueNum, message);
      console.log(`\x1b[32m✓\x1b[0m Commented on issue #${issueNum}`);
    } catch (err) {
      console.error(`\x1b[31m✗\x1b[0m Failed to comment: ${err}`);
    }
  }

  // 3. Close GitHub issue
  if (repo) {
    try {
      await closeIssue(repo, issueNum);
      console.log(`\x1b[32m✓\x1b[0m Closed issue #${issueNum} in ${repo}`);
    } catch (err) {
      console.error(`\x1b[31m✗\x1b[0m Failed to close issue: ${err}`);
    }
  }

  console.log(`\n\x1b[32m✅ Done!\x1b[0m ${item.title}`);
}
