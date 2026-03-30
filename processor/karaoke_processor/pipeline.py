from __future__ import annotations

import importlib.util
import sys
import wave
from pathlib import Path
from typing import Any, Callable

from .models import ArtifactManifest, JobStatus, LyricWord, ProcessResult, ProcessTrackRequest
from .services import (
    CancellationToken,
    CancelledError,
    MissingDependencyError,
    build_source_id,
    create_workspace,
    default_manifest,
    ffmpeg_availability_details,
    ensure_directory,
    is_binary_available,
    probe_duration_seconds,
    resolve_ffmpeg_executable,
    read_json,
    run_command,
    sha256_file,
    transcript_words_to_lines,
    to_jsonable,
    write_json,
)


ProgressCallback = Callable[[str, int, str, dict[str, Any]], None]


class AudioPipeline:
    def __init__(self) -> None:
        self.ffmpeg_executable = resolve_ffmpeg_executable()

    def normalize(self, source_path: Path, output_path: Path, cancel: CancellationToken) -> Path:
        cancel.raise_if_cancelled()
        if not self.ffmpeg_executable:
            raise MissingDependencyError(
                "FFmpeg is not available. Install imageio-ffmpeg or place ffmpeg on PATH before processing tracks."
            )

        ensure_directory(output_path.parent)
        command = [
            self.ffmpeg_executable,
            "-y",
            "-i",
            str(source_path),
            "-ac",
            "2",
            "-ar",
            "48000",
            "-vn",
            str(output_path),
        ]
        run_command(command)
        return output_path


class SeparationService:
    def __init__(self) -> None:
        self.demucs_available = importlib.util.find_spec("demucs") is not None
        self.diffq_available = importlib.util.find_spec("diffq") is not None
        self.model_candidates = self._build_model_candidates()

    def _build_model_candidates(self) -> list[str]:
        candidates = ["htdemucs"]
        if self.diffq_available:
            candidates.append("mdx_extra_q")
        return candidates

    def _load_normalized_audio(self, normalized_audio: Path) -> tuple[Any, int]:
        import numpy as np
        import torch

        with wave.open(str(normalized_audio), "rb") as handle:
            channels = handle.getnchannels()
            sample_rate = handle.getframerate()
            sample_width = handle.getsampwidth()
            frame_count = handle.getnframes()
            raw_frames = handle.readframes(frame_count)

        if sample_width == 2:
            pcm = np.frombuffer(raw_frames, dtype="<i2").astype(np.float32) / 32768.0
        elif sample_width == 4:
            pcm = np.frombuffer(raw_frames, dtype="<i4").astype(np.float32) / 2147483648.0
        else:
            raise RuntimeError(f"Unsupported normalized WAV sample width: {sample_width}")

        if pcm.size == 0:
            raise RuntimeError("Normalized audio file was empty.")

        samples = pcm.reshape(-1, channels).T.copy()
        return torch.from_numpy(samples), sample_rate

    def _save_wave_output(self, output_path: Path, audio_tensor: Any, sample_rate: int) -> None:
        import numpy as np

        ensure_directory(output_path.parent)
        samples = audio_tensor.detach().cpu().clamp(-1, 1).numpy()
        interleaved = (samples.T * 32767.0).round().astype(np.int16)
        channel_count = interleaved.shape[1] if interleaved.ndim == 2 else 1

        with wave.open(str(output_path), "wb") as handle:
            handle.setnchannels(channel_count)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(interleaved.tobytes())

    def _separate_with_model(self, normalized_audio: Path, workspace: Path, model_name: str) -> tuple[Path, Path | None]:
        import torch
        from demucs.apply import apply_model
        from demucs.audio import convert_audio
        from demucs.pretrained import get_model

        model = get_model(model_name)
        model.cpu()
        model.eval()

        wav, sample_rate = self._load_normalized_audio(normalized_audio)
        wav = convert_audio(wav, sample_rate, model.samplerate, model.audio_channels)

        ref = wav.mean(0)
        mean = ref.mean()
        std = ref.std()
        if float(std) < 1e-8:
            std = torch.tensor(1.0, dtype=wav.dtype)

        wav = wav - mean
        wav = wav / std

        sources = apply_model(
            model,
            wav[None],
            device="cpu",
            shifts=1,
            split=True,
            overlap=0.25,
            progress=False,
            num_workers=0,
        )[0]
        sources = (sources * std) + mean

        source_names = list(model.sources)
        vocals_index = source_names.index("vocals")
        vocals = sources[vocals_index]
        instrumental = torch.zeros_like(vocals)
        for index, source in enumerate(sources):
            if index != vocals_index:
                instrumental += source

        instrumental_output = workspace / "separation" / "instrumental.wav"
        vocals_output = workspace / "separation" / "vocals.wav"
        self._save_wave_output(instrumental_output, instrumental, model.samplerate)
        self._save_wave_output(vocals_output, vocals, model.samplerate)
        return instrumental_output, vocals_output

    def _write_fallback(self, normalized_audio: Path, workspace: Path, reason: str) -> tuple[Path, Path | None]:
        instrumental = workspace / "separation" / "instrumental.wav"
        ensure_directory(instrumental.parent)
        write_json(
            workspace / "logs" / "separation_fallback.json",
            {
                "message": reason,
                "normalized_audio": str(normalized_audio),
            },
        )
        instrumental.write_bytes(normalized_audio.read_bytes())
        return instrumental, None

    def _resolve_outputs(self, workspace: Path, normalized_audio: Path, model_name: str) -> tuple[Path | None, Path | None]:
        track_name = normalized_audio.stem
        base_dir = workspace / "separation" / model_name / track_name
        candidate_instrumentals = [
            base_dir / "no_vocals.wav",
            base_dir / "other.wav",
        ]
        candidate_vocals = [
            base_dir / "vocals.wav",
        ]

        instrumental_source = next((candidate for candidate in candidate_instrumentals if candidate.exists()), None)
        vocals_source = next((candidate for candidate in candidate_vocals if candidate.exists()), None)

        instrumental_output = workspace / "separation" / "instrumental.wav"
        vocals_output = workspace / "separation" / "vocals.wav"

        if instrumental_source is not None:
            instrumental_output.write_bytes(instrumental_source.read_bytes())
        if vocals_source is not None:
            vocals_output.write_bytes(vocals_source.read_bytes())

        return (
            instrumental_output if instrumental_output.exists() else None,
            vocals_output if vocals_output.exists() else None,
        )

    def separate(self, normalized_audio: Path, workspace: Path, cancel: CancellationToken) -> tuple[Path, Path | None]:
        cancel.raise_if_cancelled()
        if not self.demucs_available:
            return self._write_fallback(
                normalized_audio,
                workspace,
                "Demucs not available; copying normalized track as instrumental placeholder.",
            )

        failures: list[dict[str, Any]] = []

        for model_name in self.model_candidates:
            try:
                instrumental, vocals = self._separate_with_model(normalized_audio, workspace, model_name)
            except Exception as exc:
                failures.append({"model": model_name, "error": str(exc)})
                continue

            write_json(
                workspace / "logs" / "separation_result.json",
                {
                    "model": model_name,
                    "guide_vocals_available": vocals is not None,
                    "backend": "python_api_pcm_writer",
                },
            )
            if vocals is not None:
                return instrumental, vocals

        return self._write_fallback(
            normalized_audio,
            workspace,
            f"Demucs separation failed; using normalized track as fallback. attempts={failures}",
        )


class TranscriptionService:
    def __init__(self) -> None:
        self.faster_whisper_available = False
        try:
            from faster_whisper import WhisperModel  # type: ignore

            self._whisper_model = WhisperModel
            self.faster_whisper_available = True
        except Exception:
            self._whisper_model = None

    def transcribe(
        self,
        source_audio: Path,
        workspace: Path,
        cancel: CancellationToken,
        *,
        preferred_model: str = "base",
        language: str | None = None,
    ) -> list[LyricWord]:
        cancel.raise_if_cancelled()
        transcript_dir = workspace / "transcript"
        ensure_directory(transcript_dir)

        if not self.faster_whisper_available:
            placeholder_words = [
                LyricWord(text="Instrumental", start=0.0, end=1.0, confidence=None),
                LyricWord(text="mode", start=1.0, end=2.0, confidence=None),
                LyricWord(text="pending", start=2.0, end=3.0, confidence=None),
            ]
            write_json(transcript_dir / "words.json", to_jsonable(placeholder_words))
            return placeholder_words

        model_name = preferred_model or "base"
        model = self._whisper_model(model_name, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(str(source_audio), language=language, word_timestamps=True)

        words: list[LyricWord] = []
        for segment in segments:
            cancel.raise_if_cancelled()
            for word in getattr(segment, "words", []) or []:
                if not getattr(word, "word", "").strip():
                    continue
                words.append(
                    LyricWord(
                        text=word.word.strip(),
                        start=float(word.start),
                        end=float(word.end),
                        confidence=float(word.probability) if getattr(word, "probability", None) is not None else None,
                    )
                )
        if not words:
            words = [LyricWord(text="(no lyrics detected)", start=0.0, end=2.0, confidence=None)]
        write_json(transcript_dir / "words.json", to_jsonable(words))
        return words


class ProcessingPipeline:
    def __init__(self) -> None:
        self.audio = AudioPipeline()
        self.separation = SeparationService()
        self.transcription = TranscriptionService()

    def process(self, request: ProcessTrackRequest, cancel: CancellationToken, progress: ProgressCallback) -> ProcessResult:
        source_path = Path(request.source_path)
        workspace_root = Path(request.workspace_root)
        if not source_path.exists():
            raise FileNotFoundError(f"Source file does not exist: {source_path}")

        cancel.raise_if_cancelled()
        progress("hashing", 5, "Hashing source file", {"source_path": str(source_path)})
        source_id = request.source_id or build_source_id(source_path)
        workspace = create_workspace(workspace_root, source_id)
        manifest = default_manifest(source_id, request.pipeline_version, workspace)

        if self._is_cached_result_valid(manifest, request.pipeline_version):
            progress("cache", 100, "Reusing cached artifacts", {"source_id": source_id})
            cached = self._load_cached_result(request, source_id, workspace, manifest)
            if cached is not None:
                return cached

        write_json(workspace / "metadata" / "request.json", {"request": to_jsonable(request)})
        write_json(workspace / "metadata" / "manifest.json", {"manifest": to_jsonable(manifest)})

        progress("normalize", 20, "Preparing normalized audio", {"source_id": source_id})
        normalized_audio = self.audio.normalize(source_path, Path(manifest.normalized_audio), cancel)

        progress("separate", 55, "Separating vocals and instrumental", {"source_id": source_id})
        instrumental, vocals = self.separation.separate(normalized_audio, workspace, cancel)

        progress("transcribe", 80, "Transcribing source lyrics", {"source_id": source_id})
        preferred_model = request.preferred_models.get("transcription", "base")
        words = self.transcription.transcribe(
            source_path,
            workspace,
            cancel,
            preferred_model=preferred_model,
            language=request.language,
        )
        lines = transcript_words_to_lines(words)

        write_json(Path(manifest.transcript_words), to_jsonable(words))
        write_json(Path(manifest.transcript_lines), to_jsonable(lines))
        write_json(
            Path(manifest.metadata_path),
            {
                "source_id": source_id,
                "pipeline_version": request.pipeline_version,
                "source_path": str(source_path),
                "source_hash": sha256_file(source_path),
                "source_duration_seconds": probe_duration_seconds(source_path),
                "normalized_audio": str(normalized_audio),
                "instrumental_audio": str(instrumental),
                "vocals_audio": str(vocals) if vocals else None,
                "lyric_line_count": len(lines),
                "lyric_word_count": len(words),
            },
        )

        progress("finalize", 95, "Finalizing artifact manifest", {"source_id": source_id})
        return ProcessResult(
            job_id=request.job_id,
            source_id=source_id,
            status=JobStatus.COMPLETED,
            manifest=ArtifactManifest(
                source_id=manifest.source_id,
                pipeline_version=manifest.pipeline_version,
                original_audio=str(source_path),
                normalized_audio=str(normalized_audio),
                instrumental_audio=str(instrumental),
                vocals_audio=str(vocals) if vocals else None,
                transcript_words=str(manifest.transcript_words),
                transcript_lines=str(manifest.transcript_lines),
                waveform_peaks=manifest.waveform_peaks,
                metadata_path=str(manifest.metadata_path),
                logs_path=str(manifest.logs_path),
            ),
            summary="Track processed successfully",
            details={
                "lyric_line_count": len(lines),
                "lyric_word_count": len(words),
                "request_id": request.request_id,
            },
        )

    def _is_cached_result_valid(self, manifest: ArtifactManifest, pipeline_version: str) -> bool:
        metadata_path = Path(manifest.metadata_path) if manifest.metadata_path else None
        transcript_words = Path(manifest.transcript_words) if manifest.transcript_words else None
        transcript_lines = Path(manifest.transcript_lines) if manifest.transcript_lines else None
        instrumental = Path(manifest.instrumental_audio) if manifest.instrumental_audio else None
        normalized = Path(manifest.normalized_audio) if manifest.normalized_audio else None

        required_paths = [metadata_path, transcript_words, transcript_lines, instrumental, normalized]
        if any(path is None or not path.exists() for path in required_paths):
            return False

        try:
            metadata = read_json(metadata_path)
        except Exception:
            return False

        return metadata.get("pipeline_version") == pipeline_version and metadata.get("source_id") == manifest.source_id

    def _load_cached_result(
        self,
        request: ProcessTrackRequest,
        source_id: str,
        workspace: Path,
        manifest: ArtifactManifest,
    ) -> ProcessResult | None:
        try:
            words_payload = read_json(Path(manifest.transcript_words))
            lines_payload = read_json(Path(manifest.transcript_lines))
        except Exception:
            return None

        details = {
            "lyric_line_count": len(lines_payload) if isinstance(lines_payload, list) else 0,
            "lyric_word_count": len(words_payload) if isinstance(words_payload, list) else 0,
            "request_id": request.request_id,
            "cached": True,
        }
        return ProcessResult(
            job_id=request.job_id,
            source_id=source_id,
            status=JobStatus.COMPLETED,
            manifest=manifest,
            summary="Reused cached artifacts",
            details=details,
        )


def build_health_details() -> dict[str, Any]:
    faster_whisper_available = False
    try:
        import faster_whisper  # type: ignore  # noqa: F401

        faster_whisper_available = True
    except Exception:
        faster_whisper_available = False

    demucs_available = importlib.util.find_spec("demucs") is not None
    diffq_available = importlib.util.find_spec("diffq") is not None
    model_candidates = ["htdemucs"]
    if diffq_available:
        model_candidates.append("mdx_extra_q")

    return {
        "ffmpeg": ffmpeg_availability_details(),
        "demucs": demucs_available,
        "faster_whisper": faster_whisper_available,
        "diffq": diffq_available,
        "separation_ready": demucs_available,
        "separation_backend": "python_api_pcm_writer",
        "model_candidates": model_candidates,
        "python": sys.version.split()[0],
    }


def safe_process(
    request: ProcessTrackRequest,
    cancel: CancellationToken,
    progress: ProgressCallback,
) -> ProcessResult:
    pipeline = ProcessingPipeline()
    return pipeline.process(request, cancel, progress)
