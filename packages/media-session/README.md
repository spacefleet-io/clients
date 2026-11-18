# @space/media-session

Operating system media controls for every SpaceFleet player (rule PLAY-OSMEDIA-01). Pure TypeScript: no DOM, React or React Native imports; browser objects are passed in structurally.

| Export | Use |
|---|---|
| `planMediaSession(state)` | Pure: what the OS panel shows (title, artist, local artwork only, position) and which actions it offers (no next on the last song, no seeking without a duration, nothing once released). Phone apps reuse it to drive their native Media3 session. |
| `createMediaSessionBinder({ session, createMetadata, handlers })` | Binds the plan to `navigator.mediaSession` in the web players and the Electron renderers (Chromium maps it to MPRIS, SMTC and Now Playing). `update(state)` on every player change, `release()` when the player closes. |
| `browserMediaSession()` | The page's `{ session, createMetadata }` from `navigator.mediaSession` and `MediaMetadata`, or null where the API is missing; pass it to the binder. |
| `videoMediaInfo(media, artworkUrl)`, `episodeCode(season, episode)` | What every Badger player shows in the OS panel: a movie's title, or `S01E02 · <episode name>` with the show as artist, plus the poster's local URL. |
| `createSilentKeepAlive(...)`, `silentWav()` | Badger desktop: video plays in external mpv, so the renderer loops a silent WAV while mpv plays to make Chromium hold the session; paused keeps it, `none` releases it. |
| `SEEK_STEP_S`, `steppedSeekTarget` | 10-second seek backward/forward. |

Status mapping: `playing` / `paused` keep the session (the keys can resume a paused song), `none` (stopped or closed) releases it.

Tests: `bunx vitest run` (tagged `@req PLAY-OSMEDIA-01`).
