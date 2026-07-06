import { lazy, Suspense, useState, useRef, useCallback } from "react";
import { useFileAttach, FileInput, AttachmentChips } from "../hooks/useFileAttach";
import type { AgentState } from "../lib/types";
import { ProjectSelector } from "./ProjectSelector";

const XTerminal = lazy(() => import("./XTerminal").then(m => ({ default: m.XTerminal })));

interface TerminalModalProps {
  agent: AgentState;
  send: (msg: object) => void;
  onClose: () => void;
  onNavigate: (dir: -1 | 1) => void;
  onSelectSibling: (agent: AgentState) => void;
  siblings: AgentState[];
}

function cleanName(name: string) {
  return name.replace(/-oracle$/, "").replace(/-/g, " ");
}

const STATUS_DOT: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

export function TerminalModal({ agent, send, onClose, onNavigate, onSelectSibling, siblings }: TerminalModalProps) {
  const [showTabs, setShowTabs] = useState(false);
  const { uploading, attachments, inputRef: fileInputRef, pickFile, onFileChange, removeAttachment, clearAttachments } = useFileAttach();
  const xtermRef = useRef<{ pasteText?: (text: string) => void }>(null);

  const handleUploadAndPaste = useCallback(async () => {
    pickFile();
  }, [pickFile]);

  // When attachments change, paste URLs into terminal
  const lastAttachCountRef = useRef(0);
  if (attachments.length > lastAttachCountRef.current) {
    const newAtts = attachments.slice(lastAttachCountRef.current);
    const urls = newAtts.map(a => a.localUrl).join(" ");
    // Send the local path to the terminal as if typed
    setTimeout(() => {
      send({ type: "send", target: agent.target, text: urls, force: true });
      clearAttachments();
    }, 100);
  }
  lastAttachCountRef.current = attachments.length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0f]"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)", touchAction: "manipulation", overflow: "hidden", width: "100vw", height: "100vh", left: 0, top: 0 }}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-1.5 sm:py-2 bg-[#0e0e18] border-b border-white/[0.06] flex-shrink-0">
          {/* Close button — traffic light on desktop, X on mobile */}
          <div className="hidden sm:flex gap-1.5 shrink-0">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-110 cursor-pointer" />
            <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>

          {/* Mobile: back button + agent name */}
          <button onClick={onClose} className="sm:hidden min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-white/50 active:scale-95" style={{ background: "rgba(255,255,255,0.06)" }}>
            ←
          </button>

          {/* Current agent name (always visible) */}
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_DOT[agent.status] || "#555" }} />
            <span className="text-xs sm:text-sm font-mono text-white/80 truncate">{cleanName(agent.name)}</span>
          </div>

          {/* Desktop: inline tab bar */}
          <div className="hidden sm:flex items-center gap-0.5 overflow-x-auto scrollbar-none mx-2 flex-1">
            {siblings.map((s, i) => {
              const active = s.target === agent.target;
              return (
                <button
                  key={s.target}
                  onClick={() => onSelectSibling(s)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono whitespace-nowrap cursor-pointer transition-all ${
                    active
                      ? "bg-white/10 text-white/90"
                      : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: STATUS_DOT[s.status] || "#555" }}
                  />
                  {i < 9 && (
                    <span className="text-[9px] text-white/20">{i + 1}</span>
                  )}
                  {cleanName(s.name)}
                </button>
              );
            })}
          </div>

          {/* Mobile: tab toggle + nav arrows */}
          {siblings.length > 1 && (
            <div className="sm:hidden flex items-center gap-1 ml-auto">
              <button
                onClick={() => onNavigate(-1)}
                className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-white/40 active:scale-95 active:text-white/80"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                ‹
              </button>
              <button
                onClick={() => setShowTabs(!showTabs)}
                className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-[10px] font-mono text-white/40 active:scale-95"
                style={{ background: showTabs ? "rgba(34,211,238,0.15)" : "rgba(255,255,255,0.04)" }}
              >
                {siblings.findIndex(s => s.target === agent.target) + 1}/{siblings.length}
              </button>
              <button
                onClick={() => onNavigate(1)}
                className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-white/40 active:scale-95 active:text-white/80"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                ›
              </button>
            </div>
          )}

          <div className="ml-auto hidden sm:flex items-center gap-2 shrink-0">
            <FileInput inputRef={fileInputRef} onChange={onFileChange} />
            <button
              onClick={handleUploadAndPaste}
              className="px-2 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-cyan-400 hover:bg-cyan-400/10 border border-transparent hover:border-cyan-400/20 transition-all cursor-pointer flex items-center gap-1"
              title="Attach file"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
              attach
            </button>
            <ProjectSelector agentName={agent.name} compact />
            <button
              onClick={() => send({ type: "send", target: agent.target, text: "\x1b[A", force: true })}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-white/60 hover:bg-white/[0.06] transition-all cursor-pointer"
              title="Arrow Up"
            >
              ↑
            </button>
            <button
              onClick={() => send({ type: "send", target: agent.target, text: "\x1b[B", force: true })}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-white/60 hover:bg-white/[0.06] transition-all cursor-pointer"
              title="Arrow Down"
            >
              ↓
            </button>
            <button
              onClick={() => { if (confirm(`Restart ${agent.name}?`)) send({ type: "restart", target: agent.target }); }}
              className="px-2 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-orange-400 hover:bg-orange-400/10 border border-transparent hover:border-orange-400/20 transition-all cursor-pointer"
            >
              restart
            </button>
            {siblings.length > 1 && (
              <span className="text-[9px] text-white/20 tracking-wider">Alt+1-{Math.min(9, siblings.length)}</span>
            )}
            <button onClick={onClose} className="text-white/20 hover:text-white/50 text-lg cursor-pointer">
              &times;
            </button>
          </div>
        </div>

        {/* Mobile tab dropdown */}
        {showTabs && (
          <div className="sm:hidden flex flex-wrap gap-1.5 px-2 py-2 bg-[#0e0e18] border-b border-white/[0.06] flex-shrink-0">
            {siblings.map((s) => {
              const active = s.target === agent.target;
              return (
                <button
                  key={s.target}
                  onClick={() => { onSelectSibling(s); setShowTabs(false); }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-mono whitespace-nowrap active:scale-95 transition-all ${
                    active
                      ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                      : "bg-white/[0.04] text-white/50 border border-white/[0.06]"
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT[s.status] || "#555" }} />
                  {cleanName(s.name)}
                </button>
              );
            })}
            <button
              onClick={() => { if (confirm(`Restart ${agent.name}?`)) send({ type: "restart", target: agent.target }); }}
              className="px-3 py-2 rounded-lg text-xs font-mono text-orange-400/70 bg-orange-400/10 border border-orange-400/20 active:scale-95"
            >
              restart
            </button>
          </div>
        )}

        {/* Terminal — xterm.js via PTY WebSocket */}
        <div className="flex-1 min-h-0" style={{ overflow: "hidden", maxWidth: "100vw" }}>
          <Suspense fallback={
            <div className="flex items-center justify-center h-full text-white/30 text-sm font-mono">
              Loading terminal...
            </div>
          }>
            <XTerminal
              target={agent.target}
              onClose={onClose}
              onNavigate={onNavigate}
              siblings={siblings}
              onSelectSibling={onSelectSibling}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
