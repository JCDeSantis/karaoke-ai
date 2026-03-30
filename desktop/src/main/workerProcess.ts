import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { AppDirectories } from "./appPaths";
import { safeErrorMessage } from "./json";
import type { ProcessingJob, SongRecord } from "../../../contracts";

interface ProcessorTransportMessage {
  type: string;
  request_id?: string | null;
  job_id?: string | null;
  payload?: Record<string, unknown>;
}

interface PendingRequest {
  kind: "health" | "process" | "cancel";
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface ProcessTrackOptions {
  workspaceDir: string;
  pipelineVersion: string;
  cacheSchemaVersion: number;
}

interface LaunchTarget {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface PythonCandidate {
  command: string;
  argsPrefix: string[];
  label: string;
}

type BootstrapStatus = "idle" | "bootstrapping" | "ready" | "error";

export interface ProcessorHealthResponse {
  healthy: boolean;
  details: Record<string, unknown>;
}

export interface RawProcessorManifest {
  source_id?: string;
  pipeline_version?: string;
  original_audio?: string | null;
  normalized_audio?: string | null;
  instrumental_audio?: string | null;
  vocals_audio?: string | null;
  transcript_words?: string | null;
  transcript_lines?: string | null;
  waveform_peaks?: string | null;
  metadata_path?: string | null;
  logs_path?: string | null;
}

export interface NormalizedWorkerEvent {
  type: "JOB_STARTED" | "JOB_PROGRESS" | "JOB_COMPLETED" | "JOB_FAILED";
  requestId: string | null;
  jobId: string | null;
  stage: string | null;
  percentComplete: number;
  message: string | null;
  manifest: RawProcessorManifest;
  details: Record<string, unknown>;
}

export class WorkerProcessManager extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pendingResponses = new Map<string, PendingRequest>();
  private bufferedOutput = "";
  private ready = false;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapStatus: BootstrapStatus = "idle";
  private bootstrapMessage = "Processor environment has not been prepared yet.";
  private bootstrapDetails: string[] = [];
  private lastLaunchTarget: LaunchTarget | null = null;

  constructor(private readonly directories: AppDirectories) {
    super();
  }

  isReady(): boolean {
    return this.ready;
  }

  warmup(): void {
    void this.ensureStarted().catch((error) => {
      this.emit("log", `Processor warmup failed: ${safeErrorMessage(error)}`);
    });
  }

  private unique<T>(items: T[]): T[] {
    return [...new Set(items)];
  }

  private resolveProcessorDir(): string | null {
    const envRoot = process.env.KARAOKEAI_REPO_ROOT;
    const cwd = process.cwd();
    const candidates = this.unique(
      [envRoot, cwd, path.resolve(cwd, ".."), path.resolve(__dirname, "..", "..", "..")].filter(
        (value): value is string => Boolean(value),
      ),
    );

    for (const root of candidates) {
      const processorDir = path.join(root, "processor");
      if (fs.existsSync(path.join(processorDir, "karaoke_processor", "__main__.py"))) {
        return processorDir;
      }
    }

    return null;
  }

  private resolvePackagedExecutable(): LaunchTarget | null {
    const processorDir = path.join(process.resourcesPath, "processor");
    const candidateExecutables = [
      path.join(processorDir, "karaoke-processor.exe"),
      path.join(processorDir, "processor.exe"),
    ];
    const executablePath = candidateExecutables.find((candidate) => fs.existsSync(candidate));
    if (!executablePath) {
      return null;
    }

    const ffmpegPath = path.join(processorDir, "ffmpeg.exe");
    return {
      command: executablePath,
      args: [],
      env: {
        PATH: `${processorDir}${path.delimiter}${process.env.PATH ?? ""}`,
        HF_HOME: this.directories.modelsDir,
        KARAOKEAI_MODELS_DIR: this.directories.modelsDir,
        KARAOKEAI_FFMPEG_PATH: fs.existsSync(ffmpegPath) ? ffmpegPath : "",
      },
    };
  }

  private getProcessorEnvDir(): string {
    return path.join(this.directories.baseDir, "processor-env");
  }

  private getProcessorEnvPython(): string {
    return path.join(this.getProcessorEnvDir(), "Scripts", "python.exe");
  }

  private getBootstrapMarkerPath(): string {
    return path.join(this.getProcessorEnvDir(), "bootstrap-state.json");
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async captureCommand(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        resolve({ code: 1, stdout, stderr: `${stderr}\n${safeErrorMessage(error)}`.trim() });
      });
      child.once("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  private async runBootstrapCommand(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string },
  ): Promise<void> {
    const label = options?.label ?? `${command} ${args.join(" ")}`;
    this.emit("log", `Running ${label}`);
    const result = await this.captureCommand(command, args, options);
    if (result.code !== 0) {
      throw new Error(`${label} failed.\n${(result.stderr || result.stdout).trim()}`.trim());
    }
  }

  private async findSystemPython(): Promise<PythonCandidate | null> {
    const candidates: PythonCandidate[] = [];
    if (process.env.PYTHON) {
      candidates.push({ command: process.env.PYTHON, argsPrefix: [], label: process.env.PYTHON });
    }
    candidates.push({ command: "py", argsPrefix: ["-3"], label: "py -3" });
    candidates.push({ command: "python", argsPrefix: [], label: "python" });

    for (const candidate of candidates) {
      const result = await this.captureCommand(candidate.command, [...candidate.argsPrefix, "--version"]);
      if (result.code === 0) {
        return candidate;
      }
    }

    return null;
  }

  private async computeRequirementsFingerprint(processorDir: string): Promise<string> {
    const requirements = await fsPromises.readFile(path.join(processorDir, "requirements.txt"), "utf8");
    return crypto.createHash("sha256").update(requirements).digest("hex");
  }

  private async readBootstrapMarker(): Promise<{ fingerprint?: string } | null> {
    try {
      return await readJsonFile<{ fingerprint?: string }>(this.getBootstrapMarkerPath());
    } catch {
      return null;
    }
  }

  private async writeBootstrapMarker(fingerprint: string): Promise<void> {
    await writeJsonFile(this.getBootstrapMarkerPath(), {
      fingerprint,
      updatedAt: new Date().toISOString(),
    });
  }

  private buildVenvEnv(): NodeJS.ProcessEnv {
    const pythonPath = this.getProcessorEnvPython();
    const scriptsDir = path.dirname(pythonPath);
    return {
      ...process.env,
      PATH: `${scriptsDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HF_HOME: this.directories.modelsDir,
      KARAOKEAI_MODELS_DIR: this.directories.modelsDir,
    };
  }

  private async ensureBootstrapped(): Promise<void> {
    return this.ensureBootstrappedInternal(false);
  }

  private async ensureBootstrappedInternal(force: boolean): Promise<void> {
    const packaged = this.resolvePackagedExecutable();
    if (packaged) {
      this.bootstrapStatus = "ready";
      this.bootstrapMessage = "Bundled processor executable is available.";
      this.bootstrapDetails = ["mode: packaged"];
      this.lastLaunchTarget = packaged;
      return;
    }

    const processorDir = this.resolveProcessorDir();
    if (!processorDir) {
      this.bootstrapStatus = "error";
      this.bootstrapMessage = "Processor source folder could not be found from the current dev workspace.";
      this.bootstrapDetails = [`cwd: ${process.cwd()}`];
      throw new Error(this.bootstrapMessage);
    }

    const requirementsFingerprint = await this.computeRequirementsFingerprint(processorDir);
    const marker = await this.readBootstrapMarker();
    const envPython = this.getProcessorEnvPython();
    const envExists = await this.fileExists(envPython);
    const markerMatches = marker?.fingerprint === requirementsFingerprint;
    const venvDir = this.getProcessorEnvDir();

    if (!envExists || !markerMatches || force) {
      this.bootstrapStatus = "bootstrapping";
      this.bootstrapMessage = force
        ? "Refreshing processor dependencies for local development."
        : "Installing processor dependencies for local development.";
      this.bootstrapDetails = [`processor: ${processorDir}`, `venv: ${venvDir}`, `force: ${force}`];

      await fsPromises.mkdir(venvDir, { recursive: true });
      const python = await this.findSystemPython();
      if (!python) {
        this.bootstrapStatus = "error";
        this.bootstrapMessage = "Python 3.11+ is required to bootstrap the processor in dev mode.";
        this.bootstrapDetails = ["Tried: PYTHON env, py -3, python"];
        throw new Error(this.bootstrapMessage);
      }

      if (!envExists) {
        await this.runBootstrapCommand(
          python.command,
          [...python.argsPrefix, "-m", "venv", venvDir],
          { cwd: processorDir, label: "create processor venv" },
        );
      }

      await this.runBootstrapCommand(
        envPython,
        ["-m", "pip", "install", "--upgrade", "pip"],
        { cwd: processorDir, env: this.buildVenvEnv(), label: "upgrade pip" },
      );
      await this.runBootstrapCommand(
        envPython,
        ["-m", "pip", "install", "-r", "requirements.txt"],
        { cwd: processorDir, env: this.buildVenvEnv(), label: "install processor requirements" },
      );

      await this.writeBootstrapMarker(requirementsFingerprint);
    }

    this.bootstrapStatus = "ready";
    this.bootstrapMessage = "Processor environment is ready.";
    this.bootstrapDetails = [`processor: ${processorDir}`, `venv: ${venvDir}`];
    this.lastLaunchTarget = {
      command: envPython,
      args: ["-m", "karaoke_processor"],
      cwd: processorDir,
      env: this.buildVenvEnv() as Record<string, string>,
    };
  }

  private async resolveLaunchTarget(): Promise<LaunchTarget> {
    const explicit = process.env.KARAOKEAI_PROCESSOR_COMMAND;
    if (explicit) {
      return { command: explicit, args: [] };
    }

    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.ensureBootstrapped().finally(() => {
        this.bootstrapPromise = null;
      });
    }
    await this.bootstrapPromise;

    if (!this.lastLaunchTarget) {
      throw new Error("Processor launch target could not be resolved.");
    }

    return this.lastLaunchTarget;
  }

  private determineRuntimeMode(): "dev" | "packaged" | "custom" | "unknown" {
    if (process.env.KARAOKEAI_PROCESSOR_COMMAND) {
      return "custom";
    }
    if (this.resolvePackagedExecutable()) {
      return "packaged";
    }
    if (this.resolveProcessorDir()) {
      return "dev";
    }
    return "unknown";
  }

  private async summarizeModelsDir(): Promise<{ count: number; summary: string }> {
    try {
      const entries = await fsPromises.readdir(this.directories.modelsDir, { withFileTypes: true });
      const visible = entries.filter((entry) => !entry.name.startsWith("."));
      if (visible.length === 0) {
        return { count: 0, summary: "No downloaded model assets yet" };
      }

      const names = visible.slice(0, 3).map((entry) => entry.name);
      const suffix = visible.length > names.length ? ` +${visible.length - names.length} more` : "";
      return {
        count: visible.length,
        summary: `${visible.length} entries: ${names.join(", ")}${suffix}`,
      };
    } catch {
      return { count: 0, summary: "Model cache folder is not readable" };
    }
  }

  private async preloadTranscriptionModel(): Promise<void> {
    const runtimeMode = this.determineRuntimeMode();
    if (runtimeMode !== "dev") {
      this.bootstrapDetails = [...this.bootstrapDetails, "model preload: skipped outside dev runtime"];
      return;
    }

    const envPython = this.getProcessorEnvPython();
    if (!(await this.fileExists(envPython))) {
      throw new Error("Processor Python environment is missing; bootstrap the runtime before preloading models.");
    }

    this.bootstrapStatus = "bootstrapping";
    this.bootstrapMessage = "Downloading or verifying the transcription model cache.";
    this.bootstrapDetails = [...this.bootstrapDetails, "transcription model: base"];

    await this.runBootstrapCommand(
      envPython,
      [
        "-c",
        "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')",
      ],
      { env: this.buildVenvEnv(), label: "prepare faster-whisper base model" },
    );
  }

  private async buildSupplementalHealthDetails(): Promise<Record<string, unknown>> {
    const models = await this.summarizeModelsDir();
    return {
      bootstrap_status: this.bootstrapStatus,
      bootstrap_message: this.bootstrapMessage,
      bootstrap_details: this.bootstrapDetails,
      runtime_mode: this.determineRuntimeMode(),
      launch_target: this.lastLaunchTarget ? `${this.lastLaunchTarget.command} ${this.lastLaunchTarget.args.join(" ")}`.trim() : null,
      processor_env: this.getProcessorEnvPython(),
      processor_env_exists: await this.fileExists(this.getProcessorEnvPython()),
      models_dir: this.directories.modelsDir,
      models_entry_count: models.count,
      models_summary: models.summary,
      worker_running: this.process !== null && this.ready,
      app_data_dir: this.directories.baseDir,
    };
  }

  private startProcess(target: LaunchTarget): void {
    this.process = spawn(target.command, target.args, {
      cwd: target.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...(target.env ?? {}),
        KARAOKEAI_APPDATA: this.directories.baseDir,
        KARAOKEAI_MODE: "worker",
        PYTHONIOENCODING: "utf-8",
      },
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    this.process.stderr.on("data", (chunk: Buffer) => this.emit("log", chunk.toString("utf8")));
    this.process.once("exit", () => {
      this.ready = false;
      this.process = null;
      for (const pending of this.pendingResponses.values()) {
        pending.reject(new Error("Worker process exited"));
      }
      this.pendingResponses.clear();
    });
    this.ready = true;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process) {
      return;
    }

    const target = await this.resolveLaunchTarget();
    this.startProcess(target);
  }

  private handleStdout(chunk: string): void {
    this.bufferedOutput += chunk;
    let newlineIndex = this.bufferedOutput.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.bufferedOutput.slice(0, newlineIndex).trim();
      this.bufferedOutput = this.bufferedOutput.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleMessage(line);
      }
      newlineIndex = this.bufferedOutput.indexOf("\n");
    }
  }

  private normalizeEvent(message: ProcessorTransportMessage): NormalizedWorkerEvent | null {
    if (message.type === "HEALTH_STATUS") {
      return null;
    }

    const payload = message.payload ?? {};
    return {
      type: message.type as NormalizedWorkerEvent["type"],
      requestId: message.request_id ?? null,
      jobId: message.job_id ?? null,
      stage: typeof payload.stage === "string" ? payload.stage : null,
      percentComplete:
        typeof payload.percent === "number"
          ? payload.percent
          : message.type === "JOB_COMPLETED"
            ? 100
            : 0,
      message: typeof payload.message === "string" ? payload.message : typeof payload.summary === "string" ? payload.summary : null,
      manifest: (payload.manifest ?? {}) as RawProcessorManifest,
      details: (payload.details ?? {}) as Record<string, unknown>,
    };
  }

  private handleMessage(line: string): void {
    const parsed = JSON.parse(line) as ProcessorTransportMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === "HEALTH_STATUS") {
      const requestId = parsed.request_id ?? "";
      const pending = this.pendingResponses.get(requestId);
      if (pending?.kind === "health") {
        const payload = parsed.payload ?? {};
        pending.resolve({
          healthy: Boolean(payload.healthy),
          details: {
            ...(payload.details ?? {}),
          },
        } satisfies ProcessorHealthResponse);
        this.pendingResponses.delete(requestId);
      }
      return;
    }

    const normalized = this.normalizeEvent(parsed);
    if (!normalized) {
      return;
    }

    const requestId = normalized.requestId ?? "";
    const pending = this.pendingResponses.get(requestId);
    if (pending?.kind === "process" && normalized.type === "JOB_COMPLETED") {
      pending.resolve(normalized);
      this.pendingResponses.delete(requestId);
    } else if (pending?.kind === "process" && normalized.type === "JOB_FAILED") {
      pending.resolve(normalized);
      this.pendingResponses.delete(requestId);
    } else if (pending?.kind === "cancel" && normalized.type === "JOB_PROGRESS" && normalized.stage === "cancel") {
      pending.resolve(undefined);
      this.pendingResponses.delete(requestId);
    }

    this.emit("event", normalized);
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Worker process is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async request<TResponse>(kind: PendingRequest["kind"], payload: Record<string, unknown>): Promise<TResponse> {
    await this.ensureStarted();
    if (!this.process) {
      return Promise.reject(new Error("Processor worker is not available"));
    }

    const requestId = crypto.randomUUID();
    const message = { ...payload, request_id: requestId };
    return await new Promise<TResponse>((resolve, reject) => {
      this.pendingResponses.set(requestId, { kind, resolve, reject });
      try {
        this.sendMessage(message);
      } catch (error) {
        this.pendingResponses.delete(requestId);
        reject(error);
      }
    });
  }

  async healthCheck(): Promise<ProcessorHealthResponse> {
    try {
      const response = await this.request<ProcessorHealthResponse>("health", { type: "HEALTH_CHECK" });
      const supplementalDetails = await this.buildSupplementalHealthDetails();
      return {
        healthy: response.healthy,
        details: {
          ...response.details,
          ...supplementalDetails,
        },
      };
    } catch (error) {
      const supplementalDetails = await this.buildSupplementalHealthDetails();
      return {
        healthy: false,
        details: {
          message: safeErrorMessage(error),
          ...supplementalDetails,
        },
      };
    }
  }

  async prepareRuntime(options?: { force?: boolean; preloadTranscriptionModel?: boolean }): Promise<ProcessorHealthResponse> {
    const force = Boolean(options?.force);
    const preloadTranscriptionModel = Boolean(options?.preloadTranscriptionModel);
    this.shutdown();
    this.bootstrapPromise = null;
    await this.ensureBootstrappedInternal(force);
    if (preloadTranscriptionModel) {
      await this.preloadTranscriptionModel();
      this.bootstrapStatus = "ready";
      this.bootstrapMessage = "Processor runtime and transcription model cache are ready.";
    }
    return await this.healthCheck();
  }

  async processTrack(job: ProcessingJob, song: SongRecord, options: ProcessTrackOptions): Promise<void> {
    await this.request("process", {
      type: "PROCESS_TRACK",
      job_id: job.id,
      source_path: song.sourcePath,
      workspace_root: this.directories.baseDir,
      source_id: song.sourceId,
      pipeline_version: options.pipelineVersion,
      language: song.language,
      preferred_models: {
        transcription: "base",
      },
    });
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.request("cancel", { type: "CANCEL_JOB", job_id: jobId });
  }

  shutdown(): void {
    this.pendingResponses.clear();
    this.bufferedOutput = "";
    this.ready = false;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fsPromises.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
