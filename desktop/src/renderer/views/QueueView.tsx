import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { formatTimestamp } from "../lib/format";
import type { KaraokeApi, ProcessingJob } from "../types/electron-api";

export interface QueueViewProps {
  api: KaraokeApi;
  jobs: ProcessingJob[];
  onRefresh: () => Promise<void>;
}

function toneForJob(job: ProcessingJob) {
  if (job.status === "completed") return "success";
  if (job.status === "failed") return "danger";
  if (job.status === "running") return "info";
  if (job.status === "cancelled") return "neutral";
  return "warning";
}

export function QueueView({ api, jobs, onRefresh }: QueueViewProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const finishedJobs = jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled");

  const handleRemoveJob = async (job: ProcessingJob) => {
    setBusyKey(job.id);
    setMessage(null);
    try {
      await api.removeJob(job.id);
      setMessage(job.status === "running" ? "Cancellation requested for the running job." : "Job removed from the queue.");
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to remove job.");
    } finally {
      setBusyKey(null);
    }
  };

  const handleClear = async (filter: "active" | "finished") => {
    setBusyKey(`clear-${filter}`);
    setMessage(null);
    try {
      const removedCount = await api.clearJobs(filter);
      setMessage(removedCount > 0 ? `Removed ${removedCount} ${filter} job${removedCount === 1 ? "" : "s"}.` : `No ${filter} jobs to clear.`);
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to clear jobs.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Queue</h2>
          <p>Track each pipeline stage as songs move through normalization, separation, and transcription.</p>
        </div>
        <div className="inline-controls">
          <button type="button" onClick={() => void handleClear("active")} disabled={busyKey !== null}>
            Clear active
          </button>
          <button type="button" onClick={() => void handleClear("finished")} disabled={busyKey !== null}>
            Clear finished
          </button>
        </div>
      </div>

      {message ? <p className="helper-copy">{message}</p> : null}

      {jobs.length === 0 ? (
        <EmptyState title="No active jobs" description="Import and process a track to watch job progress appear here." />
      ) : (
        <div className="stack-list">
          {activeJobs.concat(finishedJobs).map((job) => (
            <article key={job.id} className="list-card queue-card">
              <div className="queue-topline">
                <div>
                  <div className="list-card-title">{job.id}</div>
                  <div className="list-card-meta">Song {job.songId}</div>
                </div>
                <StatusPill tone={toneForJob(job)}>{job.status}</StatusPill>
              </div>
              <div className="progress-shell" aria-hidden="true">
                <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, job.percentComplete))}%` }} />
              </div>
              <div className="queue-grid">
                <div>Stage: {job.stage}</div>
                <div>Progress: {Math.round(job.percentComplete)}%</div>
                <div>Updated: {formatTimestamp(job.updatedAt)}</div>
                <div>{job.errorMessage ?? job.message ?? "Working through the pipeline."}</div>
              </div>
              <div className="inline-controls">
                <button type="button" onClick={() => void handleRemoveJob(job)} disabled={busyKey !== null}>
                  {job.status === "running" ? "Cancel job" : "Remove job"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
