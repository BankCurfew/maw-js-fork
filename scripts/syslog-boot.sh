#!/bin/bash
# WSL Boot/Shutdown Logger — logs system events to feed.log
# Runs automatically via wireguard-route.sh boot sequence
# Ref: maw-js#62, parent: maw-js#61
#
# Usage:
#   syslog-boot.sh boot     # Log boot event (called on WSL start)
#   syslog-boot.sh shutdown  # Log shutdown event (called on WSL stop)

FEED_LOG="$HOME/.oracle/feed.log"
HOST=$(hostname)
EVENT_TYPE="${1:-boot}"

log_event() {
  local msg="$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | SYSTEM | $HOST | Event | SYSTEM | $msg" >> "$FEED_LOG"
}

case "$EVENT_TYPE" in
  boot)
    # Calculate last shutdown time and downtime
    UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
    BOOT_TIME=$(date -d "-${UPTIME_SECONDS} seconds" '+%Y-%m-%d %H:%M:%S')

    # Get previous shutdown from journalctl
    PREV_SHUTDOWN=$(journalctl --list-boots 2>/dev/null | tail -2 | head -1 | awk '{print $4, $5}')

    if [ -n "$PREV_SHUTDOWN" ]; then
      # Calculate downtime
      PREV_TS=$(date -d "$PREV_SHUTDOWN" '+%s' 2>/dev/null || echo 0)
      BOOT_TS=$(date -d "$BOOT_TIME" '+%s' 2>/dev/null || echo 0)
      if [ "$PREV_TS" -gt 0 ] && [ "$BOOT_TS" -gt "$PREV_TS" ]; then
        DOWNTIME_SEC=$((BOOT_TS - PREV_TS))
        DOWNTIME_MIN=$((DOWNTIME_SEC / 60))
        if [ "$DOWNTIME_MIN" -ge 60 ]; then
          DOWNTIME_HR=$((DOWNTIME_MIN / 60))
          DOWNTIME_REM=$((DOWNTIME_MIN % 60))
          DOWNTIME_STR="${DOWNTIME_HR}h${DOWNTIME_REM}m"
        else
          DOWNTIME_STR="${DOWNTIME_MIN}m"
        fi
        log_event "boot » WSL started — last shutdown: $(echo "$PREV_SHUTDOWN" | awk '{print $2}' | cut -d: -f1-2) (${DOWNTIME_STR} ago)"
      else
        log_event "boot » WSL started — previous shutdown time unknown"
      fi
    else
      log_event "boot » WSL started — first boot (no previous shutdown found)"
    fi

    # Log PM2 service count
    PM2_COUNT=$(pm2 jlist 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
    log_event "boot » PM2 services: $PM2_COUNT processes loaded"

    # Log boot number (how many boots in this journal)
    BOOT_COUNT=$(journalctl --list-boots 2>/dev/null | wc -l)
    log_event "boot » boot index: $BOOT_COUNT (since journal start)"
    ;;

  shutdown)
    UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
    UPTIME_HR=$((UPTIME_SECONDS / 3600))
    UPTIME_MIN=$(( (UPTIME_SECONDS % 3600) / 60 ))
    log_event "shutdown » WSL stopping — uptime: ${UPTIME_HR}h${UPTIME_MIN}m"
    ;;

  *)
    echo "Usage: syslog-boot.sh [boot|shutdown]"
    exit 1
    ;;
esac
