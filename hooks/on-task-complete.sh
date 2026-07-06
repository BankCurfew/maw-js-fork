#!/bin/bash
# Hook: TaskCompleted — log background task completion to feed.log
# Fires when a Claude Code Task (TaskCreate) finishes
# Prevents fire-and-forget: oracle sees completion in feed + gets nudged

INPUT=$(cat)
ORACLE_NAME="${ORACLE_NAME:-$(basename "$(pwd)")}"
TASK_ID=$(echo "$INPUT" | jq -r '.task_id // "unknown"' 2>/dev/null)
TASK_STATUS=$(echo "$INPUT" | jq -r '.task_status // "completed"' 2>/dev/null)

echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_NAME} | $(hostname) | Notification | ${ORACLE_NAME} | task-done » Task ${TASK_ID} ${TASK_STATUS} — process results now" >> ~/.oracle/feed.log
