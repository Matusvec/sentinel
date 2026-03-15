import type { ToolDefinition } from './types';

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:5000';

export const moveGimbalTool: ToolDefinition = {
  name: 'move_gimbal',
  description: 'Move the camera gimbal. Only call this ONCE per user request — do NOT chain multiple move_gimbal calls. Check current position in SENSORS (p=pan, t=tilt) and calculate the target in one move. Pan: 0=right, 180=left, 90=center. Tilt: 45=max up, 135=max down, 90=straight. "center" = pan 90, tilt 90. "look left" = add 30-50 to current pan. "look right" = subtract 30-50. "look up" = subtract 20 from tilt. "look down" = add 20.',
  parameters: [
    { name: 'pan', type: 'number', description: 'Absolute pan angle (0-180)', required: true },
    { name: 'tilt', type: 'number', description: 'Absolute tilt angle (45-135)', required: true },
  ],
  category: 'hardware',
  async execute(params) {
    const pan = Math.max(0, Math.min(180, Math.round(params.pan as number)));
    const tilt = Math.max(45, Math.min(135, Math.round(params.tilt as number)));
    try {
      const res = await fetch(`${PYTHON_URL}/gimbal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pan, tilt }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { success: false, error: `Gimbal command failed: HTTP ${res.status}` };
      }
      const data = await res.json();
      return { success: true, data: { pan, tilt, ...data } };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Python server unreachable — is sentinel.py running?' };
    }
  },
};
