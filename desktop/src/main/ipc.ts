import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppDirectories } from "./appPaths";
import { JOB_EVENT_CHANNEL, IPC_CHANNELS } from "./constants";
import { safeErrorMessage } from "./json";
import { probeDurationMs } from "./mediaProbe";
import type { JobQueue } from "./jobQueue";
import type { SongRepository } from "./songRepository";
import type { WorkerProcessManager } from "./workerProcess";
import type { EditableLyricLine } from "../../../contracts";

export interface MainServices {
  directories: AppDirectories;
  repository: SongRepository;
  queue: JobQueue;
  worker: WorkerProcessManager;
}

function broadcastJobEvent(payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(JOB_EVENT_CHANNEL, payload);
    }
  }
}

export function registerIpcHandlers(services: MainServices): void {
  services.queue.on("job-event", (event) => broadcastJobEvent(event));

  ipcMain.handle(IPC_CHANNELS.openFilePicker, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        {
          name: "Audio and Video",
          extensions: ["mp3", "m4a", "wav", "flac", "aac", "ogg", "mp4", "mkv", "mov"],
        },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.importLocalFile, async (_event, inputPath: string) => {
    try {
      const stat = await fs.stat(inputPath);
      if (!stat.isFile()) {
        throw new Error("Selected path is not a file");
      }

      const sourceHash = await services.repository.hashFile(inputPath);
      const durationMs = await probeDurationMs(inputPath);
      const sourceId = services.repository.buildSourceId(sourceHash, durationMs, stat.size);
      const workspaceDir = await services.repository.createSongWorkspace(sourceId);
      const copiedSourcePath = await services.repository.copySourceFile(inputPath, workspaceDir);
      const imported = await services.repository.importLocalSong({
        sourceId,
        sourceHash,
        originalFileName: path.basename(inputPath),
        title: path.basename(inputPath, path.extname(inputPath)),
        durationMs,
        copiedSourcePath,
      });

      return { song: imported };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.listSongs, async () => services.repository.listSongs());
  ipcMain.handle(IPC_CHANNELS.listJobs, async () => services.queue.listJobs());

  ipcMain.handle(IPC_CHANNELS.getSong, async (_event, songId: string) => services.repository.getSongById(songId));

  ipcMain.handle(IPC_CHANNELS.deleteSong, async (_event, songId: string) => {
    try {
      const deleted = await services.queue.deleteSong(songId);
      return { deleted };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.enqueueProcessing, async (_event, songId: string) => {
    const job = services.queue.enqueue(songId);
    return { job };
  });

  ipcMain.handle(IPC_CHANNELS.removeJob, async (_event, jobId: string) => {
    try {
      const removed = await services.queue.removeJob(jobId);
      return { removed };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.clearJobs, async (_event, filter: "all" | "active" | "finished" = "active") => {
    try {
      const removedCount = await services.queue.clearJobs(filter);
      return { removedCount };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.playSong, async (_event, songId: string) => services.repository.buildPlaybackPayload(songId));

  ipcMain.handle(IPC_CHANNELS.saveLyrics, async (_event, songId: string, lines: EditableLyricLine[]) => {
    try {
      const playback = await services.repository.saveLyricOverrides(songId, lines);
      return { playback };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.resetLyrics, async (_event, songId: string) => {
    try {
      const playback = await services.repository.resetLyricOverrides(songId);
      return { playback };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.getAppStatus, async () =>
    services.repository.getStatus(services.directories, services.worker.isReady(), app.getVersion()),
  );

  ipcMain.handle(IPC_CHANNELS.healthCheck, async () => services.worker.healthCheck());

  ipcMain.handle(
    IPC_CHANNELS.prepareProcessor,
    async (_event, options?: { force?: boolean; preloadTranscriptionModel?: boolean }) => {
    try {
        return await services.worker.prepareRuntime({
          force: Boolean(options?.force),
          preloadTranscriptionModel: Boolean(options?.preloadTranscriptionModel),
        });
    } catch (error) {
      return {
        healthy: false,
        details: {
          message: safeErrorMessage(error),
        },
      };
    }
    },
  );
}
