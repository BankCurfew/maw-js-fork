#!/bin/bash
# Safety Guardian — PreToolUse hook for all BoB's Office oracles
# Blocks dangerous commands, suggests safe alternatives
# Installed by: operator | Version: 1.0 | Date: 2026-03-19

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Bash commands
[ "$TOOL" != "Bash" ] && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# 1. Block rm -rf
if echo "$CMD" | grep -qE '(^|\s)rm\s+.*-rf|rm\s+-rf'; then
  echo "🛡️ BLOCKED: rm -rf ไม่อนุญาต — อาจลบข้อมูลสำคัญ" >&2
  echo "Safe alternative: mv <path> /tmp/trash_\$(date +%Y%m%d_%H%M%S)_\$(basename <path>)" >&2
  echo "Recovery: ls /tmp/trash_*" >&2
  exit 2
fi

# 2. Block git push --force (but allow --force-with-lease — atomic stale-ref check)
if echo "$CMD" | grep -qE '(^|\s)git\s+push\s+.*--force|(^|\s)git\s+push\s+-f'; then
  # Allow --force-with-lease: safer variant, fails if remote has commits we don't know about
  if echo "$CMD" | grep -qE '\-\-force-with-lease'; then
    :  # safe variant, allow
  else
    echo "🛡️ BLOCKED: git push --force ไม่อนุญาต — อาจทำลาย remote history" >&2
    echo "Safe alternative: git push --force-with-lease (atomic stale-ref check) หรือ git push (no force)" >&2
    exit 2
  fi
fi

# 3. Block git reset --hard
if echo "$CMD" | grep -qE '(^|\s)git\s+reset\s+--hard'; then
  echo "🛡️ BLOCKED: git reset --hard ไม่อนุญาต — จะลบ uncommitted changes" >&2
  echo "Safe alternative: git stash หรือ git reset --soft" >&2
  exit 2
fi

# 4. Block direct push to main/master (removed — regular push is safe,
#    force push is already blocked by rule #2)

# 5. Block dropping database tables
if echo "$CMD" | grep -qiE 'DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE'; then
  echo "🛡️ BLOCKED: DROP/TRUNCATE database operation ไม่อนุญาต" >&2
  echo "ต้องได้ approval จากoperatorก่อน" >&2
  exit 2
fi

# 6. Block secrets in echo/curl (prevent leaking to logs)
if echo "$CMD" | grep -qiE '(echo|curl|wget).*\b(SUPABASE_SERVICE_KEY|SUPABASE_KEY|API_KEY|SECRET|PASSWORD|TOKEN)\b.*[a-zA-Z0-9]{20}'; then
  echo "🛡️ BLOCKED: อาจมี secret/key ใน command — ห้ามส่ง credentials ผ่าน command line" >&2
  echo "ใช้ .env file หรือ environment variable แทน" >&2
  exit 2
fi

# 7. Block kill -9 on critical processes
if echo "$CMD" | grep -qE '(^|\s)kill\s+-9\s'; then
  echo "🛡️ WARNING: kill -9 — ลองใช้ kill (SIGTERM) ก่อน" >&2
  # Allow but warn — don't block
fi

# Safe — allow
exit 0
