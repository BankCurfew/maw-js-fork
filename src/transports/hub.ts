/**
 * Hub transport — WebSocket client connecting private nodes to a workspace hub.
 *
 * Private nodes use this to:
 *   - Register shared agents with the hub
 *   - Send/receive messages routed through the hub
 *   - Forward feed events and presence updates
 *   - Receive messages destined for local agents
 *
 * Config loaded from ~/.config/maw/workspaces/*.json:
 *   { id, hubUrl, token, sharedAgents }
 *
 * Opens one WebSocket per workspace. Reconnects automatically on disconnect.
 *
 * Protocol (Node → Hub):
 *   { type: "auth", token: "wst_...", nodeId: "white", sig, ts }
 *   { type: "heartbeat", timestamp }
 *   { type: "presence", agents: [{name, status}...] }
 *   { type: "feed", event: {...FeedEvent} }
 *   { type: "message", to: "mba:homekeeper", body, from: "white:neo" }
 *
 * Protocol (Hub → Node):
 *   { type: "auth-ok", workspaceId, agents: [...] }
 *   { type: "message", from, to, body }
 *   { type: "presence", agents: [...] }
 *   { type: "node-joined", nodeId }
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../transport";
import type { FeedEvent } from "../lib/feed";
import { sign } from "../lib/federation-auth";
import { CONFIG_DIR } from "../paths";
import { loadConfig } from "../config";

// Bun provides WebSocket as a global (browser-standard API)

const WORKSPACES_DIR = join(CONFIG_DIR, "workspaces");
const HEARTBEAT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Workspace config from ~/.config/maw/workspaces/*.json */
export interface WorkspaceConfig {
  id: string;
  hubUrl: string;        // "wss://hub.example.com" or "ws://vps:3456"
  token: string;
  sharedAgents: string[];
}

/** Live connection to a single workspace hub */
interface HubConnection {
  config: WorkspaceConfig;
  ws: WebSocket | null;
  connected: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Remote agents visible through this workspace (from auth-ok + presence) */
  remoteAgents: Set<string>;
}

export class HubTransport implements Transport {
  readonly name = "workspace-hub";
  readonly priority = 30;  // between MQTT (20) and HTTP (40)
  private _connected = false;
  private connections: Map<string, HubConnection> = new Map();
  private nodeId: string;
  private federationToken: string | undefined;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(nodeId?: string) {
    const config = loadConfig();
    this.nodeId = nodeId ?? config.node ?? "local";
    this.federationToken = config.federationToken;
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    const workspaces = loadWorkspaceConfigs();
    if (workspaces.length === 0) {
      console.log("[hub] no workspace configs found");
      return;
    }

    console.log(`[hub] connecting to ${workspaces.length} workspace(s)...`);

    const results = await Promise.allSettled(
      workspaces.map((ws) => this.connectWorkspace(ws)),
    );

    // Connected if at least one workspace succeeded
    const anyConnected = results.some(
      (r) => r.status === "fulfilled" && r.value === true,
    );
    this._connected = anyConnected;
  }

  async disconnect(): Promise<void> {
    for (const conn of this.connections.values()) {
      this.cleanupConnection(conn);
    }
    this.connections.clear();
    this._connected = false;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    const qualifiedTarget = target.host
      ? `${target.host}:${target.oracle}`
      : target.oracle;

    // Find a workspace that can reach this target
    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;

      // Check if this workspace knows about the target agent
      if (conn.remoteAgents.has(target.oracle) || conn.remoteAgents.has(qualifiedTarget)) {
        const payload = JSON.stringify({
          type: "message",
          to: qualifiedTarget,
          body: message,
          from: `${this.nodeId}:${target.oracle}`,
          timestamp: Date.now(),
        });

        try {
          conn.ws.send(payload);
          return true;
        } catch (err) {
          console.warn(`[hub] send failed on workspace ${conn.config.id}:`, err);
        }
      }
    }

    return false;
  }

  async publishPresence(presence: TransportPresence): Promise<void> {
    const payload = JSON.stringify({
      type: "presence",
      agents: [{ name: presence.oracle, status: presence.status }],
      timestamp: presence.timestamp,
    });

    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;
      try {
        conn.ws.send(payload);
      } catch {
        // Best effort — don't break on single workspace failure
      }
    }
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    const payload = JSON.stringify({
      type: "feed",
      event,
    });

    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;
      try {
        conn.ws.send(payload);
      } catch {
        // Best effort
      }
    }
  }

  onMessage(handler: (msg: TransportMessage) => void) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  /** Can reach any agent visible in any joined workspace */
  canReach(target: TransportTarget): boolean {
    if (!this._connected) return false;
    const qualifiedTarget = target.host
      ? `${target.host}:${target.oracle}`
      : target.oracle;

    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      if (conn.remoteAgents.has(target.oracle) || conn.remoteAgents.has(qualifiedTarget)) {
        return true;
      }
    }
    return false;
  }

  /** Get status of all workspace connections */
  workspaceStatus(): { id: string; connected: boolean; remoteAgents: string[] }[] {
    return Array.from(this.connections.values()).map((conn) => ({
      id: conn.config.id,
      connected: conn.connected,
      remoteAgents: Array.from(conn.remoteAgents),
    }));
  }

  // --- Private ---

  private async connectWorkspace(config: WorkspaceConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const conn: HubConnection = {
        config,
        ws: null,
        connected: false,
        heartbeatTimer: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        remoteAgents: new Set(),
      };

      this.connections.set(config.id, conn);
      const timeout = setTimeout(() => {
        if (!conn.connected) {
          console.warn(`[hub] workspace ${config.id}: connection timeout`);
          resolve(false);
        }
      }, 10_000);

      this.openWebSocket(conn, () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  private openWebSocket(conn: HubConnection, onFirstConnect?: () => void) {
    try {
      const ws = new WebSocket(conn.config.hubUrl);
      conn.ws = ws;

      ws.addEventListener("open", () => {
        console.log(`[hub] workspace ${conn.config.id}: connected to ${conn.config.hubUrl}`);
        conn.connected = true;
        conn.reconnectAttempt = 0;
        this._connected = true;

        // Authenticate
        this.sendAuth(conn);

        // Start heartbeat
        this.startHeartbeat(conn);

        onFirstConnect?.();
      });

      ws.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        this.handleMessage(conn, data);
      });

      ws.addEventListener("close", (event) => {
        console.log(`[hub] workspace ${conn.config.id}: disconnected (code=${event.code}, reason=${event.reason})`);
        conn.connected = false;
        this.stopHeartbeat(conn);
        this.updateConnectedState();
        this.scheduleReconnect(conn);
      });

      ws.addEventListener("error", (event) => {
        console.error(`[hub] workspace ${conn.config.id}: error:`, (event as any).message || "connection error");
        // close event will fire after error — reconnect handled there
      });
    } catch (err) {
      console.error(`[hub] workspace ${conn.config.id}: failed to create WebSocket:`, err);
      this.scheduleReconnect(conn);
    }
  }

  private sendAuth(conn: HubConnection) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN /* 1 */) return;

    const ts = Math.floor(Date.now() / 1000);
    const authPayload: Record<string, any> = {
      type: "auth",
      token: conn.config.token,
      nodeId: this.nodeId,
      sharedAgents: conn.config.sharedAgents,
      timestamp: ts,
    };

    // Sign with federation token if available (HMAC auth)
    if (this.federationToken) {
      authPayload._ts = ts;
      const signed = sign("WS", `auth:${conn.config.id}`, this.federationToken);
      authPayload._sig = signed.signature;
    }

    conn.ws.send(JSON.stringify(authPayload));
  }

  private handleMessage(conn: HubConnection, raw: string) {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case "auth-ok":
          console.log(`[hub] workspace ${conn.config.id}: authenticated (workspace=${msg.workspaceId})`);
          // Update remote agent registry
          if (Array.isArray(msg.agents)) {
            conn.remoteAgents = new Set(msg.agents);
          }
          break;

        case "message":
          this.handleIncomingMessage(conn, msg);
          break;

        case "presence":
          this.handleIncomingPresence(conn, msg);
          break;

        case "node-joined":
          console.log(`[hub] workspace ${conn.config.id}: node joined — ${msg.nodeId}`);
          break;

        case "node-left":
          console.log(`[hub] workspace ${conn.config.id}: node left — ${msg.nodeId}`);
          // Remove agents from that node
          if (msg.agents && Array.isArray(msg.agents)) {
            for (const agent of msg.agents) {
              conn.remoteAgents.delete(agent);
            }
          }
          break;

        case "feed":
          if (msg.event) {
            for (const h of this.feedHandlers) h(msg.event);
          }
          break;

        case "error":
          console.error(`[hub] workspace ${conn.config.id}: hub error — ${msg.message || msg.reason}`);
          break;

        default:
          // Unknown message type — ignore gracefully
          break;
      }
    } catch {
      // Malformed JSON — ignore
    }
  }

  private handleIncomingMessage(conn: HubConnection, msg: any) {
    const transportMsg: TransportMessage = {
      from: msg.from || "unknown",
      to: msg.to || "unknown",
      body: msg.body || "",
      timestamp: msg.timestamp || Date.now(),
      transport: "hub",
    };
    for (const h of this.msgHandlers) h(transportMsg);
  }

  private handleIncomingPresence(conn: HubConnection, msg: any) {
    if (!Array.isArray(msg.agents)) return;

    for (const agent of msg.agents) {
      // Update remote agent registry
      if (agent.name) {
        conn.remoteAgents.add(agent.name);
      }

      // Emit presence event
      const presence: TransportPresence = {
        oracle: agent.name || "unknown",
        host: agent.host || agent.nodeId || "remote",
        status: agent.status || "ready",
        timestamp: msg.timestamp || Date.now(),
      };
      for (const h of this.presenceHandlers) h(presence);
    }
  }

  private startHeartbeat(conn: HubConnection) {
    this.stopHeartbeat(conn);
    conn.heartbeatTimer = setInterval(() => {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({
          type: "heartbeat",
          timestamp: Date.now(),
          nodeId: this.nodeId,
        }));
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(conn: HubConnection) {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(conn: HubConnection) {
    if (conn.reconnectTimer) return; // already scheduled

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, conn.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    conn.reconnectAttempt++;

    console.log(`[hub] workspace ${conn.config.id}: reconnecting in ${Math.round(delay / 1000)}s (attempt ${conn.reconnectAttempt})`);

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (conn.ws) {
        try { conn.ws.close(); } catch {}
      }
      this.openWebSocket(conn);
    }, delay);
  }

  private cleanupConnection(conn: HubConnection) {
    this.stopHeartbeat(conn);
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.ws) {
      try { conn.ws.close(1000, "transport disconnect"); } catch {}
      conn.ws = null;
    }
    conn.connected = false;
  }

  private updateConnectedState() {
    this._connected = Array.from(this.connections.values()).some((c) => c.connected);
  }
}

/** Load all workspace configs from ~/.config/maw/workspaces/*.json */
export function loadWorkspaceConfigs(): WorkspaceConfig[] {
  if (!existsSync(WORKSPACES_DIR)) {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    return [];
  }

  const files = readdirSync(WORKSPACES_DIR).filter((f) => f.endsWith(".json"));
  const configs: WorkspaceConfig[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(WORKSPACES_DIR, file), "utf-8"));
      if (validateWorkspaceConfig(raw)) {
        configs.push(raw as WorkspaceConfig);
      } else {
        console.warn(`[hub] invalid workspace config: ${file}`);
      }
    } catch (err) {
      console.warn(`[hub] failed to parse workspace config: ${file}`, err);
    }
  }

  return configs;
}

/** Validate workspace config shape */
function validateWorkspaceConfig(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (typeof raw.id !== "string" || raw.id.length === 0) return false;
  if (typeof raw.hubUrl !== "string" || raw.hubUrl.length === 0) return false;
  if (typeof raw.token !== "string" || raw.token.length === 0) return false;
  if (!Array.isArray(raw.sharedAgents)) return false;
  // Validate hubUrl is a valid WebSocket URL
  try {
    const url = new URL(raw.hubUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
  } catch {
    return false;
  }
  return true;
}
