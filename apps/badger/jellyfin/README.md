# Badger for Jellyfin (v0)

Jellyfin 12 plugin (`Jellyfin.Plugin.SpaceBadger`, targetAbi 12.0.0.0) that shows your Badger library in Jellyfin.

## How it works

1. The plugin downloads the service for this platform (linux-x64, linux-arm64, windows-x64) from `<Badger API>/integrations/jellyfin/sidecar/<plugin version>/{manifest.json,<platform>}` (override: plugin setting `SidecarDownloadUrl`), checks its sha256 against the manifest, keeps it in `<jellyfin data>/spacebadger/bin/<plugin version>/` (older version folders are removed on update), and supervises it (restarts with backoff; download failures retry with backoff). `SidecarPath` points at a binary you supply instead (offline use).
2. It writes a Jellyfin library under `<jellyfin program data>/spacebadger-library` (`movies/`, `shows/`; deliberately NOT inside Jellyfin's `data/` folder: Jellyfin 12 drops alternate versions of media found there): NFO + artwork +
   subtitle sidecars + `.strm` shortcuts pointing at the local HLS. TMDB ids are in the NFO, so metadata matches.
   Movies and episodes get one shortcut per quality (`<Title> - 1080p.strm`); Jellyfin merges them as versions, the original first.
   When an app caps the streaming bitrate, PlaybackInfo offers the best version that fits first (INTG-QUAL-01).
   Artwork that is not in the library comes from the metadata service with one anonymous ticket per picture (META-RELAY-01, META-ART-02): the service keeps a reserve of tickets in its state dir (`metadata-tickets/`, removed on sign-out), refilled from the API on its own schedule with the device's session, never by a lookup. The service URL is the plugin setting `MetadataUrl` (passed as `HEADLESS_METADATA_URL`; empty = the production metadata service). Tickets are checked against the production ticket key; a sidecar run against a dev stack pins the committed dev key only with the explicit opt-in `HEADLESS_DEV_TICKET_KEY=1` in its environment (META-ANON-06; never inferred from a URL, the plugin does not set it). A picture the service has none of, or that fails to download, is remembered for 24 h so a library pass does not spend a ticket per dead picture; a 429/503 or an unreachable service pauses lookups for its `Retry-After` (30-60 s by default).
3. It creates the libraries "Badger Movies" and "Badger Shows" and keeps them in step through the service's change feed.
4. PlaybackInfo for these items is rewritten: direct play is turned off and the private `127.0.0.1` URL never leaves the server.
   Jellyfin remuxes/transcodes from the local HLS for every client (INTG-JF-03).
5. Resume/watched flow both ways for the **owner user** (INTG-SYNC-01; resume kept from >=2% or >=15 s, watched at >=95% or after credits).
   Movies use `media.progress`, episodes `episode_resume_v1:<episodeId>`, like the desktop, for the account's oldest profile; another profile uses its own `p:<profileId>:` keys (see 11).
6. Deleting a movie, a single episode or a whole show in Jellyfin deletes it from Badger (INTG-DEL-01).
7. Pairing (ACCT-PAIR-01): the settings page shows a QR code, a short code and a countdown; approve on your phone. The service does the crypto (`@space/pairing-crypto`); the page never sees the key. Email/password and a typed key are under "Advanced".
8. Revoking the device (ACCT-DEV-01): on a 401 the service wipes key and state, the plugin removes the generated library and the Jellyfin libraries, and the page says "signed out".
9. Unpaid account (ACCT-UNPAID-03): playback is blocked (402), signed-in sessions get an on-screen message with the wipe date written as a plain date ("30 November 2026", also in the settings-page banner), an activity-log entry is written; the library stays browsable.
10. Audio and subtitle choices (INTG-JF-01): the owner's choice for a movie or show is the shared per-title preference of all Badger apps (`track_prefs_v1:<movieId|showId>`, never per episode).
    Switching audio or subtitles while playing writes it (languages normalised to ISO 639-1, subtitle "off" kept as off). When the owner starts a title, the remembered choice is used
    unless the app asked for a specific track (`PlaybackInfo` and the item page default to it; a request that names a track wins). PGS subtitles are written as `.sup` files so they stay selectable. Other users never write or receive it.
11. One profile (INTG-PROF-01): the server follows one account and one of its profiles. At pairing, an account with one profile uses it; with several, nothing is stored and nothing syncs until the owner picks one on the settings page (`POST SpaceBadger/Profile`, list `GET SpaceBadger/Profiles`; service `POST /integration/v1/profile`, `GET /integration/v1/profiles`). The pick is kept in the service state (`profile.json`) and never asked again; a session stored before profiles existed takes the account's only profile, and on an account with several asks on the settings page like a deleted profile does. Settings → "Badger profile this server follows" changes it: the media stay, only resume, watched marks and track choices sync again from the new profile (an item the profile never started is reset for the owner).
    Keys: the oldest profile (`isMain`) uses the library's own storage, any other `p:<profileId>:media_progress_v1:<mediaId>`, `p:<profileId>:episode_resume_v1:<episodeId>`, `p:<profileId>:track_prefs_v1:<mediaId>`. The prefix is recomputed from every fresh `GET /profiles` (`isMain` moves when the oldest profile is deleted). If the followed profile is deleted elsewhere, the server never switches to another one: sync and viewing writes pause (service state `needs_profile`, `profileNeeded: "deleted"`), the settings page shows a banner with the picker and the Activity log gets one warning; picking a profile resumes, keeping the synced media.

## Build

```
apps/badger/jellyfin/scripts/build.sh --base-url https://api.spacefleet.io   # service for 3 platforms (bun) + plugin (docker, dotnet 10) + zip + repository manifest + release assets
apps/badger/jellyfin/scripts/build.sh --skip-service --base-url <origin>      # plugin only
```

Output in `dist/`: `spacebadger_<version>.zip` (dll, `meta.json`, licenses; no service binary) and `manifest.json` (plugin repository entry; `sourceUrl` = `<base-url>/integrations/jellyfin/plugin/spacebadger_<version>.zip`). When all three service binaries exist, `dist/release/` holds the tree to publish (see `scripts/release-assets.py`).
Outside dev mode the plugin downloads from the production API (`https://api.spacefleet.io`); in dev mode (`HEADLESS_DEV_TICKET_KEY=1` in Jellyfin's environment) its `ApiUrl` must equal that origin. Or set `SidecarDownloadUrl`.

The `ApiUrl` setting (the account API, not your media server) counts and shows on the settings page in dev mode only (ACCT-AUTH-09): any other run talks to the production API and ignores a stored address, in the plugin (`PluginConfiguration.EffectiveApiUrl`) and in the service (`config.apiUrl`, `accountApiUrl`).

## Install

Unzip into `<jellyfin config>/plugins/Badger_<version>/`, restart Jellyfin, open **Dashboard → Plugins → Badger**:
press **Pair with your phone**, scan the QR code (or type the short code) in the Badger app and approve; if your account has several profiles, pick the one this server follows; then pick the owner user and save.

## Key storage (PRIV-KEY-04)

The library key sits in a private file (`<jellyfin data>/spacebadger/library.key`, mode 0600 on Unix). Anyone with access to the server can read it.
The settings page says so and links https://spacebadger.io/docs/privacy/key-storage. Sign out removes the file.

## Known limits of v0

- jellyfin-web keeps a visited item page in memory: a choice made in another app shows on the item page after a reload (starting playback from a fresh page always uses it).
- External subtitle tracks are listed by Jellyfin with a short id prefix as their title (`0dbf3382 - English - SUBRIP`).
- The delete confirmation is Jellyfin's own dialog plus a tagline on the item; there is no custom dialog.
- Progress/watched and track choices are written back for the owner user only; other users never sync.
- Deleting one version file of a title in Jellyfin deletes the whole title/episode in Badger.
- The library names come from the stored plugin settings (`MoviesLibraryName`, `ShowsLibraryName`) and the plugin finds its libraries again by that stored name. A server set up before the rename (PLAT-SUITE-02) keeps "SpaceBadger Movies" / "SpaceBadger Shows"; only new installs get "Badger Movies" / "Badger Shows".

## Test (what was run live)

Throwaway `jellyfin/jellyfin:12.2` container with the plugin: libraries, metadata, versions, PlaybackInfo (no private URL, transcode URL),
real HLS transcode through Jellyfin (ffprobe: h264+aac), progress/played/unplayed write-back, movie and episode delete, pairing from the settings page, revoke -> signed out, sidecar download with hash check, unpaid message + admin notice.
Pure logic tests for the service: `cd apps/badger/jellyfin/sidecar && bunx vitest run`.
Plugin tests (sidecar binary check, INTG-JF-05): `cd apps/badger/jellyfin/Jellyfin.Plugin.SpaceBadger.Tests && dotnet test` (or in `mcr.microsoft.com/dotnet/sdk:10.0`).
