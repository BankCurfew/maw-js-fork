#!/bin/bash
# cc-bob-enforcer — Stop hook for LAW #7
# When an oracle session stops, check if they cc'd bob.
# If not, log a warning and auto-report to Bob via maw server.

INPUT=$(cat)
ORACLE=${ORACLE_NAME:-unknown}

# Skip Bob himself
echo "$ORACLE" | grep -qi "bob" && exit 0

# Check stop reason
REASON=$(echo "$INPUT" | jq -r '.stop_reason // empty' 2>/dev/null)

# Check if oracle talked to bob in this session by looking at recent feed
RECENT_BOB=$(grep -c "talk-to.*bob\|cc.*bob\|handoff.*bob" ~/.oracle/feed.log 2>/dev/null | tail -1)

# Always fire auto-report via maw server API
curl -s -X POST "http://localhost:3456/api/loops/trigger" \
  -H "Content-Type: application/json" \
  -d "{\"loopId\":\"bob-oracle-monitor\"}" >/dev/null 2>&1 &

# Write to feed that this oracle stopped
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "${TIMESTAMP} | ${ORACLE} | $(hostname) | Stop | ${ORACLE} | session ended — cc-bob-enforcer active" >> ~/.oracle/feed.log 2>/dev/null

exit 0
