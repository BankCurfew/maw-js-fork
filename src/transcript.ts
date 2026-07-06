/**
 * Transcript reader — reads Claude Code session JSONL transcripts
 * for oracle preview and history (replaces capture-pane for TUI sessions).
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { ORACLE_MAP } from "./autopilot";
import { loadConfig } from "./config";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
  idx: number; // global index in transcript (cursor for paging)
}

const CLAUDE_PROJECTS_DIR = join(process.env.HOME || "/home/curfew", ".claude", "projects");

const PROJECT_DIR_OVERRIDES: Record<string, string> = {
};

/** Convert oracle name → Claude Code project directory path */
export function oracleToProjectDir(oracle: string): string | null {
  const lower = oracle.toLowerCase().replace(/-oracle$/i, "");
  let repoName = PROJECT_DIR_OVERRIDES[lower] || ORACLE_MAP[lower];

  // Fleet-based fallback: use FULL org/repo from fleet windows[].repo (Forge 50dba30)
  let fullRepoString: string | null = null;
  if (!repoName) {
    try {
      const fleetDir = join(import.meta.dir, "../fleet");
      const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.includes("example"));
      for (const f of files) {
        const fleet = JSON.parse(readFileSync(join(fleetDir, f), "utf-8"));
        const sessionName = (fleet.name || "").replace(/^\d+-/, "").toLowerCase();
        const windowName = (fleet.windows?.[0]?.name || "").replace(/-oracle$/i, "").toLowerCase();
        if (sessionName === lower || windowName === lower) {
          fullRepoString = fleet.windows?.[0]?.repo || null;
          break;
        }
      }
    } catch {}
  }

  if (!repoName && !fullRepoString) return null;

  const ghqRoot = loadConfig().ghqRoot;
  const repoPath = fullRepoString
    ? join(ghqRoot, fullRepoString)
    : join(ghqRoot, loadConfig().githubOrgs?.[0] || "YourOrg", repoName!);
  const slug = repoPath.replace(/[/.]/g, "-");
  const projectDir = join(CLAUDE_PROJECTS_DIR, slug);

  try {
    statSync(projectDir);
    return projectDir;
  } catch {
    // Case-insensitive fallback (e.g. pulse-oracle vs Pulse-Oracle)
    try {
      const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
      const match = dirs.find(d => d.toLowerCase() === slug.toLowerCase());
      if (match) return join(CLAUDE_PROJECTS_DIR, match);
    } catch {}
    return null;
  }
}

/** Find the most recently modified JSONL transcript in a project dir */
function latestTranscript(projectDir: string): string | null {
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] ? join(projectDir, files[0].name) : null;
  } catch {
    return null;
  }
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  total: number;
  hasMore: boolean;
}

/** Parse all messages from a transcript file (cached per file path) */
let _allCache: { path: string; mtime: number; msgs: TranscriptMessage[] } | null = null;

function parseAllMessages(filePath: string): TranscriptMessage[] {
  const mtime = statSync(filePath).mtimeMs;
  if (_allCache && _allCache.path === filePath && _allCache.mtime === mtime) return _allCache.msgs;

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const messages: TranscriptMessage[] = [];
  let idx = 0;

  for (const line of lines) {
    try {
      const d = JSON.parse(line);

      // Extract queued user messages (queue-operation records) — #108
      if (d.type === "queue-operation" && d.content) {
        let qText = typeof d.content === "string" ? d.content : "";
        // Extract attachment paths before stripping
        const attachments: string[] = [];
        // Format: [attached: IMG.png] /path/to/file or [2 files attached]- IMG.png: /path
        qText = qText.replace(/\[attached:\s*([^\]]+)\]\s*(\/[^\n\r]+)/g, (_, name, path) => {
          attachments.push(path.trim());
          return "";
        });
        qText = qText.replace(/\[\d+ files? attached\]\s*/g, "");
        qText = qText.replace(/-\s*[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp|gif):\s*(\/[^\n\r]+)/gi, (_, __, path) => {
          attachments.push(path.trim());
          return "";
        });
        qText = qText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\r]/g, "").trim();
        if (qText) {
          if (attachments.length > 0) qText += "\n" + attachments.join(" ");
          messages.push({ role: "user" as const, text: qText, ts: d.timestamp || "", idx: idx++ });
        }
        continue;
      }

      if (d.type !== "user" && d.type !== "assistant") continue;

      const msg = d.message;
      if (!msg || !msg.content) continue;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && block.text) {
            text += block.text + "\n";
          }
          // Extract mid-turn user messages from tool_result blocks (#108)
          if (block?.type === "tool_result" && d.type === "user") {
            const inner = typeof block.content === "string" ? block.content
              : Array.isArray(block.content) ? block.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
            const queueMatch = inner.match(/The user sent a new message while you were working:\s*\n?([\s\S]*?)(?:\n\nIMPORTANT:|$)/);
            if (queueMatch) {
              const queuedText = queueMatch[1].trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
              if (queuedText && !queuedText.startsWith("<local-command")) {
                messages.push({
                  role: "user" as const,
                  text: queuedText,
                  ts: d.timestamp || "",
                  idx: idx++,
                });
              }
            }
          }
        }
      }

      // Strip control chars except \n \t (prevents invalid JSON in API response)
      text = text.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      if (!text || text.startsWith("<local-command")) continue;

      messages.push({
        role: d.type as "user" | "assistant",
        text,
        ts: d.timestamp || "",
        idx: idx++,
      });
    } catch { /* skip malformed lines */ }
  }

  _allCache = { path: filePath, mtime, msgs: messages };
  return messages;
}

/** Read last N user/assistant messages from a transcript JSONL */
export function readTranscript(oracle: string, count = 20): TranscriptMessage[] {
  return readTranscriptPage(oracle, count).messages;
}

/** Read a page of transcript messages with cursor support */
export function readTranscriptPage(oracle: string, limit = 50, before?: number): TranscriptPage {
  const projectDir = oracleToProjectDir(oracle);
  if (!projectDir) return { messages: [], total: 0, hasMore: false };

  const file = latestTranscript(projectDir);
  if (!file) return { messages: [], total: 0, hasMore: false };

  return readTranscriptFilePage(file, limit, before);
}

/** Read a page from a specific transcript file */
export function readTranscriptFilePage(filePath: string, limit = 50, before?: number): TranscriptPage {
  try {
    const all = parseAllMessages(filePath);
    const total = all.length;

    let end = total;
    if (before !== undefined && before < total) {
      end = before;
    }
    const start = Math.max(0, end - limit);
    const messages = all.slice(start, end);
    const hasMore = start > 0;

    return { messages, total, hasMore };
  } catch {
    return { messages: [], total: 0, hasMore: false };
  }
}

/** Read transcript from a specific file path (legacy, returns flat array) */
export function readTranscriptFile(filePath: string, count = 20): TranscriptMessage[] {
  return readTranscriptFilePage(filePath, count).messages;
}

/** Format transcript messages for terminal display */
export function formatTranscript(messages: TranscriptMessage[], maxLineWidth = 120): string {
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === "user" ? "\x1b[36m▶ user\x1b[0m" : "\x1b[33m◀ asst\x1b[0m";
    const ts = m.ts ? ` \x1b[90m${m.ts.slice(0, 19).replace("T", " ")}\x1b[0m` : "";
    const preview = m.text.replace(/\n/g, " ").slice(0, maxLineWidth);
    lines.push(`${label}${ts}: ${preview}`);
  }
  return lines.join("\n");
}

/** Format transcript messages for dashboard preview (HTML-safe, no ANSI) */
export function formatTranscriptPreview(messages: TranscriptMessage[], maxChars = 80): string {
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === "user" ? "▶" : "◀";
    const preview = m.text.replace(/\n/g, " ").slice(0, maxChars);
    lines.push(`${label} ${preview}`);
  }
  return lines.join("\n");
}

/** Get the latest transcript file path for an oracle */
export function getTranscriptPath(oracle: string): string | null {
  const projectDir = oracleToProjectDir(oracle);
  if (!projectDir) return null;
  return latestTranscript(projectDir);
}
