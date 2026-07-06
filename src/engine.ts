import { tmux } from "./tmux";
import { isAgentPane } from "./lib/pane";
import { unsubscribeAll } from "./engine/transcript-watcher";

async function capture(target: string, lines?: number) { return (await import("./ssh")).capture(target, lines); }
import { registerBuiltinHandlers } from "./handlers";
import type { FeedTailer } from "./feed-tail";
import type { MawWS, Handler } from "./types";
import { statSync, readFileSync, appendFileSync } from "fs";
import { MAW_LOG_PATH, type LogEntry } from "./maw-log";
import {
  type OracleHealth, type CommAlert, type HealthSummary, type PendingMessage,
  ORACLE_SESSIONS, EXPECTED_ORACLES, RESTART_COOLDOWN_MS,
  oracleToSession, alertId, getTier, isTrackableSender,
} from "./oracle-health";
import { join } from "path";
import { homedir } from "os";

const HEALTH_LOG_PATH = join(homedir(), ".oracle", "oracle-health.log");

/** Feed log uses title-case oracle names — map from our lowercase keys */
const FEED_ORACLE_NAMES: Record<string, string> = {
  bob: "BoB-Oracle", dev: "Dev-Oracle", qa: "QA-Oracle",
  researcher: "Researcher-Oracle", writer: "Writer-Oracle",
  designer: "Designer-Oracle", hr: "HR-Oracle", aia: "AIA-Oracle",
  data: "Data-Oracle", admin: "Admin-Oracle", botdev: "BotDev-Oracle",
  creator: "Creator-Oracle", doc: "DocCon-Oracle", editor: "Editor-Oracle",
  security: "Security-Oracle", fe: "FE-Oracle", pa: "PA-Oracle",
  recruiter: "Recruiter-Oracle",
};

export class MawEngine {
  private clients = new Set<MawWS>();
  private handlers = new Map<string, Handler>();
  private lastContent = new Map<MawWS, string>();
  private lastPreviews = new Map<MawWS, Map<string, string>>();
  private lastSessionsJson = "";
  private cachedSessions: { name: string; windows: { index: number; name: string; active: boolean }[] }[] = [];
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private sessionInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private feedUnsub: (() => void) | null = null;
  private feedTailer: FeedTailer;
  private mawLogInterval: ReturnType<typeof setInterval> | null = null;
  private mawLogOffset = 0;

  // --- Oracle Health State ---
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastRestartAttempt = new Map<string, number>();
  private restartLog: Array<{ oracle: string; ts: string; success: boolean }> = [];
  private pendingMessages = new Map<string, PendingMessage>();
  private commAlerts: CommAlert[] = [];
  private lastHealthSummary: HealthSummary | null = null;

  constructor({ feedTailer }: { feedTailer: FeedTailer }) {
    this.feedTailer = feedTailer;
    registerBuiltinHandlers(this);
  }

  /** Register a WebSocket message handler */
  on(type: string, handler: Handler) {
    this.handlers.set(type, handler);
  }

  // --- WebSocket lifecycle ---

  handleOpen(ws: MawWS) {
    this.clients.add(ws);
    this.startIntervals();
    if (this.cachedSessions.length > 0) {
      ws.send(JSON.stringify({ type: "sessions", sessions: this.cachedSessions }));
      this.sendBusyAgents(ws);
    } else {
      // Cold start: fetch and send directly to this client
      tmux.listAll().then(all => {
        const sessions = all.filter(s => !s.name.startsWith("maw-pty-"));
        this.cachedSessions = sessions;
        ws.send(JSON.stringify({ type: "sessions", sessions }));
        this.sendBusyAgents(ws);
      }).catch(() => {});
    }
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedTailer.getRecent(50) }));
  }

  /** Scan panes for busy agents and send `recent` message to client. */
  private async sendBusyAgents(ws: MawWS) {
    const allTargets = this.cachedSessions.flatMap(s =>
      s.windows.map(w => `${s.name}:${w.index}`)
    );
    const cmds = await tmux.getPaneCommands(allTargets);
    const busy = allTargets
      .filter(t => isAgentPane(cmds[t] || ""))
      .map(t => {
        const [session] = t.split(":");
        const s = this.cachedSessions.find(x => x.name === session);
        const w = s?.windows.find(w => `${s.name}:${w.index}` === t);
        return { target: t, name: w?.name || t, session };
      });
    if (busy.length > 0) {
      ws.send(JSON.stringify({ type: "recent", agents: busy }));
    }
  }

  handleMessage(ws: MawWS, msg: string | Buffer) {
    try {
      const data = JSON.parse(msg as string);
      const handler = this.handlers.get(data.type);
      if (handler) handler(ws, data, this);
    } catch {}
  }

  handleClose(ws: MawWS) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
    // T026: clean up transcript watchers
    try { unsubscribeAll(ws); } catch {}
  }

  // --- Push mechanics (public — handlers use these) ---

  async pushCapture(ws: MawWS) {
    if (!ws.data.target) return;
    try {
      const content = await capture(ws.data.target, 1000);
      const prev = this.lastContent.get(ws);
      if (content !== prev) {
        this.lastContent.set(ws, content);
        ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  }

  async pushPreviews(ws: MawWS) {
    const targets = ws.data.previewTargets;
    if (!targets || targets.size === 0) return;
    const prevMap = this.lastPreviews.get(ws) || new Map<string, string>();
    const changed: Record<string, string> = {};
    let hasChanges = false;

    await Promise.allSettled([...targets].map(async (target) => {
      try {
        const content = await capture(target, 3);
        const prev = prevMap.get(target);
        if (content !== prev) {
          prevMap.set(target, content);
          changed[target] = content;
          hasChanges = true;
        }
      } catch {}
    }));

    this.lastPreviews.set(ws, prevMap);
    if (hasChanges) {
      ws.send(JSON.stringify({ type: "previews", data: changed }));
    }
  }

  /** Broadcast a message to all connected clients */
  broadcast(msg: string) {
    for (const ws of this.clients) ws.send(msg);
  }

  // --- Broadcast ---

  private async broadcastSessions() {
    if (this.clients.size === 0) return;
    try {
      const all = await tmux.listAll();
      // Filter out internal PTY sessions from dashboard view
      const sessions = all.filter(s => !s.name.startsWith("maw-pty-"));
      this.cachedSessions = sessions;
      const json = JSON.stringify(sessions);

      if (json === this.lastSessionsJson) return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ type: "sessions", sessions });
      for (const ws of this.clients) ws.send(msg);
    } catch {}
  }

  // --- Oracle Health ---

  /** Get the latest health summary (for API endpoint) */
  getHealthSummary(): HealthSummary | null {
    return this.lastHealthSummary;
  }

  /** Check oracle session liveness + auto-restart dead sessions */
  private checkOracleHealth() {
    const liveSessions = new Set(this.cachedSessions.map(s => s.name));
    const now = Date.now();
    const activeMap = this.feedTailer.getActive(5 * 60_000); // 5 min window

    const oracles: OracleHealth[] = [];
    let liveCount = 0;
    let deadCount = 0;

    for (const oracle of EXPECTED_ORACLES) {
      const sessionName = oracleToSession(oracle);
      const isLive = liveSessions.has(sessionName);
      // Feed uses "Dev-Oracle"/"BoB-Oracle" format — try multiple patterns
      const lastEvent = activeMap.get(oracle.charAt(0).toUpperCase() + oracle.slice(1) + "-Oracle")
        || activeMap.get(oracle.toUpperCase().slice(0,1) + oracle.slice(1) + "-Oracle")
        || activeMap.get(FEED_ORACLE_NAMES[oracle] || "")
        || activeMap.get(oracle);
      const lastSeen = lastEvent ? new Date(lastEvent.ts).toISOString() : "";

      // Count pending messages for this oracle
      let pendingCount = 0;
      for (const [, pm] of this.pendingMessages) {
        if (pm.to === oracle && !pm.responded) pendingCount++;
      }

      // Determine status
      let status: "alive" | "idle" | "dead";
      if (isLive && lastEvent && (now - lastEvent.ts < 5 * 60_000)) {
        status = "alive";
        liveCount++;
      } else if (isLive) {
        status = "idle";
        liveCount++;
      } else {
        status = "dead";
        deadCount++;

        // Auto-restart dead sessions with cooldown
        const lastAttempt = this.lastRestartAttempt.get(oracle) || 0;
        if (now - lastAttempt >= RESTART_COOLDOWN_MS) {
          this.lastRestartAttempt.set(oracle, now);
          const alert: CommAlert = {
            id: alertId("dead-session", oracle),
            type: "dead-session", oracle, waitingMin: 0, tier: 2,
            ts: new Date().toISOString(), action: "restarting",
          };
          this.emitAlert(alert);
          this.appendHealthLog(`auto-restart triggered: ${oracle}`);

          // Attempt restart via maw wake
          try {
            Bun.spawn(["maw", "wake", oracle]);
            this.restartLog.push({ oracle, ts: new Date().toISOString(), success: true });
          } catch {
            this.restartLog.push({ oracle, ts: new Date().toISOString(), success: false });
          }
        }
      }

      oracles.push({
        name: oracle, status, sessionName, lastSeen,
        pendingMessages: pendingCount,
        avgResponseMin: 0,  // TODO: compute from historical data
        responseRate: 0,     // TODO: compute from historical data
      });
    }

    // Build and broadcast health summary
    const totalPending = [...this.pendingMessages.values()].filter(m => !m.responded).length;
    const summary: HealthSummary = {
      timestamp: new Date().toISOString(),
      responseRate: totalPending === 0 ? 100 : Math.round(
        ([...this.pendingMessages.values()].filter(m => m.responded).length /
          Math.max(this.pendingMessages.size, 1)) * 100
      ),
      liveCount, deadCount,
      totalOracles: EXPECTED_ORACLES.size,
      oracles,
      alerts: [...this.commAlerts],
      restartLog: this.restartLog.slice(-20), // keep last 20
    };

    this.lastHealthSummary = summary;
    this.broadcast(JSON.stringify({ type: "oracle-health", health: summary }));
  }

  /** Track pending messages from new maw-log entries */
  private trackPendingMessages(entries: LogEntry[]) {
    const now = Date.now();

    for (const entry of entries) {
      if (entry.ch === "heartbeat") continue;
      const from = entry.from || "";
      const to = entry.to || "";

      // Track new messages TO oracles
      if (EXPECTED_ORACLES.has(to) && isTrackableSender(from)) {
        const key = `${entry.ts}:${to}`;
        if (!this.pendingMessages.has(key)) {
          this.pendingMessages.set(key, {
            id: key, from, to, ts: now,
            msg: (entry.msg || "").slice(0, 100),
            responded: false, alertedTier: 0,
          });
        }
      }

      // Detect responses: message FROM an oracle that has pending messages
      if (EXPECTED_ORACLES.has(from)) {
        for (const [key, pm] of this.pendingMessages) {
          if (pm.to === from && !pm.responded) {
            pm.responded = true;
          }
        }
      }
    }

    // Check thresholds and emit alerts for unresponded messages
    for (const [key, pm] of this.pendingMessages) {
      if (pm.responded) continue;

      const waitingMin = (now - pm.ts) / 60_000;
      const tier = getTier(waitingMin);

      if (tier > 0 && tier > pm.alertedTier) {
        pm.alertedTier = tier;
        const alert: CommAlert = {
          id: alertId("no-response", pm.to, pm.from),
          type: "no-response", oracle: pm.to, from: pm.from,
          waitingMin: Math.round(waitingMin), tier: tier as 1 | 2 | 3,
          ts: new Date().toISOString(),
        };
        this.emitAlert(alert);
      }

      // Clean up old entries (>24h)
      if (waitingMin > 24 * 60) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /** Emit a comm-alert to all clients and store it */
  private emitAlert(alert: CommAlert) {
    // Replace existing alert with same ID
    this.commAlerts = this.commAlerts.filter(a => a.id !== alert.id);
    this.commAlerts.push(alert);
    // Keep only last 50 alerts
    if (this.commAlerts.length > 50) this.commAlerts = this.commAlerts.slice(-50);

    this.broadcast(JSON.stringify({ type: "comm-alert", alert }));
  }

  /** Append to health log file */
  private appendHealthLog(message: string) {
    try {
      const line = `${new Date().toISOString()} | ${message}\n`;
      appendFileSync(HEALTH_LOG_PATH, line);
    } catch {}
  }

  // --- Interval lifecycle ---

  private startIntervals() {
    if (this.captureInterval) return;
    this.captureInterval = setInterval(() => {
      for (const ws of this.clients) this.pushCapture(ws);
    }, 1000);
    this.sessionInterval = setInterval(() => this.broadcastSessions(), 5000);
    this.previewInterval = setInterval(() => {
      for (const ws of this.clients) this.pushPreviews(ws);
    }, 2000);
    this.feedTailer.start();
    this.feedUnsub = this.feedTailer.onEvent((event) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients) ws.send(msg);
    });

    // Watch maw-log for new entries → broadcast to clients + track pending messages
    try { this.mawLogOffset = statSync(MAW_LOG_PATH).size; } catch { this.mawLogOffset = 0; }
    this.mawLogInterval = setInterval(() => this.checkMawLog(), 2000);

    // Oracle health check every 30 seconds
    this.healthInterval = setInterval(() => this.checkOracleHealth(), 30_000);
  }

  private checkMawLog() {
    try {
      const size = statSync(MAW_LOG_PATH).size;
      if (size <= this.mawLogOffset) return;
      // Read new bytes
      const buf = Buffer.alloc(size - this.mawLogOffset);
      const fd = require("fs").openSync(MAW_LOG_PATH, "r");
      require("fs").readSync(fd, buf, 0, buf.length, this.mawLogOffset);
      require("fs").closeSync(fd);
      this.mawLogOffset = size;

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      const entries: LogEntry[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch {}
      }
      if (entries.length > 0) {
        // Broadcast to clients
        if (this.clients.size > 0) {
          const msg = JSON.stringify({ type: "maw-log", entries });
          for (const ws of this.clients) ws.send(msg);
        }
        // Track pending messages
        this.trackPendingMessages(entries);
      }
    } catch {}
  }

  private stopIntervals() {
    if (this.clients.size > 0) return;
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    if (this.sessionInterval) { clearInterval(this.sessionInterval); this.sessionInterval = null; }
    if (this.previewInterval) { clearInterval(this.previewInterval); this.previewInterval = null; }
    if (this.mawLogInterval) { clearInterval(this.mawLogInterval); this.mawLogInterval = null; }
    if (this.healthInterval) { clearInterval(this.healthInterval); this.healthInterval = null; }
    if (this.feedUnsub) { this.feedUnsub(); this.feedUnsub = null; }
    this.feedTailer.stop();
  }
}
