#!/bin/bash
# Playwright Session Limiter — PreToolUse hook
# Max 2 concurrent Playwright sessions across all oracles
# If 2 sessions active → BLOCK + tell oracle to wait

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check playwright tools
echo "$TOOL" | grep -qi "playwright" || exit 0

MAX_SESSIONS=2
LOCK_DIR="/tmp/playwright-sessions"
mkdir -p "$LOCK_DIR"

# Count active sessions (lock files < 10 min old)
ACTIVE=0
NOW=$(date +%s)
for f in "$LOCK_DIR"/*.lock 2>/dev/null; do
  [ ! -f "$f" ] && continue
  AGE=$(( NOW - $(stat -c %Y "$f" 2>/dev/null || echo "$NOW") ))
  if [ "$AGE" -lt 600 ]; then
    ACTIVE=$((ACTIVE + 1))
  else
    rm -f "$f"  # Clean stale lock
  fi
done

# Check if this oracle already has a session
ORACLE_NAME="${ORACLE_NAME:-unknown}"
if [ -f "$LOCK_DIR/${ORACLE_NAME}.lock" ]; then
  # Already has a session — update timestamp and allow
  touch "$LOCK_DIR/${ORACLE_NAME}.lock"
  exit 0
fi

# Check limit
if [ "$ACTIVE" -ge "$MAX_SESSIONS" ]; then
  USERS=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | xargs -I{} basename {} .lock | tr '\n' ', ' | sed 's/,$//')
  echo "🎭 BLOCKED: Playwright session limit (max $MAX_SESSIONS) — ตอนนี้ $USERS ใช้อยู่" >&2
  echo "รอให้เขาเสร็จก่อน หรือ /talk-to oracle ที่ใช้อยู่ถามว่าเสร็จเมื่อไหร่" >&2
  exit 2
fi

# Allow — create lock
touch "$LOCK_DIR/${ORACLE_NAME}.lock"
exit 0
