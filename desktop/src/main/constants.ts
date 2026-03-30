import { CACHE_SCHEMA_VERSION, PIPELINE_VERSION } from "../../../contracts/version";

export const APP_NAME = "KaraokeAI";
export const JOB_EVENT_CHANNEL = "karaoke:job-event";
export const IPC_CHANNELS = {
  importLocalFile: "karaoke:import-local-file",
  enqueueProcessing: "karaoke:enqueue-processing",
  removeJob: "karaoke:remove-job",
  clearJobs: "karaoke:clear-jobs",
  listSongs: "karaoke:list-songs",
  listJobs: "karaoke:list-jobs",
  getSong: "karaoke:get-song",
  deleteSong: "karaoke:delete-song",
  playSong: "karaoke:play-song",
  saveLyrics: "karaoke:save-lyrics",
  resetLyrics: "karaoke:reset-lyrics",
  openFilePicker: "karaoke:open-file-picker",
  getAppStatus: "karaoke:get-app-status",
  healthCheck: "karaoke:health-check",
  prepareProcessor: "karaoke:prepare-processor",
} as const;

export { CACHE_SCHEMA_VERSION, PIPELINE_VERSION };
