#!/bin/bash
# comm-compliance-log.sh — PostToolUse hook for MCP thread tools
# Logs every MCP thread write to ~/.oracle/comm-compliance.jsonl
# Cross-refs with maw hey usage to determine compliance
# Installed by: Dev-Oracle | Ref: Dev-Oracle#58 | Date: 2026-05-26

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

# Only log MCP thread write tools
case "$TOOL_NAME" in
  mcp__oracle-v2__arra_thread|mcp__oracle-v2__arra_thread_update|mcp__oracle-v2__arra_handoff) ;;
  *) exit 0 ;;
esac

# Check if this is a WRITE (has message/content field)
MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // ""' 2>/dev/null)
[ -z "$MESSAGE" ] && exit 0  # READ — don't log

# Identify caller oracle
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

THREAD_ID=$(echo "$INPUT" | jq -r '.tool_input.threadId // .tool_input.thread_id // ""' 2>/dev/null)
PREVIEW=$(echo "$MESSAGE" | head -c 80 | tr '\n' ' ')
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Check compliance: was there a matching maw hey in the last 30 seconds?
# Cross-ref with maw command log
COMPLIANT="false"
NOW=$(date +%s)
if [ -f /tmp/maw-hey-${ORACLE_LOWER}.last ]; then
  LAST_MAW=$(cat /tmp/maw-hey-${ORACLE_LOWER}.last 2>/dev/null)
  DIFF=$((NOW - LAST_MAW))
  [ "$DIFF" -lt 30 ] && COMPLIANT="true"
fi

# BoB and Pulse are always compliant (exempt from maw hey requirement)
case "$ORACLE_LOWER" in
  bob|pulse) COMPLIANT="true" ;;
esac

# Append to compliance log
echo "{\"ts\":\"$TS\",\"oracle\":\"$ORACLE_LOWER\",\"tool\":\"direct_mcp\",\"thread_id\":\"$THREAD_ID\",\"preview\":\"$PREVIEW\",\"compliant\":$COMPLIANT}" >> ~/.oracle/comm-compliance.jsonl 2>/dev/null

exit 0
