/**
 * Authentication middleware for maw-js dashboard
 * Session-based with cookie + login page
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { generateQRSvg } from "./lib/qr";

const AUTH_CONFIG_PATH = join(import.meta.dir, "../auth.json");
const SESSION_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

interface AuthConfig {
  enabled: boolean;
  username: string;
  passwordHash: string; // bcrypt-like hash
  sessions: Record<string, { createdAt: number; userAgent: string; ip?: string }>;
  allowLocal: boolean; // allow localhost without auth
}

function loadAuthConfig(): AuthConfig {
  try {
    if (existsSync(AUTH_CONFIG_PATH)) {
      return JSON.parse(readFileSync(AUTH_CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return { enabled: false, username: "", passwordHash: "", sessions: {}, allowLocal: true };
}

function saveAuthConfig(config: AuthConfig) {
  writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// bcrypt hashing via Bun.password (random per-password salt, cost 10)
async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

// Legacy FNV+fixed-salt hash (pre-bcrypt). Kept ONLY to verify existing
// stored hashes during the transition; rehashed to bcrypt on next login.
function legacyHashPassword(password: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "maw-salt-2026");
  let hash = 0x811c9dc5;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `maw1$${(hash >>> 0).toString(16)}$${data.length}`;
}

async function verifyPassword(password: string, hash: string): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (hash.startsWith("maw1$")) {
    // Legacy format — verify, signal caller to rehash with bcrypt.
    return { valid: legacyHashPassword(password) === hash, needsRehash: true };
  }
  try {
    const valid = await Bun.password.verify(password, hash);
    return { valid, needsRehash: false };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function isLocalRequest(req: Request): boolean {
  const host = new URL(req.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function getSessionFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/maw_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

export function isAuthenticated(req: Request): boolean {
  const config = loadAuthConfig();
  if (!config.enabled) return true;
  if (config.allowLocal && isLocalRequest(req)) return true;

  const sessionId = getSessionFromCookie(req);
  if (!sessionId) return false;

  const session = config.sessions[sessionId];
  if (!session) return false;

  // Check expiry
  if (Date.now() - session.createdAt > SESSION_EXPIRY) {
    delete config.sessions[sessionId];
    saveAuthConfig(config);
    return false;
  }

  return true;
}

export async function handleLogin(username: string, password: string, userAgent: string, ip?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const config = loadAuthConfig();

  if (config.username !== username) {
    return { ok: false, error: "Invalid credentials" };
  }

  const { valid, needsRehash } = await verifyPassword(password, config.passwordHash);
  if (!valid) {
    return { ok: false, error: "Invalid credentials" };
  }

  // Compare-then-rehash: upgrade legacy hashes to bcrypt on successful login.
  if (needsRehash) {
    config.passwordHash = await hashPassword(password);
  }

  // Purge expired sessions before creating new one
  const now = Date.now();
  for (const [id, session] of Object.entries(config.sessions)) {
    if (now - session.createdAt > SESSION_EXPIRY) {
      delete config.sessions[id];
    }
  }

  // Create session with IP
  const sessionId = generateSessionId();
  config.sessions[sessionId] = { createdAt: Date.now(), userAgent, ip: ip || "unknown" };

  // Clean old sessions (keep max 10)
  const entries = Object.entries(config.sessions).sort((a, b) => b[1].createdAt - a[1].createdAt);
  if (entries.length > 10) {
    config.sessions = Object.fromEntries(entries.slice(0, 10));
  }

  saveAuthConfig(config);
  return { ok: true, sessionId };
}

export function getActiveSessions(): { total: number; sessions: Array<{ id: string; createdAt: number; userAgent: string; ip?: string }> } {
  const config = loadAuthConfig();
  const now = Date.now();
  const active = Object.entries(config.sessions)
    .filter(([_, s]) => now - s.createdAt <= SESSION_EXPIRY)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([id, s]) => ({ id: id.slice(0, 12) + "...", createdAt: s.createdAt, userAgent: s.userAgent, ip: s.ip }));
  return { total: active.length, sessions: active };
}

export function handleLogout(req: Request): void {
  const sessionId = getSessionFromCookie(req);
  if (!sessionId) return;
  const config = loadAuthConfig();
  delete config.sessions[sessionId];
  saveAuthConfig(config);
}

export async function setupAuth(username: string, password: string): Promise<void> {
  const config = loadAuthConfig();
  config.enabled = true;
  config.username = username;
  config.passwordHash = await hashPassword(password);
  config.allowLocal = true;
  saveAuthConfig(config);
}

export function isAuthEnabled(): boolean {
  return loadAuthConfig().enabled;
}

// --- QR Code Login ---
interface QrToken {
  token: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved";
  sessionId?: string;    // session created for the big screen
  approvedBy?: string;   // session that approved it
  userAgent?: string;    // requesting device user-agent
  ip?: string;           // requesting device IP
}

const QR_EXPIRY = 2 * 60 * 1000; // 2 minutes
const QR_MAX_PENDING = 20;
const qrTokens = new Map<string, QrToken>();

function cleanupQrTokens() {
  const now = Date.now();
  for (const [key, t] of qrTokens) {
    if (now > t.expiresAt) qrTokens.delete(key);
  }
}

export function generateQrToken(userAgent?: string, ip?: string): { token: string; expiresAt: number; qrSvg: string } {
  cleanupQrTokens();
  // Rate limit: max pending tokens
  const pending = [...qrTokens.values()].filter(t => t.status === "pending");
  if (pending.length >= QR_MAX_PENDING) {
    // Remove oldest pending
    const oldest = pending.sort((a, b) => a.createdAt - b.createdAt)[0];
    qrTokens.delete(oldest.token);
  }

  // 16 bytes = 32 hex chars (sufficient for 2-min expiry token, keeps QR compact)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  qrTokens.set(token, {
    token,
    createdAt: now,
    expiresAt: now + QR_EXPIRY,
    status: "pending",
    userAgent,
    ip,
  });

  const approveUrl = `https://localhost:3457/auth/qr-approve?token=${token}`;
  const qrSvg = generateQRSvg(approveUrl, 4, 4);

  return { token, expiresAt: now + QR_EXPIRY, qrSvg };
}

export function getQrTokenStatus(token: string): { status: "pending" | "approved" | "expired"; sessionId?: string } {
  cleanupQrTokens();
  const t = qrTokens.get(token);
  if (!t) return { status: "expired" };
  if (Date.now() > t.expiresAt) {
    qrTokens.delete(token);
    return { status: "expired" };
  }
  if (t.status === "approved" && t.sessionId) {
    // Single-use: delete after consumption
    qrTokens.delete(token);
    return { status: "approved", sessionId: t.sessionId };
  }
  return { status: "pending" };
}

export function approveQrToken(token: string, approverSessionId: string, bigScreenUserAgent?: string): { ok: boolean; error?: string } {
  cleanupQrTokens();
  const t = qrTokens.get(token);
  if (!t) return { ok: false, error: "Token expired or invalid" };
  if (Date.now() > t.expiresAt) {
    qrTokens.delete(token);
    return { ok: false, error: "Token expired" };
  }
  if (t.status === "approved") return { ok: false, error: "Token already used" };

  // Create a new session for the big screen device
  const config = loadAuthConfig();
  const sessionId = generateSessionId();
  config.sessions[sessionId] = {
    createdAt: Date.now(),
    userAgent: bigScreenUserAgent || t.userAgent || "QR Login",
    ip: t.ip || "qr-login",
  };

  // Clean old sessions (keep max 10)
  const entries = Object.entries(config.sessions).sort((a, b) => b[1].createdAt - a[1].createdAt);
  if (entries.length > 10) {
    config.sessions = Object.fromEntries(entries.slice(0, 10));
  }
  saveAuthConfig(config);

  // Mark QR token as approved
  t.status = "approved";
  t.sessionId = sessionId;
  t.approvedBy = approverSessionId;

  return { ok: true };
}

// Login page HTML
export const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BoB's Office — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    background: #020208;
    color: #cdd6f4;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .login-box {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(34,211,238,0.15);
    border-radius: 16px;
    padding: 40px;
    width: 360px;
    box-shadow: 0 4px 30px rgba(0,0,0,0.4), 0 0 40px rgba(34,211,238,0.03);
  }
  h1 {
    color: #22d3ee;
    font-size: 18px;
    letter-spacing: 6px;
    text-align: center;
    margin-bottom: 8px;
  }
  .subtitle {
    text-align: center;
    color: rgba(255,255,255,0.3);
    font-size: 11px;
    margin-bottom: 32px;
    letter-spacing: 2px;
  }
  label {
    display: block;
    color: rgba(255,255,255,0.5);
    font-size: 11px;
    margin-bottom: 6px;
    letter-spacing: 1px;
  }
  input {
    width: 100%;
    padding: 10px 14px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    color: #cdd6f4;
    font-family: inherit;
    font-size: 14px;
    outline: none;
    margin-bottom: 16px;
    transition: border-color 0.2s;
  }
  input:focus {
    border-color: rgba(34,211,238,0.4);
    box-shadow: 0 0 12px rgba(34,211,238,0.1);
  }
  button {
    width: 100%;
    padding: 12px;
    background: rgba(34,211,238,0.15);
    color: #22d3ee;
    border: 1px solid rgba(34,211,238,0.3);
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    font-weight: bold;
    letter-spacing: 2px;
    cursor: pointer;
    transition: all 0.2s;
  }
  button:hover { background: rgba(34,211,238,0.25); }
  button:active { transform: scale(0.98); }
  .error {
    color: #ef4444;
    font-size: 12px;
    text-align: center;
    margin-top: 12px;
    display: none;
  }
  .lock-icon {
    text-align: center;
    font-size: 32px;
    margin-bottom: 16px;
    opacity: 0.3;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 24px 0;
  }
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(255,255,255,0.08);
  }
  .divider span {
    color: rgba(255,255,255,0.3);
    font-size: 11px;
    letter-spacing: 2px;
  }
  .qr-section {
    text-align: center;
  }
  .qr-container {
    display: flex;
    justify-content: center;
    margin: 16px 0 12px;
    min-height: 160px;
    align-items: center;
  }
  .qr-container svg {
    border-radius: 8px;
    max-width: 160px;
    max-height: 160px;
  }
  .qr-status {
    font-size: 11px;
    color: rgba(255,255,255,0.4);
    letter-spacing: 1px;
  }
  .qr-status.success {
    color: #22c55e;
  }
  .qr-countdown {
    font-size: 11px;
    color: rgba(255,255,255,0.3);
    margin-top: 8px;
  }
  .qr-refresh {
    background: none;
    border: none;
    color: #22d3ee;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 4px 8px;
    letter-spacing: 1px;
    margin-top: 8px;
    width: auto;
    display: inline-block;
  }
  .qr-refresh:hover {
    text-decoration: underline;
    background: none;
  }
  .qr-label {
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    letter-spacing: 1px;
    margin-bottom: 4px;
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid rgba(34,211,238,0.2);
    border-top-color: #22d3ee;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="login-box">
  <div class="lock-icon">&#128274;</div>
  <h1>BOB'S OFFICE</h1>
  <p class="subtitle">AUTHENTICATION REQUIRED</p>
  <form id="loginForm">
    <label>USERNAME</label>
    <input type="text" id="username" autocomplete="username" autofocus>
    <label>PASSWORD</label>
    <input type="password" id="password" autocomplete="current-password">
    <button type="submit">LOGIN</button>
  </form>
  <p class="error" id="error"></p>

  <div class="divider"><span>OR SCAN QR</span></div>

  <div class="qr-section">
    <p class="qr-label">SCAN WITH YOUR PHONE</p>
    <div class="qr-container" id="qrContainer">
      <div class="spinner"></div>
    </div>
    <p class="qr-status" id="qrStatus">GENERATING...</p>
    <p class="qr-countdown" id="qrCountdown"></p>
    <button class="qr-refresh" id="qrRefresh" style="display:none" onclick="loadQR()">REFRESH QR CODE</button>
  </div>
</div>
<script>
// Password login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('error');
  err.style.display = 'none';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      window.location.href = (redirect && redirect.startsWith('/')) ? redirect : '/';
    } else {
      err.textContent = data.error || 'Login failed';
      err.style.display = 'block';
    }
  } catch (e) {
    err.textContent = 'Connection error';
    err.style.display = 'block';
  }
});

// QR login
let qrToken = null;
let qrExpiry = 0;
let pollTimer = null;
let countdownTimer = null;

async function loadQR() {
  const container = document.getElementById('qrContainer');
  const status = document.getElementById('qrStatus');
  const countdown = document.getElementById('qrCountdown');
  const refresh = document.getElementById('qrRefresh');

  container.innerHTML = '<div class="spinner"></div>';
  status.textContent = 'GENERATING...';
  status.className = 'qr-status';
  countdown.textContent = '';
  refresh.style.display = 'none';
  if (pollTimer) clearInterval(pollTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  try {
    const res = await fetch('/auth/qr-generate');
    const data = await res.json();
    qrToken = data.token;
    qrExpiry = data.expiresAt;

    container.innerHTML = data.qrSvg;
    status.textContent = 'WAITING FOR APPROVAL...';

    // Start countdown
    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((qrExpiry - Date.now()) / 1000));
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        clearInterval(pollTimer);
        countdown.textContent = '';
        status.textContent = 'QR CODE EXPIRED';
        refresh.style.display = 'inline-block';
        container.style.opacity = '0.3';
        return;
      }
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      countdown.textContent = min + ':' + String(sec).padStart(2, '0');
    }, 1000);

    // Poll for approval
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/auth/qr-status?token=' + qrToken);
        const d = await r.json();
        if (d.status === 'approved') {
          clearInterval(pollTimer);
          clearInterval(countdownTimer);
          status.textContent = 'APPROVED!';
          status.className = 'qr-status success';
          countdown.textContent = '';
          // Cookie set by server via Set-Cookie header — just redirect
          setTimeout(() => { window.location.href = '/'; }, 500);
        } else if (d.status === 'expired') {
          clearInterval(pollTimer);
          clearInterval(countdownTimer);
          countdown.textContent = '';
          status.textContent = 'QR CODE EXPIRED';
          refresh.style.display = 'inline-block';
          container.style.opacity = '0.3';
        }
      } catch {}
    }, 2000);
  } catch (e) {
    status.textContent = 'FAILED TO GENERATE QR';
    refresh.style.display = 'inline-block';
  }
}

// Auto-load QR on page load
loadQR();
</script>
</body>
</html>`;

// QR Approve page HTML (shown on mobile after scanning)
export const QR_APPROVE_PAGE = (token: string, deviceInfo: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BoB's Office — Approve Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    background: #020208;
    color: #cdd6f4;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
  }
  .approve-box {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(34,211,238,0.15);
    border-radius: 16px;
    padding: 32px;
    width: 100%;
    max-width: 360px;
    text-align: center;
    box-shadow: 0 4px 30px rgba(0,0,0,0.4), 0 0 40px rgba(34,211,238,0.03);
  }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 {
    color: #22d3ee;
    font-size: 16px;
    letter-spacing: 4px;
    margin-bottom: 8px;
  }
  .desc {
    color: rgba(255,255,255,0.4);
    font-size: 12px;
    margin-bottom: 24px;
    line-height: 1.6;
  }
  .device-info {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    padding: 12px;
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    margin-bottom: 24px;
    word-break: break-all;
    line-height: 1.5;
  }
  .device-info strong {
    color: rgba(255,255,255,0.7);
  }
  .btn-approve {
    width: 100%;
    padding: 14px;
    background: rgba(34,211,238,0.2);
    color: #22d3ee;
    border: 1px solid rgba(34,211,238,0.4);
    border-radius: 8px;
    font-family: inherit;
    font-size: 14px;
    font-weight: bold;
    letter-spacing: 3px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-approve:hover { background: rgba(34,211,238,0.3); }
  .btn-approve:active { transform: scale(0.98); }
  .btn-approve:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .result {
    margin-top: 16px;
    font-size: 13px;
    display: none;
  }
  .result.success { color: #22c55e; }
  .result.error { color: #ef4444; }
</style>
</head>
<body>
<div class="approve-box">
  <div class="icon">&#128272;</div>
  <h1>APPROVE LOGIN</h1>
  <p class="desc">A device is requesting access to BoB's Office. Approve only if you initiated this login.</p>
  <div class="device-info">
    <strong>Requesting Device:</strong><br>${deviceInfo}
  </div>
  <button class="btn-approve" id="approveBtn" onclick="approve()">APPROVE LOGIN</button>
  <p class="result" id="result"></p>
</div>
<script>
async function approve() {
  const btn = document.getElementById('approveBtn');
  const result = document.getElementById('result');
  btn.disabled = true;
  btn.textContent = 'APPROVING...';
  try {
    const res = await fetch('/auth/qr-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '${token}' }),
    });
    const data = await res.json();
    if (data.ok) {
      result.textContent = 'LOGIN APPROVED';
      result.className = 'result success';
      result.style.display = 'block';
      btn.textContent = 'DONE';
    } else {
      result.textContent = data.error || 'Approval failed';
      result.className = 'result error';
      result.style.display = 'block';
      btn.textContent = 'APPROVE LOGIN';
      btn.disabled = false;
    }
  } catch (e) {
    result.textContent = 'Connection error';
    result.className = 'result error';
    result.style.display = 'block';
    btn.textContent = 'APPROVE LOGIN';
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
