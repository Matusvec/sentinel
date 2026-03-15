# SENTINEL — Multi-Agent Parallel Build Plan
## Adaptive Perception Engine with Temporal Intelligence

---

## The Hard Problem (and how we solve it)

The core challenge: when a user says "count red backpacks" vs "watch my grandfather" vs "monitor foot traffic," EVERYTHING changes — what Gemini looks for in each frame, what gets stored in MongoDB, what Featherless reasons about, and when alerts fire.

Most systems solve this with rigid schemas and config files. We solve it with a single design decision:

**The database stores flexible documents. The prompts are the schema.**

Here's what that means:

### The Adaptive Storage Architecture

We do NOT create different MongoDB collections for different missions. We do NOT define rigid schemas. Instead:

Every detection document has the same outer structure:
```javascript
{
  _id: ObjectId,
  timestamp: ISODate,
  mission_id: "grandpa_watch_001",
  
  // THIS is the flexible part — changes per mission
  extracted: {
    // For "count red backpacks":
    // { red_backpack_count: 2, total_backpacks: 5, locations: [...] }
    //
    // For "watch grandfather":
    // { person_visible: true, posture: "standing", moving: true, on_floor: false }
    //
    // For "count foot traffic":
    // { entering: 3, exiting: 1, total_in_frame: 5, directions: [...] }
  },
  
  // Always present, minimal context
  meta: {
    people_count: 3,
    activity_level: "moderate",
    gimbal_position: { pan: 90, tilt: 90 },
    sensors: { front_dist: 180, ir: [0, 0], sound: 450 },
  },
  
  // Only present if a trigger fired
  trigger: null,  // or { type: "fall_detected", severity: "critical", message: "..." }
  
  // Only present on critical events
  frame: null,  // or base64 string
}
```

The `extracted` field is a free-form object. Its contents are determined by the mission's extraction prompt, which Gemini generates when the mission is created. This means MongoDB doesn't care what mission you're running — it just stores whatever the extraction produces.

### How the Prompt Rewires Everything

When a user says "watch my grandfather, text me if he falls":

**Step 1: Gemini parses the instruction (once, at mission creation)**

Input: user's raw instruction
Output: a MissionConfig object containing 4 custom prompts

```javascript
MissionConfig = {
  // Prompt A: What Gemini Vision looks for in EACH FRAME
  visionPrompt: "Focus on detecting a single elderly person. Report: 
    Are they visible? What is their posture (standing/sitting/lying_bed/
    lying_floor)? Are they moving? Estimate confidence. If they are on 
    the floor and not in a bed, flag as CRITICAL.
    
    Return JSON:
    { person_visible: bool, posture: string, moving: bool, 
      on_floor: bool, confidence: float, description: string }",
  
  // Prompt B: What fields to EXTRACT and store from Gemini's response
  extractionMap: {
    source: "gemini_vision_response",
    fields: ["person_visible", "posture", "moving", "on_floor", "confidence"]
  },
  
  // Prompt C: When to TRIGGER alerts
  triggers: [
    { 
      condition: "extracted.on_floor === true && extracted.confidence > 0.7",
      severity: "critical",
      message: "Your grandfather appears to have fallen.",
      includeFrame: true,
      sendTelegram: true,
    },
    {
      condition: "minutes_since_movement > 10 && extracted.posture !== 'lying_bed'",
      severity: "warning", 
      message: "No movement detected for {minutes} minutes.",
      includeFrame: true,
      sendTelegram: true,
    }
  ],
  
  // Prompt D: What Featherless analyzes over TIME
  featherlessSystemPrompt: "You monitor an elderly person living alone.
    Analyze activity patterns over time. Track: movement frequency, 
    routine adherence, rest vs active periods. Flag: extended immobility 
    while not in bed, missed routine times, gradual decline in activity 
    over days. Compare current activity to their established pattern."
}
```

**Step 2: Every perception cycle uses Prompt A**

Instead of the default "identify all people and objects" Gemini Vision prompt, the perception loop injects the mission's `visionPrompt`. Gemini now returns mission-specific data — posture and fall detection instead of generic bounding boxes.

**Step 3: The extraction map determines what gets stored**

The `extractionMap` tells the storage layer which fields from Gemini's response to put in the `extracted` object. Only mission-relevant data gets stored. Everything else is discarded.

**Step 4: Triggers evaluate against extracted data**

Each trigger condition is a simple expression evaluated against the `extracted` object. When a trigger fires, it sends a Telegram alert (with photo if configured) and stores the event with the frame.

**Step 5: Featherless uses Prompt D to reason over stored data**

Every N seconds, the analyze route pulls recent documents from MongoDB (filtered by mission_id), and sends them to Featherless with the mission's custom system prompt. Featherless reasons about temporal patterns specific to the mission.

---

## Agent Split: 4 Agents Working in Parallel

Each agent owns a completely separate set of files. No overlaps.

```
AGENT 1: Mission Engine (the brain)
  Creates the mission parsing pipeline and prompt generation.
  Files:
    lib/mission-engine.ts
    lib/mission-prompts.ts
    app/api/sentinel/mission/route.ts

AGENT 2: Adaptive Perception + Storage (the eyes and memory)
  Modifies the perception loop to use dynamic prompts and flexible storage.
  Files:
    lib/adaptive-storage.ts
    lib/trigger-evaluator.ts
    app/api/sentinel/perception/route.ts  (MODIFY existing)

AGENT 3: Temporal Intelligence + Featherless (the reasoning brain)
  Builds the temporal analysis layer and Featherless integration.
  Files:
    lib/temporal-queries.ts
    lib/featherless-client.ts
    app/api/sentinel/analyze/route.ts
    app/api/sentinel/chat/route.ts

AGENT 4: Telegram + Frontend (the interface)
  Builds Telegram bot integration and mission UI on the dashboard.
  Files:
    lib/telegram.ts
    lib/telegram-listener.ts  
    app/api/sentinel/telegram/route.ts
    components/MissionInput.tsx
    components/MissionStatus.tsx
    components/ChatInterface.tsx
```

---

# AGENT 1: Mission Engine

## What it builds

The system that takes "watch my grandfather" and produces a complete MissionConfig with 4 custom prompts.

## File: `lib/mission-engine.ts`

```
Purpose: Parse user instructions into structured missions.

Exports:
  createMission(instruction: string) → MissionConfig
  getMission() → MissionConfig | null
  clearMission() → void
  updateMission(instruction: string) → MissionConfig  // modify existing

State:
  activeMission: MissionConfig | null  (module-level variable)

How createMission works:
  1. Send the user's instruction to Gemini with the meta-prompt
     (see "The Gemini Meta-Prompt" below)
  2. Gemini returns a MissionConfig JSON
  3. Validate the config (all required fields present)
  4. Store it in module-level state
  5. Also store in MongoDB 'missions' collection for persistence
  6. Return the config

The Gemini Meta-Prompt (this is the most important prompt in the system):

  "You are SENTINEL's mission architect. The user wants to deploy
  SENTINEL for a specific purpose. Your job is to generate FOUR
  prompts that rewire SENTINEL's entire perception stack.
  
  USER INSTRUCTION: {instruction}
  
  Generate a complete MissionConfig. Be specific and detailed in
  each prompt — they will be used verbatim by downstream systems.
  
  {
    missionName: 'Short descriptive name',
    
    visionPrompt: 'Complete Gemini Vision prompt. Be very specific
      about what to detect, count, track, or flag in each frame.
      MUST include the exact JSON response format you want. Example:
      Return JSON: { field1: type, field2: type, ... }',
    
    extractionFields: ['field1', 'field2', ...],
    // List of field names that will appear in the vision response.
    // These are the fields that get stored in MongoDB.
    
    triggers: [
      {
        id: 'trigger_1',
        description: 'Human readable description',
        field: 'which extracted field to check',
        operator: 'equals | greater_than | less_than | contains | 
                   is_true | is_false | absent_for_minutes',
        value: 'comparison value',
        severity: 'info | warning | critical',
        message: 'What SENTINEL says. Use {field_name} for values.',
        includeFrame: true/false,
        sendTelegram: true/false,
        cooldownSeconds: 60,  // Don't re-trigger within this window
      }
    ],
    
    featherlessSystemPrompt: 'Complete system prompt for temporal
      pattern analysis. Be specific about what patterns matter,
      what anomalies to flag, and what trends to track for this
      particular use case.',
    
    speakBehavior: {
      onDetection: false,  // Narrate every detection?
      onTrigger: true,     // Speak when trigger fires?
      onPattern: false,    // Speak pattern analysis results?
      silent: true,        // Only speak when asked?
    },
    
    analysisIntervalSeconds: 30,  // How often to run Featherless
    
    summarySchedule: {
      enabled: true/false,
      intervalMinutes: 60,  // Send summary every N minutes
      via: 'telegram | voice | both',
    }
  }"

  Include 5-6 examples in the meta-prompt covering different
  mission types (security, care, counting, tracking, retail)
  so Gemini understands the range of possible outputs.
```

## File: `lib/mission-prompts.ts`

```
Purpose: Store the meta-prompt template and example missions.
  Separating this keeps mission-engine.ts clean.

Exports:
  getMissionParsingPrompt(instruction: string) → string
  getExampleMissions() → MissionConfig[]

This file contains:
  1. The full meta-prompt template with {instruction} placeholder
  2. 5-6 hardcoded example MissionConfigs that get included in the
     meta-prompt as few-shot examples for Gemini:
     
     - "Count foot traffic in a hallway"
     - "Watch an elderly person for falls"
     - "Count specific colored objects"
     - "Monitor a parking lot for open spots"  
     - "Security watch — alert on perimeter breach"
     - "Just chat with me about what you see"
```

## File: `app/api/sentinel/mission/route.ts`

```
POST /api/sentinel/mission
  Body: { instruction: "watch my grandfather" }
  
  1. Call createMission(instruction) from mission-engine
  2. Store mission in MongoDB 'missions' collection
  3. Return the full MissionConfig to the frontend
  
  Response: { 
    success: true, 
    mission: MissionConfig,
    message: "Mission created: Grandfather care monitor" 
  }

GET /api/sentinel/mission
  Returns active mission + list of past missions from MongoDB

DELETE /api/sentinel/mission  
  Clears active mission, reverts to default perception

PUT /api/sentinel/mission
  Body: { instruction: "also count how many times he goes to the kitchen" }
  Updates the existing mission by re-parsing with additional context
```

---

# AGENT 2: Adaptive Perception + Storage

## What it builds

The layer that uses the active mission's prompts to change what Gemini looks for and what gets stored.

## File: `lib/adaptive-storage.ts`

```
Purpose: Store mission-relevant data flexibly in MongoDB.

Exports:
  buildDocument(geminiResponse, sensors, mission) → document | null
  shouldStore(geminiResponse, previousResponse, mission) → boolean

How buildDocument works:
  1. Receive the raw Gemini Vision response (JSON object)
  2. If a mission is active:
     → Extract ONLY the fields listed in mission.extractionFields
     → Put them in the 'extracted' object
     → Add minimal 'meta' context (people count, activity level, sensors)
  3. If no mission (default mode):
     → Store the full Gemini response as-is (backward compatible)
  4. Return the document ready for MongoDB insertion

How shouldStore works (change detection):
  1. Compare current extracted data to previous extracted data
  2. If nothing mission-relevant changed → return false (skip storage)
  3. If any extraction field changed → return true (store it)
  4. Always store if: trigger fired, first detection, periodic checkpoint
  
  This prevents storing "grandpa is still standing" 1000 times.
  Only stores: "grandpa went from standing to sitting" (change events).

Change detection logic:
  For each field in mission.extractionFields:
    if current[field] !== previous[field]:
      return true  // Something changed, store it
  
  // Also store on time-based checkpoints (every 60 seconds even if
  // nothing changed, so we have data continuity for Featherless)
  if (secondsSinceLastStore > 60):
    return true
  
  return false  // Nothing relevant changed, skip
```

## File: `lib/trigger-evaluator.ts`

```
Purpose: Check mission trigger conditions against extracted data.

Exports:
  evaluateTriggers(extracted, mission, context) → TriggeredAlert[]

How it works:
  For each trigger in mission.triggers:
    1. Get the field value from extracted data
    2. Apply the operator:
       - equals: extracted[field] === value
       - greater_than: extracted[field] > value
       - less_than: extracted[field] < value
       - contains: extracted[field].includes(value)
       - is_true: extracted[field] === true
       - is_false: extracted[field] === false
       - absent_for_minutes: special — query MongoDB for last time
         this field was truthy, calculate minutes since then
    3. Check cooldown — don't re-trigger if we fired this trigger
       within the last N seconds
    4. If triggered, return alert object with severity, message, etc.

  The 'absent_for_minutes' operator is the tricky one. It handles
  cases like "alert if no movement for 10 minutes." Implementation:
    - Query MongoDB: find the most recent document where
      extracted.moving === true for this mission_id
    - Calculate minutes between that document's timestamp and now
    - If minutes > trigger.value, fire the trigger

Context parameter includes:
  - previousExtracted: last stored document's extracted data
  - minutesSinceLastMovement: pre-calculated from MongoDB
  - minutesSinceLastStore: time since last storage event
  - totalEventsToday: count of today's events for this mission
```

## File: `app/api/sentinel/perception/route.ts` (MODIFY)

```
This is your existing perception route. Agent 2 modifies it to be
mission-aware. The changes are additive — existing behavior is
preserved when no mission is active.

Modified flow:

  async POST(request):
    const perception = await request.json()
    const mission = getMission()  // from mission-engine
    
    // === STEP 1: Dynamic Gemini Vision ===
    // If mission active AND this perception includes a raw frame,
    // re-analyze with the mission's custom visionPrompt.
    //
    // NOTE: The RPi/laptop Python script sends frames to Gemini
    // with the DEFAULT prompt. If a mission is active, we can either:
    //   Option A: Re-analyze the frame server-side with custom prompt
    //   Option B: Send the custom prompt to the Python script
    //
    // Option A is simpler (no changes to Python script):
    
    let extracted = null
    if (mission && perception.frame_full) {
      // Call Gemini Vision AGAIN with the mission-specific prompt
      const missionVision = await analyzeWithMissionPrompt(
        perception.frame_full, 
        mission.visionPrompt
      )
      extracted = extractFields(missionVision, mission.extractionFields)
    }
    
    // === STEP 2: Smart Storage ===
    if (mission) {
      const shouldSave = shouldStore(extracted, previousExtracted, mission)
      if (shouldSave) {
        const doc = buildDocument(extracted, perception.sensors, mission)
        await db.collection('detections').insertOne(doc)
        previousExtracted = extracted
      }
    } else {
      // Default behavior — store everything as before
      await db.collection('detections').insertOne(perception)
    }
    
    // === STEP 3: Trigger Evaluation ===
    if (mission && extracted) {
      const alerts = evaluateTriggers(extracted, mission, context)
      for (const alert of alerts) {
        // Store the alert event
        await db.collection('events').insertOne({
          timestamp: new Date(),
          mission_id: mission.id,
          trigger: alert,
          extracted: extracted,
          frame: alert.includeFrame ? perception.frame_full : null,
        })
        
        // Speak if configured
        if (mission.speakBehavior.onTrigger) {
          await fetch('/api/sentinel/speak', {
            method: 'POST',
            body: JSON.stringify({ text: alert.message, context: 'alert' })
          })
        }
        
        // Telegram if configured
        if (alert.sendTelegram) {
          await fetch('/api/sentinel/telegram', {
            method: 'POST',
            body: JSON.stringify({ 
              text: alert.message, 
              photo: alert.includeFrame ? perception.frame_full : null 
            })
          })
        }
      }
    }
    
    return Response.json({ status: 'ok', stored: true, alerts: alerts?.length || 0 })
```

---

# AGENT 3: Temporal Intelligence + Featherless

## What it builds

The layer that queries MongoDB for historical data and sends it to Featherless for temporal pattern analysis. Also handles the chat/conversational interface.

## File: `lib/temporal-queries.ts`

```
Purpose: All MongoDB aggregation queries for temporal analysis.

Exports:
  getRecentEvents(db, missionId, count) → documents[]
  getHourlySummary(db, missionId, hours) → aggregation result
  getBaselineForDayOfWeek(db, missionId) → baseline stats
  getFieldTimeline(db, missionId, fieldName, hours) → time series
  getMinutesSince(db, missionId, field, value) → number
  getMissionStats(db, missionId) → summary stats

getRecentEvents:
  Simple: last N documents for this mission_id, sorted newest first.
  Projects only: timestamp, extracted, trigger, meta.

getHourlySummary:
  Groups events by hour for the last N hours.
  For each hour: count of events, average of numeric extracted fields.
  
  This requires DYNAMIC aggregation because the extracted fields
  differ per mission. Solution:
  
  // We know the mission's extractionFields, so we can build
  // the $group stage dynamically:
  
  const groupStage = { _id: { hour: { $hour: '$timestamp' } } }
  for (const field of mission.extractionFields) {
    // Try to average numeric fields, count boolean true fields
    groupStage[`avg_${field}`] = { $avg: `$extracted.${field}` }
    groupStage[`sum_${field}`] = { 
      $sum: { $cond: [`$extracted.${field}`, 1, 0] } 
    }
  }
  groupStage['event_count'] = { $sum: 1 }

getBaselineForDayOfWeek:
  Queries analyses collection for past instances of same day-of-week.
  Returns average metrics for comparison ("is today normal?").

getFieldTimeline:
  Returns a time series of a specific extracted field over N hours.
  Useful for charting trends: "show me movement over the last 4 hours"

getMinutesSince:
  Finds the most recent document where extracted[field] === value.
  Returns minutes elapsed since that document's timestamp.
  Critical for "absent_for_minutes" trigger type.
  
  Example: getMinutesSince(db, missionId, "moving", true)
  → Finds last time grandpa was moving, returns minutes since then.

getMissionStats:
  Returns overall stats for a mission:
  total events, duration running, trigger fire count, etc.
```

## File: `lib/featherless-client.ts`

```
Purpose: Clean wrapper for Featherless API calls.

Exports:
  analyzePatterns(recentEvents, hourlySummary, baseline, mission) → analysis
  answerQuestion(question, recentEvents, currentPerception, mission) → answer

analyzePatterns:
  Sends to Featherless with the mission's custom featherlessSystemPrompt.
  
  The user message includes:
    - Recent events (last 20, with extracted data)
    - Hourly summary (aggregated stats)
    - Baseline comparison (is today normal?)
    - Current time and mission duration
  
  Returns structured JSON:
  {
    patterns: [{ description, confidence, severity, reasoning }],
    trend: "description of overall trend",
    anomalies: ["anything unusual"],
    spoken_summary: "30-50 word natural language summary",
    next_prediction: "what might happen next based on the pattern"
  }

answerQuestion:
  Used by the chat route. Sends the user's question to Featherless
  along with mission context and recent data.
  
  Example: User asks "how's grandpa doing?"
  Featherless receives: recent events showing movement patterns,
  current posture, historical baseline.
  Returns: "Your grandfather has been moderately active today. He 
  moved from the bedroom to the kitchen at 8:15am, sat in the living
  room from 9:00 to 10:30, and has been in the kitchen again for the
  last 20 minutes. Activity level is normal compared to his usual 
  Wednesday pattern."
```

## File: `app/api/sentinel/analyze/route.ts`

```
GET /api/sentinel/analyze

  1. Get active mission
  2. Call getRecentEvents(db, mission.id, 20)
  3. Call getHourlySummary(db, mission.id, 4)
  4. Call getBaselineForDayOfWeek(db, mission.id)
  5. Call analyzePatterns(events, summary, baseline, mission)
  6. Store analysis in 'analyses' collection with mission_id
  7. If analysis has significant findings AND mission.summarySchedule:
     → Check if it's time for a scheduled summary
     → If yes, send via Telegram / voice
  8. Return analysis to caller

  The dashboard calls this every N seconds (mission.analysisIntervalSeconds).
  It only runs in mission or scan mode.
```

## File: `app/api/sentinel/chat/route.ts`

```
POST /api/sentinel/chat
  Body: { message: "how's grandpa doing?", source: "dashboard" | "telegram" }

  1. Get active mission
  2. Get current perception (latest frame + sensors)
  3. Get recent events from MongoDB (last 15 for this mission)
  4. Determine intent — is this a question, a new mission, a command?
  
     Send to Gemini:
     "The user said: '{message}'
      Active mission: {mission.missionName or 'none'}
      
      Classify: 
      - question: user wants information
      - new_mission: user is giving new instructions for what to watch
      - update_mission: user wants to modify the current mission  
      - mode_switch: user wants to change modes
      - command: user wants SENTINEL to do something (move, scan, etc)
      
      Return: { intent: '...', confidence: 0.9 }"
  
  5. Based on intent:
  
     question → 
       Call Featherless answerQuestion() with context + recent events.
       Return answer. If source is telegram, send via Telegram.
       If voice enabled, send to ElevenLabs.
     
     new_mission →
       Call createMission(message) from mission-engine.
       Return confirmation. Notify via Telegram if source is telegram.
     
     update_mission →
       Append the new instruction to the existing mission.
       Re-parse with Gemini to get updated MissionConfig.
       Return confirmation.
     
     mode_switch →
       Parse which mode. Call setMode(). Return confirmation.
     
     command →
       Parse what action. Execute (move gimbal, start scan, etc).
       Return confirmation.
```

---

# AGENT 4: Telegram + Frontend

## What it builds

The Telegram bot for remote control and the dashboard UI for missions.

## File: `lib/telegram.ts`

```
Purpose: Send messages and photos to the user via Telegram.

Exports:
  sendText(text: string) → void
  sendPhoto(imageBase64: string, caption: string) → void
  sendAlert(text: string, imageBase64?: string) → void
  sendSummary(missionName, stats, findings) → void

Implementation:
  All functions call the Telegram Bot API:
  https://api.telegram.org/bot{TOKEN}/sendMessage
  https://api.telegram.org/bot{TOKEN}/sendPhoto
  
  Use process.env.TELEGRAM_BOT_TOKEN and process.env.TELEGRAM_CHAT_ID.
  
  sendAlert formats with emoji and markdown:
    "⚠️ *SENTINEL ALERT*\n\n{text}"
  
  sendSummary formats as a report:
    "📊 *SENTINEL Report*\nMission: {name}\n\n{findings}"
  
  sendPhoto converts base64 to a Blob and sends as multipart form data.
```

## File: `lib/telegram-listener.ts`

```
Purpose: Poll for incoming Telegram messages from the user.

Exports:
  startListening(onMessage: callback) → void
  stopListening() → void

Implementation:
  Uses Telegram's getUpdates long-polling API.
  Every 3 seconds, calls:
    GET https://api.telegram.org/bot{TOKEN}/getUpdates?offset={lastId+1}
  
  When a message arrives:
    1. Extract text and sender info
    2. Call the onMessage callback with { text, from, timestamp }
    3. The callback routes to /api/sentinel/chat with source: 'telegram'
    4. The chat route processes and returns a response
    5. Send the response back via sendText()

  This polling loop runs as a setInterval on the server side.
  Start it when the app boots, stop on shutdown.
```

## File: `app/api/sentinel/telegram/route.ts`

```
POST /api/sentinel/telegram
  Body: { text: "alert message", photo?: "base64 string" }
  
  Sends a message (and optional photo) to the user's Telegram.
  Called by the perception route when triggers fire.
  Called by the analyze route for scheduled summaries.
  Called by the chat route to reply to Telegram messages.

GET /api/sentinel/telegram  
  Returns Telegram connection status and recent message history.

PUT /api/sentinel/telegram
  Body: { botToken: "...", chatId: "..." }
  Updates Telegram credentials. Sends a test message to verify.
```

## File: `components/MissionInput.tsx`

```
The main instruction input on the dashboard.

Visual:
  Large text area at top of dashboard.
  Placeholder: "Tell SENTINEL what to watch for..."
  
  Quick-start chips below:
    [Count foot traffic]  [Monitor elderly person]  
    [Track specific objects]  [Security watch]  [Just chat]
  
  Each chip pre-fills the text area with a starter instruction.
  
  Submit button sends POST to /api/sentinel/mission.
  Shows loading state while Gemini parses the instruction.
  On success, shows the parsed mission summary:
    "Mission: Grandfather care monitor
     Watching for: Falls, extended immobility
     Alerts: Telegram with photo
     Analysis: Every 2 minutes"
  
  Also shows a "Connected to Telegram" badge if configured.

Props:
  onMissionCreated: (mission: MissionConfig) => void
```

## File: `components/MissionStatus.tsx`

```
Shows the active mission with live stats.

Visual:
  Card showing mission name, duration, live stats.
  Stats are dynamically generated from the mission's extractionFields.
  
  Polls /api/sentinel/mission/stats every 3 seconds for updates.
  
  Shows:
    - Mission name and how long it's been running
    - Key stats (count, last event, trend)
    - Recent triggers fired
    - Telegram messages sent
    - [Pause] [Edit] [Stop] buttons

Props:
  mission: MissionConfig
  onStop: () => void
  onEdit: (newInstruction: string) => void
```

## File: `components/ChatInterface.tsx`

```
Chat panel for talking to SENTINEL.

Visual:
  Message history (scrollable)
  Text input at bottom
  Microphone button for voice input (Web Speech API)
  
  Messages show:
    - User messages (right-aligned)
    - SENTINEL responses (left-aligned, with SENTINEL avatar)
    - System messages (centered, gray: "Mission created", "Mode switched")
  
  When user submits:
    1. Add user message to history
    2. Show typing indicator
    3. POST to /api/sentinel/chat
    4. Add SENTINEL response to history
    5. If voice enabled, play audio response
  
  Voice input:
    const recognition = new webkitSpeechRecognition()
    recognition.continuous = false
    recognition.lang = 'en-US'
    recognition.onresult = (e) => {
      const text = e.results[0][0].transcript
      handleSubmit(text)
    }
    // Microphone button toggles recognition.start() / .stop()

Props:
  onMissionCreated: (mission) => void  // if chat creates a mission
  onModeChanged: (mode) => void        // if chat switches mode
```

---

## Dependency Graph (what depends on what)

```
Agent 1 (mission-engine) depends on: nothing
  → Produces: MissionConfig objects
  → Other agents import getMission() from lib/mission-engine

Agent 2 (perception) depends on: Agent 1's MissionConfig type
  → But can start work immediately using a hardcoded test mission
  → Wire to real mission-engine later

Agent 3 (temporal + featherless) depends on: MongoDB having data
  → Can start immediately with mock data or default-mode detections
  → Wire to mission-specific queries later

Agent 4 (telegram + frontend) depends on: API routes existing
  → Can build UI components immediately with mock data
  → Wire to real API routes as agents 1-3 complete them
```

This means ALL FOUR agents can start immediately. They use mock/test data until the real integrations are ready, then wire together.

---

## Integration Order (after all agents finish their files)

```
Step 1: Agent 1's mission route creates a MissionConfig
Step 2: Agent 2's perception route reads it and uses custom prompts
Step 3: Agent 2 stores mission-filtered data in MongoDB
Step 4: Agent 3's analyze route reads that data and sends to Featherless
Step 5: Agent 3's chat route answers questions using the data
Step 6: Agent 4's Telegram sends alerts and receives commands
Step 7: Agent 4's frontend displays everything
```

To test the integration, create a mission via the dashboard:
"Count how many people walk past this camera"
Then verify:
  - Gemini Vision prompt changed (check server logs)
  - MongoDB documents have mission-specific extracted fields
  - Featherless analysis references foot traffic patterns
  - Telegram receives updates
  - Dashboard shows live mission stats

---

## What Each Agent Tells Claude Code

### Agent 1 prompt:
"Create lib/mission-engine.ts and lib/mission-prompts.ts and app/api/sentinel/mission/route.ts. The mission engine takes a plain English user instruction, sends it to Gemini (using process.env.GEMINI_API_KEY) to parse into a structured MissionConfig object containing: a custom visionPrompt for Gemini Vision, extractionFields array, trigger conditions array, a featherlessSystemPrompt, speakBehavior settings, and analysisIntervalSeconds. Store the active mission in a module-level variable. The mission-prompts file contains the meta-prompt template with few-shot examples. The route handles POST (create), GET (read), PUT (update), DELETE (clear). Store missions in MongoDB 'missions' collection using the existing mongodb.ts connection."

### Agent 2 prompt:
"Create lib/adaptive-storage.ts and lib/trigger-evaluator.ts. Modify app/api/sentinel/perception/route.ts. The adaptive storage module exports buildDocument(geminiResponse, sensors, mission) that extracts only mission-relevant fields into a flexible 'extracted' object, and shouldStore(current, previous, mission) that returns false if nothing mission-relevant changed. The trigger evaluator exports evaluateTriggers(extracted, mission, context) that checks each trigger condition using operators (equals, greater_than, is_true, absent_for_minutes etc) with cooldown support. Modify the perception route to: check for active mission, use mission's visionPrompt when calling Gemini, use adaptive storage for flexible documents, evaluate triggers and fire alerts. When triggers fire with sendTelegram: true, POST to /api/sentinel/telegram. Preserve existing default behavior when no mission is active."

### Agent 3 prompt:
"Create lib/temporal-queries.ts and lib/featherless-client.ts and app/api/sentinel/analyze/route.ts and app/api/sentinel/chat/route.ts. The temporal queries module exports MongoDB aggregation functions: getRecentEvents, getHourlySummary (group by hour with dynamic field averaging based on mission.extractionFields), getBaselineForDayOfWeek, getMinutesSince (find last document where a field equals a value, return minutes elapsed). The featherless client exports analyzePatterns (sends recent events + summary + baseline to Featherless at https://api.featherless.ai/v1/chat/completions using model meta-llama/Meta-Llama-3.1-70B-Instruct with the mission's custom featherlessSystemPrompt) and answerQuestion (for chat). The analyze route calls temporal queries then featherless, stores in 'analyses' collection. The chat route determines user intent via Gemini (question/new_mission/command), then routes accordingly."

### Agent 4 prompt:
"Create lib/telegram.ts and lib/telegram-listener.ts and app/api/sentinel/telegram/route.ts and components/MissionInput.tsx and components/MissionStatus.tsx and components/ChatInterface.tsx. The telegram module exports sendText, sendPhoto, sendAlert (with emoji formatting) using the Telegram Bot API with process.env.TELEGRAM_BOT_TOKEN and process.env.TELEGRAM_CHAT_ID. The listener polls getUpdates every 3 seconds and routes incoming messages to /api/sentinel/chat with source:'telegram'. The telegram route handles POST (send message/photo) and GET (status). MissionInput is a React component with a large text input, quick-start chips, and loading state that POSTs to /api/sentinel/mission. MissionStatus shows live stats polling from the backend. ChatInterface shows message history with text input and optional Web Speech API voice input, POSTing to /api/sentinel/chat. Use Tailwind CSS for styling. Use React hooks (useState, useEffect, useRef)."
