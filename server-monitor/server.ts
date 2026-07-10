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

const dashboardPath = new URL("./dashboard.html", import.meta.url).pathname;

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

    // Dashboard HTML — served from file for easy iteration
    const html = await Bun.file(dashboardPath).text();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[server-monitor] listening on :${PORT}`);
