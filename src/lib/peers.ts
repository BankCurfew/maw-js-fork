/**
 * Peer aggregation, health checks, and cross-node routing.
 *
 * Handles:
 * - Peer reachability pings (GET /api/config with timeout)
 * - Agent aggregation across nodes (local + remote, 30s TTL cache)
 * - Cross-node session merging
 * - Outbound send via HMAC-signed HTTP
 */

import { loadConfig } from "../config";
import { signRequest } from "./federation-auth";

interface PeerConfig {
  name: string;
  url: string;
}

export interface PeerStatus {
  name: string;
  url: string;
  reachable: boolean;
  latencyMs: number | null;
}

interface PeerConfigResponse {
  node: string;
  agents: Record<string, string>;
  namedPeers: Record<string, string>;
}

// ── Cache ─────────────────────────────────────────────────

interface AggregateCache {
  agents: Record<string, string>; // agentName → nodeName
  sessions: any[];
  ts: number;
}

let cache: AggregateCache | null = null;
const CACHE_TTL = 30_000;

function isCacheValid(): boolean {
  return !!cache && Date.now() - cache.ts < CACHE_TTL;
}

// ── Named Peers from config ─────────────────────────────

export function getNamedPeers(): PeerConfig[] {
  const config = loadConfig() as any;
  const raw = config.namedPeers;
  if (!raw) return [];
  // Support both array form [{name, url}] and object form {"name": "url"}
  if (Array.isArray(raw)) return raw as PeerConfig[];
  return Object.entries(raw).map(([name, url]) => ({ name, url: url as string }));
}

// ── Health Check ─────────────────────────────────────────

/** Ping all named peers, return reachability + latency. */
export async function checkPeerHealth(): Promise<PeerStatus[]> {
  const peers = getNamedPeers();
  if (peers.length === 0) return [];

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      const start = performance.now();
      try {
        const res = await fetch(`${peer.url}/api/config`, {
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Math.round(performance.now() - start);
        return {
          name: peer.name,
          url: peer.url,
          reachable: res.ok,
          latencyMs,
        };
      } catch {
        return {
          name: peer.name,
          url: peer.url,
          reachable: false,
          latencyMs: null,
        };
      }
    }),
  );

  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { name: "unknown", url: "", reachable: false, latencyMs: null },
  );
}

// ── Agent Aggregation ────────────────────────────────────

/**
 * Build a merged agents map: local agents + remote agents from peers.
 * Returns Record<agentName, nodeName>.
 */
export async function aggregateAgents(
  localSessions: string[],
): Promise<Record<string, string>> {
  const config = loadConfig() as any;
  const nodeName = config.node || "local";
  const agents: Record<string, string> = {};

  // Static agents from config (fallback for federated agents that aren't in local tmux)
  const staticAgents = config.agents || {};
  for (const [name, node] of Object.entries(staticAgents)) {
    if (typeof node === "string" && node) agents[name] = node;
  }

  // Local agents from tmux sessions (overrides static for local agents)
  for (const s of localSessions) {
    // Session format: "01-bob", "02-dev", etc. — strip numeric prefix
    const name = s.replace(/^\d+-/, "");
    agents[name] = nodeName;
  }

  // Fetch remote agents from peers (with cache)
  if (isCacheValid() && cache) {
    Object.assign(agents, cache.agents);
    return agents;
  }

  const peers = getNamedPeers();
  const remoteAgents: Record<string, string> = {};

  await Promise.allSettled(
    peers.map(async (peer) => {
      try {
        const res = await fetch(`${peer.url}/api/config`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return;
        const data: PeerConfigResponse = await res.json();
        // Add remote agents, tagged with peer's node name
        if (data.agents) {
          for (const [name, node] of Object.entries(data.agents)) {
            remoteAgents[name] = node;
          }
        }
      } catch {
        // Peer unreachable — skip
      }
    }),
  );

  // Update cache
  cache = { agents: remoteAgents, sessions: [], ts: Date.now() };

  Object.assign(agents, remoteAgents);
  return agents;
}

// ── Cross-Node Send ──────────────────────────────────────

/**
 * Send a message to a remote node's /api/send.
 * Target format: "node:session" (e.g., "node:01-bob")
 * Returns the remote response.
 */
export async function crossNodeSend(
  target: string,
  text: string,
  senderFrom?: string,
): Promise<{ ok: boolean; error?: string; forwarded?: boolean }> {
  const colonIdx = target.indexOf(":");
  if (colonIdx === -1) return { ok: false, error: "not a cross-node target" };

  const nodeName = target.slice(0, colonIdx);
  const remoteTarget = target.slice(colonIdx + 1);
  const config = loadConfig() as any;

  // Find peer URL (supports both array and object form)
  const peers = getNamedPeers();
  const peer = peers.find((p) => p.name === nodeName);
  if (!peer) return { ok: false, error: `unknown peer: ${nodeName}` };

  // Sign the request — use federation-specific endpoint on remote
  const path = "/api/federation/send";
  const token = config.federationToken;
  if (!token) return { ok: false, error: "no federationToken configured" };

  const { timestamp, signature } = signRequest("POST", path, token);

  try {
    const res = await fetch(`${peer.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Maw-Timestamp": timestamp,
        "X-Maw-Signature": signature,
      },
      body: JSON.stringify({ target: remoteTarget, text, from: senderFrom || config.node || "unknown" }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `peer responded ${res.status}: ${body}` };
    }

    // T068: async file-push for chip paths in message text
    pushChipFiles(peer.url, token, nodeName, remoteTarget, text, senderFrom || config.node || "unknown").catch((e: any) => { chipLog(`PUSH-INIT FAIL → ${nodeName}: ${e.message}`); });

    return { ok: true, forwarded: true };
  } catch (e: any) {
    return { ok: false, error: `peer unreachable: ${e.message}` };
  }
}

const CHIP_FILE_RE = /(?:\/[\w.\-\/]+\.(?:html?|pdf|md|txt|png|jpe?g|webp|gif))/gi;
const CHIP_ALLOWED_EXT = /\.(png|jpe?g|webp|gif|html?|pdf|md|txt)$/i;
const CHIP_MAX_SIZE = 10 * 1024 * 1024;

function chipLog(msg: string) {
  try {
    const { appendFileSync } = require("fs");
    const { join } = require("path");
    const { homedir } = require("os");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendFileSync(join(homedir(), ".oracle/feed.log"), `${ts} | SYSTEM | local | Notification | SYSTEM | file-relay » ${msg}\n`);
  } catch {}
}

async function pushChipFiles(peerUrl: string, token: string, nodeName: string, remoteTarget: string, text: string, senderFrom: string) {
  const paths = text.match(CHIP_FILE_RE);
  if (!paths || paths.length === 0) return;

  const { readFileSync, realpathSync, statSync } = await import("fs");
  const { basename: pathBasename, join } = await import("path");
  const { homedir } = await import("os");
  const home = homedir();
  const config = loadConfig() as any;

  for (const filePath of paths) {
    const basename = pathBasename(filePath);
    try {
      if (!CHIP_ALLOWED_EXT.test(filePath)) continue;
      const abs = filePath.startsWith("/") ? filePath : join(home, filePath);
      const resolved = realpathSync(abs);
      const st = statSync(resolved);
      if (st.size > CHIP_MAX_SIZE) { chipLog(`SKIP ${basename} → ${nodeName} (>${CHIP_MAX_SIZE} bytes)`); continue; }

      const bytes = readFileSync(resolved);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      const sha256 = hasher.digest("hex");

      const pushPath = "/api/file-push";
      const { timestamp, signature } = signRequest("POST", pushPath, token);

      const res = await fetch(`${peerUrl}${pushPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Maw-Timestamp": timestamp,
          "X-Maw-Signature": signature,
        },
        body: JSON.stringify({
          from_node: config.node || "unknown",
          orig_path: filePath,
          basename,
          sha256,
          data: bytes.toString("base64"),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) {
        const { dest_path } = await res.json() as { dest_path: string };
        chipLog(`OK ${basename} → ${nodeName} (${dest_path})`);
        if (dest_path) {
          const followPath = "/api/federation/send";
          const { timestamp: ts2, signature: sig2 } = signRequest("POST", followPath, token);
          await fetch(`${peerUrl}${followPath}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Maw-Timestamp": ts2,
              "X-Maw-Signature": sig2,
            },
            body: JSON.stringify({ target: remoteTarget, text: dest_path, from: senderFrom }),
            signal: AbortSignal.timeout(10000),
          }).catch((e: any) => { chipLog(`FOLLOW-UP FAIL ${basename} → ${nodeName}: ${e.message}`); });
        }
      } else {
        const body = await res.text().catch(() => "");
        chipLog(`FAIL ${basename} → ${nodeName}: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      chipLog(`ERROR ${basename} → ${nodeName}: ${e.message}`);
    }
  }
}

// ── Session Aggregation ──────────────────────────────────

/**
 * Merge local sessions with remote peer sessions.
 * Uses 30s TTL cache for remote data.
 */
export async function aggregateSessions(
  localSessions: any[],
): Promise<{ sessions: any[]; nodes: string[] }> {
  const config = loadConfig() as any;
  const nodeName = config.node || "local";

  // Tag local sessions with node
  const tagged = localSessions.map((s: any) => ({
    ...s,
    node: nodeName,
  }));

  const peers = getNamedPeers();
  if (peers.length === 0) return { sessions: tagged, nodes: [nodeName] };

  // Fetch remote sessions
  const nodes = [nodeName];
  const remoteSessions: any[] = [];

  await Promise.allSettled(
    peers.map(async (peer) => {
      try {
        const res = await fetch(`${peer.url}/api/sessions`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const sessions = Array.isArray(data) ? data : data.sessions || [];
        for (const s of sessions) {
          remoteSessions.push({ ...s, node: peer.name });
        }
        nodes.push(peer.name);
      } catch {
        // Peer unreachable
      }
    }),
  );

  return { sessions: [...tagged, ...remoteSessions], nodes };
}
