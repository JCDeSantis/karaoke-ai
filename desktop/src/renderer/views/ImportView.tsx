import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusPill } from '../components/StatusPill';
import { formatTimestamp } from '../lib/format';
import type { KaraokeApi, SongRecord } from '../types/electron-api';

export interface ImportViewProps {
  api: KaraokeApi;
  songs: SongRecord[];
  onSongsChanged: () => Promise<void>;
}

export function ImportView({ api, songs, onSongsChanged }: ImportViewProps) {
  const [selectedPath, setSelectedPath] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handlePickFile = async () => {
    setMessage(null);
    const path = await api.openFilePicker();
    if (path) {
      setSelectedPath(path);
    }
  };

  const handleImport = async () => {
    if (!selectedPath.trim()) {
      setMessage('Choose a local audio or video file first.');
      return;
    }

    setIsBusy(true);
    setMessage(null);
    try {
      const song = await api.importLocalFile(selectedPath.trim());
      await api.enqueueProcessing(song.id);
      await onSongsChanged();
      setMessage('File imported and queued for processing.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="panel-grid">
      <section className="panel hero-panel">
        <div className="section-heading">
          <div>
            <h2>Import a song</h2>
            <p>Add a local audio or video file, then let the pipeline generate karaoke assets.</p>
          </div>
          <StatusPill tone="info">Local files only in v1</StatusPill>
        </div>

        <div className="import-form">
          <label className="field">
            <span>File path</span>
            <div className="inline-controls">
              <input
                value={selectedPath}
                onChange={(event) => setSelectedPath(event.target.value)}
                placeholder="Select an MP3, WAV, FLAC, M4A, MP4, or MKV file"
              />
              <button type="button" onClick={handlePickFile}>Browse</button>
            </div>
          </label>
          <div className="inline-controls">
            <button type="button" className="primary" onClick={handleImport} disabled={isBusy}>
              {isBusy ? 'Importing...' : 'Import song'}
            </button>
            <button type="button" onClick={() => setSelectedPath('')}>Clear</button>
          </div>
          {message ? <p className="helper-copy">{message}</p> : null}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Recent imports</h2>
            <p>Imported tracks appear here with their current processing state.</p>
          </div>
        </div>
        {songs.length === 0 ? (
          <EmptyState
            title="No songs yet"
            description="Use the import form to add your first local track."
          />
        ) : (
          <div className="stack-list">
            {songs.slice(0, 5).map((song) => (
              <article key={song.id} className="list-card">
                <div className="list-card-title">{song.title}</div>
                <div className="list-card-meta">
                  {song.artist ?? 'Unknown artist'} - {formatTimestamp(song.updatedAt ?? song.createdAt)}
                </div>
                <StatusPill tone={song.status === 'ready' ? 'success' : song.status === 'failed' ? 'danger' : 'warning'}>
                  {song.status}
                </StatusPill>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
