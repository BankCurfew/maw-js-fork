#!/bin/bash
# Talk-To Enforcer — PostToolUse hook
# LAW #1 + #3: Every Oracle MUST cc bob on every inter-oracle communication.
#
# Strategy: Don't just warn — AUTO cc bob immediately from the hook.
# Oracle forgets? Doesn't matter. Hook handles it.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" != "Bash" ] && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# Get current oracle name — check multiple sources
ORACLE_NAME="${ORACLE_NAME:-${CLAUDE_AGENT_NAME:-}}"
if [ -z "$ORACLE_NAME" ]; then
  # Derive from cwd (e.g. /repos/.../Dev-Oracle → dev)
  ORACLE_NAME=$(basename "$(pwd 2>/dev/null)" 2>/dev/null)
fi
ORACLE_LOWER=$(echo "$ORACLE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/-oracle//')

# Skip if this IS Bob (Bob doesn't cc himself)
if echo "$ORACLE_LOWER" | grep -qi '^bob$'; then
  exit 0
fi

# Normalize a target name: lowercase, strip trailing "-oracle"
# Usage: TARGET_NORM=$(normalize_target "$TARGET")
normalize_target() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/-oracle$//'
}

# --- 1. Detect maw hey <non-bob, non-self> → auto cc bob ---
if echo "$CMD" | grep -qE '(^|\s)maw\s+hey\s'; then
  TARGET=$(echo "$CMD" | grep -oE 'maw hey [a-zA-Z0-9_-]+' | sed 's/maw hey //' | head -1)
  TARGET_LOWER=$(normalize_target "$TARGET")

  if [ "$TARGET_LOWER" = "bob" ]; then
    # Good — already talking to Bob. Just nudge to use /talk-to
    echo "" >&2
    echo "✅ cc BoB — ใช้ /talk-to bob แทน maw hey ได้นะ (audit trail ดีกว่า)" >&2
    echo "" >&2
  elif [ -n "$TARGET_LOWER" ] && [ "$TARGET_LOWER" = "$ORACLE_LOWER" ]; then
    # Self-cc (e.g. admin → admin) — pure noise, skip auto-cc entirely
    :
  elif [ -n "$TARGET" ]; then
    # Auto cc bob immediately — don't wait for oracle to remember
    CC_MSG="cc: ${ORACLE_LOWER} → ${TARGET} (auto-cc จาก hook)"
    "$HOME/.local/bin/maw" hey bob "$CC_MSG" >/dev/null 2>&1 &
    echo "" >&2
    echo "⚠️ cc BoB! เมื่อส่ง maw hey ให้ oracle อื่น ต้อง /talk-to bob หรือ maw hey bob แจ้งสถานะด้วยเสมอ — กฎเหล็กข้าม session" >&2
    echo "" >&2
  fi
fi

# --- 2. Detect maw talk-to <non-bob, non-self> → auto cc bob ---
if echo "$CMD" | grep -qE '(^|\s)maw\s+talk-to\s'; then
  TARGET=$(echo "$CMD" | grep -oE 'maw talk-to [a-zA-Z0-9_-]+' | sed 's/maw talk-to //' | head -1)
  TARGET_LOWER=$(normalize_target "$TARGET")

  if [ -n "$TARGET" ] && [ "$TARGET_LOWER" != "bob" ] && [ "$TARGET_LOWER" != "$ORACLE_LOWER" ]; then
    CC_MSG="cc: ${ORACLE_LOWER} → ${TARGET} (auto-cc จาก hook)"
    "$HOME/.local/bin/maw" hey bob "$CC_MSG" >/dev/null 2>&1 &
    echo "" >&2
    echo "⚠️ cc BoB! เมื่อส่ง maw hey ให้ oracle อื่น ต้อง /talk-to bob หรือ maw hey bob แจ้งสถานะด้วยเสมอ — กฎเหล็กข้าม session" >&2
    echo "" >&2
  fi
fi

# --- 3. git push → remind + auto-nudge ---
if echo "$CMD" | grep -qE '(^|\s)git\s+push(\s|$)'; then
  echo "" >&2
  echo "📬 push แล้ว — /talk-to bob \"done: [สรุป] — commits: [hash] PR: [url]\"" >&2
  echo "" >&2
fi

# --- 4. gh pr create → remind ---
if echo "$CMD" | grep -qE '(^|\s)gh\s+pr\s+create'; then
  echo "" >&2
  echo "📬 PR created — /talk-to bob \"PR: [url] — [สรุป]\"" >&2
  echo "" >&2
fi

# --- 5. git commit with completion keywords → remind ---
if echo "$CMD" | grep -qE '(^|\s)git\s+commit'; then
  if echo "$CMD" | grep -qiE '(complete|done|finish|implement|fix|resolve)'; then
    echo "" >&2
    echo "📬 เสร็จงาน — /talk-to bob \"done: [สรุป] — commit: [hash]\"" >&2
    echo "" >&2
  fi
fi

exit 0
