/**
 * Heartbeat aggregator — ported from oracle-dashboard/src/brain-feed/heartbeats.ts (commit 8cd4414).
 * Parses "HB: <task-id> <progress%> <short-status>" from feed.log messages per Golden Rule #9.
 *
 * Feed line format (from Rule #9):
 *   TIMESTAMP | Oracle | host | Notification | Oracle | heartbeat » HB: <task-id> <progress%> <status>
 *
 * Output matches oracle-dashboard shape so the ported widget can be moved 1:1.
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export type HeartbeatColor = "green" | "yellow" | "red";

export interface Heartbeat {
  oracle: string;
  taskId: string;
  progress: number;
  status: string;
  lastSeen: string; // ISO 8601
  ageMinutes: number;
  color: HeartbeatColor;
}

const HB_PREFIX = "HB:";
const GREEN_MAX_MIN = 5;
const YELLOW_MAX_MIN = 15;
const DEFAULT_FEED_LOG = join(process.env.HOME || "/home/curfew", ".oracle", "feed.log");

/** Parse "HB: <task-id> <progress%> <status...>" — returns null if not a heartbeat. */
export function parseHeartbeat(
  message: string,
): { taskId: string; progress: number; status: string } | null {
  const trimmed = message.trim();
  const idx = trimmed.indexOf(HB_PREFIX);
  if (idx < 0) return null;

  const rest = trimmed.slice(idx + HB_PREFIX.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  if (parts.length < 1) return null;

  const taskId = parts[0];
  let progress = -1;
  let statusStart = 1;
  if (parts.length >= 2) {
    const pctMatch = parts[1].match(/^(\d{1,3})%?$/);
    if (pctMatch) {
      const n = parseInt(pctMatch[1], 10);
      if (n >= 0 && n <= 100) {
        progress = n;
        statusStart = 2;
      }
    }
  }

  const status = parts.slice(statusStart).join(" ").trim();
  return { taskId, progress, status };
}

export function colorForAge(ageMinutes: number): HeartbeatColor {
  if (ageMinutes <= GREEN_MAX_MIN) return "green";
  if (ageMinutes <= YELLOW_MAX_MIN) return "yellow";
  return "red";
}

interface RawLine {
  timestamp: Date;
  oracle: string;
  message: string;
}

/**
 * Parse a feed.log line. Format:
 *   2026-04-16 13:05:00 | Oracle | host | Event | project/sid | marker » message
 * Accepts both `| sid » message` (canonical) and loose suffixes.
 */
function parseFeedLine(line: string): RawLine | null {
  // Find the " » " split — everything after is the message body.
  const arrowIdx = line.indexOf(" » ");
  const pipeParts = (arrowIdx >= 0 ? line.slice(0, arrowIdx) : line).split(" | ");
  if (pipeParts.length < 2) return null;

  const tsStr = pipeParts[0].trim();
  const oracle = pipeParts[1].trim();
  const ts = new Date(tsStr.replace(" ", "T")); // parse local time
  if (isNaN(ts.getTime())) return null;

  const message = arrowIdx >= 0 ? line.slice(arrowIdx + 3).trim() : "";
  // HB may be in message OR in the last pipe segment (e.g. "| heartbeat » HB: ...")
  const pre = pipeParts[pipeParts.length - 1] || "";
  const combined = message || pre;
  return { timestamp: ts, oracle, message: combined };
}

/**
 * Read the last ~N bytes of feed.log and return the most recent HB per (oracle, taskId).
 * Returns sorted list (worst color first, then newest first).
 */
export function getHeartbeats(
  feedLogPath: string = DEFAULT_FEED_LOG,
  tailBytes = 512 * 1024, // ~500KB ≈ a few thousand lines
  now: number = Date.now(),
): Heartbeat[] {
  let content = "";
  try {
    const stat = statSync(feedLogPath);
    const start = Math.max(0, stat.size - tailBytes);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(feedLogPath, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    content = buf.toString("utf8");
  } catch {
    return [];
  }

  // If we started mid-line, drop the first partial line
  const nl = content.indexOf("\n");
  if (nl > 0) content = content.slice(nl + 1);

  const latest = new Map<
    string,
    { oracle: string; taskId: string; progress: number; status: string; ts: number }
  >();

  for (const line of content.split("\n")) {
    if (!line) continue;
    if (!line.includes(HB_PREFIX)) continue;
    const parsed = parseFeedLine(line);
    if (!parsed) continue;
    const hb = parseHeartbeat(parsed.message);
    if (!hb) continue;

    const key = `${parsed.oracle}::${hb.taskId}`;
    const ts = parsed.timestamp.getTime();
    const prev = latest.get(key);
    if (prev && prev.ts >= ts) continue;
    latest.set(key, {
      oracle: parsed.oracle,
      taskId: hb.taskId,
      progress: hb.progress,
      status: hb.status,
      ts,
    });
  }

  const results: Heartbeat[] = [];
  for (const s of latest.values()) {
    const ageMinutes = Math.max(0, Math.floor((now - s.ts) / 60_000));
    results.push({
      oracle: s.oracle,
      taskId: s.taskId,
      progress: s.progress,
      status: s.status,
      lastSeen: new Date(s.ts).toISOString(),
      ageMinutes,
      color: colorForAge(ageMinutes),
    });
  }

  const order: Record<HeartbeatColor, number> = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => {
    const c = order[a.color] - order[b.color];
    if (c !== 0) return c;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
  return results;
}
