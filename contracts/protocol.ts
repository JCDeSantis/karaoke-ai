import type { ArtifactManifest, LyricLine, LyricWord, ProcessingJob, SongRecord } from "./types";

export type WorkerRequestType = "PROCESS_TRACK" | "CANCEL_JOB" | "HEALTH_CHECK";
export type WorkerEventType = "JOB_STARTED" | "JOB_PROGRESS" | "JOB_COMPLETED" | "JOB_FAILED";
export type WorkerResponseType = "HEALTH_OK" | "ACK" | "ERROR";

export interface WorkerRequestEnvelope<TPayload = unknown> {
  type: WorkerRequestType;
  requestId: string;
  payload: TPayload;
}

export interface WorkerResponseEnvelope<TPayload = unknown> {
  type: WorkerResponseType;
  requestId: string;
  payload: TPayload;
}

export interface WorkerEventEnvelope<TPayload = unknown> {
  type: WorkerEventType;
  requestId: string | null;
  payload: TPayload;
}

export interface ProcessTrackRequest {
  job: ProcessingJob;
  song: SongRecord;
  workspaceDir: string;
  sourceFilePath: string;
  sourceCopyPath: string;
  pipelineVersion: string;
  cacheSchemaVersion: number;
}

export interface CancelJobRequest {
  jobId: string;
}

export interface HealthCheckResponse {
  ok: boolean;
  version: string | null;
  message?: string | null;
}

export interface JobStartedPayload {
  jobId: string;
  songId: string;
  stage: string;
}

export interface JobProgressPayload {
  jobId: string;
  songId: string;
  stage: string;
  percentComplete: number;
  message: string | null;
}

export interface JobCompletedPayload {
  jobId: string;
  songId: string;
  manifest: ArtifactManifest;
  words: LyricWord[];
  lines: LyricLine[];
}

export interface JobFailedPayload {
  jobId: string;
  songId: string;
  stage: string;
  message: string;
}

