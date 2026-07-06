import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const asksPath = join(import.meta.dir, "../../asks.json");

export const asksApi = new Hono();

asksApi.get("/asks", (c) => {
  try {
    if (!existsSync(asksPath)) return c.json([]);
    return c.json(JSON.parse(readFileSync(asksPath, "utf-8")));
  } catch {
    return c.json([]);
  }
});

asksApi.post("/asks", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync(asksPath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
