#!/usr/bin/env python3
"""
SENTINEL - Local Controller
Runs directly on the laptop. Handles: webcam capture, local CV processing
(pose + face detection), serial communication with Arduino, Gemini Vision
analysis, and relaying commands from the Next.js dashboard.

The local VisionEngine runs on every capture for instant person/face detection,
while Gemini provides periodic semantic analysis (activity, objects, scene).
Both are merged into a single perception payload sent to the dashboard.
"""

import cv2
import base64
import json
import time
import serial
import threading
import requests
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
import os
from dotenv import load_dotenv

load_dotenv('sentinel/.env.local')

from vision_engine import VisionEngine, GeminiAnalyzer


def auto_detect_arduino():
    """Auto-detect Arduino serial port."""
    import glob
    patterns = ['/dev/ttyACM*', '/dev/ttyUSB*', '/dev/ttyS*']  # Linux
    if os.name == 'nt':
        patterns = ['COM*']  # Windows
    for pattern in patterns:
        ports = glob.glob(pattern)
        if ports:
            return ports[0]
    return '/dev/ttyACM0'  # fallback


# ===== CONFIGURATION =====
ARDUINO_PORT = os.getenv('ARDUINO_PORT', auto_detect_arduino())
ARDUINO_BAUD = 115200
CAMERA_INDEX = int(os.getenv('CAMERA_INDEX', '0'))
CAPTURE_INTERVAL = float(os.getenv('CAPTURE_INTERVAL', '0.5'))
GEMINI_INTERVAL = float(os.getenv('GEMINI_INTERVAL', '3.0'))
SERVER_URL = os.getenv('SENTINEL_SERVER', 'http://localhost:3000/api/sentinel')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'pose_landmarker_lite.task')
LOCAL_CV_ENABLED = os.getenv('LOCAL_CV', '1') == '1'

# ===== GLOBAL STATE =====
latest_sensor_data = {}
latest_frame = None
latest_frame_b64 = None
latest_local_cv = None
camera = None
arduino = None
running = True
vision_engine = None

# Browser-sent frame (set by /analyze, read by perception_loop)
latest_browser_frame = None
latest_browser_frame_b64 = None
latest_browser_cv = None
latest_gemini_cache = None  # Latest Gemini result, shared with /analyze handler

# Tracking mode — when enabled, gimbal follows a target
tracking_enabled = False
tracking_target_id = 1  # person ID for CV-based tracking
tracking_target_desc = None  # string description for Gemini-based tracking (e.g., "right hand", "water bottle")
tracking_last_bbox = None  # (x, y, w, h) normalized — last known position for template tracking
tracking_template = None  # cropped template image for OpenCV tracking between Gemini calls
tracking_last_gemini = 0  # timestamp of last Gemini locate call

# Predictive tracking state
tracking_last_cx = 0.5   # last known center x
tracking_last_cy = 0.5   # last known center y
tracking_vx = 0.0        # velocity x (normalized units/sec)
tracking_vy = 0.0        # velocity y
tracking_last_seen = 0.0 # timestamp when target was last seen
tracking_lost_steps = 0  # how many search steps taken since losing target


def init_camera():
    """Initialize webcam capture."""
    global camera
    camera = cv2.VideoCapture(CAMERA_INDEX)
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_FPS, 15)
    if not camera.isOpened():
        print("ERROR: Cannot open camera index 0. Trying index 1...")
        camera = cv2.VideoCapture(1)
    print(f"Camera initialized: {camera.isOpened()}")


def init_vision_engine():
    """Initialize the local CV engine (MediaPipe Pose + Face detection)."""
    global vision_engine
    if not LOCAL_CV_ENABLED:
        print("Local CV disabled (set LOCAL_CV=1 to enable)")
        return
    if not os.path.exists(MODEL_PATH):
        print(f"WARNING: Pose model not found at {MODEL_PATH} — local CV disabled")
        print("  Download from: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task")
        return
    try:
        vision_engine = VisionEngine(
            model_path=MODEL_PATH,
            max_poses=5,
            face_detection_interval=2,  # faster face detection for tracking
        )
        print("VisionEngine initialized (MediaPipe Pose + Haar Face)")
    except Exception as e:
        print(f"VisionEngine init failed: {e} — running without local CV")


def init_arduino():
    """Connect to Arduino over serial."""
    global arduino
    try:
        arduino = serial.Serial(ARDUINO_PORT, ARDUINO_BAUD, timeout=1)
        time.sleep(2)  # Wait for Arduino reset
        print(f"Arduino connected on {ARDUINO_PORT}")
        line = arduino.readline().decode('utf-8', errors='ignore').strip()
        print(f"Arduino says: {line}")
    except Exception as e:
        print(f"Arduino connection failed: {e}")
        print("Running in SIMULATION mode — no physical hardware")
        arduino = None


def send_arduino_command(cmd):
    """Send a command string to Arduino."""
    if arduino and arduino.is_open:
        arduino.write(f"{cmd}\n".encode())
    else:
        print(f"[SIM] Arduino command: {cmd}")


def read_arduino_data():
    """Continuously read sensor data from Arduino (runs in thread)."""
    global latest_sensor_data
    while running:
        try:
            if arduino and arduino.in_waiting > 0:
                line = arduino.readline().decode('utf-8', errors='ignore').strip()
                if line.startswith('{'):
                    latest_sensor_data = json.loads(line)
            else:
                time.sleep(0.05)
        except (json.JSONDecodeError, serial.SerialException):
            pass
        except Exception as e:
            print(f"Serial read error: {e}")
            time.sleep(0.1)


def capture_frame():
    """Capture a frame from the webcam and return (raw_frame, base64_jpeg)."""
    global latest_frame, latest_frame_b64
    if camera and camera.isOpened():
        ret, frame = camera.read()
        if ret:
            latest_frame = frame
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            latest_frame_b64 = base64.b64encode(buffer).decode('utf-8')
            return frame, latest_frame_b64
    return None, None


def perception_loop():
    """
    Fast perception loop — local CV runs every CAPTURE_INTERVAL (0.5s),
    Gemini runs async in background every GEMINI_INTERVAL (3s).
    Each tick sends a perception update to the dashboard immediately.
    """
    global latest_local_cv, latest_gemini_cache
    global tracking_last_cx, tracking_last_cy, tracking_vx, tracking_vy
    global tracking_last_seen, tracking_lost_steps
    frame_ts = 0

    # Gemini runs in background thread, never blocks the loop
    gemini = None
    if GEMINI_API_KEY:
        gemini = GeminiAnalyzer(api_key=GEMINI_API_KEY, interval=GEMINI_INTERVAL)

    # Track latest Gemini result + age for staleness
    latest_gemini = None
    gemini_received_at = 0

    while running:
        try:
            # Use the latest frame sent by the browser via /analyze
            frame = latest_browser_frame
            frame_b64 = latest_browser_frame_b64
            if frame is None:
                time.sleep(0.5)
                continue

            frame_ts += int(CAPTURE_INTERVAL * 1000)
            now = time.time()

            # ── Local CV — already processed by /analyze handler ──
            local_cv_data = latest_browser_cv
            if local_cv_data:
                latest_local_cv = local_cv_data

            # ── Continuous tracking with prediction and search ──
            if tracking_enabled and frame is not None and arduino:
                track_cx, track_cy = _get_tracking_center(
                    frame, local_cv_data, now
                )
                cur_pan = latest_sensor_data.get('p', 90)
                cur_tilt = latest_sensor_data.get('t', 70)

                if track_cx is not None:
                    # ── Target found — update velocity and follow ──
                    dt = now - tracking_last_seen if tracking_last_seen > 0 else 0.5
                    if dt > 0 and dt < 2.0:  # reasonable time delta
                        # Exponential smoothing on velocity
                        alpha = 0.4
                        raw_vx = (track_cx - tracking_last_cx) / dt
                        raw_vy = (track_cy - tracking_last_cy) / dt
                        tracking_vx = alpha * raw_vx + (1 - alpha) * tracking_vx
                        tracking_vy = alpha * raw_vy + (1 - alpha) * tracking_vy

                    tracking_last_cx = track_cx
                    tracking_last_cy = track_cy
                    tracking_last_seen = now
                    tracking_lost_steps = 0

                    # Predictive offset: lead the target slightly based on velocity
                    lead_time = 0.15  # seconds to predict ahead
                    pred_cx = track_cx + tracking_vx * lead_time
                    pred_cy = track_cy + tracking_vy * lead_time

                    offset_x = pred_cx - 0.5
                    offset_y = pred_cy - 0.5
                    dist = (offset_x ** 2 + offset_y ** 2) ** 0.5

                    if dist > 0.02:
                        gain = 50 if dist > 0.2 else 35
                        new_pan = int(max(0, min(180, cur_pan - offset_x * gain)))
                        new_tilt = int(max(20, min(130, cur_tilt + offset_y * gain * 0.7)))
                        send_arduino_command(f"MOVE:{new_pan},{new_tilt}")

                else:
                    # ── Target lost — search in last known direction ──
                    time_lost = now - tracking_last_seen if tracking_last_seen > 0 else 0
                    if time_lost > 0.5 and time_lost < 10.0:
                        tracking_lost_steps += 1

                        # Move in the direction of last velocity (where they were going)
                        # Each step moves ~8 degrees in that direction
                        step_size = 8
                        if abs(tracking_vx) > 0.05 or abs(tracking_vy) > 0.05:
                            # Follow velocity direction
                            pan_step = -step_size if tracking_vx > 0 else step_size if tracking_vx < 0 else 0
                            tilt_step = step_size * 0.5 if tracking_vy > 0 else -step_size * 0.5 if tracking_vy < 0 else 0
                        else:
                            # No velocity info — search toward last known side
                            pan_step = -step_size if tracking_last_cx > 0.5 else step_size
                            tilt_step = 0

                        new_pan = int(max(0, min(180, cur_pan + pan_step)))
                        new_tilt = int(max(20, min(130, cur_tilt + tilt_step)))
                        send_arduino_command(f"MOVE:{new_pan},{new_tilt}")

                    elif time_lost >= 10.0:
                        # Lost for too long — return to center and stop searching
                        if tracking_lost_steps > 0:
                            send_arduino_command("MOVE:90,70")
                            tracking_lost_steps = 0

            # ── Kick off Gemini in background (non-blocking) ──
            if gemini and gemini.should_analyze():
                gemini.analyze_async(frame)

            # ── Check for new Gemini results ──
            gemini_result = gemini.latest if gemini else None
            if gemini_result and gemini_result is not latest_gemini:
                latest_gemini = gemini_result
                latest_gemini_cache = gemini_result
                gemini_received_at = now

            # Calculate staleness (seconds since last Gemini result)
            gemini_age = round(now - gemini_received_at, 1) if gemini_received_at > 0 else None

            # ── Merge Gemini semantics onto local CV persons ──
            # Instead of sending raw Gemini bboxes (which are stale),
            # match Gemini labels to the nearest local CV tracked person.
            enriched_persons = None
            if local_cv_data and latest_gemini:
                enriched_persons = _enrich_cv_with_gemini(
                    local_cv_data.get('persons', []),
                    latest_gemini
                )

            # ── Build perception payload ──
            perception = {
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'device_id': 'sentinel-001',
                'vision': latest_gemini,
                'vision_age': gemini_age,
                'local_cv': local_cv_data,
                'enriched_persons': enriched_persons,
                'sensors': latest_sensor_data,
                'frame_b64': frame_b64,
            }

            try:
                requests.post(
                    f'{SERVER_URL}/perception',
                    json=perception,
                    timeout=5,
                )
            except requests.exceptions.RequestException as e:
                print(f"Failed to send to server: {e}")

            # Status line (only print every ~2.5s to avoid spam)
            if frame_ts % int(GEMINI_INTERVAL * 1000) < int(CAPTURE_INTERVAL * 1000) + 1:
                cv_people = local_cv_data['person_count'] if local_cv_data else '?'
                cv_faces = local_cv_data['face_count'] if local_cv_data else '?'
                gemini_status = f"age={gemini_age}s" if gemini_age is not None else 'waiting'
                print(
                    f"[{datetime.now().strftime('%H:%M:%S')}] "
                    f"CV: {cv_people} bodies, {cv_faces} faces | "
                    f"Gemini: {gemini_status} | "
                    f"Front: {latest_sensor_data.get('d', {}).get('f', '?')}cm"
                )

            time.sleep(CAPTURE_INTERVAL)

        except Exception as e:
            print(f"Perception loop error: {e}")
            time.sleep(2)


def _enrich_cv_with_gemini(cv_persons, gemini_data):
    """
    Match Gemini semantic labels to local CV persons by proximity.
    Returns enriched person dicts with activity/facing/description attached.

    This solves the stale-bbox problem: instead of drawing Gemini's old
    coordinates, we anchor its labels onto the real-time tracked positions.
    """
    gemini_people = gemini_data.get('people', [])
    if not gemini_people or not cv_persons:
        return cv_persons

    enriched = []
    for cv_person in cv_persons:
        cv_cx = cv_person.get('center', {}).get('x', 0.5)
        cv_cy = cv_person.get('center', {}).get('y', 0.5)

        # Find closest Gemini person by center distance
        best_match = None
        best_dist = float('inf')
        for gp in gemini_people:
            gbbox = gp.get('bbox', {})
            gcx = gbbox.get('x', 0) + gbbox.get('width', 0) / 2
            gcy = gbbox.get('y', 0) + gbbox.get('height', 0) / 2
            dist = ((cv_cx - gcx) ** 2 + (cv_cy - gcy) ** 2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_match = gp

        # Only match if reasonably close (< 30% of frame diagonal)
        enriched_person = dict(cv_person)
        if best_match and best_dist < 0.3:
            enriched_person['gemini_activity'] = best_match.get('activity', '')
            enriched_person['gemini_facing'] = best_match.get('facing', '')
            enriched_person['gemini_description'] = best_match.get('description', '')
            enriched_person['gemini_distance'] = best_match.get('distance', '')
        enriched.append(enriched_person)

    return enriched


class CommandHandler(BaseHTTPRequestHandler):
    """HTTP server for receiving commands from the Next.js dashboard."""

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        global latest_browser_frame, latest_browser_frame_b64, latest_browser_cv
        global tracking_enabled, tracking_target_id, tracking_target_desc
        global tracking_last_bbox, tracking_template, tracking_last_gemini
        global tracking_last_cx, tracking_last_cy, tracking_vx, tracking_vy
        global tracking_last_seen, tracking_lost_steps
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

        if self.path == '/command':
            cmd = body.get('command', '')
            send_arduino_command(cmd)
            self._send_json({'ok': True})

        elif self.path == '/gimbal':
            pan = body.get('pan', 90)
            tilt = body.get('tilt', 90)
            send_arduino_command(f"MOVE:{pan},{tilt}")
            self._send_json({'ok': True, 'pan': pan, 'tilt': tilt})

        elif self.path == '/scan':
            action = body.get('action', 'start')
            send_arduino_command(f"SCAN:{'START' if action == 'start' else 'STOP'}")
            self._send_json({'ok': True})

        elif self.path == '/alert':
            color = body.get('color', 'green').upper()
            buzzer = body.get('buzzer', False)
            send_arduino_command(f"LED:{color}")
            send_arduino_command(f"BUZZ:{'ON' if buzzer else 'OFF'}")
            self._send_json({'ok': True})

        elif self.path == '/analyze':
            # Accept a base64 frame from the browser, run CV, return results
            frame_b64 = body.get('frame', '')
            if not frame_b64 or not vision_engine:
                self._send_json({'error': 'no frame or engine not ready'}, 400)
                return

            import numpy as np
            try:
                img_bytes = base64.b64decode(frame_b64)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is None:
                    self._send_json({'error': 'invalid image'}, 400)
                    return

                # Use monotonic timestamp for MediaPipe
                ts_ms = int(time.monotonic() * 1000)
                cv_result = vision_engine.process_frame(frame, ts_ms)
                local_cv = cv_result.to_dict()

                # Store frame + CV result for perception_loop to pick up
                latest_browser_frame = frame
                latest_browser_frame_b64 = frame_b64
                latest_browser_cv = local_cv

                # Enrich with latest Gemini data if available
                enriched = local_cv.get('persons', [])
                if latest_local_cv and latest_gemini_cache:
                    enriched = _enrich_cv_with_gemini(
                        local_cv.get('persons', []),
                        latest_gemini_cache
                    )

                self._send_json({
                    'ok': True,
                    'local_cv': local_cv,
                    'enriched_persons': enriched,
                    'tracking': {
                        'enabled': tracking_enabled,
                        'target': tracking_target_desc or (f'Person {tracking_target_id}' if tracking_enabled else None),
                        'bbox': tracking_last_bbox,
                    } if tracking_enabled else None,
                })
            except Exception as e:
                print(f"[analyze] Error: {e}")
                self._send_json({'error': str(e)}, 500)

        elif self.path == '/track':
            action = body.get('action', 'start')
            if action == 'start':
                tracking_enabled = True
                tracking_target_id = body.get('target_id', 1)
                tracking_target_desc = body.get('target_desc', None)
                tracking_last_bbox = None
                tracking_template = None
                tracking_last_gemini = 0
                tracking_last_cx = 0.5
                tracking_last_cy = 0.5
                tracking_vx = 0.0
                tracking_vy = 0.0
                tracking_last_seen = 0.0
                tracking_lost_steps = 0
                desc = tracking_target_desc or f'Person {tracking_target_id}'
                print(f"[track] Started tracking: {desc}")
                self._send_json({'ok': True, 'tracking': True, 'target': desc})
            else:
                tracking_enabled = False
                tracking_target_desc = None
                tracking_last_bbox = None
                tracking_template = None
                print("[track] Stopped tracking")
                self._send_json({'ok': True, 'tracking': False})

        elif self.path == '/register_face':
            name = body.get('name', '')
            image_b64 = body.get('image', '')
            if not name or not image_b64:
                self._send_json({'error': 'name and image required'}, 400)
                return
            import numpy as np
            try:
                img_bytes = base64.b64decode(image_b64)
                nparr = np.frombuffer(img_bytes, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is None:
                    self._send_json({'error': 'invalid image'}, 400)
                    return
                if vision_engine:
                    vision_engine.face_registry.register(name, img)
                    self._send_json({'ok': True, 'name': name})
                else:
                    self._send_json({'error': 'vision engine not ready'}, 503)
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        elif self.path == '/unregister_face':
            name = body.get('name', '')
            if vision_engine and name:
                vision_engine.face_registry.unregister(name)
            self._send_json({'ok': True})

        else:
            self._send_json({'error': 'unknown path'}, 404)

    def do_GET(self):
        if self.path == '/status':
            self._send_json({
                'sensors': latest_sensor_data,
                'camera': latest_browser_frame is not None,
                'arduino': arduino.is_open if arduino else False,
                'has_frame': latest_browser_frame_b64 is not None,
                'local_cv': latest_local_cv is not None,
                'tracking': {
                    'enabled': tracking_enabled,
                    'target': tracking_target_desc or (f'Person {tracking_target_id}' if tracking_enabled else None),
                    'last_bbox': tracking_last_bbox,
                } if tracking_enabled else None,
            })
        elif self.path == '/known_faces':
            names = vision_engine.face_registry.list_known() if vision_engine else []
            self._send_json({'faces': names})
        elif self.path == '/frame_b64':
            self._send_json({'frame_b64': latest_browser_frame_b64})
        else:
            self._send_json({'error': 'unknown path'}, 404)

    def log_message(self, format, *args):
        pass  # Suppress request logging


def _get_tracking_center(frame, local_cv_data, now):
    """
    Get the center (normalized 0-1) of whatever we're tracking.
    Returns (cx, cy) or (None, None) if target not found.
    """
    global tracking_last_bbox, tracking_template, tracking_last_gemini
    import numpy as np

    h, w = frame.shape[:2]

    if tracking_target_desc:
        # ── Arbitrary object tracking (Gemini + template matching) ──
        GEMINI_RELOCATE_INTERVAL = 3.0  # re-locate with Gemini every 3s

        # Try template matching first (fast, every frame)
        if tracking_template is not None and tracking_last_bbox is not None:
            lx, ly, lw, lh = tracking_last_bbox
            # Search in a region 2x the bbox size around last position
            search_x = max(0, int((lx - lw) * w))
            search_y = max(0, int((ly - lh) * h))
            search_x2 = min(w, int((lx + 2 * lw) * w))
            search_y2 = min(h, int((ly + 2 * lh) * h))
            search_region = frame[search_y:search_y2, search_x:search_x2]

            if search_region.size > 0 and tracking_template.shape[0] < search_region.shape[0] and tracking_template.shape[1] < search_region.shape[1]:
                result = cv2.matchTemplate(search_region, tracking_template, cv2.TM_CCOEFF_NORMED)
                _, max_val, _, max_loc = cv2.minMaxLoc(result)
                if max_val > 0.5:  # good enough match
                    th, tw = tracking_template.shape[:2]
                    cx = (search_x + max_loc[0] + tw / 2) / w
                    cy = (search_y + max_loc[1] + th / 2) / h
                    tracking_last_bbox = (cx - tw / (2 * w), cy - th / (2 * h), tw / w, th / h)
                    return cx, cy

        # Re-locate with Gemini (slower, every few seconds)
        if now - tracking_last_gemini >= GEMINI_RELOCATE_INTERVAL:
            tracking_last_gemini = now
            try:
                _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                img_b64 = base64.b64encode(buf).decode('utf-8')
                api_key = os.getenv('GEMINI_API_KEY', '')
                if api_key:
                    import requests as req
                    resp = req.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={api_key}",
                        json={
                            "contents": [{"parts": [
                                {"inlineData": {"mimeType": "image/jpeg", "data": img_b64}},
                                {"text": f'Locate "{tracking_target_desc}" in this frame. Return JSON only: {{"found":true,"x":0.0-1.0,"y":0.0-1.0,"w":0.0-1.0,"h":0.0-1.0}} where x,y is center and w,h is size. If not found: {{"found":false}}'},
                            ]}],
                            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 100},
                        },
                        timeout=5,
                    )
                    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                    parsed = json.loads(text.replace("```json", "").replace("```", "").strip())
                    if parsed.get("found"):
                        cx, cy = parsed["x"], parsed["y"]
                        bw = parsed.get("w", 0.1)
                        bh = parsed.get("h", 0.1)
                        tracking_last_bbox = (cx - bw / 2, cy - bh / 2, bw, bh)
                        # Crop template for subsequent frame-to-frame matching
                        tx = max(0, int((cx - bw / 2) * w))
                        ty = max(0, int((cy - bh / 2) * h))
                        tx2 = min(w, int((cx + bw / 2) * w))
                        ty2 = min(h, int((cy + bh / 2) * h))
                        if tx2 - tx > 10 and ty2 - ty > 10:
                            tracking_template = frame[ty:ty2, tx:tx2].copy()
                        return cx, cy
            except Exception as e:
                print(f"[track] Gemini locate error: {e}")

        return None, None

    else:
        # ── Person tracking via CV — prioritize face position ──
        if not local_cv_data:
            return None, None
        persons = local_cv_data.get('persons', [])
        target = None
        for p in persons:
            if p.get('id') == tracking_target_id:
                target = p
                break
        if not target and persons:
            target = persons[0]
        if not target:
            return None, None

        # Priority 1: nose landmark (index 0) — best for face tracking
        landmarks = target.get('landmarks', [])
        if landmarks and len(landmarks) > 0:
            nose = landmarks[0]  # MediaPipe landmark 0 = nose
            if nose.get('v', 0) > 0.5:
                return nose['x'], nose['y']

        # Priority 2: face bbox center (if this is a face-only detection)
        if target.get('landmark_count', 99) == 0 and target.get('center'):
            return target['center']['x'], target['center']['y']

        # Priority 3: shoulder midpoint (upper body, closer to face than hips)
        if landmarks and len(landmarks) > 12:
            l_shoulder = landmarks[11]
            r_shoulder = landmarks[12]
            if l_shoulder.get('v', 0) > 0.4 and r_shoulder.get('v', 0) > 0.4:
                cx = (l_shoulder['x'] + r_shoulder['x']) / 2
                cy = (l_shoulder['y'] + r_shoulder['y']) / 2 - 0.05  # shift up toward head
                return cx, cy

        # Fallback: body center
        if target.get('center'):
            return target['center']['x'], target['center']['y']
        return None, None


def sync_known_faces():
    """Load known faces from Next.js API (which reads MongoDB) on startup."""
    if not vision_engine:
        return
    import numpy as np
    try:
        res = requests.get(f'{SERVER_URL}/face?include_images=true', timeout=10)
        if res.status_code != 200:
            print("No known faces to sync (API not ready)")
            return
        faces = res.json().get('faces', [])
        if not faces:
            print("No known faces registered")
            return

        for face in faces:
            name = face.get('name', '')
            image_b64 = face.get('image', '')
            if name and image_b64:
                img_bytes = base64.b64decode(image_b64)
                nparr = np.frombuffer(img_bytes, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is not None:
                    vision_engine.face_registry.register(name, img)

        count = len(vision_engine.face_registry.list_known())
        if count > 0:
            print(f"Synced {count} known face(s) from database")
    except Exception as e:
        print(f"Face sync failed (non-critical): {e}")


def start_http_server(port=5000):
    server = HTTPServer(('0.0.0.0', port), CommandHandler)
    print(f"Command server listening on port {port}")
    server.serve_forever()


def main():
    global running

    print("=" * 50)
    print("SENTINEL - Autonomous Perception Station")
    print("  + VisionEngine (local CV processing)")
    print("=" * 50)

    # Browser owns the camera — no init_camera() needed
    init_vision_engine()
    init_arduino()
    sync_known_faces()

    # Start Arduino reader thread
    arduino_thread = threading.Thread(target=read_arduino_data, daemon=True)
    arduino_thread.start()

    # Start command server thread
    server_thread = threading.Thread(target=start_http_server, daemon=True)
    server_thread.start()

    try:
        send_arduino_command("MOVE:90,70")
        time.sleep(1)

        print("Starting perception loop...")
        perception_loop()
    except KeyboardInterrupt:
        print("\nShutting down SENTINEL...")
        running = False
        send_arduino_command("MOVE:90,70")
        send_arduino_command("LED:GREEN")
        send_arduino_command("BUZZ:OFF")
        if vision_engine:
            vision_engine.close()
        if arduino:
            arduino.close()


if __name__ == '__main__':
    main()
