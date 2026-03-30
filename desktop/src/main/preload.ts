import { contextBridge, ipcRenderer } from "electron";
import { JOB_EVENT_CHANNEL, IPC_CHANNELS } from "./constants";
import type { AppStatus, PlaybackPayload, ProcessingJob, SongRecord } from "../../../contracts";

type JobEventHandler = (event: unknown) => void;

const karaokeApi = {
  importLocalFile: (filePath: string): Promise<{ song: SongRecord } | { error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.importLocalFile, filePath),
  enqueueProcessing: (songId: string): Promise<{ job: ProcessingJob }> => ipcRenderer.invoke(IPC_CHANNELS.enqueueProcessing, songId),
  listSongs: (): Promise<SongRecord[]> => ipcRenderer.invoke(IPC_CHANNELS.listSongs),
  getSong: (songId: string): Promise<SongRecord | null> => ipcRenderer.invoke(IPC_CHANNELS.getSong, songId),
  playSong: (songId: string): Promise<PlaybackPayload | null> => ipcRenderer.invoke(IPC_CHANNELS.playSong, songId),
  openFilePicker: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.openFilePicker),
  getAppStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC_CHANNELS.getAppStatus),
  healthCheck: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.healthCheck),
  subscribeToJobEvents: (handler: JobEventHandler): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(JOB_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(JOB_EVENT_CHANNEL, listener);
    };
  },
};

contextBridge.exposeInMainWorld("karaokeApi", karaokeApi);

