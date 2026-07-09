import { memo, useState, useEffect, useRef, useCallback } from "react";
import { agentColor, guessCommand } from "../lib/constants";
import { FULL_COMMANDS } from "../quickCommands";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { useFileAttach, FileInput, AttachmentChips } from "../hooks/useFileAttach";
import type { AgentState } from "../lib/types";
import { ProjectSelector } from "./ProjectSelector";

interface OracleSheetProps {
  agent: AgentState;
  send: (msg: object) => void;
  onClose: () => void;
  onFullscreen: () => void;
  siblings: AgentState[];
  onSelectSibling: (agent: AgentState) => void;
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  busy: { color: "#fdd835", bg: "rgba(253,216,53,0.12)", label: "BUSY" },
  ready: { color: "#4caf50", bg: "rgba(76,175,80,0.12)", label: "READY" },
  idle: { color: "#666", bg: "rgba(102,102,102,0.12)", label: "IDLE" },
};

function cleanName(name: string) {
  return name.replace(/-oracle$/i, "").replace(/-/g, " ");
}

// Shared styles injected once
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .oracle-sheet { }
    .oracle-sheet-enter { animation: os-slide-up .2s ease-out both; }
    @keyframes os-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
    @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
    @keyframes thinking { 0%,80%,100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
  `;
  document.head.appendChild(s);
}

export const OracleSheet = memo(function OracleSheet({
  agent,
  send,
  onClose,
  onFullscreen,
  siblings,
  onSelectSibling,
}: OracleSheetProps) {
  const accent = agentColor(agent.name);
  const status = STATUS_CONFIG[agent.status] || STATUS_CONFIG.idle;
  const displayName = cleanName(agent.name);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(false);
  const [expanded, _setExpanded] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768);
  const [thinkingActive, setThinkingActive] = useState(false);
  const [advisoryShown, setAdvisoryShown] = useState(false);
  const [queueInfo, setQueueInfo] = useState<{ count: number; items: string[]; typing: string | null } | null>(null);
  const [activityItems, setActivityItems] = useState<{ msg: string; ts: number }[]>([]);
  const liveToolsRef = useRef<{ name: string; command: string }[]>([]);
  const [promptDialog, setPromptDialog] = useState<{ text: string; options: { label: string; key: string }[] } | null>(null);
  const fileValidCache = useRef(new Map<string, boolean>());
  const lastMsgHtmlRef = useRef("");
  const busyDivRef = useRef<HTMLDivElement>(null);
  const emptyThinkingCount = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const [githubOrg, setGithubOrg] = useState("YourOrg");
  const oracleFocusRef = useRef<{ projectId: string; repo: string } | null>(null);
  const { uploading, attachments, inputRef: fileInputRef, pickFile, onFileChange, removeAttachment, clearAttachments, buildMessage, onPaste } = useFileAttach();

  const setExpanded = useCallback((val: boolean) => {
    expandedRef.current = val;
    _setExpanded(val);
    // Use transform for GPU-accelerated position change
    const el = sheetRef.current;
    if (el) {
      el.style.height = val ? "100vh" : "60vh";
      el.style.borderRadius = val ? "0" : "16px 16px 0 0";
    }
  }, []);

  // Inject CSS once
  useEffect(injectStyles, []);

  // Lock body scroll — preserve width fluidity
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.style.width = "100vw";
    return () => {
      document.body.style.overflow = prev;
      document.body.style.width = "";
    };
  }, []);

  // ─── Swipe gesture ───
  const touchStartY = useRef(0);
  const touchStartTime = useRef(0);
  const isDragging = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only handle swipe on the drag handle area (first 40px)
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const touchY = e.touches[0].clientY;
    const relY = touchY - rect.top;
    if (relY > 50) return; // Only swipe from top 50px of sheet
    touchStartY.current = touchY;
    touchStartTime.current = Date.now();
    isDragging.current = true;
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    const dt = Date.now() - touchStartTime.current;
    const velocity = Math.abs(dy) / Math.max(1, dt);

    // Fast swipe or long drag
    if (dy < -50 || (dy < -20 && velocity > 0.3)) {
      // Swipe up → expand
      setExpanded(true);
    } else if (dy > 80 || (dy > 30 && velocity > 0.4)) {
      // Swipe down → minimize or close
      if (expandedRef.current) {
        setExpanded(false);
      } else {
        onClose();
      }
    }
  }, [setExpanded, onClose]);

  // ─── Transcript history with infinite scroll-up (maw-js#98) ───
  const userScrolledRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const msgsRef = useRef<any[]>([]);
  const lastPollHashRef = useRef("");

  // Extract oracle key for transcript API (handles aliases like yourapp→yourapp)
  const ORACLE_ALIASES: Record<string, string> = {
    yourapp: "yourapp", yourapporacle: "yourapp",
  };
  const rawName = agent.name.replace(/-oracle$/i, "").replace(/-/g, "").toLowerCase();
  const oracleName = ORACLE_ALIASES[rawName] || rawName;

  // Fetch config + oracle focus (#118) — MUST be after oracleName declaration
  useEffect(() => {
    fetch("/api/config").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.githubOrgs?.[0]) setGithubOrg(d.githubOrgs[0]);
    }).catch(() => {});
    fetch("/api/oracle-projects").then(r => r.ok ? r.json() : null).then(d => {
      const key = oracleName.toLowerCase();
      const entry = d?.assignments?.[key];
      if (entry?.projectId) oracleFocusRef.current = { projectId: entry.projectId, repo: entry.repo || "" };
    }).catch(() => {});
  }, [oracleName]);

  // Global handlers for bubble actions (innerHTML can't use React callbacks)
  useEffect(() => {
    (window as any).__msgCopy = (idx: number) => {
      const m = msgsRef.current.find((x: any) => x.idx === idx);
      if (!m) return;
      navigator.clipboard.writeText(m.text || "").then(() => {
        const toast = document.createElement("div");
        toast.textContent = "copied ✓";
        toast.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#a6e3a1;padding:4px 12px;border-radius:8px;font-size:12px;z-index:9999";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1200);
      });
    };
    (window as any).__msgReply = (idx: number, sender: string, time: string) => {
      const m = msgsRef.current.find((x: any) => x.idx === idx);
      if (!m) return;
      const raw = sanitizeHarnessTags((m.text || "")).replace(/\n/g, " ");
      const imgMatch = raw.match(/(?:\/[\w.\-\/]+\.(?:png|jpe?g|webp|gif))|(?:https?:\/\/[^\s]+\.(?:png|jpe?g|webp|gif))/i);
      const preview = imgMatch ? "รูปภาพ" : raw.slice(0, 40);
      replyRef.current = { idx, sender, time, preview };
      const chip = document.getElementById("reply-chip");
      if (chip) {
        const thumbHtml = imgMatch
          ? `<img src="${imgMatch[0].startsWith("http") ? imgMatch[0] : `/api/file?path=${encodeURIComponent(imgMatch[0])}`}" style="height:20px;border-radius:3px;margin-right:4px;vertical-align:middle" onerror="this.style.display='none'" />`
          : "";
        chip.innerHTML = `<span style="color:rgba(255,255,255,0.5);font-size:11px;display:flex;align-items:center">↩︎ <b style="margin:0 4px">${sender}</b> ${thumbHtml}${preview}…</span><button onclick="window.__msgReplyCancel()" style="background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;font-size:13px;margin-left:4px">✕</button>`;
        chip.style.display = "flex";
      }
      nativeInputRef.current?.focus();
    };
    (window as any).__msgReplyCancel = () => {
      replyRef.current = null;
      const chip = document.getElementById("reply-chip");
      if (chip) chip.style.display = "none";
    };
    (window as any).__imgLightbox = (url: string) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:pinch-zoom";
      overlay.onclick = () => overlay.remove();
      const img = document.createElement("img");
      img.src = url;
      img.style.cssText = "max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px";
      overlay.appendChild(img);
      document.body.appendChild(overlay);
    };
    // V19+V20: prompt dialog answer
    (window as any).__promptAnswer = (key: string) => {
      send({ type: "send", target: agent.target, text: key === "\x1b" ? "\x1b" : key, force: true });
      if (key !== "\x1b") {
        setTimeout(() => send({ type: "send", target: agent.target, text: "\r", force: true }), 500);
      }
      setPromptDialog(null);
    };
    (window as any).__dismissAdvisory = () => {
      send({ type: "send", target: agent.target, text: "\x1b", force: true });
      setTimeout(() => send({ type: "send", target: agent.target, text: "\r", force: true }), 500);
      setAdvisoryShown(false);
    };
    (window as any).__filePreview = (url: string) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center";
      const close = document.createElement("button");
      close.textContent = "✕ ปิด";
      close.style.cssText = "position:absolute;top:12px;right:16px;background:rgba(255,255,255,0.1);border:none;color:white;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:14px;z-index:1";
      close.onclick = () => overlay.remove();
      overlay.appendChild(close);
      const iframe = document.createElement("iframe");
      iframe.src = url;
      iframe.sandbox.add("allow-same-origin");
      iframe.style.cssText = "width:95vw;max-width:480px;height:85vh;border:none;border-radius:12px;background:white";
      overlay.appendChild(iframe);
      document.body.appendChild(overlay);
    };
    (window as any).__msgExpand = (idx: number) => {
      if (expandedMsgs.current.has(idx)) {
        expandedMsgs.current.delete(idx);
      } else {
        expandedMsgs.current.add(idx);
      }
      // T043: clear hash guard so expand state change re-renders
      lastMsgHtmlRef.current = "";
      const el = termRef.current;
      if (el) renderMessages(msgsRef.current, el);
    };
    return () => { delete (window as any).__msgCopy; delete (window as any).__msgReply; delete (window as any).__msgReplyCancel; delete (window as any).__imgLightbox; delete (window as any).__promptAnswer; delete (window as any).__dismissAdvisory; delete (window as any).__filePreview; delete (window as any).__msgExpand; };
  }, []);

  const replyRef = useRef<{ idx: number; sender: string; time: string; preview: string } | null>(null);

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(ts: string): string {
    if (!ts) return "";
    try {
      if (ts.includes("T") || ts.includes("Z") || ts.includes("+")) {
        const d = new Date(ts);
        const now = new Date();
        const time = d.toLocaleTimeString("en-GB", { hour12: false });
        if (d.toDateString() !== now.toDateString()) {
          return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) + " " + time;
        }
        return time;
      }
    } catch {}
    return ts.slice(11, 19);
  }

  const IMG_RE = /(?:\/[\w฀-๿.\-\/]+\.(?:png|jpe?g|webp|gif))|(?:https?:\/\/[^\s<&]+\.(?:png|jpe?g|webp|gif))/gi;

  function extractImages(text: string): { images: string[]; clean: string } {
    const images: string[] = [];
    const clean = text.replace(IMG_RE, (match) => {
      images.push(match);
      return match; // keep in text (dimmed)
    });
    return { images, clean };
  }

  function renderImageRow(images: string[]): string {
    if (images.length === 0) return "";
    const thumbs = images.map(src => {
      const url = src.startsWith("http") ? src : `/api/file?path=${encodeURIComponent(src)}`;
      return `<div style="height:200px;overflow:hidden;border-radius:8px;flex-shrink:0"><img src="${url}" loading="lazy" onclick="window.__imgLightbox('${esc(url)}')" style="height:200px;max-width:100%;border-radius:8px;cursor:pointer;object-fit:contain" onerror="this.parentElement.style.display='none'" /></div>`;
    }).join("");
    return `<div style="display:flex;gap:6px;overflow-x:auto;margin-top:6px;padding:2px 0">${thumbs}</div>`;
  }

  const FILE_RE = /(?:\/[\w฀-๿.\-\/]+\.(?:html?|pdf|md|txt))/gi;

  function extractFiles(text: string): string[] {
    return (text.match(FILE_RE) || []).filter(f => f.length > 5 && fileValidCache.current.get(f) === true);
  }

  function renderFileChips(files: string[]): string {
    if (files.length === 0) return "";
    const chips = files.map(f => {
      const name = f.split("/").pop() || f;
      const ext = (name.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      const icon = ext === "pdf" ? "📄" : ext === "md" ? "📝" : ext === "html" || ext === "htm" ? "🌐" : "📃";
      const url = `/api/file?path=${encodeURIComponent(f)}`;
      const action = ext === "html" || ext === "htm"
        ? `onclick="window.__filePreview('${esc(url)}')"`
        : `onclick="window.open('${esc(url)}','_blank')"`;
      return `<span ${action} style="display:inline-flex;align-items:center;gap:3px;background:rgba(137,180,250,0.1);border:1px solid rgba(137,180,250,0.2);color:rgba(255,255,255,0.6);font-size:11px;padding:3px 8px;border-radius:8px;cursor:pointer;margin:2px">${icon} ${esc(name)}</span>`;
    }).join("");
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>`;
  }

  function autolink(html: string): string {
    return html.replace(/(?<!href="|">)(https?:\/\/[^\s<&"]+)/g,
      '<a href="$1" target="_blank" rel="noopener" style="color:#89b4fa;word-break:break-all">$1</a>');
  }

  function renderCcReport(text: string): string | null {
    if (!text.match(/^cc:/i)) return null;
    const body = text.replace(/^cc:\s*/i, "");
    const segments = body.split(/\s*·\s*/);
    if (segments.length < 2) return null;
    const lines: string[] = [];
    segments.forEach((seg, i) => {
      const trimmed = seg.trim();
      if (!trimmed) return;
      const labelMatch = trimmed.match(/^(src|why|next|ref|source|reason|done|what):\s*/i);
      if (labelMatch) {
        const label = labelMatch[1].toLowerCase();
        const value = trimmed.slice(labelMatch[0].length);
        lines.push(`<div style="margin-left:8px;margin-bottom:2px"><span style="color:rgba(255,255,255,0.25);font-size:11px;text-transform:uppercase;margin-right:4px">${esc(label)}</span> ${esc(value)}</div>`);
      } else if (i === 0) {
        lines.push(`<div style="font-weight:600;margin-bottom:3px">${esc(trimmed)}</div>`);
      } else if (trimmed.match(/^\(\d+\)|^\d+[\.\)]/)) {
        lines.push(`<div style="margin-left:12px;margin-bottom:1px">• ${esc(trimmed.replace(/^\(\d+\)\s*|^\d+[\.\)]\s*/, ""))}</div>`);
      } else {
        lines.push(`<div style="margin-bottom:2px">${esc(trimmed)}</div>`);
      }
    });
    return autolink(lines.join(""));
  }

  function lightMarkdown(raw: string): string {
    try {
      // Structured cc: report → tidy card
      const ccHtml = renderCcReport(raw);
      if (ccHtml) return ccHtml;
      let s = esc(raw);
      s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre style="background:rgba(255,255,255,0.05);padding:8px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.4;margin:4px 0">$1</pre>');
      s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/^### (.+)$/gm, '<div style="font-weight:700;font-size:14px;margin:6px 0 2px">$1</div>');
      s = s.replace(/^## (.+)$/gm, '<div style="font-weight:700;font-size:15px;margin:8px 0 3px">$1</div>');
      s = s.replace(/^# (.+)$/gm, '<div style="font-weight:700;font-size:16px;margin:10px 0 4px">$1</div>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#89b4fa;text-decoration:underline">$1</a>');
      // #111: Auto-format single-line structured messages (safe subset only)
      if (!raw.includes("\n")) {
        s = s.replace(/ · /g, '<br> · ');
        s = s.replace(/([✅❌🔄])/g, '<br>$1');
      }
      s = s.replace(/\n/g, "<br>");
      return autolink(s);
    } catch {
      return autolink(esc(raw).replace(/\n/g, "<br>"));
    }
  }

  function sanitizeHarnessTags(text: string): string {
    let s = text;
    // Extract inner text from bash-input tags
    s = s.replace(/<bash-input>([\s\S]*?)<\/bash-input>/gi, "$1");
    // Extract stdout/stderr as small mono blocks (only if non-empty inner)
    s = s.replace(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/gi, (_, inner) => {
      const trimmed = inner.trim();
      return trimmed ? `\n\`\`\`\n${trimmed}\n\`\`\`\n` : "";
    });
    s = s.replace(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/gi, (_, inner) => {
      const trimmed = inner.trim();
      return trimmed ? `\n\`\`\`\n⚠ ${trimmed}\n\`\`\`\n` : "";
    });
    // T063: strip tool-call XML entirely from history (tool activity = ephemeral thinking bubble only)
    s = s.replace(/<invoke\s+name="[^"]*"[^>]*>[\s\S]*?<\/invoke>/gi, "");
    s = s.replace(/<invoke[^>]*>[\s\S]*?<\/antml:invoke>/gi, "");
    s = s.replace(/<parameter[^>]*>[\s\S]*?<\/antml:parameter>/gi, "");
    s = s.replace(/<parameter\s+name="[^"]*"[^>]*>[\s\S]*?<\/parameter>/gi, "");
    s = s.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/gi, "");
    s = s.replace(/^\s*call\s*$/gm, "");
    // Strip remaining harness wrapper tags (keep inner text)
    s = s.replace(/<\/?(local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder|user-prompt-submit-hook|antml:thinking)[^>]*>/gi, "");
    // Strip empty tag pairs + any remaining antml/function tags
    s = s.replace(/<(\w[\w-]*)>\s*<\/\1>/g, "");
    s = s.replace(/<\/?(antml:[a-z_]+|function_calls|function_results)[^>]*>/gi, "");
    // T023: strip bash error lines (never human content)
    s = s.replace(/^[⚠!]?\s*\/bin\/\w+:(\s*\w+:)?\s*line\s*\d+:.*$/gm, "");
    s = s.replace(/^.*: command not found\s*$/gm, "");
    s = s.replace(/^\s*\[\d+\]\+\s+Exit\s+\d+.*$/gm, "");
    return s.replace(/\n{3,}/g, "\n\n").trim();
  }

  function isToolNoise(text: string): boolean {
    return /^(Reading|Searching|Listed|Found \d|Ran \d|Edit applied|File created|Bash completed)/.test(text.trim());
  }

  // Track messages sent from THIS dashboard session
  const sentFromDashboard = useRef(new Set<string>());
  // Track expanded messages (persist across re-renders)
  const expandedMsgs = useRef(new Set<number>());

  function isSystemMessage(text: string): boolean {
    const t = text.trim();
    return /^<(task-notification|system-reminder|local-command|command-message|command-name)/.test(t) ||
           /^\[SYSTEM NOTIFICATION/.test(t) ||
           /^Base directory for this skill:/.test(t) ||
           /^# \/\w+\s*—/.test(t);
  }

  function systemSummary(text: string): string {
    if (text.includes("task-notification")) {
      const status = text.match(/status>(\w+)</)?.[1] || "";
      const summary = text.match(/summary>([^<]+)</)?.[1] || "background task";
      return `${summary}${status ? ` (${status})` : ""}`;
    }
    if (text.includes("command-message") || text.includes("command-name")) {
      const cmd = text.match(/command-(?:message|name)>([^<]+)</)?.[1] || "command";
      return `/${cmd}`;
    }
    if (text.includes("system-reminder")) return "system reminder";
    if (text.includes("local-command")) return "local command output";
    if (text.includes("[SYSTEM NOTIFICATION")) return "system notification";
    const skillHeader = text.match(/^# \/([\w-]+)/);
    if (skillHeader) return `▶︎ /${skillHeader[1]}`;
    if (/^Base directory for this skill:/.test(text.trim())) {
      const skillName = text.match(/skills\/([\w-]+)/)?.[1] || "skill";
      return `▶︎ /${skillName}`;
    }
    return "system message";
  }

  type MsgType = "assistant" | "system" | "you" | "hey" | "thread" | "cc" | "task" | "inbox";

  const msgTypeBubble: Record<MsgType, { bg: string; border: string }> = {
    assistant: { bg: "rgba(249,226,175,0.05)", border: "rgba(249,226,175,0.1)" },
    system:    { bg: "rgba(255,255,255,0.02)", border: "rgba(255,255,255,0.05)" },
    you:       { bg: "rgba(137,180,250,0.12)", border: "rgba(137,180,250,0.25)" },
    hey:       { bg: "rgba(166,227,161,0.10)", border: "rgba(166,227,161,0.20)" },
    thread:    { bg: "rgba(249,226,175,0.10)", border: "rgba(249,226,175,0.20)" },
    cc:        { bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)" },
    task:      { bg: "rgba(239,68,68,0.08)",   border: "rgba(239,68,68,0.18)" },
    inbox:     { bg: "rgba(148,226,213,0.08)", border: "rgba(148,226,213,0.15)" },
  };

  function parseSender(m: any): { label: string; color: string; type: MsgType } {
    if (m.role !== "user") return { label: `◀ ${displayName}`, color: "#f9e2af", type: "assistant" };
    const text = m.text || "";
    if (isSystemMessage(text)) return { label: "⚙ system", color: "rgba(255,255,255,0.25)", type: "system" };
    if (m.pending || sentFromDashboard.current.has(text.slice(0, 50))) {
      return { label: m.pending ? "▶ you ⏳" : "▶ you", color: "#89b4fa", type: "you" };
    }
    // Detect message type from content
    const isCc = /\bcc:/i.test(text);
    const isTask = /^(?:\[[\w-]+\]\s*)?TASK:/i.test(text);
    const isThread = /Thread #\d+/i.test(text);
    // [from:oracle] tag — injected by cmdSend
    const fromTag = text.match(/^\[from:([a-z][\w-]*)\]\s*/i);
    if (fromTag) {
      const name = fromTag[1].toLowerCase();
      const type: MsgType = isTask ? "task" : isThread ? "thread" : isCc ? "cc" : "hey";
      const colors: Record<MsgType, string> = { task: "#ef4444", thread: "#f9e2af", cc: "rgba(255,255,255,0.4)", hey: "#a6e3a1", assistant: "", system: "", you: "", inbox: "" };
      return { label: `▶ ${name}`, color: colors[type] || "#a6e3a1", type };
    }
    // Thread relay — parse sender
    const threadMatch = text.match(/Thread #\d+ from ([A-Za-z][\w-]*)/i);
    if (threadMatch) return { label: `▶ ${threadMatch[1].replace(/-Oracle$/i, "").toLowerCase()}`, color: "#f9e2af", type: "thread" };
    // [project] prefix with known oracle patterns
    const projSender = text.match(/^\[[\w-]+\]\s*(?:cc:\s*)?(?:#\d+\s+)?(?:from\s+)?([A-Z][\w-]*-Oracle)/i);
    if (projSender) {
      const name = projSender[1].replace(/-Oracle$/i, "").toLowerCase();
      const type: MsgType = isTask ? "task" : isCc ? "cc" : "hey";
      return { label: `▶ ${name}`, color: type === "task" ? "#ef4444" : type === "cc" ? "rgba(255,255,255,0.4)" : "#a6e3a1", type };
    }
    if (/^\[[\w-]+\]/.test(text) && !sentFromDashboard.current.has(text.slice(0, 50))) {
      return { label: "▶ inbox", color: "#94e2d5", type: "inbox" };
    }
    return { label: "▶ you", color: "#89b4fa", type: "you" };
  }

  function hashColor(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
    const hue = ((h % 360) + 360) % 360;
    return `hsl(${hue}, 50%, 45%)`;
  }

  function parseChips(text: string): { project?: string; tickets: { repo: string; num: string }[]; clean: string } {
    let clean = text;
    // Strip [from:X] tag + cc: prefix (#118)
    clean = clean.replace(/^\[from:[\w-]+\]\s*/, "");
    clean = clean.replace(/^cc:\s*/i, "");
    // Extract [project] tag
    const projMatch = clean.match(/^\[([a-z0-9_-]+)\]\s*/i);
    const project = projMatch ? projMatch[1] : undefined;
    if (projMatch) clean = clean.slice(projMatch[0].length);
    // Extract ticket refs: repo#N
    const tickets: { repo: string; num: string }[] = [];
    const ticketRe = /([A-Za-z0-9_.-]+)#(\d+)/g;
    let tm;
    while ((tm = ticketRe.exec(text)) !== null) {
      tickets.push({ repo: tm[1], num: tm[2] });
    }
    // Bare #N (e.g., "ref: #73") — resolve against oracle's focused repo (#118)
    const bareRe = /(?:ref:\s*|·\s*)#(\d+)/gi;
    let bm;
    while ((bm = bareRe.exec(text)) !== null) {
      const num = bm[1];
      if (!tickets.some(t => t.num === num)) {
        const focusRepo = oracleFocusRef.current?.repo?.split("/").pop() || oracleFocusRef.current?.projectId || "";
        if (focusRepo) tickets.push({ repo: focusRepo, num });
      }
    }
    return { project, tickets, clean };
  }

  function renderChips(chips: ReturnType<typeof parseChips>): string {
    let html = "";
    const proj = chips.project || (oracleFocusRef.current?.projectId ?? "");
    if (proj) {
      const bg = hashColor(proj);
      const dim = !chips.project ? ";opacity:0.5" : "";
      html += `<span style="display:inline-block;background:${bg};color:white;font-size:10px;padding:2px 6px;border-radius:8px;margin-left:4px;font-weight:600;line-height:1.2${dim}">${esc(proj)}</span>`;
    }
    const seen = new Set<string>();
    for (const t of chips.tickets.slice(0, 3)) {
      const key = `${t.repo}#${t.num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const url = `https://github.com/${githubOrg}/${t.repo}/issues/${t.num}`;
      html += `<a href="${url}" target="_blank" rel="noopener" style="display:inline-block;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-size:10px;padding:2px 6px;border-radius:8px;margin-left:3px;text-decoration:none;line-height:1.2">${esc(key)}</a>`;
    }
    return html;
  }

  function renderMessages(msgs: any[], el: HTMLDivElement) {
    try {
      // T058v3: dedup identical consecutive messages (same role + same text + ts within 10s)
      const deduped = msgs.filter((m: any, i: number) => {
        if (i === 0) return true;
        const prev = msgs[i - 1];
        if (m.role !== prev.role) return true;
        const mText = (m.text || "").trim();
        const pText = (prev.text || "").trim();
        if (!mText || mText !== pText) return true;
        const gap = Math.abs(new Date(m.ts || 0).getTime() - new Date(prev.ts || 0).getTime());
        return gap > 10000;
      });
      const newHtml = deduped.map((m: any) => {
        try {
          // System/harness injection → dim collapsed row
          if (m.role === "user" && isSystemMessage(m.text || "")) {
            const summary = systemSummary(m.text || "");
            return `<div style="margin-bottom:4px;cursor:pointer" onclick="var d=this.querySelector('[data-raw]');d.style.display=d.style.display?'':'none'">
              <span style="color:rgba(255,255,255,0.2);font-size:11px">⚙ ${esc(summary)}</span>
              <div data-raw style="display:none;color:rgba(255,255,255,0.15);font-size:10px;font-family:monospace;max-height:6em;overflow:auto;margin-top:4px;padding:4px;background:rgba(255,255,255,0.02);border-radius:4px">${esc((m.text || "").slice(0, 500))}</div>
            </div>`;
          }
          // Outbound hey → right-aligned bubble
          if (m.role === "outbound") {
            const chips = parseChips(m.text);
            const chipHtml = renderChips(chips);
            return `<div style="background:rgba(166,227,161,0.08);border:1px solid rgba(166,227,161,0.15);border-radius:10px;padding:8px 12px;margin-bottom:6px;margin-left:20%">
              <div style="font-size:11px;margin-bottom:3px;display:flex;align-items:center;flex-wrap:wrap">
                <span style="color:#a6e3a1;font-weight:600">→ ${esc(m.to || "?")}</span>
                ${m.ts ? `<span style="color:rgba(255,255,255,0.15);margin-left:6px">${esc(fmtTime(m.ts))}</span>` : ""}
                ${chipHtml}
              </div>
              <div style="color:rgba(255,255,255,0.5);font-size:13px">${esc(chips.clean).slice(0, 200)}</div>
            </div>`;
          }
          const isUser = m.role === "user";
          const sender = parseSender(m);
          const bubble = msgTypeBubble[sender.type] || msgTypeBubble.you;
          const bg = bubble.bg;
          const border = bubble.border;
          const label = `<span style="color:${sender.color};font-weight:600">${sender.label}</span>`;
          const ts = m.ts ? `<span style="color:rgba(255,255,255,0.2);margin-left:6px">${esc(fmtTime(m.ts))}</span>` : "";
          const raw = m.text || "";
          const chips = parseChips(raw);
          const chipHtml = renderChips(chips);
          // T016: sanitize harness tags before render
          let displayText = sanitizeHarnessTags(chips.clean);
          let quoteHtml = "";
          const replyMatch = displayText.match(/^↩︎\[([^\]]+)]\s*([^\n]*)\n?/);
          if (replyMatch) {
            displayText = displayText.slice(replyMatch[0].length);
            quoteHtml = `<div style="font-size:10px;color:rgba(255,255,255,0.3);border-left:2px solid rgba(255,255,255,0.15);padding-left:6px;margin-bottom:4px;cursor:pointer" onclick="document.querySelector('[data-msgidx]')?.scrollIntoView({behavior:'smooth'})">↩︎ ${esc(replyMatch[1])} ${esc(replyMatch[2])}</div>`;
          } else if (m.replyMeta) {
            quoteHtml = `<div style="font-size:10px;color:rgba(255,255,255,0.3);border-left:2px solid rgba(255,255,255,0.15);padding-left:6px;margin-bottom:4px">↩︎ ${esc(m.replyMeta.sender)}: ${esc(m.replyMeta.preview)}</div>`;
            displayText = displayText.replace(/^↩︎\[[^\]]*\][^\n]*\n?/, "");
          }
          const { images } = extractImages(displayText);
          const imgHtml = renderImageRow(images);
          const files = extractFiles(displayText);
          const fileHtml = renderFileChips(files);
          // BUG A fix: skip tool-only turns with no visible content
          if (displayText.trim() === "" && images.length === 0 && files.length === 0 && !chips.tickets.length && !chips.project) return "";
          const noise = isToolNoise(displayText);
          const long = displayText.length > 500;
          const msgId = m.idx ?? 0;
          const isExpanded = expandedMsgs.current.has(msgId);
          const body = noise
            ? `<div style="color:rgba(255,255,255,0.25);font-size:12px">${esc(displayText.slice(0,120))}…</div>`
            : long
              ? `<div style="${isExpanded ? '' : 'max-height:9em;overflow:hidden;'}">${lightMarkdown(displayText)}</div>${isExpanded ? '' : '<div style="text-align:center;color:rgba(255,255,255,0.3);font-size:11px;margin-top:2px">... อ่านต่อ</div>'}${imgHtml}${fileHtml}`
              : lightMarkdown(displayText) + imgHtml + fileHtml;
          const msgIdx = m.idx ?? 0;
          const senderText = sender.label.replace(/[▶◀]\s*/, "");
          const timeText = m.ts ? fmtTime(m.ts) : "";
          const actions = `<span class="msg-actions" style="position:absolute;top:6px;right:8px;display:none;gap:3px">
            <button onclick="window.__msgCopy(${msgIdx})" style="background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.4);font-size:11px;padding:2px 6px;border-radius:4px;cursor:pointer" title="Copy">📋</button>
            <button onclick="window.__msgReply(${msgIdx},'${esc(senderText)}','${esc(timeText)}')" style="background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.4);font-size:11px;padding:2px 6px;border-radius:4px;cursor:pointer" title="Reply">↩︎</button>
          </span>`;
          return `<div data-msgidx="${msgIdx}"${long ? ` data-expandable="${msgId}"` : ""} style="background:${bg};border:1px solid ${border};border-radius:10px;padding:10px 12px;margin-bottom:8px;position:relative;${long ? 'cursor:pointer' : ''}" onmouseenter="this.querySelector('.msg-actions').style.display='flex'" onmouseleave="this.querySelector('.msg-actions').style.display=''" ontouchstart="this.querySelector('.msg-actions').style.display='flex'">
            <div style="font-size:11px;margin-bottom:4px;display:flex;align-items:center;flex-wrap:wrap">${label}${ts}${chipHtml}</div>
            ${quoteHtml}${body}
            ${actions}
          </div>`;
        } catch {
          return `<div style="padding:4px;color:rgba(255,255,255,0.3)">[message render error]</div>`;
        }
      }).join("");
      // T021: content-hash guard — only assign innerHTML if messages changed (prevents image flicker)
      if (newHtml !== lastMsgHtmlRef.current) {
        el.innerHTML = newHtml;
        lastMsgHtmlRef.current = newHtml;
      }
      // T021: busy/advisory rendered in separate sibling div (no message container churn)
      const busyEl = busyDivRef.current;
      if (busyEl) {
        let busyHtml = "";
        if (workingRef.current && pickerRef.current.length === 0) {
          // T042v2: render verbatim terminal status lines
          const statusLines = workingRef.current.split("\n").filter(Boolean);
          busyHtml = `<div style="background:rgba(253,216,53,0.06);border:1px solid rgba(253,216,53,0.15);border-radius:10px;padding:10px 12px;margin-bottom:8px">
            <div style="font-size:11px;color:#fdd835;margin-bottom:4px;display:flex;align-items:center;gap:6px">
              <span style="display:flex;gap:3px;flex-shrink:0">
                <span style="width:6px;height:6px;border-radius:50%;background:#fdd835;animation:thinking 1.4s infinite ease-in-out">&#8203;</span>
                <span style="width:6px;height:6px;border-radius:50%;background:#fdd835;animation:thinking 1.4s infinite ease-in-out 0.2s">&#8203;</span>
                <span style="width:6px;height:6px;border-radius:50%;background:#fdd835;animation:thinking 1.4s infinite ease-in-out 0.4s">&#8203;</span>
              </span>
              ◀ ${esc(displayName)}
            </div>
            <div style="font-family:monospace;font-size:11px;color:rgba(255,255,255,0.4);line-height:1.5;padding-left:27px">${statusLines.map(l => esc(l)).join('<br>')}</div>
          </div>`;
        }
        if (advisoryShown) {
          busyHtml += `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:10px 12px;margin-bottom:8px;text-align:center">
            <div style="color:#ef4444;font-size:12px;margin-bottom:6px">⚠️ Usage advisory / rate limit notice detected</div>
            <button onclick="window.__dismissAdvisory()" style="background:#ef4444;color:white;border:none;padding:6px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Dismiss Notice</button>
          </div>`;
        }
        // V19: prompt dialog card
        if (promptDialog) {
          const optBtns = promptDialog.options.map(o => {
            const isDestructive = /delete|remove|rm|overwrite|drop|destroy/i.test(o.label);
            const bg = isDestructive ? "rgba(239,68,68,0.15)" : "rgba(34,211,238,0.15)";
            const border = isDestructive ? "rgba(239,68,68,0.3)" : "rgba(34,211,238,0.3)";
            const color = isDestructive ? "#f38ba8" : "#22d3ee";
            return `<button onclick="window.__promptAnswer('${esc(o.key)}')" style="background:${bg};border:1px solid ${border};color:${color};padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">${esc(o.label)}</button>`;
          }).join(" ");
          busyHtml += `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:10px;padding:12px;margin-bottom:8px">
            <div style="color:#f9e2af;font-size:12px;font-weight:600;margin-bottom:6px">⚠ Awaiting Decision</div>
            <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;font-style:italic">${esc(promptDialog.text)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${optBtns}</div>
          </div>`;
        }
        // T063 pivot: ephemeral live tool commands (from WS deltas)
        if (liveToolsRef.current.length > 0 && workingRef.current) {
          for (const t of liveToolsRef.current.slice(-2)) {
            busyHtml += `<div style="margin:2px 0 2px 27px;padding:3px 6px;border-left:2px solid rgba(34,211,238,0.3);background:rgba(34,211,238,0.03);border-radius:0 4px 4px 0">
              <span style="font-size:10px;color:#22d3ee;font-weight:600">⚡ ${esc(t.name)}</span>
              <pre style="font-size:10px;color:rgba(255,255,255,0.35);margin:1px 0 0;white-space:pre-wrap;word-break:break-all">${esc((t.command || "").slice(0, 120))}</pre>
            </div>`;
          }
        }
        // T034: live activity timeline
        if (activityItems.length > 0) {
          busyHtml += `<div style="margin-bottom:8px;padding:4px 8px;border-left:2px solid rgba(253,216,53,0.2)">`;
          for (const item of activityItems) {
            const time = item.ts ? new Date(item.ts).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
            busyHtml += `<div style="font-size:10px;font-family:monospace;color:rgba(255,255,255,0.25);line-height:1.6">${time ? `<span style="color:rgba(255,255,255,0.15)">${esc(time)}</span> ` : ""}${esc(item.msg)}</div>`;
          }
          busyHtml += `</div>`;
        }
        busyEl.innerHTML = busyHtml;
      }
    } catch {
      el.textContent = "[render error]";
    }
  }

  const workingRef = useRef("");
  const pickerRef = useRef<string[]>([]);

  // Poll for interactive picker state — renders into overlay, not history
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pollPicker() {
      try {
        const res = await fetch(`/api/picker?target=${encodeURIComponent(agent.target)}`);
        const data = await res.json();
        if (active) {
          pickerRef.current = data.active ? (data.lines || []) : [];
          const strip = document.getElementById("picker-strip");
          const content = document.getElementById("picker-content");
          if (strip && content) {
            if (pickerRef.current.length > 0) {
              content.innerHTML = pickerRef.current.map((l: string) =>
                `<div>${l.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`
              ).join("");
              strip.style.display = "block";
            } else {
              strip.style.display = "none";
            }
          }
        }
      } catch {}
      if (active) timer = setTimeout(pollPicker, 1500);
    }
    pollPicker();
    return () => { active = false; clearTimeout(timer); };
  }, [agent.target]);

  const [statusBar, setStatusBar] = useState<{ contextPercent: number | null; contextTokens: string | null; model: string; duration: string; usage5h: number | null } | null>(null);

  // Poll status bar from capture
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch(`/api/status-bar?target=${encodeURIComponent(agent.target)}`);
        const data = await res.json();
        if (active && (data.contextPercent !== null || data.stale)) setStatusBar(data);
      } catch {}
      if (active) timer = setTimeout(poll, 10000);
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [agent.target]);

  // Poll oracle activity — always poll thinking (decoupled from status badge, T007)
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pollActivity() {
      try {
        const [feedRes, transcriptRes, thinkingRes] = await Promise.all([
          fetch(`/api/feed?oracle=${encodeURIComponent(oracleName)}&limit=8`),
          fetch(`/api/transcript?oracle=${encodeURIComponent(oracleName)}&limit=1`),
          fetch(`/api/thinking?target=${encodeURIComponent(agent.target)}`),
        ]);
        const feedData = await feedRes.json();
        const events = feedData.events || [];

        // T042v2: verbatim terminal status region
        let thinkingLine = "";
        let statusRegion: string[] = [];
        let advisoryDetected = false;
        let queueData: any = null;
        try {
          const thinking = await thinkingRes.json();
          if (thinking.statusRegion) statusRegion = thinking.statusRegion;
          if (thinking.thinkingLine) thinkingLine = thinking.thinkingLine;
          if (thinking.advisory) advisoryDetected = true;
          setPromptDialog(thinking.promptDialog || null);
          if (thinking.queue) queueData = thinking.queue;
        } catch {}

        // Tool activity from feed — enriched format: "⚡ Bash: description"
        let toolLine = "";
        if (events.length > 0) {
          const last = events[0];
          const msg = last.message || "";
          const ago = Math.round((Date.now() - (last.ts || 0)) / 1000);
          const enriched = msg.match(/^([⚡📖✏️🔍🤖🔌🔧]\s*\w+(?::\s*.+)?)/);
          if (enriched) {
            toolLine = `${enriched[1].slice(0, 60)} · ${ago}s ago`;
          } else {
            const tool = msg.match(/(?:⚡|📖|✏️|🔍|🤖|🔌|🔧)\s*(\w+)/)?.[0] || msg.match(/(\w+)\s*»/)?.[1] || "";
            toolLine = tool ? `${tool} · ${ago}s ago` : `กำลังทำงาน · ${ago}s ago`;
          }
        }

        // Latest assistant snippet from transcript
        let doingLine = "";
        try {
          const tData = await transcriptRes.json();
          const msgs = tData.messages || [];
          if (msgs.length > 0 && msgs[0].role === "assistant") {
            doingLine = msgs[0].text.replace(/\n/g, " ").slice(0, 80);
          }
        } catch {}

        if (active) {
          // T011: advisory detection
          setAdvisoryShown(advisoryDetected);
          // T022: queue detection
          setQueueInfo(queueData);
          // T042: feedAge must be declared before any use (TDZ fix)
          const feedAge = events.length > 0 ? Math.round((Date.now() - (events[0].ts || 0)) / 1000) : 999;
          // T034: live activity timeline — recent ⚡ feed items
          const recentActivity = events
            .filter((e: any) => e.message && /^[⚡📖✏️🔍🤖🔌🔧]/.test(e.message))
            .slice(0, 5)
            .map((e: any) => ({ msg: (e.message || "").slice(0, 60), ts: e.ts || 0 }));
          setActivityItems(feedAge < 60 ? recentActivity : []);
          const hasSignal = statusRegion.length > 0 || !!thinkingLine;
          setThinkingActive(hasSignal);
          if (statusRegion.length > 0) {
            workingRef.current = statusRegion.join("\n");
          } else if (thinkingLine) {
            workingRef.current = thinkingLine;
          } else {
            workingRef.current = "";
            liveToolsRef.current = [];
          }
          const el = termRef.current;
          if (el) {
            renderMessages(msgsRef.current, el);
            if (!userScrolledRef.current) {
              requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
            }
          }
        }
      } catch {}
      if (active) timer = setTimeout(pollActivity, 2000);
    }
    workingRef.current = "";
    pollActivity();
    return () => { active = false; clearTimeout(timer); };
  }, [oracleName, agent.target]);

  // Initial load + periodic poll for new messages
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function validateFilePaths(msgs: any[]) {
      const allText = msgs.map((m: any) => m.text || "").join("\n");
      const paths = (allText.match(/(?:\/[\w.\-\/]+\.(?:html?|pdf|md|txt))/gi) || []).filter((f: string) => f.length > 5);
      const unchecked = paths.filter((p: string) => !fileValidCache.current.has(p));
      if (unchecked.length === 0) return;
      await Promise.allSettled(unchecked.map(async (p: string) => {
        try {
          const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`, { method: "HEAD" });
          fileValidCache.current.set(p, res.ok);
        } catch { fileValidCache.current.set(p, false); }
      }));
      // T031: clear hash guard so re-render with new chip state is not skipped
      lastMsgHtmlRef.current = "";
      const el = termRef.current;
      if (el && active) renderMessages(msgsRef.current, el);
    }

    async function loadInitial() {
      try {
        const [transcriptRes, commsRes] = await Promise.all([
          fetch(`/api/transcript?oracle=${encodeURIComponent(oracleName)}&limit=50`),
          fetch(`/api/comms?oracle=${encodeURIComponent(oracleName)}&limit=30`).catch(() => null),
        ]);
        const data = await transcriptRes.json();
        if (!active) return;
        let msgs = data.messages || [];
        // Interleave outbound heys as right-aligned "→ target" messages
        if (commsRes) {
          try {
            const comms = await commsRes.json();
            const outbound = (comms.messages || [])
              .filter((c: any) => c.from === oracleName)
              .map((c: any) => ({ role: "outbound" as const, text: c.text, ts: c.ts, idx: -1, to: c.to }));
            if (outbound.length > 0) {
              msgs = [...msgs, ...outbound].sort((a: any, b: any) => (a.ts || "").localeCompare(b.ts || ""));
            }
          } catch {}
        }
        msgsRef.current = msgs;
        hasMoreRef.current = data.hasMore ?? false;
        const el = termRef.current;
        if (el) {
          renderMessages(msgsRef.current, el);
          el.scrollTop = el.scrollHeight;
        }
        validateFilePaths(msgs);
      } catch {}
    }

    async function pollNew() {
      try {
        // Prune stale optimistic bubbles (>15s). A pending "you" message is
        // reconciled when its echo lands in the local transcript — but a
        // federated send (e.g. to nobi on another node) never echoes back
        // here, so without this it stays pinned at the bottom forever.
        const now = Date.now();
        const stale = (m: any) => m.pending && now - new Date(m.ts || 0).getTime() > 15000;
        if (msgsRef.current.some(stale)) {
          msgsRef.current = msgsRef.current.filter((m: any) => !stale(m));
          const el0 = termRef.current;
          if (el0) renderMessages(msgsRef.current, el0);
        }
        // Fetch both transcript and comms incrementally
        const [transcriptRes, commsRes] = await Promise.all([
          fetch(`/api/transcript?oracle=${encodeURIComponent(oracleName)}&limit=10`),
          fetch(`/api/comms?oracle=${encodeURIComponent(oracleName)}&limit=10`).catch(() => null),
        ]);
        if (!active) return;
        const transcriptData = await transcriptRes.json();
        const newTranscript = transcriptData.messages || [];

        // Find highest transcript idx (skip outbound/pending which have idx -1 or synthetic)
        const transcriptMsgs = msgsRef.current.filter((m: any) => m.role !== "outbound" && !m.pending);
        const existingMax = transcriptMsgs.length > 0 ? transcriptMsgs[transcriptMsgs.length - 1].idx : -1;
        const freshTranscript = newTranscript.filter((m: any) => m.idx > existingMax);

        // Fetch new outbound heys
        let freshOutbound: any[] = [];
        if (commsRes) {
          try {
            const commsData = await commsRes.json();
            const outbound = (commsData.messages || [])
              .filter((c: any) => c.from === oracleName)
              .map((c: any) => ({ role: "outbound" as const, text: c.text, ts: c.ts, idx: -1, to: c.to }));
            // Only add outbound not already in timeline (by timestamp match)
            const existingTs = new Set(msgsRef.current.filter((m: any) => m.role === "outbound").map((m: any) => m.ts));
            freshOutbound = outbound.filter((o: any) => !existingTs.has(o.ts));
          } catch {}
        }

        if (freshTranscript.length > 0 || freshOutbound.length > 0) {
          // Keep existing timeline, append fresh, re-sort by timestamp
          const pending = msgsRef.current.filter((m: any) => m.pending);
          const existing = msgsRef.current.filter((m: any) => !m.pending);
          const raw = [...existing, ...freshTranscript, ...freshOutbound]
            .sort((a: any, b: any) => (a.ts || "").localeCompare(b.ts || ""));
          // T058v2: dedup by ts+role
          const seen = new Set<string>();
          const merged = raw.filter((m: any) => {
            const key = `${m.ts || ""}|${m.role || ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          // Reconcile pending by ts proximity (<5s)
          msgsRef.current = [...merged, ...pending.filter((p: any) => {
            const pTs = new Date(p.ts || 0).getTime();
            return !freshTranscript.some((f: any) => f.role === "user" && Math.abs(new Date(f.ts || 0).getTime() - pTs) < 5000);
          })];
          const el = termRef.current;
          if (el) {
            renderMessages(msgsRef.current, el);
            if (!userScrolledRef.current) {
              requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
            }
          }
          // T031: validate file paths in new messages for live chip rendering
          validateFilePaths([...freshTranscript, ...freshOutbound]);
        }
      } catch {}
      if (active) timer = setTimeout(pollNew, 3000);
    }

    // T026: listen for real-time transcript deltas from WS
    let hasWatcher = false;
    const onDelta = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.oracle !== oracleName || !active) return;
      hasWatcher = true;
      const newMsgs = (detail.messages || []).map((m: any, i: number) => ({
        ...m, idx: (msgsRef.current.length > 0 ? msgsRef.current[msgsRef.current.length - 1].idx + 1 : 0) + i,
      }));
      if (newMsgs.length === 0) return;
      // T058v2: robust dedup — ts+role exact match OR pending reconcile by ts proximity
      const seen = new Set<string>();
      msgsRef.current.forEach((m: any) => {
        seen.add(`${m.ts || ""}|${m.role || ""}`);
      });
      const fresh = newMsgs.filter((m: any) => {
        const key = `${m.ts || ""}|${m.role || ""}`;
        if (seen.has(key)) return false;
        // Reconcile pending: if incoming user msg arrives within 5s of a pending msg, replace it
        if (m.role === "user") {
          const incomingTs = new Date(m.ts || 0).getTime();
          const pendingMatch = msgsRef.current.findIndex((x: any) =>
            x.pending && x.role === "user" && Math.abs(new Date(x.ts || 0).getTime() - incomingTs) < 5000
          );
          if (pendingMatch >= 0) {
            msgsRef.current.splice(pendingMatch, 1);
          }
        }
        return true;
      });
      if (fresh.length === 0) return;
      msgsRef.current = [...msgsRef.current, ...fresh];
      const el = termRef.current;
      if (el) {
        renderMessages(msgsRef.current, el);
        if (!userScrolledRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      }
      // T031: validate file paths in delta messages for live chip rendering
      validateFilePaths(fresh);
      // T063 pivot: capture live tools from deltas (ephemeral — for busy bubble)
      const deltaTools = fresh.flatMap((m: any) => (m.tools || []).map((t: any) => ({ name: t.name, command: t.command })));
      if (deltaTools.length > 0) liveToolsRef.current = deltaTools.slice(-3);
    };
    window.addEventListener("transcript-delta", onDelta);

    loadInitial().then(() => { if (active) timer = setTimeout(pollNew, hasWatcher ? 30000 : 3000); });
    return () => { active = false; clearTimeout(timer); window.removeEventListener("transcript-delta", onDelta); };
  }, [oracleName]);

  // Event delegation: tap anywhere on bubble to expand (stable handler, survives re-renders)
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('a, button, img, .msg-actions, [data-raw]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
      const bubble = target.closest('[data-expandable]') as HTMLElement | null;
      if (!bubble) return;
      const msgId = +(bubble.dataset.expandable || "0");
      if (msgId) (window as any).__msgExpand(msgId);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  // Infinite scroll-up: load older page when user hits top
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      userScrolledRef.current = !nearBottom;

      // Load older messages when scrolled near top
      if (el.scrollTop < 100 && hasMoreRef.current && !loadingMoreRef.current && msgsRef.current.length > 0) {
        loadingMoreRef.current = true;
        const oldestIdx = msgsRef.current[0].idx;
        const prevHeight = el.scrollHeight;
        fetch(`/api/transcript?oracle=${encodeURIComponent(oracleName)}&limit=50&before=${oldestIdx}`)
          .then(r => r.json())
          .then(data => {
            const older = data.messages || [];
            if (older.length > 0) {
              msgsRef.current = [...older, ...msgsRef.current];
              renderMessages(msgsRef.current, el);
              // Keep scroll anchor — restore position relative to old content
              requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight - prevHeight;
              });
            }
            hasMoreRef.current = data.hasMore ?? false;
            loadingMoreRef.current = false;
          })
          .catch(() => { loadingMoreRef.current = false; });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [oracleName]);

  // ─── Send command (reads from native input, no React state) ───
  const handleSend = useCallback(() => {
    const input = nativeInputRef.current;
    if (!input) return;
    const val = input.value;
    const msg = buildMessage(val);
    let text = msg || "";

    // Prepend reply ref for oracle context (short one-line)
    const reply = replyRef.current;
    let replyMeta: { sender: string; preview: string } | null = null;
    if (reply && text.trim()) {
      const words = reply.preview.split(/\s+/).slice(0, 6).join(" ");
      text = `↩︎[${reply.sender}@${reply.time}] ${words}…\n${text}`;
      replyMeta = { sender: reply.sender, preview: reply.preview };
      replyRef.current = null;
      const chip = document.getElementById("reply-chip");
      if (chip) chip.style.display = "none";
    }

    send({ type: "send", target: agent.target, text: (text || "\r") + (text ? "\r" : "") });

    // T036: optimistic busy bubble — show immediately on send
    if (text.trim()) {
      workingRef.current = "กำลังทำงาน…";
      setThinkingActive(true);
      emptyThinkingCount.current = 0;
    }

    // Optimistic local echo
    if (text.trim()) {
      const displayText = text.replace(/\r$/, "");
      sentFromDashboard.current.add(displayText.slice(0, 50));
      const maxIdx = msgsRef.current.length > 0 ? msgsRef.current[msgsRef.current.length - 1].idx + 1 : 0;
      const echo = { role: "user", text: displayText, ts: new Date().toISOString(), idx: maxIdx, pending: true, replyMeta };
      msgsRef.current = [...msgsRef.current, echo];
      const el = termRef.current;
      if (el) {
        renderMessages(msgsRef.current, el);
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      }
      userScrolledRef.current = false;
    }

    input.value = "";
    clearAttachments();
    input.focus();
  }, [agent.target, send, buildMessage, clearAttachments]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  // Quick command — force: true skips pane check (escape sequences need instant delivery)
  const sendCmd = useCallback((text: string) => {
    send({ type: "send", target: agent.target, text, force: true });
  }, [agent.target, send]);

  return (
    <div className={`fixed inset-0 z-50${isDesktop ? " flex items-center justify-center" : ""}`} onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.6)" }} />

      {/* Sheet — desktop: centered floating card; mobile: bottom sheet */}
      <div
        ref={sheetRef}
        className={isDesktop
          ? "oracle-sheet relative border flex flex-col overflow-hidden"
          : "oracle-sheet oracle-sheet-enter absolute bottom-0 left-0 right-0 border-t flex flex-col overflow-hidden"
        }
        style={{
          background: "#0a0a14",
          borderColor: `${accent}30`,
          height: isDesktop ? "85vh" : "60vh",
          maxHeight: isDesktop ? "85vh" : undefined,
          borderRadius: isDesktop ? "16px" : "16px 16px 0 0",
          overscrollBehavior: "contain",
          maxWidth: 640,
          width: isDesktop ? "100%" : undefined,
          margin: isDesktop ? undefined : "0 auto",
          animation: isDesktop ? "none" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1 flex-shrink-0" style={{ touchAction: "none" }}>
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${accent}15` }}>
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-bold text-white"
            style={{ background: accent }}
          >
            {displayName.substring(0, 2).toUpperCase()}
          </div>

          <div className="flex-1 min-w-0">
            <div className="text-base font-bold truncate" style={{ color: accent }}>{displayName}</div>
            <div className="text-[10px] text-white/40 font-mono truncate">{agent.target}</div>
          </div>

          <div
            className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold"
            style={{ background: status.bg, color: status.color }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: status.color }} />
            {status.label}
          </div>

          <button
            onClick={() => setExpanded(!expandedRef.current)}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-white/40 active:scale-90 text-sm"
            style={{ background: "rgba(255,255,255,0.06)" }}
          >
            {expanded ? "⌄" : "⌃"}
          </button>

          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-white/50 active:scale-90 text-lg"
            style={{ background: "rgba(255,255,255,0.06)" }}
          >
            ✕
          </button>
        </div>

        {/* Preview */}
        {agent.preview && (
          <div className="mx-3 mt-1.5 px-3 py-2 rounded-lg text-[11px] font-mono text-white/50 leading-relaxed flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.02)" }}
          >
            {agent.preview.slice(0, 150)}
          </div>
        )}

        {/* Transcript */}
        <div className="mx-3 mt-1.5 flex-1 min-h-0 rounded-lg overflow-hidden flex flex-col"
          style={{ background: "#08080c" }}
        >
          <div className="flex items-center px-3 py-1 border-b border-white/[0.03] flex-shrink-0">
            <span className="text-[8px] text-white/25 tracking-widest uppercase font-mono">History</span>
            <span className="w-1.5 h-1.5 rounded-full ml-auto" style={{ background: "#4caf50" }} />
            <button onClick={onFullscreen} className="ml-2 text-[9px] text-white/30 font-mono active:text-white/60">⛶</button>
          </div>
          <div
            ref={termRef}
            className="flex-1 overflow-y-auto px-3 py-2 text-[#cdd6f4]"
            style={{ fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "14px", lineHeight: "1.5", wordBreak: "break-word", overscrollBehavior: "contain", touchAction: "pan-y", userSelect: "text", WebkitUserSelect: "text", cursor: "text", WebkitOverflowScrolling: "touch" } as any}
          />
          <div ref={busyDivRef} className="px-3 flex-shrink-0" />
        </div>

        {/* Status footer — mini progress bars + model */}
        {statusBar && (() => {
          const bar = (pct: number, w = 28) => {
            const c = pct >= 80 ? "#f38ba8" : pct >= 50 ? "#f9e2af" : "#a6e3a1";
            return `<span style="display:inline-block;width:${w}px;height:4px;background:rgba(255,255,255,0.08);border-radius:2px;vertical-align:middle"><span style="display:block;width:${pct}%;height:100%;background:${c};border-radius:2px"></span></span>`;
          };
          const model = statusBar.model
            ? statusBar.model.replace(/\((\d+[KMkm])\s*context\)/, "($1)").replace(/\((\d+[KMkm])\)/, "($1)")
            : "—";
          const parts: string[] = [];
          if (statusBar.contextPercent !== null) parts.push(`${bar(statusBar.contextPercent, 32)} ${statusBar.contextPercent}% ${statusBar.contextTokens || ""}`);
          if (statusBar.usage5h !== null) parts.push(`· 5h ${bar(statusBar.usage5h)} ${statusBar.usage5h}%`);
          if (statusBar.usage7d !== null) parts.push(`· 7d ${bar(statusBar.usage7d)} ${statusBar.usage7d}%`);
          parts.push(`· <span style="color:rgba(255,255,255,0.25)">${model}</span>`);
          return (
            <div className="mx-3 px-3 py-1.5 flex-shrink-0 text-[10px] font-mono"
              style={{ background: "rgba(255,255,255,0.02)", borderTop: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.35)", opacity: (statusBar as any).stale ? 0.5 : 1 }}
              dangerouslySetInnerHTML={{ __html: parts.join(" ") + ((statusBar as any).stale ? ` · <span style="color:rgba(255,255,255,0.2)">cached</span>` : "") }} />
          );
        })()}

        {/* Attachment chips */}
        {(attachments.length > 0 || uploading) && (
          <div className="px-3 py-1 flex-shrink-0" style={{ background: "#0e0e18" }}>
            <AttachmentChips attachments={attachments} onRemove={removeAttachment} uploading={uploading} />
          </div>
        )}

        {/* Picker overlay — dismissible, above composer, doesn't capture scroll */}
        <div id="picker-strip" className="flex-shrink-0" style={{ display: "none", background: "#0c0c16", borderTop: "1px solid rgba(137,180,250,0.2)", padding: "8px 12px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5", color: "rgba(255,255,255,0.7)", maxHeight: "180px", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
            <span style={{ fontSize: "10px", color: "#89b4fa", fontWeight: 600 }}>🎯 Picker — use ↑↓ Enter Esc</span>
            <button onClick={() => { const el = document.getElementById("picker-strip"); if (el) el.style.display = "none"; }} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: "13px" }}>✕</button>
          </div>
          <div id="picker-content" />
        </div>

        {/* Reply quote chip */}
        <div id="reply-chip" className="px-3 py-1 flex-shrink-0" style={{ display: "none", background: "#0e0e18", borderTop: "1px solid rgba(255,255,255,0.06)", alignItems: "center" }} />

        {/* T022: Queue strip — shows pending/queued messages */}
        {queueInfo && queueInfo.count > 0 && (
          <div className="px-3 py-1.5 flex-shrink-0 text-[11px]" style={{ background: "rgba(253,216,53,0.06)", borderTop: "1px solid rgba(253,216,53,0.15)", color: "#fdd835" }}>
            <span style={{ fontWeight: 600 }}>คิวค้าง: </span>
            {queueInfo.typing && <span style={{ color: "rgba(255,255,255,0.5)" }}>{queueInfo.typing.slice(0, 50)}… </span>}
            {queueInfo.items.length > 0 && <span style={{ color: "rgba(255,255,255,0.3)" }}>+{queueInfo.items.length} queued</span>}
          </div>
        )}

        {/* Talk input — uncontrolled for zero input lag */}
        <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ background: "#0e0e18", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <FileInput inputRef={fileInputRef} onChange={onFileChange} />
          <button
            onClick={pickFile}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg active:scale-90"
            style={{ background: "rgba(255,255,255,0.06)", color: uploading ? "#22d3ee" : "rgba(255,255,255,0.4)" }}
            title="Attach file"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <ProjectSelector agentName={agent.name} compact />
          <textarea
            ref={nativeInputRef as any}
            defaultValue=""
            rows={1}
            onKeyDown={handleInputKeyDown}
            onPaste={onPaste}
            onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 80) + "px"; }}
            className="flex-1 bg-transparent text-white/90 outline-none font-mono text-sm resize-none"
            style={{ caretColor: "#22d3ee", lineHeight: "1.4" }}
            inputMode="text"
            enterKeyHint="send"
            spellCheck={false}
            autoComplete="off"
            placeholder="talk to oracle..."
          />
          <button
            onClick={handleSend}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-cyan-500 text-black text-xs font-bold active:bg-cyan-600"
          >
            SEND
          </button>
        </div>

        {/* Quick commands */}
        <div className="flex items-center gap-1 px-3 py-1.5 flex-shrink-0 overflow-x-auto" style={{ background: "#0a0a12", borderTop: "1px solid rgba(255,255,255,0.03)", touchAction: "pan-x", overscrollBehavior: "contain" }}>
          {FULL_COMMANDS.map(cmd => (
            <button
              key={cmd.label}
              onClick={() => {
                if (cmd.action === "wake") sendCmd(guessCommand(agent.name));
                else if (cmd.action === "restart") { if (confirm(`Restart ${cleanName(agent.name)}?`)) send({ type: "restart", target: agent.target }); }
                else if (cmd.action) send({ type: cmd.action, target: agent.target });
                else sendCmd(cmd.text);
              }}
              className="shrink-0 px-2.5 py-1 rounded text-[10px] font-mono active:scale-90"
              style={{ background: `${cmd.color}12`, color: cmd.color, border: `1px solid ${cmd.color}20` }}
            >
              {cmd.label}
            </button>
          ))}
        </div>

        {/* Siblings */}
        {siblings.length > 1 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 flex-shrink-0 overflow-x-auto" style={{ background: "#08080e", borderTop: "1px solid rgba(255,255,255,0.03)", touchAction: "pan-x" }}>
            <span className="text-[8px] uppercase tracking-wider text-white/20 shrink-0">Room:</span>
            {siblings.filter(s => s.target !== agent.target).map((s) => {
              const sColor = agentColor(s.name);
              const sStatus = STATUS_CONFIG[s.status] || STATUS_CONFIG.idle;
              return (
                <button
                  key={s.target}
                  onClick={() => onSelectSibling(s)}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono whitespace-nowrap active:scale-95 shrink-0"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: sStatus.color }} />
                  <span style={{ color: sColor }}>{cleanName(s.name)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
// build 2026-07-05T16:06:52+07:00
