# @space/media-crypto

The SFV1 media-object format every app uses for media in the user's storage: Badger's runtime
ingest, offline download and web player, and Parrot's song chunks.

## Format
`SFV1` | salt (16) | nonce (12) | AES-256-GCM(u32le plain length + u16le padding length | plain | padding) | tag (16),
AAD `SFV1`. Object key = HKDF-SHA256(media master key, salt, `sf-media-v1`); media master key =
HKDF-SHA256(library key, `sf-media-master-salt`, `sf-media-master`).

## Non-goals
- No storage or network: callers upload and download the sealed bytes themselves.
- Badger desktop's own copy (`apps/badger/desktop/src/main/mediaCrypto.ts`, with a cached master key for its
  playback server) is not merged here yet.

## Tests
- `bun run --cwd packages/media-crypto test`
