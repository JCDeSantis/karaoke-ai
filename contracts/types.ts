export type SourceType = "local_file" | "youtube";
export type SongStatus = "imported" | "queued" | "processing" | "ready" | "failed";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobStage = "waiting" | "normalizing" | "separating" | "transcribing" | "finalizing";

export interface LyricWord {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
}

export interface LyricLine {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  wordStartIndex: number;
  wordEndIndex: number;
}

export interface EditableLyricLine {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ArtifactManifest {
  songId: string;
  sourceId: string;
  pipelineVersion: string;
  cacheSchemaVersion: number;
  sourceCopyPath: string;
  normalizedAudioPath: string;
  instrumentalPath: string;
  vocalsPath: string | null;
  transcriptWordsPath: string;
  transcriptLinesPath: string;
  waveformPath: string | null;
  artworkPath: string | null;
  createdAt: string;
}

export interface SongRecord {
  id: string;
  sourceId: string;
  sourceHash: string;
  sourceType: SourceType;
  sourcePath: string;
  originalFileName: string | null;
  title: string;
  artist: string | null;
  durationMs: number | null;
  language: string | null;
  status: SongStatus;
  pipelineVersion: string;
  cacheSchemaVersion: number;
  artifactManifestPath: string | null;
  hasCachedArtifacts: boolean;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  lastProcessedAt: string | null;
}

export interface ProcessingJob {
  id: string;
  songId: string;
  status: JobStatus;
  stage: JobStage;
  percentComplete: number;
  message: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AppStatus {
  appVersion: string;
  baseDir: string;
  dbPath: string;
  songsDir: string;
  modelsDir: string;
  logsDir: string;
  songCount: number;
  activeJobCount: number;
  queuedJobCount: number;
  workerReady: boolean;
  pipelineVersion: string;
  cacheSchemaVersion: number;
}

export interface PlaybackPayload {
  song: SongRecord;
  artifactManifest: ArtifactManifest | null;
  primaryAudioPath: string;
  lyricWordsPath: string | null;
  lyricLinesPath: string | null;
  lyricWords: LyricWord[];
  lyricLines: LyricLine[];
  editableLyricLines: EditableLyricLine[];
  hasLyricOverrides: boolean;
  canPlay: boolean;
}
