import json
import os
import re
import subprocess
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any

import numpy as np


_WHISPER_MODEL: tuple[str, object] | None = None          # (model_name, model)
_FASTER_WHISPER_MODEL: tuple[str, object] | None = None   # ("name:compute_type", model)
_GIGAAM_MODEL: tuple[str, object] | None = None           # (model_name, model)
_PUNCTUATION_MODEL: tuple[str, object, object] | None = None  # (model_name, tokenizer, model)

FILLER_WORDS = {
    "а-а-а",
    "без проблем",
    "блин",
    "буквально",
    "в натуре",
    "в некотором роде",
    "в общем",
    "в общем-то",
    "в принципе",
    "в самом деле",
    "в целом",
    "ведь",
    "видишь",
    "вообще",
    "вот",
    "всё такое",
    "да",
    "да ладно",
    "допустим",
    "достаточно",
    "ешкин кот",
    "знаешь",
    "значит",
    "итак",
    "как бы",
    "как говорится",
    "как его",
    "как сказать",
    "как-то так",
    "конкретно",
    "короче",
    "на самом деле",
    "на фиг",
    "на хрен",
    "например",
    "не вопрос",
    "нет",
    "ничего себе",
    "ну",
    "ну вот",
    "ну это",
    "понимаешь",
    "походу",
    "практически",
    "прикинь",
    "прикол",
    "просто",
    "прямо",
    "скажем",
    "слушай",
    "слышишь",
    "собственно говоря",
    "так вот",
    "так далее",
    "так сказать",
    "таким образом",
    "типа",
    "типа того",
    "то есть",
    "только",
    "фактически",
    "эм",
    "это",
    "это самое",
    "э-э-э",
}

MAX_TEMPO_DEVIATION = 40
MAX_LOUDNESS_DEVIATION = 12
MAX_PAUSE_SECONDS_DEVIATION = 2

SCENARIO_NORMS = {
    "presentation": ((140, 160), 3, (-24, -16), (0.3, 5.0)),
    "public": ((140, 160), 3, (-24, -16), (0.3, 5.0)),
    "pitch": ((150, 170), 2, (-22, -14), (0.3, 5.0)),
    "business": ((150, 170), 2, (-22, -14), (0.3, 5.0)),
    "podcast": ((150, 170), 5, (-19, -16), (0.3, 5.0)),
    "free": ((120, 180), 7, (-26, -14), (0.3, 5.0)),
    "conversation": ((120, 180), 7, (-26, -14), (0.3, 5.0)),
    "interview": ((120, 180), 7, (-26, -14), (0.3, 5.0)),
}

WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё]+(?:-[A-Za-zА-Яа-яЁё]+)?")


@dataclass
class PauseStats:
    count: int
    short_count: int
    medium_count: int
    long_count: int
    total_seconds: float
    average_seconds: float | None
    max_seconds: float | None
    source: str
    pauses: list[dict[str, float]]


@dataclass
class AudioAnalysis:
    score: int
    overall: str
    recommendation: str
    metrics: list[dict[str, Any]]
    progress: list[dict[str, Any]]
    duration_seconds: int | None
    transcript: str
    transcript_blocks: list[dict[str, Any]]


def analyze_audio(file_path: Path, scenario: str = "presentation") -> AudioAnalysis:
    with ThreadPoolExecutor(max_workers=4) as executor:
        future_transcript = executor.submit(transcribe_audio, file_path)
        future_duration = executor.submit(detect_duration_seconds, file_path)
        future_rms = executor.submit(detect_rms_dbfs, file_path)
        future_loudness = executor.submit(detect_loudness_profile, file_path, scenario)

        transcript, transcript_note, transcript_segments = future_transcript.result()
        duration_seconds = future_duration.result()
        rms_dbfs = future_rms.result()
        loudness_profile = future_loudness.result()

    transcript_blocks = build_transcript_blocks(transcript, transcript_segments)
    pause_stats = detect_pauses(file_path, duration_seconds, transcript_segments)
    words = extract_words(transcript)
    filler_counts = count_fillers(transcript)

    speech_minutes = None
    if duration_seconds:
        pause_seconds = min(pause_stats.total_seconds, duration_seconds * 0.8)
        speech_minutes = max((duration_seconds - pause_seconds) / 60, duration_seconds / 60 * 0.25)

    words_per_minute = round(len(words) / speech_minutes) if speech_minutes else None
    score = calculate_score(words_per_minute, pause_stats, filler_counts, rms_dbfs, transcript_note, scenario, speech_minutes)
    metrics = build_metrics(
        words_per_minute,
        pause_stats,
        filler_counts,
        rms_dbfs,
        transcript_note,
        scenario,
        speech_minutes,
        loudness_profile,
    )

    return AudioAnalysis(
        score=score,
        overall=build_overall(score),
        recommendation=build_recommendation(
            words_per_minute,
            pause_stats,
            filler_counts,
            rms_dbfs,
            transcript_note,
            scenario,
            speech_minutes,
        ),
        metrics=metrics,
        progress=[{"date": datetime.now().strftime("%d.%m.%Y"), "score": score}],
        duration_seconds=duration_seconds,
        transcript=transcript,
        transcript_blocks=transcript_blocks,
    )


def transcribe_audio(file_path: Path) -> tuple[str, str | None, list[dict[str, Any]]]:
    backend = os.getenv("WHISPER_BACKEND", "gigaam").lower()
    if backend == "api":
        return transcribe_audio_with_openai_api(file_path)
    if backend == "gigaam":
        return transcribe_audio_with_gigaam(file_path)
    result = transcribe_audio_with_faster_whisper(file_path)
    if result is not None:
        return result
    return transcribe_audio_with_local_whisper(file_path)


def transcribe_audio_with_local_whisper(file_path: Path) -> tuple[str, str | None, list[dict[str, Any]]]:
    try:
        import whisper
    except ImportError:
        return "", "Установите openai-whisper, чтобы включить локальную транскрибацию Whisper.", []

    model_name = os.getenv("WHISPER_MODEL", "small")
    language = os.getenv("WHISPER_LANGUAGE", "ru")

    try:
        model = get_local_whisper_model(whisper, model_name)
        audio = load_audio_for_whisper(file_path)
        result = model.transcribe(
            audio,
            language=language,
            fp16=False,
            temperature=0,
            beam_size=5,
            condition_on_previous_text=True,
            initial_prompt="Это выступление на русском языке.",
            no_speech_threshold=0.4,
        )
    except Exception as exc:
        return "", f"Локальная транскрибация Whisper недоступна: {exc}", []

    segments = [
        {
            "start": float(segment.get("start", 0)),
            "end": float(segment.get("end", 0)),
            "text": str(segment.get("text", "")).strip(),
        }
        for segment in result.get("segments", [])
        if str(segment.get("text", "")).strip()
    ]
    return str(result.get("text", "")).strip(), None, segments


def transcribe_audio_with_gigaam(file_path: Path) -> tuple[str, str | None, list[dict[str, Any]]]:
    try:
        import gigaam
    except ImportError:
        return "", "Установите gigaam (pip install gigaam), чтобы включить транскрибацию GigaAM-CTC.", []

    model_name = os.getenv("GIGAAM_MODEL", "v2_ctc")

    try:
        configure_gigaam_audio_loader(gigaam)
        model = get_gigaam_model(gigaam, model_name)
        if os.getenv("HF_TOKEN"):
            raw_segments = model.transcribe_longform(str(file_path))
        else:
            raw_segments = transcribe_gigaam_in_chunks(model, gigaam, file_path)
    except Exception as exc:
        return "", f"GigaAM недоступен: {exc}", []

    segments: list[dict[str, Any]] = []
    texts: list[str] = []
    for seg in raw_segments:
        text = seg.get("transcription", "").strip()
        boundaries = seg.get("boundaries", (0.0, 0.0))
        if text:
            text = restore_punctuation(text)
            segments.append({
                "start": float(boundaries[0]),
                "end": float(boundaries[1]),
                "text": text,
            })
            texts.append(text)

    return " ".join(texts), None, segments


def restore_punctuation(text: str) -> str:
    if not text.strip() or os.getenv("PUNCTUATION_ENABLED", "1").lower() in {"0", "false", "no"}:
        return text

    try:
        tokenizer, model = get_punctuation_model()
        words = normalize_text_for_punctuation(text)
        if not words:
            return text
        return punctuate_words(words, tokenizer, model)
    except Exception:
        return text


def normalize_text_for_punctuation(text: str) -> list[str]:
    return re.findall(r"[A-Za-zА-Яа-яЁё0-9]+(?:-[A-Za-zА-Яа-яЁё0-9]+)?", text.lower())


def get_punctuation_model():
    global _PUNCTUATION_MODEL

    model_name = os.getenv("PUNCTUATION_MODEL", "markusiko/rubert-base-punctuation")
    if _PUNCTUATION_MODEL is None or _PUNCTUATION_MODEL[0] != model_name:
        from transformers import AutoModelForTokenClassification, AutoTokenizer

        cache_dir = get_huggingface_model_cache_dir()
        tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir=str(cache_dir))
        model = AutoModelForTokenClassification.from_pretrained(model_name, cache_dir=str(cache_dir))
        model.eval()
        _PUNCTUATION_MODEL = (model_name, tokenizer, model)
    return _PUNCTUATION_MODEL[1], _PUNCTUATION_MODEL[2]


def get_huggingface_model_cache_dir() -> Path:
    cache_dir = Path(os.getenv("HF_HOME", Path(__file__).resolve().parents[2] / "models" / "huggingface"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def punctuate_words(words: list[str], tokenizer, model) -> str:
    import torch

    max_words = int(os.getenv("PUNCTUATION_CHUNK_WORDS", "220"))
    chunks = [words[index:index + max_words] for index in range(0, len(words), max_words)]
    punctuated_chunks = [punctuate_word_chunk(chunk, tokenizer, model, torch) for chunk in chunks]
    result = " ".join(chunk for chunk in punctuated_chunks if chunk).strip()
    return capitalize_sentence_starts(result)


def punctuate_word_chunk(words: list[str], tokenizer, model, torch_module) -> str:
    encoded = tokenizer(
        words,
        is_split_into_words=True,
        return_tensors="pt",
        truncation=True,
        max_length=512,
    )

    with torch_module.inference_mode():
        predictions = model(**encoded).logits.argmax(dim=-1)[0].tolist()

    id_to_label = model.config.id2label
    word_marks: list[str] = [""] * len(words)
    previous_word_id: int | None = None
    for token_index, word_id in enumerate(encoded.word_ids()):
        if word_id is None or word_id == previous_word_id or word_id >= len(word_marks):
            previous_word_id = word_id
            continue

        label = str(id_to_label.get(predictions[token_index], "O"))
        word_marks[word_id] = punctuation_from_label(label)
        previous_word_id = word_id

    return " ".join(f"{word}{mark}" for word, mark in zip(words, word_marks)).strip()


def punctuation_from_label(label: str) -> str:
    normalized = label.upper().replace("LABEL_", "")
    if "-" in normalized:
        normalized = normalized.split("-", 1)[1]
    return {
        "COMMA": ",",
        ",": ",",
        "PERIOD": ".",
        "DOT": ".",
        ".": ".",
        "QUESTION": "?",
        "?": "?",
        "EXCLAMATION": "!",
        "EXCLAMATION_MARK": "!",
        "!": "!",
        "COLON": ":",
        ":": ":",
        "ELLIPSIS": "...",
        "...": "...",
    }.get(normalized, "")


def capitalize_sentence_starts(text: str) -> str:
    result = []
    should_capitalize = True
    for char in text:
        if should_capitalize and char.isalpha():
            result.append(char.upper())
            should_capitalize = False
        else:
            result.append(char)
        if char in ".!?":
            should_capitalize = True
    return "".join(result)


def transcribe_gigaam_in_chunks(model, gigaam_module, file_path: Path) -> list[dict[str, Any]]:
    import torch

    sample_rate = 16_000
    chunk_samples = 20 * sample_rate
    wav = gigaam_module.load_audio(str(file_path), return_format="float")

    transcribed_segments: list[dict[str, Any]] = []
    for start in range(0, wav.shape[-1], chunk_samples):
        segment = wav[start:start + chunk_samples]
        if segment.numel() == 0:
            continue

        model_input = segment.to(model._device).unsqueeze(0).to(model._dtype)
        length = torch.full([1], model_input.shape[-1], device=model._device)
        encoded, encoded_len = model.forward(model_input, length)
        text = model.decoding.decode(model.head, encoded, encoded_len)[0].strip()
        if text:
            transcribed_segments.append({
                "transcription": text,
                "boundaries": (start / sample_rate, (start + segment.numel()) / sample_rate),
            })

    return transcribed_segments


def configure_gigaam_audio_loader(gigaam_module) -> None:
    ffmpeg_exe = get_imageio_ffmpeg_exe()
    if ffmpeg_exe is None:
        return

    import torch

    def load_audio_with_bundled_ffmpeg(audio_path: str, sample_rate: int = 16000, return_format: str = "float"):
        cmd = [
            ffmpeg_exe,
            "-nostdin",
            "-threads",
            "0",
            "-i",
            audio_path,
            "-f",
            "s16le",
            "-ac",
            "1",
            "-acodec",
            "pcm_s16le",
            "-ar",
            str(sample_rate),
            "-",
        ]
        completed = subprocess.run(cmd, capture_output=True)
        if completed.returncode != 0:
            raise RuntimeError(ffmpeg_error_message(completed.stderr))
        audio = bytearray(completed.stdout)
        if return_format == "float":
            return torch.frombuffer(audio, dtype=torch.int16).float() / 32768.0
        return torch.frombuffer(audio, dtype=torch.int16)

    try:
        from gigaam import model as gigaam_model
        from gigaam import preprocess as gigaam_preprocess
    except ImportError:
        return

    gigaam_module.load_audio = load_audio_with_bundled_ffmpeg
    gigaam_model.load_audio = load_audio_with_bundled_ffmpeg
    gigaam_preprocess.load_audio = load_audio_with_bundled_ffmpeg


def get_imageio_ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg
    except ImportError:
        return None

    ffmpeg_exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
    if ffmpeg_exe.exists():
        return str(ffmpeg_exe)
    return None


def get_gigaam_model(gigaam_module, model_name: str):
    global _GIGAAM_MODEL

    if _GIGAAM_MODEL is None or _GIGAAM_MODEL[0] != model_name:
        import torch
        allow_gigaam_checkpoint_globals(torch)
        _orig_load = torch.load

        def load_trusted_gigaam_checkpoint(*args, **kwargs):
            kwargs.setdefault("weights_only", False)
            return _orig_load(*args, **kwargs)

        torch.load = load_trusted_gigaam_checkpoint
        try:
            use_fp16 = torch.cuda.is_available()
            _GIGAAM_MODEL = (model_name, gigaam_module.load_model(model_name, fp16_encoder=use_fp16))
        finally:
            torch.load = _orig_load
    return _GIGAAM_MODEL[1]


def allow_gigaam_checkpoint_globals(torch_module) -> None:
    try:
        from omegaconf.base import ContainerMetadata
    except ImportError:
        return

    try:
        torch_module.serialization.add_safe_globals([ContainerMetadata])
    except AttributeError:
        return


def get_local_whisper_model(whisper_module, model_name: str):
    global _WHISPER_MODEL

    if _WHISPER_MODEL is None or _WHISPER_MODEL[0] != model_name:
        cache_dir = get_local_whisper_model_cache_dir()
        _WHISPER_MODEL = (model_name, whisper_module.load_model(model_name, download_root=str(cache_dir)))
    return _WHISPER_MODEL[1]


def get_local_whisper_model_cache_dir() -> Path:
    cache_dir = Path(os.getenv("WHISPER_CACHE_DIR", Path(__file__).resolve().parents[2] / "models" / "whisper"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def transcribe_audio_with_faster_whisper(
    file_path: Path,
) -> tuple[str, str | None, list[dict[str, Any]]] | None:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None

    model_name = os.getenv("WHISPER_MODEL", "large-v3")
    language = os.getenv("WHISPER_LANGUAGE", "ru")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

    try:
        model = get_faster_whisper_model(WhisperModel, model_name, compute_type)
        segments_iter, _ = model.transcribe(
            str(file_path),
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            initial_prompt="Это выступление на русском языке.",
            temperature=0,
            condition_on_previous_text=True,
        )

        segments: list[dict[str, Any]] = []
        texts: list[str] = []
        for seg in segments_iter:
            text = seg.text.strip()
            if text:
                segments.append({"start": float(seg.start), "end": float(seg.end), "text": text})
                texts.append(text)

        return " ".join(texts), None, segments
    except Exception as exc:
        return "", f"faster-whisper недоступен: {exc}", []


def get_faster_whisper_model(model_class, model_name: str, compute_type: str):
    global _FASTER_WHISPER_MODEL

    key = f"{model_name}:{compute_type}"
    if _FASTER_WHISPER_MODEL is None or _FASTER_WHISPER_MODEL[0] != key:
        cache_dir = get_local_whisper_model_cache_dir()
        _FASTER_WHISPER_MODEL = (key, model_class(model_name, device="cpu", compute_type=compute_type, download_root=str(cache_dir)))
    return _FASTER_WHISPER_MODEL[1]


def load_audio_for_whisper(file_path: Path) -> np.ndarray:
    return load_audio_array(file_path, sampling_rate=16_000)


def transcribe_audio_with_openai_api(file_path: Path) -> tuple[str, str | None, list[dict[str, Any]]]:
    if not os.getenv("OPENAI_API_KEY"):
        return "", "Добавьте OPENAI_API_KEY или используйте WHISPER_BACKEND=local для локального Whisper.", []

    try:
        from openai import OpenAI
    except ImportError:
        return "", "Установите пакет openai, чтобы включить транскрибацию.", []

    model = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
    language = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "ru")

    try:
        client = OpenAI()
        with file_path.open("rb") as audio_file:
            transcription = client.audio.transcriptions.create(
                model=model,
                file=audio_file,
                language=language,
                response_format="verbose_json",
                prompt="Это выступление на русском языке.",
                timestamp_granularities=["segment"],
            )
    except Exception as exc:
        return "", f"Транскрибация недоступна: {exc}", []

    text = getattr(transcription, "text", None) or ""
    segments = []
    for seg in getattr(transcription, "segments", None) or []:
        start = float(getattr(seg, "start", 0))
        end = float(getattr(seg, "end", 0))
        seg_text = str(getattr(seg, "text", "")).strip()
        if seg_text:
            segments.append({"start": start, "end": end, "text": seg_text})
    return text.strip(), None, segments


def build_transcript_blocks(transcript: str, segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return [{"type": "text", "text": transcript}] if transcript else []

    blocks: list[dict[str, Any]] = []
    previous_end: float | None = None

    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        text = str(segment["text"]).strip()

        if previous_end is not None:
            pause_duration = round(max(start - previous_end, 0), 2)
            if pause_duration >= 0.2:
                blocks.append(
                    {
                        "type": "pause",
                        "duration": pause_duration,
                        "level": pause_level(pause_duration),
                    }
                )

        if text:
            blocks.append({"type": "text", "text": text})
        previous_end = end

    return blocks


def pause_level(duration: float) -> str:
    if duration > 1.0:
        return "long"
    if duration >= 0.4:
        return "medium"
    return "short"


def detect_duration_seconds(file_path: Path) -> int | None:
    ffmpeg = get_ffmpeg_exe()
    command = [ffmpeg, "-i", str(file_path)]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", completed.stderr)
        if match is None:
            return detect_decoded_duration_seconds(file_path) or detect_wav_duration_seconds(file_path)
        hours, minutes, seconds = match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        return max(round(duration), 1)
    except Exception:
        return detect_decoded_duration_seconds(file_path) or detect_wav_duration_seconds(file_path)


def detect_decoded_duration_seconds(file_path: Path) -> int | None:
    try:
        samples = load_audio_array(file_path, sampling_rate=16_000)
    except Exception:
        return None

    if samples.size == 0:
        return None

    return max(round(samples.size / 16_000), 1)


def detect_wav_duration_seconds(file_path: Path) -> int | None:
    try:
        with wave.open(str(file_path), "rb") as wav:
            frames = wav.getnframes()
            frame_rate = wav.getframerate()
            if frame_rate <= 0:
                return None
            return max(round(frames / frame_rate), 1)
    except Exception:
        return None


def detect_rms_dbfs(file_path: Path) -> float | None:
    try:
        waveform = load_audio_array(file_path, sampling_rate=16_000)
    except Exception:
        return None

    if waveform.size == 0:
        return None

    speech_mask = np.abs(waveform) > dbfs_to_amplitude(-45)
    speech_samples = waveform[speech_mask]
    if speech_samples.size < 1600:
        speech_samples = waveform

    rms = float(np.sqrt(np.mean(np.square(speech_samples))))
    if rms <= 0:
        return None
    return round(20 * np.log10(rms), 1)


def detect_loudness_profile(file_path: Path, scenario: str, window_seconds: float = 1.0) -> dict[str, Any] | None:
    sampling_rate = 16_000
    try:
        waveform = load_audio_array(file_path, sampling_rate=sampling_rate)
    except Exception:
        return None

    if waveform.size == 0:
        return None

    window_size = max(int(sampling_rate * window_seconds), 1)
    norm_min, norm_max = norm_for_scenario(scenario)[2]
    points: list[dict[str, float]] = []

    for start in range(0, waveform.size, window_size):
        window = waveform[start:start + window_size]
        if window.size == 0:
            continue

        rms = float(np.sqrt(np.mean(np.square(window))))
        dbfs = -60.0 if rms <= 0 else max(round(20 * np.log10(rms), 1), -60.0)
        points.append({
            "time": round(start / sampling_rate, 1),
            "dbfs": dbfs,
        })

    if not points:
        return None

    values = [point["dbfs"] for point in points]
    in_norm_count = sum(1 for value in values if norm_min <= value <= norm_max)

    return {
        "type": "loudness_profile",
        "points": points,
        "average_dbfs": round(mean(values), 1),
        "min_dbfs": min(values),
        "max_dbfs": max(values),
        "in_norm_percent": round(in_norm_count / len(values) * 100),
        "norm_min": norm_min,
        "norm_max": norm_max,
    }


def dbfs_to_amplitude(dbfs: float) -> float:
    return 10 ** (dbfs / 20)


def detect_pauses(file_path: Path, duration_seconds: int | None, transcript_segments: list[dict[str, Any]] | None = None) -> PauseStats:
    silero_stats = detect_pauses_with_silero(file_path)
    if silero_stats is not None:
        return silero_stats

    ffmpeg_stats = detect_pauses_with_ffmpeg(file_path)
    if ffmpeg_stats is not None:
        return ffmpeg_stats

    transcript_stats = detect_pauses_from_transcript_segments(transcript_segments or [])
    if transcript_stats is not None:
        return transcript_stats

    return PauseStats(
        count=0,
        short_count=0,
        medium_count=0,
        long_count=0,
        total_seconds=0,
        average_seconds=None,
        max_seconds=None,
        source="unavailable" if duration_seconds else "unknown-duration",
        pauses=[],
    )


def detect_pauses_from_transcript_segments(segments: list[dict[str, Any]]) -> PauseStats | None:
    if not segments:
        return None

    pauses: list[dict[str, float]] = []
    previous_end: float | None = None

    for segment in segments:
        try:
            start = float(segment["start"])
            end = float(segment["end"])
        except (KeyError, TypeError, ValueError):
            continue

        if previous_end is not None and start > previous_end:
            pauses.append({
                "start": round(previous_end, 2),
                "end": round(start, 2),
                "duration": round(start - previous_end, 2),
            })
        previous_end = max(previous_end or 0, end)

    useful_pauses = [pause for pause in pauses if pause["duration"] >= 0.2]
    return make_pause_stats(useful_pauses, "transcript-segments")


def detect_pauses_with_silero(file_path: Path) -> PauseStats | None:
    if int(np.__version__.split(".", 1)[0]) >= 2:
        return None

    try:
        from silero_vad import get_speech_timestamps, load_silero_vad
    except ImportError:
        return None

    try:
        sampling_rate = 16_000
        model = load_silero_vad(onnx=True)
        wav = load_audio_for_vad(file_path, sampling_rate)
        speech_segments = get_speech_timestamps(wav, model, sampling_rate=sampling_rate)
    except Exception:
        return None

    pauses = []
    previous_end = 0
    for segment in speech_segments:
        start = segment["start"] / sampling_rate
        end = segment["end"] / sampling_rate
        if start > previous_end:
            pauses.append({
                "start": round(previous_end, 2),
                "end": round(start, 2),
                "duration": round(start - previous_end, 2),
            })
        previous_end = end

    useful_pauses = [pause for pause in pauses if pause["duration"] >= 0.2]
    return make_pause_stats(useful_pauses, "silero-vad")


def load_audio_for_vad(file_path: Path, sampling_rate: int):
    import torch

    waveform = load_audio_array(file_path, sampling_rate)
    return torch.from_numpy(waveform)


def load_audio_array(file_path: Path, sampling_rate: int) -> np.ndarray:
    ffmpeg = get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-i",
        str(file_path),
        "-ac",
        "1",
        "-ar",
        str(sampling_rate),
        "-f",
        "f32le",
        "-",
    ]
    completed = subprocess.run(command, capture_output=True, timeout=120)
    if completed.returncode != 0:
        raise RuntimeError(ffmpeg_error_message(completed.stderr))
    return np.frombuffer(completed.stdout, dtype=np.float32).copy()


def can_decode_audio(file_path: Path) -> bool:
    try:
        samples = load_audio_array(file_path, sampling_rate=16_000)
    except Exception:
        return False
    return samples.size > 0


def ffmpeg_error_message(stderr: bytes | str | None) -> str:
    if isinstance(stderr, bytes):
        message = stderr.decode("utf-8", errors="replace")
    else:
        message = stderr or ""

    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if not lines:
        return "ffmpeg не смог прочитать аудио из файла."
    return lines[-1][:500]


def detect_pauses_with_ffmpeg(file_path: Path) -> PauseStats | None:
    ffmpeg = get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-i",
        str(file_path),
        "-af",
        "silencedetect=noise=-35dB:d=0.2",
        "-f",
        "null",
        "-",
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
    except Exception:
        return None

    pauses = parse_ffmpeg_silences(completed.stderr or "")
    if not pauses and completed.returncode != 0:
        return None
    return make_pause_stats(pauses, "ffmpeg-silencedetect")


def parse_ffmpeg_silences(stderr: str) -> list[dict[str, float]]:
    pauses: list[dict[str, float]] = []
    current_start: float | None = None

    for line in stderr.splitlines():
        start_match = re.search(r"silence_start:\s*(\d+(?:\.\d+)?)", line)
        if start_match:
            current_start = float(start_match.group(1))
            continue

        end_match = re.search(
            r"silence_end:\s*(\d+(?:\.\d+)?).*?silence_duration:\s*(\d+(?:\.\d+)?)",
            line,
        )
        if end_match:
            end = float(end_match.group(1))
            duration = float(end_match.group(2))
            start = current_start if current_start is not None else max(end - duration, 0)
            pauses.append({
                "start": round(start, 2),
                "end": round(end, 2),
                "duration": round(duration, 2),
            })
            current_start = None

    return [pause for pause in pauses if pause["duration"] >= 0.2]


def get_ffmpeg_exe() -> str:
    configured = os.getenv("FFMPEG_BINARY")
    if configured:
        return configured

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def make_pause_stats(pauses: list[dict[str, float]], source: str) -> PauseStats:
    durations = [pause["duration"] for pause in pauses]
    return PauseStats(
        count=len(durations),
        short_count=sum(1 for pause in durations if pause < 0.3),
        medium_count=sum(1 for pause in durations if 0.3 <= pause <= 5.0),
        long_count=sum(1 for pause in durations if pause > 5.0),
        total_seconds=round(sum(durations), 2),
        average_seconds=round(mean(durations), 2) if durations else None,
        max_seconds=round(max(durations), 2) if durations else None,
        source=source,
        pauses=pauses,
    )


def extract_words(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


def count_fillers(text: str) -> dict[str, int]:
    normalized = normalize_text(text)
    counts: dict[str, int] = {}
    occupied = [False] * len(normalized)

    for filler in sorted(FILLER_WORDS, key=len, reverse=True):
        phrase = normalize_text(filler).strip()
        pattern = rf"(?<![A-Za-zА-Яа-яЁё]){re.escape(phrase)}(?![A-Za-zА-Яа-яЁё])"
        count = 0
        for match in re.finditer(pattern, normalized):
            start, end = match.span()
            if any(occupied[start:end]):
                continue
            occupied[start:end] = [True] * (end - start)
            count += 1
        if count:
            counts[filler] = count

    return counts


def normalize_text(text: str) -> str:
    normalized = text.lower().replace("ё", "е")
    normalized = re.sub(r"[^\w\s-]+", " ", normalized, flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized)
    return f" {normalized.strip()} "


def calculate_score(
    words_per_minute: int | None,
    pause_stats: PauseStats,
    filler_counts: dict[str, int],
    rms_dbfs: float | None,
    transcript_note: str | None,
    scenario: str,
    speech_minutes: float | None,
) -> int:
    if transcript_note:
        return 35

    metric_scores = build_metric_scores(words_per_minute, pause_stats, filler_counts, rms_dbfs, scenario, speech_minutes)
    available_scores = [score for score in metric_scores.values() if score is not None]
    if not available_scores:
        return 35
    return max(min(round(mean(available_scores)), 100), 0)


def build_metric_scores(
    words_per_minute: int | None,
    pause_stats: PauseStats,
    filler_counts: dict[str, int],
    rms_dbfs: float | None,
    scenario: str,
    speech_minutes: float | None,
) -> dict[str, int | None]:
    tempo_range, filler_max, loudness_range, pause_range = norm_for_scenario(scenario)
    tempo_min, tempo_max = tempo_range
    filler_rate = filler_rate_per_minute(filler_counts, speech_minutes)
    pause_average = pause_stats.average_seconds if pause_stats.average_seconds is not None else 0
    pause_max = pause_stats.max_seconds if pause_stats.max_seconds is not None else pause_average
    if pause_stats.source == "unavailable":
        pause_average = None
        pause_max = None
    pause_average_score = score_for_range(pause_average, *pause_range, MAX_PAUSE_SECONDS_DEVIATION)
    pause_max_score = score_for_range(pause_max, *pause_range, MAX_PAUSE_SECONDS_DEVIATION)
    return {
        "tempo": score_for_range(words_per_minute, tempo_min, tempo_max, MAX_TEMPO_DEVIATION),
        "pauses": min(score for score in [pause_average_score, pause_max_score] if score is not None)
        if pause_average_score is not None or pause_max_score is not None
        else None,
        "fillers": score_for_range(filler_rate, 0, filler_max, filler_max),
        "loudness": score_for_range(rms_dbfs, *loudness_range, MAX_LOUDNESS_DEVIATION),
    }


def score_for_range(value: float | int | None, norm_min: float, norm_max: float, max_deviation: float) -> int | None:
    if value is None:
        return None
    if norm_min <= value <= norm_max:
        return 100

    deviation = norm_min - value if value < norm_min else value - norm_max
    return max(0, round(100 - (deviation / max_deviation * 100)))


def build_metrics(
    words_per_minute: int | None,
    pause_stats: PauseStats,
    filler_counts: dict[str, int],
    rms_dbfs: float | None,
    transcript_note: str | None,
    scenario: str,
    speech_minutes: float | None,
    loudness_profile: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    filler_total = sum(filler_counts.values())
    filler_rate = filler_rate_per_minute(filler_counts, speech_minutes)
    scores = build_metric_scores(words_per_minute, pause_stats, filler_counts, rms_dbfs, scenario, speech_minutes)
    if transcript_note:
        scores["tempo"] = None
        scores["fillers"] = None
    filler_text = "не найдены"
    if filler_counts:
        filler_text = ", ".join(
            f"{word}: {count}"
            for word, count in sorted(filler_counts.items(), key=lambda item: item[1], reverse=True)[:6]
        )

    tempo_range, filler_max, loudness_range, pause_range = norm_for_scenario(scenario)
    tempo_min, tempo_max = tempo_range
    loudness_min, loudness_max = loudness_range
    pause_min, pause_max = pause_range

    return [
        {
            "title": "Скорость речи",
            "state": state_for_tempo(words_per_minute, scenario),
            "score": scores["tempo"],
            "value": (
                f"{words_per_minute} слов/мин; норма {tempo_min}-{tempo_max}"
                if words_per_minute
                else "нужна длительность записи"
            ),
            "note": tempo_note(words_per_minute, scenario),
        },
        {
            "title": "Паузы",
            "state": state_for_pause(pause_stats, scenario),
            "score": scores["pauses"],
            "value": (
                f"средняя {format_seconds(pause_stats.average_seconds)}; максимум {format_seconds(pause_stats.max_seconds)}; норма {pause_min}-{pause_max} сек"
                if pause_stats.source != "unavailable"
                else "нужен Silero VAD или ffmpeg"
            ),
            "note": pause_note(pause_stats, scenario),
            "details": pause_details(pause_stats, scenario),
        },
        {
            "title": "Слова-паразиты",
            "state": state_for_filler_rate(filler_rate, scenario),
            "score": scores["fillers"],
            "value": (
                f"{format_rate(filler_rate)}/мин; норма ≤ {format_rate(filler_max)}/мин"
                if filler_rate is not None
                else "нужна транскрипция" if transcript_note else "нужна длительность записи"
            ),
            "note": filler_note(filler_total, filler_text, transcript_note),
        },
        {
            "title": "Громкость",
            "state": state_for_rms_dbfs(rms_dbfs, scenario),
            "score": scores["loudness"],
            "value": (
                f"{rms_dbfs} dBFS RMS; норма {loudness_min}...{loudness_max} dBFS"
                if rms_dbfs is not None
                else "нужен ffmpeg"
            ),
            "note": loudness_note(rms_dbfs, scenario),
            "details": loudness_profile,
        },
    ]


def pause_details(pause_stats: PauseStats, scenario: str) -> dict[str, Any] | None:
    if not pause_stats.pauses:
        return None

    pause_min, pause_max = norm_for_scenario(scenario)[3]
    short_pauses = [pause for pause in pause_stats.pauses if pause["duration"] < pause_min]
    long_pauses = [pause for pause in pause_stats.pauses if pause["duration"] > pause_max]

    return {
        "type": "pause_profile",
        "pauses": pause_stats.pauses,
        "short_pauses": short_pauses,
        "long_pauses": long_pauses,
        "norm_min": pause_min,
        "norm_max": pause_max,
        "source": pause_stats.source,
    }


def tempo_range_for_scenario(scenario: str) -> tuple[int, int]:
    return norm_for_scenario(scenario)[0]


def norm_for_scenario(scenario: str) -> tuple[tuple[int, int], float, tuple[float, float], tuple[float, float]]:
    return SCENARIO_NORMS.get(scenario, SCENARIO_NORMS["presentation"])


def filler_rate_per_minute(filler_counts: dict[str, int], speech_minutes: float | None) -> float | None:
    if not speech_minutes:
        return None
    return round(sum(filler_counts.values()) / speech_minutes, 1)


def format_rate(value: float | None) -> str:
    if value is None:
        return "нет данных"
    return str(int(value)) if float(value).is_integer() else str(value)


def format_seconds(value: float | None) -> str:
    if value is None:
        return "0 сек"
    return f"{value:g} сек"


def state_for_tempo(words_per_minute: int | None, scenario: str) -> str:
    if words_per_minute is None:
        return "warning"
    tempo_min, tempo_max = tempo_range_for_scenario(scenario)
    if tempo_min <= words_per_minute <= tempo_max:
        return "good"
    return "warning"


def tempo_note(words_per_minute: int | None, scenario: str) -> str:
    if words_per_minute is None:
        return "Темп считается после распознавания речи."

    tempo_min, tempo_max = tempo_range_for_scenario(scenario)
    if tempo_min <= words_per_minute <= tempo_max:
        return "Темп находится в рекомендуемом диапазоне для выбранного сценария."
    if words_per_minute > tempo_max:
        return "Темп выше нормы: слушателю может быть сложнее успевать за мыслью."
    return "Темп ниже нормы: выступление может звучать менее энергично."


def state_for_pause(pause_stats: PauseStats, scenario: str) -> str:
    if pause_stats.source == "unavailable":
        return "warning"
    pause_average = pause_stats.average_seconds if pause_stats.average_seconds is not None else 0
    longest_pause = pause_stats.max_seconds if pause_stats.max_seconds is not None else pause_average
    pause_min, pause_max_norm = norm_for_scenario(scenario)[3]
    if pause_min <= pause_average <= pause_max_norm and longest_pause <= pause_max_norm:
        return "good"
    return "warning"


def state_for_filler_rate(filler_rate: float | None, scenario: str) -> str:
    if filler_rate is None:
        return "warning"
    filler_max = norm_for_scenario(scenario)[1]
    return "good" if filler_rate <= filler_max else "warning"


def pause_note(pause_stats: PauseStats, scenario: str) -> str:
    if pause_stats.source == "unavailable":
        return "Паузы считаются по VAD или ffmpeg: учитываются средняя и самая длинная пауза."
    pause_min, pause_max_norm = norm_for_scenario(scenario)[3]
    if pause_stats.average_seconds is None:
        return f"Паузы не обнаружены; нормативная длительность {pause_min}-{pause_max_norm} сек."
    if pause_stats.max_seconds is not None and pause_stats.max_seconds > pause_max_norm:
        return f"Есть длинная пауза {format_seconds(pause_stats.max_seconds)}: она выбивается из нормы {pause_min}-{pause_max_norm} сек."
    if pause_min <= pause_stats.average_seconds <= pause_max_norm:
        return f"Средняя и максимальная длительность пауз в нормативном диапазоне {pause_min}-{pause_max_norm} сек."
    if pause_stats.average_seconds < pause_min:
        return "Паузы слишком короткие: речь может звучать без опорных смысловых остановок."
    return "Паузы длиннее нормы: стоит плотнее держать темп между тезисами."


def filler_note(filler_total: int, filler_text: str, transcript_note: str | None) -> str:
    if transcript_note:
        return "Слова-паразиты считаются после распознавания речи."
    if filler_total:
        return f"Всего найдено {filler_total}; чаще всего: {filler_text}."
    return "Слова-паразиты из словаря не найдены."


def state_for_rms_dbfs(rms_dbfs: float | None, scenario: str) -> str:
    if rms_dbfs is None:
        return "warning"
    loudness_min, loudness_max = norm_for_scenario(scenario)[2]
    if loudness_min <= rms_dbfs <= loudness_max:
        return "good"
    return "warning"


def loudness_note(rms_dbfs: float | None, scenario: str) -> str:
    loudness_min, loudness_max = norm_for_scenario(scenario)[2]
    if rms_dbfs is None:
        return "Громкость считается как RMS dBFS по речевым сегментам."
    if loudness_min <= rms_dbfs <= loudness_max:
        return f"Громкость в нормативном диапазоне {loudness_min}...{loudness_max} dBFS."
    if rms_dbfs < loudness_min:
        return "Громкость ниже нормы: голос может звучать тише и менее уверенно."
    return "Громкость выше нормы: запись может восприниматься слишком напористо или перегруженно."


_METRIC_STRENGTH_LABELS: dict[str, str] = {
    "Скорость речи": "Хороший темп",
    "Паузы": "Грамотные паузы",
    "Слова-паразиты": "Чистая речь",
    "Громкость": "Комфортная громкость",
}


def build_strengths_from_metrics(metrics: list[dict[str, Any]], score: int) -> list[str]:
    strengths = [
        _METRIC_STRENGTH_LABELS[m["title"]]
        for m in metrics
        if m.get("state") == "good" and m.get("title") in _METRIC_STRENGTH_LABELS
    ]
    if not strengths and score >= 85:
        strengths = ["Уверенное выступление"]
    return strengths


def build_overall(score: int) -> str:
    if score >= 85:
        return "Сильное и уверенное выступление"
    if score >= 70:
        return "Хорошая основа с точечными зонами роста"
    if score >= 55:
        return "Есть что улучшить в подаче"
    return "Анализ выполнен частично"


def build_overall_from_metrics(metrics: list[dict[str, Any]], score: int) -> str:
    available = [m for m in metrics if m.get("state") != "unavailable"]
    warnings = [m for m in available if m.get("state") == "warning"]

    if not warnings:
        if score >= 85:
            return "Сильное и уверенное выступление — все показатели в норме"
        return "Все показатели в норме"

    warning_names = [m["title"].lower() for m in warnings]
    joined = ", ".join(warning_names)

    if score >= 85:
        return f"Очень сильное выступление, стоит обратить внимание на: {joined}"
    if score >= 70:
        if len(warnings) == 1:
            return f"Хорошая основа, зона роста — {warning_names[0]}"
        return f"Хорошая основа, зоны роста: {joined}"
    if score >= 55:
        if len(warnings) == 1:
            return f"Основная зона роста — {warning_names[0]}"
        return f"Есть что улучшить: {joined}"
    return "Анализ выполнен частично"


def build_recommendation(
    words_per_minute: int | None,
    pause_stats: PauseStats,
    filler_counts: dict[str, int],
    rms_dbfs: float | None,
    transcript_note: str | None,
    scenario: str,
    speech_minutes: float | None,
) -> str:
    if transcript_note:
        return transcript_note
    tempo_range, filler_max, loudness_range, pause_range = norm_for_scenario(scenario)
    tempo_min, tempo_max = tempo_range
    loudness_min, loudness_max = loudness_range
    pause_min, pause_max = pause_range
    filler_rate = filler_rate_per_minute(filler_counts, speech_minutes)
    if words_per_minute and words_per_minute > tempo_max:
        return f"Темп выше рекомендуемого диапазона {tempo_min}-{tempo_max} слов/мин. Попробуйте говорить немного медленнее и делать короткие паузы после ключевых мыслей."
    if words_per_minute and words_per_minute < tempo_min:
        return f"Темп ниже рекомендуемого диапазона {tempo_min}-{tempo_max} слов/мин. Добавьте энергии в подачу и сократите лишние паузы."
    if pause_stats.average_seconds is not None and pause_stats.average_seconds > pause_max:
        return f"Средняя пауза длиннее нормы {pause_min}-{pause_max} сек. Заранее отметьте переходы между тезисами и держите паузы короче."
    if pause_stats.average_seconds is not None and pause_stats.average_seconds < pause_min:
        return f"Средняя пауза короче нормы {pause_min}-{pause_max} сек. Добавьте короткие смысловые остановки после важных мыслей."
    if filler_rate is not None and filler_rate > filler_max:
        return f"Слов-паразитов больше нормы: {format_rate(filler_rate)}/мин при норме до {format_rate(filler_max)}/мин. Заменяйте их короткой осознанной паузой."
    if rms_dbfs is not None and rms_dbfs < loudness_min:
        return "Голос звучит тихо: попробуйте записываться ближе к микрофону или говорить чуть увереннее."
    if rms_dbfs is not None and rms_dbfs > loudness_max:
        return "Голос звучит слишком громко: попробуйте отодвинуться от микрофона или снизить уровень записи."
    return "Сохраните текущий темп и добавьте более выразительные акценты в ключевых выводах."
