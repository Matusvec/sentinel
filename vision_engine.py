#!/usr/bin/env python3
"""
SENTINEL Vision Engine — Local real-time CV processing.

Provides MediaPipe pose estimation, face detection, movement tracking,
and optional Gemini Vision integration as a reusable module.

Usage:
    from vision_engine import VisionEngine

    engine = VisionEngine(model_path="pose_landmarker_lite.task")
    result = engine.process_frame(frame, timestamp_ms)
    # result.poses, result.faces, result.persons, result.to_dict()
"""

import os
import cv2
import math
import time
import base64
import json
import threading
import numpy as np
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)


# ── Skeleton topology ──────────────────────────────────────────

SKELETON_CONNECTIONS = [
    # Head
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    # Torso
    (11, 12), (11, 23), (12, 24), (23, 24),
    # Left arm
    (11, 13), (13, 15), (15, 17), (15, 19), (15, 21),
    # Right arm
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22),
    # Left leg
    (23, 25), (25, 27), (27, 29), (27, 31),
    # Right leg
    (24, 26), (26, 28), (28, 30), (28, 32),
]

JOINT_NAMES = {
    0: "nose", 11: "L.shoulder", 12: "R.shoulder",
    13: "L.elbow", 14: "R.elbow", 15: "L.wrist", 16: "R.wrist",
    23: "L.hip", 24: "R.hip", 25: "L.knee", 26: "R.knee",
    27: "L.ankle", 28: "R.ankle",
}

BONE_COLORS = {
    "head": (0, 255, 200),
    "torso": (0, 255, 0),
    "left_arm": (255, 200, 0),
    "right_arm": (0, 200, 255),
    "left_leg": (255, 150, 0),
    "right_leg": (0, 150, 255),
}


def get_bone_color(i1: int, i2: int) -> tuple:
    """Return BGR color based on which body part a bone belongs to."""
    indices = {i1, i2}
    if indices & {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10}:
        return BONE_COLORS["head"]
    if indices & {11, 12, 23, 24} and not (indices & {13, 14, 15, 16, 25, 26}):
        return BONE_COLORS["torso"]
    if indices & {11, 13, 15, 17, 19, 21}:
        return BONE_COLORS["left_arm"]
    if indices & {12, 14, 16, 18, 20, 22}:
        return BONE_COLORS["right_arm"]
    if indices & {23, 25, 27, 29, 31}:
        return BONE_COLORS["left_leg"]
    if indices & {24, 26, 28, 30, 32}:
        return BONE_COLORS["right_leg"]
    return (200, 200, 200)


# ── Data classes ───────────────────────────────────────────────

@dataclass
class TrackedPerson:
    """A person detected via local CV with tracking state."""
    index: int
    landmarks: list  # list of (x_norm, y_norm, visibility)
    bbox: dict  # {"x": float, "y": float, "width": float, "height": float} — normalized 0-1
    center: tuple  # (cx_norm, cy_norm)
    speed_px_per_sec: float = 0.0
    activity: str = "unknown"  # "still", "moving", "fast"
    name: Optional[str] = None  # recognized known face name
    name_confidence: float = 0.0
    fall_detected: bool = False
    fall_confidence: float = 0.0

    def to_dict(self) -> dict:
        d = {
            "id": self.index + 1,
            "bbox": self.bbox,
            "center": {"x": self.center[0], "y": self.center[1]},
            "speed": round(self.speed_px_per_sec, 1),
            "activity": self.activity,
            "landmark_count": sum(1 for _, _, v in self.landmarks if v > 0.3),
            "landmarks": [
                {"x": round(x, 4), "y": round(y, 4), "v": round(v, 2)}
                for x, y, v in self.landmarks
            ] if self.landmarks else [],
            "fall_detected": self.fall_detected,
            "fall_confidence": round(self.fall_confidence, 3),
        }
        if self.name:
            d["name"] = self.name
            d["name_confidence"] = round(self.name_confidence, 2)
        return d


@dataclass
class FrameResult:
    """Complete result from processing a single frame."""
    poses: list  # raw MediaPipe pose_landmarks
    faces: list  # list of (x, y, w, h) in pixels
    persons: list  # list of TrackedPerson
    person_count: int = 0
    timestamp: float = 0.0

    def to_dict(self) -> dict:
        """Serialize for sending to SENTINEL dashboard."""
        return {
            "person_count": self.person_count,
            "face_count": len(self.faces),
            "persons": [p.to_dict() for p in self.persons],
            "timestamp": self.timestamp,
            "fall_alert": any(p.fall_detected for p in self.persons),
        }


# ── Face Registry (deep embedding recognition) ───────────────

class FaceRegistry:
    """
    Recognizes known faces using OpenFace deep embeddings (128-dim).
    Uses a single forward pass per face to generate an embedding,
    then a single matrix multiply to compare against ALL known faces
    at once — O(1) regardless of how many faces are registered.
    """

    MATCH_THRESHOLD = float(os.environ.get('FACE_MATCH_THRESHOLD', '0.55'))
    MODEL_PATH = os.path.join(os.path.dirname(__file__), 'openface_nn4.small2.v1.t7')

    def __init__(self):
        self._names: list[str] = []            # ordered list of names
        self._embeddings: Optional[np.ndarray] = None  # (N, 128) normalized embeddings
        self._net = None  # lazy-loaded OpenFace DNN

        # Haar cascade for finding face in registration photos
        self._face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )

    def _load_model(self):
        """Lazy-load the OpenFace model on first use."""
        if self._net is not None:
            return
        if not os.path.exists(self.MODEL_PATH):
            print(f"[FaceRegistry] Model not found: {self.MODEL_PATH}")
            print("  Download: curl -L -o openface_nn4.small2.v1.t7 https://storage.cmusatyalab.org/openface-models/nn4.small2.v1.t7")
            return
        self._net = cv2.dnn.readNetFromTorch(self.MODEL_PATH)
        print("[FaceRegistry] OpenFace model loaded (128-dim embeddings)")

    def _embed(self, face_bgr) -> Optional[np.ndarray]:
        """Generate a 128-dim embedding from a face crop."""
        self._load_model()
        if self._net is None:
            return None
        blob = cv2.dnn.blobFromImage(
            face_bgr, 1.0 / 255, (96, 96), (0, 0, 0), swapRB=True, crop=False
        )
        self._net.setInput(blob)
        embedding = self._net.forward().flatten()  # (128,)
        # L2 normalize
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return embedding

    def register(self, name: str, image_bgr) -> bool:
        """Register a known face from a BGR image. Returns True on success."""
        # Find face in the image
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = self._face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30)
        )
        if len(faces) > 0:
            x, y, w, h = faces[0]
            face_bgr = image_bgr[y:y+h, x:x+w]
        else:
            face_bgr = image_bgr  # assume pre-cropped

        embedding = self._embed(face_bgr)
        if embedding is None:
            return False

        # If name already exists, replace
        if name in self._names:
            idx = self._names.index(name)
            self._embeddings[idx] = embedding
        else:
            self._names.append(name)
            if self._embeddings is None:
                self._embeddings = embedding.reshape(1, -1)
            else:
                self._embeddings = np.vstack([self._embeddings, embedding.reshape(1, -1)])

        print(f"[FaceRegistry] Registered: {name} ({len(self._names)} total)")
        return True

    def unregister(self, name: str) -> bool:
        """Remove a known face."""
        if name not in self._names:
            return False
        idx = self._names.index(name)
        self._names.pop(idx)
        if self._embeddings is not None:
            self._embeddings = np.delete(self._embeddings, idx, axis=0)
            if len(self._names) == 0:
                self._embeddings = None
        return True

    def list_known(self) -> list[str]:
        """Return list of registered face names."""
        return list(self._names)

    def identify(self, frame_bgr, face_bboxes: list) -> dict[int, tuple[str, float]]:
        """
        Match detected faces against ALL known faces in a single matrix multiply.
        Returns {face_index: (name, confidence)} for matches above threshold.
        """
        if not self._names or self._embeddings is None or not face_bboxes:
            return {}

        h, w = frame_bgr.shape[:2]
        results = {}

        for i, (fx, fy, fw, fh) in enumerate(face_bboxes):
            fx2 = min(w, fx + fw)
            fy2 = min(h, fy + fh)
            if fx2 - fx < 20 or fy2 - fy < 20:
                continue

            face_crop = frame_bgr[fy:fy2, fx:fx2]
            query = self._embed(face_crop)
            if query is None:
                continue

            # Single matrix multiply: compare against ALL known faces at once
            # cosine similarity (embeddings are already L2-normalized)
            similarities = self._embeddings @ query  # (N,) — one score per known face
            best_idx = int(np.argmax(similarities))
            best_score = float(similarities[best_idx])

            if best_score >= self.MATCH_THRESHOLD:
                results[i] = (self._names[best_idx], best_score)

        return results


# ── Fall Detector (real-time CV-based) ─────────────────────────

@dataclass
class FallState:
    """Per-person fall detection state."""
    prev_hip_y: float = 0.5
    prev_time: float = 0.0
    confidence: float = 0.0
    frames_above: int = 0       # consecutive frames above threshold
    fall_detected: bool = False
    fall_start_time: float = 0.0
    frames_below: int = 0       # consecutive frames below clear threshold


class FallDetector:
    """
    Analyzes pose landmarks per person per frame to detect falls.

    Uses four scoring signals combined with temporal filtering (EMA smoothing
    + consecutive frame confirmation) to minimize false positives from
    bending, sitting, or picking things up.
    """

    # Scoring weights
    W_TORSO_ANGLE = 0.35
    W_VELOCITY = 0.20
    W_ASPECT_RATIO = 0.20
    W_SHOULDER_HIP = 0.25

    # Thresholds
    EMA_ALPHA = 0.4            # smoothing: 0.4 * raw + 0.6 * prev
    CONFIRM_THRESHOLD = 0.65   # confidence must exceed this
    CONFIRM_FRAMES = 3         # for this many consecutive frames (~1.5s at 2Hz)
    CLEAR_THRESHOLD = 0.3      # confidence must drop below this
    CLEAR_FRAMES = 5           # for this many consecutive frames to clear

    def __init__(self):
        self._states: dict[int, FallState] = {}

    def analyze(self, persons: list, now: float) -> None:
        """
        Analyze all tracked persons for falls. Updates fall_detected and
        fall_confidence fields on each TrackedPerson in-place.
        """
        active_ids = set()

        for person in persons:
            if not person.landmarks or len(person.landmarks) < 25:
                continue  # need at least hip + shoulder landmarks

            pid = person.index
            active_ids.add(pid)

            if pid not in self._states:
                self._states[pid] = FallState(prev_time=now)

            state = self._states[pid]
            raw_score = self._compute_score(person, state, now)

            # EMA smoothing
            state.confidence = (
                self.EMA_ALPHA * raw_score + (1.0 - self.EMA_ALPHA) * state.confidence
            )

            # Temporal confirmation
            if state.confidence > self.CONFIRM_THRESHOLD:
                state.frames_above += 1
                state.frames_below = 0
            elif state.confidence < self.CLEAR_THRESHOLD:
                state.frames_below += 1
                state.frames_above = 0
            else:
                # In the middle zone — don't reset counters
                pass

            # Confirm fall
            if not state.fall_detected and state.frames_above >= self.CONFIRM_FRAMES:
                state.fall_detected = True
                state.fall_start_time = now

            # Clear fall
            if state.fall_detected and state.frames_below >= self.CLEAR_FRAMES:
                state.fall_detected = False
                state.fall_start_time = 0.0

            # Update hip tracking for next frame
            hip_y = self._get_hip_midpoint_y(person.landmarks)
            if hip_y is not None:
                state.prev_hip_y = hip_y
            state.prev_time = now

            # Write results back to person
            person.fall_detected = state.fall_detected
            person.fall_confidence = state.confidence

        # Clean up stale states (person no longer tracked)
        stale = [pid for pid in self._states if pid not in active_ids]
        for pid in stale:
            if now - self._states[pid].prev_time > 5.0:
                del self._states[pid]

    def _compute_score(self, person: TrackedPerson, state: FallState, now: float) -> float:
        """Compute raw fall score (0.0–1.0) from four signals."""
        lm = person.landmarks
        score = 0.0

        # ── Signal 1: Torso angle from vertical ──
        torso_angle = self._torso_angle(lm)
        if torso_angle is not None:
            # Score rises above 60 degrees, maxes at 90
            angle_score = max(0.0, min(1.0, (torso_angle - 60.0) / 30.0))
            score += self.W_TORSO_ANGLE * angle_score

        # ── Signal 2: Vertical velocity (sudden hip drop) ──
        hip_y = self._get_hip_midpoint_y(lm)
        if hip_y is not None and state.prev_time > 0:
            dt = now - state.prev_time
            if 0.05 < dt < 2.0:  # reasonable frame interval
                delta_y = hip_y - state.prev_hip_y  # positive = downward
                # Score high when delta_y > 0.05 in 0.5s
                velocity = delta_y / dt
                vel_score = max(0.0, min(1.0, (velocity - 0.05) / 0.15))
                score += self.W_VELOCITY * vel_score

        # ── Signal 3: Bounding box aspect ratio ──
        bbox = person.bbox
        bw = bbox.get("width", 0)
        bh = bbox.get("height", 0)
        if bh > 0.01:
            # Standing: h > w. Fallen: w > h. Score = max(0, 1 - h/w)
            ratio = bh / bw if bw > 0.01 else 10.0
            aspect_score = max(0.0, min(1.0, 1.0 - ratio))
            score += self.W_ASPECT_RATIO * aspect_score

        # ── Signal 4: Shoulder-hip vertical alignment ──
        alignment_diff = self._shoulder_hip_diff(lm)
        if alignment_diff is not None:
            # Standing: large Y diff (shoulders well above hips)
            # Lying: similar Y. Score rises when diff < 0.12
            align_score = max(0.0, min(1.0, (0.12 - alignment_diff) / 0.12))
            score += self.W_SHOULDER_HIP * align_score

        return max(0.0, min(1.0, score))

    @staticmethod
    def _get_hip_midpoint_y(landmarks: list) -> Optional[float]:
        """Get Y coordinate of hip midpoint (landmarks 23, 24)."""
        if len(landmarks) < 25:
            return None
        l_hip = landmarks[23]  # (x, y, visibility)
        r_hip = landmarks[24]
        if l_hip[2] > 0.3 and r_hip[2] > 0.3:
            return (l_hip[1] + r_hip[1]) / 2.0
        return None

    @staticmethod
    def _torso_angle(landmarks: list) -> Optional[float]:
        """
        Angle of torso vector from vertical (degrees).
        Vector from hip midpoint to shoulder midpoint.
        Returns 0 for perfectly upright, 90 for horizontal.
        """
        if len(landmarks) < 25:
            return None
        l_hip = landmarks[23]
        r_hip = landmarks[24]
        l_shoulder = landmarks[11]
        r_shoulder = landmarks[12]
        if (l_hip[2] < 0.3 or r_hip[2] < 0.3 or
                l_shoulder[2] < 0.3 or r_shoulder[2] < 0.3):
            return None

        hip_x = (l_hip[0] + r_hip[0]) / 2.0
        hip_y = (l_hip[1] + r_hip[1]) / 2.0
        shoulder_x = (l_shoulder[0] + r_shoulder[0]) / 2.0
        shoulder_y = (l_shoulder[1] + r_shoulder[1]) / 2.0

        # Vector from hip to shoulder (in image coords: y increases downward)
        dx = shoulder_x - hip_x
        dy = hip_y - shoulder_y  # flip so upward is positive

        # Angle from vertical (straight up = 0 degrees)
        angle_rad = math.atan2(abs(dx), dy) if dy != 0 else math.pi / 2
        return math.degrees(angle_rad)

    @staticmethod
    def _shoulder_hip_diff(landmarks: list) -> Optional[float]:
        """
        Vertical distance between shoulder midpoint and hip midpoint (normalized).
        Large value = standing. Small value = lying down.
        """
        if len(landmarks) < 25:
            return None
        l_hip = landmarks[23]
        r_hip = landmarks[24]
        l_shoulder = landmarks[11]
        r_shoulder = landmarks[12]
        if (l_hip[2] < 0.3 or r_hip[2] < 0.3 or
                l_shoulder[2] < 0.3 or r_shoulder[2] < 0.3):
            return None

        hip_y = (l_hip[1] + r_hip[1]) / 2.0
        shoulder_y = (l_shoulder[1] + r_shoulder[1]) / 2.0
        return abs(hip_y - shoulder_y)


# ── Vision Engine ──────────────────────────────────────────────

class VisionEngine:
    """
    Real-time local CV engine combining MediaPipe Pose + Haar face detection.

    Designed to be used by both test_vision.py (local preview) and
    sentinel_rpi.py (headless, sends data to dashboard).
    """

    def __init__(
        self,
        model_path: str = "pose_landmarker_lite.task",
        max_poses: int = 5,
        detection_confidence: float = 0.6,
        tracking_confidence: float = 0.6,
        face_detection_interval: int = 3,
        trail_length: int = 30,
    ):
        self.model_path = model_path
        self.max_poses = max_poses
        self.face_detection_interval = face_detection_interval
        self.trail_length = trail_length

        # MediaPipe Pose
        options = PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,
            num_poses=max_poses,
            min_pose_detection_confidence=detection_confidence,
            min_pose_presence_confidence=detection_confidence,
            min_tracking_confidence=tracking_confidence,
        )
        self.landmarker = PoseLandmarker.create_from_options(options)

        # Haar cascades for face detection
        self.face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        self.profile_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_profileface.xml"
        )

        # Known face recognition
        self.face_registry = FaceRegistry()

        # Fall detection
        self.fall_detector = FallDetector()

        # Movement tracking state
        self._trails: dict[int, deque] = {}
        self._frame_count = 0
        self._last_faces: list = []

        # Face identification cache — avoid re-identifying every frame
        self._face_id_cache: dict[int, tuple[str, float, float]] = {}  # face_idx → (name, confidence, timestamp)
        self._last_face_id_time = 0.0
        self._face_id_interval = 2.0  # seconds between full re-identification

    def process_frame(self, frame, timestamp_ms: int) -> FrameResult:
        """
        Run full CV pipeline on a single BGR frame.

        Args:
            frame: BGR numpy array from cv2.VideoCapture
            timestamp_ms: monotonic timestamp in milliseconds (must increase)

        Returns:
            FrameResult with all detections and tracking data
        """
        h, w = frame.shape[:2]
        now = time.time()
        self._frame_count += 1

        # ── Pose detection (every frame — fast on CPU) ──
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        pose_result = self.landmarker.detect_for_video(mp_image, timestamp_ms)
        pose_landmarks = pose_result.pose_landmarks or []

        # ── Face detection (every Nth frame — Haar is slower) ──
        if self._frame_count % self.face_detection_interval == 0:
            self._last_faces = self._detect_faces(frame)
        faces = self._last_faces

        # ── Build tracked persons from pose landmarks ──
        persons = []
        for idx, landmarks in enumerate(pose_landmarks):
            pts_norm = []
            for lm in landmarks:
                vis = lm.visibility if hasattr(lm, "visibility") else 1.0
                pts_norm.append((lm.x, lm.y, vis))

            # Bounding box from visible landmarks (normalized)
            visible = [(x, y) for x, y, v in pts_norm if v > 0.5]
            if len(visible) < 6:
                # Need at least 6 high-confidence landmarks to count as a person
                continue

            xs = [p[0] for p in visible]
            ys = [p[1] for p in visible]
            pad = 0.02  # normalized padding
            bx = max(0, min(xs) - pad)
            by = max(0, min(ys) - pad)
            bw = min(1, max(xs) + pad) - bx
            bh = min(1, max(ys) + pad) - by

            # Filter out unrealistic detections
            if bw < 0.03 or bh < 0.05:
                continue  # too small — noise
            if bw > 0.95 and bh > 0.95:
                continue  # too large — fills entire frame, likely false positive
            if bh < bw * 0.4:
                continue  # too wide/flat — people are taller than wide

            # Center of mass — prefer hip midpoint, fall back to shoulder midpoint
            cx, cy = bx + bw / 2, by + bh / 2
            if len(pts_norm) > 24 and pts_norm[23][2] > 0.3 and pts_norm[24][2] > 0.3:
                cx = (pts_norm[23][0] + pts_norm[24][0]) / 2
                cy = (pts_norm[23][1] + pts_norm[24][1]) / 2
            elif len(pts_norm) > 12 and pts_norm[11][2] > 0.3 and pts_norm[12][2] > 0.3:
                cx = (pts_norm[11][0] + pts_norm[12][0]) / 2
                cy = (pts_norm[11][1] + pts_norm[12][1]) / 2

            # Pixel-space center for speed calculation
            cx_px, cy_px = int(cx * w), int(cy * h)
            if idx not in self._trails:
                self._trails[idx] = deque(maxlen=self.trail_length)
            self._trails[idx].append((now, cx_px, cy_px))
            speed = self._calc_speed(self._trails[idx])

            # Classify activity
            if speed > 200:
                activity = "fast"
            elif speed > 50:
                activity = "moving"
            else:
                activity = "still"

            persons.append(TrackedPerson(
                index=idx,
                landmarks=pts_norm,
                bbox={"x": round(bx, 4), "y": round(by, 4),
                      "width": round(bw, 4), "height": round(bh, 4)},
                center=(round(cx, 4), round(cy, 4)),
                speed_px_per_sec=speed,
                activity=activity,
            ))

        # ── Add face-only persons for faces not covered by a pose ──
        # If someone walks by and pose misses them but face detection sees
        # their face, create a lightweight person entry for them.
        for fi, (fx, fy, fw, fh) in enumerate(faces):
            # Normalize face bbox to 0-1
            face_cx = (fx + fw / 2) / w
            face_cy = (fy + fh / 2) / h

            # Check if any pose-detected person already covers this face
            covered = False
            for p in persons:
                bx = p.bbox["x"]
                by = p.bbox["y"]
                bw = p.bbox["width"]
                bh = p.bbox["height"]
                if (bx <= face_cx <= bx + bw and by <= face_cy <= by + bh):
                    covered = True
                    break

            if not covered:
                face_idx = len(pose_landmarks) + fi
                face_bbox_norm = {
                    "x": round(fx / w, 4),
                    "y": round(fy / h, 4),
                    "width": round(fw / w, 4),
                    "height": round(fh / h, 4),
                }
                persons.append(TrackedPerson(
                    index=face_idx,
                    landmarks=[],
                    bbox=face_bbox_norm,
                    center=(round(face_cx, 4), round(face_cy, 4)),
                    speed_px_per_sec=0.0,
                    activity="unknown",
                ))

        # ── Identify known faces (smart: only re-identify every 2s) ──
        if self.face_registry._names and faces:
            should_reidentify = (now - self._last_face_id_time >= self._face_id_interval)

            if should_reidentify:
                # Full re-identification pass
                self._last_face_id_time = now
                identities = self.face_registry.identify(frame, faces)
                # Update cache
                self._face_id_cache = {
                    idx: (name, conf, now)
                    for idx, (name, conf) in identities.items()
                }

            # Apply cached identities to persons (every frame, zero cost)
            for face_idx, (name, confidence, _ts) in self._face_id_cache.items():
                if face_idx >= len(faces):
                    continue
                fx, fy, fw, fh = faces[face_idx]
                face_cx = (fx + fw / 2) / w
                face_cy = (fy + fh / 2) / h
                for p in persons:
                    bx = p.bbox["x"]
                    by = p.bbox["y"]
                    bw_n = p.bbox["width"]
                    bh_n = p.bbox["height"]
                    if bx <= face_cx <= bx + bw_n and by <= face_cy <= by + bh_n:
                        p.name = name
                        p.name_confidence = confidence
                        break

        # ── Fall detection (analyzes pose landmarks per person) ──
        self.fall_detector.analyze(persons, now)

        # Clean up stale trails
        active_indices = {p.index for p in persons}
        stale = [k for k in self._trails if k not in active_indices]
        for k in stale:
            if now - self._trails[k][-1][0] > 3.0:
                del self._trails[k]

        return FrameResult(
            poses=pose_landmarks,
            faces=faces,
            persons=persons,
            person_count=len(persons),
            timestamp=now,
        )

    def close(self):
        """Release MediaPipe resources."""
        self.landmarker.close()

    # ── Drawing helpers (for local preview / test_vision.py) ──

    def draw_overlays(self, frame, result: FrameResult) -> None:
        """Draw all CV overlays onto a frame (skeletons, faces, HUD)."""
        self._draw_skeletons(frame, result)
        self._draw_faces(frame, result.faces)

    def _draw_skeletons(self, frame, result: FrameResult) -> None:
        """Draw skeletons, bounding boxes, and speed badges."""
        h, w = frame.shape[:2]
        now = time.time()

        for person in result.persons:
            pts_px = [
                (int(x * w), int(y * h), v)
                for x, y, v in person.landmarks
            ]

            # Bones
            for i1, i2 in SKELETON_CONNECTIONS:
                if i1 >= len(pts_px) or i2 >= len(pts_px):
                    continue
                if pts_px[i1][2] < 0.3 or pts_px[i2][2] < 0.3:
                    continue
                color = get_bone_color(i1, i2)
                alpha = min(pts_px[i1][2], pts_px[i2][2])
                if alpha < 0.6:
                    color = tuple(int(c * 0.5) for c in color)
                thickness = 3 if alpha > 0.7 else 2
                cv2.line(frame, pts_px[i1][:2], pts_px[i2][:2], color, thickness, cv2.LINE_AA)

            # Keypoints
            for idx, (px, py, vis) in enumerate(pts_px):
                if vis < 0.3:
                    continue
                if idx in JOINT_NAMES:
                    cv2.circle(frame, (px, py), 6, (0, 255, 255), -1, cv2.LINE_AA)
                    cv2.circle(frame, (px, py), 6, (0, 0, 0), 1, cv2.LINE_AA)
                else:
                    cv2.circle(frame, (px, py), 3, (255, 255, 255), -1, cv2.LINE_AA)

            # Bounding box (dashed with corner accents)
            bbox = person.bbox
            bx1 = int(bbox["x"] * w)
            by1 = int(bbox["y"] * h)
            bx2 = int((bbox["x"] + bbox["width"]) * w)
            by2 = int((bbox["y"] + bbox["height"]) * h)

            box_color = (0, 255, 0)
            dash_len = 8
            for i in range(bx1, bx2, dash_len * 2):
                cv2.line(frame, (i, by1), (min(i + dash_len, bx2), by1), box_color, 1)
                cv2.line(frame, (i, by2), (min(i + dash_len, bx2), by2), box_color, 1)
            for i in range(by1, by2, dash_len * 2):
                cv2.line(frame, (bx1, i), (bx1, min(i + dash_len, by2)), box_color, 1)
                cv2.line(frame, (bx2, i), (bx2, min(i + dash_len, by2)), box_color, 1)

            corner_len = 15
            t = 2
            for cx, cy in [(bx1, by1), (bx2, by1), (bx1, by2), (bx2, by2)]:
                dx = corner_len if cx == bx1 else -corner_len
                dy = corner_len if cy == by1 else -corner_len
                cv2.line(frame, (cx, cy), (cx + dx, cy), box_color, t)
                cv2.line(frame, (cx, cy), (cx, cy + dy), box_color, t)

            # Movement trail
            trail = self._trails.get(person.index, [])
            for i in range(1, len(trail)):
                _, x0, y0 = trail[i - 1]
                t1, x1, y1 = trail[i]
                age = now - t1
                a = max(0.2, 1.0 - age / 2.0)
                trail_color = tuple(int(c * a) for c in (0, 255, 100))
                cv2.line(frame, (x0, y0), (x1, y1), trail_color, 2, cv2.LINE_AA)

            # Person label
            label = f"Person #{person.index + 1}"
            lsz, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(frame, (bx1, by1 - lsz[1] - 8), (bx1 + lsz[0] + 4, by1), (0, 180, 0), -1)
            cv2.putText(frame, label, (bx1 + 2, by1 - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

            # Speed badge
            speed = person.speed_px_per_sec
            if speed > 200:
                speed_color, speed_text = (0, 0, 255), f"FAST {speed:.0f} px/s"
            elif speed > 50:
                speed_color, speed_text = (0, 200, 255), f"MOVING {speed:.0f} px/s"
            else:
                speed_color, speed_text = (0, 255, 0), "STILL"

            cv2.putText(frame, speed_text, (bx1 + 2, by2 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, speed_color, 1, cv2.LINE_AA)

    def _draw_faces(self, frame, faces: list) -> None:
        """Draw face bounding boxes with targeting corners."""
        h, w = frame.shape[:2]
        for i, (fx, fy, fw, fh) in enumerate(faces):
            fx2 = min(w, fx + fw)
            fy2 = min(h, fy + fh)

            cv2.rectangle(frame, (fx, fy), (fx2, fy2), (0, 255, 0), 2)

            corner_len = min(15, fw // 3, fh // 3)
            c, t = (0, 255, 0), 3
            for cx, cy in [(fx, fy), (fx2, fy), (fx, fy2), (fx2, fy2)]:
                dx = corner_len if cx == fx else -corner_len
                dy = corner_len if cy == fy else -corner_len
                cv2.line(frame, (cx, cy), (cx + dx, cy), c, t)
                cv2.line(frame, (cx, cy), (cx, cy + dy), c, t)

            # Crosshair
            cx, cy = (fx + fx2) // 2, (fy + fy2) // 2
            cs = min(20, fw // 2)
            cv2.line(frame, (cx - cs, cy), (cx + cs, cy), (0, 0, 255), 1, cv2.LINE_AA)
            cv2.line(frame, (cx, cy - cs), (cx, cy + cs), (0, 0, 255), 1, cv2.LINE_AA)

            label = f"Face #{i + 1}"
            lsz, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            cv2.rectangle(frame, (fx, fy - lsz[1] - 6), (fx + lsz[0] + 4, fy), (0, 255, 0), -1)
            cv2.putText(frame, label, (fx + 2, fy - 3),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)

    def _detect_faces(self, frame) -> list:
        """Run Haar cascade face detection with NMS and quality filters."""
        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)

        # Higher minNeighbors = fewer false positives (was 5, now 7)
        # Larger minSize = skip tiny noise detections
        frontal = self.face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=7, minSize=(50, 50),
            flags=cv2.CASCADE_SCALE_IMAGE,
        )
        profile = self.profile_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=7, minSize=(50, 50),
            flags=cv2.CASCADE_SCALE_IMAGE,
        )
        all_faces = list(frontal) + list(profile)
        nms_faces = self._nms_rects(all_faces, 0.4)

        # Filter out faces in unlikely positions (top 10% of frame = ceiling)
        filtered = []
        for (fx, fy, fw, fh) in nms_faces:
            face_center_y = (fy + fh / 2) / h
            face_center_x = (fx + fw / 2) / w
            # Skip faces in the very top of frame (ceiling area)
            if face_center_y < 0.08:
                continue
            # Skip faces with unrealistic aspect ratios
            aspect = fw / fh if fh > 0 else 0
            if aspect < 0.5 or aspect > 2.0:
                continue
            filtered.append((fx, fy, fw, fh))

        return filtered

    @staticmethod
    def _nms_rects(rects, overlap_thresh=0.4) -> list:
        """Non-maximum suppression for overlapping rectangles."""
        if not rects:
            return []
        # Convert numpy int32 → Python int to avoid JSON serialization errors
        boxes = [(int(x), int(y), int(x + w), int(y + h)) for (x, y, w, h) in rects]
        boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        keep = []
        for box in boxes:
            discard = False
            for kept in keep:
                ix1, iy1 = max(box[0], kept[0]), max(box[1], kept[1])
                ix2, iy2 = min(box[2], kept[2]), min(box[3], kept[3])
                inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                area1 = (box[2] - box[0]) * (box[3] - box[1])
                area2 = (kept[2] - kept[0]) * (kept[3] - kept[1])
                union = area1 + area2 - inter
                if union > 0 and inter / union > overlap_thresh:
                    discard = True
                    break
            if not discard:
                keep.append(box)
        return [(x1, y1, x2 - x1, y2 - y1) for (x1, y1, x2, y2) in keep]

    @staticmethod
    def _calc_speed(trail) -> float:
        """Calculate smoothed movement speed in pixels/sec."""
        if len(trail) < 2:
            return 0.0
        # Use exponentially weighted recent positions for smoother speed
        total_dist = 0.0
        total_time = 0.0
        weight_sum = 0.0
        for i in range(1, len(trail)):
            t0, x0, y0 = trail[i - 1]
            t1, x1, y1 = trail[i]
            dt = t1 - t0
            if dt <= 0:
                continue
            dist = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
            # More recent samples get higher weight
            weight = i / len(trail)
            total_dist += dist * weight
            total_time += dt * weight
            weight_sum += weight
        if total_time < 0.05 or weight_sum == 0:
            return 0.0
        return total_dist / total_time


# ── Gemini integration (optional, threaded) ────────────────────

class GeminiAnalyzer:
    """
    Threaded Gemini Vision API caller. Runs analysis in background,
    exposes latest result via thread-safe property.
    """

    VISION_PROMPT = (
        "Analyze this camera frame from an autonomous monitoring system. "
        "Identify all people and notable objects.\n\n"
        "For each person, provide approximate bounding box as normalized coordinates (0-1).\n\n"
        "Respond ONLY in JSON (no markdown):\n"
        '{"people": [{"id": 1, "bbox": {"x": 0.3, "y": 0.2, "width": 0.15, "height": 0.5}, '
        '"distance": "near", "activity": "standing", "description": "short description", '
        '"facing": "toward_camera"}], '
        '"objects": [{"label": "laptop", "bbox": {"x": 0.5, "y": 0.6, "width": 0.1, "height": 0.08}}], '
        '"environment": {"crowd_density": "sparse", "activity_level": "moderate", '
        '"scene_description": "one sentence"}, '
        '"motion_detected": false}'
    )

    def __init__(self, api_key: str, interval: float = 2.5):
        self.api_key = api_key
        self.interval = interval
        self._url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-2.5-flash-lite:generateContent?key={api_key}"
        )
        self._latest: Optional[dict] = None
        self._lock = threading.Lock()
        self._analyzing = False
        self._last_analysis_time = 0.0

    @property
    def latest(self) -> Optional[dict]:
        with self._lock:
            return self._latest

    @property
    def is_analyzing(self) -> bool:
        return self._analyzing

    def should_analyze(self) -> bool:
        """Check if enough time has passed for a new analysis."""
        return (time.time() - self._last_analysis_time >= self.interval
                and not self._analyzing)

    def analyze_async(self, frame) -> None:
        """Start background Gemini analysis of the given frame."""
        if self._analyzing:
            return
        self._last_analysis_time = time.time()
        t = threading.Thread(target=self._worker, args=(frame.copy(),), daemon=True)
        t.start()

    def analyze_sync(self, frame) -> Optional[dict]:
        """Blocking Gemini analysis — used by sentinel_rpi.py's perception loop."""
        return self._call_gemini(frame)

    def _worker(self, frame) -> None:
        """Background thread target."""
        self._analyzing = True
        try:
            result = self._call_gemini(frame)
            if result:
                with self._lock:
                    self._latest = result
        finally:
            self._analyzing = False

    def _call_gemini(self, frame) -> Optional[dict]:
        """Send frame to Gemini Vision API and parse JSON response."""
        import requests as req

        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        img_b64 = base64.b64encode(buf).decode("utf-8")

        payload = {
            "contents": [{
                "parts": [
                    {"inlineData": {"mimeType": "image/jpeg", "data": img_b64}},
                    {"text": self.VISION_PROMPT},
                ]
            }],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1500},
        }

        try:
            resp = req.post(self._url, json=payload, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            cleaned = text.replace("```json", "").replace("```", "").strip()
            return json.loads(cleaned)
        except Exception as e:
            print(f"[Gemini error] {e}")
            return None
