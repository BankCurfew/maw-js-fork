import { memo, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { roomStyle } from "../lib/constants";
import type { AgentState } from "../lib/types";

/** Extract leading number from session name: "08-neo" → 8, "0" → 0 */
function sessionNum(name: string): number {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

interface JumpOverlayProps {
  agents: AgentState[];
  onSelect: (agent: AgentState) => void;
  onClose: () => void;
}

export const JumpOverlay = memo(function JumpOverlay({
  agents,
  onSelect,
  onClose,
}: JumpOverlayProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Filter agents by query (fuzzy: match session number, name, target)
  const filtered = useMemo(() => {
    if (!query.trim()) return agents;
    const q = query.toLowerCase().trim();
    // Special: "8 1" or "8.1" → session prefix 8, window index 1
    const numMatch = q.match(/^(\d+)\s*[.\s]\s*(\d+)$/);
    if (numMatch) {
      const sNum = parseInt(numMatch[1], 10);
      const wIdx = parseInt(numMatch[2], 10);
      return agents.filter(a => {
        const sn = sessionNum(a.session);
        return sn === sNum && a.windowIndex === wIdx;
      });
    }
    // Single number → match session prefix
    if (/^\d+$/.test(q)) {
      const num = parseInt(q, 10);
      const exact = agents.filter(a => sessionNum(a.session) === num);
      if (exact.length > 0) return exact;
    }
    // Text match on name, session, target
    return agents.filter(a => {
      const haystack = `${a.name} ${a.session} ${a.target}`.toLowerCase();
      return q.split(/\s+/).every(word => haystack.includes(word));
    });
  }, [agents, query]);

  // Clamp selected index
  useEffect(() => { setSelectedIdx(0); }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered.length > 0) {
        onSelect(filtered[selectedIdx]);
        onClose();
      }
      return;
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(2,2,8,0.85)", backdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-full max-w-[560px] rounded-xl border border-cyan-400/15 shadow-2xl overflow-hidden"
        style={{ background: "#0a0a0f", maxHeight: "70vh" }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <span className="text-cyan-400 text-lg">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-white/90 outline-none caret-cyan-400 font-mono text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
            style={{ WebkitAppearance: "none" }}
            placeholder="Jump to agent... (8 1 = session 08 window 1)"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <span className="text-[9px] text-white/20 font-mono">{filtered.length}/{agents.length}</span>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-white/30 text-sm font-mono">
              No match
            </div>
          )}
          {filtered.map((agent, i) => {
            const style = roomStyle(agent.session);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            const statusColor = agent.status === "busy" ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#555";
            const isSelected = i === selectedIdx;
            return (
              <div
                key={agent.target}
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors"
                style={{
                  background: isSelected ? `${style.accent}15` : "transparent",
                  borderLeft: isSelected ? `3px solid ${style.accent}` : "3px solid transparent",
                }}
                onClick={() => { onSelect(agent); onClose(); }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <kbd
                  className="w-7 h-7 flex items-center justify-center rounded text-[10px] font-bold font-mono flex-shrink-0"
                  style={{ background: `${style.accent}20`, color: style.accent, border: `1px solid ${style.accent}30` }}
                >
                  {sessionNum(agent.session) >= 0 ? sessionNum(agent.session) : "·"}
                </kbd>
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: statusColor, boxShadow: agent.status !== "idle" ? `0 0 4px ${statusColor}` : undefined }}
                />
                <span className="text-sm font-mono font-semibold" style={{ color: isSelected ? style.accent : "#cdd6f4" }}>
                  {displayName}
                </span>
                <span className="text-[10px] font-mono text-white/25 ml-auto">
                  {agent.session}:{agent.windowIndex}
                </span>
                <span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{
                    background: agent.status === "busy" ? "#ffa72618" : agent.status === "ready" ? "#22C55E14" : "rgba(255,255,255,0.04)",
                    color: statusColor,
                  }}
                >
                  {agent.status}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer hints */}
        <div className="flex items-center justify-between px-4 py-1.5 bg-[#08080c] border-t border-white/[0.04] text-[8px] font-mono text-white/20">
          <span><kbd className="text-white/30">↑↓</kbd> navigate · <kbd className="text-white/30">Enter</kbd> open · <kbd className="text-white/30">Esc</kbd> close</span>
          <span><kbd className="text-white/30">J</kbd> or <kbd className="text-white/30">Ctrl+K</kbd> to jump</span>
        </div>
      </div>
    </div>
  );
});
