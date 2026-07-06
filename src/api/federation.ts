import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { getFederationStatus } from "../peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../snapshot";
import { hostedAgents } from "../commands/federation-sync";
import { requireHmac } from "../lib/federation-auth";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FLEET_DIR } from "../paths";

// --- Federation Thread Access ---

const ORACLE_DATA_DIR = process.env.ORACLE_DATA_DIR || join(homedir(), ".oracle");
const ALLOW_LIST_PATH = join(ORACLE_DATA_DIR, "federation-threads.json");

function loadAllowedThreads(): number[] {
  try {
    const data = JSON.parse(readFileSync(ALLOW_LIST_PATH, "utf-8"));
    return Array.isArray(data.allowed) ? data.allowed : [];
  } catch {
    return [];
  }
}

function isThreadAllowed(threadId: number): boolean {
  return loadAllowedThreads().includes(threadId);
}

function getOracleDb(): Database {
  const dbPath = join(ORACLE_DATA_DIR, "oracle.db");
  return new Database(dbPath, { readonly: false });
}

// Re-export so existing importers (and any future code) can still reach
// hostedAgents via the API module. The canonical home is federation-sync.ts.
export { hostedAgents };

export const federationApi = new Hono();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
// See docs/federation.md before changing fields.
federationApi.get("/federation/status", async (c) => {
  const status = await getFederationStatus();
  return c.json(status);
});

/** Snapshots API — list and view fleet time machine snapshots */
federationApi.get("/snapshots", (c) => {
  return c.json(listSnapshots());
});

federationApi.get("/snapshots/:id", (c) => {
  const snap = loadSnapshot(c.req.param("id"));
  if (!snap) return c.json({ error: "snapshot not found" }, 404);
  return c.json(snap);
});

/** Node identity — public endpoint for federation dedup (#192). */
federationApi.get("/identity", async (c) => {
  const config = loadConfig();
  const node = config.node ?? "local";
  const agents = hostedAgents(config.agents || {}, node);
  const pkg = require("../../package.json");
  return c.json({
    node,
    version: pkg.version,
    agents,
    uptime: Math.floor(process.uptime()),
  });
});

/** Message log — query maw-log.jsonl for federation link data */
federationApi.get("/messages", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 1000);
  const logFile = join(homedir(), ".oracle", "maw-log.jsonl");
  try {
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    interface MawMessage { ts: string; from: string; to: string; msg: string; host?: string; route?: string }
    let messages: MawMessage[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (from) messages = messages.filter(m => m.from?.includes(from));
    if (to) messages = messages.filter(m => m.to?.includes(to));
    return c.json({ messages: messages.slice(-limit), total: messages.length });
  } catch {
    return c.json({ messages: [], total: 0 });
  }
});

/** Fleet configs — serve fleet/*.json with lineage data */
federationApi.get("/fleet", (c) => {
  try {
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => {
      try { return { file: f, ...JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8")) }; } catch { return null; }
    }).filter(Boolean);
    return c.json({ fleet: configs });
  } catch {
    return c.json({ fleet: [] });
  }
});

/** Auth status — public diagnostic endpoint (never reveals the token) */
federationApi.get("/auth/status", (c) => {
  const config = loadConfig();
  const token = config.federationToken;
  return c.json({
    enabled: !!token,
    tokenConfigured: !!token,
    tokenPreview: token ? token.slice(0, 4) + "****" : null,
    method: token ? "HMAC-SHA256" : "none",
    clockUtc: new Date().toISOString(),
    node: config.node ?? "local",
  });
});

// --- Federation Thread Endpoints (HMAC-protected) ---

/** List all federation-visible threads */
federationApi.get("/federation/threads", requireHmac(), (c) => {
  const allowed = loadAllowedThreads();
  if (allowed.length === 0) return c.json({ threads: [] });

  const db = getOracleDb();
  try {
    const placeholders = allowed.map(() => "?").join(",");
    const threads = db.query(
      `SELECT id, title, created_by, status, project, created_at, updated_at
       FROM forum_threads WHERE id IN (${placeholders})
       ORDER BY updated_at DESC`
    ).all(...allowed);
    return c.json({ threads });
  } finally {
    db.close();
  }
});

/** Read a single federation thread + its messages */
federationApi.get("/federation/thread/:id", requireHmac(), (c) => {
  const threadId = parseInt(c.req.param("id"), 10);
  if (isNaN(threadId)) return c.json({ error: "invalid thread id" }, 400);
  if (!isThreadAllowed(threadId)) return c.json({ error: "thread not in federation allow-list" }, 403);

  const db = getOracleDb();
  try {
    const thread = db.query(
      `SELECT id, title, created_by, status, project, created_at, updated_at
       FROM forum_threads WHERE id = ?`
    ).get(threadId);
    if (!thread) return c.json({ error: "thread not found" }, 404);

    const messages = db.query(
      `SELECT id, thread_id, role, content, author, created_at
       FROM forum_messages WHERE thread_id = ? ORDER BY created_at ASC`
    ).all(threadId);

    return c.json({ thread, messages });
  } finally {
    db.close();
  }
});

/** Post a message to a federation thread */
federationApi.post("/federation/thread/:id", requireHmac(), async (c) => {
  const threadId = parseInt(c.req.param("id"), 10);
  if (isNaN(threadId)) return c.json({ error: "invalid thread id" }, 400);
  if (!isThreadAllowed(threadId)) return c.json({ error: "thread not in federation allow-list" }, 403);

  const body = await c.req.json();
  const content = body.content;
  const author = body.author || c.req.header("x-maw-author") || "federation";
  if (!content || typeof content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const db = getOracleDb();
  try {
    // Verify thread exists
    const thread = db.query("SELECT id FROM forum_threads WHERE id = ?").get(threadId);
    if (!thread) return c.json({ error: "thread not found" }, 404);

    const now = Date.now();
    const result = db.query(
      `INSERT INTO forum_messages (thread_id, role, content, author, created_at)
       VALUES (?, 'claude', ?, ?, ?)`
    ).run(threadId, content, author, now);

    // Touch thread updated_at
    db.query("UPDATE forum_threads SET updated_at = ? WHERE id = ?").run(now, threadId);

    return c.json({
      ok: true,
      message: {
        id: result.lastInsertRowid,
        thread_id: threadId,
        role: "claude",
        content,
        author,
        created_at: now,
      },
    }, 201);
  } finally {
    db.close();
  }
});
