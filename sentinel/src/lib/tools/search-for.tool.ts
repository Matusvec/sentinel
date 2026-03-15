import type { ToolDefinition } from './types';
import { analyzeFrame } from '@/lib/gemini';

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:5000';

// Servo speed ~133 deg/sec (2 deg per 15ms step on Arduino)
const SERVO_SPEED_DPS = 133;

// Scan positions: sweep left to right, then tilt up/down
// Tilt range: 45 (max up) to 135 (max down), 90 = straight
const SCAN_POSITIONS = [
  { pan: 180, tilt: 90 },  // far left
  { pan: 135, tilt: 90 },  // left
  { pan: 90, tilt: 90 },   // center
  { pan: 45, tilt: 90 },   // right
  { pan: 0, tilt: 90 },    // far right
  { pan: 90, tilt: 45 },   // center up
  { pan: 90, tilt: 135 },  // center down
];

async function moveGimbal(pan: number, tilt: number): Promise<void> {
  await fetch(`${PYTHON_URL}/gimbal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pan, tilt }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

async function getFrame(): Promise<string | null> {
  try {
    const res = await fetch(`${PYTHON_URL}/frame_b64`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) { const d = await res.json(); return d.frame_b64 || null; }
  } catch { /* ignore */ }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Calculate settle time based on how far the gimbal needs to travel. */
function settleTime(fromPan: number, fromTilt: number, toPan: number, toTilt: number): number {
  const maxDelta = Math.max(Math.abs(toPan - fromPan), Math.abs(toTilt - fromTilt));
  const travelMs = Math.ceil((maxDelta / SERVO_SPEED_DPS) * 1000);
  // Travel time + 800ms for frame to stabilize after movement stops
  return travelMs + 800;
}

export const searchForTool: ToolDefinition = {
  name: 'search_for',
  description: 'Scan the room systematically looking for something specific. Moves the gimbal to different positions, analyzes each view with Gemini Vision, and stops when the target is found. Use for "look around until you find...", "search for...", "find the...". Returns what was found and where.',
  parameters: [
    { name: 'target', type: 'string', description: 'What to search for (e.g., "text", "a person", "a red object", "a door")', required: true },
  ],
  category: 'analysis',
  async execute(params) {
    const target = params.target as string;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { success: false, error: 'No Gemini API key' };

    let prevPan = 90, prevTilt = 90;
    for (const pos of SCAN_POSITIONS) {
      // Move gimbal to scan position and wait for it to arrive
      await moveGimbal(pos.pan, pos.tilt);
      await sleep(settleTime(prevPan, prevTilt, pos.pan, pos.tilt));
      prevPan = pos.pan;
      prevTilt = pos.tilt;

      // Get a fresh frame from this position
      const frame = await getFrame();
      if (!frame) continue;

      // Ask Gemini if the target is visible
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: frame } },
                  { text: `Is "${target}" visible in this camera frame? Respond in JSON only: {"found": true/false, "description": "what you see related to the search target", "x": 0.0-1.0, "y": 0.0-1.0} where x,y is the center position if found.` },
                ],
              }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
            }),
            signal: AbortSignal.timeout(8000),
          }
        );

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;

        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        if (parsed.found) {
          // Found it — start tracking to keep it centered
          if (parsed.x !== undefined && parsed.y !== undefined) {
            await fetch(`${PYTHON_URL}/track`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'start',
                target_desc: target,
              }),
              signal: AbortSignal.timeout(3000),
            }).catch(() => {});
          }

          return {
            success: true,
            data: {
              found: true,
              target,
              description: parsed.description,
              position: { pan: pos.pan, tilt: pos.tilt },
              frame_position: { x: parsed.x, y: parsed.y },
              message: `Found "${target}" at pan=${pos.pan}, tilt=${pos.tilt}: ${parsed.description}`,
            },
          };
        }
      } catch { continue; }
    }

    // Not found after full sweep
    await moveGimbal(90, 70); // return to center
    return {
      success: true,
      data: {
        found: false,
        target,
        message: `Could not find "${target}" after scanning the room.`,
      },
    };
  },
};
