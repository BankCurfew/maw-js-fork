import { memo, useState, useRef, useCallback, useEffect } from "react";
import { useFleetStore } from "../lib/store";
import { agentColor } from "../lib/constants";
import { useFileAttach, FileInput, AttachmentChips } from "../hooks/useFileAttach";
import type { AskItem } from "../lib/types";

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const TYPE_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  input: { bg: "rgba(34,211,238,0.15)", text: "#22d3ee", label: "Input" },
  attention: { bg: "rgba(251,191,36,0.15)", text: "#fbbf24", label: "Attention" },
  plan: { bg: "rgba(168,85,247,0.15)", text: "#a855f7", label: "Approval" },
  report: { bg: "rgba(34,197,94,0.15)", text: "#22c55e", label: "Report" },
  meeting: { bg: "rgba(59,130,246,0.15)", text: "#3b82f6", label: "Meeting" },
  handoff: { bg: "rgba(249,115,22,0.15)", text: "#f97316", label: "Handoff" },
};

// --- Linkify: auto-link URLs, GitHub repos, issues, commits ---

function Linkify({ text }: { text: string }) {
  const parts: (string | { href: string; label: string })[] = [];
  const urlRegex = /(https?:\/\/[^\s<>"')\]]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[1];
    let label = url;
    const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/(issues|pull|commit)\/(\w+)/);
    if (ghMatch) {
      const [, repo, type, id] = ghMatch;
      label = type === "commit" ? `${repo}@${id.slice(0, 7)}` : `${repo}#${id}`;
    } else if (url.length > 60) {
      label = url.slice(0, 57) + "...";
    }
    parts.push({ href: url, label });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
            onClick={(e) => e.stopPropagation()}>
            {p.label}
          </a>
        )
      )}
    </>
  );
}

/** Format a single line with basic markdown-like styling */
function FormattedLine({ line }: { line: string }) {
  // Section headers: lines starting with — or ### or ALL CAPS ending with :
  if (/^(---|—|\*\*\*|###)\s/.test(line) || /^[A-Z][A-Z\s/_&]{4,}:?\s*$/.test(line.trim())) {
    const clean = line.replace(/^(---|—|\*\*\*|###)\s*/, "").trim();
    return (
      <div className="text-white/60 text-xs font-semibold uppercase tracking-wider mt-3 mb-1 pt-2"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        {clean || line.trim()}
      </div>
    );
  }
  // Numbered items: 1. 2. etc
  const numMatch = line.match(/^(\d+)\.\s+(.+)/);
  if (numMatch) {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-cyan-400/60 font-mono flex-shrink-0 w-5 text-right">{numMatch[1]}.</span>
        <span><Linkify text={numMatch[2]} /></span>
      </div>
    );
  }
  // Bullet items: - or •
  const bulletMatch = line.match(/^[\-•]\s+(.+)/);
  if (bulletMatch) {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-white/30 flex-shrink-0">·</span>
        <span><Linkify text={bulletMatch[1]} /></span>
      </div>
    );
  }
  // Fix/issue lines with emoji or tags
  if (/^(Fix:|Bug:|TODO:|CRITICAL|WARNING|NOTE)/i.test(line.trim())) {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: "2px solid rgba(251,191,36,0.3)" }}>
        <Linkify text={line} />
      </div>
    );
  }
  return <div>{line ? <Linkify text={line} /> : <br />}</div>;
}

const COLLAPSE_LINES = 8;

/** Render message text with auto-linked URLs and collapsible long content */
function LinkedMessage({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = lines.length > COLLAPSE_LINES;
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSE_LINES);

  return (
    <div className={className}>
      {visibleLines.map((line, i) => (
        <FormattedLine key={i} line={line} />
      ))}
      {isLong && !expanded && (
        <button
          className="text-xs text-cyan-400/70 hover:text-cyan-400 mt-2 font-mono"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
          Show more ({lines.length - COLLAPSE_LINES} more lines)
        </button>
      )}
      {isLong && expanded && (
        <button
          className="text-xs text-white/30 hover:text-white/50 mt-2 font-mono"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>
          Show less
        </button>
      )}
    </div>
  );
}

// --- Parsers ---

interface HandoffData { from: string; to: string; message: string; }
interface MeetingData {
  goal: string;
  participants: { oracle: string; status: string }[];
  discussion: { oracle: string; message: string }[];
  tasks: { oracle: string; task: string; priority: string }[];
}

function tryParseHandoff(message: string): HandoffData | null {
  if (!message.includes("[handoff]")) return null;
  try {
    return JSON.parse(message.slice(message.indexOf("[handoff]") + "[handoff] ".length));
  } catch { return null; }
}

function tryParseMeeting(message: string): MeetingData | null {
  if (!message.includes("[meeting]")) return null;
  try {
    return JSON.parse(message.slice(message.indexOf("[meeting]") + "[meeting] ".length));
  } catch { return null; }
}

interface ProposalData { oracle: string; title: string; url: string; body: string; verdict?: string; }

function tryParseProposal(message: string): ProposalData | null {
  if (!message.includes("[proposal]")) return null;
  try {
    return JSON.parse(message.slice(message.indexOf("[proposal]") + "[proposal] ".length));
  } catch { return null; }
}

/** Strip [prefix] and convert raw feed messages into human-readable text */
function cleanMessage(message: string): string {
  const cleaned = message
    .replace(/ \u239C /g, "\n")  // ␤ → newline
    .trim();

  // Meeting JSON → human summary
  if (cleaned.includes("[meeting]")) {
    try {
      const json = JSON.parse(cleaned.slice(cleaned.indexOf("[meeting]") + "[meeting] ".length));
      const parts = [`Meeting: ${json.goal}`];
      if (json.participants) parts.push(`Team: ${json.participants.map((p: any) => p.oracle).join(", ")}`);
      if (json.tasks?.length) parts.push(`${json.tasks.length} tasks assigned`);
      return parts.join("\n");
    } catch {}
  }

  // Handoff JSON → human summary
  if (cleaned.includes("[handoff]")) {
    try {
      const json = JSON.parse(cleaned.slice(cleaned.indexOf("[handoff]") + "[handoff] ".length));
      return `${json.from} → ${json.to}: ${json.message}`;
    } catch {}
  }

  // Supervisor report JSON → human summary
  if (cleaned.includes("[supervisor-report]")) {
    try {
      const json = JSON.parse(cleaned.slice(cleaned.indexOf("[supervisor-report]") + "[supervisor-report] ".length));
      return `${json.oracle} completed: ${json.task}\n${json.summary || ""}`;
    } catch {}
  }

  // Strip remaining prefixes
  return cleaned
    .replace(/^\[(?:report|handoff|meeting|supervisor-report|proposal)\]\s*/i, "")
    .replace(/^report:\s*/i, "")
    .trim();
}

// --- Handoff Card (Dev → QA style) ---

function HandoffCard({ ask }: { ask: AskItem }) {
  const dismissAsk = useFleetStore((s) => s.dismissAsk);
  const handoff = tryParseHandoff(ask.message);
  const fromName = handoff?.from || ask.oracle;
  const toName = handoff?.to || "?";
  const msg = handoff?.message || cleanMessage(ask.message);
  const fromColor = agentColor(fromName);
  const toColor = agentColor(toName);

  return (
    <div className="rounded-xl p-5 border transition-all"
      style={{ background: "rgba(249,115,22,0.05)", borderColor: "rgba(249,115,22,0.20)" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: `${fromColor}25`, color: fromColor }}>
          {fromName.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-semibold" style={{ color: fromColor }}>
          {fromName}
        </span>
        <span className="text-white/40 text-sm">&rarr;</span>
        <span className="text-sm font-semibold" style={{ color: toColor }}>
          {toName}
        </span>
        <span className="text-xs font-mono px-2 py-1 rounded"
          style={{ background: "rgba(249,115,22,0.15)", color: "#f97316" }}>
          Handoff
        </span>
        <span className="text-xs font-mono text-white/40 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>
      <LinkedMessage text={msg} className="text-sm text-white/85 mb-4 leading-relaxed" />
      <div className="flex items-center">
        <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all ml-auto hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- Meeting Card ---

function MeetingCard({ ask, meeting }: { ask: AskItem; meeting: MeetingData }) {
  const dismissAsk = useFleetStore((s) => s.dismissAsk);

  return (
    <div className="rounded-xl p-5 border transition-all"
      style={{ background: "rgba(59,130,246,0.05)", borderColor: "rgba(59,130,246,0.20)" }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: "rgba(59,130,246,0.25)", color: "#3b82f6" }}>
          B
        </div>
        <span className="text-sm font-semibold" style={{ color: "#3b82f6" }}>
          BoB's Meeting
        </span>
        <span className="text-xs font-mono px-2 py-1 rounded"
          style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}>
          Meeting
        </span>
        <span className="text-xs font-mono text-white/40 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>

      {/* Goal */}
      <p className="text-sm text-white/90 mb-4 font-semibold">{meeting.goal}</p>

      {/* Participants */}
      <div className="flex flex-wrap gap-2 mb-4">
        {meeting.participants.map((p) => (
          <span key={p.oracle} className="text-xs font-mono px-2.5 py-1 rounded inline-flex items-center gap-1.5"
            style={{
              background: p.status === "ready" ? "rgba(34,197,94,0.12)" : "rgba(251,191,36,0.12)",
              color: p.status === "ready" ? "#22c55e" : "#fbbf24",
            }}>
            <span className="w-2 h-2 rounded-full" style={{ background: "currentColor" }} />
            {p.oracle}
          </span>
        ))}
      </div>

      {/* Discussion summary */}
      {meeting.discussion.filter(d => d.oracle !== "BoB").map((d, i) => (
        <div key={i} className="mb-2">
          <span className="text-xs font-semibold mr-2" style={{ color: agentColor(d.oracle) }}>
            {d.oracle}:
          </span>
          <span className="text-xs text-white/70 leading-relaxed">
            {d.message.split("\n").filter(l => l.trim()).slice(0, 3).join(" ").slice(0, 200)}
            {d.message.length > 200 ? "..." : ""}
          </span>
        </div>
      ))}

      {/* Tasks */}
      {meeting.tasks.length > 0 && (
        <div className="rounded-lg overflow-hidden mt-4 mb-4" style={{ background: "rgba(255,255,255,0.03)" }}>
          {meeting.tasks.map((t, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-xs"
              style={{ borderBottom: i < meeting.tasks.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
              <span className="text-amber-400 flex-shrink-0 w-6 font-mono font-bold">{t.priority}</span>
              <span className="flex-shrink-0 w-24 truncate font-semibold" style={{ color: agentColor(t.oracle) }}>
                {t.oracle}
              </span>
              <span className="text-white/50 flex-shrink-0">&rarr;</span>
              <span className="text-white/75 flex-1">{t.task}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center">
        <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all ml-auto hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- Proposal Card ---

function ProposalCard({ ask, proposal, send }: { ask: AskItem; proposal: ProposalData; send: (msg: object) => void }) {
  const dismissAsk = useFleetStore((s) => s.dismissAsk);
  const [acted, setActed] = useState<"approved" | "rejected" | null>(null);
  const accent = agentColor(proposal.oracle);

  const handleApprove = useCallback(() => {
    const bobTarget = (() => {
      // Try recentMap first
      const { recentMap } = useFleetStore.getState();
      for (const [t, info] of Object.entries(recentMap)) {
        const name = (info as any).name?.toLowerCase() || "";
        if (name.includes("bob")) return t;
      }
      // Fallback: known BoB target
      return "01-bob:0";
    })();
    send({ type: "send", target: bobTarget, text: `Approved: "${proposal.title}" by ${proposal.oracle}. Execute it — /talk-to ${proposal.oracle} "Execute your proposal: ${proposal.title}. Issue: ${proposal.url}"`, force: true });
    setActed("approved");
    setTimeout(() => dismissAsk(ask.id), 1500);
  }, [ask, proposal, send, dismissAsk]);

  if (acted) {
    return (
      <div className="rounded-xl p-4 border opacity-60"
        style={{ background: acted === "approved" ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)", borderColor: acted === "approved" ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)" }}>
        <span className="text-sm font-mono" style={{ color: acted === "approved" ? "#22c55e" : "#ef4444" }}>
          {acted === "approved" ? "Approved — BoB executing" : "Rejected"}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5 border transition-all"
      style={{ background: "rgba(168,85,247,0.05)", borderColor: "rgba(168,85,247,0.20)" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: `${accent}25`, color: accent }}>
          {proposal.oracle.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-semibold" style={{ color: accent }}>
          {proposal.oracle}
        </span>
        <span className="text-xs font-mono px-2 py-1 rounded"
          style={{ background: "rgba(168,85,247,0.15)", color: "#a855f7" }}>
          Proposal
        </span>
        <span className="text-xs font-mono text-white/40 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>

      <p className="text-base text-white/95 mb-3 font-semibold">{proposal.title}</p>
      <LinkedMessage text={proposal.body} className="text-sm text-white/70 mb-4 leading-relaxed " />

      <div className="flex items-center gap-2">
        {proposal.url && (
          <a href={proposal.url} target="_blank" rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all inline-flex items-center gap-1"
            style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee" }}
            onClick={(e) => e.stopPropagation()}>
            Issue
          </a>
        )}
        <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all"
          style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
          onClick={handleApprove}>
          Approve
        </button>
        <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all"
          style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
          onClick={() => { setActed("rejected"); setTimeout(() => dismissAsk(ask.id), 1000); }}>
          Reject
        </button>
        <button className="px-3 py-2 rounded-lg text-xs font-mono active:scale-95 transition-all ml-auto hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- Report Card ---

function ReportCard({ ask }: { ask: AskItem }) {
  const dismissAsk = useFleetStore((s) => s.dismissAsk);
  const accent = agentColor(ask.oracle);
  const msg = cleanMessage(ask.message);

  return (
    <div className="rounded-xl p-5 border transition-all"
      style={{ background: "rgba(34,197,94,0.05)", borderColor: "rgba(34,197,94,0.20)" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: `${accent}25`, color: accent }}>
          {ask.oracle.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-semibold" style={{ color: accent }}>
          {ask.oracle}
        </span>
        <span className="text-xs font-mono px-2 py-1 rounded"
          style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
          Report
        </span>
        <span className="text-xs font-mono text-white/40 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>
      <LinkedMessage text={msg} className="text-sm text-white/85 mb-4 leading-relaxed" />
      <div className="flex items-center">
        <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all ml-auto hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- Generic Ask Card (input, attention, plan) ---

function AskCard({ ask, send, onClose }: { ask: AskItem; send: (msg: object) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dismissAsk = useFleetStore((s) => s.dismissAsk);
  const accent = agentColor(ask.oracle);
  const style = TYPE_STYLE[ask.type] || TYPE_STYLE.input;
  const { uploading, attachments, inputRef, pickFile, onFileChange, removeAttachment, clearAttachments, buildMessage, drag, onPaste } = useFileAttach();

  const sendReply = useCallback((reply: string) => {
    let target = ask.target;
    if (!target) {
      const { recentMap } = useFleetStore.getState();
      const oracleLower = ask.oracle.toLowerCase().replace("-oracle", "");
      for (const [t, info] of Object.entries(recentMap)) {
        const name = (info as any).name?.toLowerCase() || "";
        if (name === ask.oracle.toLowerCase()
          || name === `${oracleLower}-oracle`
          || name.replace("-oracle", "") === oracleLower) {
          target = t;
          break;
        }
      }
    }
    if (!target) {
      alert(`Cannot reach ${ask.oracle} — no active session found`);
      return;
    }
    send({ type: "send", target, text: reply, force: true });
    setTimeout(() => send({ type: "send", target, text: "\r" }), 50);
    setSent(true);
    clearAttachments();
    setTimeout(() => dismissAsk(ask.id), 600);
  }, [ask, send, dismissAsk, clearAttachments]);

  const handleSend = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;
    sendReply(buildMessage(text.trim()));
    setText("");
  }, [text, sendReply, buildMessage, attachments]);

  if (sent) {
    return (
      <div className="rounded-xl p-5 border transition-all duration-300 opacity-50"
        style={{ background: "rgba(34,197,94,0.08)", borderColor: "rgba(34,197,94,0.25)" }}>
        <span className="text-sm text-emerald-400 font-mono">Sent</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5 border transition-all"
      style={{ background: "rgba(255,255,255,0.03)", borderColor: `${accent}30` }}
      onPaste={onPaste}
      {...drag}>
      <FileInput inputRef={inputRef} onChange={onFileChange} />
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: `${accent}25`, color: accent }}>
          {ask.oracle.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-semibold" style={{ color: accent }}>
          {ask.oracle}
        </span>
        <span className="text-xs font-mono px-2 py-1 rounded"
          style={{ background: style.bg, color: style.text }}>
          {style.label}
        </span>
        <span className="text-xs font-mono text-white/40 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>

      {/* Message */}
      <LinkedMessage text={cleanMessage(ask.message)} className="text-sm text-white/85 mb-4 leading-relaxed " />

      {/* Attachments */}
      <AttachmentChips attachments={attachments} onRemove={removeAttachment} uploading={uploading} />

      {/* Actions */}
      <div className="flex items-center gap-2 mt-2">
        {(ask.type === "plan" || ask.type === "attention") && (
          <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all"
            style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
            onClick={() => sendReply("y")}>
            Approve
          </button>
        )}
        {ask.type === "plan" && (
          <button className="px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-all"
            style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
            onClick={() => sendReply("n")}>
            Reject
          </button>
        )}
        <button className="px-2 py-2 rounded-lg text-xs active:scale-95 transition-all flex-shrink-0"
          style={{ background: "rgba(255,255,255,0.06)", color: uploading ? "#22d3ee" : "rgba(255,255,255,0.4)" }}
          onClick={pickFile}
          title="Attach file">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea ref={textareaRef} value={text}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Reply..."
          rows={1}
          className="flex-1 min-w-0 px-4 py-2 rounded-lg text-sm text-white outline-none placeholder:text-white/30 resize-none"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", maxHeight: 120, overflowY: "auto" }}
          enterKeyHint="send" autoComplete="off" autoCorrect="off"
        />
        {(text.trim() || attachments.length > 0) && (
          <button className="px-3 py-2 rounded-lg text-xs active:scale-95 transition-all font-semibold"
            style={{ background: `${accent}30`, color: accent }}
            onClick={handleSend}>
            Send
          </button>
        )}
        <button className="px-3 py-2 rounded-lg text-xs font-mono active:scale-95 transition-all hover:bg-white/5"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- Inbox Overlay ---

export const InboxOverlay = memo(function InboxOverlay({ send, onClose }: { send: (msg: object) => void; onClose: () => void }) {
  const asks = useFleetStore((s) => s.asks);
  const pending = asks.filter((a) => !a.dismissed);
  const dismissed = asks.filter((a) => a.dismissed).slice(0, 5);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl mx-2 sm:mx-4 max-h-[90vh] sm:max-h-[80vh] flex flex-col rounded-xl sm:rounded-2xl border overflow-hidden"
        style={{ background: "#0a0a12", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 25px 50px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <h2 className="text-base font-bold tracking-wider text-cyan-400 uppercase">
            Inbox {pending.length > 0 && <span className="text-red-400 ml-1">({pending.length})</span>}
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white/70 text-xl leading-none px-1">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {pending.length === 0 && (
            <div className="text-center py-12">
              <p className="text-white/40 text-base">No pending asks</p>
              <p className="text-white/25 text-sm mt-2">Agents will appear here when they need input</p>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {pending.map((ask) => {
              // Proposal: oracle initiative for approval
              const proposal = tryParseProposal(ask.message);
              if (proposal) {
                return <ProposalCard key={ask.id} ask={ask} proposal={proposal} send={send} />;
              }
              // Handoff: Dev → QA
              const handoff = tryParseHandoff(ask.message);
              if (ask.type === "handoff" || handoff) {
                return <HandoffCard key={ask.id} ask={ask} />;
              }
              // Meeting: BoB's team meeting
              const meeting = tryParseMeeting(ask.message);
              if (ask.type === "meeting" || meeting) {
                return meeting
                  ? <MeetingCard key={ask.id} ask={ask} meeting={meeting} />
                  : <ReportCard key={ask.id} ask={ask} />;
              }
              // Report: oracle status report
              if (ask.type === "report") {
                return <ReportCard key={ask.id} ask={ask} />;
              }
              // Default: input, attention, plan
              return <AskCard key={ask.id} ask={ask} send={send} onClose={onClose} />;
            })}
          </div>

          {dismissed.length > 0 && (
            <>
              <div className="text-xs font-mono text-white/30 uppercase tracking-wider mt-6 mb-3">Recent</div>
              <div className="flex flex-col gap-1.5">
                {dismissed.map((ask) => {
                  const handoff = tryParseHandoff(ask.message);
                  const displayMsg = handoff
                    ? `${handoff.from} → ${handoff.to}: ${handoff.message}`
                    : cleanMessage(ask.message);
                  return (
                    <div key={ask.id} className="flex items-center gap-3 px-4 py-2 rounded-lg opacity-50"
                      style={{ background: "rgba(255,255,255,0.03)" }}>
                      <span className="text-xs font-semibold flex-shrink-0" style={{ color: agentColor(ask.oracle) }}>
                        {ask.oracle}
                      </span>
                      <span className="text-xs text-white/50 truncate flex-1">{displayMsg}</span>
                      <span className="text-xs font-mono text-white/30 flex-shrink-0">{timeAgo(ask.ts)}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
