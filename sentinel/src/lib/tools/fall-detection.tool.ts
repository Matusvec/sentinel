import type { ToolDefinition } from './types';
import { setMissionDirectly, clearMission } from '@/lib/mission-engine';
import type { MissionConfig } from '@/lib/mission-engine';
import { setMode } from '@/lib/mode';

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:5000';

// Servo speed ~133 deg/sec (2 deg per 15ms step on Arduino)
const SERVO_SPEED_DPS = 133;

/** Scan positions: sweep left to right (same as search-for.tool.ts). */
const SCAN_POSITIONS = [
  { pan: 180, tilt: 90 },
  { pan: 135, tilt: 90 },
  { pan: 90, tilt: 90 },
  { pan: 45, tilt: 90 },
  { pan: 0, tilt: 90 },
  { pan: 90, tilt: 45 },
  { pan: 90, tilt: 135 },
];

async function moveGimbal(pan: number, tilt: number): Promise<void> {
  await fetch(`${PYTHON_URL}/gimbal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pan, tilt }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/** Calculate settle time based on how far the gimbal needs to travel. */
function settleTime(fromPan: number, fromTilt: number, toPan: number, toTilt: number): number {
  const maxDelta = Math.max(Math.abs(toPan - fromPan), Math.abs(toTilt - fromTilt));
  const travelMs = Math.ceil((maxDelta / SERVO_SPEED_DPS) * 1000);
  return travelMs + 800;
}

async function getAnalysis(): Promise<Record<string, unknown> | null> {
  try {
    const frameRes = await fetch(`${PYTHON_URL}/frame_b64`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!frameRes.ok) return null;
    const { frame_b64 } = await frameRes.json();
    if (!frame_b64) return null;

    const analyzeRes = await fetch(`${PYTHON_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: frame_b64 }),
      signal: AbortSignal.timeout(3000),
    });
    if (!analyzeRes.ok) return null;
    return await analyzeRes.json();
  } catch {
    return null;
  }
}

async function setLed(color: string): Promise<void> {
  await fetch(`${PYTHON_URL}/led`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const fallDetectionTool: ToolDefinition = {
  name: 'fall_detection',
  description:
    'Start or stop real-time fall detection monitoring. Scans the room for a person, starts tracking them, and creates a mission that alerts immediately if they fall. Use for "watch for falls", "monitor my grandfather", "fall detection", "elderly monitoring".',
  parameters: [
    {
      name: 'action',
      type: 'string',
      description: 'Start or stop fall detection monitoring',
      required: false,
      enum: ['start', 'stop'],
      default: 'start',
    },
    {
      name: 'target_name',
      type: 'string',
      description:
        'Name for alert messages (e.g., "my grandfather", "the patient")',
      required: false,
    },
  ],
  category: 'system',

  async execute(params) {
    const action = (params.action as string) || 'start';
    const targetName = (params.target_name as string) || 'the monitored person';

    // ── Stop flow ──
    if (action === 'stop') {
      try {
        // Stop tracking
        await fetch(`${PYTHON_URL}/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});

        // Clear mission
        await clearMission();
        setMode('chat');

        // Reset LED to green
        await setLed('green');

        return {
          success: true,
          data: { message: 'Fall detection monitoring stopped.' },
        };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : 'Failed to stop fall detection',
        };
      }
    }

    // ── Start flow ──

    // 1. Scan room for a person using local CV (no Gemini needed)
    let foundPersonId: number | null = null;
    let foundAtPosition: { pan: number; tilt: number } | null = null;

    let prevPan = 90, prevTilt = 90;
    for (const pos of SCAN_POSITIONS) {
      await moveGimbal(pos.pan, pos.tilt);
      await sleep(settleTime(prevPan, prevTilt, pos.pan, pos.tilt));
      prevPan = pos.pan;
      prevTilt = pos.tilt;

      const analysis = await getAnalysis();
      if (!analysis) continue;

      const localCv = analysis.local_cv as Record<string, unknown> | undefined;
      const persons = localCv?.persons as Array<Record<string, unknown>> | undefined;

      if (persons && persons.length > 0) {
        foundPersonId = (persons[0].id as number) ?? 1;
        foundAtPosition = pos;
        break;
      }
    }

    if (!foundPersonId || !foundAtPosition) {
      // Return to center
      await moveGimbal(90, 90);
      return {
        success: false,
        error:
          'No person found in the room. Make sure someone is visible to the camera.',
      };
    }

    // 2. Start tracking the person
    try {
      await fetch(`${PYTHON_URL}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          target_id: foundPersonId,
          target_desc: targetName,
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Non-fatal: fall detection still works without tracking
    }

    // 3. Build mission config programmatically (no Gemini call)
    const missionId = `fall-detect-${Date.now()}`;
    const config: MissionConfig = {
      id: missionId,
      missionName: 'Fall Detection',
      instruction: `Monitor ${targetName} for falls and alert immediately if detected.`,
      visionPrompt: `Analyze this camera frame. Focus on the person's posture and position.
Is the person standing, sitting, lying on the floor, or in an unusual position?
Look for signs of a fall: person on the ground, collapsed, slumped over.

Respond ONLY in JSON (no markdown):
{
  "people": [{"id": 1, "bbox": {"x": 0.3, "y": 0.2, "width": 0.15, "height": 0.5}, "activity": "standing/sitting/lying_floor/fallen", "description": "posture description", "facing": "toward_camera", "interesting": false}],
  "objects": [],
  "environment": {"crowd_density": "sparse", "activity_level": "low", "scene_description": "one sentence"},
  "motion_detected": false
}`,
      extractionFields: [
        'person_visible',
        'fall_detected',
        'fall_confidence',
        'posture',
        'on_floor',
        'is_moving',
      ],
      triggers: [
        {
          type: 'fall_detected',
          durationSeconds: 5,
        },
      ],
      featherlessSystemPrompt: `You are monitoring ${targetName} for falls. Analyze the temporal pattern of posture and movement data. Flag any concerning trends: prolonged stillness after movement, sudden position changes to floor level, or extended time without movement.`,
      speakBehavior: {
        onTrigger: true,
        onPattern: false,
        silent: false,
        template: `Alert! ${targetName} may have fallen! Immediate attention needed.`,
      },
      analysisIntervalSeconds: 10,
      createdAt: new Date(),
      status: 'active',
    };

    // 4. Set mission directly (no Gemini parsing)
    await setMissionDirectly(config);

    // 5. Set yellow LED (monitoring active)
    await setLed('yellow');

    // 6. Set mode to monitor
    setMode('monitor');

    return {
      success: true,
      data: {
        message: `Fall detection active for ${targetName}. Monitoring at pan=${foundAtPosition.pan}, tilt=${foundAtPosition.tilt}. I'll alert immediately via voice and Telegram if a fall is detected.`,
        mission_id: missionId,
        person_id: foundPersonId,
        position: foundAtPosition,
      },
    };
  },
};
