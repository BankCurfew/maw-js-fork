import { detectSession } from "./commands/wake";
import { getPaneCommand, sendKeys, ssh, listSessions } from "./ssh";
import { cmdWake } from "./commands/wake";
import { loadConfig } from "./config";
import {
  writeFeedNotification,
  checkOracleResult,
  getRecentCommits,
  setItemStatus,
  closeIssue,
  commentResult,
  assignIssue,
  dispatchToOracle,
  ORACLE_MAP,
  RESULT_CHAINS,
} from "./autopilot";
import { fetchBoardData } from "./board";
import type { MawEngine } from "./engine";

export interface TrackedTask {
  oracle: string;
  target: string;
  boardItemId: string;
  issueUrl: string;
  issueNum: number;
  task: string;
  priority: string;
  dispatchedAt: number;
  lastActivityAt: number;
  lastNudgedAt: number;
  state: "working" | "stuck" | "missing" | "done";
  retries: number;
}

export interface SupervisorReport {
  type: "completion" | "stuck" | "missing" | "restart";
  oracle: string;
  task: string;
  issueUrl: string;
  commitUrl: string;
  prUrl: string;
  summary: string;
  files: string[];
  chainedTo: string;
}

const TICK_INTERVAL = 30_000; // 30s
const STUCK_THRESHOLD = 5 * 60_000; // 5min no activity → stuck
const STUCK_ESCALATE = 15 * 60_000; // 15min stuck → escalate
const STALL_HIGH_THRESHOLD = 2 * 60 * 60_000; // 2hr silence on HIGH → auto-nudge
const STALL_NUDGE_COOLDOWN = 30 * 60_000; // Don't nudge more than once per 30min
const MAX_RETRIES = 2;

// Bob is the manager — he should never be supervised by his own tool.
// Supervising Bob creates a restart loop: maw restarts → supervisor re-discovers Bob →
// detects "missing" or "stuck" → cmdWake("bob") → Bob restarts → repeat.
const EXCLUDED_ORACLES = ["bob"];

export class BobSupervisor {
  private tracked = new Map<string, TrackedTask>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private engine: MawEngine | null = null;

  attach(engine: MawEngine) {
    this.engine = engine;
  }

  track(oracle: string, target: string, task: string, issueUrl: string, issueNum: number, boardItemId: string, priority = "") {
    const now = Date.now();
    this.tracked.set(oracle.toLowerCase(), {
      oracle: oracle.toLowerCase(),
      target,
      boardItemId,
      issueUrl,
      issueNum,
      task,
      priority,
      dispatchedAt: now,
      lastActivityAt: now,
      lastNudgedAt: 0,
      state: "working",
      retries: 0,
    });
    // Auto-start when first task is tracked
    this.start();
  }

  untrack(oracle: string) {
    this.tracked.delete(oracle.toLowerCase());
  }

  getTracked(): TrackedTask[] {
    return [...this.tracked.values()];
  }

  start() {
    if (this.interval) return;
    // Discover all running agents + unfinished board items on first start
    this.discoverFromBoard().catch(() => {});
    this.discoverAll().catch(() => {});
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL);
    console.log("  \x1b[36m●\x1b[0m Supervisor started (30s tick)");
  }

  /** Pick up "In Progress" and "Todo" board items that aren't tracked yet */
  async discoverFromBoard() {
    try {
      const items = await fetchBoardData();
      const oracleKeys = Object.keys(ORACLE_MAP);

      for (const item of items) {
        const status = (item.status || "").toLowerCase();
        if (status !== "in progress" && status !== "todo") continue;

        const oracle = (item.oracle || "").toLowerCase();
        if (!oracle || !oracleKeys.includes(oracle)) continue;
        if (EXCLUDED_ORACLES.includes(oracle)) continue; // Bob manages himself
        if (this.tracked.has(oracle)) continue; // already tracked

        // Try to find its tmux target
        let target = "";
        try {
          const session = await detectSession(oracle);
          if (session) {
            const sessions = await listSessions();
            const s = sessions.find(s => s.name === session);
            const w = s?.windows.find(w => w.name === `${oracle}-oracle`);
            if (s && w) target = `${s.name}:${w.index}`;
          }
        } catch {}

        this.tracked.set(oracle, {
          oracle,
          target,
          boardItemId: item.id,
          issueUrl: item.content?.url || "",
          issueNum: item.content?.number || 0,
          task: item.title,
          priority: item.priority || "",
          dispatchedAt: Date.now(),
          lastActivityAt: Date.now(),
          lastNudgedAt: 0,
          state: status === "in progress" ? "working" : "missing",
          retries: 0,
        });
        console.log(`  \x1b[36m●\x1b[0m Board pickup: ${ORACLE_MAP[oracle]} — ${item.title} [${item.status}]`);
      }
    } catch (e: any) {
      console.log(`  \x1b[33m●\x1b[0m Board discovery failed: ${e.message}`);
    }
  }

  /** Scan all tmux sessions for running oracle agents and auto-track them */
  async discoverAll() {
    try {
      const sessions = await listSessions();
      const oracleKeys = Object.keys(ORACLE_MAP); // bob, dev, qa, etc.

      for (const s of sessions) {
        for (const w of s.windows) {
          // Match oracle windows: "dev-oracle", "qa-oracle", etc.
          const match = w.name.match(/^(\w+)-oracle$/);
          if (!match) continue;
          const oracle = match[1].toLowerCase();
          if (!oracleKeys.includes(oracle)) continue;
          if (EXCLUDED_ORACLES.includes(oracle)) continue; // Bob manages himself
          if (this.tracked.has(oracle)) continue; // already tracked

          const target = `${s.name}:${w.index}`;

          // Check if it's actually running Claude (not just a shell)
          try {
            const cmd = await getPaneCommand(target);
            if (!/claude|node/i.test(cmd)) continue; // idle shell, skip
          } catch { continue; }

          // Auto-track as working (no issue context — discovered mid-flight)
          this.tracked.set(oracle, {
            oracle,
            target,
            boardItemId: "",
            issueUrl: "",
            issueNum: 0,
            task: "(discovered — already running)",
            priority: "",
            dispatchedAt: Date.now(),
            lastActivityAt: Date.now(),
            lastNudgedAt: 0,
            state: "working",
            retries: 0,
          });
          console.log(`  \x1b[36m●\x1b[0m Discovered running agent: ${ORACLE_MAP[oracle]} (${target})`);
        }
      }
    } catch (e: any) {
      console.log(`  \x1b[33m●\x1b[0m Discovery scan failed: ${e.message}`);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick() {
    // Discover new agents + board items each tick
    await this.discoverFromBoard().catch(() => {});
    await this.discoverAll().catch(() => {});

    for (const [oracle, tracked] of this.tracked) {
      try {
        await this.inspect(tracked);
      } catch (e: any) {
        console.log(`  \x1b[31m●\x1b[0m supervisor error for ${oracle}: ${e.message}`);
      }
    }
    // Broadcast current state to dashboard
    if (this.engine) {
      this.engine.broadcast(JSON.stringify({
        type: "supervisor-state",
        tracked: this.getTracked(),
      }));
    }
  }

  private async inspect(tracked: TrackedTask) {
    const { oracle } = tracked;

    // 1. Is the session present?
    const session = await detectSession(oracle);
    if (!session) {
      await this.handleMissing(tracked);
      return;
    }

    // 2. Check pane command — bash/zsh means agent finished
    try {
      const cmd = await getPaneCommand(tracked.target);
      if (/^(bash|zsh)$/.test(cmd)) {
        await this.handleCompletion(tracked);
        return;
      }
    } catch {
      // Can't check pane — try result check
      const result = await checkOracleResult(oracle);
      if (result?.done) {
        await this.handleCompletion(tracked);
        return;
      }
    }

    // 3. Check for activity
    const now = Date.now();
    const elapsed = now - tracked.lastActivityAt;

    // Use checkOracleResult to see if still running
    const result = await checkOracleResult(oracle);
    if (result && !result.done) {
      // Still running — check if stuck
      if (elapsed > STUCK_THRESHOLD) {
        await this.handleStuck(tracked);
      } else {
        // Update activity
        tracked.state = "working";
        tracked.lastActivityAt = now;
      }

      // Stall detection: HIGH priority tasks silent >2hr → auto-nudge
      const isHigh = /high|p0|p1|urgent|critical/i.test(tracked.priority || tracked.task);
      if (isHigh && elapsed > STALL_HIGH_THRESHOLD && (now - tracked.lastNudgedAt) > STALL_NUDGE_COOLDOWN) {
        tracked.lastNudgedAt = now;
        const oracleName = ORACLE_MAP[oracle] || oracle;
        try {
          await sendKeys(tracked.target, `[supervisor] HIGH priority task "${tracked.task}" has been silent for ${Math.round(elapsed / 3600000)}h. Please report status or escalate blockers.\r`);
          writeFeedNotification(oracleName, `[stall-nudge] HIGH task "${tracked.task}" — ${Math.round(elapsed / 3600000)}h silence, auto-nudged`);
        } catch {}
      }
    } else if (result?.done) {
      await this.handleCompletion(tracked);
    }
  }

  private async handleCompletion(tracked: TrackedTask) {
    const { oracle, task, issueUrl, issueNum, boardItemId } = tracked;
    const oracleName = ORACLE_MAP[oracle] || oracle;

    // 1. Gather results
    const commits = await getRecentCommits(oracle);
    const lastCommit = commits[0] || "";
    const commitHash = lastCommit.split(" ")[0] || "";
    const commitMsg = lastCommit.slice(commitHash.length + 1).trim();

    // Check for PR
    let prUrl = "";
    try {
      const ghqRoot = loadConfig().ghqRoot;
      const prList = await ssh(`cd '${ghqRoot}/YourOrg/${oracleName}' && gh pr list --state open --limit 1 --json url -q '.[0].url' 2>/dev/null`);
      prUrl = prList.trim();
    } catch {}

    // Build summary
    const summary = commitMsg || `Task completed by ${oracleName}`;
    const files = commits.slice(0, 5);

    // 2. Build rich report
    const chainTarget = RESULT_CHAINS[oracle]?.[0] || "";
    const report: SupervisorReport = {
      type: "completion",
      oracle: oracleName,
      task,
      issueUrl,
      commitUrl: commitHash ? `https://github.com/YourOrg/${oracleName}/commit/${commitHash}` : "",
      prUrl,
      summary,
      files,
      chainedTo: chainTarget ? (ORACLE_MAP[chainTarget] || chainTarget) : "",
    };

    // 3. Write to feed.log
    writeFeedNotification(oracleName, `[supervisor-report] ${JSON.stringify(report)}`);

    // 4. Update board → Done, close issue
    if (boardItemId) {
      try { await setItemStatus("YourOrg", 1, boardItemId, "Done"); } catch {}
    }
    if (issueNum) {
      const repo = `YourOrg/${oracleName}`;
      const commitSummary = commits.slice(0, 3).map(c => `- \`${c}\``).join("\n");
      const body = `## Task completed by ${oracleName}\n\n${commitSummary}\n${prUrl ? `\nPR: ${prUrl}\n` : ""}\nAutomatically closed by BoB Supervisor.`;
      try {
        await assignIssue(repo, issueNum, "YourOrg");
        await commentResult(repo, issueNum, body);
        await closeIssue(repo, issueNum);
      } catch {}
    }

    // 5. Chain to next oracle if configured
    if (chainTarget) {
      const chainOracleName = ORACLE_MAP[chainTarget] || chainTarget;
      const chainPrompt = [
        `Previous task completed by ${oracleName}: ${task}`,
        summary,
        commits.length > 0 ? `Recent commits:\n${commits.slice(0, 3).join("\n")}` : "",
        prUrl ? `PR: ${prUrl}` : "",
        issueUrl ? `Original issue: ${issueUrl}` : "",
        "",
        `Please review and continue from ${oracleName}'s work.`,
      ].filter(Boolean).join("\n");

      try {
        await dispatchToOracle(chainTarget, chainPrompt);
        console.log(`  \x1b[36m→\x1b[0m Chained ${oracleName} → ${chainOracleName}`);
      } catch (e: any) {
        console.log(`  \x1b[33m●\x1b[0m Chain to ${chainOracleName} failed: ${e.message}`);
      }
    }

    // 6. Broadcast to dashboard
    if (this.engine) {
      this.engine.broadcast(JSON.stringify({
        type: "supervisor-report",
        report,
      }));
    }

    // LAW #7: Ensure Bob knows about completion (auto-send if agent didn't)
    try {
      const bobSession = await detectSession("bob");
      if (bobSession) {
        const sessions = await listSessions();
        const s = sessions.find(s => s.name === bobSession);
        const w = s?.windows.find(w => /bob/i.test(w.name));
        if (s && w) {
          const bobTarget = `${s.name}:${w.index}`;
          const cmd = await getPaneCommand(bobTarget).catch(() => "");
          if (/claude|node/i.test(cmd)) {
            const briefReport = `[auto-report] ${oracleName} completed: ${summary}${prUrl ? ` PR: ${prUrl}` : ""}${commits[0] ? ` commit: ${commits[0]}` : ""}`;
            await sendKeys(bobTarget, briefReport + "\r").catch(() => {});
          }
        }
      }
    } catch {}

    tracked.state = "done";
    console.log(`  \x1b[32m✓\x1b[0m ${oracleName} completed: ${summary}`);
    this.untrack(oracle);
  }

  private async handleStuck(tracked: TrackedTask) {
    const { oracle, target } = tracked;
    const oracleName = ORACLE_MAP[oracle] || oracle;
    const now = Date.now();
    const stuckDuration = now - tracked.lastActivityAt;

    tracked.state = "stuck";

    if (stuckDuration < STUCK_ESCALATE) {
      // Nudge
      try {
        await sendKeys(target, "Are you stuck? Try a different approach.\r");
        console.log(`  \x1b[33m●\x1b[0m Nudged ${oracleName} (stuck ${Math.round(stuckDuration / 60_000)}min)`);
      } catch {}
    } else {
      // Escalate — write attention ask to inbox
      writeFeedNotification(oracleName, `[attention] ${oracleName} appears stuck on: ${tracked.task} (${Math.round(stuckDuration / 60_000)}min)`);
      console.log(`  \x1b[31m●\x1b[0m Escalated ${oracleName} — stuck ${Math.round(stuckDuration / 60_000)}min`);
    }
  }

  private async handleMissing(tracked: TrackedTask) {
    const { oracle, task } = tracked;
    const oracleName = ORACLE_MAP[oracle] || oracle;

    if (tracked.retries >= MAX_RETRIES) {
      writeFeedNotification(oracleName, `[attention] ${oracleName} session lost after ${MAX_RETRIES} restarts. Task: ${task}`);
      console.log(`  \x1b[31m✗\x1b[0m ${oracleName} lost — max retries exceeded`);
      tracked.state = "missing";
      return;
    }

    tracked.retries++;
    tracked.state = "missing";

    // Re-wake with original task
    try {
      const promptLines = [
        `You have been re-assigned a task (session was lost).`,
        tracked.issueUrl ? `Issue: ${tracked.issueUrl} (#${tracked.issueNum})` : "",
        ``,
        `## Task`,
        task,
        ``,
        `## Protocol`,
        `1. Check the issue for any previous progress`,
        `2. Continue where you left off`,
        `3. Commit and push when done`,
        tracked.issueNum ? `4. Report back on issue #${tracked.issueNum}` : "",
        `5. **⚠️ MANDATORY: /talk-to bob "done: [สรุป] — commits: [hash]"**`,
        ``,
        `> LAW #7: ห้ามจบ session โดยไม่ /talk-to bob เด็ดขาด`,
      ].filter(Boolean).join("\n");

      const target = await cmdWake(oracle, { prompt: promptLines });
      tracked.target = target;
      tracked.lastActivityAt = Date.now();

      writeFeedNotification(oracleName, `Session restarted (attempt ${tracked.retries}/${MAX_RETRIES}): ${task}`);
      console.log(`  \x1b[33m●\x1b[0m Restarted ${oracleName} (attempt ${tracked.retries})`);
    } catch (e: any) {
      console.log(`  \x1b[31m✗\x1b[0m Failed to restart ${oracleName}: ${e.message}`);
    }
  }

  async auditStaleCompleted(): Promise<{ flagged: string[]; checked: number }> {
    const flagged: string[] = [];
    const STALE_DAYS = 7;
    try {
      const boardJson = await ssh(`gh project item-list 1 --owner YourOrg --format json 2>/dev/null`);
      const items = JSON.parse(boardJson).items || [];
      const now = Date.now();

      for (const item of items) {
        if (item.status !== "In Progress") continue;
        const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
        const ageDays = (now - updatedAt) / 86400000;
        if (ageDays < STALE_DAYS) continue;

        const title = item.title || "(untitled)";
        const assignee = item.assignees?.[0]?.login || "unassigned";
        const issueUrl = item.content?.url || "";

        let hasCommits = false;
        if (issueUrl) {
          const repoMatch = issueUrl.match(/github\.com\/([^/]+\/[^/]+)\//);
          if (repoMatch) {
            try {
              const log = await ssh(`git -C "$(ghq list --full-path | grep -i '${repoMatch[1].split("/")[1]}$' | head -1)" log --oneline --since='${STALE_DAYS} days ago' 2>/dev/null | head -1`);
              hasCommits = !!log?.trim();
            } catch {}
          }
        }

        if (hasCommits) {
          const msg = `[attention] STALE IN-PROGRESS: "${title}" — ${Math.floor(ageDays)}d old, has recent commits but no maw task done. Assignee: ${assignee}`;
          writeFeedNotification("BobSupervisor", msg);
          flagged.push(`${title} (${Math.floor(ageDays)}d, assignee: ${assignee})`);
        }
      }
    } catch (e: any) {
      console.error(`[supervisor] auditStaleCompleted error: ${e.message}`);
    }
    return { flagged, checked: flagged.length };
  }
}

/** Verify that a dispatch actually started the agent */
export async function verifyDispatch(oracle: string, target: string): Promise<boolean> {
  const delays = [8000, 15000, 25000];
  for (const delay of delays) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const cmd = await getPaneCommand(target);
      if (/claude|node/i.test(cmd)) return true;
    } catch {}
  }
  const oracleName = ORACLE_MAP[oracle.toLowerCase()] || oracle;
  writeFeedNotification(oracleName, `[attention] Agent may not have started properly for: ${target}`);
  return false;
}
