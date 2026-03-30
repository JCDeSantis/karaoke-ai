import type {
  CancelJobRequest,
  HealthCheckResponse,
  ProcessTrackRequest,
  WorkerEventEnvelope,
  WorkerEventType,
  WorkerRequestEnvelope,
  WorkerRequestType,
  WorkerResponseEnvelope,
  WorkerResponseType,
} from "../../../contracts";

export type { CancelJobRequest, HealthCheckResponse, ProcessTrackRequest };
export type { WorkerEventEnvelope, WorkerEventType, WorkerRequestEnvelope, WorkerRequestType, WorkerResponseEnvelope, WorkerResponseType };

export function encodeMessage(message: WorkerRequestEnvelope | WorkerResponseEnvelope | WorkerEventEnvelope): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): unknown {
  return JSON.parse(line);
}

