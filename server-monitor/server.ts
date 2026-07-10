/**
 * Server Monitor — standalone collector + dashboard
 * Runs as its own pm2 process on port 3459
 * Survives maw crashes (that's the point)
 */

const PORT = parseInt(process.env.MONITOR_PORT || "3459");

function run(cmd: string): string {
  try {
    const r = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe", timeout: 8000 });
    return new TextDecoder().decode(r.stdout).replace(/[\x00-\x1f\x7f]/g, "").trim();
  } catch { return ""; }
}

interface NodeConfig {
  name: string;
  collector: string;
}

const NODES: NodeConfig[] = [
  { name: "curfew", collector: "localhost" },
  // { name: "nobi", collector: "10.10.0.3" },  // uncomment when paired
];

const HEALTH_ENDPOINTS = [
  { name: "curfew", url: "https://curfew.vuttipipat.com" },
  { name: "bob", url: "https://bob.vuttipipat.com" },
  { name: "api", url: "https://api.vuttipipat.com" },
  { name: "dream", url: "https://dream.vuttipipat.com" },
];

// History ring buffers for sparklines (last 60 samples = 30min at 30s interval)
const MAX_HISTORY = 60;
const cpuHistory: number[] = [];
const memHistory: number[] = [];
const loadHistory: number[] = [];

async function collectStats() {
  const cpuInfo = run("top -bn1 | grep 'Cpu(s)' | awk '{print 100-$8}'");
  const memParts = run("free -b | awk '/Mem:/{printf \"%d %d\", $3, $2}'").split(" ");
  const diskParts = run("df -B1 / | awk 'NR==2{printf \"%d %d\", $3, $2}'").split(" ");
  const loadParts = run("cat /proc/loadavg | awk '{print $1, $2, $3}'").split(" ");
  const uptimeSec = run("awk '{print int($1)}' /proc/uptime");

  const cpu = parseFloat(cpuInfo) || 0;
  const memUsed = parseInt(memParts[0]) || 0;
  const memTotal = parseInt(memParts[1]) || 0;
  const load1 = parseFloat(loadParts[0]) || 0;

  cpuHistory.push(cpu);
  if (cpuHistory.length > MAX_HISTORY) cpuHistory.shift();
  memHistory.push(memTotal > 0 ? (memUsed / memTotal) * 100 : 0);
  if (memHistory.length > MAX_HISTORY) memHistory.shift();
  loadHistory.push(load1);
  if (loadHistory.length > MAX_HISTORY) loadHistory.shift();

  let pm2Services: any[] = [];
  try {
    const pm2Json = run("pm2 jlist 2>/dev/null");
    if (pm2Json) {
      const apps = JSON.parse(pm2Json);
      pm2Services = apps.map((a: any) => ({
        name: a.name,
        status: a.pm2_env?.status || "unknown",
        pid: a.pid || 0,
        uptime: a.pm2_env?.pm_uptime || 0,
        restarts: a.pm2_env?.restart_time || 0,
        memory: a.monit?.memory || 0,
        cpu: a.monit?.cpu || 0,
      }));
    }
  } catch {}

  let tunnelConnectors = 0;
  try {
    const out = run("cloudflared tunnel info 9c73fa50-42d0-4612-8816-8d883c3ab49f 2>&1 | grep -c 'linux_'");
    tunnelConnectors = parseInt(out) || 0;
  } catch {}

  const healthChecks = await Promise.all(HEALTH_ENDPOINTS.map(async (ep) => {
    const start = Date.now();
    try {
      const r = await fetch(ep.url, { signal: AbortSignal.timeout(5000) });
      return { name: ep.name, status: r.status, latency: Date.now() - start };
    } catch {
      return { name: ep.name, status: 0, latency: Date.now() - start };
    }
  }));

  let failoverState = "not paired yet";
  try {
    const s = run("cat $HOME/.oracle/failover-state 2>/dev/null");
    if (s) failoverState = s;
  } catch {}

  let syncLag = "not paired yet";
  try {
    const last = run("tail -1 $HOME/.oracle/failover-sync.log 2>/dev/null | head -c 19");
    if (last) syncLag = last;
  } catch {}

  return {
    node: run("hostname"),
    ts: new Date().toISOString(),
    cpu,
    memory: { used: memUsed, total: memTotal },
    disk: { used: parseInt(diskParts[0]) || 0, total: parseInt(diskParts[1]) || 0 },
    load: loadParts.map(Number),
    uptime: parseInt(uptimeSec) || 0,
    pm2: pm2Services,
    tunnel: { connectors: tunnelConnectors },
    health: healthChecks,
    failover: { state: failoverState, syncLag },
    history: { cpu: [...cpuHistory], mem: [...memHistory], load: [...loadHistory] },
  };
}

function fmtBytes(b: number): string {
  if (b >= 1e12) return (b / 1e12).toFixed(1) + " TB";
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(0) + " MB";
  return (b / 1e3).toFixed(0) + " KB";
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Server Monitor — Oracle Office</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --dim: #7d8590; --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff; --orange: #f0883e; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  h1 .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .meta { font-size: 11px; color: var(--dim); margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
  .stat { background: rgba(255,255,255,0.03); border-radius: 6px; padding: 8px; text-align: center; }
  .stat .value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .sparkline { display: flex; align-items: flex-end; gap: 1px; height: 24px; margin-top: 4px; }
  .sparkline .bar { flex: 1; min-width: 2px; background: var(--blue); border-radius: 1px 1px 0 0; opacity: 0.6; transition: height 0.3s; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10px; text-transform: uppercase; }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
  .badge.online { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.stopped, .badge.errored { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge.waiting { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .health-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
  .health-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .health-dot.up { background: var(--green); }
  .health-dot.down { background: var(--red); }
  .latency { color: var(--dim); font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .failover-card { display: flex; gap: 16px; }
  .failover-item { flex: 1; background: rgba(255,255,255,0.03); border-radius: 6px; padding: 8px 12px; }
  .failover-item .label { font-size: 10px; color: var(--dim); text-transform: uppercase; }
  .failover-item .value { font-size: 13px; margin-top: 2px; }
  .error-banner { background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px; color: var(--red); display: none; }
</style>
</head>
<body>
<h1><span class="dot" id="pulse"></span> Server Monitor</h1>
<div class="meta" id="meta">Loading...</div>
<div class="error-banner" id="error"></div>
<div class="grid" id="grid"></div>

<script>
let lastData = null;
const POLL_MS = 30000;

function fmtBytes(b) {
  if (b >= 1e12) return (b/1e12).toFixed(1)+' TB';
  if (b >= 1e9) return (b/1e9).toFixed(1)+' GB';
  if (b >= 1e6) return (b/1e6).toFixed(0)+' MB';
  return (b/1e3).toFixed(0)+' KB';
}

function fmtUptime(sec) {
  const d = Math.floor(sec/86400), h = Math.floor(sec%86400/3600), m = Math.floor(sec%3600/60);
  if (d>0) return d+'d '+h+'h';
  if (h>0) return h+'h '+m+'m';
  return m+'m';
}

function fmtPm2Uptime(pmUptime) {
  if (!pmUptime) return '-';
  return fmtUptime(Math.floor((Date.now()-pmUptime)/1000));
}

function sparkline(arr, max) {
  if (!arr || !arr.length) return '';
  const m = max || Math.max(...arr, 1);
  return '<div class="sparkline">'+arr.map(v => {
    const h = Math.max(2, (v/m)*24);
    const color = v > 80 ? 'var(--red)' : v > 60 ? 'var(--yellow)' : 'var(--blue)';
    return '<div class="bar" style="height:'+h+'px;background:'+color+'"></div>';
  }).join('')+'</div>';
}

function statusBadge(s) {
  return '<span class="badge '+s+'">'+s+'</span>';
}

function renderNode(data) {
  const cpuPct = data.cpu.toFixed(1);
  const memPct = data.memory.total > 0 ? ((data.memory.used/data.memory.total)*100).toFixed(1) : '0';
  const diskPct = data.disk.total > 0 ? ((data.disk.used/data.disk.total)*100).toFixed(1) : '0';

  let html = '<h2>'+data.node+'</h2>';

  // Stats row
  html += '<div class="stats">';
  html += '<div class="stat"><div class="value" style="color:'+(data.cpu>80?'var(--red)':data.cpu>60?'var(--yellow)':'var(--green)')+'">'+cpuPct+'%</div><div class="label">CPU</div>'+sparkline(data.history?.cpu, 100)+'</div>';
  html += '<div class="stat"><div class="value" style="color:'+(parseFloat(memPct)>85?'var(--red)':parseFloat(memPct)>70?'var(--yellow)':'var(--green)')+'">'+memPct+'%</div><div class="label">RAM '+fmtBytes(data.memory.used)+' / '+fmtBytes(data.memory.total)+'</div>'+sparkline(data.history?.mem, 100)+'</div>';
  html += '<div class="stat"><div class="value">'+diskPct+'%</div><div class="label">Disk '+fmtBytes(data.disk.used)+' / '+fmtBytes(data.disk.total)+'</div></div>';
  html += '</div>';

  // Load + uptime
  html += '<div style="display:flex;gap:16px;margin-bottom:12px;font-size:12px;color:var(--dim)">';
  html += '<span>Load: '+(data.load||[]).map(l=>l.toFixed(2)).join(' / ')+'</span>';
  html += '<span>Uptime: '+fmtUptime(data.uptime)+'</span>';
  html += '<span>Tunnel: '+data.tunnel.connectors+' connector'+(data.tunnel.connectors!==1?'s':'')+'</span>';
  html += '</div>';

  // PM2 table
  html += '<table><thead><tr><th>Service</th><th>Status</th><th>PID</th><th>Uptime</th><th>Restarts</th><th>Memory</th><th>CPU</th></tr></thead><tbody>';
  for (const svc of (data.pm2 || [])) {
    html += '<tr><td style="font-weight:500">'+svc.name+'</td><td>'+statusBadge(svc.status)+'</td><td style="color:var(--dim)">'+svc.pid+'</td><td>'+fmtPm2Uptime(svc.uptime)+'</td><td>'+(svc.restarts>0?'<span style="color:var(--yellow)">'+svc.restarts+'</span>':svc.restarts)+'</td><td>'+fmtBytes(svc.memory)+'</td><td>'+svc.cpu+'%</td></tr>';
  }
  html += '</tbody></table>';

  // Health endpoints
  html += '<div style="margin-top:12px">';
  for (const h of (data.health || [])) {
    const up = h.status >= 200 && h.status < 400;
    html += '<div class="health-row"><div class="health-dot '+(up?'up':'down')+'"></div><span>'+h.name+'</span><span class="latency">'+(up?h.status+' · '+h.latency+'ms':'DOWN')+'</span></div>';
  }
  html += '</div>';

  // Failover
  html += '<div class="failover-card" style="margin-top:12px">';
  html += '<div class="failover-item"><div class="label">Failover State</div><div class="value">'+data.failover.state+'</div></div>';
  html += '<div class="failover-item"><div class="label">Sync Lag</div><div class="value">'+data.failover.syncLag+'</div></div>';
  html += '</div>';

  return html;
}

async function poll() {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    lastData = data;

    document.getElementById('meta').textContent = 'Last updated: '+new Date(data.ts).toLocaleTimeString('en-GB',{hour12:false})+' · Refresh: 30s · Nodes: 1';
    document.getElementById('error').style.display = 'none';
    document.getElementById('pulse').style.background = 'var(--green)';

    const grid = document.getElementById('grid');
    grid.innerHTML = '<div class="card">'+renderNode(data)+'</div>';

  } catch (e) {
    document.getElementById('error').textContent = 'Failed to fetch stats: '+e.message;
    document.getElementById('error').style.display = 'block';
    document.getElementById('pulse').style.background = 'var(--red)';
  }
}

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/stats") {
      const stats = await collectStats();
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Dashboard HTML
    return new Response(dashboardHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[server-monitor] listening on :${PORT}`);
