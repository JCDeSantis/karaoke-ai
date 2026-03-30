import { useEffect, useState } from "react";
import { getKaraokeApi } from "../lib/api";
import type { AppStatus, PlaybackPayload, ProcessingJob, ProcessorHealth, SongRecord } from "../types/electron-api";

export function useKaraokeData() {
  const api = getKaraokeApi();
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [health, setHealth] = useState<ProcessorHealth | null>(null);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackPayload | null>(null);

  const refreshSongs = async () => {
    const nextSongs = await api.listSongs();
    setSongs(nextSongs);
    if (selectedSongId && !nextSongs.some((song) => song.id === selectedSongId)) {
      setSelectedSongId(nextSongs[0]?.id ?? null);
      setPlayback((current) => (current && current.song.id === selectedSongId ? null : current));
    }
    if (!selectedSongId && nextSongs[0]) {
      setSelectedSongId(nextSongs[0].id);
    }
    if (nextSongs.length === 0) {
      setSelectedSongId(null);
      setPlayback(null);
    }
  };

  const refreshJobs = async () => {
    setJobs(await api.listJobs());
  };

  const refreshHealth = async () => {
    setHealth(await api.getProcessorHealth());
  };

  const refreshAppDataPath = async () => {
    const status = await api.getAppStatus();
    setAppStatus(status);
  };

  const prepareRuntime = async (options?: { force?: boolean; preloadTranscriptionModel?: boolean }) => {
    const nextHealth = await api.prepareRuntime(options);
    setHealth(nextHealth);
    return nextHealth;
  };

  const loadPlayback = async (songId: string) => {
    const payload = await api.playSong(songId);
    setPlayback(payload);
    return payload;
  };

  useEffect(() => {
    void Promise.all([refreshSongs(), refreshJobs(), refreshHealth(), refreshAppDataPath()]);
    const unsubscribe = api.subscribeToJobEvents((event) => {
      setJobs((current) => {
        const next = current.filter((job) => job.id !== event.id);
        return [event, ...next];
      });
      void refreshSongs();
    });

    return unsubscribe;
  }, []);

  return {
    songs,
    jobs,
    health,
    appStatus,
    appDataPath: appStatus?.baseDir ?? null,
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
  };
}
