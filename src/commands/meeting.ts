import { capture, getPaneCommand, sendKeys } from "../ssh";
import { detectSession } from "./wake";
import { cmdWake } from "./wake";
import { tmux } from "../tmux";

// --- Types ---

export interface MeetingOpts {
  oracles?: string[];   // --oracles dev,designer
  dryRun?: boolean;     // --dry-run
  timeout?: number;     // per-agent timeout in seconds (default: 120)
  returnTranscript?: boolean;
}

export interface MeetingTask {
  oracle: string;
  task: string;
  priority: string;
}

export interface MeetingTranscript {
  goal: string;
  ts: string;
  participants: { oracle: string; target: string; status: "ready" | "busy" | "dead" }[];
  discussion: { oracle: string; message: string }[];
  tasks: MeetingTask[];
  dispatched: boolean;
}

// --- Oracle roles ---

const ORACLE_ROLES: Record<string, { role: string; keywords: string[] }> = {
  dev:        { role: "Development",  keywords: ["implement", "api", "backend", "frontend", "deploy", "code", "build", "feature", "page", "app", "server", "fix"] },
  qa:         { role: "QA",           keywords: ["test", "bug", "validation", "quality", "suite"] },
  designer:   { role: "Design",       keywords: ["ui", "ux", "mockup", "visual", "layout", "design", "logo", "brand", "creative", "landing"] },
  researcher: { role: "Research",     keywords: ["analyze", "compare", "benchmark", "research", "explore", "competitor"] },
  writer:     { role: "Content",      keywords: ["docs", "copy", "blog", "readme", "write", "content", "article", "post"] },
  hr:         { role: "People Ops",   keywords: ["onboard", "guide", "process", "hire", "recruit", "interview", "people"] },
};

function selectParticipants(goal: string, explicit?: string[]): string[] {
  if (explicit?.length) {
    return explicit.filter(o => ORACLE_ROLES[o.toLowerCase()]).map(o => o.toLowerCase());
  }
  const lower = goal.toLowerCase();
  const matched = Object.entries(ORACLE_ROLES)
    .filter(([_, info]) => info.keywords.some(kw => lower.includes(kw)))
    .map(([oracle]) => oracle);
  return matched.length > 0 ? matched : ["dev"];
}

// --- Resolve tmux targets ---

interface OracleTarget {
  oracle: string;
  target: string;
  status: "ready" | "busy" | "dead";
}

async function resolveTargets(oracles: string[]): Promise<OracleTarget[]> {
  const results: OracleTarget[] = [];

  await Promise.allSettled(oracles.map(async (oracle) => {
    const session = await detectSession(oracle);
    if (!session) {
      results.push({ oracle, target: "", status: "dead" });
      return;
    }

    let windowName = `${oracle}-oracle`;
    try {
      const windows = await tmux.listWindows(session);
      const match = windows.find(w =>
        w.name.toLowerCase() === windowName.toLowerCase() ||
        w.name.toLowerCase() === `${oracle.charAt(0).toUpperCase() + oracle.slice(1)}-Oracle`.toLowerCase()
      );
      if (match) windowName = match.name;
    } catch {}

    const target = `${session}:${windowName}`;

    try {
      const cmd = await getPaneCommand(target);
      if (/claude|node/i.test(cmd)) {
        results.push({ oracle, target, status: "ready" });
      } else if (/bash|zsh/i.test(cmd)) {
        results.push({ oracle, target, status: "dead" });
      } else {
        results.push({ oracle, target, status: "busy" });
      }
    } catch {
      results.push({ oracle, target, status: "dead" });
    }
  }));

  return results;
}

// --- Unique marker to find our question in the pane ---

function makeMeetingMarker(): string {
  return `MTG-${Date.now().toString(36)}`;
}

// --- Send meeting question and capture ONLY the new response ---

async function askOracle(
  target: OracleTarget,
  goal: string,
  allParticipants: string[],
  timeoutMs: number,
): Promise<string> {
  const { oracle, target: tmuxTarget } = target;
  const role = ORACLE_ROLES[oracle]?.role || oracle;
  const others = allParticipants.filter(o => o !== oracle).join(", ");
  const marker = makeMeetingMarker();

  // Build question with a unique marker so we can find exactly where the response starts
  const question = [
    `[${marker}] Meeting from BoB — Goal: "${goal}".`,
    `Team: ${others ? `you, ${others}` : "you"}.`,
    `You are ${oracle} (${role}).`,
    `Answer briefly (under 150 words): What would YOU do? What do you need from others?`,
  ].join(" ");

  // Send to the running Claude session
  await sendKeys(tmuxTarget, question);

  // Poll until response stabilizes
  await new Promise(r => setTimeout(r, 8_000));

  const start = Date.now();
  let lastCapture = "";
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3_000));

    const currentCapture = await capture(tmuxTarget, 80);

    if (currentCapture === lastCapture) {
      stableCount++;
      if (stableCount >= 2) {
        return extractResponseAfterMarker(currentCapture, marker);
      }
    } else {
      stableCount = 0;
    }

    lastCapture = currentCapture;
  }

  // Timeout — try to extract what we have
  if (lastCapture) {
    return extractResponseAfterMarker(lastCapture, marker);
  }
  return "(timed out)";
}

// --- Extract only content AFTER our marker (the agent's actual response) ---

function extractResponseAfterMarker(raw: string, marker: string): string {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n");

  // Find the line containing our marker
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      markerIdx = i;
      break;
    }
  }

  if (markerIdx === -1) {
    // Marker not found — return last meaningful chunk
    const meaningful = lines.filter(l => l.trim() && !isPromptLine(l) && !isStatusBarLine(l));
    return meaningful.slice(-20).join("\n").trim() || "(no response found)";
  }

  // Skip the question echo — it may wrap across several lines in the terminal.
  // Strategy: skip from marker until we hit a line starting with "●" (Claude response indicator)
  // or a line that looks like an actual answer (starts with "-", numbered list, etc.)
  const questionPatterns = [
    marker, "Meeting from BoB", "Answer briefly", "What would YOU do",
    "What do you need from others", "You are", "Team:", "Goal:",
  ];

  let responseStart = markerIdx;
  // First: skip all lines that are clearly part of the question
  while (responseStart < lines.length) {
    const line = lines[responseStart].trim();
    const isQuestion = questionPatterns.some(p => line.includes(p));
    // Also skip short continuation lines that are part of the wrapped question
    const isWrap = responseStart > markerIdx && responseStart < markerIdx + 6
      && !line.startsWith("●") && !line.startsWith("-") && !line.startsWith("*")
      && !line.match(/^\d+\./) && !line.startsWith("#")
      && !line.toLowerCase().startsWith("my ") && !line.toLowerCase().startsWith("i ");
    if (!isQuestion && !isWrap && responseStart > markerIdx) break;
    responseStart++;
  }

  // Collect response lines — skip prompt lines, status bars
  const responseLines: string[] = [];
  for (let i = responseStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isPromptLine(line)) continue;
    if (isStatusBarLine(line)) continue;
    responseLines.push(line);
  }

  return responseLines.join("\n").trim() || "(empty response)";
}

function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "\u276f" || trimmed === "❯" || /^❯\s*$/.test(trimmed) || /^\$\s*$/.test(trimmed);
}

function isStatusBarLine(line: string): boolean {
  return /bypass permissions/i.test(line)
    || /shift\+tab to cycle/i.test(line)
    || /ctrl\+[a-z] to/i.test(line)
    || /^\s*[▘▝▜▛█▌▐]+/.test(line)  // Claude Code banner
    || /Claude Code v[\d.]+/.test(line);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\u2800-\u28FF]/g, "")
    .trim();
}

// --- Terminal output ---

function printTranscript(transcript: MeetingTranscript) {
  const { goal, ts, participants, discussion, tasks, dispatched } = transcript;

  console.log();
  console.log("\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m");
  console.log(`\x1b[36m\u2551\x1b[0m     BoB's Office \u2014 Meeting                   \x1b[36m\u2551\x1b[0m`);
  console.log(`\x1b[36m\u2551\x1b[0m     ${ts.padEnd(37)}\x1b[36m\u2551\x1b[0m`);
  console.log("\x1b[36m\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\x1b[0m");
  console.log();

  console.log(`  \x1b[1mGoal:\x1b[0m ${goal}`);
  console.log();

  console.log("  \x1b[1mParticipants:\x1b[0m");
  for (const p of participants) {
    const color = p.status === "ready" ? "\x1b[32m" : p.status === "busy" ? "\x1b[33m" : "\x1b[31m";
    const icon = p.status === "ready" ? "\u25cf" : p.status === "busy" ? "\u25cb" : "\u2717";
    const label = p.status === "ready" ? "claude running" : p.status === "busy" ? "busy" : "no session";
    console.log(`    ${color}${icon}\x1b[0m ${(p.oracle.charAt(0).toUpperCase() + p.oracle.slice(1)).padEnd(12)} ${color}${label}\x1b[0m`);
  }
  console.log();

  console.log("  \x1b[1mDiscussion:\x1b[0m");
  for (const d of discussion) {
    const name = d.oracle.charAt(0).toUpperCase() + d.oracle.slice(1);
    const color = d.oracle === "BoB" ? "\x1b[36m" : "\x1b[33m";
    const lines = d.message.split("\n").filter(l => l.trim());
    console.log(`    ${color}[${name}]\x1b[0m`);
    for (const line of lines.slice(0, 12)) {
      console.log(`      ${line}`);
    }
    if (lines.length > 12) console.log(`      \x1b[90m... (${lines.length - 12} more lines)\x1b[0m`);
    console.log();
  }

  if (tasks.length > 0) {
    console.log("  \x1b[1mTasks:\x1b[0m");
    for (const t of tasks) {
      const name = t.oracle.charAt(0).toUpperCase() + t.oracle.slice(1);
      console.log(`    \x1b[33m${t.priority}\x1b[0m  ${name.padEnd(12)} \u2192 ${t.task}`);
    }
    console.log();
  }

  if (dispatched) {
    console.log(`  \x1b[32m\u2713 Tasks assigned\x1b[0m`);
  } else {
    console.log("  \x1b[90m(dry run \u2014 agents not messaged)\x1b[0m");
  }
}

// --- Feed notification ---

function writeMeetingToFeed(transcript: MeetingTranscript) {
  try {
    const { appendFileSync } = require("node:fs");
    const { join } = require("node:path");
    const FEED_LOG = join(process.env.HOME || "/home/curfew", ".oracle", "feed.log");
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const flat = JSON.stringify(transcript).replace(/\n/g, " \u239C ");
    const line = `${ts} | BoB-Oracle | VuttiServer | Notification | BoB-Oracle | autopilot \u00bb [meeting] ${flat}\n`;
    appendFileSync(FEED_LOG, line);
  } catch {}
}

// --- Main entry ---

export async function cmdMeeting(goal: string, opts: MeetingOpts = {}): Promise<MeetingTranscript> {
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const perAgentTimeout = (opts.timeout || 120) * 1000;

  // 1. Select participants
  const participants = selectParticipants(goal, opts.oracles);

  console.log(`\n  \x1b[36mBoB's Meeting: "${goal}"\x1b[0m`);
  console.log(`  Inviting: ${participants.join(", ")}\n`);

  // 2. Resolve tmux targets
  const targets = await resolveTargets(participants);

  for (const t of targets) {
    const icon = t.status === "ready" ? "\x1b[32m\u25cf\x1b[0m" : t.status === "dead" ? "\x1b[31m\u2717\x1b[0m" : "\x1b[33m\u25cb\x1b[0m";
    const label = t.status === "ready" ? "claude running" : t.status === "dead" ? "no session" : "busy";
    console.log(`  ${icon} ${t.oracle.padEnd(12)} ${t.target || "(none)"} — ${label}`);
  }

  // Wake dead agents
  const deadAgents = targets.filter(t => t.status === "dead");
  if (deadAgents.length > 0) {
    console.log(`\n  \x1b[33mWaking ${deadAgents.length} offline agents...\x1b[0m`);
    for (const t of deadAgents) {
      try {
        const wakeTarget = await cmdWake(t.oracle, {});
        t.target = wakeTarget;
        t.status = "ready";
        console.log(`  \x1b[32m\u25cf\x1b[0m ${t.oracle} woken → ${wakeTarget}`);
        await new Promise(r => setTimeout(r, 5_000));
      } catch {
        console.log(`  \x1b[31m\u2717\x1b[0m ${t.oracle} couldn't wake — skipping`);
      }
    }
  }

  const readyAgents = targets.filter(t => t.status === "ready" && t.oracle !== "bob");

  // Dry run
  if (opts.dryRun) {
    const transcript: MeetingTranscript = {
      goal, ts,
      participants: targets.map(t => ({ oracle: t.oracle, target: t.target, status: t.status })),
      discussion: [{ oracle: "BoB", message: `(dry run — ${readyAgents.length} agents ready, not messaged)` }],
      tasks: [],
      dispatched: false,
    };
    printTranscript(transcript);
    return transcript;
  }

  if (readyAgents.length === 0) {
    console.log("\n  \x1b[31mNo agents available for meeting.\x1b[0m");
    return {
      goal, ts,
      participants: targets.map(t => ({ oracle: t.oracle, target: t.target, status: t.status })),
      discussion: [{ oracle: "BoB", message: "No agents available." }],
      tasks: [], dispatched: false,
    };
  }

  // 3. Ask ALL agents in PARALLEL — send messages to their real tmux sessions
  console.log(`\n  \x1b[33mSending meeting question to ${readyAgents.length} agents in parallel...\x1b[0m`);
  console.log(`  \x1b[90m(watch their tmux sessions — they're responding live)\x1b[0m\n`);

  const discussion: { oracle: string; message: string }[] = [];
  discussion.push({ oracle: "BoB", message: `Team meeting: "${goal}" — all oracles answering simultaneously.` });

  // Fire all asks in parallel
  const askResults = await Promise.allSettled(
    readyAgents.map(async (agent) => {
      console.log(`  \x1b[36m>>>\x1b[0m ${agent.oracle}`);
      const response = await askOracle(agent, goal, participants, perAgentTimeout);
      console.log(`  \x1b[32m\u2713\x1b[0m ${agent.oracle} responded`);
      return { oracle: agent.oracle, response };
    })
  );

  // Collect responses
  for (const result of askResults) {
    if (result.status === "fulfilled") {
      discussion.push({ oracle: result.value.oracle, message: result.value.response });
    } else {
      console.log(`  \x1b[31m\u2717\x1b[0m agent failed: ${result.reason}`);
    }
  }

  // 4. BoB synthesizes tasks — send discussion summary to BoB's real session
  console.log(`\n  \x1b[36mBoB synthesizing tasks...\x1b[0m`);

  const bobTarget = targets.find(t => t.oracle === "bob");
  let tasks: MeetingTask[] = [];

  const agentResponses = discussion.filter(d => d.oracle !== "BoB");

  if (bobTarget && bobTarget.status === "ready" && agentResponses.length > 0) {
    const marker = makeMeetingMarker();
    const summary = agentResponses.map(d =>
      `[${d.oracle}] ${d.message.split("\n").slice(0, 5).join(" ").slice(0, 200)}`
    ).join("\n");

    const bobQuestion = [
      `[${marker}] I held a meeting about: "${goal}".`,
      `Oracle responses:\n${summary}\n`,
      `Create a task list from this. For each task: oracle name, task description, priority (P1/P2/P3).`,
      `Keep it short — one line per task.`,
    ].join(" ");

    await sendKeys(bobTarget.target, bobQuestion);
    await new Promise(r => setTimeout(r, 8_000));

    const start = Date.now();
    let lastCap = "";
    let stableCount = 0;

    while (Date.now() - start < 90_000) {
      await new Promise(r => setTimeout(r, 3_000));
      const cap = await capture(bobTarget.target, 80);
      if (cap === lastCap) {
        stableCount++;
        if (stableCount >= 2) {
          const bobResponse = extractResponseAfterMarker(cap, marker);
          discussion.push({ oracle: "BoB", message: bobResponse });
          tasks = parseTasksFromText(bobResponse, readyAgents.map(a => a.oracle));
          break;
        }
      } else {
        stableCount = 0;
      }
      lastCap = cap;
    }
  }

  // Fallback task generation
  if (tasks.length === 0 && agentResponses.length > 0) {
    discussion.push({ oracle: "BoB", message: `Assigned ${agentResponses.length} tasks from oracle input.` });
    tasks = agentResponses.map((d, i) => {
      // Find first meaningful line that's not the question echo
      const skipPatterns = ["Meeting from BoB", "Answer briefly", "What would YOU do", "MTG-"];
      const firstSentence = d.message
        .split("\n")
        .filter(l => {
          const trimmed = l.trim();
          if (!trimmed || trimmed.length < 15) return false;
          if (skipPatterns.some(p => trimmed.includes(p))) return false;
          return true;
        })
        .slice(0, 2)
        .join(" ")
        .slice(0, 200);
      return {
        oracle: d.oracle,
        task: firstSentence || `${ORACLE_ROLES[d.oracle]?.role}: work on "${goal}"`,
        priority: i < 2 ? "P1" : "P2",
      };
    });
  }

  // 5. Build transcript
  const transcript: MeetingTranscript = {
    goal, ts,
    participants: targets.map(t => ({ oracle: t.oracle, target: t.target, status: t.status })),
    discussion, tasks,
    dispatched: true,
  };

  if (!opts.returnTranscript) {
    printTranscript(transcript);
  }
  writeMeetingToFeed(transcript);

  return transcript;
}

// --- Parse task list from BoB's free-text response ---

function parseTasksFromText(text: string, validOracles: string[]): MeetingTask[] {
  const tasks: MeetingTask[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const oracle of validOracles) {
      if (lower.includes(oracle)) {
        const priority = /p1|critical|urgent|blocking/i.test(line) ? "P1"
          : /p3|nice.to.have|optional|low/i.test(line) ? "P3" : "P2";
        let task = line
          .replace(/^[\s\-\*•|●○►▸]+/, "")
          .replace(/\b(P[123])\b/gi, "")
          .trim();
        if (task.length > 10) {
          tasks.push({ oracle, task, priority });
        }
        break;
      }
    }
  }

  return tasks;
}
