#!/usr/bin/env bun
/**
 * syslog.ts — PM2 event listener service (maw-syslog)
 * Issue: maw-js#63 | Parent: maw-js#61
 *
 * Connects to PM2 bus via `pm2.launchBus()` and logs all service
 * lifecycle events (online, exit, restart, stop, delete) to feed.log
 * in the standard SYSTEM event format.
 *
 * Runs as a standalone PM2 service defined in ecosystem.config.cjs.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { exec } from "child_process";

const FEED_LOG = join(homedir(), ".oracle", "feed.log");
const HOST = hostname();

// ─── Ensure feed dir exists ─────────────────────────────────────────

const feedDir = join(homedir(), ".oracle");
if (!existsSync(feedDir)) mkdirSync(feedDir, { recursive: true });

// ─── Timestamp (local time, GMT+7 per Golden Rule #9) ───────────────

function timestamp(): string {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0") +
    " " +
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0")
  );
}

// ─── Write SYSTEM event to feed.log ─────────────────────────────────

function writeSystemEvent(event: string) {
  const line = `${timestamp()} | SYSTEM | ${HOST} | Event | SYSTEM | ${event}\n`;
  try {
    appendFileSync(FEED_LOG, line);
  } catch (err) {
    console.error(`[maw-syslog] failed to write feed.log:`, err);
  }
}

function log(msg: string) {
  const ts = timestamp();
  console.log(`${ts} [maw-syslog] ${msg}`);
}

// ─── PM2 bus connection via CLI (no pm2 npm dep needed) ─────────────
// We use pm2's programmatic API by requiring it from the global install

async function getPm2Module(): Promise<any> {
  // Try to find pm2 from the global install
  const paths = [
    join(homedir(), ".bun/install/global/node_modules/pm2"),
    "/usr/lib/node_modules/pm2",
    "/usr/local/lib/node_modules/pm2",
  ];

  // Also try to resolve via which pm2
  try {
    const pm2Bin = require("child_process")
      .execSync("which pm2", { encoding: "utf-8" })
      .trim();
    // pm2 binary is usually at .../bin/pm2, module is at .../lib/node_modules/pm2
    // or directly at .../node_modules/pm2
    const binDir = join(pm2Bin, "..");
    paths.unshift(join(binDir, "..", "lib", "node_modules", "pm2"));
    paths.unshift(join(binDir, "..", "node_modules", "pm2"));
  } catch {}

  for (const p of paths) {
    try {
      if (existsSync(join(p, "index.js"))) {
        return require(p);
      }
    } catch {}
  }

  throw new Error("pm2 module not found — is pm2 installed globally?");
}

// ─── Track restart counts to detect storms ──────────────────────────

const restartCounts = new Map<string, number>();

function formatExitCode(code: number | null | undefined): string {
  if (code === null || code === undefined) return "signal";
  if (code === 0) return "clean";
  return `code ${code}`;
}

// ─── Main: connect to PM2 bus and listen ────────────────────────────

async function main() {
  log("starting — connecting to PM2 bus...");

  let pm2: any;
  try {
    pm2 = await getPm2Module();
  } catch (err: any) {
    // Fallback: use pm2's launchBus via CLI JSON-RPC
    log(`pm2 module not found, using polling fallback: ${err.message}`);
    startPollingFallback();
    return;
  }

  pm2.connect(false, (err: any) => {
    if (err) {
      log(`PM2 connect error: ${err.message} — falling back to polling`);
      startPollingFallback();
      return;
    }

    log("connected to PM2 daemon");

    pm2.launchBus((err: any, bus: any) => {
      if (err) {
        log(`PM2 launchBus error: ${err.message} — falling back to polling`);
        startPollingFallback();
        return;
      }

      log("PM2 bus connected — listening for events");
      writeSystemEvent("SYSTEM » syslog-start: maw-syslog connected to PM2 bus");

      // ── process:event — covers online, exit, restart, stop, delete ──

      bus.on("process:event", (data: any) => {
        const name = data?.process?.name || "unknown";
        const event = data?.event || "unknown";
        const pid = data?.process?.pid || 0;
        const exitCode = data?.process?.exit_code;
        const restarts = data?.process?.restart_time || 0;

        // Skip self-monitoring noise
        if (name === "maw-syslog") return;

        switch (event) {
          case "online":
            writeSystemEvent(
              `SYSTEM » service-online: ${name} — pid ${pid}`
            );
            log(`service-online: ${name} pid=${pid}`);
            restartCounts.set(name, restarts);
            break;

          case "exit": {
            const exitStr = formatExitCode(exitCode);
            const prevRestarts = restartCounts.get(name) || 0;
            const isRestart = restarts > prevRestarts;
            restartCounts.set(name, restarts);

            if (exitCode === 0) {
              writeSystemEvent(
                `SYSTEM » service-stop: ${name} — ${exitStr}`
              );
              log(`service-stop: ${name} exit=0`);
            } else {
              writeSystemEvent(
                `SYSTEM » service-crash: ${name} exited ${exitStr} — restart #${restarts}`
              );
              log(`service-crash: ${name} exit=${exitStr} restarts=${restarts}`);
            }
            break;
          }

          case "stop":
            writeSystemEvent(
              `SYSTEM » service-stop: ${name} — stopped by user`
            );
            log(`service-stop: ${name} (manual)`);
            break;

          case "delete":
            writeSystemEvent(
              `SYSTEM » service-delete: ${name} — removed from PM2`
            );
            log(`service-delete: ${name}`);
            break;

          case "restart":
            writeSystemEvent(
              `SYSTEM » service-restart: ${name} — restart #${restarts} pid ${pid}`
            );
            log(`service-restart: ${name} restarts=${restarts} pid=${pid}`);
            restartCounts.set(name, restarts);
            break;

          default:
            log(`unhandled event: ${event} for ${name}`);
        }
      });

      // ── log:err — capture stderr spikes ──

      bus.on("log:err", (data: any) => {
        const name = data?.process?.name || "unknown";
        if (name === "maw-syslog") return;

        // Only log the first line of errors to avoid flooding
        const firstLine = (data?.data || "")
          .split("\n")[0]
          .slice(0, 120);
        if (firstLine) {
          log(`stderr[${name}]: ${firstLine}`);
        }
      });
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    log("shutting down...");
    writeSystemEvent("SYSTEM » syslog-stop: maw-syslog disconnecting");
    pm2.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Polling fallback (if PM2 bus unavailable) ──────────────────────
// Uses `pm2 jlist` to detect state changes, similar to pm2-watcher.ts

function startPollingFallback() {
  log("polling mode: checking pm2 jlist every 10s");
  writeSystemEvent("SYSTEM » syslog-start: maw-syslog started (polling mode)");

  const states = new Map<string, { status: string; restarts: number; pid: number }>();
  let firstRun = true;

  const poll = () => {
    exec("pm2 jlist 2>/dev/null", { timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) return;

      let procs: any[];
      try {
        procs = JSON.parse(stdout);
      } catch {
        return;
      }

      for (const proc of procs) {
        const name = proc.name as string;
        if (name === "maw-syslog") continue;

        const status = proc.pm2_env?.status || "unknown";
        const restarts = proc.pm2_env?.restart_time || 0;
        const pid = proc.pid || 0;

        const prev = states.get(name);

        if (!prev) {
          states.set(name, { status, restarts, pid });
          if (!firstRun) {
            writeSystemEvent(`SYSTEM » service-online: ${name} — pid ${pid}`);
            log(`new service detected: ${name} status=${status}`);
          }
          continue;
        }

        // Status changed
        if (status !== prev.status) {
          if (status === "online" && prev.status !== "online") {
            writeSystemEvent(`SYSTEM » service-online: ${name} — pid ${pid}`);
            log(`service-online: ${name} pid=${pid}`);
          } else if (status === "errored") {
            writeSystemEvent(
              `SYSTEM » service-crash: ${name} errored — restart #${restarts}`
            );
            log(`service-crash: ${name} errored restarts=${restarts}`);
          } else if (status === "stopped") {
            writeSystemEvent(`SYSTEM » service-stop: ${name} — stopped`);
            log(`service-stop: ${name}`);
          }
        }

        // Restart count increased
        if (restarts > prev.restarts && status === "online") {
          const delta = restarts - prev.restarts;
          writeSystemEvent(
            `SYSTEM » service-restart: ${name} — restart #${restarts} (+${delta}) pid ${pid}`
          );
          log(`service-restart: ${name} restarts=${restarts} (+${delta})`);
        }

        states.set(name, { status, restarts, pid });
      }

      // Detect removed services
      for (const [name] of states) {
        if (!procs.find((p: any) => p.name === name)) {
          writeSystemEvent(`SYSTEM » service-delete: ${name} — removed from PM2`);
          log(`service-delete: ${name}`);
          states.delete(name);
        }
      }

      firstRun = false;
    });
  };

  // Initial poll after 2s, then every 10s
  setTimeout(poll, 2_000);
  setInterval(poll, 10_000);

  // Graceful shutdown
  const shutdown = () => {
    log("shutting down...");
    writeSystemEvent("SYSTEM » syslog-stop: maw-syslog disconnecting");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Start ──────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("[maw-syslog] fatal:", err);
  process.exit(1);
});
