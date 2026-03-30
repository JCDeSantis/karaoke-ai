# Karaoke Processor

This folder contains the Python 3.11 worker for the Windows karaoke app.

## What it does

The worker reads newline-delimited JSON from `stdin` and writes events to `stdout`.

Supported requests:

- `HEALTH_CHECK`
- `PROCESS_TRACK`
- `CANCEL_JOB`

Supported events:

- `JOB_STARTED`
- `JOB_PROGRESS`
- `JOB_COMPLETED`
- `JOB_FAILED`
- `HEALTH_STATUS`

## Setup

Install Python and then install dependencies:

```bash
pip install -r requirements.txt
```

The processing pipeline expects:

- `imageio-ffmpeg` or `ffmpeg` on `PATH` for audio conversion and duration probing
- `demucs` on `PATH` for vocal separation
- `faster-whisper` installed for transcription

In the desktop dev app, the Electron main process now bootstraps a local processor venv under `%LOCALAPPDATA%\KaraokeAI\processor-env` automatically on first run.

## Run

From this directory:

```bash
python -m karaoke_processor
```

Example request:

```json
{"type":"HEALTH_CHECK","request_id":"req-1"}
```

Example processing request:

```json
{
  "type":"PROCESS_TRACK",
  "request_id":"req-2",
  "job_id":"job-123",
  "source_path":"C:\\Music\\song.mp3",
  "workspace_root":"C:\\Users\\You\\AppData\\Local\\KaraokeAI"
}
```

The worker currently includes practical fallbacks when dependencies are missing:

- missing `ffmpeg` and `imageio-ffmpeg` raises a clear error during normalization
- missing `demucs` copies the normalized track into the instrumental slot as a placeholder
- missing `faster-whisper` generates placeholder lyric timing so the pipeline shape remains testable
