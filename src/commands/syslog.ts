/**
 * commands/syslog.ts — Query SYSTEM events from feed.log
 * Issue: maw-js#65 | Parent: maw-js#61
 *
 * Usage:
 *   maw syslog                      # last 20 system events
 *   maw syslog --since "1h ago"     # last hour
 *   maw syslog --type restart       # filter by event type
 *   maw syslog --service maw        # filter by service name
 *   maw syslog --type boot          # show all boot events
 *   maw syslog --limit 50           # show more
 *   maw syslog --json               # JSON output
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FEED_LOG = join(homedir(), ".oracle", "feed.log");

// ─── Types ──────────────────────────────────────────────────────────

interface SystemEvent {
  timestamp: string;
  host: string;
  type: string; // boot, service-online, service-crash, etc.
  detail: string; // full detail after the type
  raw: string;
}

// ─── Parse SYSTEM lines from feed.log ───────────────────────────────

function parseSystemEvents(): SystemEvent[] {
  if (!existsSync(FEED_LOG)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(FEED_LOG, "utf-8");
  } catch {
    // Feed.log might have non-UTF8 bytes — read with latin1 fallback
    try {
      content = readFileSync(FEED_LOG, "latin1");
    } catch {
      return [];
    }
  }

  const events: SystemEvent[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Match: TIMESTAMP | SYSTEM | HOST | Event | SYSTEM | message
    // The SYSTEM source field distinguishes system events from oracle events
    if (!line.includes("| SYSTEM |")) continue;

    const parts = line.split(" | ");
    if (parts.length < 6) continue;

    const timestamp = parts[0].trim();
    const source = parts[1].trim();
    if (source !== "SYSTEM") continue;

    const host = parts[2].trim();
    // parts[3] = "Event" or "Notification"
    // parts[4] = "SYSTEM"
    const message = parts.slice(5).join(" | ").trim();

    // Parse event type from message
    // Format: "SYSTEM » type: detail" or "type » detail"
    let type = "unknown";
    let detail = message;

    // Match "SYSTEM » service-online: maw — pid 106"
    const sysMatch = message.match(
      /^SYSTEM\s*»\s*([^:]+):\s*(.*)$/
    );
    if (sysMatch) {
      type = sysMatch[1].trim();
      detail = sysMatch[2].trim();
    } else {
      // Match "boot » WSL started"
      const altMatch = message.match(/^([^\s»]+)\s*»\s*(.*)$/);
      if (altMatch) {
        type = altMatch[1].trim();
        detail = altMatch[2].trim();
      }
    }

    events.push({ timestamp, host, type, detail, raw: line });
  }

  return events;
}

// ─── Parse --since relative time ────────────────────────────────────

function parseSince(since: string): Date | null {
  const now = new Date();

  // "1h ago", "30m ago", "2d ago", "1h", "30m", "2d"
  const match = since.match(/^(\d+)\s*(m|min|h|hr|hour|d|day)s?\s*(ago)?$/i);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("m")) return new Date(now.getTime() - n * 60_000);
    if (unit.startsWith("h")) return new Date(now.getTime() - n * 3600_000);
    if (unit.startsWith("d")) return new Date(now.getTime() - n * 86400_000);
  }

  // "today"
  if (since.toLowerCase() === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // "yesterday"
  if (since.toLowerCase() === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ISO or date string
  const parsed = new Date(since);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

function parseTimestamp(ts: string): Date {
  // "2026-06-13 21:15:14"
  return new Date(ts.replace(" ", "T"));
}

// ─── Extract service name from detail ───────────────────────────────

function extractServiceName(type: string, detail: string): string | null {
  // "service-online: maw — pid 106" → "maw"
  // "service-crash: my-service exited code 1" → "my-service"
  // "pm2-daemon: started" → null
  if (
    type.startsWith("service-") ||
    type === "syslog-start" ||
    type === "syslog-stop"
  ) {
    const name = detail.split(/\s+/)[0];
    return name || null;
  }
  return null;
}

// ─── Event type color ───────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  "service-online": "\x1b[32m", // green
  "service-restart": "\x1b[33m", // yellow
  "service-crash": "\x1b[31m", // red
  "service-stop": "\x1b[90m", // dim
  "service-delete": "\x1b[31m", // red
  boot: "\x1b[36m", // cyan
  "pm2-daemon": "\x1b[36m", // cyan
  "disk-warning": "\x1b[33m", // yellow
  "memory-warning": "\x1b[33m", // yellow
  "tunnel-up": "\x1b[32m", // green
  "tunnel-down": "\x1b[31m", // red
  "syslog-start": "\x1b[36m", // cyan
  "syslog-stop": "\x1b[90m", // dim
  shutdown: "\x1b[33m", // yellow
};

const RST = "\x1b[0m";
const DIM = "\x1b[90m";

function typeColor(type: string): string {
  return TYPE_COLORS[type] || "\x1b[37m";
}

// ─── Main command ───────────────────────────────────────────────────

export interface SyslogOpts {
  since?: string;
  type?: string;
  service?: string;
  limit?: number;
  json?: boolean;
}

export function cmdSyslog(opts: SyslogOpts) {
  let events = parseSystemEvents();

  if (events.length === 0) {
    console.log("\n  \x1b[90mNo system events found in feed.log.\x1b[0m\n");
    return;
  }

  // Filter by --since
  if (opts.since) {
    const sinceDate = parseSince(opts.since);
    if (!sinceDate) {
      console.error(
        `\x1b[31merror:\x1b[0m cannot parse --since "${opts.since}"\n` +
          `  examples: "1h ago", "30m", "2d ago", "today", "yesterday"`
      );
      process.exit(1);
    }
    events = events.filter(
      (e) => parseTimestamp(e.timestamp) >= sinceDate
    );
  }

  // Filter by --type
  if (opts.type) {
    const t = opts.type.toLowerCase();
    events = events.filter((e) => {
      const et = e.type.toLowerCase();
      // Partial match: "restart" matches "service-restart"
      return et === t || et.includes(t);
    });
  }

  // Filter by --service
  if (opts.service) {
    const s = opts.service.toLowerCase();
    events = events.filter((e) => {
      const svc = extractServiceName(e.type, e.detail);
      if (svc && svc.toLowerCase().includes(s)) return true;
      // Also check raw detail
      return e.detail.toLowerCase().includes(s);
    });
  }

  // Apply limit
  const limit = opts.limit || 20;
  const total = events.length;
  const shown = events.slice(-limit);

  // JSON output
  if (opts.json) {
    console.log(
      JSON.stringify(
        shown.map((e) => ({
          timestamp: e.timestamp,
          host: e.host,
          type: e.type,
          detail: e.detail,
        })),
        null,
        2
      )
    );
    return;
  }

  // Table output
  console.log(
    `\n  \x1b[36mmaw syslog\x1b[0m (${total} total, showing last ${shown.length})\n`
  );
  console.log(
    `  ${"Time".padEnd(20)} ${"Type".padEnd(20)} Detail`
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(50)}`
  );

  for (const e of shown) {
    const color = typeColor(e.type);
    const ts = e.timestamp.padEnd(20);
    const type = e.type.slice(0, 19).padEnd(20);
    const detail = e.detail.slice(0, 70);
    console.log(`  ${DIM}${ts}${RST} ${color}${type}${RST} ${detail}`);
  }

  if (total > limit) {
    console.log(
      `\n  ${DIM}(${total - limit} older events hidden — use --limit ${total} to see all)${RST}`
    );
  }

  console.log();
}
