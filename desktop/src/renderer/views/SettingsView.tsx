import { useState } from "react";
import { StatusPill } from "../components/StatusPill";
import type { AppStatus, ProcessorHealth } from "../types/electron-api";

export interface SettingsViewProps {
  appDataPath: string | null;
  appStatus?: AppStatus | null;
  health: ProcessorHealth | null;
  onRefresh: () => Promise<void>;
  onPrepareRuntime?: (options?: { force?: boolean; preloadTranscriptionModel?: boolean }) => Promise<void>;
}

function statusTone(
  status:
    | ProcessorHealth["status"]
    | ProcessorHealth["bootstrapStatus"]
    | "ready"
    | "warning"
    | "missing",
) {
  switch (status) {
    case "ok":
    case "ready":
      return "success";
    case "bootstrapping":
    case "warning":
      return "warning";
    case "error":
    case "missing":
      return "danger";
    default:
      return "neutral";
  }
}

export function SettingsView({
  appDataPath,
  appStatus,
  health,
  onRefresh,
  onPrepareRuntime,
}: SettingsViewProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<"prepare" | "repair" | "preload" | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const checks =
    health?.checks ??
    [
      {
        key: "ffmpeg",
        label: "FFmpeg",
        status: health?.ffmpeg ? "ready" : "missing",
        detail: health?.ffmpeg ? "Available" : "Missing",
      },
      {
        key: "demucs",
        label: "Demucs",
        status: health?.demucs ? "ready" : "missing",
        detail: health?.demucs ? "Available" : "Missing",
      },
      {
        key: "whisper",
        label: "Faster-Whisper",
        status: health?.whisper ? "ready" : "missing",
        detail: health?.whisper ? "Available" : "Missing",
      },
    ];

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handlePrepare = async (
    action: "prepare" | "repair" | "preload",
    options?: { force?: boolean; preloadTranscriptionModel?: boolean },
  ) => {
    if (!onPrepareRuntime) {
      return;
    }

    setBusyAction(action);
    setActionMessage(null);
    try {
      await onPrepareRuntime(options);
      setActionMessage(
        action === "repair"
          ? "Runtime repair finished."
          : action === "preload"
            ? "Transcription model cache prepared."
            : "Runtime preparation finished.",
      );
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Runtime setup failed.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <div>
          <h2>System Check</h2>
          <p>Runtime readiness, model cache visibility, and repair tools for local processing.</p>
        </div>
        <div className="inline-controls settings-actions">
          <button type="button" onClick={() => void handleRefresh()} disabled={isRefreshing || busyAction !== null}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handlePrepare("prepare")}
            disabled={isRefreshing || busyAction !== null || !onPrepareRuntime}
          >
            {busyAction === "prepare" ? "Preparing..." : "Prepare runtime"}
          </button>
          <button
            type="button"
            onClick={() => void handlePrepare("repair", { force: true })}
            disabled={isRefreshing || busyAction !== null || !onPrepareRuntime}
          >
            {busyAction === "repair" ? "Repairing..." : "Repair install"}
          </button>
          <button
            type="button"
            onClick={() => void handlePrepare("preload", { preloadTranscriptionModel: true })}
            disabled={isRefreshing || busyAction !== null || !onPrepareRuntime}
          >
            {busyAction === "preload" ? "Preloading..." : "Preload model"}
          </button>
        </div>
      </div>

      <div className="settings-grid">
        <article className="list-card">
          <div className="list-card-title">Processor runtime</div>
          <div className="list-card-meta">{health?.summary ?? "Health summary will appear here."}</div>
          <div className="settings-card-footer">
            <StatusPill tone={statusTone(health?.status ?? "unknown")}>{health?.status ?? "unknown"}</StatusPill>
            <StatusPill tone={statusTone(health?.bootstrapStatus ?? "unknown")}>
              {health?.bootstrapStatus ?? "idle"}
            </StatusPill>
          </div>
        </article>

        <article className="list-card">
          <div className="list-card-title">App version</div>
          <div className="list-card-meta">
            {appStatus ? `KaraokeAI v${appStatus.appVersion}` : "Version unavailable"}
          </div>
          <div className="list-card-meta">
            {appStatus ? `Pipeline ${appStatus.pipelineVersion} · Cache schema ${appStatus.cacheSchemaVersion}` : "Build metadata pending"}
          </div>
        </article>

        <article className="list-card">
          <div className="list-card-title">Runtime mode</div>
          <div className="list-card-meta">
            {health?.runtimeMode ? `Mode: ${health.runtimeMode}` : "Runtime mode unavailable"}
          </div>
          <div className="list-card-meta">
            {appStatus ? `${appStatus.songCount} songs, ${appStatus.queuedJobCount} queued, ${appStatus.activeJobCount} active` : "Library status pending"}
          </div>
        </article>

        <article className="list-card">
          <div className="list-card-title">App data path</div>
          <div className="path-block">{appDataPath ?? "Unavailable until the main process responds."}</div>
        </article>

        <article className="list-card">
          <div className="list-card-title">Model cache</div>
          <div className="path-block">{health?.modelsPath ?? appStatus?.modelsDir ?? "Model cache path unavailable"}</div>
          <div className="list-card-meta">
            {health?.workerRunning ? "Worker is connected." : "Worker will start on demand or during setup."}
          </div>
        </article>
      </div>

      {actionMessage ? <div className="settings-banner">{actionMessage}</div> : null}

      <div className="settings-check-grid">
        {checks.map((check) => (
          <article key={check.key} className="list-card check-card">
            <div className="check-row">
              <div>
                <div className="list-card-title">{check.label}</div>
                <div className="list-card-meta">{check.detail}</div>
              </div>
              <StatusPill tone={statusTone(check.status)}>{check.status}</StatusPill>
            </div>
          </article>
        ))}
      </div>

      {health?.details?.length ? (
        <article className="list-card">
          <div className="list-card-title">Diagnostics</div>
          <div className="settings-detail-list">
            {health.details.map((detail) => (
              <div key={detail} className="settings-detail-item">
                {detail}
              </div>
            ))}
          </div>
        </article>
      ) : null}
    </section>
  );
}
