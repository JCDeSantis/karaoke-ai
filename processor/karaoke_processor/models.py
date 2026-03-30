from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventType(str, Enum):
    JOB_STARTED = "JOB_STARTED"
    JOB_PROGRESS = "JOB_PROGRESS"
    JOB_COMPLETED = "JOB_COMPLETED"
    JOB_FAILED = "JOB_FAILED"
    HEALTH_STATUS = "HEALTH_STATUS"


class RequestType(str, Enum):
    HEALTH_CHECK = "HEALTH_CHECK"
    PROCESS_TRACK = "PROCESS_TRACK"
    CANCEL_JOB = "CANCEL_JOB"


@dataclass(slots=True)
class HealthCheckRequest:
    request_id: str
    type: RequestType = RequestType.HEALTH_CHECK


@dataclass(slots=True)
class ProcessTrackRequest:
    request_id: str
    job_id: str
    source_path: str
    workspace_root: str
    source_id: str | None = None
    pipeline_version: str = "v1"
    language: str | None = None
    preferred_models: dict[str, str] = field(default_factory=dict)
    type: RequestType = RequestType.PROCESS_TRACK


@dataclass(slots=True)
class CancelJobRequest:
    request_id: str
    job_id: str
    type: RequestType = RequestType.CANCEL_JOB


WorkerRequest = HealthCheckRequest | ProcessTrackRequest | CancelJobRequest


@dataclass(slots=True)
class WorkerEvent:
    request_id: str
    job_id: str | None
    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LyricWord:
    text: str
    start: float
    end: float
    confidence: float | None = None


@dataclass(slots=True)
class LyricLine:
    text: str
    start: float
    end: float
    words: list[LyricWord] = field(default_factory=list)
    order: int = 0


@dataclass(slots=True)
class ArtifactManifest:
    source_id: str
    pipeline_version: str
    original_audio: str | None = None
    normalized_audio: str | None = None
    instrumental_audio: str | None = None
    vocals_audio: str | None = None
    transcript_words: str | None = None
    transcript_lines: str | None = None
    waveform_peaks: str | None = None
    metadata_path: str | None = None
    logs_path: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ProcessResult:
    job_id: str
    source_id: str
    status: JobStatus
    manifest: ArtifactManifest
    summary: str
    details: dict[str, Any] = field(default_factory=dict)
