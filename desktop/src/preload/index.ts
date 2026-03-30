import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AppStatus, EditableLyricLine, PlaybackPayload, ProcessingJob, SongRecord } from "../../../contracts";
import type { KaraokeApi, ProcessorHealth } from "../renderer/types/electron-api";

function formatProcessorHealth(response: {
  healthy?: boolean;
  details?: Record<string, unknown>;
}): ProcessorHealth {
  const details = response.details ?? {};
  const ffmpegDetails =
    details.ffmpeg && typeof details.ffmpeg === "object" ? (details.ffmpeg as Record<string, unknown>) : null;
  const bootstrapDetails = Array.isArray(details.bootstrap_details)
    ? details.bootstrap_details.map((item) => String(item))
    : [];
  const runtimeMode =
    typeof details.runtime_mode === "string"
      ? (details.runtime_mode as ProcessorHealth["runtimeMode"])
      : "unknown";
  const modelsPath = typeof details.models_dir === "string" ? details.models_dir : null;
  const processorEnvPath = typeof details.processor_env === "string" ? details.processor_env : null;
  const appDataPath = typeof details.app_data_dir === "string" ? details.app_data_dir : null;
  const workerRunning = Boolean(details.worker_running);
  const torchcodecInstalled = Boolean(details.torchcodec);
  const flags = {
    ffmpeg: ffmpegDetails ? Boolean(ffmpegDetails.available) : Boolean(details.ffmpeg),
    demucs: Boolean(details.demucs),
    whisper: Boolean(details.faster_whisper),
    separationReady: Boolean(details.separation_ready),
  };
  const bootstrapStatus =
    typeof details.bootstrap_status === "string"
      ? (details.bootstrap_status as ProcessorHealth["bootstrapStatus"])
      : undefined;
  const status = response.healthy
    ? "ok"
    : bootstrapStatus === "bootstrapping"
      ? "warning"
      : Object.values(flags).some(Boolean)
        ? "warning"
        : "error";
  const summary =
    typeof details.bootstrap_message === "string"
      ? details.bootstrap_message
      : response.healthy
        ? "Processor worker reachable."
        : "Processor worker missing one or more dependencies.";
  const extraDetails = [
    ffmpegDetails && typeof ffmpegDetails.source === "string" ? `ffmpeg source: ${ffmpegDetails.source}` : null,
    `separation ready: ${flags.separationReady ? "yes" : "no"}`,
    typeof details.separation_backend === "string" ? `separation backend: ${details.separation_backend}` : null,
    `torchcodec: ${torchcodecInstalled ? "installed" : "not required"}`,
    `diffq: ${Boolean(details.diffq) ? "ready" : "optional"}`,
    Array.isArray(details.model_candidates) ? `separator models: ${details.model_candidates.map((item) => String(item)).join(", ")}` : null,
    typeof details.launch_target === "string" ? `launch target: ${details.launch_target}` : null,
    typeof details.models_summary === "string" ? `models: ${details.models_summary}` : null,
    ...bootstrapDetails,
  ].filter((item): item is string => Boolean(item));

  return {
    status,
    summary,
    details: [...Object.entries(flags).map(([key, value]) => `${key}: ${value ? "ready" : "missing"}`), ...extraDetails],
    bootstrapStatus,
    runtimeMode,
    workerRunning,
    appDataPath,
    modelsPath,
    processorEnvPath,
    checks: [
      {
        key: "worker",
        label: "Worker process",
        status: workerRunning ? "ready" : bootstrapStatus === "bootstrapping" ? "warning" : "missing",
        detail: workerRunning ? "Worker process is connected" : "Worker process is not running yet",
      },
      {
        key: "ffmpeg",
        label: "FFmpeg",
        status: flags.ffmpeg ? "ready" : "missing",
        detail:
          ffmpegDetails && typeof ffmpegDetails.executable === "string"
            ? ffmpegDetails.executable
            : flags.ffmpeg
              ? "Detected"
              : "Missing",
      },
      {
        key: "demucs",
        label: "Demucs",
        status: flags.demucs ? "ready" : "missing",
        detail: flags.demucs ? "Python package available" : "Python package missing",
      },
      {
        key: "torchcodec",
        label: "TorchCodec",
        status: torchcodecInstalled ? "ready" : "warning",
        detail: torchcodecInstalled ? "Optional torchaudio codec package installed" : "Not required with the built-in WAV writer",
      },
      {
        key: "separation",
        label: "Stem separation",
        status: flags.separationReady ? "ready" : flags.demucs ? "warning" : "missing",
        detail: flags.separationReady ? "Guide vocals and instrumental export available" : "Separator can run, but stem export is incomplete",
      },
      {
        key: "whisper",
        label: "Faster-Whisper",
        status: flags.whisper ? "ready" : "missing",
        detail: flags.whisper ? "Python package available" : "Python package missing",
      },
      {
        key: "models",
        label: "Model cache",
        status:
          typeof details.models_entry_count === "number" && details.models_entry_count > 0
            ? "ready"
            : flags.whisper
              ? "warning"
              : "missing",
        detail:
          typeof details.models_summary === "string"
            ? details.models_summary
            : modelsPath ?? "Model cache location unavailable",
      },
      {
        key: "bootstrap",
        label: "Bootstrap",
        status:
          bootstrapStatus === "ready"
            ? "ready"
            : bootstrapStatus === "bootstrapping"
              ? "warning"
              : "missing",
        detail:
          typeof details.bootstrap_message === "string"
            ? details.bootstrap_message
            : "Bootstrap state unavailable",
      },
    ],
    ffmpeg: flags.ffmpeg,
    demucs: flags.demucs,
    whisper: flags.whisper,
    torchcodec: torchcodecInstalled,
  };
}

const karaokeApi: KaraokeApi = {
  async importLocalFile(filePath: string): Promise<SongRecord> {
    const result = (await ipcRenderer.invoke("karaoke:import-local-file", filePath)) as {
      song?: SongRecord;
      error?: string;
    };
    if (result.error || !result.song) {
      throw new Error(result.error ?? "Import failed");
    }
    return result.song;
  },
  async enqueueProcessing(songId: string): Promise<ProcessingJob | null> {
    const result = (await ipcRenderer.invoke("karaoke:enqueue-processing", songId)) as {
      job?: ProcessingJob;
    };
    return result.job ?? null;
  },
  async removeJob(jobId: string): Promise<boolean> {
    const result = (await ipcRenderer.invoke("karaoke:remove-job", jobId)) as {
      removed?: boolean;
      error?: string;
    };
    if (result.error) {
      throw new Error(result.error);
    }
    return Boolean(result.removed);
  },
  async clearJobs(filter = "active"): Promise<number> {
    const result = (await ipcRenderer.invoke("karaoke:clear-jobs", filter)) as {
      removedCount?: number;
      error?: string;
    };
    if (result.error) {
      throw new Error(result.error);
    }
    return result.removedCount ?? 0;
  },
  listSongs(): Promise<SongRecord[]> {
    return ipcRenderer.invoke("karaoke:list-songs");
  },
  getSong(songId: string): Promise<SongRecord | null> {
    return ipcRenderer.invoke("karaoke:get-song", songId);
  },
  async deleteSong(songId: string): Promise<boolean> {
    const result = (await ipcRenderer.invoke("karaoke:delete-song", songId)) as {
      deleted?: boolean;
      error?: string;
    };
    if (result.error) {
      throw new Error(result.error);
    }
    return Boolean(result.deleted);
  },
  playSong(songId: string): Promise<PlaybackPayload | null> {
    return ipcRenderer.invoke("karaoke:play-song", songId);
  },
  async saveLyrics(songId: string, lines: EditableLyricLine[]): Promise<PlaybackPayload | null> {
    const result = (await ipcRenderer.invoke("karaoke:save-lyrics", songId, lines)) as {
      playback?: PlaybackPayload | null;
      error?: string;
    };
    if (result.error) {
      throw new Error(result.error);
    }
    return result.playback ?? null;
  },
  async resetLyrics(songId: string): Promise<PlaybackPayload | null> {
    const result = (await ipcRenderer.invoke("karaoke:reset-lyrics", songId)) as {
      playback?: PlaybackPayload | null;
      error?: string;
    };
    if (result.error) {
      throw new Error(result.error);
    }
    return result.playback ?? null;
  },
  subscribeToJobEvents(handler: (event: ProcessingJob) => void): () => void {
    const listener = (_event: IpcRendererEvent, job: ProcessingJob) => handler(job);
    ipcRenderer.on("karaoke:job-event", listener);
    return () => ipcRenderer.removeListener("karaoke:job-event", listener);
  },
  openFilePicker(): Promise<string | null> {
    return ipcRenderer.invoke("karaoke:open-file-picker");
  },
  getAppStatus(): Promise<AppStatus> {
    return ipcRenderer.invoke("karaoke:get-app-status");
  },
  async getProcessorHealth(): Promise<ProcessorHealth> {
    const response = (await ipcRenderer.invoke("karaoke:health-check")) as {
      healthy?: boolean;
      details?: Record<string, unknown>;
    };
    return formatProcessorHealth(response);
  },
  async prepareRuntime(options = {}): Promise<ProcessorHealth> {
    const response = (await ipcRenderer.invoke("karaoke:prepare-processor", options)) as {
      healthy?: boolean;
      details?: Record<string, unknown>;
    };
    return formatProcessorHealth(response);
  },
  listJobs(): Promise<ProcessingJob[]> {
    return ipcRenderer.invoke("karaoke:list-jobs");
  },
};

contextBridge.exposeInMainWorld("karaokeApi", karaokeApi);
