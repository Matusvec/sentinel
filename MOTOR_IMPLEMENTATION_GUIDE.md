# SENTINEL Motor Implementation Guide

> **For:** The teammate building the Arduino Uno hardware for camera pan/tilt control.
> **Status:** Software is ready. Once the Arduino is plugged in via USB, it works.

---

## TL;DR — What the Arduino Needs to Do

1. Listen on serial at **115200 baud**
2. Parse commands like `MOVE:120,70\n`
3. Drive two servos (pan + tilt) to the requested angles
4. Optionally send sensor JSON back over serial

That's it. The entire software stack (AI reasoning → tool call → HTTP → serial) is already wired up.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  GEMINI AI (reasoning engine)                                   │
│  Decides: "I should look left" → calls move_gimbal(pan:30,tilt:90) │
└──────────┬──────────────────────────────────────────────────────┘
           │  JSON tool call
           ▼
┌──────────────────────────────────┐
│  Next.js Tool: move_gimbal       │
│  src/lib/tools/move-gimbal.tool  │
│  POST http://localhost:5000/gimbal │
│  Body: { "pan": 30, "tilt": 90 }  │
└──────────┬───────────────────────┘
           │  HTTP POST
           ▼
┌──────────────────────────────────┐
│  Python Server (sentinel.py)     │
│  Port 5000, CommandHandler       │
│  Converts to: "MOVE:30,90\n"    │
│  Sends over serial               │
└──────────┬───────────────────────┘
           │  USB Serial (115200 baud)
           ▼
┌──────────────────────────────────┐
│  Arduino Uno                     │
│  Parses "MOVE:30,90"            │
│  Drives pan servo to 30°         │
│  Drives tilt servo to 90°        │
└──────────────────────────────────┘
```

---

## Serial Protocol — Commands the Arduino Will Receive

The Python server (`sentinel.py` lines 120-125, 325-329) sends these string commands over serial, each terminated with `\n`:

| Command | Format | Example | Description |
|---------|--------|---------|-------------|
| **Move gimbal** | `MOVE:{pan},{tilt}` | `MOVE:120,70` | Move pan servo to 120°, tilt servo to 70° |
| **Start scan** | `SCAN:START` | `SCAN:START` | Begin autonomous sweep pattern |
| **Stop scan** | `SCAN:STOP` | `SCAN:STOP` | Stop sweep, hold current position |
| **Set LED** | `LED:{COLOR}` | `LED:RED` | Set indicator LED (GREEN, YELLOW, RED) |
| **Buzzer** | `BUZZ:{STATE}` | `BUZZ:ON` | Toggle buzzer (ON, OFF) |
| **Raw** | Any string | `RESET` | Passthrough for custom commands |

### Gimbal Angle Ranges

These are clamped in the software before reaching the Arduino:

| Axis | Min | Center | Max | Direction |
|------|-----|--------|-----|-----------|
| **Pan** | 0° | 90° | 180° | 0 = full left, 180 = full right |
| **Tilt** | 45° | 90° | 135° | 45 = looking up, 135 = looking down |

The clamping happens in the TypeScript tool (`move-gimbal.tool.ts` line 14-15):
```typescript
const pan = Math.max(0, Math.min(180, params.pan as number));
const tilt = Math.max(45, Math.min(135, params.tilt as number));
```

---

## Serial Protocol — What the Arduino Should Send Back

The Python server (`sentinel.py` lines 128-143) reads JSON lines from the Arduino for sensor data. Send one JSON object per line:

```json
{"d":{"f":120,"l":85,"r":200},"ir":{"a":0,"b":0},"s":412,"t":22.5,"p":1013}
```

| Field | Meaning | Type |
|-------|---------|------|
| `d.f` | Front ultrasonic distance (cm) | number |
| `d.l` | Left ultrasonic distance (cm) | number |
| `d.r` | Right ultrasonic distance (cm) | number |
| `ir.a` | IR beam A (0=clear, 1=broken) | number |
| `ir.b` | IR beam B (0=clear, 1=broken) | number |
| `s` | Sound level (0-1023 analog) | number |
| `t` | Temperature (°C, optional) | number |
| `p` | Pressure (hPa, optional) | number |

**You don't need ALL sensors.** The system handles missing fields gracefully. At minimum, just handling `MOVE` commands is enough.

---

## Arduino Sketch — Minimal Working Example

This is the minimum viable firmware to get pan/tilt working:

```cpp
#include <Servo.h>

Servo panServo;
Servo tiltServo;

const int PAN_PIN = 9;
const int TILT_PIN = 10;

// Current positions
int panPos = 90;
int tiltPos = 90;

void setup() {
  Serial.begin(115200);
  panServo.attach(PAN_PIN);
  tiltServo.attach(TILT_PIN);

  // Center on startup
  panServo.write(90);
  tiltServo.write(90);

  Serial.println("{\"status\":\"ready\"}");
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd.startsWith("MOVE:")) {
      // Parse "MOVE:pan,tilt"
      int commaIdx = cmd.indexOf(',', 5);
      if (commaIdx > 5) {
        int pan = cmd.substring(5, commaIdx).toInt();
        int tilt = cmd.substring(commaIdx + 1).toInt();

        // Clamp values
        pan = constrain(pan, 0, 180);
        tilt = constrain(tilt, 45, 135);

        panServo.write(pan);
        tiltServo.write(tilt);
        panPos = pan;
        tiltPos = tilt;
      }
    }
    else if (cmd.startsWith("SCAN:START")) {
      // Implement sweep pattern (optional)
    }
    else if (cmd.startsWith("SCAN:STOP")) {
      // Stop sweep (optional)
    }
    else if (cmd.startsWith("LED:")) {
      // Handle LED color (optional)
    }
    else if (cmd.startsWith("BUZZ:")) {
      // Handle buzzer (optional)
    }
  }
}
```

### Wiring

| Component | Arduino Pin |
|-----------|-------------|
| Pan servo signal | D9 |
| Tilt servo signal | D10 |
| Servo power (5V) | 5V or external 5V supply |
| Servo ground | GND |

**Important:** If using two standard servos, power them from an external 5V supply (not the Arduino's 5V pin) to avoid brownouts. Share ground with the Arduino.

---

## How the AI Agent Calls Motor Tools

The AI doesn't think in terms of "turn left" — it thinks in degrees. But the prompt gives it semantic understanding:

From `move-gimbal.tool.ts`:
```
move_gimbal [hardware]: Move the camera gimbal to a specific pan/tilt angle.
  Pan: 0-180 (left to right). Tilt: 45-135 (up to down). Center is 90/90.
    - pan (number, required): Pan angle 0-180 degrees
    - tilt (number, required): Tilt angle 45-135 degrees
```

The AI will generate tool calls like:
```json
{
  "tool": "move_gimbal",
  "params": { "pan": 30, "tilt": 90 }
}
```

**Example AI reasoning chains:**
- User: "Look left" → `move_gimbal(pan: 30, tilt: 90)`
- User: "Check the ceiling" → `move_gimbal(pan: 90, tilt: 45)`
- User: "Scan the room" → `move_gimbal(pan: 0, tilt: 90)` then later `move_gimbal(pan: 180, tilt: 90)`
- Perception trigger: person detected on the right → `move_gimbal(pan: 150, tilt: 80)` + `speak("Tracking movement to the right")`

---

## Auto-Detection

The Python server auto-detects the Arduino USB port (`sentinel.py` lines 30-40):

```python
# Linux: tries /dev/ttyACM*, /dev/ttyUSB*, /dev/ttyS*
# Windows: tries COM*
# Override with env var: ARDUINO_PORT=/dev/ttyACM0
```

You can also force a specific port:
```bash
ARDUINO_PORT=/dev/ttyACM0 python sentinel.py
```

---

## Testing Without the Full Stack

### Test serial directly (from laptop terminal):
```bash
# Find the port
ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null

# Connect with screen or minicom
screen /dev/ttyACM0 115200

# Type commands manually:
MOVE:0,90
MOVE:180,90
MOVE:90,45
MOVE:90,135
```

### Test via the Python server (no Next.js needed):
```bash
# Start just the Python server
python sentinel.py

# In another terminal, send HTTP commands
curl -X POST http://localhost:5000/gimbal \
  -H "Content-Type: application/json" \
  -d '{"pan": 45, "tilt": 90}'
```

### Test via the Next.js dashboard (full stack):
```bash
# Terminal 1: Python server
python sentinel.py

# Terminal 2: Next.js
cd sentinel && pnpm dev

# The AI can now call move_gimbal via chat:
# "Hey SENTINEL, look to the left"
```

---

## Graceful Degradation

The system is designed to work without hardware connected:

- **Python server unreachable:** Tool returns `{ success: false, error: "Hardware unreachable" }` — the AI gets this feedback and can tell the user
- **Arduino not connected:** Python server prints `[SIM] Arduino command: MOVE:90,90` to console — commands are logged but nothing moves
- **Command route fallback:** Returns `{ ok: true, hardware: false, simulated: true }` so the dashboard stays operational

This means the entire AI, dashboard, missions, and reasoning all work while the Arduino is being built. Once you plug it in, it just starts responding.

---

## Startup Behavior

On startup (`sentinel.py` line 508), the system sends:
```
MOVE:90,90
```
This centers the camera. On shutdown (Ctrl+C), it also re-centers and turns off the LED/buzzer.

---

## Files You'll Care About

| File | What It Does | Why It Matters |
|------|-------------|----------------|
| `sentinel.py` lines 105-125 | Arduino init + serial send | Where serial commands are sent |
| `sentinel.py` lines 299-342 | HTTP command handler | `/gimbal`, `/alert`, `/scan` endpoints |
| `sentinel/src/lib/tools/move-gimbal.tool.ts` | AI tool definition | What the AI "sees" and how it calls hardware |
| `sentinel/src/lib/tools/set-alert.tool.ts` | LED/buzzer tool | Same pattern for alert hardware |
| `sentinel/src/app/api/sentinel/command/route.ts` | Next.js → Python bridge | HTTP relay from dashboard to Python |

---

## Summary of What's Already Done (Software) vs What You Need (Hardware)

| Layer | Status |
|-------|--------|
| AI tool definition (`move_gimbal`) | Done |
| AI prompt (understands pan/tilt semantics) | Done |
| Reasoning engine (decides when to move) | Done |
| Next.js API route (`/command`) | Done |
| Python HTTP server (`/gimbal` endpoint) | Done |
| Serial write (`MOVE:pan,tilt`) | Done |
| Serial auto-detection | Done |
| Graceful fallback when hardware absent | Done |
| **Arduino firmware (parse + drive servos)** | **You** |
| **Physical servo wiring** | **You** |
| **Sensor reading + JSON serial output** | **Optional** |
