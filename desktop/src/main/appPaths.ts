import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

export interface AppDirectories {
  baseDir: string;
  dbPath: string;
  songsDir: string;
  modelsDir: string;
  logsDir: string;
  tempDir: string;
}

export async function ensureDirectories(): Promise<AppDirectories> {
  const baseRoot = process.env.LOCALAPPDATA ?? app.getPath("appData");
  const baseDir = path.join(baseRoot, "KaraokeAI");
  const songsDir = path.join(baseDir, "songs");
  const modelsDir = path.join(baseDir, "models");
  const logsDir = path.join(baseDir, "logs");
  const tempDir = path.join(baseDir, "tmp");
  const dbPath = path.join(baseDir, "library.json");

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(songsDir, { recursive: true });
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  return { baseDir, dbPath, songsDir, modelsDir, logsDir, tempDir };
}

export function workspaceForSourceId(directories: AppDirectories, sourceId: string): string {
  return path.join(directories.songsDir, sourceId);
}
