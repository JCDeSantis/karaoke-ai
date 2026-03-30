from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import asdict
from enum import Enum
from pathlib import Path
from typing import Any

from .models import ArtifactManifest, LyricLine, LyricWord

try:
    import imageio_ffmpeg  # type: ignore
except Exception:
    imageio_ffmpeg = None


class CancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def raise_if_cancelled(self) -> None:
        if self._cancelled:
            raise CancelledError("Job was cancelled")

    @property
    def cancelled(self) -> bool:
        return self._cancelled


class CancelledError(RuntimeError):
    pass


class MissingDependencyError(RuntimeError):
    pass


def resolve_ffmpeg_executable() -> str | None:
    explicit = os.environ.get("KARAOKEAI_FFMPEG_PATH")
    if explicit:
        explicit_path = Path(explicit)
        if explicit_path.exists():
            return str(explicit_path)
    if imageio_ffmpeg is not None:
        try:
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            pass
    return shutil.which("ffmpeg")


def resolve_ffprobe_executable() -> str | None:
    candidate = resolve_ffmpeg_executable()
    if candidate is None:
        return shutil.which("ffprobe")

    ffmpeg_path = Path(candidate)
    ffprobe_path = ffmpeg_path.with_name("ffprobe.exe")
    if ffprobe_path.exists():
        return str(ffprobe_path)

    return shutil.which("ffprobe")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_duration_seconds(path: Path) -> float | None:
    ffprobe = resolve_ffprobe_executable()
    ffmpeg = resolve_ffmpeg_executable()
    if ffprobe is not None:
        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "json",
                    str(path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            result = None
        else:
            try:
                payload = json.loads(result.stdout or "{}")
                duration = payload.get("format", {}).get("duration")
                if duration is not None:
                    return float(duration)
            except (ValueError, TypeError, KeyError):
                pass

    if ffmpeg is None:
        return None

    try:
        result = subprocess.run(
            [ffmpeg, "-i", str(path), "-f", "null", "-"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        stderr = getattr(exc, "stderr", "") or ""
        duration_line = next((line for line in stderr.splitlines() if "Duration:" in line), None)
        if duration_line is None:
            return None
        return _parse_duration_line(duration_line)
    else:
        stderr = result.stderr or ""
        duration_line = next((line for line in stderr.splitlines() if "Duration:" in line), None)
        if duration_line is None:
            return None
        return _parse_duration_line(duration_line)


def _parse_duration_line(line: str) -> float | None:
    try:
        duration_text = line.split("Duration:", 1)[1].split(",", 1)[0].strip()
        hours, minutes, seconds = duration_text.split(":")
        return (float(hours) * 3600) + (float(minutes) * 60) + float(seconds)
    except (IndexError, ValueError):
        return None


def build_source_id(path: Path) -> str:
    duration = probe_duration_seconds(path)
    stat = path.stat()
    duration_part = f"{duration:.3f}" if duration is not None else "unknown"
    payload = f"{sha256_file(path)}:{duration_part}:{stat.st_size}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: Any) -> None:
    ensure_directory(path.parent)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def is_binary_available(name: str) -> bool:
    return shutil.which(name) is not None


def run_command(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, cwd=str(cwd) if cwd else None, capture_output=True, text=True, check=True)
    except FileNotFoundError as exc:
        raise MissingDependencyError(f"Command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"Command failed: {' '.join(command)}\nstdout={exc.stdout}\nstderr={exc.stderr}"
        ) from exc


def create_workspace(workspace_root: Path, source_id: str) -> Path:
    workspace = workspace_root / "songs" / source_id
    ensure_directory(workspace)
    for subdir in ("source", "normalized", "separation", "transcript", "metadata", "logs", "waveforms"):
        ensure_directory(workspace / subdir)
    return workspace


def default_manifest(source_id: str, pipeline_version: str, workspace: Path) -> ArtifactManifest:
    return ArtifactManifest(
        source_id=source_id,
        pipeline_version=pipeline_version,
        original_audio=str(workspace / "source" / "original"),
        normalized_audio=str(workspace / "normalized" / "audio.wav"),
        instrumental_audio=str(workspace / "separation" / "instrumental.wav"),
        vocals_audio=str(workspace / "separation" / "vocals.wav"),
        transcript_words=str(workspace / "transcript" / "words.json"),
        transcript_lines=str(workspace / "transcript" / "lines.json"),
        waveform_peaks=str(workspace / "waveforms" / "peaks.json"),
        metadata_path=str(workspace / "metadata" / "manifest.json"),
        logs_path=str(workspace / "logs" / "worker.log"),
    )


def transcript_words_to_lines(words: list[LyricWord], *, max_words_per_line: int = 8, max_gap_seconds: float = 0.85) -> list[LyricLine]:
    if not words:
        return []

    lines: list[LyricLine] = []
    current: list[LyricWord] = []

    def flush() -> None:
        if not current:
            return
        text = " ".join(word.text for word in current).strip()
        lines.append(
            LyricLine(
                text=text,
                start=current[0].start,
                end=current[-1].end,
                words=list(current),
                order=len(lines),
            )
        )
        current.clear()

    for word in words:
        if not current:
            current.append(word)
            continue

        previous = current[-1]
        gap = max(0.0, word.start - previous.end)
        if len(current) >= max_words_per_line or gap > max_gap_seconds:
            flush()
        current.append(word)

    flush()
    return lines


def serialize_manifest(manifest: ArtifactManifest) -> dict[str, Any]:
    return asdict(manifest)


def to_jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return {key: to_jsonable(item) for key, item in asdict(value).items()}
    return value


def ffmpeg_availability_details() -> dict[str, Any]:
    bundled = False
    executable = resolve_ffmpeg_executable()
    if executable is not None and imageio_ffmpeg is not None:
        try:
            bundled = Path(executable).resolve() == Path(imageio_ffmpeg.get_ffmpeg_exe()).resolve()
        except Exception:
            bundled = False

    return {
        "available": executable is not None,
        "source": "imageio-ffmpeg" if bundled else "PATH" if executable is not None else "missing",
        "executable": executable,
    }
