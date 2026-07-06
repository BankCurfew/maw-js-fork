import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DEFAULT_PATH = join(import.meta.dir, "../../ui-state.json");

export function readUiState(filePath = DEFAULT_PATH): object {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeUiState(data: object, filePath = DEFAULT_PATH): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export const uiStateApi = new Hono();

uiStateApi.get("/ui-state", (c) => {
  return c.json(readUiState());
});

uiStateApi.post("/ui-state", async (c) => {
  try {
    const body = await c.req.json();
    writeUiState(body);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
