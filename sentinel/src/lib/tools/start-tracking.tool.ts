import type { ToolDefinition } from './types';

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:5000';

// Gimbal limits (must match Arduino: pan 0-180, tilt 45-135)
const PAN_MIN = 0;
const PAN_MAX = 180;
const TILT_MIN = 45;
const TILT_MAX = 135;

/** Get a frame from Python. */
async function getFrame(): Promise<string | null> {
  try {
    const res = await fetch(`${PYTHON_URL}/frame_b64`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      return data.frame_b64 || null;
    }
  } catch { /* ignore */ }
  return null;
}

/** Ask Gemini to locate something in the frame, returns normalized {x, y} center. */
async function locateWithGemini(frame: string, target: string): Promise<{ x: number; y: number; label: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: frame } },
              { text: `Locate "${target}" in this camera frame. Return the CENTER position as normalized coordinates (0-1, where 0,0 is top-left and 1,1 is bottom-right).

Respond ONLY in JSON: {"found": true/false, "x": 0.0-1.0, "y": 0.0-1.0, "label": "what you found"}
If not found, return {"found": false, "x": 0.5, "y": 0.5, "label": "not found"}` },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
        }),
        signal: AbortSignal.timeout(8000),
      }
    );

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.found) return null;
    return { x: parsed.x, y: parsed.y, label: parsed.label };
  } catch {
    return null;
  }
}

export const startTrackingTool: ToolDefinition = {
  name: 'start_tracking',
  description: 'Enable continuous person tracking — the gimbal will follow the target as they move. For one-shot pointing at objects, use move_gimbal instead. Use for "track me", "follow me", "keep the camera on me". Use action="stop" to stop tracking.',
  parameters: [
    { name: 'action', type: 'string', description: 'Start or stop tracking', required: false, enum: ['start', 'stop'], default: 'start' },
    { name: 'person_id', type: 'number', description: 'Person ID to track (1 = closest person)', required: false, default: 1 },
    { name: 'target', type: 'string', description: 'For non-person targets (e.g., "my hand"), Gemini will locate it first, then point the gimbal', required: false },
  ],
  category: 'hardware',
  async execute(params, context) {
    const action = (params.action as string) || 'start';
    const targetDesc = params.target as string | undefined;
    const targetId = (params.person_id as number) || 1;

    // Stop tracking
    if (action === 'stop') {
      try {
        await fetch(`${PYTHON_URL}/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          signal: AbortSignal.timeout(3000),
        });
        return { success: true, data: { message: 'Tracking stopped' } };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Failed to stop tracking' };
      }
    }

    let centerX = 0.5;
    let centerY = 0.5;
    let targetLabel = 'unknown';

    if (targetDesc) {
      // ── Gemini-based: locate ANY target in the frame ──
      const frame = context.frameB64 || await getFrame();
      if (!frame) {
        return { success: false, error: 'No camera frame available' };
      }

      const location = await locateWithGemini(frame, targetDesc);
      if (!location) {
        return { success: false, error: `Could not find "${targetDesc}" in the camera frame` };
      }
      centerX = location.x;
      centerY = location.y;
      targetLabel = location.label;
    } else {
      // ── CV-based: track a detected person ──
      let persons = ((context.perception?.local_cv as Record<string, unknown>)?.persons as Array<Record<string, unknown>>) ?? [];

      // Fetch fresh CV data if cache is empty
      if (persons.length === 0) {
        const frame = await getFrame();
        if (frame) {
          try {
            const analyzeRes = await fetch(`${PYTHON_URL}/analyze`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ frame }),
              signal: AbortSignal.timeout(3000),
            });
            if (analyzeRes.ok) {
              const data = await analyzeRes.json();
              persons = data.local_cv?.persons ?? [];
            }
          } catch { /* ignore */ }
        }
      }

      const person = persons.find(p => p.id === targetId) ?? persons[0];
      if (!person?.center) {
        return { success: false, error: 'No person detected in the camera frame' };
      }

      const center = person.center as { x: number; y: number };
      centerX = center.x;
      centerY = center.y;
      targetLabel = (person.name as string) || `Person ${targetId}`;
    }

    // Get current gimbal position from sensor data
    const sensorData = context.perception?.sensors as Record<string, unknown> | undefined;
    const currentPan = (sensorData?.p as number) ?? 90;
    const currentTilt = (sensorData?.t as number) ?? 70;

    // Calculate offset from frame center (0.5, 0.5)
    // If target is right of center (x > 0.5), decrease pan (pan 0 = right)
    // If target is below center (y > 0.5), increase tilt (tilt 135 = down)
    const offsetX = centerX - 0.5; // positive = right in frame
    const offsetY = centerY - 0.5; // positive = down in frame

    // Scale: 0.5 offset = ~45 degrees of servo movement
    const panAdjust = -offsetX * 90; // negative because pan 0 = right
    const tiltAdjust = offsetY * 60;

    const pan = Math.round(currentPan + panAdjust);
    const tilt = Math.round(currentTilt + tiltAdjust);
    const clampedPan = Math.max(PAN_MIN, Math.min(PAN_MAX, pan));
    const clampedTilt = Math.max(TILT_MIN, Math.min(TILT_MAX, tilt));

    try {
      // Initial point at target
      await fetch(`${PYTHON_URL}/gimbal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pan: clampedPan, tilt: clampedTilt }),
        signal: AbortSignal.timeout(3000),
      });

      // Enable continuous tracking in Python's perception loop
      await fetch(`${PYTHON_URL}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          target_id: targetId,
          target_desc: targetDesc || null,
        }),
        signal: AbortSignal.timeout(3000),
      });

      return {
        success: true,
        data: {
          target: targetLabel,
          tracking: true,
          message: `Now continuously tracking ${targetLabel}. Say "stop tracking" to stop.`,
        },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Hardware unreachable' };
    }
  },
};
