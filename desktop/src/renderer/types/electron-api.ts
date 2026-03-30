import type { AppStatus, EditableLyricLine, LyricLine, LyricWord, PlaybackPayload, ProcessingJob, SongRecord } from "../../../../contracts";

export type ViewId = "library" | "import" | "queue" | "player" | "lyrics" | "settings";

export interface ProcessorHealth {
  status: "ok" | "warning" | "error" | "unknown";
  summary: string;
  details?: string[];
  ffmpeg?: boolean;
  demucs?: boolean;
  whisper?: boolean;
  torchcodec?: boolean;
  bootstrapStatus?: "idle" | "bootstrapping" | "ready" | "error";
  runtimeMode?: "dev" | "packaged" | "custom" | "unknown";
  workerRunning?: boolean;
  appDataPath?: string | null;
  modelsPath?: string | null;
  processorEnvPath?: string | null;
  checks?: Array<{
    key: string;
    label: string;
    status: "ready" | "warning" | "missing";
    detail: string;
  }>;
}

export interface KaraokeApi {
  importLocalFile(path: string): Promise<SongRecord>;
  enqueueProcessing(songId: string): Promise<ProcessingJob | null>;
  removeJob(jobId: string): Promise<boolean>;
  clearJobs(filter?: "all" | "active" | "finished"): Promise<number>;
  listSongs(): Promise<SongRecord[]>;
  getSong(songId: string): Promise<SongRecord | null>;
  deleteSong(songId: string): Promise<boolean>;
  playSong(songId: string): Promise<PlaybackPayload | null>;
  saveLyrics(songId: string, lines: EditableLyricLine[]): Promise<PlaybackPayload | null>;
  resetLyrics(songId: string): Promise<PlaybackPayload | null>;
  subscribeToJobEvents(handler: (event: ProcessingJob) => void): () => void;
  openFilePicker(): Promise<string | null>;
  getAppStatus(): Promise<AppStatus>;
  getProcessorHealth(): Promise<ProcessorHealth>;
  prepareRuntime(options?: { force?: boolean; preloadTranscriptionModel?: boolean }): Promise<ProcessorHealth>;
  listJobs(): Promise<ProcessingJob[]>;
}

export type { AppStatus, EditableLyricLine, LyricLine, LyricWord, PlaybackPayload, ProcessingJob, SongRecord };
