#!/usr/bin/env bash
# End-to-end Telegram flow test for SENTINEL.
# Verifies bot connection, sends a test message, then continuously polls
# the heartbeat endpoint so Telegram inbound messages get picked up —
# even without Python's sentinel.py running.
#
# Usage: bash test_telegram_flow.sh
# Requires: pnpm dev running on localhost:3000

set -euo pipefail

BASE_URL="${SENTINEL_URL:-http://localhost:3000}"
HEARTBEAT_INTERVAL=3

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "${CYAN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }

# ── Step 1: Verify bot connection ───────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  SENTINEL Telegram Flow Test"
echo "═══════════════════════════════════════════════"
echo ""

info "Step 1: Checking Telegram bot connection..."
BOT_RESP=$(curl -sf "${BASE_URL}/api/sentinel/telegram" 2>/dev/null || echo '{"error":"fetch failed"}')
BOT_OK=$(echo "$BOT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('bot',{}).get('ok') or d.get('connected') else 'fail')" 2>/dev/null || echo "fail")

if [ "$BOT_OK" = "ok" ]; then
  BOT_NAME=$(echo "$BOT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('bot',{}).get('username', d.get('botUsername','unknown')))" 2>/dev/null || echo "unknown")
  ok "Bot connected: @${BOT_NAME}"
else
  fail "Cannot reach Telegram bot API. Is pnpm dev running?"
  echo "  Response: $BOT_RESP"
  exit 1
fi

# ── Step 2: Send outbound test message ──────────────────────
echo ""
info "Step 2: Sending outbound test message..."
SEND_RESP=$(curl -sf -X POST "${BASE_URL}/api/sentinel/telegram" \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"🔄 SENTINEL flow test started. Send me a message to verify inbound routing."}' \
  2>/dev/null || echo '{"error":"send failed"}')

SEND_OK=$(echo "$SEND_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('ok') or d.get('sent') else 'fail')" 2>/dev/null || echo "fail")

if [ "$SEND_OK" = "ok" ]; then
  ok "Test message sent — check your Telegram"
else
  warn "Outbound send may have failed: $SEND_RESP"
  echo "  (Continuing anyway — inbound polling may still work)"
fi

# ── Step 3: Heartbeat polling loop ──────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Heartbeat polling active (every ${HEARTBEAT_INTERVAL}s)"
echo "  Send messages to the bot on Telegram!"
echo ""
echo "  Test these:"
echo "    • \"hello\"    → Should get a chat response"
echo "    • \"/status\"  → Should get a status summary"
echo "    • \"watch for people\" → Should get mission prompt"
echo "    • \"yes\"      → Should activate mission"
echo ""
echo "  Press Ctrl+C to stop"
echo "═══════════════════════════════════════════════"
echo ""

POLL_COUNT=0

cleanup() {
  echo ""
  echo ""
  info "Stopped after $POLL_COUNT heartbeats."

  # Send final status
  FINAL=$(curl -sf "${BASE_URL}/api/sentinel/heartbeat" 2>/dev/null || echo '{}')
  FINAL_MODE=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo "?")
  FINAL_MISSION=$(echo "$FINAL" | python3 -c "import sys,json; m=json.load(sys.stdin).get('mission'); print(m['missionName'] if m else 'none')" 2>/dev/null || echo "none")

  echo ""
  echo "  Final state:"
  echo "    Mode:    $FINAL_MODE"
  echo "    Mission: $FINAL_MISSION"
  echo ""
  exit 0
}

trap cleanup SIGINT SIGTERM

while true; do
  RESP=$(curl -sf "${BASE_URL}/api/sentinel/heartbeat" 2>/dev/null || echo '{"error":"heartbeat failed"}')
  POLL_COUNT=$((POLL_COUNT + 1))

  # Parse response
  MODE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo "?")
  VISIBLE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('visible',0))" 2>/dev/null || echo "0")
  UNIQUE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('unique',0))" 2>/dev/null || echo "0")
  MISSION=$(echo "$RESP" | python3 -c "import sys,json; m=json.load(sys.stdin).get('mission'); print(m['missionName'] if m else '-')" 2>/dev/null || echo "-")
  ERROR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null || echo "")

  # Compact status line
  TIMESTAMP=$(date +%H:%M:%S)
  if [ -n "$ERROR" ] && [ "$ERROR" != "" ]; then
    printf "\r${RED}[%s]${NC} #%d  error: %s" "$TIMESTAMP" "$POLL_COUNT" "$ERROR"
  else
    printf "\r${GREEN}[%s]${NC} #%-4d mode=%-8s visible=%-3s unique=%-3s mission=%s    " \
      "$TIMESTAMP" "$POLL_COUNT" "$MODE" "$VISIBLE" "$UNIQUE" "$MISSION"
  fi

  sleep "$HEARTBEAT_INTERVAL"
done
