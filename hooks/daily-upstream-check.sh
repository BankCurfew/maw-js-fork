#!/bin/bash
# Daily upstream maw-js check — run by maw loop
# Compares local maw-js against upstream

cd "\"/bin/.." 2>/dev/null || exit 1

git fetch upstream 2>/dev/null

BEHIND=$(git rev-list HEAD..upstream/main --count 2>/dev/null)
LATEST=$(git log upstream/main --oneline -5 2>/dev/null)

echo "=== MAW-JS UPSTREAM CHECK ==="
echo "Behind: $BEHIND commits"
echo ""
echo "Latest upstream:"
echo "$LATEST"
echo ""

# Highlight interesting features (not just deps bumps)
FEATURES=$(git log HEAD..upstream/main --oneline 2>/dev/null | grep -i "feat\|fix(" | grep -v "deps\|bump" | head -10)
if [ -n "$FEATURES" ]; then
  echo "Notable features/fixes:"
  echo "$FEATURES"
fi
