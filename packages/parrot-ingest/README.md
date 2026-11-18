# @space/parrot-ingest

Parrot's import, upload and playback reads, shared by the Parrot desktop app and the dev seed script.

## Scope
- Which files are imported (`formats.ts`, PAR-UP-01: audio only) and how a folder is walked.
- Reading a file's tags with `music-metadata`, falling back to the file and folder names (`readTrack.ts`).
- Stable library IDs (`ids.ts`): the same file imported on any device lands on the same rows.
- Upload: each file whole, cut into 1 MiB chunks, each sealed as an SFV1 media object (`@space/media-crypto`)
  on the song's own placement; then the library ops and the snapshot publish (`importer.ts`). A file already in
  the library is skipped, so the same import run again resumes.
- The library snapshot as SQLite through `node:sqlite` (`library.ts`), so it runs in Bun and in Electron's main
  process without a native module.
- Reading a stored file back by byte range, decrypting chunk by chunk (`chunkReader.ts`).

## Non-goals
- No song identification or covers yet (PAR-META-01): names come from the file's own tags.
- No light Opus copy yet (PAR-FMT-02).

## Tests
- `bun run --cwd packages/parrot-ingest test`
