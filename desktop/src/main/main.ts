import { app, BrowserWindow, protocol } from "electron";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ensureDirectories } from "./appPaths";
import { registerIpcHandlers } from "./ipc";
import { JobQueue } from "./jobQueue";
import { SongRepository } from "./songRepository";
import { WorkerProcessManager } from "./workerProcess";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "karaoke-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let repositoryRef: SongRepository | null = null;
let workerRef: WorkerProcessManager | null = null;

function inferMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".m4a":
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

function parseRangeHeader(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader?.startsWith("bytes=") || size <= 0) {
    return null;
  }

  const [rawStart, rawEnd] = rangeHeader.slice("bytes=".length).split("-", 2);
  const hasStart = rawStart.trim().length > 0;
  const hasEnd = rawEnd.trim().length > 0;

  if (!hasStart && !hasEnd) {
    return null;
  }

  if (!hasStart && hasEnd) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const parsedStart = Number.parseInt(rawStart, 10);
  const parsedEnd = hasEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) {
    return null;
  }

  const start = Math.max(0, parsedStart);
  const end = Math.min(size - 1, parsedEnd);
  if (start > end || start >= size) {
    return null;
  }

  return { start, end };
}

function registerMediaProtocol(): void {
  protocol.handle("karaoke-media", async (request): Promise<Response> => {
    const url = new URL(request.url);
    const mediaPath = url.searchParams.get("path");
    if (!mediaPath) {
      return new Response("Missing media path", { status: 400 });
    }

    const normalizedPath = path.normalize(mediaPath);
    try {
      const stats = await fsPromises.stat(normalizedPath);
      if (!stats.isFile()) {
        return new Response("Media not found", { status: 404 });
      }

      const contentType = inferMediaType(normalizedPath);
      const range = parseRangeHeader(request.headers.get("range"), stats.size);
      if (!range) {
        const stream = Readable.toWeb(fs.createReadStream(normalizedPath)) as ReadableStream;
        return new Response(stream, {
          status: 200,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(stats.size),
            "content-type": contentType,
            "cache-control": "no-store",
          },
        });
      }

      const chunkSize = range.end - range.start + 1;
      const stream = Readable.toWeb(fs.createReadStream(normalizedPath, { start: range.start, end: range.end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(chunkSize),
          "content-range": `bytes ${range.start}-${range.end}/${stats.size}`,
          "content-type": contentType,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open media file";
      return new Response(message, { status: 500 });
    }
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: "#101114",
    title: "KaraokeAI",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
  } else {
    await window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  return window;
}

async function bootstrap(): Promise<void> {
  const directories = await ensureDirectories();
  const repository = new SongRepository(directories);
  const worker = new WorkerProcessManager(directories);
  const queue = new JobQueue(directories, repository, worker);
  repositoryRef = repository;
  workerRef = worker;

  queue.recoverInterruptedJobs();
  worker.warmup();

  registerIpcHandlers({
    directories,
    repository,
    queue,
    worker,
  });

  mainWindow = await createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerMediaProtocol();
  void bootstrap();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  workerRef?.shutdown();
  repositoryRef?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
