#!/bin/bash
# migrate-fleet.sh — Automated fleet migration to a new server
# Usage: ./migrate-fleet.sh <backup-dir> [--old-user mbank] [--new-user curfew] [--hostname curfew] [--skip-phase N]
# Prerequisites: Ubuntu/Debian WSL, internet access, GitHub auth
# ref: [oracle-infra] #137

set -euo pipefail

# --- Parse args ---
BACKUP_DIR=""
OLD_USER="mbank"
NEW_USER="$(whoami)"
HOSTNAME_LABEL="${NEW_USER}"
SKIP_PHASES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --old-user) OLD_USER="$2"; shift 2 ;;
    --new-user) NEW_USER="$2"; shift 2 ;;
    --hostname) HOSTNAME_LABEL="$2"; shift 2 ;;
    --skip-phase) SKIP_PHASES="$SKIP_PHASES $2"; shift 2 ;;
    --help|-h)
      echo "Usage: migrate-fleet.sh <backup-dir> [--old-user mbank] [--new-user $(whoami)] [--hostname name] [--skip-phase N]"
      echo "Phases: 1=prerequisites 2=repos 3=maw-install 4=paths 5=hooks 6=boot 7=wake 8=restore"
      exit 0 ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done

[ -z "$BACKUP_DIR" ] && { echo "Usage: migrate-fleet.sh <backup-dir> [options]"; exit 1; }
[ -d "$BACKUP_DIR" ] || { echo "Backup dir not found: $BACKUP_DIR"; exit 1; }

LOG=/tmp/fleet-migration.log
echo "" >> "$LOG"
echo "$(date) | ========== Fleet migration starting ==========" >> "$LOG"
echo "$(date) | backup=$BACKUP_DIR old=$OLD_USER new=$NEW_USER host=$HOSTNAME_LABEL" >> "$LOG"

should_skip() { echo "$SKIP_PHASES" | grep -qw "$1"; }

phase() {
  local N="$1" TITLE="$2"
  if should_skip "$N"; then
    echo ""
    echo "=== Phase $N: $TITLE [SKIPPED] ==="
    return 1
  fi
  echo ""
  echo "=== Phase $N: $TITLE ==="
  echo "$(date) | Phase $N: $TITLE" >> "$LOG"
  return 0
}

check_cmd() { command -v "$1" >/dev/null 2>&1; }

# ============================================================
# Phase 1: Prerequisites
# ============================================================
if phase 1 "Prerequisites (install tools)"; then

  echo "--- Checking/installing tools ---"

  # bun
  if check_cmd bun; then
    echo "  ✅ bun $(bun --version)"
  else
    echo "  📦 Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    echo "  ✅ bun installed"
  fi

  # nvm + node
  if check_cmd node; then
    echo "  ✅ node $(node --version)"
  else
    echo "  📦 Installing nvm + node..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install --lts
    echo "  ✅ node installed"
  fi

  # pm2
  if check_cmd pm2; then
    echo "  ✅ pm2 $(pm2 --version 2>/dev/null)"
  else
    echo "  📦 Installing pm2..."
    npm i -g pm2
    echo "  ✅ pm2 installed"
  fi

  # gh CLI
  if check_cmd gh; then
    echo "  ✅ gh $(gh --version | head -1)"
  else
    echo "  📦 Installing gh CLI..."
    (type -p wget >/dev/null || sudo apt install wget -y) \
      && sudo mkdir -p -m 755 /etc/apt/keyrings \
      && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
      && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
      && sudo apt update && sudo apt install gh -y
    echo "  ✅ gh installed"
  fi

  # gh auth check
  if gh auth status >/dev/null 2>&1; then
    echo "  ✅ gh authenticated"
  else
    echo ""
    echo "  ⚠️  GitHub auth required — run: gh auth login"
    echo "  Press Enter after completing auth..."
    read -r
  fi

  # Other tools
  for tool in tmux jq cloudflared ollama ghq; do
    if check_cmd "$tool"; then
      echo "  ✅ $tool"
    else
      case "$tool" in
        tmux|jq) sudo apt install -y "$tool" 2>/dev/null && echo "  ✅ $tool installed" || echo "  ⚠️  $tool: install manually" ;;
        cloudflared) echo "  ⚠️  cloudflared: install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" ;;
        ollama) curl -fsSL https://ollama.com/install.sh | sh && echo "  ✅ ollama installed" || echo "  ⚠️  ollama: install manually" ;;
        ghq) go install github.com/x-motemen/ghq@latest 2>/dev/null && echo "  ✅ ghq installed" || echo "  ⚠️  ghq: install manually (needs Go)" ;;
      esac
    fi
  done

  echo "$(date) | Phase 1 complete" >> "$LOG"
fi

# ============================================================
# Phase 2: Clone all repos
# ============================================================
if phase 2 "Clone all repos"; then

  if [ -f "$BACKUP_DIR/repo-list.txt" ]; then
    TOTAL=$(wc -l < "$BACKUP_DIR/repo-list.txt")
    echo "  Cloning $TOTAL repos from backup list..."
    while read -r repo; do
      if [ -d "$HOME/repos/$repo" ] || [ -d "$(ghq root)/$repo" ] 2>/dev/null; then
        continue
      fi
      ghq get "https://$repo" 2>/dev/null || echo "  ⚠️  Failed: $repo"
    done < "$BACKUP_DIR/repo-list.txt"
    echo "  ✅ Repos cloned: $(ghq list 2>/dev/null | wc -l)"
  else
    echo "  No repo-list.txt in backup — cloning from GitHub..."
    gh repo list YourOrg --limit 100 --json nameWithOwner --jq '.[].nameWithOwner' | while read -r repo; do
      ghq get "https://github.com/$repo" 2>/dev/null || true
    done
    echo "  ✅ Repos cloned: $(ghq list 2>/dev/null | wc -l)"
  fi

  echo "$(date) | Phase 2 complete" >> "$LOG"
fi

# ============================================================
# Phase 3: Install maw-js
# ============================================================
if phase 3 "Install maw-js"; then

  MAW="$HOME/repos/github.com/YourOrg/maw-js"
  cd "$MAW"
  bun install
  echo "  ✅ bun install complete"

  # Restore config from backup
  for f in maw.config.json rooms.json; do
    if [ -f "$BACKUP_DIR/$f" ]; then
      cp "$BACKUP_DIR/$f" "$MAW/$f"
      echo "  ✅ Restored $f"
    fi
  done

  echo "$(date) | Phase 3 complete" >> "$LOG"
fi

# ============================================================
# Phase 4: Path migration
# ============================================================
if phase 4 "Path migration (/home/$OLD_USER → /home/$NEW_USER)"; then

  if [ "$OLD_USER" = "$NEW_USER" ]; then
    echo "  Same user — skip path migration"
  else
    echo "  Scanning for /home/$OLD_USER references..."
    COUNT=0

    # Oracle repos
    find "$HOME/repos/github.com/YourOrg/" \
      \( -name '.mcp.json' -o -name 'CLAUDE.md' -o -name 'CLAUDE_*.md' -o -name 'settings.json' -path '*/.claude/*' \) \
      2>/dev/null | while read -r f; do
      if grep -q "/home/$OLD_USER" "$f" 2>/dev/null; then
        sed -i "s|/home/$OLD_USER|/home/$NEW_USER|g" "$f"
        COUNT=$((COUNT+1))
      fi
    done

    # Hook scripts
    for f in "$HOME/.oracle/hooks/"*.sh; do
      [ -f "$f" ] && sed -i "s|/home/$OLD_USER|/home/$NEW_USER|g" "$f"
    done

    # Boot scripts
    [ -f "$HOME/boot.sh" ] && sed -i "s|/home/$OLD_USER|/home/$NEW_USER|g" "$HOME/boot.sh"
    [ -f "$HOME/test-boot.sh" ] && sed -i "s|/home/$OLD_USER|/home/$NEW_USER|g" "$HOME/test-boot.sh"

    # Verify
    REMAINING=$(grep -rn "/home/$OLD_USER" "$HOME/repos/github.com/YourOrg/" "$HOME/.oracle/" "$HOME/boot.sh" 2>/dev/null | grep -v '.git/' | wc -l)
    echo "  ✅ Path migration done (remaining refs: $REMAINING)"
    [ "$REMAINING" -gt 0 ] && echo "  ⚠️  Review: grep -rn '/home/$OLD_USER' ~/repos/ ~/.oracle/ ~/boot.sh | grep -v .git/"
  fi

  echo "$(date) | Phase 4 complete" >> "$LOG"
fi

# ============================================================
# Phase 5: Copy hooks + oracle infrastructure
# ============================================================
if phase 5 "Hooks + oracle infrastructure"; then

  mkdir -p "$HOME/.oracle/hooks" "$HOME/.oracle/tools" "$HOME/.oracle/docs" "$HOME/.oracle/directory"

  [ -d "$BACKUP_DIR/oracle-hooks" ] && cp "$BACKUP_DIR/oracle-hooks/"*.sh "$HOME/.oracle/hooks/" 2>/dev/null && chmod +x "$HOME/.oracle/hooks/"*.sh && echo "  ✅ Hooks restored"
  [ -d "$BACKUP_DIR/oracle-docs" ] && cp -r "$BACKUP_DIR/oracle-docs/"* "$HOME/.oracle/docs/" 2>/dev/null && echo "  ✅ Docs restored"
  [ -d "$BACKUP_DIR/oracle-tools" ] && cp -r "$BACKUP_DIR/oracle-tools/"* "$HOME/.oracle/tools/" 2>/dev/null && echo "  ✅ Tools restored"
  [ -d "$BACKUP_DIR/oracle-directory" ] && cp -r "$BACKUP_DIR/oracle-directory/"* "$HOME/.oracle/directory/" 2>/dev/null && echo "  ✅ Directory restored"
  [ -f "$BACKUP_DIR/feed-hook.py" ] && cp "$BACKUP_DIR/feed-hook.py" "$HOME/.oracle/" && echo "  ✅ feed-hook.py restored"
  [ -f "$BACKUP_DIR/SYSTEM_PLAYBOOK.md" ] && cp "$BACKUP_DIR/SYSTEM_PLAYBOOK.md" "$HOME/.oracle/" && echo "  ✅ SYSTEM_PLAYBOOK.md restored"

  # Restore claude settings for all oracles
  if [ -d "$BACKUP_DIR/claude-settings" ]; then
    for f in "$BACKUP_DIR/claude-settings/"*.json; do
      NAME=$(basename "$f" .json)
      DEST="$HOME/repos/github.com/YourOrg/$NAME/.claude/settings.json"
      if [ -d "$(dirname "$DEST")" ]; then
        mkdir -p "$(dirname "$DEST")"
        cp "$f" "$DEST"
      fi
    done
    echo "  ✅ Claude settings restored"
  fi

  echo "$(date) | Phase 5 complete" >> "$LOG"
fi

# ============================================================
# Phase 6: Boot infrastructure
# ============================================================
if phase 6 "Boot infrastructure (PM2, cloudflared, WSL)"; then

  # Boot scripts
  [ -f "$BACKUP_DIR/boot.sh" ] && cp "$BACKUP_DIR/boot.sh" "$HOME/boot.sh" && chmod +x "$HOME/boot.sh" && echo "  ✅ boot.sh restored"
  [ -f "$BACKUP_DIR/test-boot.sh" ] && cp "$BACKUP_DIR/test-boot.sh" "$HOME/test-boot.sh" && chmod +x "$HOME/test-boot.sh" && echo "  ✅ test-boot.sh restored"

  # PM2
  MAW="$HOME/repos/github.com/YourOrg/maw-js"
  if [ -f "$BACKUP_DIR/ecosystem.config.cjs" ]; then
    cp "$BACKUP_DIR/ecosystem.config.cjs" "$MAW/ecosystem.config.cjs"
  fi
  cd "$MAW"
  pm2 start ecosystem.config.cjs 2>/dev/null || true
  pm2 save
  echo "  ✅ PM2 started + saved"

  # PM2 startup
  echo "  Setting up PM2 startup..."
  pm2 startup systemd -u "$NEW_USER" --hp "/home/$NEW_USER" 2>/dev/null || echo "  ⚠️  PM2 startup: may need sudo"

  # Cloudflare
  if [ -d "$BACKUP_DIR/cloudflared" ]; then
    mkdir -p "$HOME/.cloudflared"
    cp "$BACKUP_DIR/cloudflared/"* "$HOME/.cloudflared/" 2>/dev/null
    echo "  ✅ Cloudflare config restored"
    echo "  ⚠️  Manual: verify hostnames in ~/.cloudflared/config.yml"
    echo "  ⚠️  Manual: cloudflared tunnel route dns --overwrite-dns <tunnel-id> <domain>"
  fi

  # tmux config
  [ -f "$BACKUP_DIR/tmux.conf" ] && cp "$BACKUP_DIR/tmux.conf" "$HOME/.tmux.conf" && echo "  ✅ tmux.conf restored"
  tmux source-file "$HOME/.tmux.conf" 2>/dev/null || true
  tmux set-option -g default-size 200x200 2>/dev/null

  # WSL config
  echo "  ⚠️  Manual: verify /etc/wsl.conf — boot command should point to /home/$NEW_USER/boot.sh"

  echo "$(date) | Phase 6 complete" >> "$LOG"
fi

# ============================================================
# Phase 7: Wake fleet + verify
# ============================================================
if phase 7 "Wake fleet + verify"; then

  tmux set-option -g default-size 200x200 2>/dev/null

  # Wait for maw server
  echo "  Waiting for maw server..."
  for i in $(seq 1 30); do
    curl -s --max-time 2 http://localhost:3456/ >/dev/null 2>&1 && break
    sleep 2
  done

  MAW="$HOME/repos/github.com/YourOrg/maw-js"
  cd "$MAW"
  echo "  Waking full fleet..."
  bun src/cli.ts wake --all 2>&1 | tail -20

  sleep 15

  # Resize all windows
  for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
    tmux resize-window -t "$session" -x 200 -y 200 2>/dev/null
  done
  echo "  ✅ All windows resized to 200x200"

  # Run tests
  echo ""
  echo "  Running test-boot.sh..."
  bash "$HOME/test-boot.sh" 2>/dev/null || true

  echo "$(date) | Phase 7 complete" >> "$LOG"
fi

# ============================================================
# Phase 8: Restore state
# ============================================================
if phase 8 "Restore state (loops, projects, identity)"; then

  MAW="$HOME/repos/github.com/YourOrg/maw-js"

  [ -f "$BACKUP_DIR/loops.json" ] && cp "$BACKUP_DIR/loops.json" "$MAW/loops.json" && echo "  ✅ loops.json restored"

  # Restore ~/.maw/ state (projects, task-logs, loop-queue)
  mkdir -p "$HOME/.maw"
  if [ -d "$BACKUP_DIR/maw-state" ]; then
    for f in oracle-projects.json projects.json; do
      [ -f "$BACKUP_DIR/maw-state/$f" ] && cp "$BACKUP_DIR/maw-state/$f" "$HOME/.maw/$f" && echo "  ✅ ~/.maw/$f restored"
    done
    for d in task-logs loop-queue projects inbox; do
      [ -d "$BACKUP_DIR/maw-state/$d" ] && cp -r "$BACKUP_DIR/maw-state/$d" "$HOME/.maw/$d" && echo "  ✅ ~/.maw/$d/ restored"
    done
  fi

  # Git identity
  if [ -f "$BACKUP_DIR/git-user-name.txt" ] && [ -f "$BACKUP_DIR/git-user-email.txt" ]; then
    git config --global user.name "$(cat "$BACKUP_DIR/git-user-name.txt")"
    git config --global user.email "$(cat "$BACKUP_DIR/git-user-email.txt")"
    echo "  ✅ Git identity: $(git config --global user.name) <$(git config --global user.email)>"
  fi

  # Verify arra-api
  if curl -s --max-time 3 http://localhost:47778/api/health >/dev/null 2>&1; then
    echo "  ✅ arra-api healthy"
  else
    echo "  ⚠️  arra-api not responding on :47778"
  fi

  echo "$(date) | Phase 8 complete" >> "$LOG"
fi

echo ""
echo "=========================================="
echo "  Fleet migration complete!"
echo "  Log: $LOG"
echo "  Next: bash ~/test-boot.sh (verify 38/38)"
echo "=========================================="
echo "$(date) | ========== Fleet migration complete ==========" >> "$LOG"
