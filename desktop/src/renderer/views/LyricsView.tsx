import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { formatDuration } from "../lib/format";
import type { EditableLyricLine, KaraokeApi, PlaybackPayload, SongRecord } from "../types/electron-api";

export interface LyricsViewProps {
  api: KaraokeApi;
  song: SongRecord | null;
  playback: PlaybackPayload | null;
  onPlaybackChange: (playback: PlaybackPayload | null) => void;
  onEnsurePlayback: (songId: string) => Promise<PlaybackPayload | null>;
  onOpenPlayer: (songId: string) => Promise<void>;
}

function cloneLines(lines: EditableLyricLine[]): EditableLyricLine[] {
  return lines.map((line) => ({ ...line }));
}

function formatSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2);
}

function parseSeconds(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 1000);
}

export function LyricsView({
  api,
  song,
  playback,
  onPlaybackChange,
  onEnsurePlayback,
  onOpenPlayer,
}: LyricsViewProps) {
  const [draftLines, setDraftLines] = useState<EditableLyricLine[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (song && (!playback || playback.song.id !== song.id)) {
      void onEnsurePlayback(song.id);
    }
  }, [onEnsurePlayback, playback, song]);

  useEffect(() => {
    setDraftLines(cloneLines(playback?.editableLyricLines ?? []));
    setError(null);
    setMessage(null);
  }, [playback?.song.id, playback?.hasLyricOverrides]);

  if (!song) {
    return (
      <section className="panel">
        <EmptyState title="No song selected" description="Choose a processed song to edit its saved lyric timing." />
      </section>
    );
  }

  const canEdit = Boolean(playback);

  const updateLine = (index: number, patch: Partial<EditableLyricLine>) => {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index
          ? {
              ...line,
              ...patch,
            }
          : line,
      ),
    );
  };

  const addLine = () => {
    const lastLine = draftLines[draftLines.length - 1];
    const nextStartMs = lastLine ? lastLine.endMs + 250 : 0;
    setDraftLines((current) => [
      ...current,
      {
        index: current.length,
        text: "New lyric line",
        startMs: nextStartMs,
        endMs: nextStartMs + 2000,
      },
    ]);
  };

  const removeLine = (index: number) => {
    setDraftLines((current) =>
      current.filter((_line, lineIndex) => lineIndex !== index).map((line, lineIndex) => ({ ...line, index: lineIndex })),
    );
  };

  const save = async () => {
    if (!song) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const normalized = draftLines
        .map((line, index) => ({
          index,
          text: line.text.trim(),
          startMs: Math.max(0, line.startMs),
          endMs: Math.max(line.startMs + 50, line.endMs),
        }))
        .filter((line) => line.text.length > 0);
      const nextPlayback = await api.saveLyrics(song.id, normalized);
      onPlaybackChange(nextPlayback);
      setDraftLines(cloneLines(nextPlayback?.editableLyricLines ?? normalized));
      setMessage("Lyric edits saved locally.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save lyric edits.");
    } finally {
      setIsSaving(false);
    }
  };

  const reset = async () => {
    if (!song) {
      return;
    }

    setIsResetting(true);
    setError(null);
    setMessage(null);
    try {
      const nextPlayback = await api.resetLyrics(song.id);
      onPlaybackChange(nextPlayback);
      setDraftLines(cloneLines(nextPlayback?.editableLyricLines ?? []));
      setMessage("Lyric edits reset to the generated transcript.");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Unable to reset lyric edits.");
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <section className="panel lyrics-editor-panel">
      <div className="section-heading">
        <div>
          <h2>Lyric Editor</h2>
          <p>
            Correct transcript lines and timing locally for {song.title}. Saved edits are reused the next time you sing.
          </p>
        </div>
        <div className="inline-controls">
          <StatusPill tone={playback?.hasLyricOverrides ? "warning" : "info"}>
            {playback?.hasLyricOverrides ? "edited lyrics" : "generated lyrics"}
          </StatusPill>
          <button type="button" onClick={() => void onOpenPlayer(song.id)} disabled={!canEdit}>
            Open player
          </button>
        </div>
      </div>

      <div className="lyrics-editor-summary">
        <div className="session-chip">
          <span>Song</span>
          <strong>{song.title}</strong>
        </div>
        <div className="session-chip">
          <span>Duration</span>
          <strong>{formatDuration(song.durationMs, { unit: "milliseconds" })}</strong>
        </div>
        <div className="session-chip">
          <span>Lines</span>
          <strong>{draftLines.length}</strong>
        </div>
      </div>

      {!canEdit ? (
        <EmptyState title="Playback data loading" description="We’re preparing the lyric data for this song." />
      ) : (
        <>
          <div className="lyrics-editor-actions">
            <button type="button" onClick={addLine}>
              Add line
            </button>
            <button type="button" onClick={() => void save()} className="primary" disabled={isSaving || draftLines.length === 0}>
              {isSaving ? "Saving..." : "Save edits"}
            </button>
            <button type="button" onClick={() => void reset()} disabled={isResetting}>
              {isResetting ? "Resetting..." : "Reset to generated"}
            </button>
          </div>

          {message ? <div className="editor-banner is-success">{message}</div> : null}
          {error ? <div className="editor-banner is-error">{error}</div> : null}

          <div className="lyrics-editor-list">
            {draftLines.map((line, index) => (
              <article key={`${line.index}-${index}`} className="lyrics-edit-row">
                <div className="lyrics-edit-row-header">
                  <strong>Line {index + 1}</strong>
                  <button type="button" className="ghost-link" onClick={() => removeLine(index)}>
                    Remove
                  </button>
                </div>
                <label className="field">
                  <span>Text</span>
                  <input
                    type="text"
                    value={line.text}
                    onChange={(event) => updateLine(index, { text: event.target.value })}
                  />
                </label>
                <div className="lyrics-edit-timing">
                  <label className="field">
                    <span>Start (seconds)</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={formatSeconds(line.startMs)}
                      onChange={(event) => updateLine(index, { startMs: parseSeconds(event.target.value) })}
                    />
                  </label>
                  <label className="field">
                    <span>End (seconds)</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={formatSeconds(line.endMs)}
                      onChange={(event) => updateLine(index, { endMs: parseSeconds(event.target.value) })}
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
