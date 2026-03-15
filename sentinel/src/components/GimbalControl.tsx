'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

/** Pan range: 0 (right) to 180 (left) */
const PAN_MIN = 0;
const PAN_MAX = 180;
/** Tilt range: 45 (up) to 135 (down) — matches Arduino hardware limits */
const TILT_MIN = 45;
const TILT_MAX = 135;
/** Default center position */
const DEFAULT_PAN = 90;
const DEFAULT_TILT = 70;

interface GimbalPosition {
  pan: number;
  tilt: number;
}

/**
 * Clamps a value between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Sends a gimbal command to the sentinel API.
 */
async function sendGimbalCommand(pan: number, tilt: number): Promise<void> {
  try {
    await fetch('/api/sentinel/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'gimbal', params: { pan, tilt } }),
    });
  } catch (err) {
    console.error('[GimbalControl] Failed to send command:', err);
  }
}

/**
 * GimbalControl — drag-based pan/tilt joystick for the SENTINEL dashboard.
 * Sends POST /api/sentinel/command at up to 5 requests per second.
 */
export default function GimbalControl() {
  const [position, setPosition] = useState<GimbalPosition>({
    pan: DEFAULT_PAN,
    tilt: DEFAULT_TILT,
  });
  const [isDragging, setIsDragging] = useState(false);
  const zoneRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef<number>(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Converts a pixel offset from zone center to pan/tilt degrees. */
  const pixelsToDegrees = useCallback(
    (offsetX: number, offsetY: number, radius: number): GimbalPosition => {
      const nx = clamp(offsetX / radius, -1, 1); // -1 to 1
      const ny = clamp(offsetY / radius, -1, 1); // -1 to 1 (up = negative)
      const pan = Math.round(((nx + 1) / 2) * (PAN_MAX - PAN_MIN) + PAN_MIN);
      // Y is inverted: drag up = increase tilt
      const tilt = Math.round(((-ny + 1) / 2) * (TILT_MAX - TILT_MIN) + TILT_MIN);
      return { pan, tilt };
    },
    []
  );

  /** Throttled command sender — max 5/s (200ms interval). */
  const throttledSend = useCallback((pan: number, tilt: number) => {
    const now = Date.now();
    const elapsed = now - lastSentRef.current;
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    if (elapsed >= 200) {
      lastSentRef.current = now;
      sendGimbalCommand(pan, tilt);
    } else {
      pendingRef.current = setTimeout(() => {
        lastSentRef.current = Date.now();
        sendGimbalCommand(pan, tilt);
        pendingRef.current = null;
      }, 200 - elapsed);
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging || !zoneRef.current) return;
      const rect = zoneRef.current.getBoundingClientRect();
      const radius = rect.width / 2;
      const offsetX = e.clientX - rect.left - radius;
      const offsetY = e.clientY - rect.top - radius;
      const newPos = pixelsToDegrees(offsetX, offsetY, radius);
      setPosition(newPos);
      throttledSend(newPos.pan, newPos.tilt);
    },
    [isDragging, pixelsToDegrees, throttledSend]
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleReset = useCallback(() => {
    setPosition({ pan: DEFAULT_PAN, tilt: DEFAULT_TILT });
    sendGimbalCommand(DEFAULT_PAN, DEFAULT_TILT);
  }, []);

  // Flush any pending send on unmount
  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, []);

  /** Converts pan/tilt back to dot position within the zone (0–100%). */
  const dotX = ((position.pan - PAN_MIN) / (PAN_MAX - PAN_MIN)) * 100;
  const dotY = (1 - (position.tilt - TILT_MIN) / (TILT_MAX - TILT_MIN)) * 100;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 select-none">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
          Gimbal Control
        </h2>
        <div className="flex gap-3 text-xs font-mono text-zinc-300">
          <span>
            PAN{' '}
            <span className="text-green-400">{String(position.pan).padStart(3, '0')}</span>
          </span>
          <span>
            TILT{' '}
            <span className="text-green-400">{String(position.tilt).padStart(3, '0')}</span>
          </span>
        </div>
      </div>

      {/* Joystick zone */}
      <div className="flex justify-center">
        <div
          ref={zoneRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className={[
            'relative w-48 h-48 rounded-full border-2 cursor-crosshair overflow-hidden',
            isDragging
              ? 'border-green-500/70 shadow-[0_0_12px_2px_rgba(34,197,94,0.25)]'
              : 'border-zinc-700',
          ].join(' ')}
          style={{
            backgroundImage: [
              'linear-gradient(rgba(34,197,94,0.04) 1px, transparent 1px)',
              'linear-gradient(90deg, rgba(34,197,94,0.04) 1px, transparent 1px)',
            ].join(', '),
            backgroundSize: '24px 24px',
            backgroundColor: '#0f0f0f',
          }}
        >
          {/* Crosshair lines */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-full h-px bg-zinc-700/50" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="h-full w-px bg-zinc-700/50" />
          </div>

          {/* Position dot */}
          <div
            className={[
              'absolute w-4 h-4 rounded-full border-2 -translate-x-1/2 -translate-y-1/2 transition-none pointer-events-none',
              isDragging
                ? 'border-green-400 bg-green-500/50 shadow-[0_0_6px_rgba(34,197,94,0.8)]'
                : 'border-green-600 bg-green-700/50',
            ].join(' ')}
            style={{ left: `${dotX}%`, top: `${dotY}%` }}
          />
        </div>
      </div>

      {/* Reset button */}
      <div className="mt-3 flex justify-center">
        <button
          onClick={handleReset}
          className="rounded border border-zinc-600 bg-zinc-800 px-4 py-1.5 text-xs font-semibold tracking-widest text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:bg-zinc-700 active:bg-zinc-600"
        >
          Center (90 / 70)
        </button>
      </div>
    </div>
  );
}
