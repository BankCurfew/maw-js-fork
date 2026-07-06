#!/bin/bash
# Context Guardian — PostToolUse hook
# LAW #8: Context 80% → auto /rrr + /forward
# ห้าม context ล้น — บังคับทุก oracle

# Build project dir path (Claude Code format: slashes → dashes)
CWD=$(pwd 2>/dev/null)
[ -z "$CWD" ] && exit 0
PROJECT_KEY=$(echo "$CWD" | sed 's|/|-|g')
PROJECT_DIR="$HOME/.claude/projects/$PROJECT_KEY"

# Find latest conversation JSONL (active session)
JSONL=$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -1)
[ -z "$JSONL" ] && exit 0

# Get file size in KB
SIZE_KB=$(du -k "$JSONL" 2>/dev/null | cut -f1)
[ -z "$SIZE_KB" ] && exit 0

# Count lines as secondary signal (each line ≈ 1 message/tool exchange)
LINE_COUNT=$(wc -l < "$JSONL" 2>/dev/null)

# Thresholds:
# - JSONL grows with every message. Compression happens in-context but JSONL keeps growing.
# - ~500KB or ~300 lines = getting full (80%)
# - ~700KB or ~400 lines = critical (90%+)
WARN_KB=500
WARN_LINES=300
CRIT_KB=700
CRIT_LINES=400

if [ "$SIZE_KB" -ge "$CRIT_KB" ] || [ "$LINE_COUNT" -ge "$CRIT_LINES" ]; then
  echo "" >&2
  echo "🚨🚨🚨 LAW #8 CRITICAL: Context เกือบเต็ม! (${SIZE_KB}KB, ${LINE_COUNT} msgs)" >&2
  echo "→ หยุดงานทันที! รัน /rrr แล้ว /forward เดี๋ยวนี้เลย!" >&2
  echo "→ ห้ามทำอะไรต่อ — ข้อมูลจะหายถ้า context ล้น" >&2
  echo "" >&2
elif [ "$SIZE_KB" -ge "$WARN_KB" ] || [ "$LINE_COUNT" -ge "$WARN_LINES" ]; then
  echo "" >&2
  echo "⚠️ LAW #8: Context ~80% (${SIZE_KB}KB, ${LINE_COUNT} msgs) — เตรียม /rrr + /forward เร็วๆ นี้" >&2
  echo "" >&2
fi

exit 0
