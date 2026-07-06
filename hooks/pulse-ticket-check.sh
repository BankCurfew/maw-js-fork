#!/bin/bash
# Pulse Ticket Check — BLOCKS dispatch without a ticket
# PreToolUse hook for Bash commands
# exitCode 2 = block tool execution until addressed

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only check maw hey and /talk-to commands (dispatch commands)
if echo "$CMD" | grep -qE '(maw hey|/talk-to|talk-to)'; then
  # Skip if it's a ping, test, status check, cc, or non-task message
  if echo "$CMD" | grep -qiE '(ping|test|status|peek|cc:|follow.?up|ตามงาน|confirm|check|BoB test|good morning|good night|สวัสดี|ขอบคุณ|รับทราบ|audit|เช็ค|verify)'; then
    exit 0
  fi

  # Block with error message — forces Claude to create ticket first
  echo '{"error":"🚫 PULSE BLOCKED: ห้าม dispatch task โดยไม่มี pulse ticket. สร้างก่อน: ./pulse add \"task title\" --oracle <name> หรือ gh issue create แล้วค่อย dispatch. ถ้าไม่ใช่ task dispatch (แค่ถาม/remind/follow-up) เพิ่ม keyword: cc:/check/confirm/verify ใน command"}'
  exit 2
fi
