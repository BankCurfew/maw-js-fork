/**
 * maw audit — Compliance audit for DocCon
 * Issue: maw-js#38
 *
 * Usage:
 *   maw audit             — combined daily report (cc + tasks)
 *   maw audit cc          — parse cc's, validate Rule #8 fields
 *   maw audit cc --today  — today's cc's only
 *   maw audit tasks       — find tasks with orphan/stale issues
 *   maw audit tasks --orphan — tasks with zero log entries
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MAW_LOG_PATH = join(homedir(), ".oracle", "maw-log.jsonl");
const FEED_LOG_PATH = join(homedir(), ".oracle", "feed.log");
const MAW_URL = process.env.MAW_URL || "http://localhost:3456";

// ── CC Audit (Rule #8 compliance) ────────────────────────────────────────────

interface CcEntry {
  ts: string;
  from: string;
  to: string;
  msg: string;
  fields: { what: boolean; why: boolean; next: boolean; ref: boolean };
  score: number; // 0-4 (number of fields present)
}

function parseCcFields(msg: string): CcEntry["fields"] {
  // Rule #8 required fields: what (verb+object), why/source, next, ref
  const lower = msg.toLowerCase();

  // "what" — message has a verb-like start after "cc:"
  const ccBody = msg.replace(/^cc:\s*/i, "").trim();
  const hasWhat = ccBody.length > 5 && /^[a-z]+(ed|ing|s)?\b/i.test(ccBody);

  // "why" or "source" — contains src:, why:, source:, eval, issue#, ref to external
  const hasWhy = /\b(src|source|why|eval|issue|§|#\d+)\b/i.test(msg) || /\breq(uest)?\b/i.test(msg);

  // "next" — contains next:, done, awaiting, monitoring, idle
  const hasNext = /\b(next|done|awaiting|monitoring|idle|waiting|blocked)\b/i.test(msg);

  // "ref" — contains ref:, file:line, .ts, .js, .md, repo#
  const hasRef = /\b(ref|file|\.ts|\.js|\.md|\.py|\.sh)\b/i.test(msg) || /[A-Za-z\-]+#\d+/.test(msg) || /[a-z]+\/[a-z]+\.[a-z]+:\d+/.test(msg);

  return { what: hasWhat, why: hasWhy, next: hasNext, ref: hasRef };
}

function loadMawLog(since?: Date): CcEntry[] {
  if (!existsSync(MAW_LOG_PATH)) return [];
  const raw = readFileSync(MAW_LOG_PATH, "utf-8");
  const entries: CcEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.msg || !entry.ts) continue;

      // Filter to cc messages
      const msg = entry.msg as string;
      if (!msg.match(/^(\[[\w-]+\]\s*)?cc:/i)) continue;

      // Filter by date if specified
      if (since) {
        const entryDate = new Date(entry.ts);
        if (entryDate < since) continue;
      }

      const fields = parseCcFields(msg);
      const score = [fields.what, fields.why, fields.next, fields.ref].filter(Boolean).length;

      entries.push({
        ts: entry.ts,
        from: entry.from || "unknown",
        to: entry.to || "unknown",
        msg,
        fields,
        score,
      });
    } catch {}
  }
  return entries;
}

function auditCc(args: string[]) {
  const today = args.includes("--today");
  const since = today ? todayStart() : undefined;
  const label = today ? "today" : "all time";

  const entries = loadMawLog(since);

  if (entries.length === 0) {
    console.log(`\n  \x1b[90mNo cc messages found (${label}).\x1b[0m\n`);
    return;
  }

  // Group by oracle
  const byOracle = new Map<string, CcEntry[]>();
  for (const e of entries) {
    const oracle = e.from.toLowerCase().replace(/-oracle$/i, "");
    const prev = byOracle.get(oracle) || [];
    prev.push(e);
    byOracle.set(oracle, prev);
  }

  console.log(`\n  \x1b[36mCC Compliance Audit\x1b[0m (${label}) — ${entries.length} messages from ${byOracle.size} oracles\n`);

  // Per-oracle summary
  const scores: { oracle: string; total: number; avg: number; perfect: number; bad: number }[] = [];
  for (const [oracle, ccs] of [...byOracle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = ccs.length;
    const avg = ccs.reduce((s, c) => s + c.score, 0) / total;
    const perfect = ccs.filter(c => c.score === 4).length;
    const bad = ccs.filter(c => c.score <= 1).length;
    scores.push({ oracle, total, avg, perfect, bad });
  }

  // Table
  console.log("  \x1b[1mOracle          CCs   Avg   Perfect  Incomplete\x1b[0m");
  for (const s of scores) {
    const color = s.avg >= 3 ? "\x1b[32m" : s.avg >= 2 ? "\x1b[33m" : "\x1b[31m";
    const icon = s.avg >= 3 ? "\x1b[32m●\x1b[0m" : s.avg >= 2 ? "\x1b[33m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    console.log(`  ${icon} ${s.oracle.padEnd(14)} ${String(s.total).padStart(4)}  ${color}${s.avg.toFixed(1)}/4\x1b[0m  ${String(s.perfect).padStart(7)}  ${s.bad > 0 ? `\x1b[31m${String(s.bad).padStart(10)}\x1b[0m` : String(s.bad).padStart(10)}`);
  }

  // Flag worst offenders
  const badMessages = entries.filter(e => e.score <= 1).slice(-10);
  if (badMessages.length > 0) {
    console.log(`\n  \x1b[31mIncomplete CCs (score ≤1):\x1b[0m`);
    for (const e of badMessages) {
      const time = new Date(e.ts).toLocaleString("en-GB", {
        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const oracle = e.from.toLowerCase().replace(/-oracle$/i, "");
      const missing = [];
      if (!e.fields.what) missing.push("what");
      if (!e.fields.why) missing.push("why");
      if (!e.fields.next) missing.push("next");
      if (!e.fields.ref) missing.push("ref");
      console.log(`  \x1b[31m✗\x1b[0m ${time} ${oracle}: "${e.msg.slice(0, 80)}${e.msg.length > 80 ? "..." : ""}"`);
      console.log(`    \x1b[90mmissing: ${missing.join(", ")}\x1b[0m`);
    }
  }

  // Overall score
  const totalAvg = entries.reduce((s, e) => s + e.score, 0) / entries.length;
  const grade = totalAvg >= 3.5 ? "\x1b[32mA\x1b[0m" : totalAvg >= 3 ? "\x1b[32mB\x1b[0m" : totalAvg >= 2 ? "\x1b[33mC\x1b[0m" : totalAvg >= 1 ? "\x1b[31mD\x1b[0m" : "\x1b[31mF\x1b[0m";
  console.log(`\n  Overall: ${grade} (${totalAvg.toFixed(1)}/4 avg across ${entries.length} messages)\n`);
}

// ── Task Audit ───────────────────────────────────────────────────────────────

interface TaskInfo {
  id: string;
  title: string;
  status: string;
  logs: number;
  project?: string;
  created?: string;
}

async function auditTasks(args: string[]) {
  const orphanOnly = args.includes("--orphan");

  try {
    // Fetch tasks from maw API
    const res = await fetch(`${MAW_URL}/api/tasks`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();

    const tasks: TaskInfo[] = Array.isArray(data) ? data : (data.tasks || []);

    if (tasks.length === 0) {
      console.log("\n  \x1b[90mNo tasks found.\x1b[0m\n");
      return;
    }

    const orphans = tasks.filter(t => (t.logs || 0) === 0);
    const stale = tasks.filter(t => {
      if (t.status === "completed" || t.status === "archived") return false;
      if (!t.created) return false;
      const age = Date.now() - new Date(t.created).getTime();
      return age > 7 * 24 * 3600_000; // >7 days old and not done
    });

    if (orphanOnly) {
      console.log(`\n  \x1b[36mOrphan Tasks\x1b[0m (zero log entries) — ${orphans.length} found\n`);
      if (orphans.length === 0) {
        console.log("  \x1b[32mAll tasks have log entries.\x1b[0m\n");
        return;
      }
      for (const t of orphans) {
        console.log(`  \x1b[31m●\x1b[0m ${t.id} — ${t.title.slice(0, 60)} \x1b[90m[${t.status}]${t.project ? ` (${t.project})` : ""}\x1b[0m`);
      }
      console.log();
      return;
    }

    // Full task audit
    console.log(`\n  \x1b[36mTask Audit\x1b[0m — ${tasks.length} tasks\n`);
    console.log(`  Orphans (no logs): ${orphans.length > 0 ? `\x1b[31m${orphans.length}\x1b[0m` : "\x1b[32m0\x1b[0m"}`);
    console.log(`  Stale (>7d open):  ${stale.length > 0 ? `\x1b[33m${stale.length}\x1b[0m` : "\x1b[32m0\x1b[0m"}`);
    console.log(`  Active:            ${tasks.filter(t => t.status === "active" || t.status === "in_progress").length}`);
    console.log(`  Completed:         ${tasks.filter(t => t.status === "completed").length}`);

    if (orphans.length > 0) {
      console.log(`\n  \x1b[31mOrphans:\x1b[0m`);
      for (const t of orphans.slice(0, 10)) {
        console.log(`    ● ${t.id} — ${t.title.slice(0, 50)} \x1b[90m[${t.status}]\x1b[0m`);
      }
      if (orphans.length > 10) console.log(`    \x1b[90m... and ${orphans.length - 10} more\x1b[0m`);
    }

    if (stale.length > 0) {
      console.log(`\n  \x1b[33mStale:\x1b[0m`);
      for (const t of stale.slice(0, 10)) {
        const age = Math.floor((Date.now() - new Date(t.created!).getTime()) / (24 * 3600_000));
        console.log(`    ● ${t.id} — ${t.title.slice(0, 50)} \x1b[90m[${age}d old, ${t.status}]\x1b[0m`);
      }
      if (stale.length > 10) console.log(`    \x1b[90m... and ${stale.length - 10} more\x1b[0m`);
    }

    console.log();
  } catch (e: any) {
    // Fallback: try to read tasks from local project files
    console.error(`  \x1b[31mError:\x1b[0m ${e.message} — is maw server running?`);
    console.log("  Tip: Start maw server or use maw audit cc (doesn't need server).\n");
  }
}

// ── Heartbeat Audit ──────────────────────────────────────────────────────────

function auditHeartbeat() {
  if (!existsSync(FEED_LOG_PATH)) {
    console.log("\n  \x1b[90mNo feed.log found.\x1b[0m\n");
    return;
  }

  const raw = readFileSync(FEED_LOG_PATH, "utf-8");
  const lines = raw.split("\n").filter(l => l.includes("heartbeat"));
  const recent = lines.slice(-50);

  // Group by oracle
  const byOracle = new Map<string, { last: string; count: number }>();
  for (const line of recent) {
    const match = line.match(/\| (\w[\w-]*) \|.*heartbeat/);
    if (!match) continue;
    const oracle = match[1];
    const prev = byOracle.get(oracle) || { last: "", count: 0 };
    prev.last = line.slice(0, 19);
    prev.count++;
    byOracle.set(oracle, prev);
  }

  console.log(`\n  \x1b[36mHeartbeat Audit\x1b[0m — ${byOracle.size} oracles with heartbeats\n`);
  if (byOracle.size === 0) {
    console.log("  \x1b[90mNo heartbeat entries found in feed.log.\x1b[0m\n");
    return;
  }

  for (const [oracle, data] of [...byOracle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ● ${oracle.padEnd(18)} ${data.count} heartbeats, last: ${data.last}`);
  }
  console.log();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

export async function cmdAudit(args: string[]) {
  const sub = args[0];

  if (sub === "cc") {
    auditCc(args.slice(1));
    return;
  }

  if (sub === "tasks" || sub === "task") {
    await auditTasks(args.slice(1));
    return;
  }

  if (sub === "heartbeat" || sub === "hb") {
    auditHeartbeat();
    return;
  }

  if (sub === "help" || sub === "--help") {
    console.log(`
  \x1b[36mmaw audit\x1b[0m — Compliance audit for DocCon

  Usage:
    maw audit             Combined daily report (cc + tasks)
    maw audit cc          CC compliance (Rule #8 fields)
    maw audit cc --today  Today's CCs only
    maw audit tasks       Task health report
    maw audit tasks --orphan  Tasks with zero log entries
    maw audit heartbeat   Heartbeat compliance (Rule #9)
`);
    return;
  }

  // Default: combined report
  console.log("\x1b[1m╔══════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║     maw audit — Daily Compliance     ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════╝\x1b[0m");

  auditCc(["--today"]);
  await auditTasks([]);
  auditHeartbeat();
}
