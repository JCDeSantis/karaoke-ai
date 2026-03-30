import type { AppStatus, PlaybackPayload, ProcessingJob, SongRecord } from "../../../contracts";

export {};

declare global {
  interface Window {
    karaokeApi: {
      importLocalFile(filePath: string): Promise<unknown>;
      enqueueProcessing(songId: string): Promise<unknown>;
      removeJob(jobId: string): Promise<unknown>;
      clearJobs(filter?: "all" | "active" | "finished"): Promise<unknown>;
      listSongs(): Promise<SongRecord[]>;
      listJobs(): Promise<ProcessingJob[]>;
      getSong(songId: string): Promise<SongRecord | null>;
      deleteSong(songId: string): Promise<boolean>;
      playSong(songId: string): Promise<PlaybackPayload | null>;
      saveLyrics(songId: string, lines: unknown[]): Promise<PlaybackPayload | null>;
      resetLyrics(songId: string): Promise<PlaybackPayload | null>;
      prepareRuntime(options?: { force?: boolean; preloadTranscriptionModel?: boolean }): Promise<unknown>;
      openFilePicker(): Promise<string | null>;
      getAppStatus(): Promise<AppStatus>;
      getProcessorHealth(): Promise<unknown>;
      subscribeToJobEvents(handler: (event: unknown) => void): () => void;
    };
  }
}
