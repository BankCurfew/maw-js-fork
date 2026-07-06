import { memo, useState, useEffect, type ReactNode } from "react";
import { apiUrl } from "../lib/api";
import { useDevice } from "../hooks/useDevice";

interface StatusBarProps {
  connected: boolean;
  agentCount: number;
  sessionCount: number;
  activeView?: string;
  askCount?: number;
  onInbox?: () => void;
  onJump?: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  children?: ReactNode;
}

const NAV_ITEMS = [
  { href: "#fleet", label: "Fleet", id: "fleet" },
  { href: "#office", label: "Office", id: "office" },
  { href: "#board", label: "Board", id: "board" },
  { href: "#loops", label: "Loops", id: "loops" },
  { href: "#jarvis", label: "Jarvis", id: "jarvis" },
  { href: "#heartbeats", label: "HB", id: "heartbeats" },
  { href: "#terminal", label: "Terminal", id: "terminal" },
  { href: "#chat", label: "Chat", id: "chat" },
  { href: "#voice", label: "Voice", id: "voice" },
  { href: "#federation", label: "Fed", id: "federation" },
  { href: "#config", label: "Config", id: "config" },
];

// isNarrow moved into component via useDevice hook

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

interface RateData { inputTokens: number; outputTokens: number; totalTokens: number; totalPerMin: number; inputPerMin: number; outputPerMin: number; turns: number }

function useTokenRate() {
  const [lastHourRate, setLastHourRate] = useState<RateData | null>(null);
  useEffect(() => {
    const fetch_ = () => {
      fetch(apiUrl("/api/tokens/rate?mode=window&window=3600")).then(r => r.json()).then(d => setLastHourRate(d)).catch(() => {});
    };
    fetch_();
    const iv = setInterval(fetch_, 30000);
    return () => clearInterval(iv);
  }, []);
  return { lastHourRate };
}

export const StatusBar = memo(function StatusBar({ connected, agentCount, sessionCount, activeView = "office", askCount = 0, onInbox, onJump, muted, onToggleMute, children }: StatusBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [officeTitle, setOfficeTitle] = useState("Office");
  const { isNarrow } = useDevice();
  const { lastHourRate } = useTokenRate();

  useEffect(() => {
    fetch(apiUrl("/api/config")).then(r => r.json()).then(d => {
      if (d.officeTitle) setOfficeTitle(d.officeTitle);
    }).catch(() => {});
  }, []);

  return (
    <header className="sticky top-0 z-20 mx-2 sm:mx-4 md:mx-6 mt-2 sm:mt-3 px-3 sm:px-4 md:px-6 py-2 sm:py-2.5 rounded-xl sm:rounded-2xl bg-black/50 backdrop-blur-xl border border-white/[0.06] shadow-[0_4px_30px_rgba(0,0,0,0.4)]">
      {/* Top row — always visible */}
      <div className="flex items-center gap-2 sm:gap-3">
        <h1 className="text-sm sm:text-base md:text-lg font-bold tracking-[3px] sm:tracking-[4px] md:tracking-[6px] text-cyan-400 uppercase whitespace-nowrap">
          {activeView === "fleet" ? "Fleet" : activeView === "mission" ? "Mission" : activeView === "overview" ? "Overview" : activeView === "vs" ? "VS" : activeView === "config" ? "Config" : activeView === "terminal" ? "Terminal" : activeView === "board" ? "Board" : activeView === "loops" ? "Loops" : activeView === "jarvis" ? "Jarvis" : activeView === "heartbeats" ? "Heartbeats" : activeView === "chat" ? "Chat" : activeView === "voice" ? "Voice" : activeView === "federation" ? "Federation" : officeTitle}
        </h1>

        <span className="flex items-center gap-1 text-xs sm:text-sm text-white/70">
          <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full flex-shrink-0 ${connected ? "bg-emerald-400 shadow-[0_0_6px_#4caf50]" : "bg-red-400 animate-pulse"}`} />
          <span className="hidden sm:inline">{connected ? "LIVE" : "..."}</span>
        </span>

        <span className="text-xs sm:text-sm text-white/70 whitespace-nowrap">
          <strong className="text-cyan-400">{agentCount}</strong><span className="hidden sm:inline"> agents</span>
        </span>
        <span className="hidden sm:inline text-sm text-white/70 whitespace-nowrap">
          <strong className="text-purple-400">{sessionCount}</strong> rooms
        </span>

        {lastHourRate && lastHourRate.totalTokens > 0 && (
          <span className="text-[10px] font-mono whitespace-nowrap hidden xl:flex items-center gap-1" title={`Last 60min — ${formatTokens(lastHourRate.inputTokens)} in · ${formatTokens(lastHourRate.outputTokens)} out · ${lastHourRate.turns} turns`}>
            <span className="text-amber-400/70">{formatTokens(lastHourRate.totalPerMin)}</span>
            <span className="text-white/15">tok/min</span>
          </span>
        )}

        {/* View-specific controls injected by parent */}
        <div className="hidden md:flex items-center gap-2">
          {children}
        </div>

        {/* Right side actions */}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {onToggleMute && (
            <button
              onClick={onToggleMute}
              className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs font-mono active:scale-95 transition-all flex items-center justify-center"
              style={{
                background: muted ? "rgba(239,83,80,0.15)" : "rgba(76,175,80,0.15)",
                color: muted ? "#ef5350" : "#4caf50",
                border: `1px solid ${muted ? "rgba(239,83,80,0.25)" : "rgba(76,175,80,0.25)"}`,
              }}
            >
              {muted ? "🔇" : "🔊"}
            </button>
          )}

          {onJump && !isNarrow && (
            <button
              onClick={onJump}
              className="hidden sm:inline-flex min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 px-2 sm:px-3 py-1.5 rounded-lg text-xs font-mono font-bold active:scale-95 transition-all items-center justify-center"
              style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.25)" }}
            >
              ⌘J
            </button>
          )}

          {onInbox && (
            <button onClick={onInbox} className="relative min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 px-2 sm:px-3 py-1.5 rounded-lg text-xs transition-colors text-white/50 hover:text-white/80 active:scale-95 hidden xl:flex items-center justify-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              Inbox
              {askCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold text-white bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]">
                  {askCount}
                </span>
              )}
            </button>
          )}

          {/* Logout */}
          <button
            onClick={async () => {
              if (!confirm(`Logout from ${officeTitle}?`)) return;
              await fetch("/auth/logout", { method: "POST" });
              window.location.href = "/auth/login";
            }}
            className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs font-mono active:scale-95 transition-all hidden xl:flex items-center justify-center"
            style={{ background: "rgba(239,83,80,0.08)", color: "rgba(239,83,80,0.6)", border: "1px solid rgba(239,83,80,0.15)" }}
            title="Logout"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>

          {/* Desktop nav — scrollable at xl, hidden below */}
          <nav className="hidden xl:flex items-center gap-2 text-xs ml-2 overflow-x-auto scrollbar-hide max-w-[50vw]" style={{ scrollbarWidth: "none" }}>
            {NAV_ITEMS.map((item) => (
              <a
                key={item.id}
                href={item.href}
                className={`transition-colors whitespace-nowrap px-1.5 py-0.5 rounded ${
                  activeView === item.id
                    ? "text-cyan-400 font-bold bg-cyan-500/10"
                    : "text-white/50 hover:text-white/80"
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Hamburger menu — visible below xl */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="xl:hidden min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-white/60 hover:text-white/90 active:scale-95 transition-all"
            style={{ background: menuOpen ? "rgba(34,211,238,0.15)" : "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {/* Nav dropdown (visible below xl) */}
      {menuOpen && (
        <nav className="xl:hidden flex flex-wrap gap-2 mt-2 pt-2 border-t border-white/[0.06]">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={item.href}
              onClick={() => setMenuOpen(false)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-all active:scale-95 ${
                activeView === item.id
                  ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                  : "bg-white/[0.04] text-white/60 border border-white/[0.06] hover:text-white/80"
              }`}
            >
              {item.label}
            </a>
          ))}
          {/* Show children (view controls) in mobile menu too */}
          {children && <div className="w-full flex flex-wrap gap-2 mt-1">{children}</div>}
          {/* Inbox in mobile menu */}
          {onInbox && (
            <button
              onClick={() => { setMenuOpen(false); onInbox(); }}
              className="relative px-3 py-2 rounded-lg text-sm font-medium transition-all active:scale-95 bg-white/[0.04] text-white/60 border border-white/[0.06] hover:text-white/80"
            >
              Inbox
              {askCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold text-white bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]">
                  {askCount}
                </span>
              )}
            </button>
          )}
          {/* Logout in mobile menu */}
          <button
            onClick={async () => {
              if (!confirm(`Logout from ${officeTitle}?`)) return;
              await fetch("/auth/logout", { method: "POST" });
              window.location.href = "/auth/login";
            }}
            className="px-3 py-2 rounded-lg text-sm font-medium transition-all active:scale-95 bg-red-500/10 text-red-400 border border-red-500/20"
          >
            Logout
          </button>
        </nav>
      )}
    </header>
  );
});
