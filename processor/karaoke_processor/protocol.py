from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from .models import (
    ArtifactManifest,
    CancelJobRequest,
    EventType,
    HealthCheckRequest,
    JobStatus,
    LyricLine,
    LyricWord,
    ProcessTrackRequest,
    ProcessResult,
    RequestType,
    WorkerEvent,
    WorkerRequest,
)
from enum import Enum


class ProtocolError(ValueError):
    pass


def _coerce_request_type(value: str) -> RequestType:
    try:
        return RequestType(value)
    except ValueError as exc:
        raise ProtocolError(f"Unsupported request type: {value!r}") from exc


def parse_request(payload: dict[str, Any]) -> WorkerRequest:
    if not isinstance(payload, dict):
        raise ProtocolError("Request payload must be an object")

    raw_type = payload.get("type")
    if not isinstance(raw_type, str):
        raise ProtocolError("Request payload missing string 'type'")

    request_type = _coerce_request_type(raw_type)
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("Request payload missing 'request_id'")

    if request_type is RequestType.HEALTH_CHECK:
        return HealthCheckRequest(request_id=request_id)

    if request_type is RequestType.PROCESS_TRACK:
        source_path = payload.get("source_path")
        workspace_root = payload.get("workspace_root")
        job_id = payload.get("job_id")
        if not isinstance(source_path, str) or not source_path:
            raise ProtocolError("PROCESS_TRACK requires 'source_path'")
        if not isinstance(workspace_root, str) or not workspace_root:
            raise ProtocolError("PROCESS_TRACK requires 'workspace_root'")
        if not isinstance(job_id, str) or not job_id:
            raise ProtocolError("PROCESS_TRACK requires 'job_id'")
        preferred_models = payload.get("preferred_models") or {}
        if not isinstance(preferred_models, dict):
            raise ProtocolError("'preferred_models' must be an object when provided")
        return ProcessTrackRequest(
            request_id=request_id,
            job_id=job_id,
            source_path=source_path,
            workspace_root=workspace_root,
            source_id=payload.get("source_id") if isinstance(payload.get("source_id"), str) else None,
            pipeline_version=payload.get("pipeline_version") if isinstance(payload.get("pipeline_version"), str) else "v1",
            language=payload.get("language") if isinstance(payload.get("language"), str) else None,
            preferred_models=preferred_models,
        )

    if request_type is RequestType.CANCEL_JOB:
        job_id = payload.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            raise ProtocolError("CANCEL_JOB requires 'job_id'")
        return CancelJobRequest(request_id=request_id, job_id=job_id)

    raise ProtocolError(f"Unsupported request type: {request_type.value}")


def _serialize(value: Any) -> Any:
    if is_dataclass(value):
        return {key: _serialize(item) for key, item in asdict(value).items()}
    if isinstance(value, list):
        return [_serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: _serialize(item) for key, item in value.items()}
    if isinstance(value, Enum):
        return value.value
    return value


def event_payload(event: WorkerEvent) -> dict[str, Any]:
    return _serialize(event)


def encode_event(event: WorkerEvent) -> dict[str, Any]:
    return {
        "type": event.type.value,
        "request_id": event.request_id,
        "job_id": event.job_id,
        "payload": _serialize(event.payload),
    }


def encode_health_status(request_id: str, healthy: bool, details: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": EventType.HEALTH_STATUS.value,
        "request_id": request_id,
        "job_id": None,
        "payload": {"healthy": healthy, "details": details},
    }


def encode_result(result: ProcessResult, request_id: str) -> dict[str, Any]:
    return {
        "type": EventType.JOB_COMPLETED.value,
        "request_id": request_id,
        "job_id": result.job_id,
        "payload": {
            "status": result.status.value,
            "summary": result.summary,
            "details": _serialize(result.details),
            "manifest": _serialize(result.manifest),
        },
    }


def encode_error(request_id: str, job_id: str | None, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": EventType.JOB_FAILED.value,
        "request_id": request_id,
        "job_id": job_id,
        "payload": {"message": message, "details": details or {}},
    }


def lyric_lines_to_payload(lines: list[LyricLine]) -> list[dict[str, Any]]:
    return [_serialize(line) for line in lines]


def lyric_words_to_payload(words: list[LyricWord]) -> list[dict[str, Any]]:
    return [_serialize(word) for word in words]
