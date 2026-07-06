/**
 * Anti-Pattern Detection — Zombie, Island, Parasite, Clone
 *
 * Implements health checks per YourOrg/maw-js#3.
 * Data sources: feed.log, maw-log.jsonl, tmux sessions, loops.json, git log.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { ORACLE_SESSIONS, EXPECTED_ORACLES } from "./oracle-health";
import { parseLog, type LogEntry } from "./maw-log";
import { parseLine, type FeedEvent } from "./lib/feed";

// --- Types ---

export type AntiPatternType = "zombie" | "island" | "parasite" | "clone";
export type Severity = "notice" | "warning" | "critical";

export interface AntiPatternFlag {
  type: AntiPatternType;
  oracle: string;
  severity: Severity;
  reasons: string[];
  action?: string;
}

export interface ScanResult {
  timestamp: string;
  zombies: AntiPatternFlag[];
  islands: AntiPatternFlag[];
  parasites: AntiPatternFlag[];
  clones: AntiPatternFlag[];
  total: number;
}

// --- Constants ---

const FEED_PATH = join(homedir(), ".oracle", "feed.log");
const LOOPS_PATH = join(homedir(), ".maw", "loops.json");

/** Oracles with legitimately low commit output — check thread/doc output instead */
const LOW_COMMIT_ROLES = new Set(["hr", "doc", "researcher", "editor"]);

/** Feed name → EXPECTED_ORACLES key alias (when feed name doesn't match) */
const FEED_NAME_ALIASES: Record<string, string> = {
  doccon: "doc",
  "doccon-oracle": "doc",
  bob: "bob",  // BoB-Oracle → bob (already works but BoB casing is tricky)
};

// Thresholds (in hours)
const ZOMBIE_WARNING_H = 24;
const ZOMBIE_CRITICAL_H = 48;
const ZOMBIE_SEVERE_H = 168; // 7 days

const ISLAND_THREAD_DAYS = 7;
const ISLAND_COMMS_DAYS = 14;
const ISLAND_TASKS_NO_CC = 3;
const ISLAND_COMMITS_NO_LINK = 5;

// --- Helpers ---

function hoursAgo(ms: number): number {
  return (Date.now() - ms) / (1000 * 60 * 60);
}

function daysAgo(ms: number): number {
  return hoursAgo(ms) / 24;
}

/** Get live tmux sessions */
function getLiveSessions(): Set<string> {
  try {
    const out = execSync("tmux list-sessions -F '#{session_name}'", { encoding: "utf-8", timeout: 5000 });
    return new Set(out.trim().split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Get enabled loops per oracle */
function getEnabledLoops(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    if (!existsSync(LOOPS_PATH)) return map;
    const data = JSON.parse(readFileSync(LOOPS_PATH, "utf-8"));
    // loops.json is { enabled, loops: [...] } — not a flat array
    const loops: Array<{ oracle: string; enabled: boolean }> = Array.isArray(data) ? data : (data.loops || []);
    for (const loop of loops) {
      if (loop.enabled) {
        map.set(loop.oracle, (map.get(loop.oracle) || 0) + 1);
      }
    }
  } catch {}
  return map;
}

/** Get last feed event per oracle from feed.log (scan last 500KB) */
function getLastFeedEvents(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    if (!existsSync(FEED_PATH)) return map;
    const stat = require("fs").statSync(FEED_PATH);
    const size = stat.size;
    const chunkSize = Math.min(size, 500_000);
    const fd = require("fs").openSync(FEED_PATH, "r");
    const buf = Buffer.alloc(chunkSize);
    require("fs").readSync(fd, buf, 0, chunkSize, size - chunkSize);
    require("fs").closeSync(fd);

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const event = parseLine(line);
      if (event) {
        map.set(event.oracle, event.ts);
      }
    }
  } catch {}
  return map;
}

/** Get recent maw-log entries (last 14 days) */
function getRecentLogEntries(days: number): LogEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = parseLog();
  return entries.filter(e => {
    const ts = new Date(e.ts).getTime();
    return ts > cutoff;
  });
}

/** Get recent git commits per oracle across ghq repos */
function getRecentCommits(oracle: string, days: number): number {
  try {
    // Check the oracle's main repo via fleet config
    const sessionName = ORACLE_SESSIONS[oracle];
    if (!sessionName) return 0;

    // Search common repo locations
    const ghqRoot = join(homedir(), "repos/github.com/YourOrg");
    const oracleName = oracle.charAt(0).toUpperCase() + oracle.slice(1);
    const repoPaths = [
      join(ghqRoot, `${oracleName}-Oracle`),
      join(ghqRoot, `${oracle}-oracle`),
    ];

    let total = 0;
    for (const repoPath of repoPaths) {
      try {
        if (!existsSync(repoPath)) continue;
        const out = execSync(
          `git -C "${repoPath}" log --since="${days} days ago" --oneline 2>/dev/null | wc -l`,
          { encoding: "utf-8", timeout: 5000 }
        );
        total += parseInt(out.trim()) || 0;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

// --- Detectors ---

export function detectZombies(): AntiPatternFlag[] {
  const flags: AntiPatternFlag[] = [];
  const liveSessions = getLiveSessions();
  const enabledLoops = getEnabledLoops();
  const lastFeedEvents = getLastFeedEvents();

  // Normalize oracle names in feed log (e.g. "Dev-Oracle" → "dev", "DocCon-Oracle" → "doc")
  const feedByKey = new Map<string, number>();
  for (const [name, ts] of lastFeedEvents) {
    let key = name.replace("-Oracle", "").toLowerCase();
    // Apply alias mapping (e.g. "doccon" → "doc")
    key = FEED_NAME_ALIASES[key] || key;
    const existing = feedByKey.get(key) || 0;
    if (ts > existing) feedByKey.set(key, ts);
  }

  for (const oracle of EXPECTED_ORACLES) {
    const sessionName = ORACLE_SESSIONS[oracle];
    const hasSession = liveSessions.has(sessionName);
    const hasLoops = (enabledLoops.get(oracle) || 0) > 0;
    const lastActivity = feedByKey.get(oracle);

    // Only flag if has session OR has loops but no activity
    if (!hasSession && !hasLoops) continue;

    if (!lastActivity) {
      // No feed event ever recorded but has session/loops
      if (hasLoops) {
        flags.push({
          type: "zombie", oracle, severity: "critical",
          reasons: [`No feed activity recorded`, `${enabledLoops.get(oracle)} loops still enabled`],
          action: "Review and disable loops if oracle is not operational",
        });
      }
      continue;
    }

    const hours = hoursAgo(lastActivity);

    if (hours >= ZOMBIE_SEVERE_H && (hasSession || hasLoops)) {
      flags.push({
        type: "zombie", oracle, severity: "critical",
        reasons: [
          `No activity for ${Math.round(hours / 24)}d`,
          hasSession ? "tmux session alive" : "",
          hasLoops ? `${enabledLoops.get(oracle)} loops active` : "",
        ].filter(Boolean),
        action: "Auto-disable loops, flag for manual review",
      });
    } else if (hours >= ZOMBIE_CRITICAL_H && (hasSession || hasLoops)) {
      flags.push({
        type: "zombie", oracle, severity: "warning",
        reasons: [
          `No activity for ${Math.round(hours)}h`,
          hasLoops ? `${enabledLoops.get(oracle)} loops still running` : "",
        ].filter(Boolean),
        action: "Notify Bob to check oracle status",
      });
    } else if (hours >= ZOMBIE_WARNING_H && hasLoops) {
      flags.push({
        type: "zombie", oracle, severity: "notice",
        reasons: [`No activity for ${Math.round(hours)}h`, `${enabledLoops.get(oracle)} loops enabled`],
      });
    }
  }

  return flags;
}

export function detectIslands(): AntiPatternFlag[] {
  const flags: AntiPatternFlag[] = [];
  const logEntries = getRecentLogEntries(ISLAND_COMMS_DAYS);
  const lastFeedEvents = getLastFeedEvents();

  // Normalize feed keys (e.g. "DocCon-Oracle" → "doc")
  const feedByKey = new Map<string, number>();
  for (const [name, ts] of lastFeedEvents) {
    let key = name.replace("-Oracle", "").toLowerCase();
    key = FEED_NAME_ALIASES[key] || key;
    const existing = feedByKey.get(key) || 0;
    if (ts > existing) feedByKey.set(key, ts);
  }

  for (const oracle of EXPECTED_ORACLES) {
    // Skip dead oracles (they're zombies, not islands)
    const lastActivity = feedByKey.get(oracle);
    if (!lastActivity || hoursAgo(lastActivity) > ZOMBIE_CRITICAL_H) continue;

    const reasons: string[] = [];
    let criteriaCount = 0;

    const oracleVariants = new Set([oracle, `${oracle}-oracle`]);
    if (oracle === "doc") { oracleVariants.add("doccon"); oracleVariants.add("doccon-oracle"); }

    // Check 1: cc bob frequency
    // Look for messages TO bob that mention this oracle (cc pattern)
    const sessionPrefix = ORACLE_SESSIONS[oracle];
    const bobMessages = logEntries.filter(e => {
      const to = (e.to || "").toLowerCase();
      if (to !== "bob" && to !== "bob-oracle") return false;
      // Check if message was sent from this oracle's session
      if (sessionPrefix && (e.target || "").startsWith(sessionPrefix)) return true;
      // Check message content for oracle signature
      const msg = (e.msg || "").toLowerCase();
      const oracleTitleCase = oracle.charAt(0).toUpperCase() + oracle.slice(1);
      return msg.includes(`${oracleTitleCase}-Oracle`) || msg.includes(`from ${oracle}`) || msg.includes(`cc: ${oracle}`);
    });
    // Count task completions sent TO this oracle (as proxy for tasks done)
    const tasksDone = logEntries.filter(e => {
      const to = (e.to || "").replace("-oracle", "").toLowerCase();
      if (!oracleVariants.has(to) && !oracleVariants.has((e.to || "").toLowerCase())) return false;
      const msg = (e.msg || "").toLowerCase();
      return msg.includes("done") || msg.includes("เสร็จ") || msg.includes("complete");
    });
    if (tasksDone.length >= ISLAND_TASKS_NO_CC && bobMessages.length === 0) {
      reasons.push(`${tasksDone.length} task completions but 0 cc bob`);
      criteriaCount++;
    }

    // Check 2: cross-oracle communication in last 7 days
    // maw-log `from` is often "cli" — check `to` field (messages received)
    // and `target` field / message content for messages sent
    const messagesReceived = logEntries.filter(e => {
      const to = (e.to || "").replace("-oracle", "").toLowerCase();
      return oracleVariants.has(to) || oracleVariants.has((e.to || "").toLowerCase());
    });
    const messagesSent = logEntries.filter(e => {
      // Check target field (tmux target like "02-dev:0" → oracle is dev)
      const sessionPrefix = ORACLE_SESSIONS[oracle];
      if (sessionPrefix && (e.target || "").startsWith(sessionPrefix)) return true;
      // Check message content for oracle signature
      const msg = (e.msg || "").toLowerCase();
      const oracleTitleCase = oracle.charAt(0).toUpperCase() + oracle.slice(1);
      return msg.includes(`${oracleTitleCase}-Oracle`) || msg.includes(`from ${oracle}`) || msg.includes(`— ${oracle}`);
    });

    const recentReceived = messagesReceived.filter(e => daysAgo(new Date(e.ts).getTime()) <= ISLAND_THREAD_DAYS);
    const recentSent = messagesSent.filter(e => daysAgo(new Date(e.ts).getTime()) <= ISLAND_THREAD_DAYS);

    if (recentReceived.length === 0 && recentSent.length === 0) {
      reasons.push(`No cross-oracle comms in ${ISLAND_THREAD_DAYS}d`);
      criteriaCount++;
    }

    // Check 3: commits without task/issue links
    const recentCommits = getRecentCommits(oracle, ISLAND_COMMS_DAYS);
    if (recentCommits > ISLAND_COMMITS_NO_LINK) {
      // We can't easily check if commits reference issues without reading git logs
      // Flag as potential — Bob can verify
      reasons.push(`${recentCommits} commits in ${ISLAND_COMMS_DAYS}d (verify task links)`);
      // Don't count as criteria yet — needs manual check
    }

    if (criteriaCount >= 2) {
      flags.push({ type: "island", oracle, severity: "warning", reasons });
    } else if (criteriaCount === 1) {
      flags.push({ type: "island", oracle, severity: "notice", reasons });
    }

    // Severe: >14 days no cross-oracle comms at all
    if (messagesReceived.length === 0 && messagesSent.length === 0 && lastActivity && daysAgo(lastActivity) <= 2) {
      // Active but completely isolated for the full 14d window
      flags.push({
        type: "island", oracle, severity: "critical",
        reasons: [`Active oracle with ZERO cross-oracle communication in ${ISLAND_COMMS_DAYS}d`],
        action: "Escalate to Bob — oracle may be working in isolation",
      });
    }
  }

  return flags;
}

// --- Main Scan ---

export function runAntiPatternScan(): ScanResult {
  const zombies = detectZombies();
  const islands = detectIslands();
  // Phase 2: parasites
  // Phase 3: clones
  const parasites: AntiPatternFlag[] = [];
  const clones: AntiPatternFlag[] = [];

  return {
    timestamp: new Date().toISOString(),
    zombies,
    islands,
    parasites,
    clones,
    total: zombies.length + islands.length + parasites.length + clones.length,
  };
}

// --- Display ---

const EMOJI: Record<AntiPatternType, string> = {
  zombie: "🧟",
  island: "🏝️",
  parasite: "🦠",
  clone: "🧬",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  notice: "\x1b[33m",   // yellow
  warning: "\x1b[38;5;208m", // orange
  critical: "\x1b[31m", // red
};

export function formatScanResult(result: ScanResult): string {
  const lines: string[] = [];

  lines.push(`\x1b[36m🏥 ANTI-PATTERN SCAN\x1b[0m — ${result.timestamp.split("T")[0]}`);
  lines.push("━".repeat(50));

  const sections: [AntiPatternType, AntiPatternFlag[]][] = [
    ["zombie", result.zombies],
    ["island", result.islands],
    ["parasite", result.parasites],
    ["clone", result.clones],
  ];

  for (const [type, flags] of sections) {
    const emoji = EMOJI[type];
    const label = type.charAt(0).toUpperCase() + type.slice(1) + "s";

    if (flags.length === 0) {
      lines.push(`${emoji} ${label} (0): \x1b[32mnone\x1b[0m`);
    } else {
      lines.push(`${emoji} ${label} (${flags.length}):`);
      for (const flag of flags) {
        const color = SEVERITY_COLOR[flag.severity];
        const severityTag = `${color}${flag.severity.toUpperCase()}\x1b[0m`;
        lines.push(`   ${severityTag} ${flag.oracle} — ${flag.reasons.join(", ")}`);
        if (flag.action) {
          lines.push(`     → ${flag.action}`);
        }
      }
    }
  }

  lines.push("━".repeat(50));

  if (result.total === 0) {
    lines.push(`\x1b[32m✓ All clear — no anti-patterns detected\x1b[0m`);
  } else {
    const critical = [...result.zombies, ...result.islands, ...result.parasites, ...result.clones]
      .filter(f => f.severity === "critical").length;
    lines.push(`Total: ${result.total} issue${result.total > 1 ? "s" : ""}${critical > 0 ? ` — \x1b[31m${critical} critical\x1b[0m` : ""}`);
  }

  return lines.join("\n");
}

/** CLI entry point for `maw pulse scan` */
export function cmdPulseScan(opts: { json?: boolean }) {
  const result = runAntiPatternScan();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatScanResult(result));
  }
}
