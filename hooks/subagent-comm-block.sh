#!/bin/bash
# subagent-comm-block.sh — PreToolUse hook for Agent tool
# Blocks subagents being used as messengers to other oracles
# BoB exempt (orchestrator role)
# Phase: WARN (exit 0 + additionalContext) — switch to exit 2 for BLOCK
# Installed by: Dev-Oracle | Ref: Dev-Oracle#58 | Date: 2026-05-26

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

# Only check Agent tool
[ "$TOOL_NAME" != "Agent" ] && exit 0

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

# BoB exempt — orchestrator can delegate via agents
[ "$ORACLE_LOWER" = "bob" ] && exit 0

# Extract agent prompt
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null)
[ -z "$PROMPT" ] && exit 0

# Oracle names to detect

# Action verbs that indicate messaging
VERBS="tell|send|message|notify|ask|inform|report|talk.to|maw.hey|cc|deliver|forward|relay"

# Check if prompt contains oracle name + action verb pattern
PROMPT_LOWER=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]')
if echo "$PROMPT_LOWER" | grep -qiP "(${VERBS})\s+(the\s+)?(${ORACLES})|(${ORACLES})\s+(that|to|about|saying)"; then
  MATCHED_ORACLE=$(echo "$PROMPT_LOWER" | grep -oiP "(${ORACLES})" | head -1)

  # Log to compliance
  echo "{\"ts\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"oracle\":\"$ORACLE_LOWER\",\"tool\":\"subagent_comm\",\"target\":\"$MATCHED_ORACLE\",\"preview\":\"$(echo "$PROMPT" | head -c 60)\",\"action\":\"warn\"}" >> ~/.oracle/comm-compliance.jsonl 2>/dev/null

  echo "⚠️ COMM PROTOCOL: Subagent used to communicate with ${MATCHED_ORACLE}. Use \`maw hey ${MATCHED_ORACLE}\` or \`/talk-to ${MATCHED_ORACLE}\` instead — subagents are your hands, not your messengers."

  # WARN phase — exit 0 (switch to exit 2 for BLOCK)
  exit 0
fi

exit 0
