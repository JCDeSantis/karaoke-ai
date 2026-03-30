import { spawn } from "node:child_process";

export async function probeDurationMs(filePath: string): Promise<number | null> {
  const ffprobeCommand = process.env.KARAOKEAI_FFPROBE_PATH ?? "ffprobe";

  return await new Promise<number | null>((resolve) => {
    const child = spawn(ffprobeCommand, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
        const durationSeconds = Number(parsed.format?.duration ?? "");
        resolve(Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null);
      } catch {
        resolve(null);
      }
    });
  });
}
