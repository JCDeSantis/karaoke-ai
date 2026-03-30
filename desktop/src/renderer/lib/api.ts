import type { AppStatus, KaraokeApi, PlaybackPayload, ProcessingJob, ProcessorHealth, SongRecord } from "../types/electron-api";

const emptyHealth: ProcessorHealth = {
  status: "unknown",
  summary: "Processor status will appear here when the main process is connected.",
};

const emptyApi: KaraokeApi = {
  async importLocalFile(path: string): Promise<SongRecord> {
    const now = new Date().toISOString();
    return {
      id: `pending-${path}`,
      title: path.split(/[/\\]/).pop() ?? "Imported Song",
      sourcePath: path,
      sourceType: "local_file",
      sourceId: `pending-${path}`,
      sourceHash: "",
      originalFileName: path.split(/[/\\]/).pop() ?? null,
      artist: null,
      durationMs: null,
      language: null,
      status: "imported",
      pipelineVersion: "1.1.0",
      cacheSchemaVersion: 1,
      artifactManifestPath: null,
      hasCachedArtifacts: false,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      lastProcessedAt: null,
    };
  },
  async enqueueProcessing(): Promise<ProcessingJob | null> {
    return null;
  },
  async removeJob(): Promise<boolean> {
    return false;
  },
  async clearJobs(): Promise<number> {
    return 0;
  },
  async listSongs(): Promise<SongRecord[]> {
    return [];
  },
  async getSong(): Promise<SongRecord | null> {
    return null;
  },
  async deleteSong(): Promise<boolean> {
    return false;
  },
  async playSong(): Promise<PlaybackPayload | null> {
    return null;
  },
  async saveLyrics(): Promise<PlaybackPayload | null> {
    return null;
  },
  async resetLyrics(): Promise<PlaybackPayload | null> {
    return null;
  },
  subscribeToJobEvents(): () => void {
    return () => {};
  },
  async openFilePicker(): Promise<string | null> {
    return null;
  },
  async getAppStatus(): Promise<AppStatus> {
    return {
      appVersion: "0.1.0",
      baseDir: "",
      dbPath: "",
      songsDir: "",
      modelsDir: "",
      logsDir: "",
      songCount: 0,
      activeJobCount: 0,
      queuedJobCount: 0,
      workerReady: false,
      pipelineVersion: "1.1.0",
      cacheSchemaVersion: 1,
    };
  },
  async getProcessorHealth(): Promise<ProcessorHealth> {
    return emptyHealth;
  },
  async prepareRuntime(): Promise<ProcessorHealth> {
    return emptyHealth;
  },
  async listJobs(): Promise<ProcessingJob[]> {
    return [];
  },
};

export function getKaraokeApi(): KaraokeApi {
  return window.karaokeApi ?? emptyApi;
}
