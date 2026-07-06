import { Hono } from "hono";
import { scanWorktrees, cleanupWorktree } from "../worktrees";

export const worktreesApi = new Hono();

worktreesApi.get("/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

worktreesApi.post("/worktrees/cleanup", async (c) => {
  const { path } = await c.req.json();
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    const log = await cleanupWorktree(path);
    return c.json({ ok: true, log });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
