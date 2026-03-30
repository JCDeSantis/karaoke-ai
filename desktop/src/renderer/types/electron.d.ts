import type { KaraokeApi } from './electron-api';

declare global {
  interface Window {
    karaokeApi?: KaraokeApi;
  }
}

export {};

