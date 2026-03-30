# KaraokeAI

KaraokeAI is a Windows-first desktop app for turning local songs into reusable karaoke tracks. It imports a song, separates a guide vocal from the instrumental, transcribes timed lyrics, and stores everything locally so the same track can be replayed later without reprocessing.

## What it does

- Imports local audio and video files
- Normalizes source media with FFmpeg
- Separates vocals and instrumentals with Demucs
- Transcribes and time-aligns lyrics with Faster-Whisper
- Caches processed songs under `%LOCALAPPDATA%\\KaraokeAI`
- Plays instrumental and guide-vocal tracks together in the desktop player
- Lets you edit and save lyric corrections locally

## Project layout

- `desktop/` Electron + React + TypeScript desktop app
- `processor/` Python worker for media and AI processing
- `contracts/` shared app types and message contracts

## Local development

Requirements:

- Node.js 20+
- Python 3.11 recommended for release builds
- Windows 10/11

Run the app in development:

```powershell
npm install
npm run dev
```

The dev app bootstraps its local processor runtime on first use under `%LOCALAPPDATA%\\KaraokeAI\\processor-env`.

## Packaging

Build a Windows installer locally:

```powershell
npm run package
```

That command:

- bundles the Python processor into `desktop/resources/processor`
- includes FFmpeg with the packaged worker
- builds the Electron app
- produces an NSIS installer in `desktop/release`

## Releases

The repository includes a Windows release workflow at `.github/workflows/release-windows.yml`.

- `workflow_dispatch` builds and uploads installer artifacts
- pushing a tag like `v0.1.1` also creates a GitHub Release and attaches the installer

## Local data

KaraokeAI stores app data here:

- Library metadata: `%LOCALAPPDATA%\\KaraokeAI\\library.json`
- Song artifacts: `%LOCALAPPDATA%\\KaraokeAI\\songs\\<source_id>\\`
- Downloaded models: `%LOCALAPPDATA%\\KaraokeAI\\models\\`
