#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Telegram Chat Tester — Simulates perception heartbeat so the
# Telegram polling loop runs, then you can chat with @Matusvecbot.
#
# Usage: bash test_telegram_chat.sh
# Then open Telegram and send messages to your bot.
# Press Ctrl+C to stop.
# ─────────────────────────────────────────────────────────────

BASE_URL="http://localhost:3000/api/sentinel"
INTERVAL=2  # seconds between heartbeats

echo "=== SENTINEL Telegram Chat Tester ==="
echo ""
echo "This script sends fake perception data every ${INTERVAL}s"
echo "to keep the Telegram polling loop alive."
echo ""
echo "Open Telegram and message @Matusvecbot. Try:"
echo "  - 'hello'              → chat response"
echo "  - '/status'            → status summary"
echo "  - 'count people'       → should create a mission"
echo "  - 'how many people?'   → question about observations"
echo ""
echo "Watch the Next.js terminal for [telegram-poll] logs."
echo "Press Ctrl+C to stop."
echo "─────────────────────────────────────────────────────"
echo ""

# Verify server is up
if ! curl -sf "${BASE_URL}/perception" > /dev/null 2>&1; then
  echo "ERROR: Next.js server not running at ${BASE_URL}"
  echo "Start it with: cd sentinel && pnpm dev"
  exit 1
fi

echo "[$(date +%H:%M:%S)] Server is up. Starting heartbeat..."
echo ""

COUNT=0
while true; do
  COUNT=$((COUNT + 1))
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  # Minimal fake perception payload — just enough to trigger the route
  PAYLOAD=$(cat <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "device_id": "test-simulator",
  "local_cv": {
    "person_count": 0,
    "face_count": 0,
    "persons": [],
    "faces": []
  },
  "sensors": {
    "d": {"f": 400, "l": 400, "r": 400},
    "ir": [0, 0],
    "s": 10,
    "p": 90,
    "t": 90
  },
  "vision": null,
  "enriched_persons": []
}
EOF
)

  RESPONSE=$(curl -sf -X POST "${BASE_URL}/perception" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}" 2>&1)

  # Parse response for interesting events
  MISSION=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    parts = []
    if d.get('mission'):
        parts.append(f\"mission={d['mission'].get('missionName','?')}\")
    triggers = d.get('mission_triggers_fired', [])
    if triggers:
        parts.append(f\"triggers={len(triggers)}\")
    parts.append(f\"mode={d.get('mode','?')}\")
    print(' | '.join(parts))
except:
    print('parse error')
" 2>/dev/null)

  # Print status every 5th heartbeat (every 10s) to reduce noise
  if [ $((COUNT % 5)) -eq 0 ]; then
    echo "[$(date +%H:%M:%S)] heartbeat #${COUNT} | ${MISSION}"
  fi

  sleep ${INTERVAL}
done
