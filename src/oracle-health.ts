/**
 * Oracle Health Monitoring — Types & Utilities
 *
 * Tracks oracle session liveness, pending messages, and response metrics.
 * Used by engine.ts (checkOracleHealth) and server.ts (/api/oracle-health).
 */

// --- Types ---

export interface OracleHealth {
  name: string;
  status: "alive" | "idle" | "dead";
  sessionName: string;
  lastSeen: string;           // ISO timestamp of last feed event
  pendingMessages: number;    // unanswered inbound messages
  avgResponseMin: number;     // rolling average response time
  responseRate: number;       // 0-100
}

export interface CommAlert {
  id: string;
  type: "no-response" | "dead-session" | "auto-restart";
  oracle: string;
  from?: string;
  waitingMin: number;
  tier: 1 | 2 | 3;
  ts: string;
  action?: "restarting" | "restarted" | "restart-failed";
}

export interface HealthSummary {
  timestamp: string;
  responseRate: number;       // overall 0-100
  liveCount: number;
  deadCount: number;
  totalOracles: number;
  oracles: OracleHealth[];
  alerts: CommAlert[];
  restartLog: Array<{ oracle: string; ts: string; success: boolean }>;
}

export interface PendingMessage {
  id: string;
  from: string;
  to: string;
  ts: number;
  msg: string;
  responded: boolean;
  alertedTier: number;  // highest tier alert sent for this message
}

// --- Constants ---

/** Oracle name → tmux session prefix mapping */
export const ORACLE_SESSIONS: Record<string, string> = {
  bob: "01-bob", dev: "02-dev", qa: "03-qa", researcher: "04-researcher",
  writer: "05-writer", designer: "06-designer", hr: "07-hr", aia: "08-aia",
  data: "09-data", admin: "10-admin", botdev: "11-botdev", creator: "12-creator",
  doc: "13-doc", editor: "14-editor", security: "15-security", fe: "16-fe", pa: "17-pa",
  fa: "18-fa", cost: "19-cost", 
  pulse: "23-pulse", recruiter: "24-recruiter", 
};

/** All expected oracle names */
export const EXPECTED_ORACLES = new Set(Object.keys(ORACLE_SESSIONS));

/** Non-oracle senders to ignore in pending message tracking */
const IGNORE_SENDERS = new Set(["cli", "nat", "human", ""]);

/** Tier thresholds in minutes */
export const TIER_THRESHOLDS = { 1: 15, 2: 30, 3: 120 } as const;

/** Cooldown between auto-restart attempts per oracle (ms) */
export const RESTART_COOLDOWN_MS = 300_000; // 5 min

// --- Utilities ---

export function oracleToSession(oracle: string): string {
  return ORACLE_SESSIONS[oracle] || oracle;
}

/** Generate a unique alert ID */
export function alertId(type: string, oracle: string, from?: string): string {
  return `${type}:${oracle}:${from || ""}`;
}

/** Determine tier from waiting minutes */
export function getTier(waitingMin: number): 0 | 1 | 2 | 3 {
  if (waitingMin >= TIER_THRESHOLDS[3]) return 3;
  if (waitingMin >= TIER_THRESHOLDS[2]) return 2;
  if (waitingMin >= TIER_THRESHOLDS[1]) return 1;
  return 0;
}

/** Check if a sender should be tracked for pending messages */
export function isTrackableSender(from: string): boolean {
  if (IGNORE_SENDERS.has(from)) return false;
  // Only track oracle-to-oracle messages
  return EXPECTED_ORACLES.has(from) || from.endsWith("-oracle") || from === "nat";
}

/** Check if a message looks like a response/acknowledgment */
export function looksLikeResponse(msg: string, originalFrom: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes(`→ ${originalFrom}`) ||
    lower.includes(`to ${originalFrom}`) ||
    lower.startsWith(`${originalFrom}`) ||
    lower.includes("รับทราบ") ||
    lower.includes("เสร็จแล้ว") ||
    lower.includes("done") ||
    lower.includes("✅");
}
