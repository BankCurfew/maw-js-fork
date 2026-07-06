import { useState, useEffect } from "react";
import { apiUrl } from "../../lib/api";

interface Check {
  name: string;
  status: "green" | "yellow" | "red";
  detail: string;
}

interface HealthData {
  timestamp: string;
  overall: string;
  green: number;
  red: number;
  total: number;
  checks: Check[];
}

export function HealthCheckWidget() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = () => {
    fetch(apiUrl("/api/health-check"))
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchHealth();
    const iv = setInterval(fetchHealth, 30000);
    return () => clearInterval(iv);
  }, []);

  if (loading) return <div className="text-white/30 text-sm font-mono p-4">Loading health check...</div>;
  if (!data) return <div className="text-red-400 text-sm font-mono p-4">Health check unavailable</div>;

  const statusColor = data.overall === "healthy" ? "#4caf50" : data.overall === "degraded" ? "#fdd835" : "#ef5350";

  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-bold tracking-widest uppercase" style={{ color: statusColor }}>
          System Health
        </h3>
        <span className="text-[10px] font-mono text-white/30">{data.green}/{data.total} green</span>
        <button onClick={fetchHealth} className="ml-auto text-[10px] text-white/30 hover:text-white/60 font-mono">refresh</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {data.checks.map((check, i) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: "rgba(255,255,255,0.02)" }}>
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                background: check.status === "green" ? "#4caf50" : check.status === "yellow" ? "#fdd835" : "#ef5350",
                boxShadow: check.status === "red" ? "0 0 6px #ef5350" : "none",
              }}
            />
            <span className="text-[11px] font-mono text-white/60 truncate flex-1">{check.name}</span>
            {check.status !== "green" && (
              <span className="text-[9px] font-mono text-red-400/80 truncate max-w-[120px]">{check.detail}</span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 text-[9px] text-white/20 font-mono">
        Last check: {new Date(data.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}
