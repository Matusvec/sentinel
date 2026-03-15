/**
 * SENTINEL Unified Reasoning Engine
 *
 * Single AI reasoning function shared by chat and perception events.
 * Builds the prompt dynamically from the tool registry, calls Gemini,
 * parses tool calls, and executes them.
 */

import { getDb } from '@/lib/mongodb';
import { getMission } from '@/lib/mission-engine';
import { getMode } from '@/lib/mode';
import { latestPerception, latestFrameB64 } from '@/app/api/sentinel/perception/route';
import {
  getUniqueCount,
  getVisibleCount,
  getNetFlow,
  getEnteringCount,
  getExitingCount,
  getMinutesSinceLastMovement,
} from '@/lib/person-tracker';
import {
  getToolDescriptionsForPrompt,
  executeTool,
  type ToolContext,
  type ToolResult,
} from '@/lib/tools';

// ── Types ────────────────────────────────────────────────────

export interface ReasoningInput {
  type: 'user_message' | 'perception_event';
  message?: string;
  source?: 'dashboard' | 'telegram';
  perception?: Record<string, unknown>;
  trigger?: string;
}

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
}

export interface ReasoningOutput {
  shouldAct: boolean;
  reasoning: string;
  responseText: string;
  toolCalls: ToolCall[];
  toolResults: Array<{ tool: string; result: ToolResult }>;
  audioBase64?: string | null;
}

// ── Throttle for perception events ───────────────────────────

let lastPerceptionReasoning = 0;
const PERCEPTION_THROTTLE_MS = 5000;

export function shouldRunPerceptionReasoning(): boolean {
  const now = Date.now();
  if (now - lastPerceptionReasoning < PERCEPTION_THROTTLE_MS) return false;
  lastPerceptionReasoning = now;
  return true;
}

// ── Main reasoning function ──────────────────────────────────

export async function reason(input: ReasoningInput): Promise<ReasoningOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      shouldAct: false,
      reasoning: 'No Gemini API key',
      responseText: 'I need a Gemini API key to reason.',
      toolCalls: [],
      toolResults: [],
    };
  }

  // Build context
  const db = await getDb();
  const mission = await getMission();
  const mode = getMode();
  const perception = input.perception ?? latestPerception;

  const toolContext: ToolContext = {
    perception: perception ?? null,
    frameB64: latestFrameB64,
    mission,
    mode: mode as ToolContext['mode'],
    db,
    trackerStats: {
      unique: getUniqueCount(),
      visible: getVisibleCount(),
      netFlow: getNetFlow(),
      entering: getEnteringCount(),
      exiting: getExitingCount(),
      minutesSinceMovement: getMinutesSinceLastMovement(),
    },
  };

  // Build observation context
  const localCv = perception?.local_cv as Record<string, unknown> | undefined;
  const visionData = perception?.vision as Record<string, unknown> | undefined;
  const missionVision = perception?.mission_vision as Record<string, unknown> | undefined;
  const sensors = perception?.sensors as Record<string, unknown> | undefined;
  const peopleCount = (localCv?.person_count as number) ?? 0;
  const sceneDesc = (missionVision?.environment as Record<string, unknown>)?.scene_description
    ?? (visionData?.environment as Record<string, unknown>)?.scene_description ?? '';

  // Get known face names from current frame
  const persons = (localCv?.persons as Array<Record<string, unknown>>) ?? [];
  const knownNames = persons.filter(p => p.name).map(p => `${p.name} (${Math.round((p.name_confidence as number) * 100)}%)`);
  const unknownCount = persons.filter(p => !p.name).length;

  // Describe each person briefly
  const personDescriptions = persons.map((p, i) => {
    const name = p.name ? `${p.name}` : `Unknown person ${i + 1}`;
    return `  - ${name}: ${p.activity}, speed=${p.speed}px/s`;
  });

  // Query context for user messages: chat history, events, known faces
  let recentEventsStr = '';
  let knownFacesStr = '';
  let recentRecognitionsStr = '';
  let chatHistoryStr = '';
  if (input.type === 'user_message') {
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const [recentEvents, knownFaces, recentRecognitions, chatHistory] = await Promise.all([
        db.collection('events')
          .find({ timestamp: { $gte: fiveMinAgo } })
          .sort({ timestamp: -1 })
          .limit(5)
          .toArray(),
        db.collection('known_faces')
          .find({}, { projection: { name: 1, _id: 0 } })
          .toArray(),
        db.collection('events')
          .find({ event_type: 'face_recognized', timestamp: { $gte: fiveMinAgo } })
          .sort({ timestamp: -1 })
          .limit(5)
          .toArray(),
        db.collection('chat_messages')
          .find({})
          .sort({ timestamp: -1 })
          .limit(15)
          .toArray(),
      ]);
      if (recentEvents.length > 0) {
        recentEventsStr = `RECENT EVENTS (last 5 min):\n${recentEvents.map(e => `  - [${e.event_type}] ${e.description}`).join('\n')}`;
      }
      if (knownFaces.length > 0) {
        knownFacesStr = `REGISTERED FACES (people I can identify): ${knownFaces.map(f => f.name).join(', ')}`;
      }
      if (recentRecognitions.length > 0) {
        recentRecognitionsStr = `RECENT RECOGNITIONS:\n${recentRecognitions.map(r => `  - ${r.description}`).join('\n')}`;
      }
      if (chatHistory.length > 0) {
        const lines = chatHistory.reverse().map(m => {
          const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour12: true, timeZone: 'America/Los_Angeles' });
          const role = m.role === 'user' ? 'USER' : 'SENTINEL';
          return `  [${role} ${time}] ${m.text}`;
        });
        chatHistoryStr = `CONVERSATION HISTORY:\n${lines.join('\n')}`;
      }
    } catch { /* non-critical */ }
  }

  const localTime = new Date().toLocaleTimeString('en-US', { hour12: true, timeZone: 'America/Los_Angeles' });

  // Get frame early — needed for both context text and Gemini vision input
  let frameForPrompt = latestFrameB64;
  if (input.type === 'user_message') {
    try {
      const pythonUrl = process.env.PYTHON_URL || 'http://localhost:5000';
      const res = await fetch(`${pythonUrl}/frame_b64`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        if (data.frame_b64) frameForPrompt = data.frame_b64;
      }
    } catch { /* non-critical — use cached frame */ }
  }

  const contextLines = [
    `CURRENT TIME: ${localTime} (Pacific)`,
    `MODE: ${mode}`,
    mission ? `ACTIVE MISSION: "${mission.missionName}" — ${mission.instruction}` : 'No active mission.',
    `PEOPLE: ${peopleCount} visible, ${toolContext.trackerStats.unique} unique this session, net flow ${toolContext.trackerStats.netFlow}`,
    knownNames.length > 0 ? `IDENTIFIED IN FRAME: ${knownNames.join(', ')}` : '',
    unknownCount > 0 ? `UNIDENTIFIED: ${unknownCount} unknown person(s) in frame` : '',
    personDescriptions.length > 0 ? `PERSON DETAILS:\n${personDescriptions.join('\n')}` : '',
    sensors ? `SENSORS: front=${(sensors.d as Record<string, unknown>)?.f}cm, IR=${JSON.stringify(sensors.ir)}, sound=${sensors.s}, GIMBAL: pan=${sensors.p} tilt=${sensors.t} (pan 0=right, 180=left, 90=center | tilt 45=max up, 135=max down, 90=straight)` : '',
    sceneDesc ? `SCENE: ${sceneDesc}` : '',
    knownFacesStr,
    recentRecognitionsStr,
    recentEventsStr,
    chatHistoryStr,
    frameForPrompt
      ? '(Live camera frame attached — use it for visual questions)'
      : '(No camera frame attached right now — but you CAN still use describe_scene, search_for, or full_sweep tools which grab their own live frames. Do NOT refuse visual requests just because no frame is attached here.)',
  ].filter(Boolean).join('\n');

  // Build the prompt
  const toolDescriptions = getToolDescriptionsForPrompt();

  // Mission mode enforcement
  const missionEnforcement = mission
    ? `\nMISSION MODE ACTIVE: Mission "${mission.missionName}" (${mission.instruction}).
MISSION RULES:
- Stay focused on this mission. Answer questions about the mission or current observations.
- If the user says "stop mission", "end mission", "clear mission", "cancel mission", or anything about stopping/ending the mission: IMMEDIATELY call the clear_mission tool (NOT set_mode — clear_mission handles both). Do NOT tell them to say it again — just do it.
- For off-topic chat, briefly redirect: "I'm focused on [mission]. Say 'stop mission' to chat freely."`
    : '\nNo mission active. You can chat freely. Answer ANY question the user asks — general knowledge, opinions, advice, whatever. You are a helpful AI assistant that also happens to have a camera and sensors.';

  const systemPrompt = `You are SENTINEL, an autonomous AI perception station with a camera, sensors, and physical actuators. You can SEE, THINK, and ACT.${missionEnforcement}

YOUR CURRENT STATE:
${contextLines}

YOUR AVAILABLE TOOLS:
${toolDescriptions}

RESPONSE FORMAT — respond ONLY in JSON (no markdown, no asterisks, no bullet points):
{
  "should_act": boolean,
  "reasoning": "1-2 sentences explaining your decision",
  "response_text": "Natural language response (conversational, first-person as SENTINEL). Use plain text only — NO markdown, NO asterisks, NO bullet points. Write in natural sentences.",
  "tool_calls": [
    { "tool": "tool_name", "params": { ... } }
  ]
}

GUIDELINES:
- You have full autonomy to choose which tools to use based on the situation
- For "who is there?" questions: check the IDENTIFIED IN FRAME and PERSON DETAILS sections. If a person is identified by name, say their name. If not identified, say you see an unknown person and describe them using the camera frame. If no one is visible, say the room is empty.
- For "what do you see?" questions: describe the scene using both your SCENE data and the camera frame if attached. Mention people, objects, activities.
- For history/summary questions ("what happened?", "who was here?", "give me a summary"): use query_database with collection="all_activity". This gives you a pre-summarized view with people seen, notable events, and stats — much better than raw event logs.
- For specific queries ("show me chat history", "what events happened?"): use query_database with the specific collection.
- For commands: use the appropriate tool(s) and confirm what you did
- For "watch for X and alert me" / "text me if Y happens": use create_mission with a clear instruction like "watch for [X] and alert via telegram with photo when detected". The mission system will automatically send Telegram alerts with photos when triggers fire.
- For missions: use create_mission to reconfigure your perception pipeline. Missions automatically monitor the camera and send alerts — you don't need to poll manually.
- You can chain multiple tools in one response (e.g., speak + set_alert + send_telegram)
- tool_calls can be empty if no action is needed
- When you don't know something, use a tool to find out (query_database, describe_scene, get_tracker_stats)
- When using describe_scene, ALWAYS pass the user's specific question as the "focus" parameter (e.g., if user asks "how many flags?", set focus to "count the flags in the frame"). Never call describe_scene without a focus.
- ALWAYS be specific about identities — say names when you know them, say "unknown person" when you don't
- ALWAYS be helpful, proactive, and concise
- BE SMART with tool chaining: if one tool needs info from another, call them together. For example, if asked to "track me", call both describe_scene (to confirm someone is there) AND start_tracking. If asked to "scan and report", call scan_room AND describe_scene.
- For tracking/following requests: use start_tracking. It will automatically find the person and point the gimbal at them.
- For scanning: use scan_room to sweep, then describe_scene to report what you see.
- For gimbal movement: only call move_gimbal ONCE. Calculate the final position from current SENSORS data (p=pan, t=tilt). "center the camera" = pan 90, tilt 90. Never call move_gimbal multiple times in one response.
- For thorough searching: use full_sweep to systematically scan every direction. It steps through all pan angles and at each one checks up/middle/down tilt positions.`;

  let userContent: string;
  if (input.type === 'user_message') {
    userContent = `The user says: "${input.message}"
${input.source === 'telegram' ? '(Message received via Telegram — do NOT use the send_telegram tool to reply, your response_text will be sent automatically. You CAN use send_telegram with attach_photo=true if the user asks for a photo. You have ALL the same tools available as the dashboard — describe_scene, query_database, create_mission, etc.)' : ''}

Instructions:
- If they ask WHO is there: first check IDENTIFIED IN FRAME for recognized names. For unknown people, use describe_scene to look at the camera and describe them in detail. If they ask "who is this person" or "do you know them", check the known_faces collection with query_database to see if they match anyone registered.
- If they ask WHAT is in the room: use describe_scene with the specific question as focus. Be precise — count items, name colors, describe positions.
- If they ask about past events or history: use query_database with collection="all_activity" for summaries, or specific collections for detailed data. Cross-reference — if they ask "who was here at 3pm", query events for face_recognized entries around that time.
- If they ask about a specific person ("when was Matus last seen?"): query the events collection filtered by face_recognized events, look for that name.
- If they ask what you can do: list your tools and capabilities.
- THINK before answering. If one tool's result isn't enough, call another. Chain tools: describe_scene → query_database → get_tracker_stats. Use multiple tools when needed to give a complete answer.
- Always answer based on what you ACTUALLY see and what the data shows, not generic responses.`;
  } else {
    userContent = `New perception data received. Trigger: ${input.trigger ?? 'periodic'}
Local CV: ${JSON.stringify(localCv)}
${input.trigger ? `\nThis was flagged because: ${input.trigger}` : ''}

You receive perception data every few seconds. Only act (should_act: true) when something MEANINGFUL happens — a state transition, threshold crossing, anomaly, or mission-relevant event. Most frames need no action.`;
  }

  // Build Gemini request parts
  const parts: Record<string, unknown>[] = [];
  if (frameForPrompt && input.type === 'user_message') {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: frameForPrompt } });
  }
  parts.push({ text: `${systemPrompt}\n\n${userContent}` });

  // Call Gemini
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
      }),
    }
  );

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini reasoning');

  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  const output: ReasoningOutput = {
    shouldAct: parsed.should_act ?? false,
    reasoning: parsed.reasoning ?? '',
    responseText: parsed.response_text ?? '',
    toolCalls: parsed.tool_calls ?? [],
    toolResults: [],
  };

  // Execute tool calls, then do a SECOND Gemini call with the results
  if (output.toolCalls.length > 0) {
    const results = await Promise.all(
      output.toolCalls.map(async (tc: ToolCall) => ({
        tool: tc.tool,
        result: await executeTool(tc.tool, tc.params ?? {}, toolContext),
      }))
    );
    output.toolResults = results;

    // ── Second pass: feed tool results back to Gemini for a real answer ──
    // Only for user messages (perception events don't need a polished response)
    if (input.type === 'user_message') {
      try {
        const toolResultsSummary = results.map(r => {
          const data = r.result.success ? JSON.stringify(r.result.data).slice(0, 2000) : `ERROR: ${r.result.error}`;
          return `[${r.tool}]: ${data}`;
        }).join('\n');

        const followUpParts: Record<string, unknown>[] = [];
        if (latestFrameB64) {
          followUpParts.push({ inlineData: { mimeType: 'image/jpeg', data: latestFrameB64 } });
        }
        followUpParts.push({
          text: `You are SENTINEL. The user asked: "${input.message}"

You called the following tools and got these results:
${toolResultsSummary}

Now give a final, helpful response to the user based on these tool results. Rules:
- Use plain text only — NO markdown, NO asterisks, NO bullet points
- Be specific — include numbers, names, and timestamps
- SUMMARIZE patterns instead of listing every event (e.g., "Matus was seen 5 times in the last 5 minutes" not listing each sighting)
- Group similar events together
- Focus on what's interesting or important, skip repetitive entries
- If asked about history, give a narrative summary, not a raw event log
- CROSS-REFERENCE data: if describe_scene sees a person and query_database has face recognition events, connect them ("I see someone who matches Matus based on recent recognition events")
- Be smart: combine information from multiple tool results to give a complete picture
${input.source === 'telegram' ? '- Keep it concise for Telegram (2-3 sentences max).' : ''}

Respond with ONLY the response text (plain text, no JSON, no markdown).`,
        });

        const followUpRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: followUpParts }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
            }),
          }
        );

        const followUpData = await followUpRes.json();
        const followUpText = followUpData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (followUpText) {
          output.responseText = followUpText.replace(/```/g, '').trim();
        }
      } catch (err) {
        console.error('[reasoning] Follow-up call failed:', err);
        // Keep the original response_text as fallback
      }
    }

    // Extract audio from speak tool if present
    const speakResult = results.find(r => r.tool === 'speak');
    if (speakResult?.result.success) {
      output.audioBase64 = (speakResult.result.data as Record<string, unknown>)?.audio_base64 as string | null;
    }
  }

  // Log decision to MongoDB for the reasoning log UI
  if (output.shouldAct && output.toolCalls.length > 0) {
    db.collection('agent_decisions').insertOne({
      timestamp: new Date(),
      trigger: input.type === 'user_message' ? `user:${input.message?.slice(0, 50)}` : input.trigger,
      plan: {
        reasoning: output.reasoning,
        steps: output.toolCalls,
      },
      results: output.toolResults,
      perception_snapshot: {
        people_count: peopleCount,
        mode,
        mission: mission?.missionName ?? null,
      },
    }).catch(console.error);
  }

  return output;
}
