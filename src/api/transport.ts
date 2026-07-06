/**
 * Transport API — exposes transport status and messaging via HTTP.
 *
 * Routes:
 *   GET  /api/transport/status   → status of all transports
 *   POST /api/transport/send     → send message via transport router
 */

import { Hono } from "hono";
import { getTransportRouter } from "../transports";

export const transportApi = new Hono();

// GET /api/transport/status — show all transports and their connectivity
transportApi.get("/transport/status", (c) => {
  const router = getTransportRouter();
  return c.json({
    transports: router.status(),
    timestamp: new Date().toISOString(),
  });
});

// POST /api/transport/send — send a message through the transport router
transportApi.post("/transport/send", async (c) => {
  const { oracle, host, message, from } = await c.req.json();

  if (!oracle || !message) {
    return c.json({ error: "oracle and message are required" }, 400);
  }

  const router = getTransportRouter();
  const result = await router.send(
    { oracle, host: host || undefined },
    message,
    from || "api",
  );

  return c.json({
    ...result,
    target: oracle,
    host: host || "local",
  });
});
