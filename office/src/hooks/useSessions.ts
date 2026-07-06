import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session, AgentState, PaneStatus, AgentEvent } from "../lib/types";
import { stripAnsi } from "../lib/ansi";
import { agentSortKey } from "../lib/constants";
import { playSaiyanSound } from "../lib/sounds";
import { useFleetStore } from "../lib/store";
import { activeOracles, describeActivity, type FeedEvent, type FeedEventType } from "../lib/feed";
import type { AskType } from "../lib/types";

const BUSY_TIMEOUT = 15_000; // 15s without feed → ready
const IDLE_TIMEOUT = 60_000; // 60s without feed → idle

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [captureData, setCaptureData] = useState<Record<string, { preview: string; status: PaneStatus; contextPercent?: number }>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [eventLog, setEventLog] = useState<AgentEvent[]>([]);
  const MAX_EVENTS = 200;

  // Oracle feed state
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const feedEventsRef = useRef<FeedEvent[]>([]);
  feedEventsRef.current = feedEvents;
  const MAX_FEED = 100;

  const addEvent = useCallback((target: string, type: AgentEvent["type"], detail: string) => {
    setEventLog(prev => {
      const next = [...prev, { time: Date.now(), target, type, detail }];
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    });
  }, []);

  const markBusy = useFleetStore((s) => s.markBusy);
  const markSlept = useFleetStore((s) => s.markSlept);
  const clearSlept = useFleetStore((s) => s.clearSlept);

  const agentsRef = useRef<AgentState[]>([]);
  const lastSoundTime = useRef(0);

  // --- Feed-based status tracking ---
  // target → last feed timestamp, target → last event type
  const feedLastSeen = useRef<Record<string, number>>({});
  const feedLastEvent = useRef<Record<string, FeedEventType>>({});

  const FEED_BUSY_EVENTS = new Set<FeedEventType>(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SubagentStart", "PostToolUseFailure"]);
  const FEED_STOP_EVENTS = new Set<FeedEventType>(["Stop", "SessionEnd", "TaskCompleted", "Notification"]);

  /** Resolve feed event → agent. Uses project field for worktree-aware matching (case-insensitive). */
  const resolveAgentFromFeed = useCallback((event: FeedEvent): AgentState | undefined => {
    // project like "hermes-oracle.wt-1-bitkub" or "homelab-wt-statusline" → window name "hermes-bitkub" / "homekeeper-statusline"
    const project = event.project;
    // Match both formats: ".wt-N-name" (old) and "-wt-name" (new, no digit)
    const wtMatch = project.match(/[.-]wt-(?:\d+-)?(.+)$/);
    if (wtMatch) {
      const windowName = `${event.oracle}-${wtMatch[1]}`.toLowerCase();
      const agent = agentsRef.current.find(a => a.name.toLowerCase() === windowName);
      if (agent) return agent;
    }
    // Fallback: match by oracle name (main window)
    // Handle both formats: oracle="neo" → "neo-oracle", oracle="calliope-oracle" → "calliope-oracle"
    const oracleLower = event.oracle.toLowerCase();
    const oracleMain = oracleLower.endsWith("-oracle") ? oracleLower : `${oracleLower}-oracle`;
    return agentsRef.current.find(a => a.name.toLowerCase() === oracleMain)
      || agentsRef.current.find(a => a.name.toLowerCase() === oracleLower);
  }, []);

  const updateStatusFromFeed = useCallback((event: FeedEvent) => {
    const agent = resolveAgentFromFeed(event);
    if (!agent) return;

    const target = agent.target;

    feedLastEvent.current[target] = event.event;

    if (FEED_BUSY_EVENTS.has(event.event)) {
      feedLastSeen.current[target] = Date.now();
      setCaptureData(prev => {
        const existing = prev[target];
        if (existing?.status === "busy") return prev;
        // Play saiyan sound on transition to busy (60s cooldown)
        const now = Date.now();
        if (now - lastSoundTime.current > 60_000) {
          lastSoundTime.current = now;
          playSaiyanSound();
        }
        if (existing && existing.status !== "busy") addEvent(target, "status", `${existing.status} → busy`);
        clearSlept(target);
        return { ...prev, [target]: { preview: existing?.preview || "", status: "busy" } };
      });
    } else if (FEED_STOP_EVENTS.has(event.event)) {
      feedLastSeen.current[target] = 0; // mark stopped
      setCaptureData(prev => {
        const existing = prev[target];
        if (existing?.status === "ready") return prev;
        if (existing && existing.status !== "ready") addEvent(target, "status", `${existing.status} → ready`);
        return { ...prev, [target]: { preview: existing?.preview || "", status: "ready" } };
      });
    }
  }, [addEvent, clearSlept, resolveAgentFromFeed]);

  // Decay: busy → ready after 15s, ready → idle after 60s without feed events
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCaptureData(prev => {
        let next = prev;
        for (const agent of agentsRef.current) {
          const lastSeen = feedLastSeen.current[agent.target] || 0;
          const existing = prev[agent.target];
          if (!existing) continue;

          // Don't decay busy→ready if agent is in a tool call (PreToolUse without PostToolUse)
          const lastEvt = feedLastEvent.current[agent.target];
          const inToolCall = lastEvt === "PreToolUse" || lastEvt === "SubagentStart";
          if (existing.status === "busy" && lastSeen > 0 && now - lastSeen > BUSY_TIMEOUT && !inToolCall) {
            if (next === prev) next = { ...prev };
            next[agent.target] = { ...existing, status: "ready" };
          } else if (existing.status === "ready" && (lastSeen === 0 || now - lastSeen > IDLE_TIMEOUT)) {
            if (next === prev) next = { ...prev };
            next[agent.target] = { ...existing, status: "idle" };
          }
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // --- Ask detection from feed events ---
  const ASK_RESUME_EVENTS = new Set<FeedEventType>(["PreToolUse", "SubagentStart", "UserPromptSubmit"]);
  // Store last Stop message per oracle — Stop fires before Notification, carries the real question
  const lastStopMessage = useRef<Record<string, string>>({});

  const detectAsk = useCallback((event: FeedEvent) => {
    const { addAsk, dismissByOracle } = useFleetStore.getState();
    const agent = resolveAgentFromFeed(event);

    // Auto-dismiss: agent resumed on its own
    if (ASK_RESUME_EVENTS.has(event.event)) {
      const name = agent?.name || event.oracle;
      dismissByOracle(name);
      delete lastStopMessage.current[name];
      return;
    }

    const oracleName = agent?.name || event.oracle;

    // Capture Stop message — this has the actual question text
    if (event.event === "Stop" && event.message.trim()) {
      lastStopMessage.current[oracleName] = event.message.trim();
    }

    if (event.event === "Notification") {
      const msg = event.message.toLowerCase();
      // Skip all generic "waiting for input" notifications — they're Claude idle noise
      if (msg.includes("waiting for input") || msg.includes("waiting for your input")) return;

      let askType: AskType | null = null;
      if (msg.includes("[proposal]")) askType = "plan";
      else if (msg.includes("[handoff]")) askType = "handoff";
      else if (msg.includes("[meeting]")) askType = "meeting";
      else if (msg.includes("[report]") || msg.includes("report:")) askType = "report";
      else if (msg.includes("needs your attention") || msg.includes("attention")) askType = "attention";
      else if (msg.includes("needs your approval") || msg.includes("approval")) askType = "plan";
      if (askType) {
        // For proposal/handoff/meeting/report, use the message directly — no Stop lookup needed
        if (askType === "handoff" || askType === "meeting" || askType === "report" || msg.includes("[proposal]")) {
          const cleanMsg = event.message.replace(/ ␤ /g, "\n");
          addAsk({ oracle: oracleName, target: agent?.target || "", type: askType, message: cleanMsg });
          return;
        }
        // Find the real question: check ref first, then search feed history for last Stop from this oracle
        let stopMsg = lastStopMessage.current[oracleName];
        if (!stopMsg) {
          for (let i = feedEventsRef.current.length - 1; i >= 0; i--) {
            const fe = feedEventsRef.current[i];
            if (fe.oracle === event.oracle && fe.event === "Stop" && fe.message.trim()) {
              stopMsg = fe.message.trim();
              break;
            }
          }
        }
        const displayMessage = stopMsg && stopMsg.length > event.message.length ? stopMsg : event.message;
        addAsk({ oracle: oracleName, target: agent?.target || "", type: askType, message: displayMessage });
        delete lastStopMessage.current[oracleName];
      }
    }
  }, [resolveAgentFromFeed]);

  const handleMessage = useCallback((data: any) => {
    if (data.type === "sessions") {
      setSessions(data.sessions);
    } else if (data.type === "recent") {
      const agents: { target: string; name: string; session: string }[] = data.agents || [];
      if (agents.length > 0) markBusy(agents);
    } else if (data.type === "feed") {
      const feedEvent = data.event as FeedEvent;
      setFeedEvents(prev => {
        const next = [...prev, feedEvent];
        return next.length > MAX_FEED ? next.slice(-MAX_FEED) : next;
      });
      updateStatusFromFeed(feedEvent);
      detectAsk(feedEvent);
    } else if (data.type === "feed-history") {
      const events = (data.events as FeedEvent[]).slice(-MAX_FEED);
      setFeedEvents(events);
      // Set initial status + populate recentMap from feed events
      for (const e of events) {
        updateStatusFromFeed(e);
        if (FEED_BUSY_EVENTS.has(e.event as FeedEventType)) {
          const agent = resolveAgentFromFeed(e);
          if (agent) markBusy([{ target: agent.target, name: agent.name, session: agent.session }], e.ts);
        }
      }
    } else if (data.type === "transcript-delta") {
      // T026: dispatch as custom event for OracleSheet to consume
      window.dispatchEvent(new CustomEvent("transcript-delta", { detail: data }));
    } else if (data.type === "previews") {
      const previews: Record<string, string> = data.data;
      setCaptureData((prev) => {
        let next = prev;
        for (const [target, raw] of Object.entries(previews)) {
          const text = stripAnsi(raw);
          const lines = text.split("\n").filter((l: string) => l.trim());
          // Prefer a line showing "Compacting" (from /compact) over the default last line (prompt)
          const compactingLine = lines.find((l: string) => l.toLowerCase().includes("compacting"));
          const preview = (compactingLine || lines[lines.length - 1] || "").slice(0, 120);
          // Extract context percentage from Claude Code status line
          // Matches: "45% ctx", "ctx: 45%", "context: 45%", "45% 120k/200k", "2% until auto-compact"
          let contextPercent: number | undefined;
          for (const line of lines) {
            const m = line.match(/(\d+)%\s*ctx/i) || line.match(/ctx[:\s]+(\d+)%/i) || line.match(/context[:\s]+(\d+)%/i) || line.match(/(\d+)%\s+\d+k\/\d+k/) || line.match(/(\d+)%\s+until\s+auto[- ]compact/);
            if (m) {
              const raw = parseInt(m[1], 10);
              // "N% until auto-compact" = N% remaining, so used = 100 - N
              contextPercent = line.includes('until') ? (100 - raw) : raw;
              break;
            }
          }
          const existing = next[target];
          if (!existing || existing.preview !== preview || existing.contextPercent !== contextPercent) {
            if (next === prev) next = { ...prev };
            next[target] = { preview, status: existing?.status || "idle", contextPercent };
          }
        }
        return next;
      });
    } else if (data.type === "action-ok") {
      if (data.action === "sleep") markSlept(data.target);
      else if (data.action === "wake") clearSlept(data.target);
    } else if (data.type === "board-data") {
      const { setBoardItems, setBoardFields, setBoardLoading } = useFleetStore.getState();
      setBoardItems(data.items || []);
      setBoardFields(data.fields || []);
      setBoardLoading(false);
    } else if (data.type === "board-scan-results") {
      useFleetStore.getState().setScanResults(data.results || []);
    } else if (data.type === "board-scan-mine-results") {
      useFleetStore.getState().setScanMineResults(data.results || []);
    } else if (data.type === "board-timeline-data") {
      const { setTimelineData, setBoardLoading } = useFleetStore.getState();
      setTimelineData(data.timeline || []);
      setBoardLoading(false);
    } else if (data.type === "pulse-board-data") {
      useFleetStore.getState().setPulseBoard(data);
    } else if (data.type === "board-auto-assign-results") {
      // Results are informational; board-data will follow
    } else if (data.type === "task-log-data") {
      useFleetStore.getState().setTaskActivities(data.activities || []);
    } else if (data.type === "task-log-summaries-data") {
      useFleetStore.getState().setTaskLogSummaries(data.summaries || {});
    } else if (data.type === "task-log-new") {
      useFleetStore.getState().addTaskActivity(data.activity);
    } else if (data.type === "project-board-data") {
      useFleetStore.getState().setProjectBoard(data);
    }
  }, []);

  // Derive flat agent list
  const agents: AgentState[] = useMemo(() => {
    const list = sessions.flatMap((s) =>
      s.windows.map((w) => {
        const key = `${s.name}:${w.index}`;
        const cd = captureData[key];
        // Derive project from cwd (basename, detect worktree)
        let project: string | undefined;
        if (w.cwd) {
          const base = w.cwd.split("/").pop() || "";
          const wtMatch = base.match(/[.-]wt-(?:\d+-)?(.+)$/);
          project = wtMatch ? `wt:${wtMatch[1]}` : base;
        }
        return {
          target: key,
          name: w.name,
          session: s.name,
          windowIndex: w.index,
          active: w.active,
          preview: cd?.preview || "",
          status: cd?.status || "idle",
          project,
          contextPercent: cd?.contextPercent,
        };
      })
    );
    list.sort((a, b) => agentSortKey(a.name) - agentSortKey(b.name));
    agentsRef.current = list;
    return list;
  }, [sessions, captureData]);

  const feedActive = useMemo(() => activeOracles(feedEvents, 5 * 60_000), [feedEvents]);

  const agentFeedLog = useMemo((): Map<string, FeedEvent[]> => {
    const map = new Map<string, FeedEvent[]>();
    for (let i = feedEvents.length - 1; i >= 0; i--) {
      const e = feedEvents[i];
      const arr = map.get(e.oracle) || [];
      if (arr.length < 5) { arr.push(e); map.set(e.oracle, arr); }
    }
    return map;
  }, [feedEvents]);

  return { sessions, agents, eventLog, addEvent, handleMessage, feedEvents, feedActive, agentFeedLog };
}
