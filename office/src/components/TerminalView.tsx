import { memo, useState, useEffect, useRef, useCallback } from "react";
import { ansiToHtml, linkifyHtml } from "../lib/ansi";
import { roomStyle } from "../lib/constants";
import { wsUrl } from "../lib/api";
import { useFileAttach, FileInput, AttachmentChips } from "../hooks/useFileAttach";
import { TERMINAL_COMMANDS } from "../quickCommands";
import type { Session, AgentState } from "../lib/types";
import { ProjectSelector } from "./ProjectSelector";

interface TerminalViewProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  onSelectAgent: (agent: AgentState) => void;
}

export const TerminalView = memo(function TerminalView({ sessions, agents, connected, onSelectAgent }: TerminalViewProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [captureHtml, setCaptureHtml] = useState("");
  const [inputBuf, setInputBuf] = useState("");
  const [sendQueue, setSendQueue] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const inputElRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const { uploading, attachments, inputRef: fileInputRef, pickFile, onFileChange, removeAttachment, clearAttachments, buildMessage, drag, onPaste } = useFileAttach();

  // Own WebSocket for capture stream (separate from main fleet WS)
  useEffect(() => {
    const ws = new WebSocket(wsUrl("/ws"));
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "capture") {
          const out = outputRef.current;
          const atBottom = out ? out.scrollHeight - out.scrollTop - out.clientHeight < 200 : true;
          setCaptureHtml(ansiToHtml(data.content || "(empty)"));
          if (atBottom) requestAnimationFrame(() => out?.scrollTo(0, out.scrollHeight));
        }
      } catch {}
    };

    ws.onclose = () => { wsRef.current = null; };
    ws.onerror = () => ws.close();

    return () => { ws.close(); wsRef.current = null; };
  }, []);

  // Subscribe when target changes
  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && selectedTarget) {
      ws.send(JSON.stringify({ type: "subscribe", target: selectedTarget }));
      ws.send(JSON.stringify({ type: "select", target: selectedTarget }));
    }
  }, [selectedTarget]);

  // Re-subscribe when WS reconnects
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = () => {
      if (selectedTarget) ws.send(JSON.stringify({ type: "subscribe", target: selectedTarget }));
    };
    ws.addEventListener("open", handler);
    return () => ws.removeEventListener("open", handler);
  }, [selectedTarget]);

  const selectWindow = useCallback((target: string) => {
    setSelectedTarget(target);
    setCaptureHtml("");
    setInputBuf("");
    setSendQueue([]);
    // Collapse the session list — on mobile this frees the whole screen for the
    // terminal + input; on desktop the sidebar stays visible via md:flex.
    setSidebarOpen(false);
    // Focus the real input so the mobile soft keyboard opens
    requestAnimationFrame(() => inputElRef.current?.focus());
  }, []);

  // Flush send queue
  useEffect(() => {
    if (sendingRef.current || sendQueue.length === 0) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !selectedTarget) return;

    sendingRef.current = true;
    const text = sendQueue[0];
    ws.send(JSON.stringify({ type: "send", target: selectedTarget, text }));
    requestAnimationFrame(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight));
    setTimeout(() => {
      setSendQueue(q => q.slice(1));
      sendingRef.current = false;
    }, 100);
  }, [sendQueue, selectedTarget]);

  const queueSend = useCallback((text: string) => {
    if (!text || !selectedTarget) return;
    setSendQueue(q => [...q, text]);
  }, [selectedTarget]);

  // Send raw key sequence (arrow keys, Enter, Escape, etc.)
  const sendRawKey = useCallback((seq: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !selectedTarget) return;
    ws.send(JSON.stringify({ type: "send", target: selectedTarget, text: seq, force: true }));
    requestAnimationFrame(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight));
  }, [selectedTarget]);

  // Keydown handler for the real <input> element (mobile + desktop typing).
  // onChange manages the text buffer; this only handles control keys.
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (!selectedTarget) return;
      const allWindows = sessions.flatMap(s => s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name })));
      const idx = allWindows.findIndex(w => w.target === selectedTarget);
      if (idx < 0) return;
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      selectWindow(allWindows[(idx + dir + allWindows.length) % allWindows.length].target);
      return;
    }
    if (!selectedTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputBuf || attachments.length > 0) {
        queueSend(buildMessage(inputBuf));
        setInputBuf("");
        clearAttachments();
      } else sendRawKey("\n");
    } else if (e.key === "ArrowUp" && !inputBuf) {
      e.preventDefault();
      sendRawKey("\x1b[A");
    } else if (e.key === "ArrowDown" && !inputBuf) {
      e.preventDefault();
      sendRawKey("\x1b[B");
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (inputBuf || sendQueue.length > 0) { setInputBuf(""); setSendQueue([]); }
      else sendRawKey("\x1b");
    } else if (e.key === "Tab") {
      e.preventDefault();
      queueSend(inputBuf + "\t");
      setInputBuf("");
    }
  }, [selectedTarget, inputBuf, attachments, sendQueue, queueSend, sendRawKey, selectWindow, sessions, buildMessage, clearAttachments]);

  // Get display name for selected target
  const selectedName = selectedTarget
    ? sessions.flatMap(s => s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name }))).find(w => w.target === selectedTarget)?.name || ""
    : "";

  return (
    <div className="flex flex-col md:flex-row mx-2 sm:mx-4 md:mx-6 mb-3 rounded-xl sm:rounded-2xl overflow-hidden border border-white/[0.06]" style={{ height: "calc(100dvh - 72px)" }}>
      {/* Sidebar — collapsible on mobile so terminal + input fill the screen */}
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex w-full md:w-[220px] flex-shrink-0 flex-col border-b md:border-b-0 md:border-r border-white/[0.06] max-h-[45vh] md:max-h-none overflow-y-auto`} style={{ background: "#08080e" }}>
        {[...sessions].sort((a, b) => a.name === "shell" ? -1 : b.name === "shell" ? 1 : 0).map(session => {
          const style = roomStyle(session.name);
          return (
            <div key={session.name} className="py-1">
              <div className="px-4 py-1 text-[10px] uppercase tracking-[1px]" style={{ color: style.accent + "80" }}>
                {session.name}
              </div>
              {session.windows.map(w => {
                const target = `${session.name}:${w.index}`;
                const isSelected = target === selectedTarget;
                const agent = agents.find(a => a.target === target);
                const statusColor = agent?.status === "busy" ? "#ffa726" : agent?.status === "ready" ? "#4caf50" : "#333";
                return (
                  <div
                    key={target}
                    className="flex items-center gap-2 py-1.5 cursor-pointer transition-colors"
                    style={{
                      paddingLeft: 12, paddingRight: 12,
                      background: isSelected ? `${style.accent}12` : "transparent",
                      borderLeft: isSelected ? `3px solid ${style.accent}` : "3px solid transparent",
                    }}
                    onClick={() => selectWindow(target)}
                  >
                    <span className="text-[11px] font-mono text-white/30 w-4 text-right flex-shrink-0">{w.index}</span>
                    <span className="text-[12px] font-mono truncate" style={{ color: isSelected ? style.accent : "#999" }}>
                      {w.name}
                    </span>
                    <span
                      className="w-1.5 h-1.5 rounded-full ml-auto flex-shrink-0"
                      style={{ background: statusColor, boxShadow: w.active ? `0 0 4px ${statusColor}` : undefined }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Terminal pane */}
      <div
        ref={termRef}
        className={`${sidebarOpen ? "hidden md:flex" : "flex"} flex-1 flex-col min-w-0 min-h-0 outline-none`}
        data-terminal="true"
        onPaste={onPaste}
        {...drag}
      >
        <FileInput inputRef={fileInputRef} onChange={onFileChange} />
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] flex-shrink-0" style={{ background: "#0a0a12" }}>
          {/* Mobile: back to session list */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden flex-shrink-0 text-white/40 hover:text-cyan-400 -ml-1 mr-1"
            title="Sessions"
            aria-label="Show sessions"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
          <span className="text-xs font-mono text-white/40 truncate">{selectedName || "select a window"}</span>
          {selectedTarget && <span className="text-[10px] font-mono text-white/20 hidden sm:inline">{selectedTarget}</span>}
          <span className="ml-auto flex-shrink-0 text-[10px] font-mono" style={{ color: connected ? "#4caf50" : "#ef5350" }}>
            {connected ? "live" : "reconnecting"}
          </span>
        </div>

        {/* Output */}
        <div
          ref={outputRef}
          className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-3 py-2 font-mono text-[11px] sm:text-[13px] leading-[1.35]"
          style={{ background: "#0a0a0f", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "break-word", color: "#aaa", overscrollBehavior: "contain", touchAction: "auto", userSelect: "text", WebkitUserSelect: "text" }}
        >
          {captureHtml ? (
            <div dangerouslySetInnerHTML={{ __html: linkifyHtml(captureHtml) }} />
          ) : (
            <div className="text-white/15 text-center mt-[30vh] text-sm">
              {selectedTarget ? "connecting..." : "select a window \u2190"}
            </div>
          )}
        </div>

        {/* Attachment chips */}
        {(attachments.length > 0 || uploading) && (
          <div className="px-3 py-1 border-t border-white/[0.06]" style={{ background: "#0d0d14" }}>
            <AttachmentChips attachments={attachments} onRemove={removeAttachment} uploading={uploading} />
          </div>
        )}

        {/* Input line */}
        <div
          className="flex items-center px-3 py-1.5 border-t border-white/[0.06] font-mono text-[13px] min-h-[32px]"
          style={{ background: "#0d0d14" }}
        >
          <button
            onClick={pickFile}
            className="mr-2 text-white/30 hover:text-cyan-400 transition-colors flex-shrink-0"
            title="Attach file"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {selectedTarget && <ProjectSelector agentName={selectedTarget.replace(/^\d+-/, "").replace(/:.*$/, "")} compact />}
          <span className="text-white/30 mr-2 flex-shrink-0">&gt;</span>
          <input
            ref={inputElRef}
            type="text"
            value={inputBuf}
            onChange={(e) => setInputBuf(e.target.value)}
            onKeyDown={handleInputKeyDown}
            disabled={!selectedTarget}
            placeholder={selectedTarget ? "type a message, Enter to send" : "select a window ←"}
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-white/90 font-mono text-[13px] placeholder:text-white/20"
          />
          {sendQueue.length > 0 && (
            <span className="text-white/30 text-[11px] ml-2 flex-shrink-0">({sendQueue.length} queued)</span>
          )}
          {(inputBuf || sendQueue.length > 0) && (
            <span
              className="ml-2 flex-shrink-0 text-white/30 text-[11px] cursor-pointer hover:text-red-400 px-2 rounded"
              onClick={() => { setInputBuf(""); setSendQueue([]); clearAttachments(); }}
            >
              esc
            </span>
          )}
        </div>
        {/* Control bar — quick commands */}
        {selectedTarget && (
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 border-t border-white/[0.06]"
            style={{ background: "#0a0a10", touchAction: "pan-x", overscrollBehavior: "contain" }}
          >
            {TERMINAL_COMMANDS.map(cmd => (
              <button
                key={cmd.label}
                onClick={() => { sendRawKey(cmd.text); inputElRef.current?.focus(); }}
                className="px-2.5 py-1 rounded text-[11px] font-mono cursor-pointer select-none active:scale-95 transition-transform"
                style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}
              >
                {cmd.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
