#!/bin/bash
# Feed Activity Hook — PostToolUse (all tools)
# Writes to feed.log on EVERY tool use so dashboard shows oracle as active
# Lightweight — only writes oracle name + tool name, no heavy processing

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

# Skip if no tool name
[ -z "$TOOL_NAME" ] && exit 0

# Get oracle name
ORACLE_RAW="${ORACLE_NAME:-${CLAUDE_AGENT_NAME:-}}"
if [ -z "$ORACLE_RAW" ]; then
  CWD="$(pwd 2>/dev/null)"
  if [[ "$CWD" =~ ([^/]+)-[Oo]racle ]]; then
    ORACLE_RAW="${BASH_REMATCH[1]}"
  fi
fi

# Format oracle name properly (e.g., "dev" → "Dev-Oracle")
ORACLE_LOWER=$(echo "$ORACLE_RAW" | tr '[:upper:]' '[:lower:]' | sed 's/-oracle$//')
case "$ORACLE_LOWER" in
  bob) ORACLE_DISPLAY="BoB-Oracle" ;;
  dev) ORACLE_DISPLAY="Dev-Oracle" ;;
  qa) ORACLE_DISPLAY="QA-Oracle" ;;
  researcher) ORACLE_DISPLAY="Researcher-Oracle" ;;
  writer) ORACLE_DISPLAY="Writer-Oracle" ;;
  designer) ORACLE_DISPLAY="Designer-Oracle" ;;
  hr) ORACLE_DISPLAY="HR-Oracle" ;;
  aia) ORACLE_DISPLAY="AIA-Oracle" ;;
  data) ORACLE_DISPLAY="Data-Oracle" ;;
  admin) ORACLE_DISPLAY="Admin-Oracle" ;;
  botdev) ORACLE_DISPLAY="BotDev-Oracle" ;;
  creator) ORACLE_DISPLAY="Creator-Oracle" ;;
  doc) ORACLE_DISPLAY="DocCon-Oracle" ;;
  editor) ORACLE_DISPLAY="Editor-Oracle" ;;
  security) ORACLE_DISPLAY="Security-Oracle" ;;
  fe) ORACLE_DISPLAY="FE-Oracle" ;;
  pa) ORACLE_DISPLAY="PA-Oracle" ;;
  fa) ORACLE_DISPLAY="FA-Oracle" ;;
  cost) ORACLE_DISPLAY="Cost-Oracle" ;;
  pulse) ORACLE_DISPLAY="Pulse-Oracle" ;;
  recruiter) ORACLE_DISPLAY="Recruiter-Oracle" ;;
  *) ORACLE_DISPLAY="${ORACLE_RAW:-unknown}-Oracle" ;;
esac

# Throttle: only write once per 30 seconds per oracle (avoid flooding)
THROTTLE_FILE="/tmp/feed-activity-${ORACLE_LOWER}.last"
NOW=$(date +%s)
if [ -f "$THROTTLE_FILE" ]; then
  LAST=$(cat "$THROTTLE_FILE" 2>/dev/null)
  DIFF=$((NOW - LAST))
  [ "$DIFF" -lt 30 ] && exit 0
fi
echo "$NOW" > "$THROTTLE_FILE"

# Tool icons
case "$TOOL_NAME" in
  Bash) ICON="⚡" ;;
  Read) ICON="📖" ;;
  Edit|Write) ICON="✏️" ;;
  Grep|Glob) ICON="🔍" ;;
  Agent) ICON="🤖" ;;
  *MCP*|*mcp*) ICON="🔌" ;;
  *) ICON="🔧" ;;
esac

echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_DISPLAY} | $(hostname) | PostToolUse | ${ORACLE_DISPLAY} | ${ICON} ${TOOL_NAME}" >> ~/.oracle/feed.log

exit 0
