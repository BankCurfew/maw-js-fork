#!/bin/bash
# Auto-Project Focus Hook — UserPromptSubmit (maw-js#47)
# When oracle receives a dispatched task with issue ref, auto-focus on the right project.
# Detects patterns like: "TASK: maw-js#44", "assigned: Dev — ref: YourOrg/LordMS#37"
#
# Non-blocking — runs focus command in background.
# macOS compatible — no grep -P (maw-js#53)

INPUT=$(cat)
USER_MSG=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)

# Only process messages that look like task dispatches
echo "$USER_MSG" | grep -qiE '(TASK:|assigned:|ref:.*#[0-9])' || exit 0

# Get oracle name
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

PROJECTS_FILE="$HOME/.maw/projects.json"
[ -f "$PROJECTS_FILE" ] || exit 0

# Extract issue reference — try multiple patterns
# Pattern 1: "Owner/Repo#N" (full form)
REPO=$(echo "$USER_MSG" | grep -oE '[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+#[0-9]+' | sed 's/#[0-9]*//' | head -1)

# Pattern 2: "repo-name#N" (short form after TASK: or ref:) — prepend YourOrg/
if [ -z "$REPO" ]; then
  SHORT_REPO=$(echo "$USER_MSG" | grep -oE '(TASK:|ref:)[[:space:]]*[A-Za-z0-9_.-]+#[0-9]+' | sed 's/^[^:]*:[[:space:]]*//' | sed 's/#[0-9]*//' | head -1)
  [ -n "$SHORT_REPO" ] && REPO="YourOrg/${SHORT_REPO}"
fi

[ -z "$REPO" ] && exit 0

# Look up project for this repo
REPO_LOWER=$(echo "$REPO" | tr '[:upper:]' '[:lower:]')
PROJECT_ID=$(jq -r --arg repo "$REPO_LOWER" \
  '.projects[] | select(.repos != null) | select(.repos | map(ascii_downcase) | index($repo)) | .id' \
  "$PROJECTS_FILE" 2>/dev/null | head -1)

[ -z "$PROJECT_ID" ] && exit 0

# Auto-focus oracle on this project (non-blocking)
"$HOME/.local/bin/maw" project focus "$PROJECT_ID" "$ORACLE_LOWER" >/dev/null 2>&1 &

exit 0
