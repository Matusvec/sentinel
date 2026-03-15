import type { ToolDefinition, ToolContext, ToolResult } from './types';

import { speakTool } from './speak.tool';
import { moveGimbalTool } from './move-gimbal.tool';
import { setAlertTool } from './set-alert.tool';
import { analyzePatternsTool } from './analyze-patterns.tool';
import { queryDatabaseTool } from './query-database.tool';
import { describeSceneTool } from './describe-scene.tool';
import { sendTelegramTool } from './send-telegram.tool';
import { createMissionTool } from './create-mission.tool';
import { clearMissionTool } from './clear-mission.tool';
import { setModeTool } from './set-mode.tool';
import { getTrackerStatsTool } from './get-tracker-stats.tool';
import { captureSnapshotTool } from './capture-snapshot.tool';
import { clearDataTool } from './clear-data.tool';
import { startTrackingTool } from './start-tracking.tool';
import { scanRoomTool } from './scan-room.tool';
import { searchForTool } from './search-for.tool';
import { manageAlertsTool } from './manage-alerts.tool';
import { fullSweepTool } from './full-sweep.tool';
import { fallDetectionTool } from './fall-detection.tool';

const tools: ToolDefinition[] = [
  speakTool,
  moveGimbalTool,
  setAlertTool,
  analyzePatternsTool,
  queryDatabaseTool,
  describeSceneTool,
  sendTelegramTool,
  createMissionTool,
  clearMissionTool,
  setModeTool,
  getTrackerStatsTool,
  captureSnapshotTool,
  clearDataTool,
  startTrackingTool,
  scanRoomTool,
  searchForTool,
  manageAlertsTool,
  fullSweepTool,
  fallDetectionTool,
];

export function getAllTools(): ToolDefinition[] {
  return tools;
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.find(t => t.name === name);
}

/**
 * Build a formatted tool description string for the LLM prompt.
 * Dynamically generated from registered tools — adding a tool file
 * automatically makes it available to the AI.
 */
export function getToolDescriptionsForPrompt(): string {
  return tools.map(t => {
    const params = t.parameters.length > 0
      ? t.parameters.map(p => {
          let desc = `    - ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}`;
          if (p.enum) desc += ` [${p.enum.join(' | ')}]`;
          if (p.default !== undefined) desc += ` (default: ${p.default})`;
          return desc;
        }).join('\n')
      : '    (no parameters)';
    return `  ${t.name} [${t.category}]: ${t.description}\n${params}`;
  }).join('\n\n');
}

/**
 * Execute a tool by name with the given params and context.
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { success: false, error: `Unknown tool: ${name}` };
  console.log(`[tools] Executing: ${name}`, JSON.stringify(params).slice(0, 200));
  try {
    const result = await tool.execute(params, context);
    console.log(`[tools] ${name} result:`, result.success ? 'OK' : result.error);
    return result;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Tool execution failed' };
  }
}

export type { ToolDefinition, ToolContext, ToolResult } from './types';
