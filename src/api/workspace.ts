/**
 * Workspace Hub API — multi-node workspace management.
 *
 * Runs on a public VPS alongside maw-js. Provides:
 *   - Workspace creation with join codes
 *   - Shared agent registry across nodes
 *   - Feed events and messaging (REST fallback)
 *
 * Auth: HMAC-SHA256 with workspace token (same pattern as federation-auth).
 * Storage: JSON files in ~/.config/maw/workspaces/
 */

import { Hono } from "hono";
import crypto from "crypto";
const { randomBytes, randomUUID, createHmac, timingSafeEqual } = crypto;
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../paths";

// --- Types ---

export interface WorkspaceAgent {
  name: string;
  nodeId: string;
  status?: string;
  capabilities?: string[];
  updatedAt: string;
}

export interface WorkspaceFeedEvent {
  id: string;
  nodeId: string;
  type: string;
  message: string;
  ts: number;
}

export interface WorkspaceNode {
  nodeId: string;
  joinedAt: string;
  lastSeen: string;
}

export interface Workspace {
  id: string;
  name: string;
  token: string;
  joinCode: string;
  joinCodeExpiresAt: number;
  createdAt: string;
  creatorNodeId: string;
  nodes: WorkspaceNode[];
  agents: WorkspaceAgent[];
  feed: WorkspaceFeedEvent[];
}

// --- Storage ---

export const WORKSPACE_DIR = join(CONFIG_DIR, "workspaces");
mkdirSync(WORKSPACE_DIR, { recursive: true });

/** In-memory cache, persisted to disk on mutation */
const workspaces = new Map<string, Workspace>();

/** Load all workspaces from disk into memory */
function loadAll() {
  if (workspaces.size > 0) return; // already loaded
  try {
    for (const file of readdirSync(WORKSPACE_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ws = JSON.parse(readFileSync(join(WORKSPACE_DIR, file), "utf-8")) as Workspace;
        workspaces.set(ws.id, ws);
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir doesn't exist yet */ }
}

function persist(ws: Workspace) {
  writeFileSync(join(WORKSPACE_DIR, `${ws.id}.json`), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

/** Find workspace by join code (linear scan — small N) */
function findByJoinCode(code: string): Workspace | undefined {
  for (const ws of workspaces.values()) {
    if (ws.joinCode === code && ws.joinCodeExpiresAt > Date.now()) return ws;
  }
  return undefined;
}

// --- ID / Token Generation ---

function generateWorkspaceId(): string {
  return `ws_${randomUUID().slice(0, 8)}`;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function generateJoinCode(): string {
  return randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();
}

// --- HMAC Auth (workspace-scoped) ---

const WINDOW_SEC = 300; // ±5 min

function wsSign(token: string, method: string, path: string, timestamp: number): string {
  return createHmac("sha256", token).update(`${method}:${path}:${timestamp}`).digest("hex");
}

function wsVerify(token: string, method: string, path: string, timestamp: number, signature: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WINDOW_SEC) return false;
  const expected = wsSign(token, method, path, timestamp);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Verify workspace HMAC from request headers. Returns workspace or null. */
function authenticateWorkspace(workspaceId: string, method: string, path: string, headers: { sig?: string; ts?: string }): Workspace | null {
  const ws = workspaces.get(workspaceId);
  if (!ws) return null;
  if (!headers.sig || !headers.ts) return null;
  const timestamp = parseInt(headers.ts, 10);
  if (isNaN(timestamp)) return null;
  if (!wsVerify(ws.token, method, path, timestamp, headers.sig)) return null;
  return ws;
}

/** Touch a node's lastSeen timestamp */
function touchNode(ws: Workspace, nodeId: string) {
  const node = ws.nodes.find(n => n.nodeId === nodeId);
  if (node) node.lastSeen = new Date().toISOString();
}

// --- Feed ---

const FEED_MAX = 200;

function pushFeed(ws: Workspace, event: Omit<WorkspaceFeedEvent, "id">) {
  const full: WorkspaceFeedEvent = { ...event, id: randomUUID().slice(0, 8) };
  ws.feed.push(full);
  if (ws.feed.length > FEED_MAX) ws.feed.splice(0, ws.feed.length - FEED_MAX);
}

// --- Router ---

export const workspaceApi = new Hono();

// Ensure workspaces are loaded on first request
workspaceApi.use("*", async (_c, next) => {
  loadAll();
  return next();
});

/**
 * POST /workspace/create
 * Body: { name, nodeId }
 * Returns: { id, token, joinCode, joinCodeExpiresAt }
 */
workspaceApi.post("/workspace/create", async (c) => {
  const body = await c.req.json<{ name?: string; nodeId?: string }>();
  if (!body.name || !body.nodeId) {
    return c.json({ error: "name and nodeId are required" }, 400);
  }

  const id = generateWorkspaceId();
  const token = generateToken();
  const joinCode = generateJoinCode();
  const now = new Date().toISOString();
  const joinCodeExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h

  const ws: Workspace = {
    id,
    name: body.name,
    token,
    joinCode,
    joinCodeExpiresAt,
    createdAt: now,
    creatorNodeId: body.nodeId,
    nodes: [{ nodeId: body.nodeId, joinedAt: now, lastSeen: now }],
    agents: [],
    feed: [],
  };

  workspaces.set(id, ws);
  persist(ws);

  pushFeed(ws, { nodeId: body.nodeId, type: "workspace.created", message: `Workspace "${body.name}" created`, ts: Date.now() });
  persist(ws);

  return c.json({ id, token, joinCode, joinCodeExpiresAt });
});

/**
 * POST /workspace/join
 * Body: { code, nodeId }
 * Returns: { workspaceId, token, name }
 */
workspaceApi.post("/workspace/join", async (c) => {
  const body = await c.req.json<{ code?: string; nodeId?: string }>();
  if (!body.code || !body.nodeId) {
    return c.json({ error: "code and nodeId are required" }, 400);
  }

  const ws = findByJoinCode(body.code.toUpperCase());
  if (!ws) {
    return c.json({ error: "invalid or expired join code" }, 404);
  }

  // Check if node already joined
  if (!ws.nodes.find(n => n.nodeId === body.nodeId)) {
    const now = new Date().toISOString();
    ws.nodes.push({ nodeId: body.nodeId, joinedAt: now, lastSeen: now });
    pushFeed(ws, { nodeId: body.nodeId, type: "node.joined", message: `Node "${body.nodeId}" joined`, ts: Date.now() });
  }

  persist(ws);

  return c.json({ workspaceId: ws.id, token: ws.token, name: ws.name });
});

// --- Authenticated /:id routes (HMAC required) ---

/** Middleware: verify workspace HMAC for all /:id routes */
workspaceApi.use("/workspace/:id/*", async (c, next) => {
  const workspaceId = c.req.param("id");
  const url = new URL(c.req.url);

  const ws = authenticateWorkspace(workspaceId, c.req.method, url.pathname, {
    sig: c.req.header("x-maw-signature"),
    ts: c.req.header("x-maw-timestamp"),
  });

  if (!ws) {
    return c.json({ error: "workspace auth failed" }, 401);
  }

  // Stash workspace on context for downstream handlers
  c.set("workspace" as never, ws as never);
  return next();
});

/**
 * POST /workspace/:id/agents
 * Body: { name, nodeId, status?, capabilities? }
 * Registers or updates an agent in the workspace.
 */
workspaceApi.post("/workspace/:id/agents", async (c) => {
  const ws = c.get("workspace" as never) as unknown as Workspace;
  const body = await c.req.json<{ name?: string; nodeId?: string; status?: string; capabilities?: string[] }>();

  if (!body.name || !body.nodeId) {
    return c.json({ error: "name and nodeId are required" }, 400);
  }

  const now = new Date().toISOString();
  const existing = ws.agents.find(a => a.name === body.name && a.nodeId === body.nodeId);

  if (existing) {
    existing.status = body.status || existing.status;
    existing.capabilities = body.capabilities || existing.capabilities;
    existing.updatedAt = now;
  } else {
    ws.agents.push({
      name: body.name,
      nodeId: body.nodeId,
      status: body.status || "registered",
      capabilities: body.capabilities || [],
      updatedAt: now,
    });
    pushFeed(ws, { nodeId: body.nodeId, type: "agent.registered", message: `Agent "${body.name}" registered from ${body.nodeId}`, ts: Date.now() });
  }

  touchNode(ws, body.nodeId);
  persist(ws);

  return c.json({ ok: true, agents: ws.agents.length });
});

/**
 * GET /workspace/:id/agents
 * Returns all agents in the workspace.
 */
workspaceApi.get("/workspace/:id/agents", (c) => {
  const ws = c.get("workspace" as never) as unknown as Workspace;
  return c.json({ agents: ws.agents, total: ws.agents.length });
});

/**
 * GET /workspace/:id/status
 * Returns workspace status: nodes, agent count, health.
 */
workspaceApi.get("/workspace/:id/status", (c) => {
  const ws = c.get("workspace" as never) as unknown as Workspace;

  const fiveMinAgo = Date.now() - 5 * 60_000;
  const healthyNodes = ws.nodes.filter(n => new Date(n.lastSeen).getTime() > fiveMinAgo);

  return c.json({
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    nodes: ws.nodes,
    nodeCount: ws.nodes.length,
    healthyNodeCount: healthyNodes.length,
    agentCount: ws.agents.length,
    feedCount: ws.feed.length,
  });
});

/**
 * GET /workspace/:id/feed
 * Returns recent feed events. Query: ?limit=50
 */
workspaceApi.get("/workspace/:id/feed", (c) => {
  const ws = c.get("workspace" as never) as unknown as Workspace;
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const events = ws.feed.slice(-limit).reverse();
  return c.json({ events, total: events.length });
});

/**
 * POST /workspace/:id/message
 * Body: { from, to?, text }
 * REST fallback for messaging. Appended to feed as message event.
 */
workspaceApi.post("/workspace/:id/message", async (c) => {
  const ws = c.get("workspace" as never) as unknown as Workspace;
  const body = await c.req.json<{ from?: string; to?: string; text?: string }>();

  if (!body.from || !body.text) {
    return c.json({ error: "from and text are required" }, 400);
  }

  const target = body.to ? ` → ${body.to}` : "";
  pushFeed(ws, {
    nodeId: body.from,
    type: "message",
    message: `[${body.from}${target}] ${body.text}`,
    ts: Date.now(),
  });

  persist(ws);

  return c.json({ ok: true });
});
