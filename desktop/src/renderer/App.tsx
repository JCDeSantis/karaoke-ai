import { useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { formatDuration, formatTimestamp, getSongSubtitle } from "./lib/format";
import { useKaraokeData } from "./hooks/useKaraokeData";
import { ImportView } from "./views/ImportView";
import { LibraryView } from "./views/LibraryView";
import { LyricsView } from "./views/LyricsView";
import { PlayerView } from "./views/PlayerView";
import { QueueView } from "./views/QueueView";
import { SettingsView } from "./views/SettingsView";
import type { SongRecord, ViewId } from "./types/electron-api";

function Header({ selectedSong }: { selectedSong: SongRecord | null }) {
  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">Windows karaoke workstation</div>
        <h1>Sing with synced lyrics and local AI processing.</h1>
      </div>
      <div className="song-summary">
        {selectedSong ? (
          <>
            <div className="song-summary-title">{selectedSong.title}</div>
            <div className="song-summary-meta">
              {getSongSubtitle(selectedSong)} - {formatDuration(selectedSong.durationMs, { unit: "milliseconds" })}
            </div>
            <div className="song-summary-meta">Updated {formatTimestamp(selectedSong.updatedAt ?? selectedSong.createdAt)}</div>
          </>
        ) : (
          <EmptyState title="No song selected" description="Open a track from the library or import a new one." />
        )}
      </div>
    </header>
  );
}

export function App() {
  const {
    songs,
    jobs,
    health,
    appStatus,
    appDataPath,
    playback,
    selectedSongId,
    setSelectedSongId,
    setPlayback,
    refreshSongs,
    refreshJobs,
    refreshHealth,
    refreshAppDataPath,
    loadPlayback,
    prepareRuntime,
    api,
  } = useKaraokeData();
  const [activeView, setActiveView] = useState<ViewId>("library");

  const selectedSong = songs.find((song) => song.id === selectedSongId) ?? songs[0] ?? null;

  const showPlayerForSong = async (songId: string) => {
    if (!songId) {
      return;
    }

    setSelectedSongId(songId);
    await loadPlayback(songId);
    setActiveView("player");
  };

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} onChange={setActiveView} />
      <main className="main-column">
        <Header selectedSong={selectedSong} />
        <div className="content-area">
          {activeView === "library" ? (
            <LibraryView
              api={api}
              songs={songs}
              selectedSongId={selectedSong?.id ?? null}
              onSelectSong={(songId) => {
                setSelectedSongId(songId);
              }}
              onOpenPlayer={showPlayerForSong}
              onRefresh={refreshSongs}
            />
          ) : null}
          {activeView === "import" ? <ImportView api={api} songs={songs} onSongsChanged={refreshSongs} /> : null}
          {activeView === "queue" ? <QueueView api={api} jobs={jobs} onRefresh={async () => { await Promise.all([refreshJobs(), refreshSongs()]); }} /> : null}
          {activeView === "player" ? <PlayerView playback={playback} song={selectedSong} /> : null}
          {activeView === "lyrics" ? (
            <LyricsView
              api={api}
              song={selectedSong}
              playback={playback}
              onPlaybackChange={setPlayback}
              onEnsurePlayback={loadPlayback}
              onOpenPlayer={showPlayerForSong}
            />
          ) : null}
          {activeView === "settings" ? (
            <SettingsView
              appDataPath={appDataPath}
              appStatus={appStatus}
              health={health}
              onPrepareRuntime={async (options) => {
                await prepareRuntime(options);
                await refreshAppDataPath();
              }}
              onRefresh={async () => {
                await Promise.all([refreshHealth(), refreshAppDataPath(), refreshJobs()]);
              }}
            />
          ) : null}
        </div>

        <footer className="status-bar">
          <span>{songs.length} songs</span>
          <span>{jobs.length} jobs</span>
          <span>{appDataPath ?? "App data pending"}</span>
          <button
            type="button"
            className="ghost-link"
            onClick={() => {
              void showPlayerForSong(selectedSong?.id ?? songs[0]?.id ?? "");
            }}
          >
            Focus player
          </button>
        </footer>
      </main>
    </div>
  );
}
