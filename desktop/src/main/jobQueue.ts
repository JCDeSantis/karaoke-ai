import { EventEmitter } from "node:events";
import path from "node:path";
import { CACHE_SCHEMA_VERSION, PIPELINE_VERSION } from "./constants";
import { nowIso, safeErrorMessage } from "./json";
import type { AppDirectories } from "./appPaths";
import type { ArtifactManifest, ProcessingJob, SongRecord } from "../../../contracts";
import type { SongRepository } from "./songRepository";
import type { NormalizedWorkerEvent, RawProcessorManifest, WorkerProcessManager } from "./workerProcess";

export class JobQueue extends EventEmitter {
  private runningJobId: string | null = null;
  private queuedJobIds: string[] = [];
  private cancellingJobIds = new Set<string>();

  constructor(
    private readonly directories: AppDirectories,
    private readonly repository: SongRepository,
    private readonly worker: WorkerProcessManager,
  ) {
    super();
    this.worker.on("event", (event: NormalizedWorkerEvent) => {
      void this.handleWorkerEvent(event);
    });
  }

  recoverInterruptedJobs(): ProcessingJob[] {
    return this.repository.markInterruptedJobsFailed();
  }

  enqueue(songId: string): ProcessingJob {
    const song = this.repository.getSongById(songId);
    if (!song) {
      throw new Error("Song not found");
    }

    if (song.hasCachedArtifacts && song.artifactManifestPath) {
      const cachedJob = this.repository.createJob(songId);
      const manifest = this.repository.getManifestForSong(songId);
      const cacheIsCurrent =
        manifest?.pipelineVersion === PIPELINE_VERSION && manifest?.cacheSchemaVersion === CACHE_SCHEMA_VERSION;
      if (!manifest) {
        this.failJob(cachedJob.id, songId, "waiting", "Cached manifest is missing");
        return this.repository.getJob(cachedJob.id) as ProcessingJob;
      }
      if (!cacheIsCurrent) {
        this.repository.removeJob(cachedJob.id);
      } else {
        this.repository.updateJob(cachedJob.id, {
          status: "completed",
          stage: "finalizing",
          percentComplete: 100,
          message: "Cached artifacts reused",
          finishedAt: nowIso(),
        });
        this.repository.setSongStatus(songId, "ready");
        const completed = this.repository.getJob(cachedJob.id);
        if (completed) {
          this.emit("job-event", completed);
        }
        return this.repository.getJob(cachedJob.id) as ProcessingJob;
      }
    }

    const job = this.repository.createJob(songId);
    this.repository.setSongStatus(songId, "queued");
    this.queuedJobIds.push(job.id);
    void this.processNext();
    return job;
  }

  listJobs(): ProcessingJob[] {
    return this.repository.listJobs();
  }

  async removeJob(jobId: string): Promise<boolean> {
    const job = this.repository.getJob(jobId);
    if (!job) {
      return false;
    }

    if (this.runningJobId === jobId) {
      this.cancellingJobIds.add(jobId);
      const updated = this.repository.updateJob(jobId, {
        status: "cancelled",
        message: "Cancelling job...",
        errorMessage: null,
        finishedAt: nowIso(),
      });
      if (updated) {
        this.emit("job-event", updated);
      }
      await this.worker.cancelJob(jobId);
      return true;
    }

    this.queuedJobIds = this.queuedJobIds.filter((queuedId) => queuedId !== jobId);
    const removed = this.repository.removeJob(jobId);
    if (removed) {
      void this.processNext();
      return true;
    }
    return false;
  }

  async clearJobs(filter: "all" | "active" | "finished" = "active"): Promise<number> {
    const jobs = this.repository.listJobs();
    const matchingJobs = jobs.filter((job) => {
      if (filter === "all") {
        return true;
      }
      if (filter === "active") {
        return job.status === "queued" || job.status === "running";
      }
      return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    });

    if (matchingJobs.length === 0) {
      return 0;
    }

    const runningJobs = matchingJobs.filter((job) => job.id === this.runningJobId);
    const queuedJobIds = matchingJobs.filter((job) => job.id !== this.runningJobId).map((job) => job.id);

    this.queuedJobIds = this.queuedJobIds.filter((jobId) => !queuedJobIds.includes(jobId));
    const removedCount = this.repository.removeJobs(queuedJobIds);

    for (const runningJob of runningJobs) {
      await this.removeJob(runningJob.id);
    }

    return removedCount + runningJobs.length;
  }

  async deleteSong(songId: string): Promise<boolean> {
    const jobs = this.repository.listJobs().filter((job) => job.songId === songId);
    for (const job of jobs.filter((job) => job.id === this.runningJobId)) {
      await this.removeJob(job.id);
    }

    const remainingJobIds = jobs
      .filter((job) => job.id !== this.runningJobId)
      .map((job) => job.id);
    this.queuedJobIds = this.queuedJobIds.filter((jobId) => !remainingJobIds.includes(jobId));
    this.repository.removeJobs(remainingJobIds);

    return await this.repository.deleteSong(songId);
  }

  private mapStage(stage: string | null | undefined): ProcessingJob["stage"] {
    switch (stage) {
      case "normalize":
        return "normalizing";
      case "separate":
        return "separating";
      case "transcribe":
        return "transcribing";
      case "finalize":
      case "cache":
        return "finalizing";
      default:
        return "waiting";
    }
  }

  private buildArtifactManifest(song: SongRecord, raw: RawProcessorManifest): ArtifactManifest {
    return {
      songId: song.id,
      sourceId: song.sourceId,
      pipelineVersion: raw.pipeline_version ?? PIPELINE_VERSION,
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      sourceCopyPath: song.sourcePath,
      normalizedAudioPath: raw.normalized_audio ?? path.join(this.directories.songsDir, song.sourceId, "normalized", "audio.wav"),
      instrumentalPath: raw.instrumental_audio ?? song.sourcePath,
      vocalsPath: raw.vocals_audio ?? null,
      transcriptWordsPath: raw.transcript_words ?? path.join(this.directories.songsDir, song.sourceId, "transcript", "words.json"),
      transcriptLinesPath: raw.transcript_lines ?? path.join(this.directories.songsDir, song.sourceId, "transcript", "lines.json"),
      waveformPath: raw.waveform_peaks ?? null,
      artworkPath: null,
      createdAt: nowIso(),
    };
  }

  private async processNext(): Promise<void> {
    if (this.runningJobId) {
      return;
    }

    const nextJobId = this.queuedJobIds.shift();
    if (!nextJobId) {
      return;
    }

    const job = this.repository.getJob(nextJobId);
    if (!job) {
      void this.processNext();
      return;
    }

    const song = this.repository.getSongById(job.songId);
    if (!song) {
      this.repository.updateJob(job.id, {
        status: "failed",
        stage: "waiting",
        errorMessage: "Song disappeared before processing",
        finishedAt: nowIso(),
      });
      void this.processNext();
      return;
    }

    this.runningJobId = job.id;
    this.repository.setSongStatus(song.id, "processing");
    this.repository.updateJob(job.id, {
      status: "running",
      stage: "normalizing",
      percentComplete: 5,
      message: "Worker started",
      startedAt: nowIso(),
    });
    const started = this.repository.getJob(job.id);
    if (started) {
      this.emit("job-event", started);
    }

    try {
      await this.worker.processTrack(job, song, {
        workspaceDir: path.join(this.directories.songsDir, song.sourceId),
        pipelineVersion: PIPELINE_VERSION,
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      });
    } catch (error) {
      this.failJob(job.id, song.id, "waiting", safeErrorMessage(error));
      this.runningJobId = null;
      void this.processNext();
    }
  }

  private async handleWorkerEvent(event: NormalizedWorkerEvent): Promise<void> {
    if (!event.jobId) {
      return;
    }

    if (this.cancellingJobIds.has(event.jobId) && (event.type === "JOB_FAILED" || event.type === "JOB_COMPLETED")) {
      const removed = this.repository.removeJob(event.jobId);
      this.cancellingJobIds.delete(event.jobId);
      if (this.runningJobId === event.jobId) {
        this.runningJobId = null;
      }
      void this.processNext();
      return;
    }

    const job = this.repository.getJob(event.jobId);
    if (!job) {
      return;
    }

    const song = this.repository.getSongById(job.songId);
    if (!song) {
      return;
    }

    if (event.type === "JOB_STARTED" || event.type === "JOB_PROGRESS") {
      const updated = this.repository.updateJob(job.id, {
        status: "running",
        stage: this.mapStage(event.stage),
        percentComplete: Math.max(job.percentComplete, event.percentComplete),
        message: event.message,
      });
      if (updated) {
        this.emit("job-event", updated);
      }
      return;
    }

    if (event.type === "JOB_FAILED") {
      this.failJob(job.id, song.id, this.mapStage(event.stage), event.message ?? "Processing failed");
      this.runningJobId = null;
      void this.processNext();
      return;
    }

    await this.completeJob(job.id, song.id, this.buildArtifactManifest(song, event.manifest));
    this.runningJobId = null;
    void this.processNext();
  }

  private async completeJob(jobId: string, songId: string, manifest: ArtifactManifest): Promise<void> {
    const workspaceDir = path.join(this.directories.songsDir, manifest.sourceId);
    await this.repository.persistManifest(songId, manifest, workspaceDir);
    const updated = this.repository.updateJob(jobId, {
      status: "completed",
      stage: "finalizing",
      percentComplete: 100,
      message: "Processing completed",
      finishedAt: nowIso(),
    });
    this.repository.setSongStatus(songId, "ready");
    if (updated) {
      this.emit("job-event", updated);
    }
  }

  private failJob(jobId: string, songId: string, stage: ProcessingJob["stage"], message: string): void {
    const updated = this.repository.updateJob(jobId, {
      status: "failed",
      stage,
      percentComplete: 0,
      errorMessage: message,
      message,
      finishedAt: nowIso(),
    });
    this.repository.setSongStatus(songId, "failed", message);
    if (updated) {
      this.emit("job-event", updated);
    }
  }
}
