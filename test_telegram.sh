#!/usr/bin/env bash
# Quick test: verify Telegram bot token + chat ID work.
# Sends a test message and reports success/failure.

source /home/mvecera/Projects/RocketHacks/sentinel/.env.local

echo "=== SENTINEL Telegram Bot Test ==="
echo "Bot token: ${TELEGRAM_BOT_TOKEN:0:10}..."
echo "Chat ID:   $TELEGRAM_CHAT_ID"
echo ""

# Step 1: Verify bot identity
echo "--- Checking bot identity (getMe) ---"
ME=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe")
echo "$ME" | python3 -m json.tool 2>/dev/null || echo "$ME"
echo ""

OK=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
if [ "$OK" != "True" ]; then
  echo "FAILED: Bot token is invalid."
  exit 1
fi

# Step 2: Send a test message
echo "--- Sending test message ---"
RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${TELEGRAM_CHAT_ID}\", \"text\": \"SENTINEL test — bot connection verified.\", \"parse_mode\": \"Markdown\"}")
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
echo ""

SEND_OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
if [ "$SEND_OK" = "True" ]; then
  echo "SUCCESS: Message sent. Check your Telegram."
else
  echo "FAILED: Could not send message. Check chat ID."
  exit 1
fi
