#!/bin/bash
# maw-hey-gate.sh — PreToolUse hook for MCP thread tools
# Blocks WRITE operations to threads unless caller is BoB or Pulse
# READ operations (no message field) always allowed
# Phase: WARN (exit 0 + additionalContext) — switch to exit 2 after testing
# Installed by: Dev-Oracle | Ref: Dev-Oracle#58 | Date: 2026-05-26

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

# Only gate MCP thread write tools
case "$TOOL_NAME" in
  mcp__oracle-v2__arra_thread|mcp__oracle-v2__arra_thread_update|mcp__oracle-v2__arra_handoff) ;;
  *) exit 0 ;;
esac

# Check if this is a WRITE (has message/content field) or READ
MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // ""' 2>/dev/null)
[ -z "$MESSAGE" ] && exit 0  # READ operation — always allowed

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

# Exemptions: BoB and Pulse can write directly (orchestrator + tracker roles)
case "$ORACLE_LOWER" in
  bob|pulse) exit 0 ;;
esac

# WARN phase — exit 0 with additionalContext (switch to exit 2 for BLOCK)
THREAD_ID=$(echo "$INPUT" | jq -r '.tool_input.threadId // .tool_input.thread_id // "?"' 2>/dev/null)
PREVIEW=$(echo "$MESSAGE" | head -c 60)

# Log to compliance
echo "{\"ts\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"oracle\":\"$ORACLE_LOWER\",\"tool\":\"direct_mcp\",\"thread_id\":\"$THREAD_ID\",\"preview\":\"$PREVIEW\",\"action\":\"warn\"}" >> ~/.oracle/comm-compliance.jsonl 2>/dev/null

echo "⚠️ COMM PROTOCOL: Direct MCP thread write detected (thread#${THREAD_ID}). Use \`maw hey <oracle>\` or \`/talk-to <oracle>\` instead. Direct thread posts bypass delivery + audit trail."

exit 0
