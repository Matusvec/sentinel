/**
 * SENTINEL Temporal Analysis — Periodic Featherless reasoning with MongoDB context.
 *
 * Called from the perception route's 2Hz heartbeat. Internally throttled to
 * run every `analysisIntervalSeconds` (from the active mission, default 30s).
 * Queries MongoDB for historical observations, builds a temporal context
 * string, and sends it to Featherless alongside the current perception.
 */

import { getDb } from '@/lib/mongodb';
import { getMission } from '@/lib/mission-engine';
import { analyzePatterns } from '@/lib/featherless';
import { sendAlert } from '@/lib/telegram';
import {
  getUniqueCount,
  getNetFlow,
  getVisibleCount,
  getEnteringCount,
  getExitingCount,
  getMinutesSinceLastMovement,
} from '@/lib/person-tracker';

// ── Throttle state ───────────────────────────────────────────

let lastAnalysisTime = 0;
const lastAlertSent = new Map<string, number>(); // cooldown per alert type

// ── Public API ───────────────────────────────────────────────

/**
 * Run temporal Featherless analysis if enough time has passed.
 * Safe to call at 2Hz — internally throttled.
 */
/** Minimum interval to avoid calling getMission() too often when no mission is active. */
const MIN_THROTTLE_MS = 15_000;

export async function runTemporalAnalysis(
  perception: Record<string, unknown>
): Promise<void> {
  const now = Date.now();
  // Fast exit: don't even check mission if minimum interval hasn't passed
  if (now - lastAnalysisTime < MIN_THROTTLE_MS) return;

  const mission = await getMission();
  if (!mission) return;

  const intervalMs = Math.max((mission.analysisIntervalSeconds || 30) * 1000, MIN_THROTTLE_MS);
  if (now - lastAnalysisTime < intervalMs) return;
  lastAnalysisTime = now;

  try {
    const temporalContext = await buildTemporalContext(mission.missionName);

    const result = await analyzePatterns(perception, 'periodic_analysis', temporalContext);
    if (!result) return;

    // Store analysis result in MongoDB
    const db = await getDb();
    await db.collection('analysis_results').insertOne({
      timestamp: new Date(),
      mission_id: mission.id,
      mission_name: mission.missionName,
      result,
    });

    // Speak if mission config says to
    if (mission.speakBehavior.onPattern && result.spoken_summary) {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      fetch(`${baseUrl}/api/sentinel/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: result.spoken_summary,
          context: result.narration_context || 'summary',
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(console.error);
    }

    // Send alert-level patterns to Telegram (with cooldown to prevent spam)
    const alertPatterns = result.patterns_detected?.filter(
      p => p.severity === 'alert'
    );
    if (alertPatterns?.length > 0) {
      const alertKey = alertPatterns.map(p => p.type).sort().join(',');
      const lastAlert = lastAlertSent.get(alertKey) ?? 0;
      if (Date.now() - lastAlert > 120_000) { // 2 minute cooldown per alert type
        lastAlertSent.set(alertKey, Date.now());
        const alertMsg = alertPatterns
          .map(p => `${p.type}: ${p.description}`)
          .join('\n');
        await sendAlert(`Pattern detected:\n${alertMsg}`);
      }
    }

    // Store as event for the timeline
    if (result.patterns_detected?.length > 0) {
      await db.collection('events').insertOne({
        timestamp: new Date(),
        event_type: 'temporal_analysis',
        severity: result.situation_assessment?.overall_risk === 'high' ? 'alert' : 'info',
        description: result.spoken_summary || 'Temporal pattern analysis completed.',
      });
    }
  } catch (err) {
    console.error('[temporal-analysis] Error:', err);
  }
}

// ── Context Builder ──────────────────────────────────────────

async function buildTemporalContext(missionName: string): Promise<string> {
  const db = await getDb();
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Run all 4 queries in parallel — they're independent
  const [recentDetections, hourlyStats, recentEvents, lastAnalysis] = await Promise.all([
    db.collection('detections')
      .find({ timestamp: { $gte: fiveMinAgo } })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray(),

    db.collection('detections').aggregate([
      { $match: { timestamp: { $gte: oneHourAgo } } },
      {
        $group: {
          _id: {
            $dateTrunc: { date: '$timestamp', unit: 'minute', binSize: 5 },
          },
          avg_people: {
            $avg: {
              $ifNull: [
                '$context.people_count',
                { $ifNull: ['$local_cv.person_count', 0] },
              ],
            },
          },
          max_people: {
            $max: {
              $ifNull: [
                '$context.people_count',
                { $ifNull: ['$local_cv.person_count', 0] },
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 12 },
    ]).toArray(),

    db.collection('events')
      .find({ timestamp: { $gte: fiveMinAgo } })
      .sort({ timestamp: -1 })
      .limit(5)
      .toArray(),

    // Filter by current mission to avoid cross-mission context contamination
    db.collection('analysis_results')
      .findOne(
        { mission_name: missionName },
        { sort: { timestamp: -1 } }
      ),
  ]);

  // Build context string
  const lines: string[] = [
    `MISSION: "${missionName}"`,
    `TIME: ${now.toLocaleTimeString()}`,
    '',
    '── PERSON TRACKER ──',
    `Currently visible: ${getVisibleCount()} people`,
    `Unique people seen (this mission): ${getUniqueCount()}`,
    `Net flow: ${getNetFlow()} (entering: ${getEnteringCount()}, exiting: ${getExitingCount()})`,
    `Minutes since last movement: ${getMinutesSinceLastMovement().toFixed(1)}`,
  ];

  if (recentDetections.length > 0) {
    const peopleCounts = recentDetections.map(
      d => (d.context?.people_count as number)
        ?? (d.local_cv?.person_count as number)
        ?? 0
    );
    const avg = peopleCounts.reduce((a, b) => a + b, 0) / peopleCounts.length;
    const max = Math.max(...peopleCounts);
    lines.push(
      '',
      '── RECENT (last 5 min) ──',
      `${recentDetections.length} observations, avg ${avg.toFixed(1)} people, peak ${max}`,
    );
  }

  if (hourlyStats.length > 0) {
    lines.push(
      '',
      '── HOURLY TREND (5-min buckets) ──',
      ...hourlyStats.map(s =>
        `${new Date(s._id).toLocaleTimeString()}: avg ${(s.avg_people as number ?? 0).toFixed(1)}, peak ${s.max_people ?? 0} (${s.count} samples)`
      ),
    );
  }

  if (recentEvents.length > 0) {
    lines.push(
      '',
      '── RECENT EVENTS ──',
      ...recentEvents.map(e => `[${e.event_type}] ${e.description}`),
    );
  }

  if (lastAnalysis?.result?.spoken_summary) {
    lines.push(
      '',
      `── PREVIOUS ANALYSIS ──`,
      `${lastAnalysis.result.spoken_summary}`,
    );
  }

  return lines.join('\n');
}
