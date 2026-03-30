from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from .models import EventType, JobStatus, RequestType, WorkerEvent
from .pipeline import build_health_details, safe_process
from .protocol import encode_error, encode_health_status, encode_result, parse_request, ProtocolError
from .services import CancellationToken, CancelledError


class WorkerState:
    def __init__(self) -> None:
        self.current_job_id: str | None = None
        self.cancel_tokens: dict[str, CancellationToken] = {}

    def set_running(self, job_id: str, token: CancellationToken) -> None:
        self.current_job_id = job_id
        self.cancel_tokens[job_id] = token

    def clear_running(self, job_id: str) -> None:
        self.cancel_tokens.pop(job_id, None)
        if self.current_job_id == job_id:
            self.current_job_id = None

    def cancel(self, job_id: str) -> bool:
        token = self.cancel_tokens.get(job_id)
        if token is None:
            return False
        token.cancel()
        return True


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_event(event: WorkerEvent) -> None:
    emit(
        {
            "type": event.type.value,
            "request_id": event.request_id,
            "job_id": event.job_id,
            "payload": event.payload,
        }
    )


def handle_request(state: WorkerState, raw: dict[str, Any]) -> None:
    request = parse_request(raw)

    if request.type is RequestType.HEALTH_CHECK:
        emit(encode_health_status(request.request_id, True, build_health_details()))
        return

    if request.type is RequestType.CANCEL_JOB:
        cancelled = state.cancel(request.job_id)
        emit(
            {
                "type": "JOB_PROGRESS",
                "request_id": request.request_id,
                "job_id": request.job_id,
                "payload": {
                    "stage": "cancel",
                    "percent": 100 if cancelled else 0,
                    "message": "Cancellation requested" if cancelled else "No active job found",
                    "details": {"cancelled": cancelled},
                },
            }
        )
        return

    if request.type is RequestType.PROCESS_TRACK:
        token = CancellationToken()
        state.set_running(request.job_id, token)
        emit_event(
            WorkerEvent(
                request_id=request.request_id,
                job_id=request.job_id,
                type=EventType.JOB_STARTED,
                payload={"message": "Job started", "job_status": JobStatus.RUNNING.value},
            )
        )

        def progress(stage: str, percent: int, message: str, details: dict[str, Any]) -> None:
            emit_event(
                WorkerEvent(
                    request_id=request.request_id,
                    job_id=request.job_id,
                    type=EventType.JOB_PROGRESS,
                    payload={"stage": stage, "percent": percent, "message": message, "details": details},
                )
            )

        try:
            result = safe_process(request, token, progress)
            emit(encode_result(result, request.request_id))
        except CancelledError as exc:
            emit(encode_error(request.request_id, request.job_id, str(exc), {"status": JobStatus.CANCELLED.value}))
        except Exception as exc:
            emit(
                encode_error(
                    request.request_id,
                    request.job_id,
                    str(exc),
                    {"traceback": traceback.format_exc(), "status": JobStatus.FAILED.value},
                )
            )
        finally:
            state.clear_running(request.job_id)
        return

    raise ProtocolError(f"Unhandled request type: {request.type.value}")


def main() -> int:
    state = WorkerState()
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            payload = json.loads(stripped)
            if not isinstance(payload, dict):
                raise ProtocolError("Each JSONL message must be an object")
            handle_request(state, payload)
        except ProtocolError as exc:
            emit(
                {
                    "type": "JOB_FAILED",
                    "request_id": None,
                    "job_id": None,
                    "payload": {"message": str(exc), "details": {"error_type": "protocol"}},
                }
            )
        except Exception as exc:
            emit(
                {
                    "type": "JOB_FAILED",
                    "request_id": None,
                    "job_id": None,
                    "payload": {"message": str(exc), "details": {"traceback": traceback.format_exc()}},
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
