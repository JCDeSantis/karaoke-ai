import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import { useFullscreenToggle } from "../hooks/useFullscreenToggle";
import { clamp, formatDuration, pickCurrentLine, resolveAudioSource, resolveMediaSource } from "../lib/format";
import type { LyricLine, LyricWord, PlaybackPayload, SongRecord } from "../types/electron-api";

export interface PlayerViewProps {
  song: SongRecord | null;
  playback: PlaybackPayload | null;
}

function deriveLines(playback: PlaybackPayload | null): LyricLine[] {
  const directLines = playback?.lyricLines ?? [];
  if (directLines.length > 0) {
    return directLines;
  }

  const words = playback?.lyricWords ?? [];
  if (words.length === 0) {
    return [];
  }

  return [
    {
      index: 0,
      text: words.map((word) => word.text).join(" "),
      startMs: words[0].startMs,
      endMs: words[words.length - 1].endMs,
      wordStartIndex: 0,
      wordEndIndex: words.length - 1,
    },
  ];
}

function getLineWords(line: LyricLine, allWords: LyricWord[]): LyricWord[] {
  const slice = allWords.slice(line.wordStartIndex, line.wordEndIndex + 1);
  if (slice.length > 0) {
    return slice;
  }

  return line.text
    .split(/\s+/)
    .filter(Boolean)
    .map((text, index) => ({ index, text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
}

function getLineProgress(line: LyricLine | null, currentTimeSeconds: number): number {
  if (!line) {
    return 0;
  }

  const durationMs = Math.max(line.endMs - line.startMs, 1);
  return clamp(((currentTimeSeconds * 1000) - line.startMs) / durationMs, 0, 1);
}

function getCueLabel(nextLine: LyricLine | null, currentTimeSeconds: number): string {
  if (!nextLine) {
    return "No upcoming cue";
  }

  const secondsUntil = Math.ceil((nextLine.startMs / 1000) - currentTimeSeconds);
  if (secondsUntil <= 0) {
    return "Cue live";
  }
  if (secondsUntil === 1) {
    return "Cue in 1 second";
  }
  return `Cue in ${secondsUntil} seconds`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

function syncGuideAudio(
  audio: HTMLAudioElement | null,
  guide: HTMLAudioElement | null,
  options: {
    enabled: boolean;
    source?: string;
    volume: number;
    playbackRate: number;
  },
): void {
  if (!audio || !guide || !options.source) {
    return;
  }

  guide.volume = options.enabled ? options.volume : 0;
  guide.playbackRate = options.playbackRate;

  if (!options.enabled) {
    if (!guide.paused) {
      guide.pause();
    }
    return;
  }

  const drift = Math.abs(audio.currentTime - guide.currentTime);
  if (drift > 0.2 || guide.ended) {
    guide.currentTime = audio.currentTime;
  }

  if (audio.paused) {
    if (!guide.paused) {
      guide.pause();
    }
    return;
  }

  if (guide.paused) {
    void guide.play().catch(() => {});
  }
}

export function PlayerView({ song, playback }: PlayerViewProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const guideAudioRef = useRef<HTMLAudioElement | null>(null);
  const hideControlsTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioSource, setAudioSource] = useState<string | undefined>();
  const [guideSource, setGuideSource] = useState<string | undefined>();
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [performanceMode, setPerformanceMode] = useState(true);
  const [guideEnabled, setGuideEnabled] = useState(false);
  const [instrumentalVolume, setInstrumentalVolume] = useState(1);
  const [guideVolume, setGuideVolume] = useState(0.25);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [lyricScale, setLyricScale] = useState(1);
  const [loopLinePosition, setLoopLinePosition] = useState<number | null>(null);
  const [stageControlsVisible, setStageControlsVisible] = useState(true);
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false);
  const [stageTheme, setStageTheme] = useState<"neon" | "sunset" | "ice">("neon");
  const { isFullscreen, toggleFullscreen } = useFullscreenToggle();

  const lines = useMemo(() => deriveLines(playback), [playback]);
  const words = playback?.lyricWords ?? [];
  const activeLineIndex = pickCurrentLine(lines, currentTime);
  const previousLine = activeLineIndex > 0 ? lines[activeLineIndex - 1] : null;
  const activeLine = activeLineIndex >= 0 ? lines[activeLineIndex] : null;
  const queuedLines = activeLineIndex >= 0 ? lines.slice(activeLineIndex + 1, activeLineIndex + 3) : lines.slice(0, 2);
  const nextLine = queuedLines[0] ?? null;
  const activeWords = activeLine ? getLineWords(activeLine, words) : [];
  const lineProgress = getLineProgress(activeLine, currentTime);
  const songProgress = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const hasGuideTrack = Boolean(playback?.artifactManifest?.vocalsPath);
  const cueLabel = getCueLabel(nextLine, currentTime);
  const loopedLine = loopLinePosition != null ? lines[loopLinePosition] ?? null : null;
  const stageMode = isFullscreen && performanceMode;
  const cueSecondsRemaining = nextLine ? Math.ceil((nextLine.startMs / 1000) - currentTime) : null;
  const stageCueVisible = stageMode && nextLine != null && cueSecondsRemaining != null && cueSecondsRemaining > 0 && cueSecondsRemaining <= 5;

  const jumpToLine = (line: LyricLine | null, preRollSeconds = 0.35) => {
    if (!line) {
      return;
    }

    handleSeek(Math.max((line.startMs / 1000) - preRollSeconds, 0));
  };

  const scheduleStageControlsHide = () => {
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current);
    }

    if (!stageMode) {
      setStageControlsVisible(true);
      return;
    }

    setStageControlsVisible(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      setStageControlsVisible(false);
    }, 2200);
  };

  useEffect(() => {
    setAudioSource(resolveAudioSource(playback));
    setGuideSource(resolveMediaSource(playback?.artifactManifest?.vocalsPath));
    setCurrentTime(0);
    setDuration((song?.durationMs ?? 0) / 1000);
    setPlaybackError(null);
    setLoopLinePosition(null);
    setGuideEnabled(Boolean(playback?.artifactManifest?.vocalsPath));
  }, [playback, song]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.volume = instrumentalVolume;
    audio.playbackRate = playbackRate;
  }, [instrumentalVolume, playbackRate, audioSource]);

  useEffect(() => {
    const guide = guideAudioRef.current;
    if (!guide) {
      return;
    }

    guide.volume = guideEnabled ? guideVolume : 0;
    guide.playbackRate = playbackRate;
  }, [guideEnabled, guideVolume, playbackRate, guideSource]);

  useEffect(() => {
    scheduleStageControlsHide();
    return () => {
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [stageMode]);

  useEffect(() => {
    if (loopLinePosition == null) {
      return;
    }

    if (!lines[loopLinePosition]) {
      setLoopLinePosition(null);
    }
  }, [lines, loopLinePosition]);

  const syncFromAudio = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    setCurrentTime(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : (song?.durationMs ?? 0) / 1000);
    setIsPlaying(!audio.paused);
    syncGuideAudio(audio, guideAudioRef.current, {
      enabled: guideEnabled,
      source: guideSource,
      volume: guideVolume,
      playbackRate,
    });
  };

  const handleSeek = (nextTime: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const resolvedTime = clamp(nextTime, 0, duration || audio.duration || nextTime);
    audio.currentTime = resolvedTime;
    if (guideAudioRef.current) {
      guideAudioRef.current.currentTime = resolvedTime;
    }
    syncFromAudio();
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !audioSource) {
      return;
    }

    if (audio.paused) {
      try {
        setPlaybackError(null);
        await audio.play();
        scheduleStageControlsHide();
        syncGuideAudio(audio, guideAudioRef.current, {
          enabled: guideEnabled,
          source: guideSource,
          volume: guideVolume,
          playbackRate,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Playback failed to start.";
        setPlaybackError(message);
        setIsPlaying(false);
        return;
      }
    } else {
      audio.pause();
      if (guideAudioRef.current && !guideAudioRef.current.paused) {
        guideAudioRef.current.pause();
      }
    }

    syncFromAudio();
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const handleTimeUpdate = () => syncFromAudio();
    const handleLoaded = () => syncFromAudio();
    const handleEnded = () => {
      setIsPlaying(false);
      setLoopLinePosition(null);
      if (guideAudioRef.current) {
        guideAudioRef.current.pause();
        guideAudioRef.current.currentTime = 0;
      }
    };
    const handleError = () => {
      const mediaError = audio.error;
      const message = mediaError?.message || "The selected audio file could not be played.";
      setPlaybackError(message);
      setIsPlaying(false);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("durationchange", handleLoaded);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("durationchange", handleLoaded);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [song, audioSource, guideEnabled, guideSource, guideVolume, playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;
    const guide = guideAudioRef.current;
    if (!audio || !guide || !guideSource) {
      return;
    }

    syncGuideAudio(audio, guide, {
      enabled: guideEnabled,
      source: guideSource,
      volume: guideVolume,
      playbackRate,
    });
  }, [guideEnabled, guideVolume, guideSource, isPlaying, playbackRate]);

  useEffect(() => {
    if (!isPlaying || !loopedLine) {
      return;
    }

    const loopEndSeconds = (loopedLine.endMs + 120) / 1000;
    if (currentTime >= loopEndSeconds) {
      handleSeek(Math.max((loopedLine.startMs / 1000) - 0.25, 0));
    }
  }, [currentTime, isPlaying, loopedLine]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!song || isEditableTarget(event.target)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
        return;
      }

      if (event.code === "ArrowRight") {
        event.preventDefault();
        handleSeek(currentTime + 5);
        return;
      }

      if (event.code === "ArrowLeft") {
        event.preventDefault();
        handleSeek(Math.max(currentTime - 5, 0));
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }

      if (event.key.toLowerCase() === "m" && hasGuideTrack) {
        event.preventDefault();
        setGuideEnabled((current) => !current);
        return;
      }

      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        setLoopLinePosition((current) => (current != null ? null : activeLineIndex >= 0 ? activeLineIndex : null));
        return;
      }

      if (event.code === "ArrowUp") {
        event.preventDefault();
        jumpToLine(previousLine ?? activeLine);
        return;
      }

      if (event.code === "ArrowDown") {
        event.preventDefault();
        jumpToLine(nextLine ?? activeLine);
        return;
      }

      if (event.key.toLowerCase() === "h" && stageMode) {
        event.preventDefault();
        setStageControlsVisible((current) => !current);
        return;
      }

      if ((event.key === "/" || event.key === "?") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShowShortcutOverlay((current) => !current);
        return;
      }

      if (event.key === "Escape" && showShortcutOverlay) {
        event.preventDefault();
        setShowShortcutOverlay(false);
        return;
      }

      if (event.key === "[" || event.key === "{") {
        event.preventDefault();
        setPlaybackRate((current) => clamp(Number((current - 0.05).toFixed(2)), 0.75, 1.25));
        return;
      }

      if (event.key === "]" || event.key === "}") {
        event.preventDefault();
        setPlaybackRate((current) => clamp(Number((current + 0.05).toFixed(2)), 0.75, 1.25));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeLineIndex, currentTime, hasGuideTrack, nextLine, previousLine, showShortcutOverlay, song, stageMode, toggleFullscreen]);

  if (!song) {
    return (
      <section className="panel">
        <EmptyState title="No song selected" description="Choose a ready track from the library to start singing." />
      </section>
    );
  }

  return (
    <section
      className={[
        "panel",
        "player-panel",
        isFullscreen ? "is-fullscreen" : "",
        performanceMode ? "is-performance" : "",
        stageMode && !stageControlsVisible ? "stage-controls-hidden" : "",
        `theme-${stageTheme}`,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ ["--player-lyric-scale" as "--player-lyric-scale"]: String(lyricScale) }}
      onMouseMove={() => scheduleStageControlsHide()}
      onClick={() => {
        if (stageMode && !stageControlsVisible) {
          scheduleStageControlsHide();
        }
      }}
    >
      <div className="section-heading player-heading">
        <div>
          <div className="eyebrow">Singer mode</div>
          <h2>{song.title}</h2>
          <p>
            {song.artist ?? "Unknown artist"} - {formatDuration(song.durationMs, { unit: "milliseconds" })}
          </p>
        </div>
        <div className="inline-controls player-heading-actions">
          <StatusPill tone={song.status === "ready" ? "success" : "warning"}>{song.status}</StatusPill>
          <StatusPill tone="info">{cueLabel}</StatusPill>
          <StatusPill tone={loopedLine ? "warning" : "neutral"}>{loopedLine ? "looping line" : "free run"}</StatusPill>
          <StatusPill tone={hasGuideTrack ? "success" : "neutral"}>{hasGuideTrack ? "dual track ready" : "instrumental only"}</StatusPill>
          <button
            type="button"
            onClick={() =>
              setStageTheme((current) => (current === "neon" ? "sunset" : current === "sunset" ? "ice" : "neon"))
            }
          >
            Theme: {stageTheme}
          </button>
          <button type="button" onClick={() => setShowShortcutOverlay((current) => !current)}>
            {showShortcutOverlay ? "Hide shortcuts" : "Shortcuts"}
          </button>
          <button type="button" onClick={() => setPerformanceMode((current) => !current)}>
            {performanceMode ? "Edit layout" : "Performance mode"}
          </button>
          <button type="button" onClick={() => void toggleFullscreen()}>
            {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </div>
      </div>

      <audio
        ref={audioRef}
        src={audioSource}
        preload="metadata"
        onLoadedMetadata={syncFromAudio}
        onTimeUpdate={syncFromAudio}
        onPlay={syncFromAudio}
        onPause={syncFromAudio}
      />
      <audio ref={guideAudioRef} src={guideSource} preload="metadata" />

      {stageCueVisible && nextLine ? (
        <div className="stage-cue-overlay">
          <div className="stage-cue-badge">{cueSecondsRemaining}</div>
          <div className="stage-cue-copy">
            <span>Next line</span>
            <strong>{nextLine.text}</strong>
          </div>
        </div>
      ) : null}

      {stageMode && !stageControlsVisible ? (
        <div className="stage-hint-overlay">Move the mouse or press `H` to show controls.</div>
      ) : null}

      <div className="player-stage">
        <div className="lyrics-card performer-card">
          <div className="performer-meta">
            <div>
              <div className="lyrics-label">Song progress</div>
              <div className="transport-time">
                <span>{formatDuration(currentTime)}</span>
                <span>{formatDuration(duration)}</span>
              </div>
            </div>
            <div className="line-progress-shell song-progress-shell">
              <span className="line-progress-fill" style={{ width: `${songProgress * 100}%` }} />
            </div>
          </div>

          <div className="lyrics-context">
            <div className="lyrics-label">Previous</div>
            <div className="lyrics-line previous-line">{previousLine ? previousLine.text : " "}</div>
          </div>

          <div className={`lyrics-focus-card ${loopedLine ? "is-looping" : ""}`}>
            <div className="focus-header">
              <div className="lyrics-label">Now singing</div>
              {loopedLine ? <div className="loop-badge">Rehearsal loop</div> : null}
            </div>
            <div className="lyrics-line current">{activeLine ? activeLine.text : "Waiting for lyric data..."}</div>
            <div className="line-progress-shell">
              <span className="line-progress-fill" style={{ width: `${lineProgress * 100}%` }} />
            </div>
            <div className="word-strip">
              {activeWords.length > 0 ? (
                activeWords.map((word, index) => {
                  const nowMs = currentTime * 1000;
                  const tone = nowMs >= word.endMs ? "is-complete" : nowMs >= word.startMs ? "is-active" : "is-upcoming";
                  return (
                    <span key={`${word.text}-${index}`} className={`word-chip ${tone}`}>
                      {word.text}
                    </span>
                  );
                })
              ) : (
                <span className="word-chip is-upcoming">Waiting for aligned words...</span>
              )}
            </div>
          </div>

          <div className="lyrics-queue">
            <div className="lyrics-label next">Up next</div>
            {queuedLines.length > 0 ? (
              queuedLines.map((line, index) => (
                <div key={`${line.index}-${index}`} className={`lyrics-line ${index === 0 ? "next-line" : "future-line"}`}>
                  {line.text}
                </div>
              ))
            ) : (
              <div className="lyrics-line next-line">No upcoming line available.</div>
            )}
          </div>
        </div>

        <div className="transport-card control-card">
          <div className="control-cluster">
            <div className="lyrics-label">Transport</div>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0)}
              step={0.01}
              value={Math.min(currentTime, duration || currentTime)}
              onChange={(event) => handleSeek(Number(event.target.value))}
            />
            <div className="inline-controls transport-actions">
              <button type="button" onClick={() => handleSeek(Math.max(currentTime - 10, 0))}>
                -10s
              </button>
              <button type="button" className="primary" onClick={() => void togglePlayback()}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button type="button" onClick={() => handleSeek(0)}>
                Restart
              </button>
              <button type="button" onClick={() => handleSeek(currentTime + 10)}>
                +10s
              </button>
            </div>
          </div>

          <div className="control-cluster rehearsal-card">
            <div className="lyrics-label">Rehearsal</div>
            <div className="performance-meta-row">
              <StatusPill tone={loopedLine ? "warning" : "neutral"}>{loopedLine ? "current line looping" : "loop off"}</StatusPill>
              <button
                type="button"
                onClick={() => setLoopLinePosition((current) => (current != null ? null : activeLineIndex >= 0 ? activeLineIndex : null))}
                disabled={activeLineIndex < 0}
              >
                {loopedLine ? "Stop loop" : "Loop current line"}
              </button>
            </div>
            <div className="list-card-meta">
              Replays the active lyric line with a short pre-roll so you can practice a difficult phrase.
            </div>
            <div className="inline-controls transport-actions">
              <button type="button" onClick={() => jumpToLine(previousLine ?? activeLine)} disabled={!previousLine && !activeLine}>
                Prev line
              </button>
              <button type="button" onClick={() => jumpToLine(activeLine)} disabled={!activeLine}>
                Replay line
              </button>
              <button type="button" onClick={() => jumpToLine(nextLine ?? activeLine)} disabled={!nextLine && !activeLine}>
                Next line
              </button>
            </div>
          </div>

          <div className="control-cluster mixer-card">
            <div className="lyrics-label">Mix</div>
            <label className="slider-field">
              <span>Instrumental volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={instrumentalVolume}
                onChange={(event) => setInstrumentalVolume(Number(event.target.value))}
              />
            </label>

            <div className="guide-toggle-row">
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={guideEnabled}
                  disabled={!hasGuideTrack}
                  onChange={(event) => setGuideEnabled(event.target.checked)}
                />
                <span>Guide vocal track</span>
              </label>
              <StatusPill tone={hasGuideTrack ? "success" : "neutral"}>{hasGuideTrack ? "isolated" : "missing"}</StatusPill>
            </div>

            <label className="slider-field">
              <span>Guide vocal volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={guideVolume}
                disabled={!hasGuideTrack || !guideEnabled}
                onChange={(event) => setGuideVolume(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="control-cluster performance-controls">
            <div className="lyrics-label">Performance controls</div>
            <label className="slider-field">
              <span>Tempo</span>
              <input
                type="range"
                min={0.75}
                max={1.25}
                step={0.01}
                value={playbackRate}
                onChange={(event) => setPlaybackRate(Number(event.target.value))}
              />
            </label>
            <div className="performance-meta-row">
              <StatusPill tone="info">{playbackRate.toFixed(2)}x</StatusPill>
              <button type="button" onClick={() => setPlaybackRate(1)}>
                Reset tempo
              </button>
            </div>

            <label className="slider-field">
              <span>Lyric size</span>
              <input
                type="range"
                min={0.85}
                max={1.4}
                step={0.01}
                value={lyricScale}
                onChange={(event) => setLyricScale(Number(event.target.value))}
              />
            </label>
            <div className="performance-meta-row">
              <StatusPill tone="info">{Math.round(lyricScale * 100)}%</StatusPill>
              <button type="button" onClick={() => setLyricScale(1)}>
                Reset size
              </button>
            </div>
          </div>

          <div className="control-cluster upcoming-card">
            <div className="lyrics-label">Session</div>
            <div className="session-grid">
              <div className="session-chip">
                <span>Lines</span>
                <strong>{lines.length}</strong>
              </div>
              <div className="session-chip">
                <span>Words</span>
                <strong>{words.length}</strong>
              </div>
              <div className="session-chip">
                <span>Next cue</span>
                <strong>{nextLine ? formatDuration(nextLine.startMs / 1000) : "--:--"}</strong>
              </div>
            </div>
            <div className="shortcut-hint-list">
              <span>`Space` play/pause</span>
              <span>`Left/Right` seek 5s</span>
              <span>`[` / `]` tempo</span>
              <span>`Up/Down` line jump</span>
              <span>`L` line loop</span>
              <span>`H` hide controls</span>
              <span>`M` guide vocals</span>
              <span>`F` fullscreen</span>
            </div>
          </div>

          {playbackError ? <p className="transport-error">{playbackError}</p> : null}
        </div>
      </div>

      {showShortcutOverlay ? (
        <div className="shortcut-overlay" role="dialog" aria-label="Player shortcuts">
          <div className="shortcut-overlay-card">
            <div className="shortcut-overlay-header">
              <div>
                <div className="lyrics-label">Performance shortcuts</div>
                <h3>Keyboard guide</h3>
              </div>
              <button type="button" onClick={() => setShowShortcutOverlay(false)}>
                Close
              </button>
            </div>
            <div className="shortcut-overlay-grid">
              <div className="shortcut-overlay-item">
                <strong>Space</strong>
                <span>Play or pause</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>Left / Right</strong>
                <span>Seek 5 seconds</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>[ / ]</strong>
                <span>Change tempo</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>Up / Down</strong>
                <span>Jump between lyric lines</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>L</strong>
                <span>Loop the current line</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>M</strong>
                <span>Toggle guide vocals</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>H</strong>
                <span>Hide or show stage controls</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>F</strong>
                <span>Toggle fullscreen</span>
              </div>
              <div className="shortcut-overlay-item">
                <strong>/</strong>
                <span>Open this overlay</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
