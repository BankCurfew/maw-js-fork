import { Hono } from "hono";

export const deprecatedApi = new Hono();

// Token + maw-log APIs removed — use POST /api/feed for all events
deprecatedApi.get("/tokens", (c) => c.json({ error: "removed — use /api/feed" }, 410));
deprecatedApi.get("/tokens/rate", (c) => c.json({ totalTokens: 0, totalPerMin: 0, inputPerMin: 0, outputPerMin: 0, inputTokens: 0, outputTokens: 0, turns: 0 }));
deprecatedApi.get("/maw-log", (c) => c.json({ entries: [], total: 0 }));
