import { memo, useEffect, useMemo } from "react";
import { agentColor } from "../lib/constants";
import { describeActivity, type FeedEvent, type FeedEventType } from "../lib/feed";

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const STATUS_DOT: Record<string, { color: string; label: string }> = {
  busy: { color: "#22c55e", label: "Working" },
  ready: { color: "#3b82f6", label: "Ready" },
  idle: { color: "#6b7280", label: "Idle" },
  done: { color: "#a855f7", label: "Done" },
};

interface AgentTaskState {
  oracle: string;
  status: "busy" | "ready" | "idle" | "done";
  events: FeedEvent[];
  lastActivity: string;
  lastTs: number;
}

function AgentTaskRow({ state }: { state: AgentTaskState }) {
  const accent = agentColor(state.oracle);
  const dot = STATUS_DOT[state.status] || STATUS_DOT.idle;

  return (
    <div className="px-4 py-3 border-b transition-all" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
      {/* Agent header */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="relative flex-shrink-0">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{ background: `${accent}20`, color: accent }}>
            {state.oracle.charAt(0).toUpperCase()}
          </div>
          <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
            style={{ background: dot.color, borderColor: "#0a0a12" }} />
        </div>
        <span className="text-[13px] font-semibold truncate" style={{ color: accent }}>
          {state.oracle}
        </span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded ml-auto flex-shrink-0"
          style={{ background: `${dot.color}15`, color: dot.color }}>
          {dot.label}
        </span>
      </div>

      {/* Activity stream */}
      <div className="ml-9 flex flex-col gap-0.5">
        {state.events.length === 0 ? (
          <span className="text-[11px] text-white/20 font-mono">No activity yet</span>
        ) : (
          state.events.slice(0, 4).map((e, i) => (
            <div key={`${e.ts}-${i}`} className="flex items-start gap-2">
              <span className="text-[10px] text-white/20 font-mono flex-shrink-0 w-6 text-right pt-px">
                {timeAgo(e.ts)}
              </span>
              <span className={`text-[11px] font-mono leading-relaxed ${i === 0 ? "text-white/70" : "text-white/30"}`}>
                {describeActivity(e)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export const TaskFeedOverlay = memo(function TaskFeedOverlay({
  feedEvents,
  agentStatuses,
  onClose,
}: {
  feedEvents: FeedEvent[];
  agentStatuses: Map<string, "busy" | "ready" | "idle">;
  onClose: () => void;
}) {
  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Build per-agent task states from feed events
  const agentStates = useMemo((): AgentTaskState[] => {
    const map = new Map<string, FeedEvent[]>();

    // Group events by oracle (most recent first)
    for (let i = feedEvents.length - 1; i >= 0; i--) {
      const e = feedEvents[i];
      const arr = map.get(e.oracle) || [];
      if (arr.length < 10) {
        arr.push(e);
        map.set(e.oracle, arr);
      }
    }

    const states: AgentTaskState[] = [];
    for (const [oracle, events] of map) {
      const lastEvent = events[0];
      const feedStatus = agentStatuses.get(oracle);

      // Determine status from feed events
      let status: AgentTaskState["status"] = feedStatus || "idle";
      if (lastEvent) {
        const isSessionEnd = lastEvent.event === "SessionEnd";
        const isStop = lastEvent.event === "Stop" && !lastEvent.message;
        if (isSessionEnd || isStop) status = "done";
      }

      states.push({
        oracle,
        status,
        events,
        lastActivity: lastEvent ? describeActivity(lastEvent) : "",
        lastTs: lastEvent?.ts || 0,
      });
    }

    // Sort: busy first, then ready, then done, then idle
    const order = { busy: 0, ready: 1, done: 2, idle: 3 };
    states.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.lastTs - a.lastTs);
    return states;
  }, [feedEvents, agentStatuses]);

  // Summary counts
  const busyCount = agentStates.filter(s => s.status === "busy").length;
  const doneCount = agentStates.filter(s => s.status === "done").length;
  const totalCount = agentStates.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-2xl border overflow-hidden"
        style={{ background: "#0a0a12", borderColor: "rgba(255,255,255,0.08)", boxShadow: "0 25px 50px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold tracking-wider text-cyan-400 uppercase">
              Task Feed
            </h2>
            <div className="flex items-center gap-2 text-[10px] font-mono">
              {busyCount > 0 && (
                <span className="px-1.5 py-0.5 rounded" style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>
                  {busyCount} working
                </span>
              )}
              {doneCount > 0 && (
                <span className="px-1.5 py-0.5 rounded" style={{ background: "rgba(168,85,247,0.12)", color: "#a855f7" }}>
                  {doneCount} done
                </span>
              )}
              <span className="text-white/20">{totalCount} agents</span>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 text-lg leading-none px-1">&times;</button>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto">
          {agentStates.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-white/30 text-sm">No feed activity</p>
              <p className="text-white/15 text-[11px] mt-1">Agents will appear here when they start working</p>
            </div>
          ) : (
            agentStates.map(state => (
              <AgentTaskRow key={state.oracle} state={state} />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t flex items-center justify-between" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <span className="text-[10px] font-mono text-white/20">
            Live from feed.log
          </span>
          <span className="text-[10px] font-mono text-white/20">
            Press <kbd className="px-1 py-0.5 rounded text-white/40" style={{ background: "rgba(255,255,255,0.06)" }}>T</kbd> to toggle
          </span>
        </div>
      </div>
    </div>
  );
});
