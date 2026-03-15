/**
 * SENTINEL Trigger Evaluator — Checks mission trigger conditions against
 * extracted perception data and fires alerts with cooldown protection.
 *
 * Condition operators used internally:
 *   - greater_than:  people_count > threshold, distance < threshold
 *   - is_true:       boolean flags (person_visible, on_floor, ir_breach)
 *   - equals:        string matching (object labels contain searchTerm)
 *   - absent_for_minutes: no movement detected for N seconds
 *
 * Stateful: tracks cooldowns (don't re-fire same trigger within N seconds)
 * and movement timestamps (for lingering/absence detection).
 */

import type { MissionTrigger } from '@/lib/mission';
import type { MissionConfig } from '@/lib/mission-engine';
import { getMinutesSinceLastMovement as getTrackerMovement } from '@/lib/person-tracker';

// ── Types ────────────────────────────────────────────────────

export interface FiredTrigger {
  trigger: MissionTrigger;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  /** Whether this trigger should be forwarded to Telegram. */
  sendTelegram: boolean;
}

// ── Stateful tracking (module-level, lives in server process) ─

/** Last time each trigger key fired (for cooldown). */
const lastFiredAt = new Map<string, number>();

/** Last time movement was detected (for lingering/absence). */
let lastMovementAt = Date.now();

/** Default cooldown: 30 seconds between re-fires of same trigger. */
const DEFAULT_COOLDOWN_MS = 30_000;

// ── Public API ───────────────────────────────────────────────

/**
 * Evaluate all mission triggers against the extracted perception data.
 * Returns an array of triggers that fired this cycle (empty if none).
 *
 * @param extracted - Flat key-value object from adaptive storage buildDocument
 * @param mission   - Active MissionConfig with triggers and speakBehavior
 */
export function evaluateTriggers(
  extracted: Record<string, unknown>,
  mission: MissionConfig
): FiredTrigger[] {
  if (mission.status !== 'active' || mission.triggers.length === 0) {
    return [];
  }

  const now = Date.now();
  const fired: FiredTrigger[] = [];

  // Update local movement tracker (as backup)
  if (extracted.is_moving || extracted.motion_detected) {
    lastMovementAt = now;
  }

  // Use the person-tracker's movement time as primary source (updated at 2Hz),
  // fall back to our local tracker (only updated when trigger evaluation runs)
  const trackerMinutes = getTrackerMovement();
  const localMinutes = (now - lastMovementAt) / 60_000;
  const minutesSinceMovement = Math.min(trackerMinutes, localMinutes);

  // Unpack commonly used values
  const peopleCount = asNumber(extracted.people_count);
  const frontDistance = asNumber(extracted.front_distance ?? extracted.distance, 999);
  const irBreach = asBool(extracted.ir_breach);
  const objectLabels = asStringArray(extracted.object_labels);

  for (const trigger of mission.triggers) {
    // ── Cooldown check ──
    const triggerKey = buildKey(mission.id, trigger);
    const lastTime = lastFiredAt.get(triggerKey) ?? 0;
    const cooldown = (trigger.durationSeconds ?? 30) * 1000;
    const effectiveCooldown = Math.max(cooldown, DEFAULT_COOLDOWN_MS);
    if (now - lastTime < effectiveCooldown) continue;

    // ── Evaluate condition ──
    let met = false;
    let severity: 'info' | 'warning' | 'critical' = 'info';

    switch (trigger.type) {
      case 'people_count_exceeds':
        // greater_than: people_count > threshold
        met = peopleCount > (trigger.threshold ?? 0);
        severity = 'warning';
        break;

      case 'person_entered':
        // is_true: at least one person visible
        met = peopleCount > 0;
        severity = 'info';
        break;

      case 'lingering_detected':
        // absent_for_minutes: no movement for durationSeconds
        met = minutesSinceMovement >= ((trigger.durationSeconds ?? 60) / 60);
        severity = met ? 'warning' : 'info';
        break;

      case 'object_detected': {
        // equals: searchTerm found in object labels
        const term = (trigger.searchTerm ?? '').toLowerCase();
        if (term) {
          met = objectLabels.some((label) => label.includes(term));
        }
        severity = 'info';
        break;
      }

      case 'distance_below':
        // greater_than (inverted): distance < threshold
        met = frontDistance < (trigger.threshold ?? 100);
        severity = 'warning';
        break;

      case 'perimeter_breach':
        // is_true: IR beam broken
        met = irBreach;
        severity = 'critical';
        break;

      case 'activity_level':
        // is_true: fast/running movement detected
        met = asBool(extracted.has_fast_movement);
        severity = 'warning';
        break;

      case 'custom_condition': {
        // Heuristic: check if Gemini flagged anything as "interesting"
        // The custom visionPrompt instructs Gemini to set interesting=true
        // on people/objects matching the custom condition.
        const interestingCount = asNumber(extracted.interesting_people_count);
        const onFloor = asBool(extracted.on_floor);

        // Check description-based patterns if a customDescription exists
        if (trigger.customDescription) {
          const desc = trigger.customDescription.toLowerCase();
          if (desc.includes('floor') || desc.includes('fall')) {
            met = onFloor;
          } else if (desc.includes('no movement') || desc.includes('stationary')) {
            met = minutesSinceMovement >= ((trigger.durationSeconds ?? 600) / 60);
          } else {
            // Generic: any interesting detection
            met = interestingCount > 0;
          }
        } else {
          met = interestingCount > 0;
        }
        severity = 'critical';
        break;
      }
    }

    if (!met) continue;

    // ── Build message from speak template ──
    const message = mission.speakBehavior.template
      .replace('{count}', String(peopleCount))
      .replace('{people}', String(peopleCount))
      .replace('{distance}', String(Math.round(frontDistance)))
      .replace('{minutes}', String(Math.round(minutesSinceMovement)));

    // Record cooldown
    lastFiredAt.set(triggerKey, now);

    // Telegram for critical/warning triggers
    // Send ALL mission triggers to Telegram — user asked to be alerted
    const sendTelegram = true;

    fired.push({ trigger, severity, message, sendTelegram });
  }

  return fired;
}

/**
 * Reset all cooldown and movement state.
 * Call when a mission is cleared to avoid stale state on the next mission.
 */
export function resetTriggerState(): void {
  lastFiredAt.clear();
  lastMovementAt = Date.now();
}

// ── Helpers ──────────────────────────────────────────────────

function buildKey(missionId: string, trigger: MissionTrigger): string {
  return `${missionId}:${trigger.type}:${trigger.threshold ?? ''}:${trigger.searchTerm ?? ''}:${trigger.customDescription ?? ''}`;
}

function asNumber(val: unknown, fallback = 0): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function asBool(val: unknown): boolean {
  return val === true || val === 1 || val === 'true';
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((v) => String(v).toLowerCase());
  return [];
}
