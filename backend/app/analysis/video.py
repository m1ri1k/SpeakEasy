import math
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any

import numpy as np


@dataclass
class VisualAnalysis:
    metrics: list[dict[str, Any]]
    note: str | None = None


VIDEO_SCENARIO_NORMS = {
    "presentation": {
        "gaze_good": 0.70,
        "gaze_excellent": 0.80,
        "gaze_min": 0.50,
        "head_excellent": 15,
        "head_good": 20,
        "head_warning": 25,
        "head_zero": 45,
    },
    "pitch": {
        "gaze_good": 0.75,
        "gaze_excellent": 0.85,
        "gaze_min": 0.55,
        "head_excellent": 12,
        "head_good": 18,
        "head_warning": 24,
        "head_zero": 44,
    },
    "free": {
        "gaze_good": 0.55,
        "gaze_excellent": 0.70,
        "gaze_min": 0.40,
        "head_excellent": 20,
        "head_good": 28,
        "head_warning": 35,
        "head_zero": 55,
    },
}


def analyze_video(file_path: Path, scenario: str = "presentation") -> VisualAnalysis:
    if os.getenv("VIDEO_ANALYSIS_ENABLED", "1").lower() in {"0", "false", "no"}:
        return VisualAnalysis([], "Визуальный анализ выключен.")

    try:
        metrics = analyze_video_with_mediapipe(file_path, scenario)
    except Exception as exc:
        return VisualAnalysis([unavailable_metric(f"Визуальный анализ недоступен: {exc}")], str(exc))

    return VisualAnalysis(metrics)


def analyze_video_with_mediapipe(file_path: Path, scenario: str = "presentation") -> list[dict[str, Any]]:
    matplotlib_cache = Path(__file__).resolve().parents[2] / "models" / "matplotlib"
    matplotlib_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(matplotlib_cache))
    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

    import cv2
    import mediapipe as mp
    import mediapipe.python.solution_base as solution_base

    solution_base.__file__ = str(Path(get_mediapipe_ascii_resource_dir(mp)) / "mediapipe" / "python" / "solution_base.py")

    capture = cv2.VideoCapture(str(file_path))
    if not capture.isOpened():
        raise RuntimeError("не удалось открыть видео")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    step = max(round(fps / float(os.getenv("VIDEO_ANALYSIS_FPS", "2"))), 1)
    max_frames = int(os.getenv("VIDEO_ANALYSIS_MAX_FRAMES", "720"))

    gaze_hits: list[bool] = []
    head_angles: list[tuple[float, float, float]] = []
    stability_offsets: list[float] = []
    analyzed_frames = 0
    detected_faces = 0
    previous_gray = None

    face_mesh = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    try:
        frame_index = 0
        while analyzed_frames < max_frames:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % step != 0:
                frame_index += 1
                continue

            frame = resize_for_analysis(frame)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            height, width = frame.shape[:2]
            results = face_mesh.process(rgb)

            if previous_gray is not None:
                offset = estimate_frame_motion(previous_gray, gray, cv2)
                if offset is not None:
                    stability_offsets.append(offset)
            previous_gray = gray

            if results.multi_face_landmarks:
                detected_faces += 1
                landmarks = results.multi_face_landmarks[0].landmark
                gaze_hits.append(is_gaze_centered(landmarks))
                angles = estimate_head_pose(landmarks, width, height, cv2)
                if angles is not None:
                    head_angles.append(angles)

            analyzed_frames += 1
            frame_index += 1
    finally:
        face_mesh.close()
        capture.release()

    if analyzed_frames == 0:
        raise RuntimeError("не удалось прочитать кадры видео")

    return build_visual_metrics(
        gaze_hits=gaze_hits,
        head_angles=head_angles,
        stability_offsets=stability_offsets,
        analyzed_frames=analyzed_frames,
        detected_faces=detected_faces,
        frame_count=frame_count,
        fps=fps,
        source_width=source_width,
        source_height=source_height,
        scenario=scenario,
    )


def get_mediapipe_ascii_resource_dir(mp_module) -> str:
    package_root = Path(mp_module.__file__).resolve().parent
    source_modules = package_root / "modules"
    target_root = Path(tempfile.gettempdir()) / "speakeasy_mediapipe_resources"
    target_modules = target_root / "mediapipe" / "modules"

    if not target_modules.exists():
        shutil.copytree(source_modules, target_modules, dirs_exist_ok=True)

    return str(target_root)


def resize_for_analysis(frame):
    height, width = frame.shape[:2]
    long_edge = max(width, height)
    if long_edge <= 720:
        return frame

    scale = 720 / long_edge
    import cv2

    return cv2.resize(frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)


def is_gaze_centered(landmarks) -> bool:
    left_center = iris_center_ratio(landmarks, [468, 469, 470, 471], 33, 133)
    right_center = iris_center_ratio(landmarks, [473, 474, 475, 476], 362, 263)
    if left_center is None or right_center is None:
        return False

    horizontal_center = abs(left_center - 0.5) <= 0.18 and abs(right_center - 0.5) <= 0.18
    return horizontal_center


def iris_center_ratio(landmarks, iris_indices: list[int], outer_index: int, inner_index: int) -> float | None:
    try:
        iris_x = mean(landmarks[index].x for index in iris_indices)
        outer_x = landmarks[outer_index].x
        inner_x = landmarks[inner_index].x
    except IndexError:
        return None

    left = min(outer_x, inner_x)
    right = max(outer_x, inner_x)
    if right - left <= 1e-6:
        return None
    return (iris_x - left) / (right - left)


def estimate_head_pose(landmarks, width: int, height: int, cv2) -> tuple[float, float, float] | None:
    try:
        left_eye = np.array([landmarks[33].x * width, landmarks[33].y * height])
        right_eye = np.array([landmarks[263].x * width, landmarks[263].y * height])
        nose = np.array([landmarks[1].x * width, landmarks[1].y * height])
        chin = np.array([landmarks[152].x * width, landmarks[152].y * height])
    except IndexError:
        return None

    eye_vector = right_eye - left_eye
    eye_distance = float(np.linalg.norm(eye_vector))
    face_height = float(np.linalg.norm(chin - ((left_eye + right_eye) / 2)))
    if eye_distance <= 1e-6 or face_height <= 1e-6:
        return None

    eye_midpoint = (left_eye + right_eye) / 2
    yaw = float((nose[0] - eye_midpoint[0]) / eye_distance * 55)
    pitch_ratio = float((nose[1] - eye_midpoint[1]) / face_height)
    pitch = (pitch_ratio - 0.34) * 90
    roll = math.degrees(math.atan2(eye_vector[1], eye_vector[0]))
    return yaw, pitch, roll


def estimate_frame_motion(previous_gray, current_gray, cv2) -> float | None:
    features = cv2.goodFeaturesToTrack(
        previous_gray,
        maxCorners=120,
        qualityLevel=0.01,
        minDistance=12,
        blockSize=7,
    )
    if features is None:
        return None

    next_points, status, _error = cv2.calcOpticalFlowPyrLK(previous_gray, current_gray, features, None)
    if next_points is None or status is None:
        return None

    valid = status.reshape(-1) == 1
    if valid.sum() < 8:
        return None

    displacement = next_points[valid].reshape(-1, 2) - features[valid].reshape(-1, 2)
    distances = np.linalg.norm(displacement, axis=1)
    diagonal = math.hypot(*previous_gray.shape[:2])
    if diagonal <= 0:
        return None
    return float(np.median(distances) / diagonal * 100)


def build_visual_metrics(
    gaze_hits: list[bool],
    head_angles: list[tuple[float, float, float]],
    stability_offsets: list[float],
    analyzed_frames: int,
    detected_faces: int,
    frame_count: int,
    fps: float,
    source_width: int,
    source_height: int,
    scenario: str,
) -> list[dict[str, Any]]:
    norms = video_norms_for_scenario(scenario)
    face_detection_rate = detected_faces / analyzed_frames if analyzed_frames else 0
    context = f"проанализировано {analyzed_frames} кадров"
    if frame_count and fps:
        context += f" из ~{round(frame_count / fps)} сек видео"
    if source_width and source_height:
        context += f"; исходный кадр {source_width}x{source_height}"

    if face_detection_rate < 0.15:
        return [unavailable_metric(f"Лицо найдено только в {format_percent(face_detection_rate)} кадров; {context}.")]

    gaze_rate = sum(gaze_hits) / len(gaze_hits) if gaze_hits else None
    head_max_angle = mean(max(abs(yaw), abs(pitch), abs(roll)) for yaw, pitch, roll in head_angles) if head_angles else None
    head_good_rate = (
        sum(1 for yaw, pitch, roll in head_angles if max(abs(yaw), abs(pitch), abs(roll)) <= norms["head_good"]) / len(head_angles)
        if head_angles
        else None
    )
    motion = mean(stability_offsets) if stability_offsets else None

    return [
        gaze_metric(gaze_rate, face_detection_rate, context, norms),
        head_pose_metric(head_max_angle, head_good_rate, context, norms),
        stability_metric(motion, context),
    ]


def video_norms_for_scenario(scenario: str) -> dict[str, float]:
    return VIDEO_SCENARIO_NORMS.get(scenario, VIDEO_SCENARIO_NORMS["presentation"])


def gaze_metric(gaze_rate: float | None, face_detection_rate: float, context: str, norms: dict[str, float]) -> dict[str, Any]:
    if gaze_rate is None:
        return metric("Взгляд в камеру", "warning", None, "нет данных", f"Не удалось надежно оценить направление взгляда; {context}.")

    score = score_for_gaze(gaze_rate, norms)
    good = norms["gaze_good"]
    excellent = norms["gaze_excellent"]
    minimum = norms["gaze_min"]
    return metric(
        "Взгляд в камеру",
        "good" if gaze_rate >= good else "warning",
        score,
        f"{format_percent(gaze_rate)} времени; ориентир {format_percent(good)}-{format_percent(excellent)}, минимум {format_percent(minimum)}",
        f"Лицо найдено в {format_percent(face_detection_rate)} кадров.",
    )


def head_pose_metric(max_angle: float | None, good_rate: float | None, context: str, norms: dict[str, float]) -> dict[str, Any]:
    if max_angle is None:
        return metric("Наклон/поворот головы", "warning", None, "нет данных", f"Не удалось надежно оценить положение головы; {context}.")

    score = score_for_head_angle(max_angle, norms)
    excellent = norms["head_excellent"]
    good = norms["head_good"]
    return metric(
        "Наклон/поворот головы",
        "good" if max_angle <= good else "warning",
        score,
        f"среднее отклонение {max_angle:.1f}°; кадров в норме до {good:g}° — {format_percent(good_rate or 0)}",
        f"Хороший ориентир — до {excellent:g}°, допустимо до {good:g}°.",
    )


def stability_metric(motion: float | None, context: str) -> dict[str, Any]:
    if motion is None:
        return metric("Стабильность кадра", "warning", None, "нет данных", f"Не удалось надежно оценить движение кадра; {context}.")

    score = score_for_motion(motion)
    return metric(
        "Стабильность кадра",
        "good" if motion <= 1.5 else "warning",
        score,
        f"среднее смещение {motion:.2f}% диагонали кадра",
        "Кадр выглядит стабильнее, когда среднее смещение остается низким.",
    )


def unavailable_metric(note: str) -> dict[str, Any]:
    return metric("Видеометрики", "warning", None, "нет данных", note)


def metric(title: str, state: str, score: int | None, value: str, note: str) -> dict[str, Any]:
    return {
        "title": title,
        "state": state,
        "score": score,
        "value": value,
        "note": note,
    }


def score_for_gaze(value: float, norms: dict[str, float]) -> int:
    excellent = norms["gaze_excellent"]
    minimum = norms["gaze_min"]
    if value >= excellent:
        return 100
    if value >= minimum:
        return round(50 + (value - minimum) / (excellent - minimum) * 50)
    return max(0, round(value / minimum * 50))


def score_for_head_angle(angle: float, norms: dict[str, float]) -> int:
    excellent = norms["head_excellent"]
    good = norms["head_good"]
    warning = norms["head_warning"]
    zero = norms["head_zero"]
    if angle <= excellent:
        return 100
    if angle <= good:
        return round(100 - (angle - excellent) / (good - excellent) * 15)
    if angle <= warning:
        return round(85 - (angle - good) / (warning - good) * 35)
    return max(0, round(50 - (angle - warning) / (zero - warning) * 50))


def score_for_motion(value: float) -> int:
    if value <= 0.8:
        return 100
    if value <= 1.5:
        return round(100 - (value - 0.8) / 0.7 * 20)
    if value <= 3.0:
        return round(80 - (value - 1.5) / 1.5 * 50)
    return max(0, round(30 - (value - 3.0) / 3.0 * 30))


def format_percent(value: float) -> str:
    return f"{round(value * 100)}%"
