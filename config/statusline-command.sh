#!/bin/bash
# Claude Code statusline — colored bars for context, 5hr, and weekly usage

input=$(cat)
TDIR="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
echo "$input" > "$TDIR/statusline-raw.json" 2>/dev/null
_sid=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null)
[ -n "$_sid" ] && echo "$input" > "$TDIR/statusline-${_sid}.json" 2>/dev/null
_cwd=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null)
if [ -n "$_cwd" ]; then
  _cwdkey=$(echo "$_cwd" | sed 's|/|_|g')
  echo "$input" > "$TDIR/statusline-cwd-${_cwdkey}.json" 2>/dev/null
fi

# Parse context window
pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1) || pct=0
used_k=$(echo "$input" | jq -r '((.context_window.current_usage | ((.input_tokens//0)+(.cache_creation_input_tokens//0)+(.cache_read_input_tokens//0)+(.output_tokens//0))) / 1000) | floor' 2>/dev/null) || used_k=0
max_k=$(echo "$input" | jq -r '((.context_window.context_window_size // 0) / 1000) | floor' 2>/dev/null) || max_k=0

# Parse rate limits
hr5_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // 0' 2>/dev/null | cut -d. -f1) || hr5_pct=0
wk_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // 0' 2>/dev/null | cut -d. -f1) || wk_pct=0

# Duration
dur_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // 0' 2>/dev/null | cut -d. -f1) || dur_ms=0
s=$(( dur_ms / 1000 )) 2>/dev/null || s=0
h=$(( s / 3600 )); m=$(( (s % 3600) / 60 ))
[ "$h" -gt 0 ] 2>/dev/null && dur="${h}h${m}m" || dur="${m}m"

# Model + session
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "?"' 2>/dev/null) || model="?"
sid=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null | cut -c1-8)

# Git branch
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "~"' 2>/dev/null) || cwd="~"
branch=$(timeout 2 git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
git=""
if [ -n "$branch" ]; then
  d=""; timeout 1 git -C "$cwd" diff-index --quiet HEAD -- 2>/dev/null || d="*"
  git=" on  ${branch}${d}"
fi

# --- Color bar builder ---
# Usage: $(make_bar <percent> <width>)
# Green <50%, Yellow 50-80%, Red >80%
make_bar() {
  local p=$1 w=${2:-10}
  local filled=$(( (p * w + 50) / 100 ))
  [ "$filled" -gt "$w" ] && filled=$w
  local empty=$(( w - filled ))
  # Color: green(32) < 50, yellow(33) 50-80, red(31) > 80
  local c=32
  [ "$p" -ge 50 ] && c=33
  [ "$p" -ge 80 ] && c=31
  local bar=""
  local i=0
  while [ $i -lt $filled ]; do bar="${bar}█"; i=$((i+1)); done
  i=0
  while [ $i -lt $empty ]; do bar="${bar}░"; i=$((i+1)); done
  printf "\033[%sm%s\033[0m" "$c" "$bar"
}

ctx_bar=$(make_bar "$pct" 10)
hr5_bar=$(make_bar "$hr5_pct" 8)
wk_bar=$(make_bar "$wk_pct" 8)

echo "📡 ${ctx_bar} ${pct}% ${used_k}k/${max_k}k • 5h${hr5_bar}${hr5_pct}% • 7d${wk_bar}${wk_pct}% • ${dur} • ${model} • ${sid}${git}"
