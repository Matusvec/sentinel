export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedPerson {
  id: number;
  bbox: BBox;
  distance: 'near' | 'mid' | 'far';
  activity: string;
  description: string;
  facing: string;
  interesting?: boolean;
}

export interface DetectedObject {
  label: string;
  bbox: BBox;
  description?: string;
  interesting?: boolean;
}

export interface EnvironmentInfo {
  lighting?: string;
  crowd_density: string;
  activity_level: string;
  scene_description: string;
}

export interface VisionAnalysis {
  people: DetectedPerson[];
  objects: DetectedObject[];
  environment: EnvironmentInfo;
  motion_detected: boolean;
  motion_direction?: string | null;
}

const VISION_PROMPT = `Analyze this camera frame from an autonomous monitoring system. Identify all people and notable objects.

For each person, provide approximate bounding box as normalized coordinates (0-1).

Respond ONLY in JSON (no markdown):
{
  "people": [{"id": 1, "bbox": {"x": 0.3, "y": 0.2, "width": 0.15, "height": 0.5}, "distance": "near", "activity": "standing", "description": "short description", "facing": "toward_camera"}],
  "objects": [{"label": "laptop", "bbox": {"x": 0.5, "y": 0.6, "width": 0.1, "height": 0.08}}],
  "environment": {"crowd_density": "sparse", "activity_level": "moderate", "scene_description": "one sentence"},
  "motion_detected": false
}`;

/**
 * Analyze a camera frame using Gemini Vision API.
 */
export async function analyzeFrame(imageBase64: string): Promise<VisionAnalysis | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set');
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
              { text: VISION_PROMPT },
            ],
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1500,
          },
        }),
      }
    );

    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (error) {
    console.error('Gemini Vision error:', error);
    return null;
  }
}

/**
 * Use Gemini to plan agent actions based on a trigger event.
 */
export async function planAgentResponse(
  trigger: string,
  perception: Record<string, unknown>
): Promise<{ reasoning: string; steps: Array<{ tool: string; params: Record<string, unknown> }> }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const vision = perception.vision as VisionAnalysis | undefined;
  const sensors = perception.sensors as Record<string, unknown> | undefined;

  const prompt = `You are SENTINEL's autonomous decision engine. A trigger event occurred.

TRIGGER: ${trigger}

CURRENT PERCEPTION:
- People detected: ${vision?.people?.length || 0}
- Objects: ${JSON.stringify(vision?.objects?.map(o => o.label) || [])}
- Distances: front=${(sensors?.d as Record<string, unknown>)?.f}cm, left=${(sensors?.d as Record<string, unknown>)?.l}cm, right=${(sensors?.d as Record<string, unknown>)?.r}cm
- Perimeter beams: ${JSON.stringify((sensors as Record<string, unknown>)?.ir)}
- Sound level: ${(sensors as Record<string, unknown>)?.s}
- Gimbal position: pan=${(sensors as Record<string, unknown>)?.p}, tilt=${(sensors as Record<string, unknown>)?.t}

${vision?.people?.length ? `Closest person: ${JSON.stringify(vision.people[0])}` : 'No people detected'}

AVAILABLE TOOLS:
- move_gimbal: { pan: 0-180, tilt: 45-135 } — Rotate camera
- set_alert: { color: "green"|"yellow"|"red", buzzer: true|false } — Set status
- analyze_patterns: {} — Deep pattern analysis via Featherless.AI
- speak: { text: "...", context: "detection"|"alert"|"summary" } — Speak via ElevenLabs
- query_memory: { timerange: "5m"|"15m"|"1h" } — Query detection history
- start_tracking: { target_id: N } — Lock camera on a person

Decide what SENTINEL should do. Respond in JSON:
{
  "reasoning": "Why SENTINEL should take these actions",
  "steps": [
    { "tool": "tool_name", "params": { ... } }
  ]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
