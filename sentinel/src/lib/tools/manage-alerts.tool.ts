import type { ToolDefinition } from './types';

// Shared mutable state — controls whether alerts are sent
let alertsEnabled = true;
let mutedTypes = new Set<string>();

export function isAlertEnabled(): boolean {
  return alertsEnabled;
}

export function isTypeMuted(type: string): boolean {
  return mutedTypes.has(type) || mutedTypes.has('all');
}

export const manageAlertsTool: ToolDefinition = {
  name: 'manage_alerts',
  description: 'Control the alert system. Use when the user says "stop alerting me", "mute alerts", "stop sending texts", "resume alerts", etc. Can mute all alerts, mute specific types, or resume.',
  parameters: [
    { name: 'action', type: 'string', description: 'What to do', required: true, enum: ['mute_all', 'mute_type', 'unmute_all', 'unmute_type', 'status'] },
    { name: 'type', type: 'string', description: 'Alert type to mute/unmute (e.g., "temporal_analysis", "face_recognized", "mission_trigger")', required: false },
  ],
  category: 'system',
  async execute(params) {
    const action = params.action as string;
    const type = params.type as string | undefined;

    switch (action) {
      case 'mute_all':
        alertsEnabled = false;
        mutedTypes.add('all');
        return { success: true, data: { message: 'All alerts muted. I will not send any Telegram notifications or speak alerts until you say "resume alerts".' } };

      case 'mute_type':
        if (type) {
          mutedTypes.add(type);
          return { success: true, data: { message: `Muted "${type}" alerts.` } };
        }
        return { success: false, error: 'Specify which type to mute' };

      case 'unmute_all':
        alertsEnabled = true;
        mutedTypes.clear();
        return { success: true, data: { message: 'All alerts resumed.' } };

      case 'unmute_type':
        if (type) {
          mutedTypes.delete(type);
          return { success: true, data: { message: `Unmuted "${type}" alerts.` } };
        }
        return { success: false, error: 'Specify which type to unmute' };

      case 'status':
        return {
          success: true,
          data: {
            enabled: alertsEnabled,
            muted_types: Array.from(mutedTypes),
            message: alertsEnabled
              ? mutedTypes.size > 0
                ? `Alerts active, but these types are muted: ${Array.from(mutedTypes).join(', ')}`
                : 'All alerts are active.'
              : 'All alerts are muted.',
          },
        };

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};
