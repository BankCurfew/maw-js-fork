#!/bin/bash
# pre-close-psi-check — Stop hook
# Warns oracle if there are untracked/uncommitted ψ/ files before session ends.
# Task #1: Pre-Close Commit Hook (operator approved 2026-04-11)

INPUT=$(cat)
ORACLE=${ORACLE_NAME:-unknown}

# Find the git repo root from CWD or common oracle paths
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  exit 0  # Not in a git repo — skip
fi

# Check for untracked ψ/ files
UNTRACKED=$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- 'ψ/' 2>/dev/null | wc -l)

# Check for modified but unstaged ψ/ files
MODIFIED=$(git -C "$REPO_ROOT" diff --name-only -- 'ψ/' 2>/dev/null | wc -l)

TOTAL=$((UNTRACKED + MODIFIED))

if [ "$TOTAL" -gt 0 ]; then
  # Build warning message
  MSG="⚠️ PRE-CLOSE WARNING: ${TOTAL} uncommitted ψ/ files detected (${UNTRACKED} untracked, ${MODIFIED} modified). Commit brain files before ending session! Run: git add ψ/ && git commit -m 'docs: commit ψ/ brain files'"

  # Output as additional_context for the AI to see
  echo "$MSG"

  # Log to feed
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  echo "${TIMESTAMP} | ${ORACLE} | $(hostname) | Warning | ${ORACLE} | pre-close: ${TOTAL} uncommitted ψ/ files" >> ~/.oracle/feed.log 2>/dev/null
fi

exit 0
