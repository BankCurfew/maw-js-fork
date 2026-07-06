#!/bin/bash
# auto-cross-notify.sh — Automatic cross-oracle notification hook
# PostToolUse (Bash + MCP thread tools)
# Detects when oracle A's action implies oracle B should be notified
# Then fires: maw hey <oracle-B> "Cross-notify from <A>: <preview>"
# Guards: debounce 15s per target, never self/bob/pulse

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

# Never self-notify, never from pulse (infinite loop)
[ "$ORACLE_LOWER" = "pulse" ] && exit 0

# Dry-run mode for testing (DRY_RUN=1 → log only, no maw hey)
DRY_RUN="${DRY_RUN:-0}"


CROSS_TARGETS=""
EXPLICIT_TARGET=""
MSG_CONTENT=""

# ══════════════════════════════════════════════════════════════════════════════
# PATH A: Bash commands
# ══════════════════════════════════════════════════════════════════════════════
if [ "$TOOL_NAME" = "Bash" ]; then

  # Skip if command failed
  OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // ""' 2>/dev/null)
  if echo "$OUTPUT" | head -1 | grep -qiE '^(error|failed|fatal|denied)'; then
    exit 0
  fi

  # Skip internal logging commands — these are bookkeeping, not communication
  if echo "$COMMAND" | grep -qE '>>\s*(~/\.oracle/feed\.log|~/\.oracle/pulse-feed\.log|~/.oracle/maw-log|ψ/memory/logs/activity\.log|\$HOME/\.oracle/feed\.log|~/.oracle/comm-compliance)'; then
    exit 0
  fi

  # Extract the explicit target (the oracle being maw hey'd / talk-to'd directly)
  EXPLICIT_TARGET=$(echo "$COMMAND" | grep -oE '(maw[[:space:]]+hey|talk-to)[[:space:]]+[A-Za-z0-9_:-]+' | grep -oE '[A-Za-z0-9_:-]+$' | head -1 | tr '[:upper:]' '[:lower:]' | sed 's/-oracle$//' | sed 's/:[0-9]$//')

  # Extract quoted message content
  MSG_CONTENT=$(echo "$COMMAND" | grep -oE '"[^"]*"' | tr -d '"' | head -5 | tr '\n' ' ')

  # ─── Method 1: Oracle names mentioned in message content ─────────────────
  for oracle in $KNOWN_ORACLES; do
    [ "$oracle" = "$ORACLE_LOWER" ] && continue
    [ "$oracle" = "bob" ] && continue
    [ "$oracle" = "pulse" ] && continue
    [ "$oracle" = "$EXPLICIT_TARGET" ] && continue  # they already got the message
    if echo "$MSG_CONTENT" | grep -qiE "(^|[^a-z])${oracle}([^a-z]|$)"; then
      CROSS_TARGETS="$CROSS_TARGETS $oracle"
    fi
  done

  # ─── Method 2: @mentions ─────────────────────────────────────────────────
  AT_MENTIONS=$(echo "$MSG_CONTENT" | grep -oE '@[a-z]+' | tr -d '@' | sort -u)
  for mention in $AT_MENTIONS; do
    if echo "$KNOWN_ORACLES" | grep -qw "$mention" \
       && [ "$mention" != "$ORACLE_LOWER" ] \
       && [ "$mention" != "pulse" ] \
       && [ "$mention" != "bob" ] \
       && [ "$mention" != "$EXPLICIT_TARGET" ]; then
      CROSS_TARGETS="$CROSS_TARGETS $mention"
    fi
  done

  # ─── Method 3: deps.json on maw task done ────────────────────────────────
  if echo "$COMMAND" | grep -qE 'maw\s+task\s+done'; then
    if [ -f ~/.oracle/hooks/cross-notify-deps.json ]; then
      DEPS=$(jq -r ".\"${ORACLE_LOWER}\" // [] | .[]" ~/.oracle/hooks/cross-notify-deps.json 2>/dev/null)
      for dep in $DEPS; do
        [ "$dep" = "$ORACLE_LOWER" ] && continue
        [ "$dep" = "pulse" ] && continue
        [ "$dep" = "bob" ] && continue
        [ "$dep" = "$EXPLICIT_TARGET" ] && continue
        CROSS_TARGETS="$CROSS_TARGETS $dep"
      done
    fi
  fi

# ══════════════════════════════════════════════════════════════════════════════
# PATH B: MCP thread tools (/talk-to via oracle-v2)
# ══════════════════════════════════════════════════════════════════════════════
elif echo "$TOOL_NAME" | grep -qE '^mcp__oracle-v2__arra_(thread_update|thread|handoff)$'; then
  MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // ""' 2>/dev/null | head -c 500)
  MSG_CONTENT="$MESSAGE"

  # Scan thread message for oracle names
  for oracle in $KNOWN_ORACLES; do
    [ "$oracle" = "$ORACLE_LOWER" ] && continue
    [ "$oracle" = "bob" ] && continue
    [ "$oracle" = "pulse" ] && continue
    if echo "$MSG_CONTENT" | grep -qiE "(^|[^a-z])${oracle}([^a-z]|$)"; then
      CROSS_TARGETS="$CROSS_TARGETS $oracle"
    fi
  done
else
  exit 0
fi

# ─── No targets? Exit ──────────────────────────────────────────────────────
CROSS_TARGETS=$(echo "$CROSS_TARGETS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)
[ -z "$CROSS_TARGETS" ] && exit 0

# ─── Build preview ──────────────────────────────────────────────────────────
# Sanitize: strip unexpanded shell constructs — $(cmd), ${var}, backticks
PREVIEW=$(echo "$MSG_CONTENT" | sed 's/\$([^)]*)/…/g; s/\${[^}]*}/…/g; s/`[^`]*`/…/g' | head -c 300)

# ─── Dispatch with debounce ─────────────────────────────────────────────────
NOTIFIED=""
NOW=$(date +%s)

for target in $CROSS_TARGETS; do
  [ -z "$target" ] && continue

  # Debounce: 15 seconds per caller→target pair
  DEBOUNCE_FILE="/tmp/cross-notify-${ORACLE_LOWER}-${target}.last"
  if [ -f "$DEBOUNCE_FILE" ]; then
    LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null)
    DIFF=$((NOW - LAST))
    [ "$DIFF" -lt 15 ] && continue
  fi
  echo "$NOW" > "$DEBOUNCE_FILE"

  # Send maw hey (async, non-blocking) — skip in dry-run mode
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] Would maw hey ${target}-oracle" >&2
  else
    "$HOME/.local/bin/maw" hey "${target}-oracle" "Cross-notify from ${ORACLE_LOWER}: ${PREVIEW:-task update}" >/dev/null 2>&1 &
  fi

  # Log
  echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_LOWER} | CROSS_NOTIFY: ${ORACLE_LOWER} → ${target} — ${PREVIEW:-task update}" >> ~/.oracle/pulse-feed.log 2>/dev/null

  NOTIFIED="${NOTIFIED} ${target}"
done

# ─── Output hint for Claude context ─────────────────────────────────────────
NOTIFIED=$(echo "$NOTIFIED" | xargs)
if [ -n "$NOTIFIED" ]; then
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"CROSS-NOTIFY: auto-notified ${NOTIFIED}\"}}"
fi

exit 0
