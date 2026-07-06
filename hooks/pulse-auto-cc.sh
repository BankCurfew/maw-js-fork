#!/bin/bash
# Pulse Auto-CC Hook — PostToolUse (Bash + MCP thread tools)
# Auto-forwards task events to Pulse Oracle via actual maw hey (not just hints)
# Events detected: maw hey (dispatch), maw task (state), gh issue (create/close),
#   gh pr (create/merge), git push, MCP thread posts
#
# This hook NOTIFIES Pulse — it does NOT block execution.
# Works for ALL oracles (global settings.json)
# macOS compatible — no grep -P (maw-js#53)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
OUTPUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // ""' 2>/dev/null)

# ─── Get oracle name ──────────────────────────────────────────────────────────
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

# Don't cc Pulse from Pulse itself (infinite loop)
[ "$ORACLE_LOWER" = "pulse" ] && exit 0

# ─── Detect events ────────────────────────────────────────────────────────────
NOTIFY=""
EVENT_TYPE=""

# ══════════════════════════════════════════════════════════════════════════════
# PATH A: Bash commands
# ══════════════════════════════════════════════════════════════════════════════
if [ "$TOOL_NAME" = "Bash" ]; then

  # Skip if command failed
  if echo "$OUTPUT" | head -1 | grep -qiE '^(error|failed|fatal|denied)'; then
    exit 0
  fi

  # Case 0a: Skip auto-sync noise (routine brain commits, not task events)
  if echo "$COMMAND" | grep -qiE '"cc:.*committed:.*auto-sync.*done"'; then
    exit 0
  fi

  # Case 0b: Commit hash dedup for cc messages (stops echo loops)
  CC_HASH=$(echo "$COMMAND" | grep -oE '[0-9a-f]{7,}' | head -1)
  if [ -n "$CC_HASH" ] && echo "$COMMAND" | grep -qiE '"cc:'; then
    CC_DEDUP="/tmp/pulse-cc-hash-${CC_HASH}.last"
    CC_NOW=$(date +%s)
    if [ -f "$CC_DEDUP" ]; then
      CC_LAST=$(cat "$CC_DEDUP" 2>/dev/null)
      [ $((CC_NOW - CC_LAST)) -lt 600 ] && exit 0  # same hash within 10min = skip
    fi
    echo "$CC_NOW" > "$CC_DEDUP"
  fi

  # Case 1: Task dispatch via maw hey / talk-to (non-cc, non-follow-up)
  if echo "$COMMAND" | grep -qE '(maw hey|/talk-to|talk-to)' \
     && ! echo "$COMMAND" | grep -qiE '(cc:|ping|test|status|peek|follow.?up|ตามงาน|confirm|check|verify|audit|เช็ค|pulse)'; then
    TARGET=$(echo "$COMMAND" | grep -oE '(maw[[:space:]]+hey|talk-to)[[:space:]]+[A-Za-z0-9_-]+' | head -1 | sed 's/.*[[:space:]]//')
    if [ -n "$TARGET" ]; then
      MSG_PREVIEW=$(echo "$COMMAND" | grep -oE '"[^"]{1,80}' | head -1 | tr -d '"')
      NOTIFY="DISPATCH: ${ORACLE_LOWER} → ${TARGET} — ${MSG_PREVIEW}"
      EVENT_TYPE="dispatch"

      # Ownership lock warning (maw-js#49): if message contains TASK: or issue ref,
      # check if the issue already has an owner on the board
      ISSUE_REF=$(echo "$MSG_PREVIEW" | grep -oE '[A-Za-z0-9_.-]+#[0-9]+' | head -1)
      if [ -n "$ISSUE_REF" ]; then
        ISSUE_NUM=$(echo "$ISSUE_REF" | grep -oE '#[0-9]+' | sed 's/#//')
        BOARD_OWNER=$("$HOME/.local/bin/maw" task ls 2>/dev/null | grep -E "^[[:space:]]+#${ISSUE_NUM}[[:space:]]" | awk '{print $4}' | head -1)
        TARGET_CLEAN=$(echo "$TARGET" | sed 's/-oracle$//')
        if [ -n "$BOARD_OWNER" ] && [ "$BOARD_OWNER" != "-" ] \
           && [ "$(echo "$BOARD_OWNER" | tr '[:upper:]' '[:lower:]')" != "$(echo "$TARGET_CLEAN" | tr '[:upper:]' '[:lower:]')" ]; then
          NOTIFY="${NOTIFY} [⚠️ OWNED BY ${BOARD_OWNER}]"
        fi
      fi
    fi
  fi

  # Case 2: maw task start/done/log
  if echo "$COMMAND" | grep -qE 'maw[[:space:]]+task[[:space:]]+(start|done|log|add)'; then
    ACTION=$(echo "$COMMAND" | grep -oE 'maw[[:space:]]+task[[:space:]]+(start|done|log|add)' | awk '{print $NF}')
    TASK_ID=$(echo "$COMMAND" | grep -oE "(#[0-9]+|'#[0-9]+')" | tr -d "'" | head -1)
    NOTIFY="TASK_${ACTION^^}: ${ORACLE_LOWER} — ${TASK_ID:-unknown} — $(echo "$COMMAND" | grep -oE '"[^"]{1,60}' | head -1 | tr -d '"')"
    EVENT_TYPE="task_${ACTION}"
  fi

  # Case 3: gh issue create + auto-add to project if repo is linked
  if echo "$COMMAND" | grep -qE 'gh[[:space:]]+issue[[:space:]]+create'; then
    REPO=$(echo "$COMMAND" | grep -oE '\-\-repo[[:space:]]+[^[:space:]]+' | sed 's/--repo[[:space:]]*//' | head -1)
    TITLE=$(echo "$COMMAND" | grep -oE '\-\-title[[:space:]]+"[^"]+' | sed 's/--title[[:space:]]*"//' | head -1)
    NOTIFY="ISSUE_CREATE: ${ORACLE_LOWER} — ${REPO:-unknown} — ${TITLE:-untitled}"
    EVENT_TYPE="issue_create"

    # Auto-add issue to linked project (maw-js#46)
    # If --repo not specified, try to detect from gh output URL or git remote
    if [ -z "$REPO" ]; then
      REPO=$(echo "$OUTPUT" | grep -oE 'github\.com/[^/]+/[^/]+' | head -1 | sed 's|github\.com/||')
      [ -z "$REPO" ] && REPO=$(git -C "$(pwd)" remote get-url origin 2>/dev/null | grep -oE 'github\.com[:/][^.]+' | sed 's|github\.com[:/]||' | head -1)
    fi
    if [ -n "$REPO" ]; then
      ISSUE_NUM=$(echo "$OUTPUT" | grep -oE '/issues/[0-9]+' | sed 's|/issues/||' | head -1)
      if [ -n "$ISSUE_NUM" ]; then
        PROJECTS_FILE="$HOME/.maw/projects.json"
        if [ -f "$PROJECTS_FILE" ]; then
          REPO_LOWER=$(echo "$REPO" | tr '[:upper:]' '[:lower:]')
          # Find project ID that has this repo linked
          PROJECT_ID=$(jq -r --arg repo "$REPO_LOWER" \
            '.projects[] | select(.repos != null) | select(.repos | map(ascii_downcase) | index($repo)) | .id' \
            "$PROJECTS_FILE" 2>/dev/null | head -1)
          if [ -n "$PROJECT_ID" ]; then
            # Reopen project if archived/completed (update status in JSON directly)
            PROJECT_STATUS=$(jq -r --arg id "$PROJECT_ID" \
              '.projects[] | select(.id == $id) | .status' \
              "$PROJECTS_FILE" 2>/dev/null)
            if [ "$PROJECT_STATUS" = "archived" ] || [ "$PROJECT_STATUS" = "completed" ]; then
              jq --arg id "$PROJECT_ID" \
                '(.projects[] | select(.id == $id) | .status) = "active" | (.projects[] | select(.id == $id) | .updatedAt) = (now | todate)' \
                "$PROJECTS_FILE" > "${PROJECTS_FILE}.tmp" 2>/dev/null && mv "${PROJECTS_FILE}.tmp" "$PROJECTS_FILE"
            fi
            # Auto-add issue to project
            "$HOME/.local/bin/maw" project add "$PROJECT_ID" "#${ISSUE_NUM}" >/dev/null 2>&1 &
            NOTIFY="${NOTIFY} [auto-linked → ${PROJECT_ID}]"
          fi
        fi
      fi
    fi
  fi

  # Case 4: gh issue close + auto-clear project focus (#52)
  if echo "$COMMAND" | grep -qE 'gh[[:space:]]+issue[[:space:]]+close'; then
    ISSUE=$(echo "$COMMAND" | grep -oE 'gh[[:space:]]+issue[[:space:]]+close[[:space:]]+[^[:space:]]+' | awk '{print $NF}' | head -1)
    REPO=$(echo "$COMMAND" | grep -oE '\-\-repo[[:space:]]+[^[:space:]]+' | sed 's/--repo[[:space:]]*//' | head -1)
    NOTIFY="ISSUE_CLOSE: ${ORACLE_LOWER} — ${REPO:-unknown}#${ISSUE}"
    EVENT_TYPE="issue_close"

    # Auto-clear project focus on issue close (#52)
    "$HOME/.local/bin/maw" project focus --clear --oracle "${ORACLE_LOWER}" >/dev/null 2>&1 &
  fi

  # Case 5: ./pulse add (someone creating ticket directly)
  if echo "$COMMAND" | grep -qE '\./pulse[[:space:]]+add'; then
    NOTIFY="PULSE_ADD: ${ORACLE_LOWER} — $(echo "$COMMAND" | grep -oE '"[^"]{1,80}' | head -1 | tr -d '"')"
    EVENT_TYPE="pulse_add"
  fi

  # Case 6: gh pr create / gh pr merge
  if echo "$COMMAND" | grep -qE 'gh[[:space:]]+pr[[:space:]]+(create|merge)'; then
    ACTION=$(echo "$COMMAND" | grep -oE 'gh[[:space:]]+pr[[:space:]]+(create|merge)' | awk '{print $NF}')
    REPO=$(echo "$COMMAND" | grep -oE '\-\-repo[[:space:]]+[^[:space:]]+' | sed 's/--repo[[:space:]]*//' | head -1)
    TITLE=$(echo "$COMMAND" | grep -oE '\-\-title[[:space:]]+"[^"]+' | sed 's/--title[[:space:]]*"//' | head -1)
    NOTIFY="PR_${ACTION^^}: ${ORACLE_LOWER} — ${REPO:-unknown} — ${TITLE:-untitled}"
    EVENT_TYPE="pr_${ACTION}"
  fi

  # Case 7: git push (with commit hash dedup — same hash within 10min = skip)
  if echo "$COMMAND" | grep -qE '(^|[;&|]|&&)[[:space:]]*git[[:space:]]+push'; then
    BRANCH=$(echo "$COMMAND" | grep -oE 'git[[:space:]]+push[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+' | awk '{print $NF}' | head -1)
    # Extract latest commit hash for dedup
    COMMIT_HASH=$(git -C "$(pwd)" rev-parse --short HEAD 2>/dev/null)
    DEDUP_FILE="/tmp/pulse-dedup-${ORACLE_LOWER}-${COMMIT_HASH:-none}.last"
    DEDUP_NOW=$(date +%s)
    if [ -n "$COMMIT_HASH" ] && [ -f "$DEDUP_FILE" ]; then
      DEDUP_LAST=$(cat "$DEDUP_FILE" 2>/dev/null)
      DEDUP_DIFF=$((DEDUP_NOW - DEDUP_LAST))
      [ "$DEDUP_DIFF" -lt 600 ] && exit 0  # 10 min dedup window
    fi
    [ -n "$COMMIT_HASH" ] && echo "$DEDUP_NOW" > "$DEDUP_FILE"
    NOTIFY="GIT_PUSH: ${ORACLE_LOWER} — ${BRANCH:-main} (${COMMIT_HASH:-unknown})"
    EVENT_TYPE="git_push"
  fi

# ══════════════════════════════════════════════════════════════════════════════
# PATH B: MCP thread tools (/talk-to via oracle-v2)
# ══════════════════════════════════════════════════════════════════════════════
elif echo "$TOOL_NAME" | grep -qE '^mcp__oracle-v2__arra_(thread_update|thread|handoff)$'; then
  THREAD_ID=$(echo "$INPUT" | jq -r '.tool_input.threadId // .tool_input.thread_id // ""' 2>/dev/null)
  MESSAGE=$(echo "$INPUT" | jq -r '.tool_input.message // .tool_input.content // ""' 2>/dev/null | head -c 100)

  if [ -n "$THREAD_ID" ]; then
    NOTIFY="THREAD_POST: ${ORACLE_LOWER} → thread#${THREAD_ID} — ${MESSAGE}"
    EVENT_TYPE="thread_post"
  fi
else
  # Not a tracked tool
  exit 0
fi

# ─── Debounce: 10s per oracle per event-type ──────────────────────────────────
if [ -n "$NOTIFY" ] && [ -n "$EVENT_TYPE" ]; then
  DEBOUNCE_FILE="/tmp/pulse-cc-${ORACLE_LOWER}-${EVENT_TYPE}.last"
  NOW=$(date +%s)
  if [ -f "$DEBOUNCE_FILE" ]; then
    LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null)
    DIFF=$((NOW - LAST))
    [ "$DIFF" -lt 10 ] && exit 0
  fi
  echo "$NOW" > "$DEBOUNCE_FILE"
fi

# ─── Send notification to Pulse ───────────────────────────────────────────────
if [ -n "$NOTIFY" ]; then
  # Write to shared pulse feed log
  echo "$(date '+%Y-%m-%d %H:%M:%S') | ${ORACLE_LOWER} | ${NOTIFY}" >> ~/.oracle/pulse-feed.log

  # Actually send maw hey to Pulse (async, non-blocking)
  "$HOME/.local/bin/maw" hey 23-pulse:0 "cc: ${NOTIFY}" >/dev/null 2>&1 &

  # Output hint for Claude context (lightweight)
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"📋 PULSE: Task event detected — cc pulse: ${NOTIFY}\"}}"
fi

# Cross-notify logic moved to auto-cross-notify.sh (dedicated hook)

exit 0
