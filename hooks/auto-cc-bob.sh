#!/bin/bash
# auto-cc-bob.sh — Universal auto-cc BoB hook
# Replaces: talk-to-enforcer.sh, check-talk-to-cc, cc-bob-on-thread.sh
#
# Fires on: PostToolUse (Bash + MCP thread tools)
# Action: Auto-sends maw hey bob with cc summary — no warnings, just does it
# Guards: skip if caller=bob, target=bob, debounce 15s

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# ─── Identify caller oracle ───────────────────────────────────────────────────
ORACLE_RAW="${ORACLE_NAME:-${CLAUDE_AGENT_NAME:-}}"
if [ -z "$ORACLE_RAW" ]; then
  CWD="$(pwd 2>/dev/null)"
  if [[ "$CWD" =~ ([^/]+)-[Oo]racle ]]; then
    ORACLE_RAW="${BASH_REMATCH[1]}"
  else
    ORACLE_RAW="$(basename "$CWD" 2>/dev/null)"
  fi
fi
ORACLE_LOWER=$(echo "$ORACLE_RAW" | tr '[:upper:]' '[:lower:]' | sed 's/-oracle$//')

# Bob never cc's himself
[ "$ORACLE_LOWER" = "bob" ] && exit 0

# ─── Debounce: 15 seconds per oracle ─────────────────────────────────────────
DEBOUNCE_FILE="/tmp/cc-bob-${ORACLE_LOWER}.last"
NOW=$(date +%s)
if [ -f "$DEBOUNCE_FILE" ]; then
  LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null)
  DIFF=$((NOW - LAST))
  [ "$DIFF" -lt 15 ] && exit 0
fi

# ─── Detect inter-oracle communication ────────────────────────────────────────
TARGET=""
PREVIEW=""

# Path A: Bash command — maw hey / talk-to
if [ "$TOOL_NAME" = "Bash" ]; then
  # Extract target from maw hey <target> (command position, not inside quotes/grep)
  TARGET=$(echo "$COMMAND" | grep -oE '(^|[;&|])[[:space:]]*('"$HOME"'/.local/bin/)?maw[[:space:]]+hey[[:space:]]+[A-Za-z0-9_-]+' | grep -oE '[A-Za-z0-9_-]+$' | head -1 | tr '[:upper:]' '[:lower:]' | sed 's/-oracle$//')

  # Skip non-oracle targets (e.g., maw hey bob, or system commands)
  if [ -z "$TARGET" ]; then
    # Check for /talk-to or talk-to in Bash
    TARGET=$(echo "$COMMAND" | grep -oE '(^|[;&|])[[:space:]]*/?talk-to[[:space:]]+[A-Za-z0-9_-]+' | grep -oE '[A-Za-z0-9_-]+$' | head -1 | tr '[:upper:]' '[:lower:]')
  fi

  # Skip cc: messages (already reporting to bob)
  echo "$COMMAND" | grep -qiE '"cc:' && exit 0

  # Skip if target is bob, self, or empty
  [ -z "$TARGET" ] && exit 0
  [ "$TARGET" = "bob" ] && exit 0
  [ "$TARGET" = "$ORACLE_LOWER" ] && exit 0

  # Skip status/ping/follow-up type messages
  echo "$COMMAND" | grep -qiE '(ping|status|peek|follow.?up|ตามงาน|confirm|check|verify|เช็ค)' && exit 0

  # Extract message preview
  PREVIEW=$(echo "$COMMAND" | grep -oE '"[^"]{1,80}' | head -1 | tr -d '"')

# Path B: MCP thread tools (/talk-to via oracle-v2)
elif echo "$TOOL_NAME" | grep -qE '^mcp__oracle-v2__arra_(thread_update|thread|handoff)$'; then
  THREAD_ID=$(echo "$INPUT" | jq -r '.tool_input.threadId // .tool_input.thread_id // ""' 2>/dev/null)
  MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // ""' 2>/dev/null | head -c 80)

  # Skip bob's own channel (thread 6)
  [ "$THREAD_ID" = "6" ] && exit 0

  TARGET="thread#${THREAD_ID}"
  PREVIEW="$MESSAGE"
else
  # Not an inter-oracle communication tool
  exit 0
fi

# ─── Auto-cc Bob ──────────────────────────────────────────────────────────────
CC_MSG="cc: ${ORACLE_LOWER} → ${TARGET} — ${PREVIEW:-task update}"
"$HOME/.local/bin/maw" hey bob "$CC_MSG" >/dev/null 2>&1 &
"$HOME/.local/bin/maw" hey 23-pulse:0 "cc: ${ORACLE_LOWER} → ${TARGET} (auto-cc จาก hook)" >/dev/null 2>&1 &

# Update debounce timestamp
echo "$NOW" > "$DEBOUNCE_FILE"

# Log to feed
echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_RAW:-$ORACLE_LOWER} | $(hostname) | PostToolUse | auto-cc-bob+pulse | ${CC_MSG}" >> ~/.oracle/feed.log 2>/dev/null

exit 0
