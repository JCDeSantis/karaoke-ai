import type { LyricLine, LyricWord, PlaybackPayload, SongRecord } from "../types/electron-api";

export function formatDuration(input?: number | null, options?: { unit?: "seconds" | "milliseconds" }): string {
  if (input == null || !Number.isFinite(input) || input < 0) {
    return "--:--";
  }

  const seconds = options?.unit === "milliseconds" ? input / 1000 : input;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remaining = wholeSeconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function formatTimestamp(value?: string): string {
  if (!value) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSongSubtitle(song: SongRecord): string {
  const details = [song.artist, song.language].filter(Boolean);
  if (details.length === 0) {
    return song.sourceType === "local_file" ? "Local file" : "Ready for processing";
  }

  return details.join(" - ");
}

export function resolveMediaSource(candidate?: string | null): string | undefined {
  if (!candidate) {
    return undefined;
  }

  if (/^https?:\/\//i.test(candidate) || candidate.startsWith("file:")) {
    return candidate;
  }
  return `karaoke-media://local/audio?path=${encodeURIComponent(candidate)}`;
}

export function resolveAudioSource(playback: PlaybackPayload | null): string | undefined {
  return resolveMediaSource(playback?.primaryAudioPath ?? playback?.song.sourcePath ?? undefined);
}

export function pickCurrentLine(lines: LyricLine[], currentTimeSeconds: number): number {
  if (lines.length === 0) {
    return -1;
  }

  const nowMs = currentTimeSeconds * 1000;
  let active = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (nowMs >= lines[index].startMs) {
      active = index;
    }
    if (nowMs < lines[index].startMs) {
      break;
    }
  }

  return active;
}

export function pickActiveWord(words: LyricWord[], currentTimeSeconds: number): number {
  if (words.length === 0) {
    return -1;
  }

  const nowMs = currentTimeSeconds * 1000;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (nowMs >= word.startMs && nowMs <= word.endMs) {
      return index;
    }
  }

  return nowMs < words[0].startMs ? 0 : words.length - 1;
}
