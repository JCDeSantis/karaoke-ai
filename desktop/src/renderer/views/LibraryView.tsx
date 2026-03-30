import { EmptyState } from '../components/EmptyState';
import { StatusPill } from '../components/StatusPill';
import { formatDuration, getSongSubtitle } from '../lib/format';
import type { KaraokeApi, SongRecord } from '../types/electron-api';

export interface LibraryViewProps {
  api: KaraokeApi;
  songs: SongRecord[];
  selectedSongId: string | null;
  onSelectSong: (songId: string) => void;
  onOpenPlayer: (songId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function LibraryView({ api, songs, selectedSongId, onSelectSong, onOpenPlayer, onRefresh }: LibraryViewProps) {
  const handleProcess = async (songId: string) => {
    await api.enqueueProcessing(songId);
    await onRefresh();
  };

  const handleOpenPlayer = async (songId: string) => {
    onSelectSong(songId);
    await onOpenPlayer(songId);
  };

  const handleDelete = async (song: SongRecord) => {
    const confirmed = window.confirm(
      `Delete "${song.title}" from the library and remove its cached song data from KaraokeAI storage?`,
    );
    if (!confirmed) {
      return;
    }

    await api.deleteSong(song.id);
    await onRefresh();
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Library</h2>
          <p>Browse songs, restart processing, or jump straight into playback.</p>
        </div>
      </div>

      {songs.length === 0 ? (
        <EmptyState
          title="Your library is empty"
          description="Import a local file to start generating karaoke assets."
        />
      ) : (
        <div className="table-card">
          {songs.map((song) => (
            <article
              key={song.id}
              className={`list-card song-row ${selectedSongId === song.id ? 'is-selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectSong(song.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectSong(song.id);
                }
              }}
            >
              <div className="song-main">
                <div className="song-title">{song.title}</div>
                <div className="song-subtitle">{getSongSubtitle(song)}</div>
              </div>
              <div className="song-meta">{formatDuration(song.durationMs, { unit: 'milliseconds' })}</div>
              <StatusPill tone={song.status === 'ready' ? 'success' : song.status === 'failed' ? 'danger' : 'warning'}>
                {song.status}
              </StatusPill>
              <div className="row-actions">
                <button type="button" onClick={(event) => { event.stopPropagation(); void handleProcess(song.id); }}>
                  Process
                </button>
                <button type="button" onClick={(event) => { event.stopPropagation(); void handleDelete(song); }}>
                  Delete
                </button>
                <button type="button" className="primary" onClick={(event) => { event.stopPropagation(); void handleOpenPlayer(song.id); }}>
                  Open player
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
