/**
 * Real-time transcript watcher (T026) — fs.watch JSONL files,
 * push deltas via WebSocket, 150ms debounce, auto-rotation.
 */

import { watch, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { FSWatcher } from "fs";
import type { MawWS } from "../types";

interface WatchState {
  watcher: FSWatcher;
  filePath: string;
  offset: number;
  projectDir: string;
  oracle: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<MawWS>;
}

const watchers = new Map<string, WatchState>();

function latestJsonl(projectDir: string): string | null {
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] ? join(projectDir, files[0].name) : null;
  } catch { return null; }
}

function parseNewLines(filePath: string, offset: number): { messages: any[]; newOffset: number } {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (content.length <= offset) return { messages: [], newOffset: offset };
    const newContent = content.slice(offset);
    const lines = newContent.split("\n").filter(Boolean);
    const messages: any[] = [];
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type !== "user" && d.type !== "assistant") continue;
        const msg = d.message;
        if (!msg?.content) continue;
        let text = typeof msg.content === "string" ? msg.content : "";
        if (Array.isArray(msg.content)) {
          text = msg.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
        }
        text = text.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
        if (!text || text.startsWith("<local-command")) continue;
        messages.push({ role: d.type, text, ts: d.timestamp || "" });
      } catch {}
    }
    return { messages, newOffset: content.length };
  } catch { return { messages: [], newOffset: offset }; }
}

function startWatch(oracle: string, projectDir: string, ws: MawWS) {
  const existing = watchers.get(oracle);
  if (existing) {
    existing.subscribers.add(ws);
    return;
  }

  const filePath = latestJsonl(projectDir);
  if (!filePath) return;

  // T029: use STRING length not byte size — Thai/emoji are multibyte, slice() uses string units
  const initialSize = (() => { try { return readFileSync(filePath, "utf-8").length; } catch { return 0; } })();

  const state: WatchState = {
    watcher: null as any,
    filePath,
    offset: initialSize,
    projectDir,
    oracle,
    debounceTimer: null,
    subscribers: new Set([ws]),
  };

  const onChange = () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      // Check for rotation (newer file appeared)
      const latest = latestJsonl(projectDir);
      if (latest && latest !== state.filePath) {
        state.watcher.close();
        state.filePath = latest;
        state.offset = 0;
        try {
          state.watcher = watch(latest, onChange);
        } catch { cleanupWatcher(oracle); return; }
      }

      const { messages, newOffset } = parseNewLines(state.filePath, state.offset);
      if (messages.length === 0) return;
      state.offset = newOffset;

      const payload = JSON.stringify({ type: "transcript-delta", oracle, messages });
      for (const sub of state.subscribers) {
        try { sub.send(payload); } catch { state.subscribers.delete(sub); }
      }
      if (state.subscribers.size === 0) cleanupWatcher(oracle);
    }, 150);
  };

  try {
    state.watcher = watch(filePath, onChange);
    watchers.set(oracle, state);
  } catch {}
}

function cleanupWatcher(oracle: string) {
  const state = watchers.get(oracle);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  try { state.watcher.close(); } catch {}
  watchers.delete(oracle);
}

export function subscribeTranscript(oracle: string, projectDir: string, ws: MawWS) {
  startWatch(oracle, projectDir, ws);
}

export function unsubscribeTranscript(oracle: string, ws: MawWS) {
  const state = watchers.get(oracle);
  if (!state) return;
  state.subscribers.delete(ws);
  if (state.subscribers.size === 0) cleanupWatcher(oracle);
}

export function unsubscribeAll(ws: MawWS) {
  for (const [oracle, state] of watchers) {
    state.subscribers.delete(ws);
    if (state.subscribers.size === 0) cleanupWatcher(oracle);
  }
}
