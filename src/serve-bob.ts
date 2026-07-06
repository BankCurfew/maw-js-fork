/**
 * BoB Face standalone server — serves dist-office on port 3457.
 * Proxies /api/* to main maw server (3456) for SSE + chat.
 * localhost:3457 points here.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { isAuthenticated, handleLogin, LOGIN_PAGE } from "./auth";

const MAW_PORT = process.env.MAW_PORT || "3456";
const BOB_PORT = process.env.BOB_PORT || "3457";
const MAW_ORIGIN = `http://localhost:${MAW_PORT}`;

const app = new Hono();

app.use("/api/*", cors());

// --- Auth routes ---
app.get("/auth/login", (c) => c.html(LOGIN_PAGE));
app.post("/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "direct";
  const result = await handleLogin(username, password, c.req.header("user-agent") || "", ip);
  if (result.ok) {
    c.header(
      "Set-Cookie",
      `maw_session=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    );
  }
  return c.json(result);
});

// --- Auth middleware ---
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/auth/")) return next();
  if (!isAuthenticated(c.req.raw)) {
    if (path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
    return c.redirect("/auth/login");
  }
  return next();
});

// --- Proxy /api/bob/* to main maw server ---
app.all("/api/bob/*", async (c) => {
  const url = new URL(c.req.url);
  const target = `${MAW_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  const resp = await fetch(target, {
    method: c.req.method,
    headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    // @ts-expect-error — Bun supports duplex for streaming
    duplex: "half",
  });

  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers,
  });
});

// --- Static files: redirect / → /#bob ---
app.get("/", (c) => c.redirect("/#bob"));

// Serve React app assets
app.get("/assets/*", serveStatic({ root: "./dist-office" }));

// SPA fallback — serve index.html for all non-API routes
app.get("*", serveStatic({ root: "./dist-office", path: "/index.html" }));

const server = Bun.serve({
  port: Number(BOB_PORT),
  fetch: app.fetch,
});

console.log(`🤖 BoB Face server on :${BOB_PORT} (proxying API to :${MAW_PORT})`)
console.log(`Started development server: http://localhost:${BOB_PORT}`);
