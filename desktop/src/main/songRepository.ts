import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { CACHE_SCHEMA_VERSION, PIPELINE_VERSION } from "./constants";
import { nowIso, readJsonFile, writeJsonFile } from "./json";
import type { AppDirectories } from "./appPaths";
import type {
  AppStatus,
  ArtifactManifest,
  EditableLyricLine,
  JobStage,
  JobStatus,
  LyricLine,
  LyricWord,
  PlaybackPayload,
  ProcessingJob,
  SongRecord,
  SongStatus,
} from "../../../contracts";

interface LibraryStore {
  songs: SongRecord[];
  jobs: ProcessingJob[];
  manifests: Record<string, ArtifactManifest>;
}

function defaultStore(): LibraryStore {
  return {
    songs: [],
    jobs: [],
    manifests: {},
  };
}

export class SongRepository {
  private store: LibraryStore;

  constructor(private readonly directories: AppDirectories) {
    this.store = this.loadStore();
  }

  close(): void {
    this.persistStore();
  }

  private loadStore(): LibraryStore {
    if (!fs.existsSync(this.directories.dbPath)) {
      return defaultStore();
    }

    try {
      const raw = fs.readFileSync(this.directories.dbPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LibraryStore>;
      return {
        songs: Array.isArray(parsed.songs) ? parsed.songs : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        manifests: parsed.manifests && typeof parsed.manifests === "object" ? parsed.manifests as Record<string, ArtifactManifest> : {},
      };
    } catch {
      return defaultStore();
    }
  }

  private persistStore(): void {
    fs.writeFileSync(this.directories.dbPath, `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
  }

  async hashFile(filePath: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const handle = await fsPromises.open(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead <= 0) {
          break;
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  }

  buildSourceId(sourceHash: string, durationMs: number | null, fileSize = 0): string {
    return crypto.createHash("sha256").update(`${sourceHash}:${durationMs ?? 0}:${fileSize}`).digest("hex");
  }

  async createSongWorkspace(sourceId: string): Promise<string> {
    const workspaceDir = path.join(this.directories.songsDir, sourceId);
    await fsPromises.mkdir(path.join(workspaceDir, "source"), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, "normalized"), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, "separation"), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, "transcript"), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, "waveforms"), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, "artwork"), { recursive: true });
    return workspaceDir;
  }

  async copySourceFile(sourcePath: string, workspaceDir: string): Promise<string> {
    const copiedPath = path.join(workspaceDir, "source", path.basename(sourcePath));
    await fsPromises.copyFile(sourcePath, copiedPath);
    return copiedPath;
  }

  async importLocalSong(params: {
    sourceId: string;
    sourceHash: string;
    originalFileName: string | null;
    title: string;
    durationMs: number | null;
    copiedSourcePath: string;
  }): Promise<SongRecord> {
    const now = nowIso();
    const existing = this.getSongBySourceId(params.sourceId);
    const song: SongRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      sourceId: params.sourceId,
      sourceHash: params.sourceHash,
      sourceType: "local_file",
      sourcePath: params.copiedSourcePath,
      originalFileName: params.originalFileName,
      title: params.title,
      artist: existing?.artist ?? null,
      durationMs: params.durationMs,
      language: existing?.language ?? null,
      status: "imported",
      pipelineVersion: PIPELINE_VERSION,
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      artifactManifestPath: existing?.artifactManifestPath ?? null,
      hasCachedArtifacts: existing?.hasCachedArtifacts ?? false,
      errorMessage: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastProcessedAt: existing?.lastProcessedAt ?? null,
    };

    this.store.songs = this.store.songs.filter((entry) => entry.sourceId !== params.sourceId);
    this.store.songs.push(song);
    this.persistStore();
    return song;
  }

  listSongs(): SongRecord[] {
    return [...this.store.songs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getSongById(songId: string): SongRecord | null {
    return this.store.songs.find((song) => song.id === songId) ?? null;
  }

  getSongBySourceId(sourceId: string): SongRecord | null {
    return this.store.songs.find((song) => song.sourceId === sourceId) ?? null;
  }

  getManifestForSong(songId: string): ArtifactManifest | null {
    return this.store.manifests[songId] ?? null;
  }

  async persistManifest(songId: string, manifest: ArtifactManifest, workspaceDir: string): Promise<string> {
    const now = nowIso();
    const manifestPath = path.join(workspaceDir, "manifest.json");
    await writeJsonFile(manifestPath, manifest);
    this.store.manifests[songId] = manifest;

    const song = this.getSongById(songId);
    if (song) {
      const updatedSong: SongRecord = {
        ...song,
        pipelineVersion: manifest.pipelineVersion,
        cacheSchemaVersion: manifest.cacheSchemaVersion,
        artifactManifestPath: manifestPath,
        hasCachedArtifacts: true,
        status: "ready",
        errorMessage: null,
        updatedAt: now,
        lastProcessedAt: now,
      };
      this.store.songs = this.store.songs.map((entry) => (entry.id === songId ? updatedSong : entry));
    }

    this.persistStore();
    return manifestPath;
  }

  createJob(songId: string): ProcessingJob {
    const now = nowIso();
    const existingAttempts = this.store.jobs.filter((job) => job.songId === songId).length;
    const job: ProcessingJob = {
      id: crypto.randomUUID(),
      songId,
      status: "queued",
      stage: "waiting",
      percentComplete: 0,
      message: null,
      errorMessage: null,
      attemptCount: existingAttempts + 1,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.store.jobs.push(job);
    this.persistStore();
    return job;
  }

  getJob(jobId: string): ProcessingJob | null {
    return this.store.jobs.find((job) => job.id === jobId) ?? null;
  }

  listJobs(): ProcessingJob[] {
    return [...this.store.jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listActiveJobs(): ProcessingJob[] {
    return this.store.jobs.filter((job) => job.status === "queued" || job.status === "running");
  }

  private reconcileSongStatus(songId: string): SongRecord | null {
    const song = this.getSongById(songId);
    if (!song) {
      return null;
    }

    const songJobs = this.store.jobs.filter((job) => job.songId === songId);
    const hasRunning = songJobs.some((job) => job.status === "running");
    const hasQueued = songJobs.some((job) => job.status === "queued");

    let status: SongStatus;
    let errorMessage: string | null = null;

    if (hasRunning) {
      status = "processing";
    } else if (hasQueued) {
      status = "queued";
    } else if (song.hasCachedArtifacts) {
      status = "ready";
    } else {
      status = "imported";
    }

    const updatedSong: SongRecord = {
      ...song,
      status,
      errorMessage,
      updatedAt: nowIso(),
    };
    this.store.songs = this.store.songs.map((entry) => (entry.id === songId ? updatedSong : entry));
    return updatedSong;
  }

  updateJob(jobId: string, patch: Partial<ProcessingJob>): ProcessingJob | null {
    const current = this.getJob(jobId);
    if (!current) {
      return null;
    }

    const next: ProcessingJob = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };
    this.store.jobs = this.store.jobs.map((job) => (job.id === jobId ? next : job));
    this.persistStore();
    return next;
  }

  removeJob(jobId: string): ProcessingJob | null {
    const current = this.getJob(jobId);
    if (!current) {
      return null;
    }

    this.store.jobs = this.store.jobs.filter((job) => job.id !== jobId);
    this.reconcileSongStatus(current.songId);
    this.persistStore();
    return current;
  }

  removeJobs(jobIds: string[]): number {
    const uniqueIds = new Set(jobIds);
    if (uniqueIds.size === 0) {
      return 0;
    }

    const removedJobs = this.store.jobs.filter((job) => uniqueIds.has(job.id));
    if (removedJobs.length === 0) {
      return 0;
    }

    this.store.jobs = this.store.jobs.filter((job) => !uniqueIds.has(job.id));
    for (const songId of new Set(removedJobs.map((job) => job.songId))) {
      this.reconcileSongStatus(songId);
    }
    this.persistStore();
    return removedJobs.length;
  }

  async deleteSong(songId: string): Promise<boolean> {
    const song = this.getSongById(songId);
    if (!song) {
      return false;
    }

    const workspaceDir = this.getSongWorkspaceDir(song);
    delete this.store.manifests[songId];
    this.store.jobs = this.store.jobs.filter((job) => job.songId !== songId);
    this.store.songs = this.store.songs.filter((entry) => entry.id !== songId);
    this.persistStore();
    await fsPromises.rm(workspaceDir, { recursive: true, force: true });
    return true;
  }

  setSongStatus(songId: string, status: SongStatus, errorMessage: string | null = null): SongRecord | null {
    const song = this.getSongById(songId);
    if (!song) {
      return null;
    }

    const updatedSong: SongRecord = {
      ...song,
      status,
      errorMessage,
      updatedAt: nowIso(),
    };
    this.store.songs = this.store.songs.map((entry) => (entry.id === songId ? updatedSong : entry));
    this.persistStore();
    return updatedSong;
  }

  markInterruptedJobsFailed(): ProcessingJob[] {
    const interrupted = this.store.jobs.filter((job) => job.status === "queued" || job.status === "running");
    if (interrupted.length === 0) {
      return [];
    }

    const now = nowIso();
    const interruptedIds = new Set(interrupted.map((job) => job.id));
    const interruptedSongIds = new Set(interrupted.map((job) => job.songId));

    this.store.jobs = this.store.jobs.map((job) =>
      interruptedIds.has(job.id)
        ? {
            ...job,
            status: "failed",
            stage: "waiting",
            percentComplete: 0,
            errorMessage: "Application restarted before the job completed",
            message: "Application restarted before the job completed",
            updatedAt: now,
            finishedAt: now,
          }
        : job,
    );

    this.store.songs = this.store.songs.map((song) =>
      interruptedSongIds.has(song.id)
        ? {
            ...song,
            status: "failed",
            errorMessage: "Application restarted before the job completed",
            updatedAt: now,
          }
        : song,
    );

    this.persistStore();
    return interrupted.map((job) => ({
      ...job,
      status: "failed",
      stage: "waiting",
      percentComplete: 0,
      errorMessage: "Application restarted before the job completed",
      message: "Application restarted before the job completed",
      updatedAt: now,
      finishedAt: now,
    }));
  }

  async loadManifestFromDisk(manifestPath: string): Promise<ArtifactManifest | null> {
    try {
      return await readJsonFile<ArtifactManifest>(manifestPath);
    } catch {
      return null;
    }
  }

  private normalizeLyricWords(rawWords: unknown): LyricWord[] {
    if (!Array.isArray(rawWords)) {
      return [];
    }

    return rawWords
      .map((word, index) => {
        if (!word || typeof word !== "object") {
          return null;
        }

        const candidate = word as Record<string, unknown>;
        const text = typeof candidate.text === "string" ? candidate.text : "";
        const start = typeof candidate.start === "number" ? candidate.start : 0;
        const end = typeof candidate.end === "number" ? candidate.end : start;
        if (!text) {
          return null;
        }

        return {
          index,
          text,
          startMs: Math.max(0, Math.round(start * 1000)),
          endMs: Math.max(0, Math.round(end * 1000)),
          confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
        } satisfies LyricWord;
      })
      .filter((word): word is LyricWord => Boolean(word));
  }

  private normalizeLyricLines(rawLines: unknown, words: LyricWord[]): LyricLine[] {
    if (!Array.isArray(rawLines)) {
      return [];
    }

    let cursor = 0;
    return rawLines
      .map((line, index) => {
        if (!line || typeof line !== "object") {
          return null;
        }

        const candidate = line as Record<string, unknown>;
        const text = typeof candidate.text === "string" ? candidate.text : "";
        const start = typeof candidate.start === "number" ? candidate.start : 0;
        const end = typeof candidate.end === "number" ? candidate.end : start;
        const wordCount = Array.isArray(candidate.words) ? candidate.words.length : 0;
        const startIndex = cursor;
        const endIndex = wordCount > 0 ? Math.min(words.length - 1, cursor + wordCount - 1) : Math.max(cursor - 1, 0);
        cursor += wordCount;

        if (!text) {
          return null;
        }

        return {
          index: typeof candidate.order === "number" ? candidate.order : index,
          text,
          startMs: Math.max(0, Math.round(start * 1000)),
          endMs: Math.max(0, Math.round(end * 1000)),
          wordStartIndex: startIndex,
          wordEndIndex: endIndex,
        } satisfies LyricLine;
      })
      .filter((line): line is LyricLine => Boolean(line));
  }

  private getSongWorkspaceDir(song: SongRecord): string {
    return path.join(this.directories.songsDir, song.sourceId);
  }

  private getOverridePaths(song: SongRecord): { linesPath: string; wordsPath: string } {
    const transcriptDir = path.join(this.getSongWorkspaceDir(song), "transcript");
    return {
      linesPath: path.join(transcriptDir, "lines.override.json"),
      wordsPath: path.join(transcriptDir, "words.override.json"),
    };
  }

  private editableLinesFromLyricLines(lines: LyricLine[]): EditableLyricLine[] {
    return lines.map((line) => ({
      index: line.index,
      text: line.text,
      startMs: line.startMs,
      endMs: line.endMs,
    }));
  }

  private normalizeEditableLyricLines(rawLines: unknown): EditableLyricLine[] {
    if (!Array.isArray(rawLines)) {
      return [];
    }

    return rawLines
      .map((line, index) => {
        if (!line || typeof line !== "object") {
          return null;
        }

        const candidate = line as Record<string, unknown>;
        const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
        const startMs = typeof candidate.startMs === "number" ? Math.max(0, Math.round(candidate.startMs)) : 0;
        const endMsRaw =
          typeof candidate.endMs === "number" ? Math.max(startMs, Math.round(candidate.endMs)) : startMs + 1000;
        if (!text) {
          return null;
        }

        return {
          index: typeof candidate.index === "number" ? candidate.index : index,
          text,
          startMs,
          endMs: endMsRaw,
        } satisfies EditableLyricLine;
      })
      .filter((line): line is EditableLyricLine => Boolean(line))
      .sort((left, right) => left.startMs - right.startMs || left.index - right.index)
      .map((line, index) => ({ ...line, index }));
  }

  private generateWordsFromEditableLines(lines: EditableLyricLine[]): LyricWord[] {
    const words: LyricWord[] = [];
    let cursor = 0;

    for (const line of lines) {
      const tokens = line.text.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        continue;
      }

      const durationMs = Math.max(line.endMs - line.startMs, tokens.length * 120);
      const stepMs = durationMs / tokens.length;

      for (let index = 0; index < tokens.length; index += 1) {
        const startMs = Math.round(line.startMs + (stepMs * index));
        const endMs =
          index === tokens.length - 1
            ? line.endMs
            : Math.max(startMs + 1, Math.round(line.startMs + (stepMs * (index + 1))));
        words.push({
          index: cursor,
          text: tokens[index],
          startMs,
          endMs,
          confidence: null,
        });
        cursor += 1;
      }
    }

    return words;
  }

  private buildLyricLinesFromEditableLines(lines: EditableLyricLine[], words: LyricWord[]): LyricLine[] {
    const built: LyricLine[] = [];
    let wordCursor = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const wordCount = line.text.split(/\s+/).filter(Boolean).length;
      const startIndex = wordCount > 0 ? wordCursor : Math.max(wordCursor - 1, 0);
      const endIndex = wordCount > 0 ? Math.min(words.length - 1, wordCursor + wordCount - 1) : startIndex;

      built.push({
        index,
        text: line.text,
        startMs: line.startMs,
        endMs: line.endMs,
        wordStartIndex: startIndex,
        wordEndIndex: endIndex,
      });

      wordCursor += wordCount;
    }

    return built;
  }

  async saveLyricOverrides(songId: string, lines: EditableLyricLine[]): Promise<PlaybackPayload | null> {
    const song = this.getSongById(songId);
    if (!song) {
      return null;
    }

    const normalizedLines = this.normalizeEditableLyricLines(lines);
    if (normalizedLines.length === 0) {
      throw new Error("At least one lyric line is required to save edits.");
    }

    const { linesPath, wordsPath } = this.getOverridePaths(song);
    const words = this.generateWordsFromEditableLines(normalizedLines);
    await writeJsonFile(linesPath, normalizedLines);
    await writeJsonFile(wordsPath, words);
    this.setSongStatus(songId, song.hasCachedArtifacts ? "ready" : song.status, null);
    return await this.buildPlaybackPayload(songId);
  }

  async resetLyricOverrides(songId: string): Promise<PlaybackPayload | null> {
    const song = this.getSongById(songId);
    if (!song) {
      return null;
    }

    const { linesPath, wordsPath } = this.getOverridePaths(song);
    await fsPromises.rm(linesPath, { force: true });
    await fsPromises.rm(wordsPath, { force: true });
    this.setSongStatus(songId, song.hasCachedArtifacts ? "ready" : song.status, null);
    return await this.buildPlaybackPayload(songId);
  }

  async buildPlaybackPayload(songId: string): Promise<PlaybackPayload | null> {
    const song = this.getSongById(songId);
    if (!song) {
      return null;
    }

    const artifactManifest = song.artifactManifestPath ? this.getManifestForSong(songId) : null;
    const primaryAudioPath = artifactManifest?.instrumentalPath ?? song.sourcePath;
    const overridePaths = this.getOverridePaths(song);
    const overrideLines = await readJsonFile<unknown>(overridePaths.linesPath).catch(() => []);
    const overrideWords = await readJsonFile<unknown>(overridePaths.wordsPath).catch(() => []);
    const editableOverrideLines = this.normalizeEditableLyricLines(overrideLines);
    const hasLyricOverrides = editableOverrideLines.length > 0;
    const rawWords = hasLyricOverrides
      ? overrideWords
      : artifactManifest?.transcriptWordsPath
        ? await readJsonFile<unknown>(artifactManifest.transcriptWordsPath).catch(() => [])
        : [];
    const rawLines = hasLyricOverrides
      ? overrideLines
      : artifactManifest?.transcriptLinesPath
        ? await readJsonFile<unknown>(artifactManifest.transcriptLinesPath).catch(() => [])
        : [];
    const lyricWords = hasLyricOverrides ? this.normalizeLyricWords(rawWords) : this.normalizeLyricWords(rawWords);
    const lyricLines = hasLyricOverrides
      ? this.buildLyricLinesFromEditableLines(editableOverrideLines, lyricWords)
      : this.normalizeLyricLines(rawLines, lyricWords);
    const editableLyricLines = hasLyricOverrides
      ? editableOverrideLines
      : this.editableLinesFromLyricLines(lyricLines);

    return {
      song,
      artifactManifest,
      primaryAudioPath,
      lyricWordsPath: hasLyricOverrides ? overridePaths.wordsPath : artifactManifest?.transcriptWordsPath ?? null,
      lyricLinesPath: hasLyricOverrides ? overridePaths.linesPath : artifactManifest?.transcriptLinesPath ?? null,
      lyricWords,
      lyricLines,
      editableLyricLines,
      hasLyricOverrides,
      canPlay: Boolean(song.hasCachedArtifacts || artifactManifest),
    };
  }

  getStatus(directories: AppDirectories, workerReady: boolean, appVersion: string): AppStatus {
    return {
      appVersion,
      baseDir: directories.baseDir,
      dbPath: directories.dbPath,
      songsDir: directories.songsDir,
      modelsDir: directories.modelsDir,
      logsDir: directories.logsDir,
      songCount: this.store.songs.length,
      activeJobCount: this.store.jobs.filter((job) => job.status === "running").length,
      queuedJobCount: this.store.jobs.filter((job) => job.status === "queued").length,
      workerReady,
      pipelineVersion: PIPELINE_VERSION,
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    };
  }
}
