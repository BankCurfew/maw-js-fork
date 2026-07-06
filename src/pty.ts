import { tmux } from "./tmux";
import { loadConfig } from "./config";
import type { ServerWebSocket } from "bun";

const PINNED_COLS = 200;
const PINNED_ROWS = 50;

let nextPtyId = 0;

interface PtySession {
  proc: ReturnType<typeof Bun.spawn>;
  target: string;
  ptySessionName: string;
  viewers: Set<ServerWebSocket<any>>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, PtySession>();
const creatingPtyNames = new Set<string>();

function isTrackedPtyName(ptyName: string): boolean {
  if (creatingPtyNames.has(ptyName)) return true;
  for (const s of sessions.values()) {
    if (s.ptySessionName === ptyName) return true;
  }
  return false;
}

export async function sweepOrphanPtySessions(): Promise<{ killed: string[]; checked: number }> {
  const all = await tmux.listSessionGroups();
  const killed: string[] = [];
  for (const { name } of all) {
    if (!name.startsWith("maw-pty-")) continue;
    if (isTrackedPtyName(name)) continue;
    await tmux.killSession(name);
    killed.push(name);
  }
  return { killed, checked: all.length };
}

function isLocalHost(): boolean {
  const host = process.env.MAW_HOST || loadConfig().host || "localhost";
  return host === "local" || host === "localhost";
}

function findSession(ws: ServerWebSocket<any>): PtySession | undefined {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws)) return s;
  }
}

async function fitWindowRows(target: string, rows: number): Promise<void> {
  const r = Math.max(1, Math.min(200, Math.floor(rows)));
  await tmux.resizeWindow(target, PINNED_COLS, r).catch(() => {});
}

export function handlePtyMessage(ws: ServerWebSocket<any>, msg: string | Buffer) {
  if (typeof msg !== "string") {
    // Binary → keystroke to PTY stdin
    const session = findSession(ws);
    if (session?.proc.stdin) {
      (session.proc.stdin as any).write(msg as Buffer);
      (session.proc.stdin as any).flush();
    }
    return;
  }

  // JSON control message
  try {
    const data = JSON.parse(msg);
    if (data.type === "attach") attach(ws, data.target, data.cols || 120, data.rows || 40);
    else if (data.type === "resize") resize(ws, data.cols, data.rows);
    else if (data.type === "detach") detach(ws);
  } catch {}
}

export function handlePtyClose(ws: ServerWebSocket<any>) {
  detach(ws);
}

async function attach(ws: ServerWebSocket<any>, target: string, cols: number, rows: number) {
  // Sanitize target: only allow safe characters
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe) return;

  // Detach from any existing session
  detach(ws);

  // Join existing PTY session?
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }

  const sessionName = safe.split(":")[0];
  const windowPart = safe.includes(":") ? safe.split(":").slice(1).join(":") : "";
  const c = Math.max(1, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(200, Math.floor(rows)));

  // Create a grouped session — shares windows but has independent client sizing.
  // This prevents the web terminal from shrinking the real terminal.
  const ptySessionName = `maw-pty-${++nextPtyId}`;
  creatingPtyNames.add(ptySessionName);
  try {
    await tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c, rows: r, window: windowPart || undefined,
    });
    await fitWindowRows(ptySessionName, r);
  } catch {
    creatingPtyNames.delete(ptySessionName);
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));
    return;
  }

  // Spawn PTY via script(1) — attach to our grouped session (not the original)
  let args: string[];
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`;
    args = ["script", "-qfc", cmd, "/dev/null"];
  } else {
    const host = process.env.MAW_HOST || loadConfig().host || "localhost";
    args = ["ssh", "-tt", host, `TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`];
  }

  let proc;
  try {
    proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", message: `PTY spawn failed: ${e.message}` }));
    tmux.killSession(ptySessionName);
    return;
  }

  session = { proc, target: safe, ptySessionName, viewers: new Set([ws]), cleanupTimer: null };
  sessions.set(safe, session);
  creatingPtyNames.delete(ptySessionName);

  ws.send(JSON.stringify({ type: "attached", target: safe }));

  // No resize here — grouped session has its own size from stty

  // Stream PTY stdout → all viewers as binary frames
  const s = session;
  const reader = proc.stdout!.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const v of s.viewers) {
          try { v.send(value); } catch {}
        }
      }
    } catch {}
    // PTY process ended — restore pinned canvas + clean up grouped session
    void tmux.resizeWindow(safe.split(":")[0], PINNED_COLS, PINNED_ROWS).catch(() => {});
    sessions.delete(safe);
    tmux.killSession(s.ptySessionName);
    for (const v of s.viewers) {
      try { v.send(JSON.stringify({ type: "detached", target: safe })); } catch {}
    }
  })();
}

function resize(ws: ServerWebSocket<any>, _cols: number, rows: number) {
  const session = findSession(ws);
  if (!session) return;
  void fitWindowRows(session.ptySessionName, rows);
}

function detach(ws: ServerWebSocket<any>) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws)) continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      // Restore pinned canvas so the headless Oracle gets full working area
      const parent = target.split(":")[0];
      void tmux.resizeWindow(parent, PINNED_COLS, PINNED_ROWS).catch(() => {});
      // Grace period before killing PTY
      session.cleanupTimer = setTimeout(() => {
        try { session.proc.kill(); } catch {}
        tmux.killSession(session.ptySessionName);
        sessions.delete(target);
      }, 5000);
    }
  }
}
