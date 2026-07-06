#!/bin/bash
# backup-fleet.sh — Capture fleet state before migration
# Usage: ./backup-fleet.sh [output-dir]
# Creates a timestamped backup of all fleet config, hooks, state
# ref: [oracle-infra] #137

set -euo pipefail

OUT="${1:-$HOME/fleet-backup-$(date +%Y%m%d-%H%M)}"
mkdir -p "$OUT"

echo "=== Fleet Backup → $OUT ==="
echo ""

cp_if() { [ -f "$1" ] && cp "$1" "$OUT/$2" && echo "  ✅ $2" || echo "  ⚠️  $2 (not found)"; }
cp_dir() { [ -d "$1" ] && cp -r "$1" "$OUT/$2" && echo "  ✅ $2/" || echo "  ⚠️  $2/ (not found)"; }

echo "--- 1. Maw config ---"
MAW="$HOME/repos/github.com/YourOrg/maw-js"
cp_if "$MAW/maw.config.json" "maw.config.json"
cp_if "$MAW/rooms.json" "rooms.json"
cp_if "$MAW/loops.json" "loops.json"
cp_if "$MAW/loops-log.json" "loops-log.json"
cp_if "$MAW/ecosystem.config.cjs" "ecosystem.config.cjs"
cp_if "$MAW/tmux.conf" "tmux.conf"

echo ""
echo "--- 1.5. Maw state (~/.maw/) ---"
mkdir -p "$OUT/maw-state"
cp_if "$HOME/.maw/oracle-projects.json" "maw-state/oracle-projects.json"
cp_if "$HOME/.maw/projects.json" "maw-state/projects.json"
cp_dir "$HOME/.maw/task-logs" "maw-state/task-logs"
cp_dir "$HOME/.maw/loop-queue" "maw-state/loop-queue"
cp_dir "$HOME/.maw/projects" "maw-state/projects"
cp_dir "$HOME/.maw/inbox" "maw-state/inbox"
cp_dir "$MAW/fleet" "fleet"

echo ""
echo "--- 2. Oracle infrastructure ---"
cp_dir "$HOME/.oracle/hooks" "oracle-hooks"
cp_dir "$HOME/.oracle/docs" "oracle-docs"
cp_dir "$HOME/.oracle/tools" "oracle-tools"
cp_dir "$HOME/.oracle/directory" "oracle-directory"
cp_if "$HOME/.oracle/feed-hook.py" "feed-hook.py"
cp_if "$HOME/.oracle/SYSTEM_PLAYBOOK.md" "SYSTEM_PLAYBOOK.md"
cp_if "$HOME/.oracle/cost-optimization.md" "cost-optimization.md"

echo ""
echo "--- 3. Boot scripts ---"
cp_if "$HOME/boot.sh" "boot.sh"
cp_if "$HOME/test-boot.sh" "test-boot.sh"

echo ""
echo "--- 4. Cloudflare ---"
mkdir -p "$OUT/cloudflared"
cp_if "$HOME/.cloudflared/config.yml" "cloudflared/config.yml"
for f in "$HOME/.cloudflared/"*.json; do
  [ -f "$f" ] && cp "$f" "$OUT/cloudflared/" && echo "  ✅ cloudflared/$(basename $f)"
done

echo ""
echo "--- 5. PM2 ---"
cp_if "$HOME/.pm2/dump.pm2" "pm2-dump.json"
pm2 list --no-color 2>/dev/null > "$OUT/pm2-list.txt" && echo "  ✅ pm2-list.txt"

echo ""
echo "--- 6. Claude settings (all oracles) ---"
mkdir -p "$OUT/claude-settings"
for d in "$HOME/repos/github.com/YourOrg/"*-Oracle; do
  name=$(basename "$d")
  [ -f "$d/.claude/settings.json" ] && cp "$d/.claude/settings.json" "$OUT/claude-settings/$name.json" && echo "  ✅ $name"
done

echo ""
echo "--- 7. Git identity + auth ---"
git config --global user.name > "$OUT/git-user-name.txt" 2>/dev/null
git config --global user.email > "$OUT/git-user-email.txt" 2>/dev/null
echo "  ✅ git identity"

echo ""
echo "--- 8. Repo list ---"
ghq list 2>/dev/null > "$OUT/repo-list.txt" && echo "  ✅ repo-list.txt ($(wc -l < "$OUT/repo-list.txt") repos)"

echo ""
echo "--- 9. WSL config ---"
[ -f /etc/wsl.conf ] && sudo cp /etc/wsl.conf "$OUT/wsl.conf" 2>/dev/null && echo "  ✅ wsl.conf" || echo "  ⚠️  wsl.conf (need sudo)"

echo ""
echo "--- 10. Tmux state ---"
tmux list-sessions -F '#{session_name}' 2>/dev/null > "$OUT/tmux-sessions.txt" && echo "  ✅ tmux-sessions.txt ($(wc -l < "$OUT/tmux-sessions.txt") sessions)"
tmux show-option -g 2>/dev/null > "$OUT/tmux-options.txt" && echo "  ✅ tmux-options.txt"

echo ""
TOTAL=$(find "$OUT" -type f | wc -l)
SIZE=$(du -sh "$OUT" | cut -f1)
echo "=== Backup complete: $TOTAL files, $SIZE → $OUT ==="
echo "Copy this directory to new server before running migrate-fleet.sh"
