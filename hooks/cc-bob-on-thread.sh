#!/bin/bash
# cc-bob-on-thread — PostToolUse hook for oracle-v2 MCP tools
# Auto-cc bob when oracle posts to ANY thread (except bob's own channel)
# Catches /talk-to which bypasses the Bash-only talk-to-enforcer.sh

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# Only fire on oracle-v2 thread tools
case "$TOOL" in
  mcp__oracle-v2__arra_thread_update|mcp__oracle-v2__arra_thread|mcp__oracle-v2__arra_handoff)
    ;;
  *) exit 0 ;;
esac

ORACLE_NAME="${ORACLE_NAME:-unknown}"
ORACLE_LOWER=$(echo "$ORACLE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/-oracle//')

# Skip Bob — he doesn't cc himself
echo "$ORACLE_LOWER" | grep -qi '^bob$' && exit 0

# Extract thread ID and message preview
THREAD_ID=$(echo "$INPUT" | jq -r '.tool_input.threadId // .tool_input.thread_id // empty' 2>/dev/null)
MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // empty' 2>/dev/null | head -c 80)

# Skip if already posting to bob's channel (thread 6)
[ "$THREAD_ID" = "6" ] && exit 0

# Auto-cc bob
CC_MSG="cc: ${ORACLE_LOWER} posted to thread#${THREAD_ID} (auto-cc): ${MESSAGE}"
"$HOME/.local/bin/maw" hey bob "$CC_MSG" >/dev/null 2>&1 &

# Log to feed
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "${TIMESTAMP} | ${ORACLE_NAME} | $(hostname) | PostToolUse | ${ORACLE_NAME} | auto-cc bob — thread#${THREAD_ID}" >> ~/.oracle/feed.log 2>/dev/null

exit 0
