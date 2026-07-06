#!/bin/bash
# Hook: SubagentStop — log background agent completion to feed.log
# Fires when a Claude Code subagent (Agent tool) finishes
# Prevents fire-and-forget: oracle sees completion in feed + gets nudged

INPUT=$(cat)
ORACLE_NAME="${ORACLE_NAME:-$(basename "$(pwd)")}"
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // "general"' 2>/dev/null)

echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_NAME} | $(hostname) | Notification | ${ORACLE_NAME} | agent-done » Subagent (${AGENT_TYPE}) finished — check results" >> ~/.oracle/feed.log
