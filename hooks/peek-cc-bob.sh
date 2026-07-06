#!/bin/bash
# After maw peek → remind HR to /talk-to bob with summary
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if echo "$COMMAND" | grep -q "maw peek"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"⚠️ HR LAW: คุณเพิ่งรัน maw peek — ต้อง /talk-to bob สรุปสิ่งที่พบ (ใครทำอะไร, ใครว่าง, ใคร overload, ใคร stuck) ก่อนทำอะไรต่อ"}}'
fi
