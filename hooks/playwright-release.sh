#!/bin/bash
# Release Playwright session lock after tool completes
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
echo "$TOOL" | grep -qi "playwright" || exit 0

# Keep lock alive (touch) — will expire after 10 min if oracle crashes
ORACLE_NAME="${ORACLE_NAME:-unknown}"
LOCK="/tmp/playwright-sessions/${ORACLE_NAME}.lock"
[ -f "$LOCK" ] && touch "$LOCK"
exit 0
