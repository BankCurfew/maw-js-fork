import { useEffect, useMemo, useState, useCallback } from "react";
import { apiUrl } from "../../lib/api";

/**
 * HeartbeatsWidget — ported from oracle-dashboard (commit dd76989).
 * Polls /api/brain/hud every 15s and renders live heartbeats per Rule #9.
 * Colors: green ≤5min · yellow 5–15min · red >15min.
 */

export type HeartbeatColor = "green" | "yellow" | "red";

export interface Heartbeat {
  oracle: string;
  taskId: string;
  progress: number;
  status: string;
  lastSeen: string;
  ageMinutes: number;
  color: HeartbeatColor;
}

interface HUDResponse {
  heartbeats?: Heartbeat[];
}

const DOT_COLORS: Record<HeartbeatColor, string> = {
  green: "#00ff88",
  yellow: "#ffcc33",
  red: "#ff6464",
};

function formatAge(mins: number): string {
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
  return `${Math.floor(mins / 1440)}d`;
}

function worstColor(beats: Heartbeat[]): HeartbeatColor {
  if (beats.some(b => b.color === "red")) return "red";
  if (beats.some(b => b.color === "yellow")) return "yellow";
  return "green";
}

interface HeartbeatsWidgetProps {
  /** Parent drill-down handler. */
  onTaskClick?: (taskId: string) => void;
  /** Poll interval ms (default 15000). */
  intervalMs?: number;
}

export function HeartbeatsWidget({ onTaskClick, intervalMs = 15000 }: HeartbeatsWidgetProps = {}) {
  const [data, setData] = useState<HUDResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);

  const fetchHud = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/brain/hud"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HUDResponse;
      setData(json);
      setError(null);
      setJustUpdated(true);
      setTimeout(() => setJustUpdated(false), 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHud();
    const iv = setInterval(fetchHud, intervalMs);
    return () => clearInterval(iv);
  }, [fetchHud, intervalMs]);

  const beats = data?.heartbeats ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, Heartbeat[]>();
    for (const b of beats) {
      const list = map.get(b.oracle) ?? [];
      list.push(b);
      map.set(b.oracle, list);
    }
    return [...map.entries()].sort(([, a], [, b]) => {
      const rank = { red: 0, yellow: 1, green: 2 } as const;
      const ca = rank[worstColor(a)];
      const cb = rank[worstColor(b)];
      if (ca !== cb) return ca - cb;
      const oldestA = Math.max(...a.map(x => x.ageMinutes));
      const oldestB = Math.max(...b.map(x => x.ageMinutes));
      return oldestB - oldestA;
    });
  }, [beats]);

  const counts = useMemo(() => {
    let green = 0, yellow = 0, red = 0;
    for (const b of beats) {
      if (b.color === "green") green++;
      else if (b.color === "yellow") yellow++;
      else if (b.color === "red") red++;
    }
    return { green, yellow, red };
  }, [beats]);

  const badge =
    beats.length > 0
      ? counts.red > 0
        ? `${counts.red} stale`
        : `${beats.length} live`
      : null;

  return (
    <section
      className={`rounded-xl border bg-black/50 backdrop-blur-xl p-4 transition-colors ${
        justUpdated ? "border-cyan-400/40" : "border-white/[0.06]"
      }`}
    >
      {/* Header */}
      <header className="flex items-center gap-2 mb-3">
        <span className="text-lg">💓</span>
        <h2 className="text-sm font-bold tracking-[2px] uppercase text-cyan-400">
          Heartbeats
        </h2>
        {badge && (
          <span
            className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full ${
              counts.red > 0
                ? "bg-red-500/15 text-red-400"
                : "bg-emerald-500/15 text-emerald-400"
            }`}
          >
            {badge}
          </span>
        )}
      </header>

      {loading && !data ? (
        <div className="text-center py-5 text-white/25 font-mono text-xs">
          loading…
        </div>
      ) : error ? (
        <div className="text-center py-5 text-red-400/80 font-mono text-xs">
          <div>error: {error}</div>
          <button
            onClick={fetchHud}
            className="mt-2 px-3 py-1 rounded border border-white/10 text-white/60 hover:border-cyan-400/40 hover:text-cyan-400"
          >
            retry
          </button>
        </div>
      ) : beats.length === 0 ? (
        <div className="text-center py-5 text-white/25 font-mono text-xs">
          No active heartbeats
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="flex gap-3 mb-2 text-[10px] font-mono text-white/50">
            <span className="inline-flex items-center gap-1">
              <Dot color={DOT_COLORS.green} /> {counts.green} fresh
            </span>
            <span className="inline-flex items-center gap-1">
              <Dot color={DOT_COLORS.yellow} /> {counts.yellow} stale
            </span>
            <span className="inline-flex items-center gap-1">
              <Dot color={DOT_COLORS.red} /> {counts.red} cold
            </span>
          </div>

          {grouped.map(([oracle, list]) => (
            <div key={oracle} className="mb-4 last:mb-0">
              <div className="text-[11px] font-mono font-semibold uppercase tracking-[0.8px] text-cyan-400/50 mb-2">
                {oracle}
              </div>
              {list.map(b => {
                const clickable = Boolean(onTaskClick);
                return (
                  <div
                    key={`${b.oracle}:${b.taskId}`}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={() => clickable && onTaskClick?.(b.taskId)}
                    onKeyDown={e => {
                      if (!clickable) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onTaskClick?.(b.taskId);
                      }
                    }}
                    className={`flex items-center gap-2 py-1.5 border-b border-cyan-400/5 text-xs font-mono ${
                      clickable ? "cursor-pointer hover:bg-white/[0.02]" : ""
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{
                        background: DOT_COLORS[b.color],
                        boxShadow:
                          b.color === "green"
                            ? `0 0 6px ${DOT_COLORS.green}`
                            : "none",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-white/80 overflow-hidden whitespace-nowrap text-ellipsis">
                        <span className="text-cyan-400/70">#{b.taskId}</span>
                        <span className="ml-1.5">{b.status}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                        <ProgressBar pct={b.progress} color={DOT_COLORS[b.color]} />
                        <span className="flex-shrink-0 w-9 text-right">
                          {b.progress < 0 ? "—" : `${Math.round(b.progress)}%`}
                        </span>
                        <span className="flex-shrink-0">
                          · {formatAge(b.ageMinutes)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full align-middle"
      style={{ background: color }}
    />
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  const clamped = pct < 0 ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <span className="flex-1 h-[3px] bg-white/5 rounded-sm overflow-hidden">
      <span
        className="block h-full transition-[width] duration-300"
        style={{ width: `${clamped}%`, background: color }}
      />
    </span>
  );
}
