#!/usr/bin/env python3
"""
SENTINEL - Raspberry Pi Controller
Handles: webcam capture, serial communication with Arduino,
         sending frames to Gemini API, relaying commands from web server.
"""

import cv2
import base64
import json
import time
import serial
import threading
import requests
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import os

# ===== CONFIGURATION =====
ARDUINO_PORT = os.getenv('ARDUINO_PORT', '/dev/ttyACM0')
ARDUINO_BAUD = 115200
CAMERA_INDEX = int(os.getenv('CAMERA_INDEX', '0'))
CAPTURE_INTERVAL = float(os.getenv('CAPTURE_INTERVAL', '2.5'))
SERVER_URL = os.getenv('SENTINEL_SERVER', 'http://localhost:3000/api/sentinel')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')

# ===== GLOBAL STATE =====
latest_sensor_data = {}
latest_frame = None
latest_frame_b64 = None
camera = None
arduino = None
running = True


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
    """Capture a frame from the webcam and return as base64 JPEG."""
    global latest_frame, latest_frame_b64
    if camera and camera.isOpened():
        ret, frame = camera.read()
        if ret:
            latest_frame = frame
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            latest_frame_b64 = base64.b64encode(buffer).decode('utf-8')
            return latest_frame_b64
    return None


def analyze_frame_with_gemini(image_base64):
    """Send frame to Gemini Vision API for analysis."""
    if not GEMINI_API_KEY:
        print("WARNING: No GEMINI_API_KEY set, skipping vision analysis")
        return None

    try:
        response = requests.post(
            f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={GEMINI_API_KEY}',
            headers={'Content-Type': 'application/json'},
            json={
                'contents': [{
                    'parts': [
                        {'inlineData': {'mimeType': 'image/jpeg', 'data': image_base64}},
                        {'text': '''Analyze this camera frame from an autonomous monitoring system. Identify all people and notable objects.

For each person, provide approximate bounding box as normalized coordinates (0-1).

Respond ONLY in JSON (no markdown):
{
  "people": [{"id": 1, "bbox": {"x": 0.3, "y": 0.2, "width": 0.15, "height": 0.5}, "distance": "near", "activity": "standing", "description": "short description", "facing": "toward_camera"}],
  "objects": [{"label": "laptop", "bbox": {"x": 0.5, "y": 0.6, "width": 0.1, "height": 0.08}}],
  "environment": {"crowd_density": "sparse", "activity_level": "moderate", "scene_description": "one sentence"},
  "motion_detected": false
}'''}
                    ]
                }],
                'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 1000},
            },
            timeout=10,
        )

        data = response.json()
        text = data['candidates'][0]['content']['parts'][0]['text']
        return json.loads(text.replace('```json', '').replace('```', '').strip())
    except Exception as e:
        print(f"Gemini API error: {e}")
        return None


def perception_loop():
    """Main loop: capture frame -> analyze -> send to web server."""
    while running:
        try:
            frame_b64 = capture_frame()
            if not frame_b64:
                time.sleep(1)
                continue

            vision = analyze_frame_with_gemini(frame_b64)

            perception = {
                'timestamp': datetime.utcnow().isoformat() + 'Z',
                'device_id': 'sentinel-001',
                'vision': vision,
                'sensors': latest_sensor_data,
                'frame_full': frame_b64,
            }

            try:
                requests.post(
                    f'{SERVER_URL}/perception',
                    json=perception,
                    timeout=5,
                )
            except requests.exceptions.RequestException as e:
                print(f"Failed to send to server: {e}")

            people_count = len(vision.get('people', [])) if vision else 0
            print(
                f"[{datetime.now().strftime('%H:%M:%S')}] "
                f"People: {people_count} | "
                f"Front: {latest_sensor_data.get('d', {}).get('f', '?')}cm | "
                f"Gimbal: P{latest_sensor_data.get('p', '?')} T{latest_sensor_data.get('t', '?')}"
            )

            time.sleep(CAPTURE_INTERVAL)

        except Exception as e:
            print(f"Perception loop error: {e}")
            time.sleep(2)


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

        else:
            self._send_json({'error': 'unknown path'}, 404)

    def do_GET(self):
        if self.path == '/status':
            self._send_json({
                'sensors': latest_sensor_data,
                'camera': camera.isOpened() if camera else False,
                'arduino': arduino.is_open if arduino else False,
                'has_frame': latest_frame_b64 is not None,
            })
        elif self.path == '/frame':
            self._send_json({
                'frame': latest_frame_b64,
                'sensors': latest_sensor_data,
            })
        else:
            self._send_json({'error': 'unknown path'}, 404)

    def log_message(self, format, *args):
        pass  # Suppress request logging


def start_http_server(port=5000):
    server = HTTPServer(('0.0.0.0', port), CommandHandler)
    print(f"Command server listening on port {port}")
    server.serve_forever()


def main():
    global running

    print("=" * 50)
    print("SENTINEL - Autonomous Perception Station")
    print("=" * 50)

    init_camera()
    init_arduino()

    # Start Arduino reader thread
    arduino_thread = threading.Thread(target=read_arduino_data, daemon=True)
    arduino_thread.start()

    # Start command server thread
    server_thread = threading.Thread(target=start_http_server, daemon=True)
    server_thread.start()

    try:
        send_arduino_command("MOVE:90,90")
        time.sleep(1)

        print("Starting perception loop...")
        perception_loop()
    except KeyboardInterrupt:
        print("\nShutting down SENTINEL...")
        running = False
        send_arduino_command("MOVE:90,90")
        send_arduino_command("LED:GREEN")
        send_arduino_command("BUZZ:OFF")
        if camera:
            camera.release()
        if arduino:
            arduino.close()


if __name__ == '__main__':
    main()
