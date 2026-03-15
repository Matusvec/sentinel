/**
 * SENTINEL Adaptive Storage — Mission-aware document building and dedup.
 *
 * When a mission is active, instead of storing the full Gemini response +
 * all sensor readings every cycle (~2KB), we extract ONLY the fields the
 * mission cares about into a lean ~200 byte document. The `shouldStore`
 * filter prevents writing when nothing mission-relevant changed.
 */

import type { VisionAnalysis } from '@/lib/gemini';
import type { MissionConfig } from '@/lib/mission-engine';
import {
  getNetFlow,
  getTimeInZone,
  getMinutesSinceLastMovement,
  getUniqueCount,
  getTrackedPersons,
} from '@/lib/person-tracker';

// ── Types ────────────────────────────────────────────────────

export interface SensorSnapshot {
  d?: { f: number; l: number; r: number };
  ir?: [number, number];
  s?: number;
  p?: number;
  t?: number;
}

export interface AdaptiveDocument {
  mission_id: string;
  mission_name: string;
  timestamp: Date;
  /** Mission-specific extracted values keyed by field name. */
  extracted: Record<string, unknown>;
  /** Minimal always-present context for dashboard/analysis. */
  context: {
    people_count: number;
    activity_level: string;
    crowd_density: string;
    scene_description: string;
  };
  /** Slim sensor snapshot. */
  sensors: {
    front_distance: number;
    left_distance: number;
    right_distance: number;
    ir: [number, number];
    sound: number;
  } | null;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Build a lean storage document from Gemini vision + sensor data,
 * extracting only the fields listed in `mission.extractionFields`.
 */
export function buildDocument(
  vision: VisionAnalysis | null,
  sensors: SensorSnapshot | undefined,
  mission: MissionConfig,
  localCvPersonCount?: number,
  localCvPersons?: Array<Record<string, unknown>>
): AdaptiveDocument {
  // Derive a flat pool of all available values from vision + sensors
  const pool = deriveValuePool(vision, sensors, localCvPersons);

  // Override people_count with local CV if Gemini didn't run
  // (local CV is always available, Gemini is throttled)
  if (localCvPersonCount !== undefined && !vision) {
    pool.people_count = localCvPersonCount;
    pool.person_count = localCvPersonCount;
    pool.person_visible = localCvPersonCount > 0;
  }

  // Extract only mission-relevant fields
  const extracted: Record<string, unknown> = {};
  for (const field of mission.extractionFields) {
    extracted[field] = pool[field] ?? null;
  }

  return {
    mission_id: mission.id,
    mission_name: mission.missionName,
    timestamp: new Date(),
    extracted,
    context: {
      people_count: (pool.people_count as number) ?? 0,
      activity_level: (pool.activity_level as string) ?? 'unknown',
      crowd_density: (pool.crowd_density as string) ?? 'unknown',
      scene_description: (pool.scene_description as string) ?? '',
    },
    sensors: sensors
      ? {
          front_distance: sensors.d?.f ?? 999,
          left_distance: sensors.d?.l ?? 999,
          right_distance: sensors.d?.r ?? 999,
          ir: sensors.ir ?? [0, 0],
          sound: sensors.s ?? 0,
        }
      : null,
  };
}

/**
 * Returns false if no mission-relevant extracted fields changed
 * since the last stored document, preventing duplicate writes.
 */
export function shouldStore(
  current: AdaptiveDocument,
  previous: AdaptiveDocument | null
): boolean {
  if (!previous) return true;

  const currEx = current.extracted;
  const prevEx = previous.extracted;

  for (const key of Object.keys(currEx)) {
    const c = currEx[key];
    const p = prevEx[key];

    // Fast path for primitives
    if (c !== p) {
      // Deep compare for arrays/objects
      if (typeof c === 'object' || typeof p === 'object') {
        if (JSON.stringify(c) !== JSON.stringify(p)) return true;
      } else {
        return true;
      }
    }
  }

  return false;
}

// ── Internal ─────────────────────────────────────────────────

/**
 * Builds a flat key→value pool from the Gemini VisionAnalysis and
 * sensor data. Mission extraction fields are matched against these
 * keys using exact match first, then heuristic name patterns.
 */
function deriveValuePool(
  vision: VisionAnalysis | null,
  sensors: SensorSnapshot | undefined,
  localCvPersons?: Array<Record<string, unknown>>
): Record<string, unknown> {
  const people = vision?.people ?? [];
  const objects = vision?.objects ?? [];
  const env = vision?.environment;

  const pool: Record<string, unknown> = {
    // ── People ──
    people_count: people.length,
    person_count: people.length,
    person_visible: people.length > 0,
    activities: people.map((p) => p.activity),
    descriptions: people.map((p) => p.description),
    interesting_people: people.filter((p) => p.interesting),
    interesting_people_count: people.filter((p) => p.interesting).length,
    posture: people[0]?.activity ?? 'none',
    facing: people[0]?.facing ?? 'unknown',
    is_moving: vision?.motion_detected ?? false,
    moving: vision?.motion_detected ?? false,

    // ── Objects ──
    object_labels: objects.map((o) => o.label),
    object_count: objects.length,
    interesting_objects: objects.filter((o) => o.interesting),
    interesting_objects_count: objects.filter((o) => o.interesting).length,

    // ── Environment ──
    crowd_density: env?.crowd_density ?? 'unknown',
    activity_level: env?.activity_level ?? 'unknown',
    scene_description: env?.scene_description ?? '',
    lighting: env?.lighting ?? 'unknown',
    motion_detected: vision?.motion_detected ?? false,
    motion_direction: vision?.motion_direction ?? null,

    // ── Sensors ──
    front_distance: sensors?.d?.f ?? 999,
    left_distance: sensors?.d?.l ?? 999,
    right_distance: sensors?.d?.r ?? 999,
    distance: sensors?.d?.f ?? 999,
    ir_beams: sensors?.ir ?? [0, 0],
    ir_breach: (sensors?.ir?.[0] === 1 || sensors?.ir?.[1] === 1) ?? false,
    sound_level: sensors?.s ?? 0,
    pan: sensors?.p ?? 90,
    tilt: sensors?.t ?? 90,

    // ── Fall detection (local CV + Gemini) ──
    fall_detected: localCvPersons?.some((p) => p.fall_detected === true) ?? false,
    fall_confidence: localCvPersons
      ? Math.max(0, ...localCvPersons.map((p) => Number(p.fall_confidence) || 0))
      : 0,
    on_floor:
      localCvPersons?.some((p) => p.fall_detected === true) ||
      people.some(
        (p) =>
          p.activity === 'lying_floor' ||
          p.description?.toLowerCase().includes('floor') ||
          p.description?.toLowerCase().includes('fallen')
      ),

    // ── Direction tracking (common for traffic) ──
    people_entering: people.filter(
      (p) =>
        p.activity?.includes('toward') ||
        p.facing === 'toward_camera'
    ).length,
    people_exiting: people.filter(
      (p) =>
        p.activity?.includes('away') ||
        p.facing === 'away_from_camera'
    ).length,
    total_in_frame: people.length,
    net_flow: getNetFlow(),

    // ── Behavior flags ──
    intruder_detected: people.some((p) => p.interesting),
    intruder_count: people.filter((p) => p.interesting).length,
    has_fast_movement: people.some((p) => p.activity === 'fast' || p.activity === 'running'),
    threat_level: people.some((p) => p.interesting) ? 'elevated' : 'normal',
  };

  // ── Dynamic count fields ──
  // Handle patterns like "red_backpack_count" → count objects with matching labels
  // These are added lazily when requested via extractionFields
  const objectLabelsLower = objects.map((o) => o.label.toLowerCase());
  const labelCounts: Record<string, number> = {};
  for (const label of objectLabelsLower) {
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }

  // Add per-label counts (e.g., "backpack_red" → backpack_red_count: 2)
  for (const [label, count] of Object.entries(labelCounts)) {
    pool[`${label}_count`] = count;
  }

  // Total counts by base label (e.g., "backpack" matches "backpack_red", "backpack_blue")
  const baseCounts: Record<string, number> = {};
  for (const label of objectLabelsLower) {
    const base = label.split('_')[0];
    baseCounts[base] = (baseCounts[base] ?? 0) + 1;
  }
  for (const [base, count] of Object.entries(baseCounts)) {
    pool[`total_${base}_count`] = count;
    pool[`${base}_count`] = pool[`${base}_count`] ?? count;
  }

  // Carrier descriptions for tracked objects
  pool.carrier_descriptions = people
    .filter((p) => p.interesting)
    .map((p) => p.description);

  // Behavior assessment (aggregated from descriptions)
  pool.behavior_assessment = people.map((p) => p.description).join('; ');

  // Direction distribution
  const dirs: Record<string, number> = {};
  for (const p of people) {
    const dir = p.facing || 'unknown';
    dirs[dir] = (dirs[dir] ?? 0) + 1;
  }
  pool.direction_distribution = dirs;

  // Backpack colors (common mission field)
  pool.backpack_colors = objects
    .filter((o) => o.label.toLowerCase().includes('backpack'))
    .map((o) => {
      const parts = o.label.split('_');
      return parts.length > 1 ? parts.slice(1).join('_') : 'unknown';
    });

  // Time in zone — seconds the longest-present person has been visible
  const longestPerson = getTrackedPersons().sort((a, b) => a.firstSeen - b.firstSeen)[0];
  pool.time_in_zone = longestPerson ? getTimeInZone(longestPerson.id) : 0;

  // Confidence (from first person's interesting flag as proxy)
  pool.confidence = people[0]?.interesting ? 0.9 : 0.5;

  // Minutes since last movement — from person tracker
  pool.minutes_since_last_movement = getMinutesSinceLastMovement();
  pool.unique_person_count = getUniqueCount();

  return pool;
}
