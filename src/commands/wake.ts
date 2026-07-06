import { ssh } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig, buildCommand, getEnvVars } from "../config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Fetch a GitHub issue and build a prompt for claude -p */
export async function fetchIssuePrompt(issueNum: number, repo?: string): Promise<string> {
  // Detect repo from git remote if not specified
  let repoSlug = repo;
  if (!repoSlug) {
    try {
      const remote = await ssh("git remote get-url origin 2>/dev/null");
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m) repoSlug = m[1];
    } catch {}
  }
  if (!repoSlug) throw new Error("Could not detect repo — pass --repo org/name");

  const json = await ssh(`gh issue view ${issueNum} --repo '${repoSlug}' --json title,body,labels`);
  const issue = JSON.parse(json);
  const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
  const parts = [
    `Work on issue #${issueNum}: ${issue.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    issue.body || "(no description)",
  ];
  return parts.filter(Boolean).join("\n");
}

export async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // 1. Try standard pattern: <oracle>-oracle (also match partial like "doc" → "DocCon-Oracle")
  let ghqOut = "";
  try { ghqOut = await ssh(`ghq list --full-path 2>/dev/null | grep -i '/${oracle}[^/]*-oracle$' | head -1`); } catch {}
  if (!ghqOut?.trim()) {
    // Fallback: direct ls in known repo dirs
    try { ghqOut = await ssh(`ls -d $HOME/repos/github.com/YourOrg/${oracle}*-Oracle $HOME/repos/github.com/YourOrg/${oracle}*-oracle 2>/dev/null | head -1`); } catch {}
  }
  if (ghqOut?.trim()) {
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  }

  // 2. Fallback: check fleet configs for repo mapping
  const fleetDir = join(import.meta.dir, "../../fleet");
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const oracleLower = oracle.toLowerCase();
      const win = (config.windows || []).find((w: any) => {
        const wl = w.name.toLowerCase();
        return wl === `${oracleLower}-oracle` || wl.startsWith(`${oracleLower}`) && wl.endsWith("-oracle");
      });
      if (win?.repo) {
        // Try ghq first, fall back to well-known repo paths
        let repoPath = "";
        try {
          const fullPath = await ssh(`ghq list --full-path | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
          if (fullPath?.trim()) repoPath = fullPath.trim();
        } catch {}
        if (!repoPath) {
          // Fallback: check common repo locations
          const repoName = win.repo.replace(/^[^/]+\//, "");
          const candidates = [
            `$HOME/repos/github.com/${win.repo}`,
            `$HOME/${repoName}`,
          ];
          for (const c of candidates) {
            try {
              const resolved = await ssh(`eval echo ${c}`);
              const exists = await ssh(`test -d "${resolved}" && echo "${resolved}"`);
              if (exists?.trim()) { repoPath = exists.trim(); break; }
            } catch {}
          }
        }
        if (repoPath) {
          const repoName = repoPath.split("/").pop()!;
          const parentDir = repoPath.replace(/\/[^/]+$/, "");
          return { repoPath, repoName, parentDir };
        }
      }
    }
  } catch { /* fleet dir may not exist */ }

  console.error(`oracle repo not found: ${oracle} (tried ${oracle}-oracle pattern and fleet configs)`);
  process.exit(1);
}

export async function findWorktrees(parentDir: string, repoName: string): Promise<{ path: string; name: string }[]> {
  const lsOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split("\n").filter(Boolean).map(p => {
    const base = p.split("/").pop()!;
    const suffix = base.replace(`${repoName}.wt-`, "");
    return { path: p, name: suffix };
  });
}

// Oracle → tmux session mapping (from config, with hardcoded fallback)
export function getSessionMap(): Record<string, string> {
  return loadConfig().sessions;
}

/** Scan fleet/*.json for a config containing a window matching the oracle name */
export function resolveFleetSession(oracle: string): string | null {
  const fleetDir = join(import.meta.dir, "../../fleet");
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const hasOracleWindow = (config.windows || []).some(
        (w: any) => w.name.toLowerCase() === `${oracle.toLowerCase()}-oracle` || w.name.toLowerCase() === oracle.toLowerCase()
      );
      if (hasOracleWindow) return config.name;
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string): Promise<string | null> {
  const sessions = await tmux.listSessions();

  // 1. Check manual session map
  const mapped = getSessionMap()[oracle];
  if (mapped) {
    const exists = sessions.find(s => s.name === mapped);
    if (exists) return mapped;
  }

  // 2. Pattern match running sessions (e.g., "08-neo" for oracle "neo")
  const patternMatch = sessions.find(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name
    || sessions.find(s => s.name === oracle)?.name;
  if (patternMatch) return patternMatch;

  // 3. Scan fleet configs for oracle → session name mapping
  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession) {
    const exists = sessions.find(s => s.name === fleetSession);
    if (exists) return fleetSession;
  }

  return null;
}

/** Set config env vars on a tmux session (hidden from screen output) */
async function setSessionEnv(session: string, oracle?: string): Promise<void> {
  for (const [key, val] of Object.entries(getEnvVars())) {
    await tmux.setEnvironment(session, key, val);
  }
  // Set MAW_PROJECT from oracle-projects.json if oracle has an active project
  if (oracle) {
    try {
      const { getOracleProject } = await import("../oracle-projects");
      const entry = getOracleProject(oracle);
      if (entry) {
        await tmux.setEnvironment(session, "MAW_PROJECT", entry.projectId);
      }
    } catch {}
  }
}

export async function cmdWake(oracle: string, opts: { task?: string; newWt?: string; prompt?: string; incubate?: string }): Promise<string> {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);

  // Detect or create tmux session (spawn all worktrees if new)
  let session = await detectSession(oracle);
  if (!session) {
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || oracle;
    // Create session with main window (use oracle-oracle name to match fleet configs)
    const mainWindowName = `${oracle}-oracle`;
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await setSessionEnv(session, oracle);
    // Clear stale scrollback before launching Claude (alternate screen never writes to it)
    try { await ssh(`tmux clear-history -t '${session}:${mainWindowName}' 2>/dev/null`); } catch {}
    await new Promise(r => setTimeout(r, 300));
    await tmux.sendText(`${session}:${mainWindowName}`, buildCommand(mainWindowName));
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    // Spawn all existing worktree windows
    const allWt = await findWorktrees(parentDir, repoName);
    for (const wt of allWt) {
      const wtWindowName = `${oracle}-${wt.name}`;
      await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
      try { await ssh(`tmux clear-history -t '${session}:${wtWindowName}' 2>/dev/null`); } catch {}
      await new Promise(r => setTimeout(r, 300));
      await tmux.sendText(`${session}:${wtWindowName}`, buildCommand(wtWindowName));
      console.log(`\x1b[32m+\x1b[0m window: ${wtWindowName}`);
    }
  } else {
    // Ensure env vars are set on existing session (may predate this fix)
    await setSessionEnv(session, oracle);
  }

  let targetPath = repoPath;
  let windowName = `${oracle}-oracle`;

  if (opts.newWt || opts.task) {
    const name = opts.newWt || opts.task!;
    const worktrees = await findWorktrees(parentDir, repoName);

    // Try to find existing worktree matching this name
    const match = worktrees.find(w => w.name.endsWith(`-${name}`) || w.name === name);

    if (match) {
      // Reuse existing worktree
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      // Create new worktree
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;

      // Delete stale branch if it exists but has no worktree (#62)
      try { await ssh(`git -C '${repoPath}' branch -D '${branch}' 2>/dev/null`); } catch { /* branch doesn't exist — fine */ }
      await ssh(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);

      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
    }
  }

  // Check if window already exists (match exact name or fleet pattern oracle-N-name)
  try {
    const windows = await tmux.listWindows(session);
    const windowNames = windows.map(w => w.name);
    // Match: exact (case-insensitive), partial prefix (e.g. "doc" matches "DocCon-Oracle"),
    // or fleet config pattern (e.g. "pulse-1-scheduler")
    const nameSuffix = windowName.replace(`${oracle}-`, "");
    const wLower = windowName.toLowerCase();
    const oLower = oracle.toLowerCase();
    const existingWindow = windowNames.find(w => w.toLowerCase() === wLower)
      || windowNames.find(w => w.toLowerCase().startsWith(oLower) && w.toLowerCase().endsWith("-oracle"))
      || windowNames.find(w => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`, "i").test(w));
    if (existingWindow) {
      const target = `${session}:${existingWindow}`;
      if (opts.prompt) {
        // Window exists — check if Claude is already running
        let isClaudeRunning = false;
        try {
          const paneCmd = await ssh(`tmux display-message -t '${target}' -p '#{pane_current_command}' 2>/dev/null`);
          isClaudeRunning = /claude|node/i.test(paneCmd);
        } catch {}

        if (isClaudeRunning) {
          // Claude already running → send message to existing session (not claude -p)
          console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' has active Claude — sending message`);
          await tmux.selectWindow(target);
          const { sendKeys: sk } = await import("../ssh");
          await sk(target, opts.prompt);
          return target;
        } else {
          // No Claude running → start fresh with claude -p
          console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' exists, starting claude with prompt`);
          await tmux.selectWindow(target);
          try { await ssh(`tmux clear-history -t '${target}' 2>/dev/null`); } catch {}
          const cmd = buildCommand(existingWindow);
          const escaped = opts.prompt.replace(/'/g, "'\\''");
          await tmux.sendText(target, `${cmd} -p '${escaped}'`);
          return target;
        }
      }
      console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' already running in ${session}`);
      await tmux.selectWindow(target);
      return target;
    }
  } catch { /* session might be fresh */ }

  // Create window + start command (or with prompt)
  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  const cmd = buildCommand(windowName);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  return `${session}:${windowName}`;
}
