#!/bin/bash
# Health Check — periodic system health monitoring → feed.log
# Runs every 5 minutes via maw loop
# Ref: maw-js#64, parent: maw-js#61
#
# Checks: PM2 services, disk, memory, cloudflared, WireGuard
# Only logs WARNINGS — silent when healthy (no spam)

FEED_LOG="$HOME/.oracle/feed.log"
HOST=$(hostname)
ALERTS=0

log_warning() {
  local msg="$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | SYSTEM | $HOST | Warning | SYSTEM | $msg" >> "$FEED_LOG"
  ALERTS=$((ALERTS + 1))
}

log_ok() {
  local msg="$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | SYSTEM | $HOST | Health | SYSTEM | $msg" >> "$FEED_LOG"
}

# --- PM2 SERVICES ---

# Expected services (P0 customer-facing first)
EXPECTED_SERVICES="${MAW_HEALTH_SERVICES:-maw maw-bob cloudflared}"

for svc in $EXPECTED_SERVICES; do
  status=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    procs = json.load(sys.stdin)
    match = [p for p in procs if p.get('name') == '$svc']
    if match:
        print(match[0].get('pm2_env', {}).get('status', 'unknown'))
    else:
        print('missing')
except:
    print('error')
" 2>/dev/null)

  if [ "$status" != "online" ]; then
    # Check how long it's been down
    log_warning "service-down » $svc status: $status"
  fi
done

# --- PM2 WATCH-MODE DRIFT ---
# Watch mode should always be off in production (see maw-js#67, #69)

WATCH_ON=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    watchers = [p['name'] for p in data if p.get('pm2_env',{}).get('watch')]
    if watchers: print(','.join(watchers))
except:
    pass
" 2>/dev/null)

if [ -n "$WATCH_ON" ]; then
  log_warning "watch-drift » PM2 watch mode ON for: $WATCH_ON — run 'npm run apply-config' to fix"
fi

# --- DISK SPACE ---

disk_pct=$(df / | awk 'NR==2{gsub(/%/,""); print $5}')
disk_avail=$(df -h / | awk 'NR==2{print $4}')

if [ "$disk_pct" -ge 90 ]; then
  log_warning "disk-critical » / at ${disk_pct}% — ${disk_avail} free"
elif [ "$disk_pct" -ge 80 ]; then
  log_warning "disk-warning » / at ${disk_pct}% — ${disk_avail} free"
fi

# --- MEMORY ---

mem_pct=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
mem_avail=$(free -h | awk 'NR==2{print $7}')

if [ "$mem_pct" -ge 95 ]; then
  log_warning "memory-critical » ${mem_pct}% used — ${mem_avail} available"
elif [ "$mem_pct" -ge 90 ]; then
  log_warning "memory-warning » ${mem_pct}% used — ${mem_avail} available"
fi

# --- SWAP ---

swap_total=$(free | awk 'NR==3{print $2}')
swap_used=$(free | awk 'NR==3{print $3}')
if [ "$swap_total" -gt 0 ]; then
  swap_pct=$((swap_used * 100 / swap_total))
  if [ "$swap_pct" -ge 50 ]; then
    swap_avail=$(free -h | awk 'NR==3{print $4}')
    log_warning "swap-warning » ${swap_pct}% swap used — ${swap_avail} free"
  fi
fi

# --- CLOUDFLARED TUNNEL ---

cf_pid=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    procs = json.load(sys.stdin)
    match = [p for p in procs if p.get('name') == 'cloudflared']
    if match:
        print(match[0].get('pid', 0))
    else:
        print(0)
except:
    print(0)
" 2>/dev/null)

if [ "$cf_pid" = "0" ] || [ -z "$cf_pid" ]; then
  log_warning "tunnel-down » cloudflared not running"
fi

# --- WIREGUARD ---

WG_SUBNET="${MAW_WG_SUBNET:?Set MAW_WG_SUBNET}"
wg_route=$(ip route 2>/dev/null | grep "$WG_SUBNET")
if [ -z "$wg_route" ]; then
  log_warning "wireguard-down » $WG_SUBNET route missing"
fi

# --- PM2 RESTART STORMS ---

# Check for any service with high restart count (>10)
pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    procs = json.load(sys.stdin)
    for p in procs:
        restarts = p.get('pm2_env', {}).get('restart_time', 0)
        name = p.get('name', '?')
        if restarts > 10:
            print(f'{name}:{restarts}')
except:
    pass
" 2>/dev/null | while IFS=: read -r name count; do
  log_warning "restart-storm » $name has $count restarts — possible crash loop"
done

# --- LOAD AVERAGE ---

load=$(awk '{print $1}' /proc/loadavg)
load_check=$(awk "BEGIN{print ($load >= 10.0)}")
if [ "$load_check" = "1" ]; then
  log_warning "load-high » load average: $load"
fi

# --- SUMMARY (only log when healthy every 30 min to avoid spam) ---

if [ "$ALERTS" -eq 0 ]; then
  # Only log healthy status at :00 and :30 marks (every 30 min) to reduce noise
  MINUTE=$(date '+%M')
  if [ "$MINUTE" -lt 5 ] || [ "$MINUTE" -ge 30 ] && [ "$MINUTE" -lt 35 ]; then
    log_ok "health-ok » all services online · disk: ${disk_pct}% · mem: ${mem_pct}% · load: $load"
  fi
fi
