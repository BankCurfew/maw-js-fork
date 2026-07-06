import { useState, useEffect, useRef, useCallback } from "react";
import { agentColor } from "../lib/constants";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${((h % 360) + 360) % 360}, 50%, 45%)`;
}

interface CommMsg { idx: number; from: string; to: string; text: string; ts: string; }

export function CommsView() {
  const [msgs, setMsgs] = useState<CommMsg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const fetchPage = useCallback(async (before?: number) => {
    const params = new URLSearchParams({ limit: "60" });
    if (before !== undefined) params.set("before", String(before));
    if (filter) params.set("oracle", filter);
    const res = await fetch(`/api/comms?${params}`);
    const data = await res.json();
    return data;
  }, [filter]);

  useEffect(() => {
    fetchPage().then(data => {
      setMsgs(data.messages || []);
      setHasMore(data.hasMore ?? false);
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, [fetchPage]);

  // Poll for new messages
  useEffect(() => {
    const timer = setInterval(async () => {
      const data = await fetchPage();
      const newMsgs: CommMsg[] = data.messages || [];
      if (newMsgs.length > 0) {
        setMsgs(prev => {
          const maxIdx = prev.length > 0 ? prev[prev.length - 1].idx : -1;
          const fresh = newMsgs.filter(m => m.idx > maxIdx);
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchPage]);

  // Scroll-up to load older
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80 && hasMore && !loadingRef.current && msgs.length > 0) {
        loadingRef.current = true;
        const prevH = el.scrollHeight;
        fetchPage(msgs[0].idx).then(data => {
          const older: CommMsg[] = data.messages || [];
          if (older.length > 0) {
            setMsgs(prev => [...older, ...prev]);
            requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - prevH; });
          }
          setHasMore(data.hasMore ?? false);
          loadingRef.current = false;
        }).catch(() => { loadingRef.current = false; });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [msgs, hasMore, fetchPage]);

  function parseChips(text: string) {
    let clean = text.replace(/^\[from:[\w-]+\]\s*/, "");
    const projMatch = clean.match(/^\[([a-z0-9_-]+)\]\s*/i);
    const project = projMatch?.[1];
    if (projMatch) clean = clean.slice(projMatch[0].length);
    const tickets: { repo: string; num: string }[] = [];
    let tm;
    const re = /([A-Za-z0-9_.-]+)#(\d+)/g;
    while ((tm = re.exec(text)) !== null) tickets.push({ repo: tm[1], num: tm[2] });
    return { project, tickets, clean };
  }

  const oracles = [...new Set(msgs.flatMap(m => [m.from, m.to]))].sort();

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#0a0a0f" }}>
      {/* Filter bar */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => setFilter("")}
          style={{ padding: "3px 10px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: !filter ? "rgba(255,255,255,0.1)" : "transparent", color: "rgba(255,255,255,0.6)", fontSize: 11, cursor: "pointer" }}
        >All</button>
        {oracles.slice(0, 12).map(o => (
          <button
            key={o} onClick={() => setFilter(o)}
            style={{ padding: "3px 10px", borderRadius: 12, border: `1px solid ${agentColor(o + "-oracle")}40`, background: filter === o ? `${agentColor(o + "-oracle")}20` : "transparent", color: agentColor(o + "-oracle"), fontSize: 11, cursor: "pointer" }}
          >{o}</button>
        ))}
      </div>

      {/* Messages */}
      <div ref={containerRef} style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontFamily: "system-ui, sans-serif", fontSize: 14, lineHeight: 1.5, WebkitOverflowScrolling: "touch" as any, overscrollBehavior: "contain" }}>
        {hasMore && <div style={{ textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 11, padding: 8 }}>scroll up for older…</div>}
        {msgs.map(m => {
          const chips = parseChips(m.text);
          const fromColor = agentColor(m.from + "-oracle");
          const toColor = agentColor(m.to + "-oracle");
          return (
            <div key={m.idx} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "8px 12px", marginBottom: 6 }}>
              <div style={{ fontSize: 11, marginBottom: 3, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                <span style={{ color: fromColor, fontWeight: 600 }}>{m.from}</span>
                <span style={{ color: "rgba(255,255,255,0.2)" }}>→</span>
                <span style={{ color: toColor, fontWeight: 600 }}>{m.to}</span>
                <span style={{ color: "rgba(255,255,255,0.15)", marginLeft: 4 }}>{(() => { try { return new Date(m.ts).toLocaleTimeString("en-GB", { hour12: false }); } catch { return m.ts.slice(11, 19); } })()}</span>
                {chips.project && <span style={{ background: hashColor(chips.project), color: "white", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 600 }}>{chips.project}</span>}
                {chips.tickets.slice(0, 2).map((t, i) => (
                  <a key={i} href={`https://github.com/YourOrg/${t.repo}/issues/${t.num}`} target="_blank" rel="noopener" style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)", fontSize: 9, padding: "1px 5px", borderRadius: 8, textDecoration: "none" }}>#{t.num}</a>
                ))}
              </div>
              <div style={{ color: "rgba(255,255,255,0.7)", wordBreak: "break-word" }} dangerouslySetInnerHTML={{ __html: esc(chips.clean).replace(/\n/g, "<br>") }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
