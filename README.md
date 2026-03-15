# SENTINEL

**AI-Powered Autonomous Vision Monitoring Station**

A low-cost, real-time monitoring platform that combines a webcam, motorized gimbal, Arduino sensors, and multi-model AI to observe, understand, and respond to physical environments. Built for elderly care, fall detection, and general-purpose monitoring.

## What It Does

- **Real-time person detection** — MediaPipe Pose (33 landmarks per person at 2Hz) + Haar cascade face detection
- **Face recognition** — OpenFace deep embeddings identify known people in O(1) via matrix multiply
- **Fall detection** — CV-based scoring (torso angle, velocity, aspect ratio, shoulder-hip alignment) with temporal filtering to suppress false positives
- **Motorized tracking** — PID-controlled pan/tilt gimbal follows people smoothly with predictive motion
- **Mission system** — Plain-English instructions reconfigure the entire perception pipeline via Gemini
- **Multi-model AI** — Gemini Vision (scene understanding), Featherless/Llama (temporal analysis), ElevenLabs (voice)
- **Alerts** — Telegram with photo, text-to-speech, LED + buzzer, MongoDB event logging
- **Natural language chat** — Ask Sentinel questions about what it sees, who's in the room, etc.

## Architecture

```
Browser (webcam) ──frame──> Python Backend ──perception──> Next.js Dashboard
                              │                              │
                              ├─ VisionEngine (MediaPipe)    ├─ Gemini Vision (scene analysis)
                              ├─ FallDetector (CV scoring)   ├─ Mission Engine (custom intel)
                              ├─ FaceRegistry (OpenFace)     ├─ Trigger Evaluator (alerts)
                              └─ Arduino (gimbal/sensors)    ├─ Reasoning Engine (AI agent)
                                                             └─ Tools (20+ capabilities)
```

| Component | Stack |
|-----------|-------|
| Dashboard | Next.js 16, React, Tailwind CSS |
| Backend | Python 3, MediaPipe, OpenCV, Flask-style HTTP |
| Hardware | Arduino, 2x servos (pan/tilt), 3x ultrasonic, 2x IR beams, buzzer, LEDs |
| AI Models | Gemini 2.5 Flash Lite, Featherless Llama, ElevenLabs TTS |
| Database | MongoDB Atlas |
| Alerts | Telegram Bot API |

## Hardware

Total cost: **~$150**

- Webcam (laptop built-in or USB)
- Arduino Uno/Nano
- 2x SG90 servo motors (pan + tilt gimbal)
- 3x HC-SR04 ultrasonic sensors (front, left, right)
- 2x IR break-beam sensors
- Buzzer + LEDs
- 3D-printed or laser-cut gimbal mount

### Gimbal Limits

| Axis | Min | Max | Center |
|------|-----|-----|--------|
| Pan  | 0 (right) | 180 (left) | 90 |
| Tilt | 45 (up) | 135 (down) | 90 |

## Setup

### Prerequisites

- Node.js 18+ (recommend [fnm](https://github.com/Schniz/fnm))
- Python 3.11+
- Arduino IDE
- pnpm

### 1. Clone & Install

```bash
git clone https://github.com/Matusvec/baseSentinel.git
cd baseSentinel

# Next.js dashboard
cd sentinel
pnpm install
cd ..

# Python backend
python3 -m venv .venv
source .venv/bin/activate
pip install mediapipe opencv-python requests python-dotenv pyserial numpy
```

### 2. Download Models

```bash
# MediaPipe Pose Landmarker
curl -L -o pose_landmarker_lite.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task

# OpenFace embeddings (for face recognition)
curl -L -o openface_nn4.small2.v1.t7 \
  https://storage.cmusatyalab.org/openface-models/nn4.small2.v1.t7
```

### 3. Environment Variables

Create `sentinel/.env.local`:

```env
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_voice_id
FEATHERLESS_API_KEY=your_featherless_api_key
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/sentinel
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
PYTHON_URL=http://localhost:5000
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

### 4. Flash Arduino

Open `sentinel_arduino/sentinel_arduino.ino` in Arduino IDE, verify pin assignments match your wiring, and upload.

### 5. Run

```bash
# Terminal 1: Python backend
source .venv/bin/activate
python3 sentinel.py

# Terminal 2: Next.js dashboard
cd sentinel
pnpm dev
```

Open `http://localhost:3000` — the dashboard streams your webcam to the Python backend for CV processing.

## Tools

Sentinel exposes 20+ tools to its AI reasoning engine:

| Tool | Description |
|------|-------------|
| `fall_detection` | Start/stop real-time fall monitoring with automatic alerts |
| `search_for` | Scan room systematically looking for something specific |
| `full_sweep` | Comprehensive 21-position sweep with Gemini analysis |
| `start_tracking` | Follow a person or object with the gimbal |
| `move_gimbal` | Point camera at a specific pan/tilt angle |
| `create_mission` | Natural language mission that rewires the perception pipeline |
| `speak` | Text-to-speech via ElevenLabs |
| `send_telegram` | Send alert with optional photo to Telegram |
| `describe_scene` | Ask Gemini what it sees right now |
| `query_database` | Query MongoDB detection history |
| `manage_alerts` | Mute/unmute alert types |
| `capture_snapshot` | Save a timestamped photo |

## Fall Detection

The fall detection system uses **local CV scoring** (no LLM latency) with four signals:

| Signal | Weight | How |
|--------|--------|-----|
| Torso angle | 35% | Hip-to-shoulder vector angle from vertical |
| Vertical velocity | 20% | Sudden downward hip drop |
| Bbox aspect ratio | 20% | Width > height = likely fallen |
| Shoulder-hip alignment | 25% | Small Y difference = lying flat |

Temporal filtering prevents false positives:
- EMA smoothing (0.4 raw + 0.6 previous)
- Fall confirmed after **3 consecutive frames** above threshold (~1.5s)
- Fall clears after 5 frames below threshold
- Bending, sitting, and picking things up do NOT trigger alerts

## Project Structure

```
sentinel/
├── sentinel.py              # Python backend (CV, Arduino, tracking)
├── vision_engine.py         # MediaPipe pose, face detection, fall detector
├── sentinel/                # Next.js dashboard
│   ├── src/app/             # Pages and API routes
│   ├── src/lib/             # Core logic
│   │   ├── mission-engine.ts    # Mission creation and management
│   │   ├── trigger-evaluator.ts # Alert condition evaluation
│   │   ├── adaptive-storage.ts  # Smart document building
│   │   ├── reasoning-engine.ts  # AI agent with tool use
│   │   └── tools/               # 20+ tool implementations
│   └── src/components/      # React UI components
├── sentinel_arduino/        # Arduino firmware
└── Setup/                   # Hardware setup guides
```

## License

MIT
