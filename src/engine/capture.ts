import { capture } from "../ssh";
import { tmux } from "../tmux";
import { isAgentPane } from "../lib/pane";
import type { MawWS } from "../types";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

/** Load fleet config to map session names (e.g. "NN-example") to oracle names (e.g. "Example-Oracle"). */
const fleetNameMap = new Map<string, string>();
try {
  const fleetDir = join(import.meta.dir, "../../fleet");
  for (const f of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
    const cfg = JSON.parse(readFileSync(join(fleetDir, f), "utf-8"));
    if (cfg.name && cfg.windows?.[0]?.name) {
      fleetNameMap.set(cfg.name, cfg.windows[0].name);
    }
  }
} catch { /* fleet dir missing — no fallback */ }

/** Push terminal capture to a subscribed WebSocket client. */
export async function pushCapture(
  ws: MawWS,
  lastContent: Map<MawWS, string>,
) {
  if (!ws.data.target) return;
  try {
    const content = await capture(ws.data.target, 80);
    const prev = lastContent.get(ws);
    if (content !== prev) {
      lastContent.set(ws, content);
      ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
    }
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

/** Push preview captures for subscribed targets.
 *  For Claude TUI panes: uses transcript JSONL (capture-pane only sees the visible TUI frame).
 *  For non-Claude panes: uses capture-pane as before.
 */
export async function pushPreviews(
  ws: MawWS,
  lastPreviews: Map<MawWS, Map<string, string>>,
) {
  const targets = ws.data.previewTargets;
  if (!targets || targets.size === 0) return;
  const prevMap = lastPreviews.get(ws) || new Map<string, string>();
  const changed: Record<string, string> = {};
  let hasChanges = false;

  await Promise.allSettled([...targets].map(async (target) => {
    try {
      let content: string;

      // Try transcript-based preview for oracle panes
      const windowName = target.split(":").pop() || "";
      const oracleName = fleetNameMap.get(target.split(":")[0]) || windowName;
      const oracleKey = oracleName.replace(/-?[Oo]racle$/, "").toLowerCase();

      if (oracleKey) {
        try {
          const { readTranscript, formatTranscriptPreview } = await import("../transcript");
          const messages = readTranscript(oracleKey, 8);
          if (messages.length > 0) {
            content = formatTranscriptPreview(messages);
          } else {
            content = await capture(target, 15);
          }
        } catch {
          content = await capture(target, 15);
        }
      } else {
        content = await capture(target, 15);
      }

      const prev = prevMap.get(target);
      if (content !== prev) {
        prevMap.set(target, content);
        changed[target] = content;
        hasChanges = true;
      }
    } catch { /* expected: capture may fail for inactive pane */ }
  }));

  lastPreviews.set(ws, prevMap);
  if (hasChanges) {
    ws.send(JSON.stringify({ type: "previews", data: changed }));
  }
}

/** Broadcast session list to all clients (only if changed).
 *  peerSessions — optional extra sessions from federated peers (tagged with source).
 *  cache.sessions always holds local-only sessions for status detection / busy-agent scanning.
 */
export async function broadcastSessions(
  clients: Set<MawWS>,
  cache: { sessions: SessionInfo[]; json: string },
  peerSessions: SessionInfo[] = [],
): Promise<SessionInfo[]> {
  if (clients.size === 0) return cache.sessions;
  try {
    const local = await tmux.listAll();
    const all = peerSessions.length > 0 ? [...local, ...peerSessions] : local;
    cache.sessions = local;
    cache.json = JSON.stringify(all);
    const msg = JSON.stringify({ type: "sessions", sessions: all });
    for (const ws of clients) ws.send(msg);
    return local;
  } catch {
    return cache.sessions;
  }
}

/** Scan panes for running claude and send `recent` to client. */
export async function sendBusyAgents(ws: MawWS, sessions: SessionInfo[]) {
  const allTargets = sessions.flatMap(s => s.windows.map(w => `${s.name}:${w.index}`));
  const cmds = await tmux.getPaneCommands(allTargets);
  const busy = allTargets
    .filter(t => isAgentPane(cmds[t] || ""))
    .map(t => {
      const [session] = t.split(":");
      const s = sessions.find(x => x.name === session);
      const w = s?.windows.find(w => `${s.name}:${w.index}` === t);
      let name = w?.name || t;
      // Fallback: if tmux window has generic name, use fleet config
      if (/^claude$/i.test(name) && session) {
        name = fleetNameMap.get(session) || name;
      }
      return { target: t, name, session };
    });
  if (busy.length > 0) {
    ws.send(JSON.stringify({ type: "recent", agents: busy }));
  }
}
