/**
 * SENTINEL Mission System — Custom Intelligence Configuration.
 *
 * A Mission reconfigures the entire perception pipeline from a single
 * plain-English instruction. Gemini parses the instruction into:
 *   - A custom vision prompt (what to look for in each frame)
 *   - Storage fields (what extra data to persist to MongoDB)
 *   - Trigger conditions (when to alert / speak)
 *   - A Featherless analysis prompt (temporal pattern focus)
 *
 * The active mission is held in-memory on the Next.js server process.
 */

export interface MissionTrigger {
  type: 'people_count_exceeds' | 'person_entered' | 'lingering_detected' |
        'object_detected' | 'distance_below' | 'perimeter_breach' |
        'activity_level' | 'custom_condition' | 'fall_detected';
  threshold?: number;
  searchTerm?: string;
  durationSeconds?: number;
  /** Free-form description Gemini can evaluate per-cycle. */
  customDescription?: string;
}

export interface Mission {
  id: string;
  name: string;
  instruction: string;
  visionPrompt: string;
  storageFields: string[];
  triggers: MissionTrigger[];
  featherlessPrompt: string;
  speakOnTrigger: boolean;
  speakTemplate: string;
  createdAt: Date;
  status: 'active' | 'paused' | 'completed';
}

// ── In-memory state ──────────────────────────────────────────

let activeMission: Mission | null = null;

/** Default vision prompt used when no mission is active. */
export const DEFAULT_VISION_PROMPT = `Analyze this camera frame from an autonomous monitoring system. Identify all people and notable objects.

For each person, provide approximate bounding box as normalized coordinates (0-1).

Respond ONLY in JSON (no markdown):
{
  "people": [{"id": 1, "bbox": {"x": 0.3, "y": 0.2, "width": 0.15, "height": 0.5}, "distance": "near", "activity": "standing", "description": "short description", "facing": "toward_camera"}],
  "objects": [{"label": "laptop", "bbox": {"x": 0.5, "y": 0.6, "width": 0.1, "height": 0.08}}],
  "environment": {"crowd_density": "sparse", "activity_level": "moderate", "scene_description": "one sentence"},
  "motion_detected": false
}`;

export function getActiveMission(): Mission | null {
  return activeMission;
}

export function setActiveMission(mission: Mission | null): void {
  activeMission = mission;
}

export function clearMission(): void {
  activeMission = null;
}

/**
 * Returns the vision prompt to use for Gemini frame analysis.
 * If a mission is active, returns its custom prompt; otherwise the default.
 */
export function getVisionPrompt(): string {
  return activeMission?.visionPrompt || DEFAULT_VISION_PROMPT;
}

/**
 * Returns the Featherless analysis prompt for the current mission,
 * or null if no mission is active (use default Featherless behavior).
 */
export function getFeatherlessPrompt(): string | null {
  return activeMission?.featherlessPrompt || null;
}

// NOTE: evaluateMissionTriggers() and parseMissionInstruction() were removed.
// Trigger evaluation is now handled by lib/trigger-evaluator.ts
// Mission parsing is now handled by lib/mission-engine.ts (with few-shot examples)
