import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { listSessions, capture, sendKeys, selectWindow, getPaneCommand } from "./ssh";
import { findWindow } from "./find-window";
import { tmux } from "./tmux";
import { processMirror } from "./commands/overview";
import { FeedTailer } from "./feed-tail";
import { MawEngine } from "./engine";
import { LoopEngine } from "./loops";
import { isAuthenticated, handleLogin, handleLogout, getActiveSessions, LOGIN_PAGE, isAuthEnabled, generateQrToken, getQrTokenStatus, approveQrToken, QR_APPROVE_PAGE } from "./auth";
import type { WSData } from "./types";
// crypto.randomUUID() used below (global, no import needed)
import { requireHmac, signHeaders } from "./lib/federation-auth";
import { checkPeerHealth, aggregateAgents, crossNodeSend, aggregateSessions, getNamedPeers } from "./lib/peers";
import { Database } from "bun:sqlite";
import { homedir } from "os";

const app = new Hono();

// Module-level engine reference (set by startServer)
let engine: MawEngine | null = null;

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.use("/api/*", cors());

// --- Auth routes (always accessible) ---
app.get("/auth/login", (c) => c.html(LOGIN_PAGE));
app.post("/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "direct";
  const result = await handleLogin(username, password, c.req.header("user-agent") || "", ip);
  if (result.ok) {
    return c.json({ ok: true }, 200, {
      "Set-Cookie": `maw_session=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    });
  }
  return c.json({ ok: false, error: result.error }, 401);
});
app.get("/auth/logout", (c) => {
  handleLogout(c.req.raw);
  c.header("Set-Cookie", "maw_session=; Path=/; HttpOnly; Max-Age=0");
  return c.redirect("/auth/login", 302);
});
app.post("/auth/logout", (c) => {
  handleLogout(c.req.raw);
  return c.json({ ok: true }, 200, {
    "Set-Cookie": "maw_session=; Path=/; HttpOnly; Max-Age=0",
  });
});
app.get("/auth/me", (c) => {
  const authed = isAuthenticated(c.req.raw);
  return c.json({ authenticated: authed, authEnabled: isAuthEnabled() });
});
app.get("/api/auth/sessions", (c) => {
  if (!isAuthenticated(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  return c.json(getActiveSessions());
});

// --- QR Code Login ---
app.get("/auth/qr-generate", (c) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "direct";
  const ua = c.req.header("user-agent") || "";
  const result = generateQrToken(ua, ip);
  return c.json(result);
});

app.get("/auth/qr-approve", (c) => {
  const token = c.req.query("token");
  if (!token) return c.text("Missing token", 400);
  // Must be authenticated (logged in on phone)
  if (!isAuthenticated(c.req.raw)) {
    // Redirect to login, then back to approve page
    return c.redirect(`/auth/login?redirect=/auth/qr-approve?token=${encodeURIComponent(token)}`);
  }
  const ua = c.req.header("user-agent") || "Unknown device";
  return c.html(QR_APPROVE_PAGE(token, ua));
});

app.post("/auth/qr-approve", async (c) => {
  // Must be authenticated (logged in on phone)
  if (!isAuthenticated(c.req.raw)) {
    return c.json({ ok: false, error: "Not authenticated" }, 401);
  }
  const { token } = await c.req.json();
  if (!token) return c.json({ ok: false, error: "Missing token" }, 400);
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/maw_session=([a-f0-9]+)/);
  const approverSession = match ? match[1] : "unknown";
  const result = approveQrToken(token, approverSession);
  if (!result.ok) return c.json(result, 400);
  return c.json({ ok: true });
});

app.get("/auth/qr-status", (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);
  const result = getQrTokenStatus(token);
  if (result.status === "approved" && result.sessionId) {
    // Set HttpOnly cookie server-side (same as password login)
    return c.json({ status: "approved" }, 200, {
      "Set-Cookie": `maw_session=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    });
  }
  return c.json(result);
});

// --- Auth middleware — protect everything except /auth/* ---
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // Skip auth for auth routes, static assets needed for login, and attachments (UUID-based, unguessable)
  if (path.startsWith("/auth/") || path.startsWith("/api/attachments/")) return next();

  if (!isAuthenticated(c.req.raw)) {
    // API calls get 401, pages get redirect
    if (path.startsWith("/api/") || path.startsWith("/ws")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.redirect("/auth/login");
  }
  return next();
});

// --- Internal-only guard: block external (CF Tunnel) access to sensitive endpoints ---
// CF Tunnel always adds CF-Connecting-IP header; local requests don't have it.
const INTERNAL_ONLY_PATHS = new Set([
  "/api/sessions/federated",
  "/api/tokens",
  "/api/tokens/rate",
  "/api/maw-log",
  "/api/progress",
  "/api/oracle-health",
]);

function isInternalOnly(path: string): boolean {
  if (INTERNAL_ONLY_PATHS.has(path)) return true;
  // /api/progress/:oracle — match prefix
  if (path.startsWith("/api/progress/")) return true;
  return false;
}

app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isInternalOnly(path)) {
    const cfIp = c.req.header("cf-connecting-ip");
    if (cfIp) {
      return c.json({ error: "internal_only", hint: "This endpoint is not available externally" }, 403);
    }
  }
  return next();
});

// API routes (keep for CLI compatibility)
app.get("/api/sessions", async (c) => c.json(await listSessions()));

app.get("/api/capture", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    return c.json({ content: await capture(target) });
  } catch (e: any) {
    return c.json({ content: "", error: e.message });
  }
});

app.get("/api/thinking", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    const raw = await capture(target, 20);
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    // T050: extract ACTIVE status lines only (not stale "for Ns" history)
    // Active = paren-pattern "(Ns · ↓ tokens)" or "esc to interrupt" or ⚡ tool emoji
    // Stale = "for Ns" phrasing (past tense, no parens)
    const allLines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    const statusLines = allLines.filter(l =>
      !l.startsWith("❯") && !l.startsWith("📡") && !l.startsWith("⏵") &&
      !/^────/.test(l) && !/^bypass/.test(l) &&
      (/\(\d+[smh]?\s*\d*s?\s*·/.test(l) ||
       /esc to interrupt/i.test(l) ||
       /^[⚡📖✏️🔍🤖🔌🔧]\s+\w/.test(l) ||
       /^●\s*(Running|Ran|Bash|Read|Edit|Write|Grep|Glob|Task|Fetch|Update|Search|Web|Monitor|Agent|Workflow|Skill|Artifact)\b/.test(l) ||
       /^\s*\$\s/.test(l) ||
       /^\s*⎿/.test(l) ||
       /Compacting/i.test(l))
    ).slice(-4);
    const thinkingLine = statusLines.length > 0 ? statusLines.join(" · ") : null;
    const hasStatusBar = /📡/.test(clean) || /\d+%\s+\d+k\/\d+k/.test(clean);
    const isAdvisory = !hasStatusBar && /share one limit|% of usage|Skills|usage advisory|rate limit/i.test(clean);
    // T022: detect queued messages from pane
    const queueLines = clean.split("\n").map(l => l.trim());
    const hasQueueMarker = queueLines.some(l => /Press up to edit queued messages/i.test(l));
    const pendingItems = queueLines.filter(l => /^!\s*\[from/.test(l)).map(l => l.replace(/^!\s*/, "").slice(0, 80));
    const promptText = queueLines.find(l => /^❯\s+\S/.test(l))?.replace(/^❯\s+/, "").slice(0, 80) || null;
    const queue = (hasQueueMarker || pendingItems.length > 0 || promptText) ? { count: pendingItems.length + (promptText ? 1 : 0), items: pendingItems, typing: promptText } : undefined;
    // V19: detect prompt dialogs (permission, survey, y/n)
    let promptDialog: { text: string; options: { label: string; key: string }[] } | undefined;
    const paneLines = allLines;
    const dialogPatterns = [
      /\(y\/n\)/i, /Do you want/i, /requires? approval/i, /Esc to cancel/i,
      /proceed\?/i, /How is Claude/i, /Are you sure/i, /allow.*\?/i,
    ];
    const hasDialog = paneLines.some(l => dialogPatterns.some(p => p.test(l)));
    if (hasDialog) {
      const dialogLines = paneLines.filter(l => !l.startsWith("📡") && !l.startsWith("⏵") && !/^────/.test(l));
      const promptLine = dialogLines.find(l => dialogPatterns.some(p => p.test(l))) || "";
      const options: { label: string; key: string }[] = [];
      // Parse numbered options: "1. Yes", "2. No", "1:Bad 2:Fine"
      for (const l of dialogLines) {
        const numbered = l.matchAll(/(\d+)[.:)]\s*([A-Za-z][A-Za-z\s]*?)(?=\s+\d+[.:)]|\s*$)/g);
        for (const m of numbered) {
          options.push({ label: `${m[1]}. ${m[2].trim()}`, key: m[1] });
        }
      }
      // Parse y/n
      if (options.length === 0 && /\(y\/n\)/i.test(promptLine)) {
        options.push({ label: "Yes", key: "y" }, { label: "No", key: "n" });
      }
      // Always add Esc
      if (!options.some(o => o.key.toLowerCase() === "esc")) {
        options.push({ label: "Esc Cancel", key: "\x1b" });
      }
      promptDialog = { text: promptLine.slice(0, 120), options };
    }
    return c.json({ thinkingLine, statusRegion: statusLines.length > 0 ? statusLines : undefined, advisory: isAdvisory || undefined, queue, promptDialog });
  } catch {
    return c.json({ thinkingLine: null });
  }
});

app.get("/api/transcript", async (c) => {
  const oracle = c.req.query("oracle");
  if (!oracle) return c.json({ error: "oracle required" }, 400);
  const limit = +(c.req.query("limit") || c.req.query("count") || "50");
  const beforeRaw = c.req.query("before");
  const before = beforeRaw ? +beforeRaw : undefined;
  const { readTranscriptPage } = await import("./transcript");
  const page = readTranscriptPage(oracle, limit, before);
  return c.json({ oracle, ...page });
});

app.get("/api/comms", async (c) => {
  const limit = +(c.req.query("limit") || "50");
  const beforeRaw = c.req.query("before");
  const oracle = c.req.query("oracle");
  const pair = c.req.query("pair");
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const logPath = join(homedir(), ".oracle", "maw-log.jsonl");
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    let msgs: any[] = [];
    let idx = 0;
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const from = (d.from || "").toLowerCase().replace(/-oracle$/i, "");
        const to = (d.to || "").toLowerCase().replace(/-oracle$/i, "");
        // Strip control chars
        const text = (d.msg || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
        if (!text) continue;
        // Skip self-sends and pulse auto-cc noise
        if (from === to) continue;
        if (from === "pulse" && text.includes("auto-cc")) continue;
        msgs.push({ idx: idx++, from, to, text, ts: d.ts || "" });
      } catch {}
    }
    // Filter
    if (oracle) {
      const oLower = oracle.toLowerCase();
      msgs = msgs.filter(m => m.from === oLower || m.to === oLower);
    }
    if (pair) {
      const [a, b] = pair.split(",").map(s => s.trim().toLowerCase());
      msgs = msgs.filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a));
    }
    const total = msgs.length;
    let end = total;
    if (beforeRaw) end = Math.min(+beforeRaw, total);
    const start = Math.max(0, end - limit);
    const page = msgs.slice(start, end);
    return c.json({ messages: page, total, hasMore: start > 0 });
  } catch (e: any) {
    return c.json({ messages: [], total: 0, hasMore: false, error: e.message });
  }
});

app.get("/api/file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  const { realpathSync, statSync, createReadStream } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");
  const home = homedir();
  const ghq = join(home, "repos/github.com/YourOrg");
  const ROOTS = [
    ...(() => { try { const { readdirSync } = require("fs"); return readdirSync(ghq).map((d: string) => join(ghq, d, "output")); } catch { return []; } })(),
    ...(() => { try { const { readdirSync } = require("fs"); return readdirSync(ghq).map((d: string) => join(ghq, d, "ψ/writing")); } catch { return []; } })(),
    ...(() => { try { const { readdirSync } = require("fs"); return readdirSync(ghq).map((d: string) => join(ghq, d, ".playwright-cli")); } catch { return []; } })(),
    join(home, ".maw/inbox"),
    "/mnt/c/Users/mbank/Downloads",
  ];
  const ALLOWED_EXT = /\.(png|jpe?g|webp|gif|html?|pdf|md|txt)$/i;
  const MAX_SIZE = 20 * 1024 * 1024;
  if (!ALLOWED_EXT.test(filePath)) return c.json({ error: "unsupported file type" }, 403);
  let resolved: string;
  try {
    const abs = filePath.startsWith("/") ? filePath : join(home, filePath);
    resolved = realpathSync(abs);
  } catch {
    return c.json({ error: "not found" }, 404);
  }
  if (!ROOTS.some(root => { try { return resolved.startsWith(realpathSync(root)); } catch { return false; } })) {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    const st = statSync(resolved);
    if (st.size > MAX_SIZE) return c.json({ error: "too large" }, 413);
    const ext = resolved.match(/\.(\w+)$/)?.[1]?.toLowerCase() || "bin";
    const mime: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
      html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", pdf: "application/pdf", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
    };
    const headers: Record<string, string> = { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" };
    if (ext === "pdf") headers["Content-Disposition"] = "inline";
    const file = Bun.file(resolved);
    return new Response(file, { headers });
  } catch {
    return c.json({ error: "read error" }, 500);
  }
});

app.get("/api/picker", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    const raw = await capture(target, 20);
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
    // Strict picker: ❯ + numbered option AND ≥2 sibling numbered lines
    const selectedLine = lines.findIndex(l => /^❯\s+\d+\.\s/.test(l));
    const numberedLines = lines.filter(l => /^\s*\d+\.\s/.test(l) || /^❯\s+\d+\.\s/.test(l));
    if (selectedLine >= 0 && numberedLines.length >= 3) {
      return c.json({ active: true, lines: lines.slice(Math.max(0, selectedLine - 2), selectedLine + 8) });
    }
    return c.json({ active: false });
  } catch {
    return c.json({ active: false });
  }
});

const statusBarCache = new Map<string, { data: any; ts: number }>();

app.get("/api/status-bar", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    const raw = await capture(target, 10);
    const lines = raw.split("\n");
    const line = lines.find(l => l.includes("📡")) || lines.find(l => /\d+%\s+\d+k\/\d+k/.test(l)) || "";
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const ctx = clean.match(/(\d+)%\s+(\d+k)\/(\d+k)/);
    const model = clean.match(/(Opus|Sonnet|Haiku|Fable)\s+[\d.]+\s*(?:\([^)]+\))?/)?.[0] || "";
    const duration = clean.match(/(\d+h\d*m?)\s*•\s*(Opus|Sonnet|Haiku|Fable)/)?.[1] || "";
    const h5 = clean.match(/5h[█░]+(\d+)%/)?.[1] || "";
    const d7 = clean.match(/7d[█░]+(\d+)%/)?.[1] || "";
    const result = {
      raw: clean,
      contextPercent: ctx ? +ctx[1] : null,
      contextTokens: ctx ? ctx[2] : null,
      contextMax: ctx ? ctx[3] : null,
      model,
      duration,
      usage5h: h5 ? +h5 : null,
      usage7d: d7 ? +d7 : null,
    };
    // T020: cache last-known good result; serve stale when busy hides 📡
    if (ctx) {
      statusBarCache.set(target, { data: result, ts: Date.now() });
      return c.json(result);
    }
    const cached = statusBarCache.get(target);
    if (cached) {
      const staleSeconds = Math.round((Date.now() - cached.ts) / 1000);
      return c.json({ ...cached.data, stale: true, staleSeconds });
    }
    return c.json(result);
  } catch (e: any) {
    const cached = statusBarCache.get(target);
    if (cached) {
      const staleSeconds = Math.round((Date.now() - cached.ts) / 1000);
      return c.json({ ...cached.data, stale: true, staleSeconds });
    }
    return c.json({ raw: "", error: e.message });
  }
});

app.get("/api/mirror", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.text("target required", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw = await capture(target);
  return c.text(processMirror(raw, lines));
});

app.post("/api/send", async (c) => {
  const { target, text, from: senderFrom } = await c.req.json();
  if (!target || !text) return c.json({ error: "target and text required" }, 400);

  // Cross-node routing: "node:01-bob" → forward to peer (T025: only for KNOWN peers)
  if (target.includes(":")) {
    const colonIdx = target.indexOf(":");
    const prefix = target.slice(0, colonIdx);
    const peers = getNamedPeers();
    if (peers.some(p => p.name === prefix)) {
      const result = await crossNodeSend(target, text, senderFrom);
      if (!result.ok) return c.json({ error: result.error }, 502);
      return c.json({ ok: true, target, text, forwarded: true });
    }
  }

  // Agent→node fallback: bare name (e.g. "bob") not local → check agents config
  const config = loadConfig() as any;
  const agentNode = config.agents?.[target] || config.agents?.[target.replace(/-oracle$/, "")];
  const localNode = config.node || "local";
  if (agentNode && agentNode !== localNode) {
    const result = await crossNodeSend(`${agentNode}:${target}`, text, senderFrom);
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json({ ok: true, target, text, forwarded: true });
  }

  await sendKeys(target, text);
  return c.json({ ok: true, target, text });
});

// Inbound cross-node send (HMAC-authenticated from peer)
app.post("/api/federation/send", requireHmac(), async (c) => {
  const { target, text, from: senderName } = await c.req.json();
  if (!target || !text) return c.json({ error: "target and text required" }, 400);
  // Resolve oracle name (e.g. "echo-oracle") to tmux target (e.g. "echo:0")
  const sessions = await listSessions();
  const resolved = findWindow(sessions, target) || target;
  // Prepend sender identity so recipient knows who sent the message
  const from = senderName || "federation";
  const taggedText = `[from ${from}] ${text}`;
  await sendKeys(resolved, taggedText);

  // Audit trail — mirror cmdSend's feed.log + inbox + maw-log writes
  try {
    const { appendFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir, hostname } = await import("os");
    const home = homedir();
    const host = hostname();
    const ts = new Date().toISOString();

    // maw-log.jsonl
    const logDir = join(home, ".oracle");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "maw-log.jsonl"),
      JSON.stringify({ ts, from, to: target, target: resolved, msg: text, host, sid: null }) + "\n");

    // feed.log
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const feedTs = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const flat = text.replace(/\n/g, " \u239C ");
    appendFileSync(join(logDir, "feed.log"),
      `${feedTs} | ${from} | ${host} | Notification | ${from} | maw-hey \u00bb [handoff] ${JSON.stringify({ from, to: target, message: flat })}\n`);

    // inbox signal
    const inboxDir = join(logDir, "inbox");
    const inboxTarget = target.replace(/[^a-zA-Z0-9_-]/g, "");
    if (inboxTarget) {
      mkdirSync(inboxDir, { recursive: true });
      appendFileSync(join(inboxDir, `${inboxTarget}.jsonl`),
        JSON.stringify({ ts, from, type: "msg", msg: text, thread: null }) + "\n");
    }
  } catch {}

  return c.json({ ok: true, target: resolved, original: target !== resolved ? target : undefined, text });
});

// T068: Inbound cross-node file push (HMAC-authenticated)
app.post("/api/file-push", requireHmac(), async (c) => {
  const { from_node, orig_path, basename: rawBasename, sha256: expectedHash, data } = await c.req.json();
  if (!from_node || !rawBasename || !expectedHash || !data) {
    return c.json({ error: "from_node, basename, sha256, data required" }, 400);
  }
  const ALLOWED_EXT = /\.(png|jpe?g|webp|gif|html?|pdf|md|txt)$/i;
  const MAX_SIZE = 10 * 1024 * 1024;
  const basename = rawBasename.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!basename || !ALLOWED_EXT.test(basename)) {
    return c.json({ error: "unsupported file type" }, 403);
  }
  const nodeDir = from_node.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!nodeDir) return c.json({ error: "invalid from_node" }, 400);

  let bytes: Buffer;
  try { bytes = Buffer.from(data, "base64"); } catch { return c.json({ error: "invalid base64 data" }, 400); }
  if (bytes.length > MAX_SIZE) return c.json({ error: "file too large (>10MB)" }, 413);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const actualHash = hasher.digest("hex");
  if (actualHash !== expectedHash) {
    return c.json({ error: "sha256 mismatch" }, 400);
  }

  const { mkdirSync, writeFileSync } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");
  const relayDir = join(homedir(), ".maw/inbox/relay", nodeDir);
  mkdirSync(relayDir, { recursive: true });
  const destName = `${expectedHash.slice(0, 8)}_${basename}`;
  const destPath = join(relayDir, destName);
  writeFileSync(destPath, bytes);

  return c.json({ ok: true, dest_path: destPath });
});

app.post("/api/select", async (c) => {
  const { target } = await c.req.json();
  if (!target) return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});

// Serve React app from root (SPA with hash routing) — no-cache so mobile picks up new builds
app.get("/", async (c) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  return serveStatic({ root: "./dist-office", path: "/index.html" })(c, async () => {});
});

// Serve React app assets — immutable cache for content-hashed filenames
app.get("/assets/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return serveStatic({ root: "./dist-office" })(c, next);
});

// Serve all static files from dist-office (favicon, .html, .mp3, etc.)
app.get("/favicon.svg", serveStatic({ root: "./dist-office" }));
app.get("/*.html", serveStatic({ root: "./dist-office" }));
app.get("/*.mp3", serveStatic({ root: "./dist-office" }));

// Serve 8-bit office (Bevy WASM)
app.get("/office-8bit", serveStatic({ root: "./dist-8bit-office", path: "/index.html" }));
app.get("/office-8bit/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/dist-8bit-office"),
}));

// Serve War Room (Bevy WASM)
app.get("/war-room", serveStatic({ root: "./dist-war-room", path: "/index.html" }));
app.get("/war-room/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/war-room/, "/dist-war-room"),
}));

// Serve Race Track (Bevy WASM)
app.get("/race-track", serveStatic({ root: "./dist-race-track", path: "/index.html" }));
app.get("/race-track/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/race-track/, "/dist-race-track"),
}));

// Serve Superman Universe (Bevy WASM)
app.get("/superman", serveStatic({ root: "./dist-superman", path: "/index.html" }));
app.get("/superman/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/superman/, "/dist-superman"),
}));

// Oracle v2 proxy — search, stats
import { loadConfig, buildCommand, saveConfig, configForDisplay } from "./config";
const ORACLE_URL = process.env.ORACLE_URL || loadConfig().oracleUrl;

app.get("/api/oracle/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const params = new URLSearchParams({ q, mode: c.req.query("mode") || "hybrid", limit: c.req.query("limit") || "10" });
  const model = c.req.query("model");
  if (model) params.set("model", model);
  try {
    const res = await fetch(`${ORACLE_URL}/api/search?${params}`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

app.get("/api/oracle/traces", async (c) => {
  const limit = c.req.query("limit") || "10";
  try {
    const res = await fetch(`${ORACLE_URL}/api/traces?limit=${limit}`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

app.get("/api/oracle/stats", async (c) => {
  try {
    const res = await fetch(`${ORACLE_URL}/api/stats`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

// --- Rooms config (HR-managed) ---
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";

const roomsPath = join(import.meta.dir, "../rooms.json");

app.get("/api/rooms", (c) => {
  try {
    if (!existsSync(roomsPath)) return c.json({ rooms: [] });
    return c.json(JSON.parse(readFileSync(roomsPath, "utf-8")));
  } catch {
    return c.json({ rooms: [] });
  }
});

app.post("/api/rooms", async (c) => {
  try {
    const body = await c.req.json();
    body.updatedAt = new Date().toISOString();
    writeFileSync(roomsPath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- UI State persistence (cross-device) ---

// --- PIN lock (session auth for office dashboard) ---
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

app.get("/api/pin-info", (c) => {
  const config = loadConfig() as any;
  const pin = config.pin || "";
  return c.json({ length: pin.length, enabled: pin.length > 0 });
});

app.post("/api/pin-set", async (c) => {
  const { pin } = await c.req.json();
  const newPin = typeof pin === "string" ? pin.replace(/\D/g, "") : "";
  saveConfig({ pin: newPin } as any);
  return c.json({ ok: true, length: newPin.length, enabled: newPin.length > 0 });
});

app.post("/api/pin-verify", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "local";
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  pinAttempts.set(ip, entry);
  if (entry.count > 5) {
    return c.json({ ok: false, error: "Too many attempts. Wait 1 minute." }, 429);
  }
  const { pin } = await c.req.json();
  const config = loadConfig() as any;
  const correct = config.pin || "";
  if (!correct) return c.json({ ok: true });
  const ok = pin === correct;
  if (ok) pinAttempts.delete(ip);
  return c.json({ ok });
});

// --- UI State persistence ---
const uiStatePath = join(import.meta.dir, "../ui-state.json");

app.get("/api/ui-state", (c) => {
  try {
    if (!existsSync(uiStatePath)) return c.json({});
    return c.json(JSON.parse(readFileSync(uiStatePath, "utf-8")));
  } catch {
    return c.json({});
  }
});

app.post("/api/ui-state", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync(uiStatePath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Asks persistence (inbox) ---
const asksPath = join(import.meta.dir, "../asks.json");

app.get("/api/asks", (c) => {
  try {
    if (!existsSync(asksPath)) return c.json([]);
    const asks = JSON.parse(readFileSync(asksPath, "utf-8"));
    // Filter out stale "waiting for input" noise
    const clean = asks.filter((a: any) => {
      const msg = (a.message || "").toLowerCase();
      return !msg.includes("waiting for input") && !msg.includes("waiting for your input");
    });
    return c.json(clean);
  } catch {
    return c.json([]);
  }
});

app.post("/api/asks", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync(asksPath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Task Activity Log ---
import { readTaskLog, getAllLogSummaries, appendActivity } from "./task-log";
import { loadProjects, saveProjects, addTaskToProject, removeTaskFromProject, createProject, updateProject, autoOrganize, getProjectBoardData } from "./projects";
import { loadOracleAssignments, setOracleProject, clearOracleProject } from "./oracle-projects";

app.get("/api/task-log", (c) => {
  const taskId = c.req.query("taskId");
  if (!taskId) return c.json({ error: "taskId required" }, 400);
  return c.json({ taskId, activities: readTaskLog(taskId) });
});

app.get("/api/task-log/summaries", (c) => {
  return c.json(getAllLogSummaries());
});

app.post("/api/task-log", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.taskId || !body.content) return c.json({ error: "taskId and content required" }, 400);
    const activity = appendActivity({
      taskId: body.taskId,
      type: body.type || "note",
      oracle: body.oracle || "api",
      content: body.content,
      meta: body.meta,
    });
    return c.json({ ok: true, activity });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Projects ---

app.get("/api/projects", (c) => {
  return c.json(loadProjects());
});

app.post("/api/projects", async (c) => {
  try {
    const body = await c.req.json();
    if (body.action === "create") {
      const project = createProject(body.id, body.name, body.description || "");
      return c.json({ ok: true, project });
    } else if (body.action === "update") {
      const project = updateProject(body.id, body.updates || {});
      return c.json({ ok: true, project });
    } else if (body.action === "add-task") {
      addTaskToProject(body.projectId, body.taskId, body.parentTaskId);
      return c.json({ ok: true });
    } else if (body.action === "remove-task") {
      removeTaskFromProject(body.projectId, body.taskId);
      return c.json({ ok: true });
    } else if (body.action === "auto-organize") {
      const { fetchBoardData: fetchBoard } = await import("./board");
      const items = await fetchBoard();
      const result = autoOrganize(items);
      return c.json({ ok: true, ...result });
    } else {
      return c.json({ error: "unknown action" }, 400);
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get("/api/project-board", async (c) => {
  try {
    const { fetchBoardData: fetchBoard } = await import("./board");
    const items = await fetchBoard(c.req.query("filter") || undefined);
    const data = getProjectBoardData(items);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Oracle Project Assignments ---

app.get("/api/oracle-projects", (c) => {
  const data = loadOracleAssignments();
  const projects = loadProjects();
  const allProjects = projects.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt }));
  return c.json({ ...data, activeProjects: allProjects });
});

app.post("/api/oracle-projects", async (c) => {
  try {
    const { oracle, projectId, source } = await c.req.json();
    if (!oracle) return c.json({ error: "oracle required" }, 400);
    if (projectId) {
      const entry = setOracleProject(oracle, projectId, source || "manual");
      // Notify oracle via tmux
      try {
        const target = findWindow(await listSessions(), oracle) || findWindow(await listSessions(), `${oracle}-oracle`);
        if (target) {
          await sendKeys(target, `PROJECT FOCUS CHANGED: ${projectId} — Read: ~/.maw/projects/${projectId}/README.md`);
        }
      } catch {}
      return c.json({ ok: true, entry });
    } else {
      clearOracleProject(oracle);
      try {
        const target = findWindow(await listSessions(), oracle) || findWindow(await listSessions(), `${oracle}-oracle`);
        if (target) {
          await sendKeys(target, `PROJECT FOCUS CLEARED`);
        }
      } catch {}
      return c.json({ ok: true, cleared: true });
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Project Repo Mappings & Sync ---

app.get("/api/project-repos", (c) => {
  const { getRepoMappings } = require("./projects");
  return c.json({ mappings: getRepoMappings() });
});

app.post("/api/project-repos", async (c) => {
  try {
    const { projectId, repo, action } = await c.req.json();
    if (!projectId || !repo) return c.json({ error: "projectId and repo required" }, 400);
    const { addRepoToProject, removeRepoFromProject } = await import("./projects");
    if (action === "remove") {
      removeRepoFromProject(projectId, repo);
    } else {
      addRepoToProject(projectId, repo);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.post("/api/project-sync", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { syncAllProjects, syncProjectById } = await import("./project-sync");
    const results = (body as any).projectId
      ? await syncProjectById((body as any).projectId)
      : await syncAllProjects();
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/project-scaffold", async (c) => {
  try {
    const { projectId } = await c.req.json();
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const { loadProjects: lp } = await import("./projects");
    const project = lp().projects.find((p: any) => p.id === projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!project.repos?.length) return c.json({ error: "no repos linked" }, 400);
    const { scaffoldRepo } = await import("./project-files");
    const results: any[] = [];
    for (const repo of project.repos) {
      results.push({ repo, ...(await scaffoldRepo(repo, project)) });
    }
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Fleet Config ---

const fleetDir = join(import.meta.dir, "../fleet");

app.get("/api/fleet-config", (c) => {
  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => JSON.parse(readFileSync(join(fleetDir, f), "utf-8")));
    return c.json({ configs });
  } catch (e: any) {
    return c.json({ configs: [], error: e.message });
  }
});

// List all config files (maw.config.json + fleet/*.json + fleet/*.json.disabled)
app.get("/api/config-files", (c) => {
  const files: { name: string; path: string; enabled: boolean }[] = [
    { name: "maw.config.json", path: "maw.config.json", enabled: true },
  ];
  try {
    const entries = readdirSync(fleetDir).filter(f => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
    for (const f of entries) {
      const enabled = !f.endsWith(".disabled");
      files.push({ name: f, path: `fleet/${f}`, enabled });
    }
  } catch {}
  return c.json({ files });
});

// Read a single config file
app.get("/api/config-file", (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  try {
    const content = readFileSync(fullPath, "utf-8");
    // For maw.config.json, mask env values
    if (filePath === "maw.config.json") {
      const data = JSON.parse(content);
      const display = configForDisplay();
      data.env = display.envMasked;
      return c.json({ content: JSON.stringify(data, null, 2) });
    }
    return c.json({ content });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Save a config file
app.post("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  // Only allow maw.config.json and fleet/ files
  if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
    return c.json({ error: "invalid path" }, 403);
  }
  try {
    const { content } = await c.req.json();
    JSON.parse(content); // validate JSON
    const fullPath = join(import.meta.dir, "..", filePath);
    if (filePath === "maw.config.json") {
      // Handle masked env values
      const parsed = JSON.parse(content);
      if (parsed.env && typeof parsed.env === "object") {
        const current = loadConfig();
        for (const [k, v] of Object.entries(parsed.env as Record<string, string>)) {
          if (/\u2022/.test(v)) parsed.env[k] = current.env[k] || v;
        }
      }
      saveConfig(parsed);
    } else {
      writeFileSync(fullPath, content + "\n", "utf-8");
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Toggle enable/disable a fleet file
app.post("/api/config-file/toggle", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "invalid path" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  const isDisabled = filePath.endsWith(".disabled");
  const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
  const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
  renameSync(fullPath, newPath);
  return c.json({ ok: true, newPath: newRelPath });
});

// Delete a fleet file
app.delete("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "cannot delete" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  unlinkSync(fullPath);
  return c.json({ ok: true });
});

// Create a new fleet file
app.put("/api/config-file", async (c) => {
  const { name, content } = await c.req.json();
  if (!name || !name.endsWith(".json")) return c.json({ error: "name must end with .json" }, 400);
  const safeName = basename(name);
  const fullPath = join(fleetDir, safeName);
  if (existsSync(fullPath)) return c.json({ error: "file already exists" }, 409);
  try { JSON.parse(content); } catch { return c.json({ error: "invalid JSON" }, 400); }
  writeFileSync(fullPath, content + "\n", "utf-8");
  return c.json({ ok: true, path: `fleet/${safeName}` });
});

// --- Config API ---
app.get("/api/config", async (c) => {
  const config = loadConfig() as any;
  const display = configForDisplay();

  // Only expose this node's own agents — never aggregate remote oracles
  // Prevents federated peers from seeing internal team structure
  const localAgents: Record<string, string> = config.agents || {};
  const namedPeers: Record<string, string> = {};
  for (const p of getNamedPeers()) {
    namedPeers[p.name] = p.url;
  }

  return c.json({
    ...display,
    node: config.node || "local",
    officeTitle: config.officeTitle || undefined,
    agents: localAgents,
    namedPeers,
    rooms: config.rooms || {},
    // Mask federation token
    federationToken: undefined,
  });
});

app.post("/api/config", async (c) => {
  try {
    const body = await c.req.json();
    // If env has masked values (bullet chars), keep originals for those keys
    if (body.env && typeof body.env === "object") {
      const current = loadConfig();
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env as Record<string, string>)) {
        merged[k] = /\u2022/.test(v) ? (current.env[k] || v) : v;
      }
      body.env = merged;
    }
    saveConfig(body);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Worktree Hygiene ---
import { scanWorktrees, cleanupWorktree } from "./worktrees";

app.get("/api/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/worktrees/cleanup", async (c) => {
  const { path } = await c.req.json();
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    const log = await cleanupWorktree(path);
    return c.json({ ok: true, log });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Hall of Fame ---
const hallOfFamePath = join(process.env.HOME || "/home/user", "repos/github.com/YourOrg/HR-Oracle/hall-of-fame/data.json");

app.get("/api/hall-of-fame", (c) => {
  try {
    if (!existsSync(hallOfFamePath)) return c.json({ error: "data.json not found" }, 404);
    return c.json(JSON.parse(readFileSync(hallOfFamePath, "utf-8")));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Token Usage ---
import { loadIndex, buildIndex, summarize, realtimeRate } from "./token-index";

app.get("/api/tokens", (c) => {
  const rebuild = c.req.query("rebuild") === "1";
  const index = rebuild ? buildIndex() : loadIndex();
  if (index.sessions.length === 0) return c.json({ error: "No index. GET /api/tokens?rebuild=1" }, 404);
  return c.json({ ...summarize(index), updatedAt: index.updatedAt });
});

app.get("/api/tokens/rate", (c) => {
  const mode = c.req.query("mode") || "hour"; // "hour" = current clock hour, "window" = sliding window
  if (mode === "window") {
    const window = Math.min(7200, Math.max(60, +(c.req.query("window") || "300")));
    return c.json(realtimeRate(window));
  }
  // Current clock hour: from XX:00:00 to now
  const now = new Date();
  const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
  const elapsed = Math.max(1, Math.round((now.getTime() - hourStart.getTime()) / 1000));
  const result = realtimeRate(elapsed);
  return c.json({ ...result, hour: now.getHours(), elapsed });
});

// --- Maw Log (Oracle chat history) ---
import { readLog } from "./maw-log";

app.get("/api/maw-log", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(500, +(c.req.query("limit") || "200"));
  let entries = readLog();
  if (from) entries = entries.filter(e => e.from === from || e.to === from);
  if (to) entries = entries.filter(e => e.to === to || e.from === to);
  const total = entries.length;
  entries = entries.slice(-limit);
  return c.json({ entries, total });
});

// --- Oracle Progress ---
import { readProgress, getOracleProgress } from "./progress";

app.get("/api/progress", (c) => {
  return c.json(readProgress());
});

app.get("/api/progress/:oracle", (c) => {
  const oracle = c.req.param("oracle").toLowerCase();
  const progress = getOracleProgress(oracle);
  if (!progress) return c.json({ error: "no progress found" }, 404);
  return c.json(progress);
});

// --- Brain of Bank · HUD ---
// Ported from oracle-dashboard/src/brain-feed/heartbeats.ts (D3, commit 8cd4414).
// Feeds HeartbeatsWidget per Golden Rule #9.
import { getHeartbeats } from "./lib/heartbeat";

app.get("/api/brain/hud", (c) => {
  const heartbeats = getHeartbeats();
  return c.json({ heartbeats });
});

// --- Oracle Feed ---
const feedTailer = new FeedTailer(undefined, 1000);

app.get("/api/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const oracle = c.req.query("oracle") || undefined;
  let events = feedTailer.getRecent(1000);
  if (oracle) {
    const oLower = oracle.toLowerCase().replace(/-oracle$/i, "");
    events = events.filter(e => {
      const eName = (e.oracle || "").toLowerCase().replace(/-oracle$/i, "");
      return eName === oLower || e.oracle === oracle;
    });
  }
  events = events.slice(-limit);
  const active = [...feedTailer.getActive().keys()];
  return c.json({ events: events.reverse(), total: events.length, active_oracles: active });
});

// --- Federation Status ---

app.get("/api/federation/status", async (c) => {
  const peers = await checkPeerHealth();
  return c.json({ peers });
});

// --- Federation Thread Endpoints (HMAC-protected) ---

const FED_ORACLE_DIR = process.env.ORACLE_DATA_DIR || join(homedir(), ".oracle");
const FED_ALLOW_LIST = join(FED_ORACLE_DIR, "federation-threads.json");

function fedLoadAllowed(): number[] {
  try {
    const data = JSON.parse(readFileSync(FED_ALLOW_LIST, "utf-8"));
    return Array.isArray(data.allowed) ? data.allowed : [];
  } catch { return []; }
}

function fedGetDb(write = false): Database {
  const dbPath = join(FED_ORACLE_DIR, "oracle.db");
  const db = write
    ? new Database(dbPath)
    : new Database(dbPath, { readonly: true });
  if (write) db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** List federation-visible threads */
app.get("/api/federation/threads", requireHmac(), (c) => {
  const allowed = fedLoadAllowed();
  if (allowed.length === 0) return c.json({ threads: [] });

  const db = fedGetDb();
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

/** Read a single federation thread + messages */
app.get("/api/federation/thread/:id", requireHmac(), (c) => {
  const threadId = parseInt(c.req.param("id"), 10);
  if (isNaN(threadId)) return c.json({ error: "invalid thread id" }, 400);
  if (!fedLoadAllowed().includes(threadId)) return c.json({ error: "thread not in federation allow-list" }, 403);

  const db = fedGetDb();
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
app.post("/api/federation/thread/:id", requireHmac(), async (c) => {
  const threadId = parseInt(c.req.param("id"), 10);
  if (isNaN(threadId)) return c.json({ error: "invalid thread id" }, 400);
  if (!fedLoadAllowed().includes(threadId)) return c.json({ error: "thread not in federation allow-list" }, 403);

  const body = await c.req.json();
  const content = body.content;
  const author = body.author || c.req.header("x-maw-author") || "federation";
  if (!content || typeof content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const db = fedGetDb(true);
  try {
    const thread = db.query("SELECT id FROM forum_threads WHERE id = ?").get(threadId);
    if (!thread) return c.json({ error: "thread not found" }, 404);

    const now = Date.now();
    const result = db.query(
      `INSERT INTO forum_messages (thread_id, role, content, author, created_at)
       VALUES (?, 'claude', ?, ?, ?)`
    ).run(threadId, content, author, now);

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

// --- Peer Exec (federation read-only relay for Neo/maw-ui) ---

const PE_SESSION_TOKEN = crypto.randomUUID().replace(/-/g, "");
const PE_COOKIE_NAME = "pe_session";
const PE_COOKIE_MAX_AGE = 60 * 60 * 24;

const READONLY_CMDS = ["/dig", "/trace", "/recap", "/standup", "/who-are-you", "/philosophy", "/where-we-are"];

function isReadOnlyCmd(cmd: string): boolean {
  const trimmed = cmd.trim();
  return READONLY_CMDS.some((prefix) => trimmed === prefix || trimmed.startsWith(prefix + " "));
}

function parseSignature(sig: string): { originHost: string; originAgent: string; isAnon: boolean } | null {
  const m = sig.match(/^\[([^:\]]+):([^\]]+)\]$/);
  if (!m) return null;
  return { originHost: m[1], originAgent: m[2], isAnon: m[2].startsWith("anon-") };
}

function resolvePeerUrl(peer: string): string | null {
  const config = loadConfig() as any;
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const match = namedPeers.find((p) => p.name === peer);
  if (match) return match.url;
  if (/^[\w.-]+:\d+$/.test(peer)) return `http://${peer}`;
  if (peer.startsWith("http://") || peer.startsWith("https://")) return peer;
  return null;
}

app.get("/api/peer/session", (c) => {
  c.header("Set-Cookie", `${PE_COOKIE_NAME}=${PE_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/peer; Max-Age=${PE_COOKIE_MAX_AGE}`);
  return c.json({ ok: true, rotates: "on_server_restart" });
});

app.post("/api/peer/exec", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);

  const { peer, cmd, args = [], signature } = body as { peer?: string; cmd?: string; args?: string[]; signature?: string };
  if (!peer || !cmd || !signature) return c.json({ error: "missing_fields", required: ["peer", "cmd", "signature"] }, 400);

  const parsed = parseSignature(signature);
  if (!parsed) return c.json({ error: "bad_signature", expected: "[host:agent]" }, 400);

  // Trust boundary: readonly cmds always permitted, shell cmds require shellPeers whitelist
  const readonly = isReadOnlyCmd(cmd);
  if (!readonly) {
    const config = loadConfig() as any;
    const allowed: string[] = config?.wormhole?.shellPeers ?? [];
    if (!allowed.includes(parsed.originHost)) {
      return c.json({
        error: "shell_peer_denied",
        origin: parsed.originHost,
        hint: parsed.isAnon
          ? "anonymous browser visitors are read-only"
          : "add this origin to config.wormhole.shellPeers to permit shell cmds",
      }, 403);
    }
  }

  const peerUrl = resolvePeerUrl(peer);
  if (!peerUrl) return c.json({ error: "unknown_peer", peer }, 404);

  // Relay to peer with HMAC
  try {
    const start = Date.now();
    const path = "/api/peer/exec";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const config = loadConfig() as any;
    if (config?.federationToken) Object.assign(headers, signHeaders(config.federationToken, "POST", path));

    const response = await fetch(`${peerUrl}${path}`, { method: "POST", headers, body: JSON.stringify({ cmd, args, signature }) });
    const text = await response.text();

    return c.json({
      output: text,
      from: peerUrl,
      elapsed_ms: Date.now() - start,
      status: response.status,
      trust_tier: readonly ? "readonly" : "shell_allowlisted",
    });
  } catch (err: any) {
    return c.json({ error: "relay_failed", peer: peerUrl, reason: err?.message ?? String(err) }, 502);
  }
});

// --- Aggregated Sessions (local + remote) ---

app.get("/api/sessions/federated", async (c) => {
  const localSessions = await listSessions().catch(() => []);
  const result = await aggregateSessions(localSessions);
  return c.json(result);
});

// --- Oracle Health API ---

app.get("/api/oracle-health", (c) => {
  if (!engine) {
    return c.json({ error: "Server not fully initialized", timestamp: new Date().toISOString() }, 503);
  }
  const summary = engine.getHealthSummary();
  if (!summary) {
    return c.json({ error: "Health data not yet available — check back in 30s", timestamp: new Date().toISOString() }, 503);
  }
  return c.json(summary);
});

// --- BoB Face SSE (WALL-E Eyes emotion state) ---
// Emotions: neutral, thinking, happy, alert, confused, working, sleeping, error
app.get("/api/bob/state", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
      };

      let lastEmotion = "";
      let idleSince = Date.now();

      const tick = () => {
        const active = feedTailer.getActive();       // 5-min window
        const recent = feedTailer.getActive(15_000);  // 15s window for "live" activity
        const activeCount = active.size;
        const recentCount = recent.size;
        const hour = (new Date().getUTCHours() + 7) % 24; // Bangkok hour

        // Check for recent errors (PostToolUseFailure in last 30s)
        const recentEvents = feedTailer.getRecent(50);
        const now = Date.now();
        const hasRecentError = recentEvents.some(
          (e) => e.event === "PostToolUseFailure" && now - e.ts < 30_000,
        );

        // Check for recent task completions (last 10s)
        const hasRecentComplete = recentEvents.some(
          (e) => e.event === "TaskCompleted" && now - e.ts < 10_000,
        );

        // Derive emotion from real fleet state
        let emotion = "neutral";
        let message: string | null = null;

        if (hasRecentError) {
          // Error state — something just failed
          emotion = "error";
          const errEvent = recentEvents.find(
            (e) => e.event === "PostToolUseFailure" && now - e.ts < 30_000,
          );
          message = errEvent
            ? `${errEvent.oracle}: ${errEvent.message.slice(0, 60)}`
            : "Something went wrong";
        } else if (hasRecentComplete) {
          // Happy — task just completed
          emotion = "happy";
          const doneEvent = recentEvents.find(
            (e) => e.event === "TaskCompleted" && now - e.ts < 10_000,
          );
          message = doneEvent ? `${doneEvent.oracle} finished a task!` : "Task done!";
        } else if (activeCount === 0 && hour >= 0 && hour < 6) {
          // Late night + no activity → sleeping
          emotion = "sleeping";
          message = "zzZ...";
        } else if (activeCount === 0) {
          // No oracles active — check how long idle
          const idleDuration = now - idleSince;
          if (idleDuration > 5 * 60_000) {
            emotion = "sleeping";
            message = null;
          } else {
            emotion = "neutral";
            message = null;
          }
        } else if (recentCount >= 3) {
          // Many oracles actively working right now
          emotion = "working";
          const names = [...recent.keys()].slice(0, 3).join(", ");
          message = `${recentCount} oracles busy: ${names}`;
        } else if (recentCount >= 1) {
          // Oracles doing tool calls right now → thinking
          const latestOracle = [...recent.values()][0];
          const isToolUse = latestOracle?.event === "PreToolUse";
          if (isToolUse) {
            emotion = "thinking";
            message = `${latestOracle.oracle} is working...`;
          } else {
            emotion = "working";
            const names = [...recent.keys()].join(", ");
            message = `watching ${names}`;
          }
        } else if (activeCount >= 1) {
          // Oracles active but not in last 15s → alert (winding down)
          emotion = "alert";
          const names = [...active.keys()].slice(0, 3).join(", ");
          message = `${activeCount} oracle${activeCount > 1 ? "s" : ""} online: ${names}`;
        }

        // Track idle start
        if (activeCount > 0) idleSince = now;

        // Only send if emotion changed (reduce noise)
        const payload = { emotion, message, activeCount, timestamp: new Date().toISOString() };
        if (emotion !== lastEmotion) {
          send(payload);
          lastEmotion = emotion;
        } else {
          // Still send periodic heartbeat every 5 ticks (25s)
          send(payload);
        }
      };

      tick();
      const id = setInterval(tick, 5000);
      c.req.raw.signal.addEventListener("abort", () => clearInterval(id));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// --- BoB Chat (via maw hey bob) ---
const BOB_PANE = process.env.BOB_PANE || "01-bob:0";
app.post("/api/bob/chat", async (c) => {
  const body = await c.req.json<{ message: string }>();
  if (!body.message?.trim()) {
    return c.json({ error: "message required" }, 400);
  }

  try {
    // Capture pane BEFORE sending to get baseline
    const before = await capture(BOB_PANE, 40);
    const beforeLines = before.split("\n").length;

    // Send via maw hey bob (audit trail + proper oracle communication)
    const proc = Bun.spawn(["bun", "src/cli.ts", "hey", "bob", body.message], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Poll for BoB's response in tmux (up to 30s)
    let response = "";
    const maxAttempts = 30;
    let settled = 0;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const after = await capture(BOB_PANE, 60);
      const afterLines = after.split("\n");

      const newLines = afterLines.slice(beforeLines).join("\n").trim();
      if (newLines.length > 0) {
        if (newLines === response) {
          settled++;
          if (settled >= 3) break;
        } else {
          response = newLines;
          settled = 0;
        }
      }
    }

    // Clean ANSI escape codes
    const clean = response.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();

    return c.json({ response: clean || "(BoB didn't respond — he may be busy)" });
  } catch (err: any) {
    return c.json({ error: `maw hey error: ${err.message}` }, 500);
  }
});

// --- Anti-Pattern Scan API ---
app.get("/api/anti-patterns", (c) => {
  const { runAntiPatternScan } = require("./anti-patterns");
  return c.json(runAntiPatternScan());
});

// --- Sovereign Status API ---
app.get("/api/sovereign", (c) => {
  const { getSovereignStatus, verifySovereignHealth } = require("./commands/sovereign");
  return c.json({ status: getSovereignStatus(), health: verifySovereignHealth() });
});

// --- Wake API (for health page restart when no tmux session exists) ---
app.post("/api/wake/:oracle", async (c) => {
  const oracle = c.req.param("oracle");
  try {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "wake", oracle], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return c.json({ ok: true, oracle });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Loops API ---
const loopEngine = new LoopEngine();

app.get("/api/loops", (c) => {
  return c.json({ enabled: loopEngine.isEnabled(), loops: loopEngine.getStatus() });
});

app.get("/api/loops/history", (c) => {
  const loopId = c.req.query("loopId") || undefined;
  const limit = +(c.req.query("limit") || "50");
  return c.json(loopEngine.getHistory(loopId, limit));
});

app.post("/api/loops/trigger", async (c) => {
  const { loopId } = await c.req.json();
  if (!loopId) return c.json({ error: "loopId required" }, 400);
  const result = await loopEngine.triggerLoop(loopId);
  return c.json(result);
});

app.post("/api/loops/add", async (c) => {
  try {
    const newLoop = await c.req.json();
    if (!newLoop.id || !newLoop.schedule) return c.json({ error: "id and schedule required" }, 400);
    const { readFileSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const loopsPath = join(process.env.HOME || "/home/user", ".maw", "loops.json");
    const config = JSON.parse(readFileSync(loopsPath, "utf-8"));
    const idx = config.loops.findIndex((l: any) => l.id === newLoop.id);
    if (idx >= 0) {
      config.loops[idx] = { ...config.loops[idx], ...newLoop };
    } else {
      config.loops.push(newLoop);
    }
    writeFileSync(loopsPath, JSON.stringify(config, null, 2), "utf-8");
    return c.json({ ok: true, action: idx >= 0 ? "updated" : "added" });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete("/api/loops", async (c) => {
  const loopId = c.req.query("id");
  if (!loopId) return c.json({ error: "id required" }, 400);
  const { readFileSync, writeFileSync } = await import("fs");
  const { join } = await import("path");
  const loopsPath = join(process.env.HOME || "/home/user", ".maw", "loops.json");
  const config = JSON.parse(readFileSync(loopsPath, "utf-8"));
  const before = config.loops.length;
  config.loops = config.loops.filter((l: any) => l.id !== loopId);
  writeFileSync(loopsPath, JSON.stringify(config, null, 2), "utf-8");
  return c.json({ ok: config.loops.length < before });
});

app.post("/api/loops/toggle", async (c) => {
  const { loopId, enabled } = await c.req.json();
  if (loopId) {
    const ok = loopEngine.toggleLoop(loopId, enabled);
    return c.json({ ok });
  } else {
    loopEngine.toggleEngine(enabled);
    return c.json({ ok: true });
  }
});

// Jarvis API proxy — forward /api/jarvis/* to Admin-Oracle :3200
const JARVIS_API_URL = process.env.JARVIS_API_URL || "http://localhost:3200";
app.all("/api/jarvis/*", async (c) => {
  const path = c.req.path; // e.g. /api/jarvis/stats
  const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
  const target = `${JARVIS_API_URL}${path}${qs}`;
  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: c.req.method !== "GET" ? { "Content-Type": "application/json" } : {},
      body: c.req.method !== "GET" ? await c.req.text() : undefined,
    });
    const data = await res.json();
    return c.json(data, res.status as any);
  } catch (e: any) {
    return c.json({ error: `Jarvis API unreachable: ${e.message}` }, 502);
  }
});

// --- File Attachments ---
import { mkdirSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { extname } from "path";
import { execSync } from "child_process";

const attachDir = join(import.meta.dir, "../attachments");
mkdirSync(attachDir, { recursive: true });

const IMAGE_MAX_PX = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"]);

/** Resize image in-place if any dimension exceeds IMAGE_MAX_PX. Uses ImageMagick. */
function resizeImageIfNeeded(filePath: string): void {
  try {
    const info = execSync(`identify -format "%w %h" "${filePath}" 2>/dev/null`, { encoding: "utf-8" }).trim();
    const [w, h] = info.split(" ").map(Number);
    if (!w || !h || (w <= IMAGE_MAX_PX && h <= IMAGE_MAX_PX)) return;
    execSync(`convert "${filePath}" -resize ${IMAGE_MAX_PX}x${IMAGE_MAX_PX}\\> "${filePath}"`, { timeout: 15000 });
  } catch { /* ImageMagick not available or not an image — skip silently */ }
}

app.post("/api/attach", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) return c.json({ error: "file required" }, 400);

    // Limit to 20MB
    if (file.size > 20 * 1024 * 1024) return c.json({ error: "file too large (max 20MB)" }, 400);

    const ext = extname(file.name).toLowerCase() || "";
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const buf = await file.arrayBuffer();
    const fullPath = join(attachDir, id);
    writeFileSync(fullPath, Buffer.from(buf));

    // Auto-resize images >2000px to avoid Claude API "dimension limit" error
    const isImage = IMAGE_EXTS.has(ext) || file.type.startsWith("image/");
    if (isImage) resizeImageIfNeeded(fullPath);

    // Also copy to ~/.maw/inbox/ with original filename so oracles can read by path
    const inboxDir = join(homedir(), ".maw", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const inboxPath = join(inboxDir, file.name);
    // Copy the (possibly resized) file from attachDir
    const resizedBuf = readFileSync(fullPath);
    writeFileSync(inboxPath, resizedBuf);

    const finalSize = resizedBuf.length;
    const url = `/api/attachments/${id}`;
    const localPath = inboxPath; // file path for Claude Code to read directly
    return c.json({ ok: true, id, url, localUrl: localPath, name: file.name, size: finalSize, mimeType: file.type });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get("/api/attachments/:id", (c) => {
  const id = c.req.param("id");
  // Sanitize: only allow filename chars
  if (!id || /[/\\]/.test(id)) return c.json({ error: "invalid id" }, 400);
  const fullPath = join(attachDir, id);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  const file = Bun.file(fullPath);
  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// Dashboard health check widget — consolidated system status (#86)
app.get("/api/health-check", async (c) => {
  const checks: { name: string; status: "green" | "yellow" | "red"; detail: string }[] = [];
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const check = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const err = await fn();
      checks.push({ name, status: err ? "red" : "green", detail: clean(err || "ok") });
    } catch (e: any) {
      checks.push({ name, status: "red", detail: clean(e.message || "error") });
    }
  };

  const run = (cmd: string): string => {
    try {
      const r = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
      return clean(new TextDecoder().decode(r.stdout));
    } catch { return ""; }
  };

  // PM2 services
  for (const svc of ["maw", "maw-bob", "arra-api", "maw-syslog", "app-line", "bot-discord"]) {
    await check(`PM2: ${svc}`, async () => {
      const pid = run(`pm2 pid ${svc} 2>/dev/null`);
      return pid && pid !== "0" ? null : "not running";
    });
  }

  // Port checks
  for (const p of [{ port: 3456, name: "maw-js" }, { port: 3457, name: "maw-bob" }, { port: 47778, name: "arra-api" }, { port: 3200, name: "app-line" }]) {
    await check(`Port :${p.port} (${p.name})`, async () => {
      try {
        const res = await fetch(`http://localhost:${p.port}/`, { signal: AbortSignal.timeout(3000) });
        return res.ok || res.status === 302 ? null : `HTTP ${res.status}`;
      } catch { return "unreachable"; }
    });
  }

  // Cloudflared
  await check("Cloudflared", async () => run("pgrep -f cloudflared >/dev/null && echo ok || echo down") === "ok" ? null : "not running");

  // Ollama
  await check("Ollama", async () => run("pgrep -f ollama >/dev/null && echo ok || echo down") === "ok" ? null : "not running");

  // Tmux fleet
  await check("Tmux fleet", async () => {
    const count = parseInt(run("tmux list-sessions 2>/dev/null | wc -l")) || 0;
    return count >= 20 ? null : count >= 10 ? `${count} sessions` : `${count} — fleet down`;
  });

  // Tmux window size
  await check("Tmux 200x200", async () => {
    const size = run("tmux display-message -t '01-bob:0' -p '#{window_width}x#{window_height}' 2>/dev/null");
    return size === "200x200" ? null : `${size} (need 200x200)`;
  });

  const greenCount = checks.filter(c => c.status === "green").length;
  const redCount = checks.filter(c => c.status === "red").length;

  return c.json({
    timestamp: new Date().toISOString(),
    overall: redCount === 0 ? "healthy" : redCount <= 2 ? "degraded" : "unhealthy",
    green: greenCount,
    red: redCount,
    total: checks.length,
    checks,
  });
});

// Supervisor stale-task audit endpoint
app.get("/api/supervisor/audit-stale", async (c) => {
  try {
    const { BobSupervisor } = await import("./supervisor");
    const supervisor = new BobSupervisor();
    const result = await supervisor.auditStaleCompleted();
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Voice interface for BoB (#154) ---

const BOB_VOICE_TARGET = "01-bob:0";
const BOB_VOICE_ID = "CwhRBWXzGAHq8TQ4Fs17"; // Roger — laid-back conversational

// ElevenLabs config — loaded from ~/.oracle/security/elevenlabs.env
function loadElevenLabsConfig() {
  try {
    const env = readFileSync(join(process.env.HOME || "/tmp", ".oracle/security/elevenlabs.env"), "utf-8");
    const vars: Record<string, string> = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (m) vars[m[1]] = m[2].trim();
    }
    return vars;
  } catch { return {}; }
}

// Strip ANSI + Claude Code chrome from capture output
function cleanCaptureForVoice(raw: string): string {
  return raw.replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter(l => {
      const t = l.trim();
      if (!t) return false;
      if (/^[❯>$%#]/.test(t)) return false;
      if (/bypass permissions|shift\+tab to cycle/.test(t)) return false;
      if (/^\d+%\s+\d+k\/\d+k/.test(t)) return false;
      if (/^[●○✻⎿╭╰─━]/.test(t)) return false;
      if (/^Running \d+ (shell|Bash)/.test(t)) return false;
      if (/^\$ /.test(t)) return false;
      return true;
    })
    .join("\n").trim();
}

// Streaming voice: tmux send-keys → poll capture 500ms → ElevenLabs stream TTS
app.post("/api/voice/stream", async (c) => {
  const { transcript } = await c.req.json();
  if (!transcript) return c.json({ error: "transcript required" }, 400);

  const elCreds = loadElevenLabsConfig();

  try {
    // Snapshot before — use cleaned line count as baseline
    const beforeClean = cleanCaptureForVoice(await capture(BOB_VOICE_TARGET, 40));
    const beforeHash = beforeClean.length;

    // Send transcript to BoB
    await sendKeys(BOB_VOICE_TARGET, transcript + "\r");

    // Poll capture every 500ms for new content
    let response = "";
    let lastHash = beforeHash;
    let stableCount = 0;

    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 500));

      const nowRaw = await capture(BOB_VOICE_TARGET, 60);
      const nowClean = cleanCaptureForVoice(nowRaw);
      const nowHash = nowClean.length;

      if (nowHash <= beforeHash) continue;

      // New content appeared
      if (nowHash === lastHash) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHash = nowHash;
      }

      // Check if BoB is done — raw capture shows prompt or status bar
      const rawLast = nowRaw.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(l => l.trim()).pop() || "";
      const isDone = /^[❯>]/.test(rawLast.trim()) || /bypass permissions/.test(rawLast);

      // Done: prompt returned OR content stable 2.5s (5 × 500ms)
      if (isDone || stableCount >= 5) {
        // Extract only new content by diffing
        const beforeLines = beforeClean.split("\n");
        const nowLines = nowClean.split("\n");
        // Find first divergence point
        let diverge = 0;
        for (let j = 0; j < Math.min(beforeLines.length, nowLines.length); j++) {
          if (beforeLines[j] !== nowLines[j]) { diverge = j; break; }
          diverge = j + 1;
        }
        response = nowLines.slice(diverge).join("\n").trim();
        break;
      }
    }

    if (!response) {
      return c.json({ error: "timeout — BoB didn't respond within 60s", text: "" }, 504);
    }

    // ElevenLabs streaming TTS
    if (elCreds.ELEVENLABS_API_KEY) {
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${BOB_VOICE_ID}/stream`, {
        method: "POST",
        headers: {
          "xi-api-key": elCreds.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: response.slice(0, 1000),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          optimize_streaming_latency: 3,
        }),
      });

      if (ttsRes.ok) {
        return new Response(ttsRes.body, {
          headers: {
            "Content-Type": "audio/mpeg",
            "X-Voice-Text": encodeURIComponent(response.slice(0, 500)),
            "Cache-Control": "no-cache",
          },
        });
      }
    }

    return c.json({ ok: true, text: response });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// TTS endpoint — convert text to speech via ElevenLabs (non-streaming)
app.post("/api/voice/tts", async (c) => {
  const { text } = await c.req.json();
  if (!text) return c.json({ error: "text required" }, 400);

  const creds = loadElevenLabsConfig();
  const apiKey = creds.ELEVENLABS_API_KEY;
  if (!apiKey) return c.json({ error: "ElevenLabs API key not configured" }, 500);

  const voiceId = c.req.query("voice") || "CwhRBWXzGAHq8TQ4Fs17"; // Roger — conversational

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.slice(0, 1000),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: `ElevenLabs error: ${res.status} ${err.slice(0, 200)}` }, 502);
    }

    return new Response(res.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/voice", async (c) => {
  const { transcript } = await c.req.json();
  if (!transcript) return c.json({ error: "transcript required" }, 400);

  console.log(`[voice] received: "${transcript}"`);

  try {
    // Capture snapshot BEFORE sending
    const beforeSnap = await capture(BOB_VOICE_TARGET, 50);

    // Send transcript to BoB
    await sendKeys(BOB_VOICE_TARGET, transcript + "\r");
    console.log(`[voice] sent to tmux`);

    // Wait for BoB to start processing (give Claude 3s to begin)
    await new Promise(r => setTimeout(r, 3000));

    // Poll for response — check every 1s, max 90s
    let response = "";
    let lastCapture = "";
    let stableCount = 0;

    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const current = await capture(BOB_VOICE_TARGET, 50);
      const cleaned = current.replace(/\x1b\[[0-9;]*m/g, "");

      // Check for idle indicators (BoB finished responding)
      const lines = cleaned.split("\n").filter(l => l.trim());
      const lastLine = lines[lines.length - 1] || "";
      const secondLast = lines[lines.length - 2] || "";

      // Detect idle: prompt line starts with ❯ or contains "bypass permissions"
      const isIdle = /^❯/.test(lastLine.trim()) ||
                     /bypass permissions/.test(lastLine) ||
                     /bypass permissions/.test(secondLast) ||
                     /Sautéed|Baked|Brewed|Churned|Crunched|Cooked|Nucleating|Harmonizing|Cogitated/.test(lastLine);

      // Check if content stopped changing (stable for 3 rounds = done)
      if (current === lastCapture) {
        stableCount++;
        if (stableCount >= 3 && i > 5) {
          // Content stable for 3s and we've waited at least 8s
          break;
        }
      } else {
        stableCount = 0;
        lastCapture = current;
      }

      if (isIdle && i > 3) {
        // BoB is idle — extract response
        break;
      }
    }

    // Extract BoB's response — everything between the sent transcript and the idle prompt
    const finalCapture = await capture(BOB_VOICE_TARGET, 50);
    const finalCleaned = finalCapture.replace(/\x1b\[[0-9;]*m/g, "");
    const finalLines = finalCleaned.split("\n").filter(l => l.trim());

    // Find where transcript was echoed, then take everything after until prompt
    let startIdx = -1;
    for (let i = 0; i < finalLines.length; i++) {
      if (finalLines[i].includes(transcript.slice(0, 30))) {
        startIdx = i + 1;
        break;
      }
    }

    if (startIdx > 0) {
      // Collect response lines (skip status bar, prompt, tool indicators)
      const responseLines = [];
      for (let i = startIdx; i < finalLines.length; i++) {
        const line = finalLines[i].trim();
        if (/^❯/.test(line)) break;
        if (/^📡/.test(line)) break;
        if (/^⏵⏵/.test(line)) break;
        if (/^────/.test(line)) break;
        if (/bypass permissions/.test(line)) break;
        if (/Opus 4\.6/.test(line)) break;
        if (/Sautéed|Baked|Brewed|Churned/.test(line)) continue;
        if (line.length > 0) responseLines.push(line);
      }
      response = responseLines.join("\n").trim();
    }

    // Fallback: if no response found, get the diff from before
    if (!response) {
      const beforeLines = new Set(beforeSnap.split("\n").map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim()));
      const newLines = finalCleaned.split("\n")
        .map(l => l.trim())
        .filter(l => l && !beforeLines.has(l) && !/^❯|^📡|^⏵⏵|^────|bypass|Opus/.test(l));
      response = newLines.join("\n").trim();
    }

    console.log(`[voice] response: "${response.slice(0, 100)}..."`);

    return c.json({
      ok: true,
      transcript,
      response: response || "(BoB is still thinking... try again in a moment)",
      target: BOB_VOICE_TARGET,
    });
  } catch (e: any) {
    console.error(`[voice] error:`, e);
    return c.json({ error: e.message }, 500);
  }
});

// ElevenLabs webhook endpoint (with HMAC signature verification)
app.post("/api/voice-webhook", async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header("ElevenLabs-Signature") || "";

  // Verify HMAC signature if webhook secret is configured
  const creds = loadElevenLabsConfig();
  if (creds.ELEVENLABS_WEBHOOK_SECRET && sig) {
    const crypto = await import("crypto");
    const expected = crypto.createHmac("sha256", creds.ELEVENLABS_WEBHOOK_SECRET)
      .update(rawBody).digest("hex");
    if (sig !== expected && sig !== `sha256=${expected}`) {
      console.log(`[voice-webhook] HMAC mismatch — rejecting`);
      return c.json({ error: "invalid signature" }, 401);
    }
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return c.json({ error: "invalid JSON" }, 400); }

  const ts = new Date().toISOString();
  console.log(`[voice-webhook] ${ts} event=${body.type || "unknown"}`);

  if (body.type === "transcription_completed" && body.transcript) {
    try {
      await sendKeys(BOB_VOICE_TARGET, body.transcript + "\r");
      return c.json({ ok: true, routed: BOB_VOICE_TARGET });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }

  return c.json({ ok: true, ignored: true });
});

// Voice page status
app.get("/api/voice/status", async (c) => {
  try {
    const cmd = await getPaneCommand(BOB_VOICE_TARGET);
    const isActive = /claude|node/i.test(cmd);
    const lastLine = (await capture(BOB_VOICE_TARGET, 3)).split("\n").filter(l => l.trim()).pop() || "";
    return c.json({
      bobActive: isActive,
      target: BOB_VOICE_TARGET,
      lastLine: lastLine.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 200),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Voice page — self-contained HTML with Web Speech API (not SPA)
app.get("/voice", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BoB Voice</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}
.orb-container{position:relative;width:200px;height:200px;cursor:pointer;margin:20px}
.orb{width:200px;height:200px;border-radius:50%;background:radial-gradient(circle at 40% 40%,#4a9eff,#1a365d 70%);box-shadow:0 0 60px rgba(74,158,255,0.3);transition:all 0.3s}
.orb.listening{background:radial-gradient(circle at 40% 40%,#38a169,#1a5d36 70%);box-shadow:0 0 80px rgba(56,161,105,0.5);animation:pulse 1.5s infinite}
.orb.speaking{background:radial-gradient(circle at 40% 40%,#f59e0b,#5d3a1a 70%);box-shadow:0 0 80px rgba(245,158,11,0.5);animation:pulse 0.8s infinite}
.orb.processing{background:radial-gradient(circle at 40% 40%,#9f7aea,#3a1a5d 70%);box-shadow:0 0 80px rgba(159,122,234,0.5);animation:spin 2s linear infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@keyframes spin{0%{box-shadow:0 0 80px rgba(159,122,234,0.5)}50%{box-shadow:0 0 120px rgba(159,122,234,0.8)}100%{box-shadow:0 0 80px rgba(159,122,234,0.5)}}
.status{font-size:18px;margin:16px 0;color:#a0aec0;min-height:28px}
.transcript-box{background:#1a1a2e;border:1px solid #2d3748;border-radius:12px;padding:16px;margin:12px 20px;width:90%;max-width:600px;min-height:60px;font-size:16px;line-height:1.6}
.transcript-box.user{border-left:4px solid #38a169}
.transcript-box.bob{border-left:4px solid #4a9eff}
.label{font-size:12px;color:#718096;margin-bottom:4px}
.mode-toggle{background:#2d3748;color:#e0e0e0;border:none;padding:8px 16px;border-radius:20px;cursor:pointer;font-size:14px;margin:8px}
.mode-toggle.active{background:#38a169}
.controls{display:flex;gap:8px;margin:12px}
</style></head><body>
<h2 style="color:#4a9eff;margin-bottom:4px">BoB Voice</h2>
<p style="color:#718096;font-size:14px">Tap the orb or enable always-listen</p>

<div class="controls">
  <button class="mode-toggle" id="modeBtn" onclick="toggleMode()">Always Listen: OFF</button>
</div>

<div class="orb-container" onclick="toggleListen()">
  <div class="orb" id="orb"></div>
</div>
<div class="status" id="status">Tap to start</div>

<div class="transcript-box user" id="userBox" style="display:none">
  <div class="label">You said:</div>
  <div id="userText"></div>
</div>

<div class="transcript-box bob" id="bobBox" style="display:none">
  <div class="label">BoB:</div>
  <div id="bobText"></div>
</div>

<script>
const orb=document.getElementById('orb'),status=document.getElementById('status');
const userBox=document.getElementById('userBox'),userText=document.getElementById('userText');
const bobBox=document.getElementById('bobBox'),bobText=document.getElementById('bobText');
const modeBtn=document.getElementById('modeBtn');

let recognition=null,isListening=false,alwaysListen=false,isProcessing=false;

// Init Speech Recognition
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){status.textContent='Speech Recognition not supported — use Chrome';orb.style.opacity=0.3}
else{
  recognition=new SR();
  recognition.continuous=true;
  recognition.interimResults=true;
  recognition.lang='th-TH';

  recognition.onresult=(e)=>{
    let interim='',final='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal)final+=e.results[i][0].transcript;
      else interim+=e.results[i][0].transcript;
    }
    userBox.style.display='block';
    userText.textContent=final||interim;
    if(final&&!isProcessing){processTranscript(final)}
  };

  recognition.onend=()=>{
    isListening=false;
    if(alwaysListen&&!isProcessing){startListen()}
    else{orb.className='orb';status.textContent='Tap to start'}
  };

  recognition.onerror=(e)=>{
    console.error('STT error:',e.error);
    if(e.error==='not-allowed')status.textContent='Mic permission denied';
    else if(alwaysListen)setTimeout(()=>startListen(),1000);
  };
}

function startListen(){
  if(!recognition||isProcessing)return;
  try{recognition.start();isListening=true;orb.className='orb listening';status.textContent='Listening...'}
  catch(e){console.error(e)}
}

function stopListen(){
  if(!recognition)return;
  try{recognition.stop()}catch(e){}
  isListening=false;orb.className='orb';status.textContent='Tap to start';
}

function toggleListen(){
  if(isProcessing)return;
  if(isListening)stopListen();else startListen();
}

function toggleMode(){
  alwaysListen=!alwaysListen;
  modeBtn.textContent='Always Listen: '+(alwaysListen?'ON':'OFF');
  modeBtn.className='mode-toggle'+(alwaysListen?' active':'');
  if(alwaysListen&&!isListening)startListen();
}

async function processTranscript(text){
  isProcessing=true;
  orb.className='orb processing';
  status.textContent='BoB is thinking...';
  bobBox.style.display='block';
  bobText.textContent='...';

  try{
    const res=await fetch('/api/voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:text})});
    const data=await res.json();
    bobText.textContent=data.response||data.error||'No response';

    // TTS — speak BoB's response
    if(data.response&&data.response!=='(BoB is still thinking...)'){
      orb.className='orb speaking';
      status.textContent='BoB is speaking...';
      try{
        const ttsRes=await fetch('/api/voice/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:data.response.slice(0,500)})});
        if(ttsRes.ok){
          const blob=await ttsRes.blob();
          const audio=new Audio(URL.createObjectURL(blob));
          audio.onended=()=>{isProcessing=false;if(alwaysListen)startListen();else{orb.className='orb';status.textContent='Tap to start'}};
          audio.play();
        }else{isProcessing=false;if(alwaysListen)startListen()}
      }catch(e){console.error('TTS error:',e);isProcessing=false;if(alwaysListen)startListen()}
    }else{isProcessing=false;if(alwaysListen)startListen();orb.className='orb';status.textContent='Tap to start'}
  }catch(e){
    bobText.textContent='Error: '+e.message;
    isProcessing=false;orb.className='orb';status.textContent='Error — tap to retry';
    if(alwaysListen)setTimeout(()=>startListen(),2000);
  }
}
</script></body></html>`);
});

// SPA fallback — known UI paths serve the React app (hash routing handles the view)
for (const path of ["/office", "/office/*", "/dashboard", "/terminal"]) {
  app.get(path, serveStatic({ root: "./dist-office", path: "/index.html" }));
}

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- WebSocket + Server ---

import { handlePtyMessage, handlePtyClose, sweepOrphanPtySessions } from "./pty";
import { startPm2Watcher } from "./pm2-watcher";

export async function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  engine = new MawEngine({ feedTailer });

  const wsHandler = {
    open: (ws: any) => {
      if (ws.data.mode === "pty") return;
      engine.handleOpen(ws);
    },
    message: (ws: any, msg: any) => {
      if (ws.data.mode === "pty") { handlePtyMessage(ws, msg); return; }
      engine.handleMessage(ws, msg);
    },
    close: (ws: any) => {
      if (ws.data.mode === "pty") { handlePtyClose(ws); return; }
      engine.handleClose(ws);
    },
  };

  const fetchHandler = (req: Request, server: any) => {
    const url = new URL(req.url);
    // Protect WebSocket endpoints with auth
    if (url.pathname === "/ws/pty" || url.pathname === "/ws") {
      if (!isAuthenticated(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const mode = url.pathname === "/ws/pty" ? "pty" : undefined;
      const data = { target: null, previewTargets: new Set(), ...(mode ? { mode } : {}) } as WSData;
      if (server.upgrade(req, { data })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  };

  // HTTP server — retry bind on EADDRINUSE (maw-js#102)
  let server: ReturnType<typeof Bun.serve>;
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 2000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({ port, fetch: fetchHandler, websocket: wsHandler });
      break;
    } catch (e: any) {
      if (e?.code === "EADDRINUSE" && attempt < MAX_RETRIES) {
        console.log(`  ⚠ port ${port} in use — retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY}ms`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      } else {
        throw e;
      }
    }
  }

  // Graceful shutdown — free port immediately on SIGINT/SIGTERM (#102)
  const shutdown = () => {
    console.log("  🛑 Graceful shutdown — closing server...");
    try { server!.stop(true); } catch {}
    loopEngine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start Loop Engine
  loopEngine.start((msg) => engine.broadcast(msg));

  // Start PM2 Watcher — alert feed.log when P0 services die (#35)
  startPm2Watcher();

  // Periodic orphan-PTY sweep — kill leaked maw-pty-* tmux sessions (upstream #2414)
  const ptySweepTimer = setInterval(() => {
    sweepOrphanPtySessions()
      .then(({ killed, checked }) => {
        if (killed.length > 0) console.log(`[pty-sweep] killed ${killed.length} orphan(s): ${killed.join(", ")} (checked ${checked})`);
      })
      .catch((err) => console.error("[pty-sweep] failed:", err));
  }, 5 * 60 * 1000);
  (ptySweepTimer as any).unref?.();

  // Ensure a general-purpose "shell" tmux session with Claude Code exists
  tmux.hasSession("shell").then(async (exists) => {
    if (!exists) {
      await tmux.run("new-session", "-d", "-s", "shell", "-x", "200", "-y", "50").catch(() => {});
      // Auto-launch Claude Code in the shell session
      setTimeout(() => tmux.run("send-keys", "-t", "shell:0", "claude --dangerously-skip-permissions", "Enter").catch(() => {}), 1000);
    }
  });

  console.log(`maw serve → http://localhost:${port} (ws://localhost:${port}/ws)`);

  // HTTPS server (if mkcert certs exist — auto-detect hostname-based cert files)
  const hostname = process.env.MAW_HOST || "localhost";
  const certPath = join(import.meta.dir, `../${hostname}+3.pem`);
  const keyPath = join(import.meta.dir, `../${hostname}+3-key.pem`);
  if (existsSync(certPath) && existsSync(keyPath)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsHandler });
    console.log(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// --- Auto Status Heartbeat (every 15 min) ---
import { appendFileSync } from "fs";
import { MAW_LOG_PATH } from "./maw-log";

import { describeActivity } from "./lib/feed";

function statusHeartbeat() {
  try {
    const cutoff = Date.now() - 15 * 60_000;
    const events = feedTailer.getRecent(500).filter(e => e.ts >= cutoff);
    if (events.length === 0) return;

    // Only count real work events (tool uses, prompts)
    const workEvents = events.filter(e =>
      e.event === "PreToolUse" || e.event === "PostToolUse" ||
      e.event === "UserPromptSubmit" || e.event === "SubagentStart"
    );
    if (workEvents.length === 0) return;

    // Group by parent oracle (neo-mawjs → neo, hermes-bitkub → hermes)
    const byParent = new Map<string, { tools: number; projects: Set<string>; lastActivity: string }>();
    for (const e of workEvents) {
      // Extract parent: "neo-oracle" → "neo", "hermes-bitkub" → "hermes", "neo-mawjs" → "neo"
      const parent = e.oracle.split("-")[0];
      const prev = byParent.get(parent) || { tools: 0, projects: new Set(), lastActivity: "" };
      prev.tools++;
      const proj = e.project.split("/").pop() || "";
      if (proj) prev.projects.add(proj);
      prev.lastActivity = describeActivity(e);
      byParent.set(parent, prev);
    }

    // Token rate for the same window
    const rate = realtimeRate(15 * 60);
    const fmt = (n: number) => n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : `${n}`;

    // Build readable multiline
    const lines = [...byParent.entries()]
      .sort((a, b) => b[1].tools - a[1].tools)
      .map(([name, data]) => `${name}: ${data.tools} actions`);

    const msg = `${byParent.size} oracles, ${workEvents.length} actions\n${lines.join("\n")}\n${fmt(rate.totalPerMin)} tok/min (${fmt(rate.inputPerMin)} in, ${fmt(rate.outputPerMin)} out)`;

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      from: "system",
      to: "all",
      msg,
      ch: "heartbeat",
    }) + "\n";

    appendFileSync(MAW_LOG_PATH, entry);
  } catch {}
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  const server = startServer();
  // Start heartbeat after 1 min, then every 15 min
  setTimeout(() => {
    statusHeartbeat();
    setInterval(statusHeartbeat, 15 * 60 * 1000);
  }, 60_000);
}
