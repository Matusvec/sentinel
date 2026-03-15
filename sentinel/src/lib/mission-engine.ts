/**
 * SENTINEL Mission Engine — Creates, stores, and manages missions.
 *
 * A Mission rewires SENTINEL's entire perception pipeline from a single
 * plain-English instruction. This module handles:
 *   1. Sending the instruction to Gemini with the meta-prompt
 *   2. Parsing the response into a structured MissionConfig
 *   3. Storing it in-memory (module-level) for fast access
 *   4. Persisting it to MongoDB 'missions' collection for durability
 *   5. Bridging to the legacy mission.ts state so existing code keeps working
 */

import { getDb } from '@/lib/mongodb';
import { getMissionParsingPrompt } from '@/lib/mission-prompts';
import {
  setActiveMission,
  clearMission as legacyClear,
  type Mission,
  type MissionTrigger,
} from '@/lib/mission';
import { resetTriggerState } from '@/lib/trigger-evaluator';

// ── Types ────────────────────────────────────────────────────

export interface SpeakBehavior {
  onTrigger: boolean;
  onPattern: boolean;
  silent: boolean;
  template: string;
}

export interface MissionConfig {
  /** Unique identifier */
  id: string;
  /** Short 2-5 word name */
  missionName: string;
  /** Raw user instruction */
  instruction: string;
  /** Custom Gemini Vision prompt for per-frame analysis */
  visionPrompt: string;
  /** Mission-specific fields to extract and persist each cycle */
  extractionFields: string[];
  /** Conditions that fire alerts */
  triggers: MissionTrigger[];
  /** System prompt for Featherless/Llama temporal analysis */
  featherlessSystemPrompt: string;
  /** When and how SENTINEL speaks */
  speakBehavior: SpeakBehavior;
  /** Seconds between Featherless analysis runs */
  analysisIntervalSeconds: number;
  /** When this mission was created */
  createdAt: Date;
  /** Current status */
  status: 'active' | 'paused' | 'completed';
}

/** Shape Gemini returns (before we add server-assigned fields). */
interface GeminiMissionResponse {
  missionName: string;
  visionPrompt: string;
  extractionFields: string[];
  triggers: MissionTrigger[];
  featherlessSystemPrompt: string;
  speakBehavior: SpeakBehavior;
  analysisIntervalSeconds: number;
}

// ── In-memory state ──────────────────────────────────────────

let activeMission: MissionConfig | null = null;
let missionCounter = 0;

/** Cache null results from MongoDB to avoid querying every frame (2Hz). */
let nullCheckedAt = 0;
const NULL_CHECK_INTERVAL_MS = 10_000;

// ── Public API ───────────────────────────────────────────────

/**
 * Parse a plain-English instruction into a full MissionConfig via Gemini,
 * store it in memory and MongoDB, and bridge to the legacy mission state.
 */
export async function createMission(instruction: string): Promise<MissionConfig> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const prompt = getMissionParsingPrompt(instruction);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty response from Gemini');

  const parsed: GeminiMissionResponse = JSON.parse(
    rawText.replace(/```json|```/g, '').trim()
  );

  // Build the full MissionConfig with server-assigned fields
  const config: MissionConfig = {
    id: `mission-${++missionCounter}-${Date.now()}`,
    missionName: parsed.missionName || 'Unnamed Mission',
    instruction,
    visionPrompt: parsed.visionPrompt,
    extractionFields: parsed.extractionFields || [],
    triggers: parsed.triggers || [],
    featherlessSystemPrompt: parsed.featherlessSystemPrompt || '',
    speakBehavior: {
      onTrigger: parsed.speakBehavior?.onTrigger ?? true,
      onPattern: parsed.speakBehavior?.onPattern ?? false,
      silent: parsed.speakBehavior?.silent ?? false,
      template: parsed.speakBehavior?.template || 'Mission alert: {count} detected.',
    },
    analysisIntervalSeconds: parsed.analysisIntervalSeconds || 30,
    createdAt: new Date(),
    status: 'active',
  };

  // Store in memory (and invalidate null cache)
  activeMission = config;
  nullCheckedAt = 0;

  // Bridge to legacy mission.ts state so gemini.ts and featherless.ts keep working
  bridgeToLegacy(config);

  // Persist to MongoDB
  await persistMission(config);

  return config;
}

/**
 * Returns the active mission from memory, falling back to MongoDB
 * if the in-memory state was lost (e.g., after a server restart).
 */
export async function getMission(): Promise<MissionConfig | null> {
  if (activeMission) return activeMission;

  // Don't hit MongoDB every frame (2Hz) when no mission is active.
  // Recheck every 10 seconds at most.
  const now = Date.now();
  if (now - nullCheckedAt < NULL_CHECK_INTERVAL_MS) return null;
  nullCheckedAt = now;

  // Fallback: check MongoDB for an active mission
  try {
    const db = await getDb();
    const doc = await db
      .collection('missions')
      .findOne({ status: 'active' }, { sort: { createdAt: -1 } });

    if (doc) {
      activeMission = {
        id: doc.id,
        missionName: doc.missionName,
        instruction: doc.instruction,
        visionPrompt: doc.visionPrompt,
        extractionFields: doc.extractionFields,
        triggers: doc.triggers,
        featherlessSystemPrompt: doc.featherlessSystemPrompt,
        speakBehavior: doc.speakBehavior,
        analysisIntervalSeconds: doc.analysisIntervalSeconds,
        createdAt: new Date(doc.createdAt),
        status: doc.status,
      };
      bridgeToLegacy(activeMission);
      return activeMission;
    }
  } catch (err) {
    console.error('Failed to load mission from MongoDB:', err);
  }

  return null;
}

/**
 * Clears the active mission from memory and marks it completed in MongoDB.
 */
export async function clearMission(): Promise<void> {
  const missionId = activeMission?.id;
  activeMission = null;
  nullCheckedAt = 0;

  // Clear legacy state and reset trigger cooldowns
  legacyClear();
  resetTriggerState();

  // Mark completed in MongoDB (preserves history)
  if (missionId) {
    try {
      const db = await getDb();
      await db.collection('missions').updateOne(
        { id: missionId },
        { $set: { status: 'completed', endedAt: new Date() } }
      );
    } catch (err) {
      console.error('Failed to update mission in MongoDB:', err);
    }
  }
}

/**
 * Set a pre-built MissionConfig directly without calling Gemini.
 * Used by tools that build mission configs programmatically
 * (e.g., fall detection tool with precise trigger config).
 */
export async function setMissionDirectly(config: MissionConfig): Promise<MissionConfig> {
  activeMission = config;
  nullCheckedAt = 0;
  bridgeToLegacy(config);
  await persistMission(config);
  return config;
}

// ── Internal helpers ─────────────────────────────────────────

/**
 * Syncs a MissionConfig to the legacy mission.ts in-memory state.
 * This ensures gemini.ts (getVisionPrompt) and featherless.ts
 * (getFeatherlessPrompt) continue to work without import changes.
 */
function bridgeToLegacy(config: MissionConfig): void {
  const legacy: Mission = {
    id: config.id,
    name: config.missionName,
    instruction: config.instruction,
    visionPrompt: config.visionPrompt,
    storageFields: config.extractionFields,
    triggers: config.triggers,
    featherlessPrompt: config.featherlessSystemPrompt,
    speakOnTrigger: config.speakBehavior.onTrigger,
    speakTemplate: config.speakBehavior.template,
    createdAt: config.createdAt,
    status: config.status,
  };
  setActiveMission(legacy);
}

/**
 * Persists a mission config to the MongoDB 'missions' collection.
 */
async function persistMission(config: MissionConfig): Promise<void> {
  try {
    const db = await getDb();
    await db.collection('missions').insertOne({
      ...config,
      createdAt: config.createdAt,
    });
  } catch (err) {
    // Non-fatal: mission still works in-memory even if DB write fails
    console.error('Failed to persist mission to MongoDB:', err);
  }
}
