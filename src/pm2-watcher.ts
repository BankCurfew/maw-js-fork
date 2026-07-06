/**
 * pm2-watcher.ts — Monitor P0 services via PM2, alert feed.log when they die
 * Issue: maw-js#35
 *
 * Polls `pm2 jlist` every 30s. When a watched service:
 *   - exits unexpectedly (status !== "online")
 *   - exceeds restart threshold (>5 restarts in 10 min)
 * → writes to ~/.oracle/feed.log with `needs your attention` keyword
 * → optionally sends `maw hey admin` notification
 */

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";

const FEED_LOG = join(homedir(), ".oracle", "feed.log");
const POLL_INTERVAL_MS = 30_000; // 30s
const RESTART_THRESHOLD = 5; // >5 restarts in window = alert
const RESTART_WINDOW_MS = 10 * 60_000; // 10 min

// P0 services to watch — add more as needed
const WATCHED_SERVICES = [
  
  
  
  "maw",
  "maw-bob",
  "oracle-api",
];

interface ServiceState {
  name: string;
  status: string;
  restarts: number;
  pid: number;
  lastAlertTs: number; // avoid alert spam — 1 alert per 5 min per service
  restartHistory: number[]; // timestamps of observed restart count increases
}

const serviceStates = new Map<string, ServiceState>();
const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 min between alerts for same service

function timestamp(): string {
  // Local time (GMT+7) per Golden Rule #9
  const now = new Date();
  return now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + " " +
    String(now.getHours()).padStart(2, "0") + ":" +
    String(now.getMinutes()).padStart(2, "0") + ":" +
    String(now.getSeconds()).padStart(2, "0");
}

function writeFeedAlert(service: string, message: string) {
  const dir = join(homedir(), ".oracle");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry = `${timestamp()} | maw-server | ${hostname()} | Notification | maw-server | needs your attention — PM2 ALERT: ${service} ${message}`;
  appendFileSync(FEED_LOG, entry + "\n");
  console.log(`[pm2-watcher] ALERT: ${service} — ${message}`);
}

function notifyAdmin(service: string, message: string) {
  try {
    execSync(
      `tmux send-keys -t 01-bob:0 -l 'maw hey admin "PM2 ALERT: ${service} — ${message.replace(/"/g, '\\"')}"' && tmux send-keys -t 01-bob:0 Enter`,
      { timeout: 5000, stdio: "ignore" }
    );
  } catch {
    // Best-effort — don't crash the watcher
  }
}

function getPm2Processes(): any[] {
  try {
    const raw = execSync("pm2 jlist 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function checkServices() {
  const procs = getPm2Processes();
  if (procs.length === 0) return;

  const now = Date.now();

  for (const proc of procs) {
    const name = proc.name as string;
    if (!WATCHED_SERVICES.includes(name)) continue;

    const status = proc.pm2_env?.status || "unknown";
    const restarts = proc.pm2_env?.restart_time || 0;
    const pid = proc.pid || 0;

    const prev = serviceStates.get(name);
    const canAlert = !prev || (now - prev.lastAlertTs > ALERT_COOLDOWN_MS);

    // Initialize state on first run
    if (!prev) {
      serviceStates.set(name, {
        name,
        status,
        restarts,
        pid,
        lastAlertTs: 0,
        restartHistory: [],
      });
      // Don't alert on first poll — just record baseline
      continue;
    }

    // Check 1: Service went offline/errored
    if (status !== "online" && prev.status === "online" && canAlert) {
      writeFeedAlert(name, `DOWN — status: ${status} (was online, pid was ${prev.pid})`);
      notifyAdmin(name, `DOWN — status: ${status}`);
      prev.lastAlertTs = now;
    }

    // Check 2: Service errored state
    if (status === "errored" && prev.status !== "errored" && canAlert) {
      writeFeedAlert(name, `ERRORED — exceeded max restarts`);
      notifyAdmin(name, `ERRORED — needs manual intervention`);
      prev.lastAlertTs = now;
    }

    // Check 3: Restart count increased → track restart velocity
    if (restarts > prev.restarts) {
      const delta = restarts - prev.restarts;
      for (let i = 0; i < delta; i++) {
        prev.restartHistory.push(now);
      }
      // Prune old restart timestamps outside window
      prev.restartHistory = prev.restartHistory.filter(t => now - t < RESTART_WINDOW_MS);

      // Alert if restart rate exceeds threshold
      if (prev.restartHistory.length > RESTART_THRESHOLD && canAlert) {
        writeFeedAlert(
          name,
          `RESTART STORM — ${prev.restartHistory.length} restarts in ${Math.round(RESTART_WINDOW_MS / 60_000)}min (total: ${restarts})`
        );
        notifyAdmin(name, `RESTART STORM — ${prev.restartHistory.length} restarts in 10min`);
        prev.lastAlertTs = now;
        prev.restartHistory = []; // Reset after alert to avoid re-firing
      }
    }

    // Update state
    prev.status = status;
    prev.restarts = restarts;
    prev.pid = pid;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPm2Watcher() {
  console.log(`[pm2-watcher] watching ${WATCHED_SERVICES.length} services (poll: ${POLL_INTERVAL_MS / 1000}s, restart threshold: >${RESTART_THRESHOLD} in ${RESTART_WINDOW_MS / 60_000}min)`);

  // Initial check after 5s (let server finish booting)
  setTimeout(() => {
    checkServices();
    pollTimer = setInterval(checkServices, POLL_INTERVAL_MS);
  }, 5_000);
}

export function stopPm2Watcher() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
