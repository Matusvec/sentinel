# SENTINEL — Telegram Integration & Temporal Intelligence
## The "OpenClaw for Spatial Reasoning Over Time"

---

## The Vision

SENTINEL is a platform where you:
1. Point a camera at anything
2. Send it a text message describing what you want it to understand
3. It watches, reasons, remembers, and learns patterns over hours/days/weeks
4. It texts you back when something matters — with photos, stats, and context

The three things that make this different from anything else:

**TIME** — It doesn't just see. It remembers. It knows what's normal for Tuesday at 3pm vs Saturday at 3pm. It notices that someone who was here yesterday is back today. It tracks trends across hours, days, weeks. The database IS the intelligence.

**CUSTOMIZABLE WITH A PROMPT** — You don't configure settings or write code. You text it in plain English. "Watch for delivery trucks and count them." "Tell me if this parking spot opens up." "Monitor my baby's crib and alert me if she's crying." One message rewires the entire perception stack.

**OPEN-SOURCE REASONING** — Featherless runs open-weight models. Every inference decision is transparent and auditable. When SENTINEL says "this is unusual," you can see exactly why. No black box.

---

## Telegram Integration

### Why Telegram
- Free bot API, no approval process, works in 5 minutes
- Supports photos, videos, text, buttons, and inline keyboards
- Works on every phone, desktop, web
- Your user doesn't need to install anything special
- You can text SENTINEL from anywhere in the world

### Setup (10 minutes)

**Step 1: Create the bot**
1. Open Telegram, search for @BotFather
2. Send `/newbot`
3. Name it "SENTINEL" (or whatever you want)
4. BotFather gives you a token like `7123456789:AAH...`
5. Add to `.env.local`: `TELEGRAM_BOT_TOKEN=your_token`

**Step 2: Get your chat ID**
1. Search for @userinfobot on Telegram
2. Send it any message
3. It replies with your chat ID (a number like `123456789`)
4. Add to `.env.local`: `TELEGRAM_CHAT_ID=your_chat_id`

**Step 3: Test it**
```bash
curl -X POST "https://api.telegram.org/bot{YOUR_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "YOUR_CHAT_ID", "text": "SENTINEL online. Awaiting instructions."}'
```
If you get a message on Telegram, it works.

### How It Works In Your App

**Sending messages FROM SENTINEL to you:**

```javascript
// lib/telegram.ts

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Send a text message
export async function sendText(text: string) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
    }),
  });
}

// Send a photo with caption
export async function sendPhoto(imageBase64: string, caption: string) {
  // Convert base64 to buffer
  const buffer = Buffer.from(imageBase64, 'base64');
  
  // Telegram needs multipart form data for photos
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', caption);
  formData.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'frame.jpg');
  
  await fetch(`${BASE_URL}/sendPhoto`, {
    method: 'POST',
    body: formData,
  });
}

// Send an alert with inline action buttons
export async function sendAlert(text: string, imageBase64?: string) {
  if (imageBase64) {
    await sendPhoto(imageBase64, text);
  } else {
    await sendText(`⚠️ *SENTINEL ALERT*\n\n${text}`);
  }
}

// Send a mission summary
export async function sendSummary(summary: object) {
  const text = `📊 *SENTINEL Report*\n\n` +
    `Mission: ${summary.missionName}\n` +
    `Duration: ${summary.duration}\n\n` +
    `${summary.findings}\n\n` +
    `_Next update in ${summary.nextUpdateMinutes} minutes_`;
  
  await sendText(text);
}
```

**Receiving messages FROM you to SENTINEL (this is the magic part):**

Telegram has two ways to receive messages. The simplest for a hackathon is polling:

```javascript
// lib/telegram-listener.ts

let lastUpdateId = 0;

export async function checkForMessages() {
  const response = await fetch(
    `${BASE_URL}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`
  );
  const data = await response.json();
  
  if (data.result && data.result.length > 0) {
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      
      if (update.message?.text) {
        return {
          text: update.message.text,
          from: update.message.from.first_name,
          timestamp: new Date(update.message.date * 1000),
        };
      }
    }
  }
  return null;
}
```

Then in your perception loop or a setInterval, check for new Telegram messages:

```javascript
// Every 3 seconds, check if the user sent a Telegram message
setInterval(async () => {
  const msg = await checkForMessages();
  if (msg) {
    // Process it exactly like a chat message on the dashboard
    // Send to /api/sentinel/chat with the message text
    // The response gets sent back via Telegram instead of dashboard
    const response = await handleChatMessage(msg.text);
    
    if (response.isTask) {
      // User is giving a new mission via Telegram
      await setMission(msg.text);
      await sendText(`✅ Mission set: ${response.missionName}\n\nI'll text you when something happens.`);
    } else {
      // User asked a question, send the answer back
      await sendText(response.answer);
    }
  }
}, 3000);
```

### Example Telegram Conversations

**Setting up a mission remotely:**
```
You:      Watch the front porch. Tell me if anyone comes 
          to the door after 9pm. Send a photo.

SENTINEL: ✅ Mission set: Front porch night monitor

          Watching for: People approaching after 9:00 PM
          Alert type: Photo + description
          Mode: Silent until triggered
          
          I'll text you when someone shows up.
```

**Getting an alert:**
```
SENTINEL: ⚠️ SENTINEL ALERT

          Person detected on front porch at 10:47 PM.
          Standing at the door for 15 seconds.
          Appears to be holding a package.
          
          [Photo attached]

You:      Keep watching. Tell me if they come back.

SENTINEL: ✅ Updated: Also watching for return visits 
          from the same person.
```

**Asking for a report:**
```
You:      How was the porch today?

SENTINEL: 📊 SENTINEL Report
          
          Mission: Front porch monitor
          Running since: 6:00 PM (4 hours)
          
          Total visitors: 3
          • 7:12 PM — Delivery driver, dropped package, left
          • 8:45 PM — Neighbor walked past, didn't stop
          • 10:47 PM — Unknown person, lingered 15 sec (alerted)
          
          No visitors in the last 45 minutes.
          Activity level: Quiet.
```

**Changing the mission:**
```
You:      Actually, also count cars that pass by on the street.

SENTINEL: ✅ Mission updated: Front porch + street traffic
          
          Now tracking:
          • People approaching the door (alert after 9pm)
          • Cars passing on the street (counting)
          
          I'll include car counts in my reports.
```

---

## The Temporal Intelligence Layer (Why "Over Time" Is Everything)

### What MongoDB Enables

Most AI vision systems are stateless — they analyze one frame and forget it. SENTINEL remembers everything. This is what the database gives you:

**Short-term memory (last 5 minutes):**
Raw detections. "Right now there are 3 people. 10 seconds ago there were 2. Someone just arrived."
Used by: the perception loop for change detection and immediate responses.

**Medium-term memory (last 1-24 hours):**
Event patterns. "Between 2pm and 4pm, 47 people walked by. The busiest 15-minute window was 3:15-3:30. One person came back 3 times."
Used by: Featherless for pattern analysis every 30 seconds.

**Long-term memory (days/weeks):**
Baselines and trends. "Tuesdays average 200 people. This Tuesday had 280 — 40% above normal. The parking lot fills up by 9:15am on weekdays but not until 11am on weekends."
Used by: Featherless for anomaly detection against historical norms.

### MongoDB Aggregation Pipelines That Power This

**Hourly activity heatmap:**
```javascript
db.detections.aggregate([
  { $match: { 
    mission_id: activeMission.id,
    timestamp: { $gte: last24Hours } 
  }},
  { $group: {
    _id: { hour: { $hour: '$timestamp' } },
    avg_count: { $avg: '$data.people_count' },
    max_count: { $max: '$data.people_count' },
    total_events: { $sum: 1 },
  }},
  { $sort: { '_id.hour': 1 } }
])
```
Result: "Hour 14 (2pm) averaged 4.2 people, peaked at 8."

**Recurring visitor detection:**
```javascript
db.detections.aggregate([
  { $match: { 
    mission_id: activeMission.id,
    'data.person_description': { $exists: true }
  }},
  { $group: {
    _id: '$data.person_description',
    visit_count: { $sum: 1 },
    first_seen: { $min: '$timestamp' },
    last_seen: { $max: '$timestamp' },
    avg_duration_seconds: { $avg: '$data.duration' },
  }},
  { $match: { visit_count: { $gt: 1 } } },
  { $sort: { visit_count: -1 } }
])
```
Result: "Person in blue jacket has been seen 3 times today."

**Baseline comparison (is today normal?):**
```javascript
// Get same day-of-week average from past 4 weeks
const dayOfWeek = new Date().getDay();
db.analyses.aggregate([
  { $match: { 
    mission_id: activeMission.id,
    'metadata.day_of_week': dayOfWeek,
    timestamp: { $gte: fourWeeksAgo }
  }},
  { $group: {
    _id: null,
    baseline_avg_people: { $avg: '$analysis.situation_assessment.crowd_density' },
    baseline_avg_events: { $avg: '$detections_analyzed' },
  }}
])
```
Result: "Typical Tuesday: 180 events. Today: 245 events. 36% above normal."

### How Featherless Uses This Over Time

Every 30 seconds (or at the mission-specified interval), the analyze route sends Featherless:

1. **Recent events** (last 20 from MongoDB) — what just happened
2. **Hourly summary** (aggregation) — what's been happening today
3. **Baseline comparison** (aggregation) — what's normal for this time/day
4. **Mission context** — what the user cares about

Featherless then reasons across all of it:

```
"In the last 30 minutes, foot traffic increased from 3/minute to 
7/minute. This is 40% above the Tuesday baseline of 5/minute for 
this hour. The increase is concentrated on the left side of the 
hallway, suggesting an event or attraction in that direction. 
Additionally, one individual matching the description 'person in 
red jacket' has appeared 3 times in the last 2 hours at roughly 
40-minute intervals, which may indicate a patrol pattern or 
repeated visits."
```

No single frame could produce that analysis. It requires memory, baselines, and temporal reasoning. That's what makes SENTINEL fundamentally different.

### The Featherless Prompt Adapts Per Mission

Default Featherless prompt (scan mode):
"Analyze detection patterns. Find anomalies, trends, crowd dynamics."

Custom mission "count foot traffic" prompt:
"Analyze entry/exit patterns over time. Calculate flow rate per 
5-minute window. Identify peak hours. Compare to baseline if available. 
Predict when the next peak will occur based on the pattern."

Custom mission "watch grandfather" prompt:
"Monitor activity patterns for an elderly person living alone. Track: 
time between movements, daily routine adherence, posture changes, 
duration of sleep/rest periods. Flag: extended immobility (>10 min 
while not in bed), falls (lying on floor), missed routine activities 
(hasn't been to kitchen by usual time). Compare today's activity 
to their normal pattern."

The prompt is generated once when the mission is created (by Gemini parsing the user's instruction) and used for every subsequent Featherless call.

---

## Integration Into Your Existing Architecture

### Agent 1 adds to backend:

```
lib/telegram.ts              ← Sending messages + photos to Telegram
lib/telegram-listener.ts     ← Polling for incoming Telegram messages

Modify app/api/sentinel/perception/route.ts:
  When a trigger fires AND Telegram is configured:
    → Call sendAlert() with the alert text
    → If trigger severity is critical, include the frame as a photo
    → Debounce: don't send more than 1 alert per minute for same trigger

Add to the main perception loop (or a separate setInterval):
  Every 3 seconds, call checkForMessages()
  If user sent a Telegram message:
    → Route to /api/sentinel/chat (same as dashboard chat)
    → Send the response back via Telegram instead of dashboard
    → If it's a new mission instruction, set the mission and confirm

Modify app/api/sentinel/analyze/route.ts:
  Add temporal queries:
    → Pull hourly summaries from MongoDB aggregation
    → Pull day-of-week baselines for comparison
    → Include all of this in the Featherless prompt
    → If pattern analysis finds something significant,
      send a Telegram summary
```

### Agent 2 adds to frontend:

```
components/TelegramSetup.tsx   ← Simple UI to enter bot token + chat ID
  Just two text inputs and a "Test Connection" button that sends
  a test message. Store tokens in the app state / env.

Modify components/MissionInput.tsx:
  Add a toggle: "Send alerts via Telegram"
  Add a toggle: "Send periodic reports via Telegram"
  Add a field: "Report every [N] minutes"

Modify components/MissionStatus.tsx:
  Show Telegram connection status (connected / disconnected)
  Show last Telegram message sent/received
  Show alert count sent to Telegram
```

---

## What This Becomes (The Pitch)

"Every security camera in the world is dumb. It records video and someone has to watch it. SENTINEL is different. You send it a text — any instruction, in plain English — and it rewires its entire perception stack. It watches. It remembers. It reasons over time using open-source AI. And it texts you back when something matters.

Point it at a hallway and say 'count foot traffic.' Point it at your grandfather's room and say 'alert me if he falls.' Point it at a parking lot and say 'tell me when a spot opens up.' One camera, one prompt, infinite purposes.

The intelligence isn't in the hardware. It's in the temporal reasoning — SENTINEL knows what happened an hour ago, what's normal for a Tuesday, and what just changed. That context is what turns a camera into a thinking machine.

And because the reasoning runs on open-weight models through Featherless, every decision is transparent. When SENTINEL says 'this is unusual,' you can see exactly why."

---

## Hackathon Demo Order

1. SENTINEL is running in scan mode when judges arrive. Camera tracks them. Voice narrates. (30 sec)

2. "But watch this." Open Telegram on your phone. Type: "Count how many people approach this table." SENTINEL confirms on Telegram. Switch to showing the dashboard — it's now counting silently. (30 sec)

3. Have someone approach. SENTINEL texts you on Telegram: "1 person approached. Total: 1." Show your phone to the judges. (15 sec)

4. On Telegram, type: "What patterns have you noticed in the last 5 minutes?" SENTINEL responds with temporal analysis from Featherless. (15 sec)

5. "This same device, same code — you text it 'watch my grandfather' and it becomes a care monitor. You text it 'count delivery trucks' and it becomes a logistics tracker. The instruction IS the product." (30 sec)

6. Quick architecture slide: OpenCV → Gemini → MongoDB → Featherless → ElevenLabs → Telegram. Open-source reasoning. $50 in hardware. (30 sec)
