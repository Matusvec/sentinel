#!/usr/bin/env python3
"""
SENTINEL Vision Test — Real-time pose estimation + face detection + Gemini AI overlay.

Uses VisionEngine for all local CV processing. This script adds the interactive
preview window with HUD and Gemini overlay drawing.

Usage:
    source venv/bin/activate
    python test_vision.py

Controls:
    q     — quit
    SPACE — force Gemini analysis
    g     — toggle Gemini overlay on/off
    f     — toggle face detection on/off
    s     — save current frame as screenshot
"""

import cv2
import os
import time
from dotenv import load_dotenv

from vision_engine import VisionEngine, GeminiAnalyzer

# Load API key from sentinel/.env.local
load_dotenv("sentinel/.env.local")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found — check sentinel/.env.local")


def draw_gemini_overlays(frame, analysis: dict, cv_result=None, gemini_age: float = 0) -> None:
    """
    Draw Gemini AI analysis — anchored to local CV persons when available.

    Instead of drawing Gemini's stale bounding boxes (which are wrong after
    camera movement), we match Gemini labels to the nearest CV-tracked person
    and draw the label at their CURRENT position.
    """
    h, w = frame.shape[:2]

    # Fade overlays based on age (stale data gets transparent)
    alpha = max(0.3, 1.0 - gemini_age / 8.0)
    person_color = tuple(int(c * alpha) for c in (255, 0, 255))
    obj_color = tuple(int(c * alpha) for c in (255, 150, 0))
    text_color = tuple(int(c * alpha) for c in (200, 200, 200))

    gemini_people = analysis.get("people", [])

    if cv_result and cv_result.persons:
        # ── Anchor Gemini labels to local CV tracked persons ──
        for cv_person in cv_result.persons:
            cv_cx = cv_person.center[0]
            cv_cy = cv_person.center[1]

            # Find closest Gemini person
            best_match = None
            best_dist = float('inf')
            for gp in gemini_people:
                gbbox = gp.get("bbox", {})
                gcx = gbbox.get("x", 0) + gbbox.get("width", 0) / 2
                gcy = gbbox.get("y", 0) + gbbox.get("height", 0) / 2
                dist = ((cv_cx - gcx) ** 2 + (cv_cy - gcy) ** 2) ** 0.5
                if dist < best_dist:
                    best_dist = dist
                    best_match = gp

            if best_match and best_dist < 0.3:
                # Draw Gemini label at the CV person's current bbox
                bbox = cv_person.bbox
                bx1 = int(bbox["x"] * w)
                by2 = int((bbox["y"] + bbox["height"]) * h)
                info = f"{best_match.get('activity', '?')} | {best_match.get('facing', '?')}"
                cv2.putText(frame, info, (bx1 + 2, by2 + 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, person_color, 1, cv2.LINE_AA)
    else:
        # No local CV — fall back to drawing Gemini bboxes directly (with fade)
        for person in gemini_people:
            bbox = person.get("bbox", {})
            x1 = int(bbox.get("x", 0) * w)
            y1 = int(bbox.get("y", 0) * h)
            x2 = int((bbox.get("x", 0) + bbox.get("width", 0)) * w)
            y2 = int((bbox.get("y", 0) + bbox.get("height", 0)) * h)
            cv2.rectangle(frame, (x1, y1), (x2, y2), person_color, 1)
            info = f"{person.get('activity', '?')} | {person.get('facing', '?')}"
            cv2.putText(frame, info, (x1 + 2, y2 + 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, person_color, 1, cv2.LINE_AA)

    # ── Objects — render as scene tags at bottom (not at stale positions) ──
    objects = analysis.get("objects", [])
    if objects:
        tag_x = 8
        tag_y = h - 50
        for obj in objects:
            label = obj.get("label", "?")
            lsz, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            pill_w = lsz[0] + 12
            cv2.rectangle(frame, (tag_x, tag_y), (tag_x + pill_w, tag_y + 18),
                          (0, 0, 0), -1)
            cv2.rectangle(frame, (tag_x, tag_y), (tag_x + pill_w, tag_y + 18),
                          obj_color, 1)
            cv2.putText(frame, label, (tag_x + 6, tag_y + 13),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, obj_color, 1, cv2.LINE_AA)
            tag_x += pill_w + 6
            if tag_x > w - 60:
                break

    # ── Scene description ──
    env = analysis.get("environment", {})
    scene = env.get("scene_description", "")
    if scene:
        cv2.rectangle(frame, (0, h - 28), (w, h), (0, 0, 0), -1)
        cv2.putText(frame, scene[:100], (8, h - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, text_color, 1, cv2.LINE_AA)


def main():
    model_path = os.path.join(os.path.dirname(__file__), "pose_landmarker_lite.task")

    engine = VisionEngine(model_path=model_path)
    gemini = GeminiAnalyzer(api_key=GEMINI_API_KEY, interval=2.5)

    # Camera setup — try USB webcam first, fall back to built-in
    cam_index = int(os.getenv("CAMERA_INDEX", "2"))
    cap = cv2.VideoCapture(cam_index)
    if not cap.isOpened():
        print(f"Cannot open /dev/video{cam_index}, trying /dev/video0...")
        cam_index = 0
        cap = cv2.VideoCapture(cam_index)
    if not cap.isOpened():
        print("ERROR: Cannot open any webcam.")
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    print("SENTINEL Vision Test — Pose + Face + Gemini")
    print("=" * 48)
    print(f"  Webcam: /dev/video{cam_index}")
    print("  q=quit  SPACE=analyze  g=gemini  f=faces  s=screenshot")
    print("=" * 48)

    show_gemini = True
    show_faces = True
    force_analyze = False
    fps_time = time.time()
    fps_count = 0
    fps = 0
    frame_ts = 0
    gemini_received_at = 0
    last_gemini_ref = None

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Frame capture failed")
            break

        now = time.time()
        frame_ts += 33  # ~30fps monotonic timestamp

        # FPS counter
        fps_count += 1
        if now - fps_time >= 1.0:
            fps = fps_count
            fps_count = 0
            fps_time = now

        # ── Local CV (every frame) ──
        result = engine.process_frame(frame, frame_ts)

        # ── Gemini (background, periodic) ──
        if gemini.should_analyze() or force_analyze:
            force_analyze = False
            gemini.analyze_async(frame)

        # Track when new Gemini results arrive
        gemini_data = gemini.latest
        if gemini_data is not last_gemini_ref:
            last_gemini_ref = gemini_data
            gemini_received_at = now
        gemini_age = now - gemini_received_at if gemini_received_at > 0 else 0

        # ── Draw ──
        display = frame.copy()
        engine.draw_overlays(display, result)

        # Gemini semantic overlay (anchored to CV persons, fades with age)
        if gemini_data and show_gemini:
            draw_gemini_overlays(display, gemini_data, cv_result=result, gemini_age=gemini_age)

        # ── HUD ──
        h, w = display.shape[:2]
        hud = f"Bodies: {result.person_count} | Faces: {result.face_count} | FPS: {fps}"
        cv2.rectangle(display, (0, 0), (w, 28), (0, 0, 0), -1)
        cv2.putText(display, hud, (8, 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)

        # Gemini status indicator with age
        if gemini.is_analyzing:
            cv2.putText(display, "GEMINI...", (w - 120, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
        elif gemini_data and show_gemini:
            age_label = f"AI {gemini_age:.0f}s"
            age_color = (0, 255, 0) if gemini_age < 3 else (0, 200, 255) if gemini_age < 6 else (0, 100, 255)
            cv2.putText(display, age_label, (w - 80, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, age_color, 1, cv2.LINE_AA)

        # Branding
        cv2.putText(display, "SENTINEL", (8, h - 36),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 0), 1, cv2.LINE_AA)

        cv2.imshow("SENTINEL Vision Test", display)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord(" "):
            force_analyze = True
            print("[Manual] Forcing Gemini analysis...")
        elif key == ord("g"):
            show_gemini = not show_gemini
            print(f"[Toggle] Gemini overlay: {'ON' if show_gemini else 'OFF'}")
        elif key == ord("f"):
            show_faces = not show_faces
            print(f"[Toggle] Face detection: {'ON' if show_faces else 'OFF'}")
        elif key == ord("s"):
            filename = f"sentinel_capture_{int(time.time())}.jpg"
            cv2.imwrite(filename, display)
            print(f"[Screenshot] Saved: {filename}")

    engine.close()
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
