import { listSessions, findWindow, capture, sendKeys, getPaneCommand, getPaneCommands, getPaneInfos } from "../ssh";
import { isAgentPane } from "../lib/pane";
import { runHook } from "../hooks";
import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { resolveTarget } from "../routing";
import { loadConfig } from "../config";
import { execSync } from "child_process";

/** Infer caller name: explicit override → message [node:sender] → env var → tmux → "cli" */
function inferCaller(message?: string): string {
  if (process.env.MAW_SENDER) return process.env.MAW_SENDER;
  if (message) {
    const m = message.match(/\[[\w-]+:([\w-]+)\]/);
    if (m) return m[1];
  }
  try {
    // Own pane's window name is ground truth — it beats CLAUDE_AGENT_NAME, which
    // panes inherit from tmux global env and can be stale for every oracle
    // (Dreams 2026-07-06: a global CLAUDE_AGENT_NAME=Nobi-Oracle tagged ALL
    // senders as nobi). Without -t, display-message reports the attached
    // client's current window, not the caller's.
    const pane = process.env.TMUX_PANE;
    if (pane) {
      const win = execSync(`tmux display-message -p -t '${pane}' '#W'`, { encoding: "utf-8" }).trim();
      if (win) return win.replace(/^\d+-/, "");
    }
  } catch {}
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  try {
    const win = execSync("tmux display-message -p '#W'", { encoding: "utf-8" }).trim();
    if (win) return win.replace(/^\d+-/, "");
  } catch {}
  return "cli";
}

export async function cmdList() {
  const sessions = await listSessions();

  // Batch-check process + cwd for each pane
  const targets: string[] = [];
  for (const s of sessions) {
    for (const w of s.windows) targets.push(`${s.name}:${w.index}`);
  }
  const infos = await getPaneInfos(targets);

  for (const s of sessions) {
    console.log(`\x1b[36m${s.name}\x1b[0m`);
    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      const info = infos[target] || { command: "", cwd: "" };
      const isAgent = isAgentPane(info.command || "");
      const cwdBroken = info.cwd.includes("(deleted)") || info.cwd.includes("(dead)");

      let dot: string;
      let suffix = "";
      if (cwdBroken) {
        dot = "\x1b[31m●\x1b[0m"; // red — working dir deleted
        suffix = "  \x1b[31m(path deleted)\x1b[0m";
      } else if (w.active && isAgent) {
        dot = "\x1b[32m●\x1b[0m"; // green — active + agent running
      } else if (isAgent) {
        dot = "\x1b[34m●\x1b[0m"; // blue — agent running
      } else {
        dot = "\x1b[31m●\x1b[0m"; // red — dead (shell only)
        suffix = `  \x1b[90m(${info.command || "?"})\x1b[0m`;
      }
      console.log(`  ${dot} ${w.index}: ${w.name}${suffix}`);
    }
  }
}

export async function cmdPeek(query?: string, args: string[] = []) {
  // Parse --history N flag
  const histIdx = args.indexOf("--history");
  const historyCount = histIdx >= 0 ? +(args[histIdx + 1] || "20") : 0;

  if (historyCount > 0 && query) {
    const { readTranscriptPage, formatTranscript } = await import("../transcript");
    const beforeIdx = args.indexOf("--before");
    const before = beforeIdx >= 0 ? +(args[beforeIdx + 1] || "0") : undefined;
    const page = readTranscriptPage(query, historyCount, before);
    if (page.messages.length === 0) {
      console.error(`No transcript found for: ${query}`);
      process.exit(1);
    }
    const label = before !== undefined ? `before #${before}` : "latest";
    console.log(`\x1b[36m--- ${query} transcript (${page.messages.length}/${page.total}, ${label}${page.hasMore ? ", more ↑" : ""}) ---\x1b[0m`);
    console.log(formatTranscript(page.messages));
    return;
  }

  const sessions = await listSessions();
  if (!query) {
    // Peek all — one line per agent
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        try {
          const content = await capture(target, 3);
          const lastLine = content.split("\n").filter(l => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
          console.log(`${dot} \x1b[36m${w.name.padEnd(22)}\x1b[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1b[36m${w.name.padEnd(22)}\x1b[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const target = findWindow(sessions, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  const content = await capture(target);
  console.log(`\x1b[36m--- ${target} ---\x1b[0m`);
  console.log(content);
}

export async function cmdSend(query: string, message: string, force = false, fromOverride?: string) {
  // Sender tag: prepend [from:oracle] for UI attribution (#98)
  const caller = inferCaller().replace(/-oracle$/i, "").toLowerCase();
  if (caller && caller !== "cli" && !message.startsWith("[from:")) {
    message = `[from:${caller}] ${message}`;
  }

  // Smart project tag: prefer issue ref in message over stale focus (#52)
  try {
    const { getOracleProject, clearOracleProject } = await import("../oracle-projects");
    const { getProjectForRepo } = await import("../projects");

    // Check if message already has a [project] tag (after optional [from:])
    const msgBody = message.replace(/^\[from:[\w-]+\]\s*/, "");
    if (!msgBody.startsWith("[")) {
      const issueRef = message.match(/([A-Za-z0-9_.-]+)#(\d+)/);
      let tagProject: string | null = null;

      if (issueRef) {
        const repoName = issueRef[1];
        const proj = getProjectForRepo(`YourOrg/${repoName}`);
        if (proj) tagProject = proj.id;
      }

      if (!tagProject) {
        const entry = getOracleProject(caller);
        if (entry) {
          const age = Date.now() - new Date(entry.updatedAt).getTime();
          if (age < 30 * 60 * 1000) {
            tagProject = entry.projectId;
          }
        }
      }

      if (tagProject) {
        // Insert project tag after [from:] if present
        if (message.match(/^\[from:[\w-]+\]\s*/)) {
          message = message.replace(/^(\[from:[\w-]+\]\s*)/, `$1[${tagProject}] `);
        } else {
          message = `[${tagProject}] ${message}`;
        }
      }
    }

    // Auto-clear focus when sender says "done" / "เสร็จ" / "idle"
    const entry = getOracleProject(caller);
    if (entry && /\b(done|เสร็จ|idle|awaiting|monitoring)\b/i.test(message)) {
      clearOracleProject(caller);
    }

    // Also detect "done" in cross-notify/cc messages and clear the originating oracle
    const ccMatch = message.match(/cc:\s*(\w+).*\b(done|เสร็จ|idle|awaiting next task|monitoring)\b/i);
    if (ccMatch) {
      const ccOracle = ccMatch[1];
      if (ccOracle.toLowerCase() !== caller) {
        try { clearOracleProject(ccOracle); } catch {}
      }
    }
  } catch {}

  const config = loadConfig();
  const sessions = await listSessions();
  const resolved = resolveTarget(query, config, sessions);

  // Cross-node: route via local HTTP API (which handles federation + HMAC)
  if (resolved?.type === "peer") {
    const server = process.env.MAW_SERVER || "http://localhost:3456";
    // Use node:agent format so /api/send routes to the correct peer
    const crossTarget = `${resolved.node}:${resolved.target}`;
    try {
      const res = await fetch(`${server}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: crossTarget, text: message, from: fromOverride || inferCaller(message) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${res.status}`);
      }
      console.log(`\x1b[32msent\x1b[0m → ${crossTarget}: ${message}`);
      return;
    } catch (e: any) {
      throw new Error(`server unreachable: ${e.message}`);
    }
  }

  // Error from resolver
  if (resolved?.type === "error") {
    // Federation fallback: the compiled CLI can't always read maw.config.json (import.meta.dir),
    // but the local server holds the full peer/agent map. Let it resolve federation before failing.
    if (resolved.reason === "not_found" || resolved.reason === "unknown_node" || resolved.reason === "no_peer_url") {
      const server = process.env.MAW_SERVER || "http://localhost:3456";
      try {
        const res = await fetch(`${server}/api/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: query, text: message, from: fromOverride || inferCaller(message) }),
        });
        const body: any = await res.json().catch(() => ({}));
        if (res.ok && (body.forwarded || body.ok)) {
          console.log(`\x1b[32msent\x1b[0m → ${query}${body.forwarded ? " (federated)" : ""}: ${message}`);
          return;
        }
      } catch {}
    }
    throw new Error(`${resolved.detail}${resolved.hint ? ` (hint: ${resolved.hint})` : ""}`);
  }

  // Local or self-node
  const target = resolved?.type === "local" || resolved?.type === "self-node" ? resolved.target : findWindow(sessions, query);
  if (!target) throw new Error(`window not found: ${query}`);

  // Detect active Claude session (#17)
  if (!force) {
    const cmd = await getPaneCommand(target);
    if (!isAgentPane(cmd)) {
      throw new Error(`no active agent in ${target} (idle shell: ${cmd})`);
    }
  }

  // Auto-switch receiver's project focus from [project] prefix
  try {
    const projMatch = message.match(/^\[([a-z0-9_-]+)\]\s/i);
    if (projMatch) {
      const { setOracleProject } = await import("../oracle-projects");
      const receiver = query.replace(/-oracle$/, "").replace(/:\d+$/, "").replace(/^\d+-/, "").toLowerCase();
      try { setOracleProject(receiver, projMatch[1], "auto"); } catch {}
    }
  } catch {}

  await sendKeys(target, message);

  // Delivery verification: warn-only, NO retry (T024: retry caused double-delivery on busy panes)
  try {
    await new Promise(r => setTimeout(r, 500));
    const snippet = message.replace(/\n/g, " ").slice(0, 40);
    const pane = await capture(target, 10);
    if (!pane.includes(snippet.slice(0, 20))) {
      console.error(`\x1b[33m⚠\x1b[0m delivery unverified — message may not have landed in ${target}`);
    }
  } catch { /* verification is best-effort */ }

  await runHook("after_send", { to: query, message });

  // Built-in log — every maw hey is recorded (for 'AI คุยกัน' blog)
  const logDir = join(homedir(), ".oracle");
  const logFile = join(logDir, "maw-log.jsonl");
  const host = (await import("os")).hostname();
  const from = fromOverride || inferCaller(message);
  const sid = process.env.CLAUDE_SESSION_ID || null;
  const line = JSON.stringify({ ts: new Date().toISOString(), from, to: query, target, msg: message, host, sid }) + "\n";
  try { await mkdir(logDir, { recursive: true }); await appendFile(logFile, line); } catch {}

  // Write to feed.log so dashboard inbox shows agent-to-agent messages
  try {
    const feedLog = join(homedir(), ".oracle", "feed.log");
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const flat = message.replace(/\n/g, " \u239C ");
    const feedLine = `${ts} | ${from} | ${host} | Notification | ${from} | maw-hey \u00bb [handoff] ${JSON.stringify({ from, to: query, message: flat })}\n`;
    await appendFile(feedLog, feedLine);
  } catch {}

  // Signal inbox — write to target's inbox so parent hook can read (#81)
  const inboxDir = join(homedir(), ".oracle", "inbox");
  const inboxTarget = query.replace(/[^a-zA-Z0-9_-]/g, "");
  if (inboxTarget) {
    const signal = JSON.stringify({ ts: new Date().toISOString(), from, type: "msg", msg: message, thread: null }) + "\n";
    try { await mkdir(inboxDir, { recursive: true }); await appendFile(join(inboxDir, `${inboxTarget}.jsonl`), signal); } catch {}
  }

  console.log(`\x1b[32msent\x1b[0m → ${target}: ${message}`);
}
