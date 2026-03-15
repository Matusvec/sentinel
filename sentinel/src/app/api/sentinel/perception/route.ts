import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { getMode, checkTasks } from '@/lib/mode';
import { getMission, type MissionConfig } from '@/lib/mission-engine';
import { analyzeFrame, type VisionAnalysis } from '@/lib/gemini';
import {
  buildDocument,
  shouldStore,
  type AdaptiveDocument,
  type SensorSnapshot,
} from '@/lib/adaptive-storage';
import { evaluateTriggers, type FiredTrigger } from '@/lib/trigger-evaluator';
import { updateTracking, resetTracking, getUniqueCount } from '@/lib/person-tracker';
import { pollAndRoute } from '@/lib/telegram-poll';
import { runTemporalAnalysis } from '@/lib/temporal-analysis';
import { reason, shouldRunPerceptionReasoning } from '@/lib/reasoning-engine';
import { isAlertEnabled, isTypeMuted } from '@/lib/tools/manage-alerts.tool';

// In-memory latest state for real-time dashboard polling.
// Exported so other routes can import directly without HTTP loopback.
export let latestPerception: Record<string, unknown> | null = null;
// Latest frame kept separately for visual Q&A (chat route sends this to Gemini)
export let latestFrameB64: string | null = null;

// Throttle mission-specific Gemini analysis (uses mission config or 3s default)
let lastMissionAnalysis = 0;

// Previous adaptive document for dedup (reset when mission changes)
let previousAdaptiveDoc: AdaptiveDocument | null = null;
let previousMissionId: string | null = null;

// Face recognition event throttle (30s per name)
const lastFaceRecognized = new Map<string, number>();

/** POST /api/sentinel/perception — ingest perception data from Python. */
export async function POST(request: Request) {
  try {
    const perception = await request.json();

    // Store frame for visual Q&A, strip from GET responses to keep them lean
    const { frame_b64: _frame, ...perceptionWithoutFrame } = perception;
    if (_frame) latestFrameB64 = _frame;
    latestPerception = perceptionWithoutFrame;

    const db = await getDb();
    const mode = getMode();
    const mission = await getMission();

    // Update cached mission info for the GET handler (avoids MongoDB on dashboard polls)
    cachedMissionInfo = mission
      ? { id: mission.id, missionName: mission.missionName, status: mission.status }
      : null;

    // Reset state caches when mission changes
    if (mission?.id !== previousMissionId) {
      previousAdaptiveDoc = null;
      previousMissionId = mission?.id ?? null;
      resetTracking();
    }

    // ── Person tracking (cross-frame identity) ──
    const localCvPersons = (perception.local_cv as Record<string, unknown>)?.persons;
    if (Array.isArray(localCvPersons)) {
      updateTracking(localCvPersons);

      // Log known face recognition events (throttled per name, 30s cooldown)
      const tickMs = Date.now();
      for (const person of localCvPersons) {
        const p = person as Record<string, unknown>;
        if (p.name && typeof p.name === 'string') {
          const lastSeen = lastFaceRecognized.get(p.name) ?? 0;
          if (tickMs - lastSeen > 30_000) {
            lastFaceRecognized.set(p.name, tickMs);
            db.collection('events').insertOne({
              timestamp: new Date(),
              event_type: 'face_recognized',
              severity: 'info',
              description: `Known person identified: ${p.name} (${Math.round((p.name_confidence as number ?? 0) * 100)}% confidence)`,
            }).catch(console.error);
          }
        }
      }
    }

    // ── Fast-path fall detection (fires even without an active mission) ──
    if (Array.isArray(localCvPersons)) {
      const fallenPerson = (localCvPersons as Array<Record<string, unknown>>).find(
        (p) => p.fall_detected === true
      );
      if (fallenPerson) {
        const fallCooldownKey = 'fall_fastpath';
        const lastFallAlert = lastFaceRecognized.get(fallCooldownKey) ?? 0;
        const tickNow = Date.now();
        if (tickNow - lastFallAlert > 10_000) {
          lastFaceRecognized.set(fallCooldownKey, tickNow);
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
          const fallName = (fallenPerson.name as string) || 'A person';
          const fallConf = Math.round(((fallenPerson.fall_confidence as number) ?? 0) * 100);
          const alertMsg = `Fall detected! ${fallName} may have fallen. Confidence: ${fallConf}%.`;

          if (isAlertEnabled() && !isTypeMuted('fall_detection')) {
            // Red LED + buzzer
            const pythonUrl = process.env.PYTHON_URL || 'http://localhost:5000';
            fetch(`${pythonUrl}/led`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ color: 'red', buzzer: true }),
              signal: AbortSignal.timeout(2000),
            }).catch(() => {});

            // TTS alert
            fetch(`${baseUrl}/api/sentinel/speak`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: alertMsg, context: 'alert' }),
              signal: AbortSignal.timeout(5000),
            }).catch(console.error);

            // Telegram with photo
            const photo = (perception.frame_b64 as string | undefined) || latestFrameB64;
            fetch(`${baseUrl}/api/sentinel/telegram`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'alert',
                text: alertMsg,
                base64: photo || undefined,
              }),
              signal: AbortSignal.timeout(10000),
            }).catch(console.error);

            // Log event to MongoDB
            db.collection('events').insertOne({
              timestamp: new Date(),
              event_type: 'fall_detected',
              severity: 'critical',
              description: alertMsg,
              person_name: fallenPerson.name || null,
              fall_confidence: fallenPerson.fall_confidence,
            }).catch(console.error);
          }
        }
      }
    }

    // ── Mission-specific Gemini analysis (throttled) ──
    let missionVision: VisionAnalysis | null = null;
    const now = Date.now();
    const analysisInterval = mission?.analysisIntervalSeconds
      ? mission.analysisIntervalSeconds * 1000
      : 3000;
    // Use frame from perception payload, or fallback to cached frame
    const frameB64 = (perception.frame_b64 as string | undefined) || latestFrameB64;
    if (mission && frameB64 && now - lastMissionAnalysis >= analysisInterval) {
      lastMissionAnalysis = now;
      try {
        missionVision = await analyzeFrame(
          frameB64,
          mission.visionPrompt
        );
      } catch (e) {
        console.error('[perception] Mission vision analysis failed:', e);
      }
    }

    // Merge mission vision into cached perception so chat/dashboard has it
    if (missionVision) {
      latestPerception = { ...latestPerception, mission_vision: missionVision };
    }

    // ── Storage ──
    const sensors = perception.sensors as SensorSnapshot | undefined;
    let adaptiveDoc: AdaptiveDocument | null = null;

    if (mission) {
      // Build adaptive doc — feed local CV person count + persons so triggers work
      // even between Gemini analysis intervals
      const localCvCount = (perception.local_cv as Record<string, unknown>)?.person_count as number | undefined;
      const localCvPersonsArr = Array.isArray(localCvPersons) ? localCvPersons as Array<Record<string, unknown>> : undefined;
      adaptiveDoc = buildDocument(missionVision, sensors, mission, localCvCount ?? 0, localCvPersonsArr);

      if (shouldStore(adaptiveDoc, previousAdaptiveDoc)) {
        await db.collection('detections').insertOne({
          ...adaptiveDoc,
          mode,
          received_at: new Date(),
        });
        previousAdaptiveDoc = adaptiveDoc;
      }
    } else {
      // Default storage: strip large frame_b64 before persisting
      const { frame_b64: _fb, ...perceptionLean } = perception;
      await db.collection('detections').insertOne({
        ...perceptionLean,
        mode,
        timestamp: new Date(perception.timestamp),
        received_at: new Date(),
      });
    }

    // ── Trigger evaluation ──
    let agentTriggered = false;
    let taskTriggered: Array<{ taskId: number; message: string }> = [];
    let firedMissionTriggers: FiredTrigger[] = [];

    // Evaluate triggers when mission is active — runs even without Gemini vision
    // (basic triggers like people_count_exceeds use local CV, not Gemini)
    if (mission && adaptiveDoc) {
      firedMissionTriggers = evaluateTriggers(adaptiveDoc.extracted, mission);
    }

    // ── Mode-aware trigger logic ──
    switch (mode) {
      case 'chat':
        // Silent — mission triggers evaluated above but we don't speak
        // unless speakBehavior says otherwise
        if (firedMissionTriggers.length > 0 && !mission?.speakBehavior.silent) {
          handleFiredTriggers(firedMissionTriggers, frameB64 ?? undefined);
        }
        break;

      case 'monitor': {
        // Check active tasks against this perception (existing behavior)
        const triggeredTasks = checkTasks(perception);
        if (triggeredTasks.length > 0) {
          taskTriggered = triggeredTasks.map(t => ({
            taskId: t.task.id,
            message: t.message,
          }));

          // Speak task results (fire-and-forget)
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
          for (const { message } of triggeredTasks) {
            fetch(`${baseUrl}/api/sentinel/speak`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: message, context: 'detection' }),
              signal: AbortSignal.timeout(5000),
            }).catch(console.error);
          }
        }

        // Handle mission triggers
        if (firedMissionTriggers.length > 0) {
          handleFiredTriggers(firedMissionTriggers, frameB64 ?? undefined);
        }
        break;
      }

      case 'scan': {
        // Full autonomous mode — AI reasoning decides when to act (throttled)
        if (shouldRunPerceptionReasoning()) {
          agentTriggered = true;
          // Fire-and-forget: reasoning engine handles tool execution internally
          reason({
            type: 'perception_event',
            perception,
            trigger: 'scan_perception',
          }).catch(console.error);
        }

        // Handle mission triggers (fast path — no LLM needed)
        if (firedMissionTriggers.length > 0) {
          handleFiredTriggers(firedMissionTriggers, frameB64 ?? undefined);
        }
        break;
      }
    }

    // ── Background tasks (fire-and-forget, internally throttled) ──
    pollAndRoute().catch(console.error);
    runTemporalAnalysis(perception).catch(console.error);

    return NextResponse.json({
      status: 'ok',
      mode,
      mission: mission ? { id: mission.id, missionName: mission.missionName } : null,
      agent_triggered: agentTriggered,
      task_triggered: taskTriggered,
      mission_triggers_fired: firedMissionTriggers.map(ft => ({
        type: ft.trigger.type,
        severity: ft.severity,
        message: ft.message,
        sent_telegram: ft.sendTelegram,
      })),
      mission_vision: missionVision !== null,
      unique_persons: getUniqueCount(),
    });
  } catch (error) {
    console.error('Perception error:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// Cache mission info from the last POST cycle for the GET handler
// so dashboard polling doesn't trigger additional MongoDB queries
let cachedMissionInfo: { id: string; missionName: string; status: string } | null = null;

/** GET /api/sentinel/perception — returns latest perception snapshot for dashboard polling. */
export async function GET() {
  return NextResponse.json({
    perception: latestPerception,
    mode: getMode(),
    mission: cachedMissionInfo,
  });
}

// ── Helpers (unchanged from original) ────────────────────────

// ── Mission trigger side-effects ─────────────────────────────

/**
 * Handle fired mission triggers: speak via ElevenLabs and
 * send Telegram alerts with photo.
 */
async function handleFiredTriggers(
  triggers: FiredTrigger[],
  frameBase64?: string
): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

  // Get a frame for the photo — try multiple sources
  let photo = frameBase64 || latestFrameB64;
  if (!photo) {
    try {
      const pythonUrl = process.env.PYTHON_URL || 'http://localhost:5000';
      const res = await fetch(`${pythonUrl}/frame_b64`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        photo = data.frame_b64 || null;
      }
    } catch { /* no photo available */ }
  }

  for (const ft of triggers) {
    // Check if alerts are muted
    if (!isAlertEnabled() || isTypeMuted('mission_trigger')) continue;

    // Speak the alert
    fetch(`${baseUrl}/api/sentinel/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: ft.message,
        context: ft.severity === 'critical' ? 'alert' : 'detection',
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(console.error);

    // ALWAYS send to Telegram with photo for mission triggers
    if (ft.sendTelegram) {
      fetch(`${baseUrl}/api/sentinel/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'alert',
          text: ft.message,
          base64: photo || undefined,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(console.error);
    }
  }
}
