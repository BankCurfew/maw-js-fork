#!/bin/bash
# maw-js macOS setup — get a new node running from scratch
#
# Usage:
#   git clone https://github.com/YourOrg/maw-js.git
#   cd maw-js
#   bash scripts/setup-macos.sh
#
# What this does:
#   1. Checks / installs: bun, tmux, pm2
#   2. Copies example configs (won't overwrite existing)
#   3. Detects ghqRoot
#   4. Runs bun install
#   5. Prints first-run instructions

set -e

echo ""
echo "  maw-js — macOS setup"
echo "  ====================="
echo ""

# ── 1. Dependencies ──────────────────────────────────────────

check_or_install() {
  local cmd="$1"
  local install_cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  [ok] $cmd ($(command -v $cmd))"
  else
    echo "  [!!] $cmd not found — installing..."
    eval "$install_cmd"
    if command -v "$cmd" >/dev/null 2>&1; then
      echo "  [ok] $cmd installed"
    else
      echo "  [FAIL] Could not install $cmd. Install manually and re-run."
      exit 1
    fi
  fi
}

echo "Checking dependencies..."
echo ""

# bun
check_or_install "bun" 'curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"'

# tmux
check_or_install "tmux" "brew install tmux"

# pm2 (optional but recommended)
if command -v pm2 >/dev/null 2>&1; then
  echo "  [ok] pm2 ($(command -v pm2))"
else
  echo "  [--] pm2 not found (optional, install with: bun add -g pm2)"
fi

# Claude Code CLI
if command -v claude >/dev/null 2>&1; then
  echo "  [ok] claude ($(command -v claude))"
else
  echo "  [!!] claude CLI not found — install from https://claude.ai/code"
  echo "       maw won't be able to launch oracles without it"
fi

echo ""

# ── 2. Copy example configs ──────────────────────────────────

echo "Setting up configs..."
echo ""

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [ -f "$dst" ]; then
    echo "  [skip] $dst (already exists)"
  else
    cp "$src" "$dst"
    echo "  [new] $dst (copied from $(basename $src))"
  fi
}

copy_if_missing "maw.config.example.json" "maw.config.json"
copy_if_missing "rooms.example.json" "rooms.json"

# Fleet directory
mkdir -p fleet
if ls fleet/*.json 1>/dev/null 2>&1; then
  echo "  [skip] fleet/*.json (configs already exist)"
else
  copy_if_missing "fleet/01-oracle.example.json" "fleet/01-bob.json"
fi

echo ""

# ── 3. Detect ghqRoot ────────────────────────────────────────

echo "Detecting ghqRoot..."

GHQ_ROOT=""
if command -v ghq >/dev/null 2>&1; then
  GHQ_ROOT="$(ghq root)/github.com"
  echo "  [ok] ghq detected: $GHQ_ROOT"
elif [ -d "$HOME/repos/github.com" ]; then
  GHQ_ROOT="$HOME/repos/github.com"
  echo "  [ok] found: $GHQ_ROOT"
elif [ -d "$HOME/Code/github.com" ]; then
  GHQ_ROOT="$HOME/Code/github.com"
  echo "  [ok] found: $GHQ_ROOT"
else
  GHQ_ROOT="$HOME/repos/github.com"
  echo "  [--] defaulting to: $GHQ_ROOT"
  echo "       create this directory and clone your oracle repos there"
fi

# Update maw.config.json with detected ghqRoot
if [ -f "maw.config.json" ]; then
  # Use bun to update JSON (safe, no jq dependency)
  bun -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('maw.config.json', 'utf-8'));
    cfg.ghqRoot = '$GHQ_ROOT';
    fs.writeFileSync('maw.config.json', JSON.stringify(cfg, null, 2) + '\\n');
  " 2>/dev/null && echo "  [ok] maw.config.json ghqRoot updated" || true
fi

echo ""

# ── 4. Install dependencies ──────────────────────────────────

echo "Installing node dependencies..."
bun install
echo ""

# ── 5. First-run instructions ────────────────────────────────

echo ""
echo "  Setup complete!"
echo "  ==============="
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit maw.config.json:"
echo "     - Set your CLAUDE_CODE_OAUTH_TOKEN in env"
echo "     - Verify ghqRoot points to your repos"
echo "     - Set node name (e.g. \"dreams\")"
echo ""
echo "  2. Set up fleet configs:"
echo "     - Edit fleet/01-bob.json with your oracle repos"
echo "     - Add more: fleet/02-dev.json, fleet/03-qa.json, etc."
echo "     - Each oracle needs a matching repo in ghqRoot"
echo ""
echo "  3. Clone your oracle repos:"
echo "     mkdir -p $GHQ_ROOT/YourOrg"
echo "     cd $GHQ_ROOT/YourOrg"
echo "     git clone <your-bob-oracle-repo>"
echo "     git clone <your-dev-oracle-repo>"
echo ""
echo "  4. Start maw:"
echo "     # Option A: PM2 (recommended, auto-restart)"
echo "     pm2 start ecosystem.config.cjs"
echo ""
echo "     # Option B: Direct"
echo "     bun src/server.ts"
echo ""
echo "  5. Wake your fleet:"
echo "     maw wake all"
echo ""
echo "  Dashboard: http://localhost:3456"
echo ""
