import { useState, useEffect, useCallback, useRef, memo } from "react";

interface ProjectSelectorProps {
  agentName: string;
  compact?: boolean;
}

interface ProjectItem { id: string; name: string; status: string; createdAt?: string; updatedAt?: string }

interface ProjectData {
  assignments: Record<string, { projectId: string; source: string; updatedAt: string }>;
  activeProjects: ProjectItem[];
}

/** Folder icon button + searchable combobox popup — mobile-friendly project selector. */
export const ProjectSelector = memo(function ProjectSelector({ agentName }: ProjectSelectorProps) {
  type SortMode = "status" | "name" | "date";
  const [data, setData] = useState<ProjectData | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem("maw-project-sort") as SortMode) || "status");
  const [sortAsc, setSortAsc] = useState<boolean>(() => localStorage.getItem("maw-project-sort-asc") !== "false");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const oracleName = agentName.replace(/-oracle$/, "").toLowerCase();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/oracle-projects")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSearch(""); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Auto-focus search on open
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  const currentProjectId = data?.assignments[oracleName]?.projectId || "";
  const projects = data?.activeProjects || [];

  const selectProject = useCallback((projectId: string) => {
    fetch("/api/oracle-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oracle: oracleName, projectId: projectId || null, source: "manual" }),
    }).catch(() => {});
    setData(prev => {
      if (!prev) return prev;
      const next = { ...prev, assignments: { ...prev.assignments } };
      if (projectId) {
        next.assignments[oracleName] = { projectId, source: "manual", updatedAt: new Date().toISOString() };
      } else {
        delete next.assignments[oracleName];
      }
      return next;
    });
    setOpen(false);
    setSearch("");
  }, [oracleName]);

  if (projects.length === 0) return null;

  const hasProject = !!currentProjectId;

  // Filter projects by search
  const q = search.toLowerCase();
  const filtered = q
    ? projects.filter(p => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    : projects;

  // Status colors for badges
  const statusColor: Record<string, string> = { active: "#22c55e", completed: "#3b82f6", archived: "#6b7280" };

  // Relative time helper
  const timeAgo = (iso?: string): string => {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
  };

  // Sort: always group by status first, then apply secondary sort within groups
  const statusOrder: Record<string, number> = { active: 0, completed: 1, archived: 2 };
  const dir = sortAsc ? 1 : -1;
  const secondarySort = (a: ProjectItem, b: ProjectItem): number => {
    if (sortMode === "name") return dir * (a.name || a.id).localeCompare(b.name || b.id);
    if (sortMode === "date") return dir * (a.updatedAt || a.createdAt || "").localeCompare(b.updatedAt || b.createdAt || "");
    return 0; // status mode — no secondary sort
  };
  const sorted = [...filtered].sort((a, b) => {
    const statusDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    return statusDiff !== 0 ? statusDiff : secondarySort(a, b);
  });

  const handleSort = (mode: SortMode) => {
    if (mode === sortMode) {
      // Toggle direction on re-click
      const next = !sortAsc;
      setSortAsc(next);
      localStorage.setItem("maw-project-sort-asc", String(next));
    } else {
      setSortMode(mode);
      // Default directions: name=asc, date=desc (newest first), status=asc
      const defaultAsc = mode !== "date";
      setSortAsc(defaultAsc);
      localStorage.setItem("maw-project-sort", mode);
      localStorage.setItem("maw-project-sort-asc", String(defaultAsc));
    }
  };
  const sortOptions: SortMode[] = ["status", "name", "date"];

  return (
    <div ref={ref} className="relative shrink-0" style={{ display: "inline-flex" }}>
      {/* Folder icon button — matches attachment button */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg active:scale-90"
        style={{ background: hasProject ? "rgba(236,72,153,0.12)" : "rgba(255,255,255,0.06)", color: hasProject ? "#ec4899" : "rgba(255,255,255,0.4)" }}
        title={hasProject ? `Focus: ${currentProjectId}` : "Set project focus"}
      >
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      </button>

      {/* Combobox popup */}
      {open && (
        <div
          className="absolute z-50 rounded-lg border border-white/10 shadow-2xl overflow-hidden"
          style={{ background: "#1a1a2e", bottom: "calc(100% + 4px)", left: -4, width: 240 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="px-2 py-2 border-b border-white/[0.06]">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setOpen(false); setSearch(""); }
                if (e.key === "Enter" && sorted.length === 1) selectProject(sorted[0].id);
              }}
              placeholder="search project..."
              className="w-full bg-white/[0.06] rounded-md px-2.5 py-1.5 text-[11px] font-mono text-white/90 outline-none placeholder:text-white/25"
              style={{ caretColor: "#ec4899" }}
              autoComplete="off"
              spellCheck={false}
            />
            {/* Sort pills */}
            <div className="flex gap-1 mt-1.5">
              {sortOptions.map(mode => {
                const active = sortMode === mode;
                const arrow = active ? (sortAsc ? "\u2191" : "\u2193") : "";
                return (
                  <button
                    key={mode}
                    className="px-2 py-0.5 rounded-full text-[9px] font-mono transition-colors"
                    style={{
                      background: active ? "rgba(236,72,153,0.2)" : "rgba(255,255,255,0.04)",
                      color: active ? "#ec4899" : "rgba(255,255,255,0.35)",
                    }}
                    onClick={() => handleSort(mode)}
                  >
                    {mode}{arrow && ` ${arrow}`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Project list */}
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {/* Clear option */}
            <button
              className="w-full text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.06]"
              style={{ color: currentProjectId ? "#94a3b8" : "#ec4899", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
              onClick={() => selectProject("")}
            >
              -- none --
            </button>

            {sorted.map((p, i) => {
              const isCurrent = p.id === currentProjectId;
              const prevStatus = i > 0 ? sorted[i - 1].status : null;
              const showDivider = prevStatus !== null && prevStatus !== p.status;

              return (
                <div key={p.id}>
                  {showDivider && (
                    <div className="border-t border-white/10 mt-1 pt-1 px-3 text-[9px] font-mono uppercase tracking-wider" style={{ color: statusColor[p.status] || "#6b7280", opacity: 0.6 }}>
                      {p.status}
                    </div>
                  )}
                  <button
                    className="w-full text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-pink-500/10 flex items-center gap-1"
                    style={{ color: isCurrent ? "#ec4899" : "#e2e8f0" }}
                    onClick={() => selectProject(p.id)}
                  >
                    {isCurrent && <span className="shrink-0">●</span>}
                    <span className="truncate">{p.name || p.id}</span>
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      {p.updatedAt && <span className="text-[9px]" style={{ color: "rgba(255,255,255,0.25)" }}>{timeAgo(p.updatedAt)}</span>}
                      <span className="text-[9px]" style={{ color: statusColor[p.status] || "#6b7280" }}>{p.status}</span>
                    </span>
                  </button>
                </div>
              );
            })}

            {sorted.length === 0 && (
              <div className="px-3 py-3 text-[11px] font-mono text-white/25 text-center">no matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
