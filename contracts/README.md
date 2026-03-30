# KaraokeAI Contracts

This folder defines the shared shapes used by the Electron main process, the preload bridge, and the Python processing worker.

## Versioning

- `PIPELINE_VERSION` changes when the processing pipeline behavior changes in a way that invalidates cached song artifacts.
- `CACHE_SCHEMA_VERSION` changes when the on-disk cache layout or manifest schema changes.

## Core Records

- `SongRecord` is the canonical metadata row for a song imported into the app.
- `ProcessingJob` tracks queue and worker state for a single processing attempt.
- `ArtifactManifest` points at the local files generated for a processed song.
- `PlaybackPayload` is the player-facing shape returned by the main process, including resolved audio plus lyric timing arrays loaded from disk.

## Lyric Timing

- `LyricWord` stores the smallest timing unit the app uses for karaoke highlighting.
- `LyricLine` groups words into display-sized chunks for the player UI.

## Worker Protocol

- Requests are sent as JSON lines with a `type`, `requestId`, and `payload`.
- Worker events use the same line-delimited JSON approach so the main process can stream progress into the UI.
- `PROCESS_TRACK` is the main long-running job request.
- `HEALTH_CHECK` is used to verify that the worker process and models are available.
- `CANCEL_JOB` lets the main process request cancellation for an in-flight job.
