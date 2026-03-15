'use client';

import { useEffect, useRef, useState } from 'react';

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Landmark {
  x: number;
  y: number;
  v: number; // visibility 0-1
}

interface LocalCvPerson {
  id: number;
  bbox: BBox;
  center: { x: number; y: number };
  speed: number;
  activity: string;
  landmark_count: number;
  landmarks?: Landmark[];
  name?: string;
  name_confidence?: number;
}

// MediaPipe skeleton connections
const SKELETON_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

// Named keypoints for display
const KEYPOINT_LABELS: Record<number, string> = {
  0: 'HEAD', 11: 'L.SHOULDER', 12: 'R.SHOULDER',
  13: 'L.ELBOW', 14: 'R.ELBOW', 15: 'L.HAND', 16: 'R.HAND',
  23: 'L.HIP', 24: 'R.HIP', 25: 'L.KNEE', 26: 'R.KNEE',
  27: 'L.FOOT', 28: 'R.FOOT',
};

interface EnrichedPerson extends LocalCvPerson {
  gemini_activity?: string;
  gemini_facing?: string;
  gemini_description?: string;
  gemini_distance?: string;
}

interface Person {
  id: number;
  bbox: BBox | [number, number, number, number];
  distance: number | string;
  activity?: string;
  facing?: string;
}

interface DetectedObject {
  label: string;
  bbox: BBox | [number, number, number, number];
}

interface VisionData {
  people: Person[];
  objects?: DetectedObject[];
  environment?: {
    scene_description?: string;
  };
}

interface CameraDevice {
  deviceId: string;
  label: string;
}

function normBBox(bbox: BBox | [number, number, number, number]): BBox {
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

/**
 * LiveFeed — browser-native camera with CV overlay.
 * Uses getUserMedia for instant 30fps video.
 * Periodically sends frames to Python VisionEngine for CV analysis.
 * Also polls /perception for Gemini results from sentinel.py.
 */
export default function LiveFeed() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [persons, setPersons] = useState<EnrichedPerson[]>([]);
  const [visionData, setVisionData] = useState<VisionData | null>(null);
  const [visionAge, setVisionAge] = useState<number | null>(null);
  const [cvActive, setCvActive] = useState(false);
  const [peopleCount, setPeopleCount] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [trackingInfo, setTrackingInfo] = useState<{ enabled: boolean; target: string | null; bbox: [number, number, number, number] | null } | null>(null);

  // Enumerate cameras and start stream in a single flow (avoids the temp-stream
  // race condition where releasing then re-acquiring the device fails on Linux V4L2)
  useEffect(() => {
    let cancelled = false;

    async function initCamera() {
      try {
        // Request camera — keep the stream (don't stop and re-request)
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
          },
        });

        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        // Enumerate devices now that we have permission
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices
          .filter(d => d.kind === 'videoinput')
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${i + 1}`,
          }));
        setCameras(videoDevices);

        // Use the stream we already have
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setIsStreaming(true);
        if (videoDevices.length > 0) {
          setSelectedCamera(stream.getVideoTracks()[0]?.getSettings()?.deviceId || videoDevices[0].deviceId);
        }
      } catch (err) {
        console.error('Camera init failed:', err);
        setIsStreaming(false);
      }
    }

    initCamera();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // Switch camera when user picks a different one from the dropdown
  useEffect(() => {
    // Skip the initial render — the first useEffect already started the default camera
    if (!selectedCamera || !streamRef.current) return;

    // Check if current stream already uses this device
    const currentDeviceId = streamRef.current.getVideoTracks()[0]?.getSettings()?.deviceId;
    if (currentDeviceId === selectedCamera) return;

    async function switchCamera() {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: selectedCamera },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
          },
        });

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setIsStreaming(true);
      } catch (err) {
        console.error('Camera switch failed:', err);
        setIsStreaming(false);
      }
    }

    switchCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, [selectedCamera]);

  // Periodically capture frame and send to Python for CV analysis
  useEffect(() => {
    if (!isStreaming) return;

    // Create offscreen canvas for frame capture
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    captureCanvasRef.current = captureCanvas;

    let aborted = false;

    const analyzeFrame = async () => {
      const video = videoRef.current;
      const ctx = captureCanvas.getContext('2d');
      if (!video || !ctx || video.readyState < 2) return;

      // Draw video frame to offscreen canvas
      ctx.drawImage(video, 0, 0, 640, 480);
      const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.7);
      const base64 = dataUrl.split(',')[1];

      try {
        const res = await fetch('/api/sentinel/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame: base64 }),
          signal: AbortSignal.timeout(3000),
        });
        if (aborted) return;
        const data = await res.json();

        if (data.local_cv) {
          setPersons(data.enriched_persons ?? data.local_cv.persons ?? []);
          setPeopleCount(data.local_cv.person_count ?? 0);
          setCvActive(true);
        }
        if (data.tracking !== undefined) {
          setTrackingInfo(data.tracking);
        }
      } catch {
        if (!aborted) setCvActive(false);
      }
    };

    const interval = setInterval(analyzeFrame, 500);
    return () => { aborted = true; clearInterval(interval); };
  }, [isStreaming]);

  // Poll /perception for Gemini semantic data + backend frame fallback
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/sentinel/perception');
        if (!res.ok) return;
        const data = await res.json();
        const p = data.perception;
        if (p?.vision) setVisionData(p.vision);
        if (p?.vision_age !== undefined) setVisionAge(p.vision_age ?? null);
        if (p?.enriched_persons?.length) setPersons(p.enriched_persons);
        if (p?.local_cv) {
          setPeopleCount(p.local_cv.person_count ?? 0);
          setCvActive(true);
          if (p.local_cv.persons?.length) setPersons(p.enriched_persons ?? p.local_cv.persons);
        }
      } catch { /* ignore */ }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // Draw CV overlays
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = container.clientWidth;
    const H = container.clientHeight;
    canvas.width = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const geminiAlpha = visionAge !== null ? Math.max(0.2, 1.0 - visionAge / 10.0) : 0.6;

    // ── CV tracked persons ──
    for (const person of persons) {
      const { x: nx, y: ny, width: nw, height: nh } = person.bbox;
      const x = nx * W, y = ny * H, w = nw * W, h = nh * H;
      const p = person as LocalCvPerson;
      const hasLandmarks = p.landmarks && p.landmarks.length > 10;

      if (hasLandmarks && p.landmarks) {
        // ── Skeleton overlay for pose-detected persons ──
        const lms = p.landmarks;
        ctx.setLineDash([]);

        // Draw bones
        for (const [i1, i2] of SKELETON_CONNECTIONS) {
          if (i1 >= lms.length || i2 >= lms.length) continue;
          if (lms[i1].v < 0.3 || lms[i2].v < 0.3) continue;
          const x1 = lms[i1].x * W, y1 = lms[i1].y * H;
          const x2 = lms[i2].x * W, y2 = lms[i2].y * H;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.strokeStyle = 'rgba(34,197,94,0.7)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Draw labeled keypoints
        for (let i = 0; i < lms.length; i++) {
          if (lms[i].v < 0.3) continue;
          const px = lms[i].x * W, py = lms[i].y * H;
          const label = KEYPOINT_LABELS[i];
          const isLabeled = !!label;

          // Draw point
          ctx.beginPath();
          ctx.arc(px, py, isLabeled ? 5 : 3, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? '#ef4444' : i <= 10 ? '#00ffc8' : isLabeled ? '#3b82f6' : '#22c55e';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Draw label for named keypoints
          if (isLabeled && i !== 0) { // skip HEAD label (name badge is above)
            ctx.font = '8px monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(label, px + 6, py + 3);
          }
        }
      } else {
        // ── Bounding box for face-only detections ──
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);

        // Corner accents
        ctx.setLineDash([]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#22c55e';
        const cl = Math.min(15, w / 4);
        for (const [cx, cy, dx, dy] of [
          [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
        ] as [number, number, number, number][]) {
          ctx.beginPath();
          ctx.moveTo(cx + cl * dx, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + cl * dy);
          ctx.stroke();
        }
      }

      // Person label — show name if recognized, otherwise generic ID
      ctx.font = '11px monospace';
      ctx.setLineDash([]);
      const isKnown = !!p.name;
      const label = isKnown
        ? `${p.name} (${Math.round((p.name_confidence ?? 0) * 100)}%)`
        : `Person ${person.id}`;
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = isKnown ? 'rgba(59,130,246,0.8)' : 'rgba(0,128,0,0.7)';
      ctx.fillRect(x, y - 18, tw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 4, y - 5);

      // Speed badge
      const activity = person.activity ?? 'unknown';
      const speedColor = activity === 'fast' ? '#ef4444'
        : activity === 'moving' ? '#eab308' : '#22c55e';
      const speedLabel = activity === 'still' ? 'STILL'
        : `${activity.toUpperCase()} ${person.speed ?? 0}px/s`;
      ctx.font = '10px monospace';
      const stw = ctx.measureText(speedLabel).width + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x, y + h + 2, stw, 14);
      ctx.fillStyle = speedColor;
      ctx.fillText(speedLabel, x + 4, y + h + 13);

      // Gemini label
      const ep = person as EnrichedPerson;
      if (ep.gemini_activity) {
        const info = `${ep.gemini_activity}${ep.gemini_facing ? ' · ' + ep.gemini_facing : ''}`;
        const iw = ctx.measureText(info).width + 8;
        ctx.fillStyle = `rgba(168,85,247,${geminiAlpha * 0.7})`;
        ctx.fillRect(x, y + h + 18, iw, 14);
        ctx.fillStyle = `rgba(232,200,255,${geminiAlpha})`;
        ctx.fillText(info, x + 4, y + h + 29);
      }

      // Center dot
      if (person.center) {
        ctx.beginPath();
        ctx.arc(person.center.x * W, person.center.y * H, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#22c55e';
        ctx.fill();
      }
    }

    // ── Gemini-only fallback ──
    const geminiPeople = visionData?.people ?? [];
    if (persons.length === 0 && geminiPeople.length > 0) {
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(217,70,239,${geminiAlpha})`;
      ctx.lineWidth = 2;
      ctx.font = '12px monospace';
      for (let i = 0; i < geminiPeople.length; i++) {
        const { x: nx, y: ny, width: nw, height: nh } = normBBox(geminiPeople[i].bbox);
        ctx.strokeRect(nx * W, ny * H, nw * W, nh * H);
        const lb = `Person ${i + 1} · ${geminiPeople[i].distance}`;
        ctx.fillStyle = `rgba(217,70,239,${geminiAlpha})`;
        ctx.fillText(lb, nx * W + 4, ny * H - 6);
      }
    }

    // ── Object tags ──
    const objects = visionData?.objects ?? [];
    if (objects.length > 0) {
      ctx.font = '11px monospace';
      let tagX = 8;
      const tagY = H - 36;
      for (const obj of objects) {
        const tw = ctx.measureText(obj.label).width + 12;
        ctx.fillStyle = `rgba(59,130,246,${geminiAlpha * 0.15})`;
        ctx.fillRect(tagX, tagY, tw, 18);
        ctx.strokeStyle = `rgba(59,130,246,${geminiAlpha * 0.6})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(tagX, tagY, tw, 18);
        ctx.fillStyle = `rgba(147,197,253,${geminiAlpha})`;
        ctx.fillText(obj.label, tagX + 6, tagY + 13);
        tagX += tw + 6;
        if (tagX > W - 50) break;
      }
    }

    // ── Scene bar ──
    const scene = visionData?.environment?.scene_description;
    if (scene && geminiAlpha > 0.3) {
      ctx.fillStyle = `rgba(0,0,0,${geminiAlpha * 0.6})`;
      ctx.fillRect(0, H - 18, W, 18);
      ctx.font = '10px monospace';
      ctx.fillStyle = `rgba(200,200,200,${geminiAlpha})`;
      ctx.fillText(scene.slice(0, 100), 8, H - 5);
    }

    // ── Tracking indicator ──
    if (trackingInfo?.enabled) {
      ctx.setLineDash([]);

      // If tracking a custom target with a bounding box from Gemini
      if (trackingInfo.bbox) {
        const [bx, by, bw, bh] = trackingInfo.bbox;
        const tx = bx * W, ty = by * H, tw = bw * W, th = bh * H;

        // Pulsing tracking box
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.strokeRect(tx, ty, tw, th);

        // Corner brackets
        const cl = Math.min(12, tw / 3);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#f59e0b';
        for (const [cx, cy, dx, dy] of [
          [tx, ty, 1, 1], [tx + tw, ty, -1, 1], [tx, ty + th, 1, -1], [tx + tw, ty + th, -1, -1],
        ] as [number, number, number, number][]) {
          ctx.beginPath();
          ctx.moveTo(cx + cl * dx, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + cl * dy);
          ctx.stroke();
        }

        // Center crosshair
        const tcx = tx + tw / 2, tcy = ty + th / 2;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tcx - 8, tcy); ctx.lineTo(tcx + 8, tcy);
        ctx.moveTo(tcx, tcy - 8); ctx.lineTo(tcx, tcy + 8);
        ctx.stroke();
      }

      // Tracking label
      const trackLabel = `TRACKING: ${trackingInfo.target || 'target'}`;
      ctx.font = '10px monospace';
      const tlw = ctx.measureText(trackLabel).width + 10;
      ctx.fillStyle = 'rgba(245,158,11,0.8)';
      ctx.fillRect(W - tlw - 8, H - 56, tlw, 16);
      ctx.fillStyle = '#000';
      ctx.fillText(trackLabel, W - tlw - 3, H - 44);
    }

    // ── Crosshair on primary person ──
    const target = persons[0];
    if (target?.center && !trackingInfo?.enabled) {
      const cx = target.center.x * W, cy = target.center.y * H;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 6, cy);
      ctx.moveTo(cx + 6, cy); ctx.lineTo(cx + 20, cy);
      ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 6);
      ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 20);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239,68,68,0.6)';
      ctx.stroke();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons, visionData, visionAge, trackingInfo]);

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video rounded-xl overflow-hidden bg-zinc-950 border border-zinc-800"
    >
      {/* Browser-native video — 30fps, zero latency */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover ${isStreaming ? '' : 'hidden'}`}
      />

      {/* No feed fallback */}
      {!isStreaming && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <div className="text-zinc-600 text-sm font-mono tracking-widest uppercase">
            Waiting for feed...
          </div>
        </div>
      )}

      {/* Canvas overlay */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />

      {/* Top-left: LIVE indicator + camera picker */}
      <div className="absolute top-3 left-3 flex items-center gap-2 z-30">
        <div className="flex items-center gap-2 rounded-md bg-black/60 px-2.5 py-1 backdrop-blur-sm">
          {isStreaming ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-green-400 text-xs font-mono font-bold tracking-widest">LIVE</span>
            </>
          ) : (
            <>
              <span className="inline-flex rounded-full h-2 w-2 bg-zinc-600" />
              <span className="text-zinc-500 text-xs font-mono font-bold tracking-widest">OFFLINE</span>
            </>
          )}
        </div>

        {/* Camera switcher — always visible, cycles through available cameras */}
        {cameras.length > 1 ? (
          <button
            onClick={() => {
              const currentIdx = cameras.findIndex(c => c.deviceId === selectedCamera);
              const nextIdx = (currentIdx + 1) % cameras.length;
              setSelectedCamera(cameras[nextIdx].deviceId);
            }}
            className="rounded-md bg-black/60 border border-zinc-600 px-2.5 py-1 backdrop-blur-sm text-cyan-400 text-[10px] font-mono font-bold hover:bg-zinc-700/60 hover:text-white transition-colors tracking-wider"
          >
            {cameras.find(c => c.deviceId === selectedCamera)?.label.includes('Logitech')
              ? 'GIMBAL CAM'
              : cameras.find(c => c.deviceId === selectedCamera)?.label.slice(0, 12).toUpperCase()
              || 'LAPTOP CAM'
            } &#x21C4;
          </button>
        ) : (
          <span className="rounded-md bg-black/60 px-2 py-1 text-zinc-600 text-[10px] font-mono tracking-wider">
            1 CAM
          </span>
        )}
      </div>

      {/* Top-right: counts */}
      <div className="absolute top-3 right-3 flex items-center gap-3 rounded-md bg-black/60 px-2.5 py-1 backdrop-blur-sm z-30">
        <div className="flex items-center gap-1.5">
          <svg className="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
          </svg>
          <span className="text-green-400 text-xs font-mono font-bold">{peopleCount}</span>
        </div>
        {cvActive && (
          <span className="text-emerald-500 text-[9px] font-mono font-bold tracking-wider">CV</span>
        )}
      </div>

      {/* Scan line effect */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
        }}
      />
    </div>
  );
}
