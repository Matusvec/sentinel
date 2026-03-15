import type { ToolDefinition } from './types';

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:5000';

// Servo limits (must match Arduino constraints)
// Pan: 0-180, Tilt: 45-135
const PAN_MIN = 0;     // far right
const PAN_MAX = 180;   // far left
const TILT_UP = 45;    // max up (Arduino clamps to 45)
const TILT_MID = 90;   // straight ahead
const TILT_DOWN = 135;  // max down (Arduino clamps to 135)
const PAN_STEP = 30;    // degrees per horizontal step

// Tilt angles to check at each pan position (top to bottom)
const TILT_LEVELS = [TILT_UP, TILT_MID, TILT_DOWN];

/**
 * Build sweep positions: column-by-column.
 * For each pan increment (0 → 180 in PAN_STEP), cycle through
 * all tilt levels (up, middle, down) before moving to the next pan.
 */
function buildSweepPositions(): Array<{ pan: number; tilt: number }> {
  const positions: Array<{ pan: number; tilt: number }> = [];
  for (let pan = PAN_MIN; pan <= PAN_MAX; pan += PAN_STEP) {
    for (const tilt of TILT_LEVELS) {
      positions.push({ pan, tilt });
    }
  }
  return positions;
}

async function moveGimbal(pan: number, tilt: number): Promise<boolean> {
  try {
    const res = await fetch(`${PYTHON_URL}/gimbal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pan, tilt }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    console.log(`[full_sweep] MOVE pan=${pan} tilt=${tilt} → ${JSON.stringify(data)}`);
    return true;
  } catch (e) {
    console.error(`[full_sweep] MOVE pan=${pan} tilt=${tilt} FAILED:`, e);
    return false;
  }
}

async function getFrame(): Promise<string | null> {
  try {
    const res = await fetch(`${PYTHON_URL}/frame_b64`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      return d.frame_b64 || null;
    }
  } catch { /* ignore */ }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const fullSweepTool: ToolDefinition = {
  name: 'full_sweep',
  description: 'Perform a comprehensive sweep of the entire visible area. The gimbal steps through its full pan range (0-180) in 30-degree increments, and at each pan position cycles through three tilt angles (up 30, middle 70, down 110) before moving to the next pan step. This covers every direction the camera can see. At each position, Gemini Vision analyzes the frame. If a search target is specified, stops when found. Otherwise completes the full sweep and returns a summary of everything observed. Use when you want to thoroughly search the entire room or need a complete picture of the surroundings.',
  parameters: [
    { name: 'target', type: 'string', description: 'Optional: what to search for. If set, stops when found. If omitted, does a full sweep and summarizes everything.', required: false },
  ],
  category: 'hardware',
  async execute(params) {
    const target = (params.target as string) || null;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { success: false, error: 'No Gemini API key' };

    const positions = buildSweepPositions();
    console.log(`[full_sweep] Starting sweep: ${positions.length} positions`, positions.map(p => `${p.pan}/${p.tilt}`).join(', '));
    const observations: Array<{
      pan: number;
      tilt: number;
      description: string;
    }> = [];

    let prevPan = -1;
    let prevTilt = -1;
    for (const pos of positions) {
      const moved = await moveGimbal(pos.pan, pos.tilt);
      if (!moved) continue;

      // Wait for servo to physically reach position — larger moves need more time
      const panDelta = Math.abs(pos.pan - prevPan);
      const tiltDelta = Math.abs(pos.tilt - prevTilt);
      const maxDelta = Math.max(panDelta, tiltDelta);
      // Servo moves ~2 deg per 15ms = ~133 deg/s. Add buffer for frame refresh.
      const waitMs = Math.max(1500, Math.ceil(maxDelta / 133 * 1000) + 1000);
      await sleep(waitMs);
      prevPan = pos.pan;
      prevTilt = pos.tilt;

      const frame = await getFrame();
      if (!frame) continue;

      try {
        const prompt = target
          ? `Look at this camera frame carefully. Is "${target}" visible? Respond in JSON only: {"found": true/false, "description": "brief description of what you see at this position"}`
          : `Briefly describe what you see in this camera frame in 1-2 sentences. Respond in JSON only: {"description": "what you see"}`;

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: frame } },
                  { text: prompt },
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

        observations.push({
          pan: pos.pan,
          tilt: pos.tilt,
          description: parsed.description || '',
        });

        // If searching for a target and found it, stop and lock on
        if (target && parsed.found) {
          await fetch(`${PYTHON_URL}/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start', target_desc: target }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});

          return {
            success: true,
            data: {
              found: true,
              target,
              description: parsed.description,
              position: { pan: pos.pan, tilt: pos.tilt },
              positions_checked: observations.length,
              total_positions: positions.length,
              message: `Found "${target}" at pan=${pos.pan}, tilt=${pos.tilt}: ${parsed.description}`,
            },
          };
        }
      } catch { continue; }
    }

    // Return to center after sweep
    await moveGimbal(90, 70);

    if (target) {
      return {
        success: true,
        data: {
          found: false,
          target,
          positions_checked: observations.length,
          observations,
          message: `Could not find "${target}" after checking ${observations.length} positions across the full sweep.`,
        },
      };
    }

    // Summarize the full sweep using Gemini
    let summary = observations.map(o =>
      `Pan ${o.pan}, Tilt ${o.tilt}: ${o.description}`
    ).join('\n');

    try {
      const summaryRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `You are a security camera AI. You just completed a full 360-degree sweep of a room and observed the following at each position:\n\n${summary}\n\nGive a concise 2-4 sentence summary of everything you observed across the entire sweep. Mention any people, notable objects, or areas of interest. Plain text only.`,
              }],
            }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      const summaryData = await summaryRes.json();
      const summaryText = summaryData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (summaryText) summary = summaryText.trim();
    } catch { /* keep raw observations as summary */ }

    return {
      success: true,
      data: {
        found: false,
        positions_checked: observations.length,
        summary,
        observations,
        message: `Full sweep complete. Checked ${observations.length} positions. ${summary}`,
      },
    };
  },
};
