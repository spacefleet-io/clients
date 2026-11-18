# Badger for Kodi (v0)

`plugin.video.spacebadger` — Kodi 21+ (Python 3.8+) video add-on. Pure Python, no bundled binaries.
Spec: INTG-KODI-*, PRIV-KEY-01/04/05, PRIV-ENC-01, ACCT-DEV-01, ACCT-UNPAID-03.

## What it does

- **Pairing** (ACCT-PAIR-01, PRIV-KEY-05): the first time you open the add-on a dialog shows a QR code and a short code (`ABCD-1234`). Approve it from the Badger phone/desktop app; the library key travels sealed end to end (X25519 + AES-256-GCM), never in clear. The code expires after 5 minutes ("Get a new code" asks for another). "Use email and password" (Advanced) opens the settings page for the old sign-in. The QR image is made by a small vendored encoder (Nayuki QR Code generator, MIT) and the key exchange uses libcrypto/pure-Python `x25519.py`.
- Syncs the encrypted library (snapshot + ops) into a local SQLite file (`library.sqlite` in the add-on data dir).
- Serves HLS from a local loopback server (all qualities + audio renditions, sidecar subtitles incl. image-based PGS `.sup`) and plays it through `inputstream.adaptive`. Media objects are fetched through the gateway tunnel and decrypted (SFV1 AES-256-GCM) on the fly. The gateway is picked from `shard.addresses[]` by probing.
- Exports `.strm` / `.nfo` / artwork to `special://profile/addon_data/plugin.video.spacebadger/library/{movies,tvshows}/` so Kodi's own scanner imports them. It never writes `MyVideos.db`. A deleted episode's files are pruned from the export so Kodi cannot re-add it.
- **Library setup** (INTG-KODI-02): after pairing, "Add your library to Kodi" (also in the add-on menu) walks Kodi's own Set-content screens for both folders (Movies/TV shows, "Local information only", scan recursively). Kodi offers no API for adding a source with a content type, so this drives its normal screens, and if you prefer you can do the same steps by hand (below).
- Writes progress back to the library exactly like the desktop app (`media.progress`, `setting.set episode_resume_v1:<id>`); INTG-SYNC-01 thresholds (resume from >=2 % or >=15 s, watched at >=95 % or past credits).
- **Resume**: from Kodi's library, Kodi asks "Resume from X / Play from beginning" against the position we push into its bookmark (we never ask twice). Started from the add-on's own menu, the add-on shows the same two-line question itself (position minus the standard rewind).
- **Skip intro / Skip credits** (INTG-KODI-04): a "Skip intro" / "Skip credits" button appears over the video (custom dialog `SpaceBadgerSkip`) while a marker from the library is active; press OK to seek past it.
- **Up Next**: the add-on signals `service.upnext` (install "Up Next" from Kodi's official repository) with the next episode of the show, so Kodi shows the "Up next in N seconds / Watch now" card. Each episode gets its real Kodi library id (or a stable synthetic one), because Up Next compares ids.
- **Audio/subtitle memory** (INTG-KODI-04): the add-on reads and writes the shared `track_prefs_v1:<movieId|showId>` setting (`{"audioLanguage":"fr"|null,"subtitle":{"language","format"?,"forced"?}|"off"|null,"updatedAt"}`), so a choice made on the desktop applies in Kodi and the other way round. Languages are normalised to ISO 639-1; when the title starts, the matching stream (same language, forced flag and format when several) is selected.
- **One profile** (INTG-PROF-01, ACCT-SQUAD-02): pairing asks "Who uses this Kodi?" when the account has several profiles (one is used without asking; cancelling signs the new session out and saves nothing), and never asks again. Resume points, watched marks and track choices are that profile's: the oldest profile uses the library's own storage slot, any other `p:<profileId>:` keys. Settings → "Change profile" switches it; the synced media stays and only the viewing state re-syncs. Playback sessions name the profile (STOR-BW-11). If the followed profile is deleted on another device (or an install paired before profiles finds several on the account), the add-on never switches by itself: it says so once, stops recording resume points, watched marks and track choices, and waits until someone picks a profile in Settings → "Change profile".
- **Delete (INTG-DEL-01)**: context menu "Delete from Badger" on a movie, a show or one episode -> permanent-delete confirmation -> `/storage/delete` for every owned key -> `media.delete` (movie/show) or `media.upsert` without the episode's files (episode) -> removal from Kodi's library and of that title's (or episode's) export files only, no full re-export.
- **Unpaid account (ACCT-UNPAID-03)**: the menu shows "Subscription unpaid - playback paused, data removed <date>", playback shows the notice with the date and the renewal link; browsing keeps working.
- **Signed out remotely (ACCT-DEV-01)**: when the server reports the device's session revoked (HTTP 401), the add-on wipes its token, key, library cache, the export folder and every item it put in Kodi's library, tells you in plain English, and offers pairing again.
- **Account server (ACCT-AUTH-09)**: the add-on talks to the production API (`https://api.spacefleet.io`). The `api_url` setting is shown and used only on a dev run (`SB_DEV_TICKET_KEY=1` in Kodi's environment, the same switch as the development ticket key); any other run hides it and ignores it and any address a saved session remembers (`core.account_api_url`). The service mirrors the switch into the hidden `dev_mode` setting that settings.xml keys the field's visibility on; the code never reads `dev_mode`.
- **Anonymous metadata** (META-ANON-02, META-ANON-03, META-RELAY-01, META-RELAY-02): pictures are looked up with `POST <metadata url>/lookup` and `Authorization: PrivateToken token=...`, one single-use ticket per lookup, nothing else identifying (no cookie, no account or device header, generic user agent, no redirects). Tickets are blind RSA tokens (RFC 9474 RSABSSA-SHA384-PSS-Deterministic, RFC 9578 type 0x0002) done in pure Python (`privacypass.py`). The reserve lives in `tickets.json` in the add-on data dir (0600, atomic replace, cross-process lock, a ticket is removed from the file before it is used) and is wiped on sign-out. The service refills it on its own schedule (target 600, refill below 300, 100 per request, about every 6 hours with +-30 % jitter, backoff on failures, `POST /metadata/tickets` with the usual bearer) and only keeps tickets stamped with the pinned signing key (`ticket_pin.py`, generated by `python3 tools/sync_ticket_pin.py` from `packages/privacy-pass/src/pinnedKey.ts`; `--check` verifies it, `test_ticket_pin.py` fails on drift). Pictures only come through the metadata service, never from a source host (META-ART-02).

## Build / install

## Build / install

```sh
python3 build.py plugin [--out DIR]   # -> dist/plugin.video.spacebadger-<version from addon.xml>.zip
```

Install the zip via Kodi → Add-ons → Install from zip, or copy the folder to `~/.kodi/addons/` and run
`kodi-send --action="UpdateLocalAddons"`, then enable the add-on. Normal users install through the repository (below).

Crypto uses the system `libcrypto` through `ctypes` (present on OSMC/LibreELEC/Android/desktop Linux). Where it is missing or
unusable, a copy of pycryptodomex for the CPU type that ships inside the add-on is used (next section). The zip is deterministic
(sorted entries, fixed timestamps, no bytecode).

<!-- BEGIN vendored-crypto-fallback -->
## Vendored crypto fallback

INTG-KODI-01: no separate program is shipped or started. The compiled files under `resources/lib/vendor/` are the unmodified upstream
extension modules of **pycryptodomex 3.24.2**, loaded in-process by Python only when the system has no working libcrypto/`Cryptodome`
(packaging only). `crypto._load_backend()` order: system libcrypto (ctypes) → system `Cryptodome` → vendored `Cryptodome`
(`vendor_loader.prepare()` puts `vendor/<platform>` on `sys.path` only if no system copy imports, and logs every step with the `[SpaceBadger]` prefix).

| `vendor/<platform>` | CPU / OS | wheel (abi3, cp37+) |
|---|---|---|
| `linux-x86_64` | glibc PC, LibreELEC x86 | PyPI `manylinux2014_x86_64` |
| `linux-aarch64` | 64-bit ARM (Pi 4/5 64-bit images) | PyPI `manylinux2014_aarch64` |
| `linux-armv7l` | 32-bit ARM (Pi OSMC/LibreELEC `armhf`, also armv6l) | piwheels `linux_armv7l` (PyPI has none) |
| `windows-amd64` | Windows 64-bit | PyPI `win_amd64` |
| `macos-universal` | macOS Intel + Apple silicon | PyPI `macosx_10_9_universal2` |

`platform_key()` uses `platform.machine()` **and** `sys.maxsize`: OSMC on a Pi 4 reports `aarch64` (64-bit kernel) but runs 32-bit Kodi/Python, so it maps to
`linux-armv7l`. Not vendored: musl Linux (Alpine; not used by Kodi distros), Windows 32-bit/ARM, Linux i686. Android Kodi has libcrypto.

`vendor/MANIFEST.json` records wheel file name, wheel sha256, source and a tree digest per platform; `vendor/LICENSE.rst` and `AUTHORS.rst`
are upstream's (BSD-2-Clause + public domain parts, GPL-3.0 compatible). Only the modules the add-on needs are kept
(AES-GCM, SHA-256/HMAC/HKDF, X25519 via `Protocol.DH` + `PublicKey.ECC`, Random), found by scanning imports; tests are dropped (~4.5 MB per platform
unpacked, ~7 MB for the whole zip). Regenerate / bump with `python3 tools/vendor_wheels.py` (downloads, checks the pinned sha256s, rewrites `vendor/`).

Force the fallback (testing, e.g. on a box with a good libcrypto): set env `SB_FORCE_CRYPTODOME=1`, or create an empty file
`force_cryptodome` in the add-on data folder (`special://profile/addon_data/plugin.video.spacebadger/`). Check on any machine:
`python3 -S tests/vendor_check.py plugin.video.spacebadger/resources/lib tests/vectors.json` (prints one JSON line, exit 0 = AES-GCM, HKDF and X25519 vectors passed from the vendored copy).
<!-- END vendored-crypto-fallback -->

<!-- BEGIN kodi-repository -->
## Kodi repository (auto-updates)

INTG-DIST-01: users add our repository once; Kodi then installs the add-on and updates it by itself.

```sh
python3 build.py repo --base-url https://api.spacefleet.io/integrations/kodi --out DIR [--layout tree|flat]
```

`--base-url` is where `DIR` is served; it is baked into `repository.spacebadger/addon.xml` inside the repo zip (the committed file only holds `@BASE_URL@`).
`tree` (default) writes `addons.xml`, `addons.xml.md5`, `repository.spacebadger.zip` (latest alias) and `addons/<id>/<id>-<ver>.zip` + `icon.png` for
`repository.spacebadger` and `plugin.video.spacebadger`. `flat` writes the release-attachment names (`addons.xml`, `addons.xml.md5`, `<id>-<ver>.zip`, `<id>-icon.png`).
`--version X.Y.Z` builds a dry-run version of the plugin (update tests) without touching `addon.xml`.

**User:** download `repository.spacebadger.zip` from `<base-url>/repository.spacebadger.zip` (or add `<base-url>/` as a file source) → Add-ons → Install from zip
→ then Add-ons → Install from repository → Badger → Video add-ons → Badger → Install.

**Shipping an update:** bump `<addon version>` in `plugin.video.spacebadger/addon.xml` (and `news`), run the `repo` build, publish the output. Kodi re-reads
`addons.xml.md5` on its repo refresh (about daily, or `kodi-send --action="UpdateAddonRepos"`) and, with Settings → System → Add-ons → Updates = automatic, installs the new version.
Verified on OSMC Kodi 21.3 (Pi 4): repo zip installed, plugin installed from the repository, then auto-updated 0.1.0 → 0.1.1 after `UpdateAddonRepos`.
Note: removing add-on folders by hand (instead of Kodi's Uninstall) leaves harmless orphan cache rows in Kodi's `Addons33.db`.
<!-- END kodi-repository -->

## Settings

Pairing replaces typing anything. The "Advanced" settings page (API URL, e-mail, password, library key) stays for people who cannot pair. After saving, the service signs in, stores the key, and clears the password/key fields from `settings.xml` (they are declared `allowempty` so Kodi accepts a cleared field).

**Key storage warning (PRIV-KEY-04):** the library key is stored in plain text in `library.key` in the add-on data directory
(file mode 0600 where the OS allows it; no obfuscation). Anyone with access to that file can decrypt your library.
See https://spacebadger.io/docs/privacy/key-storage. The settings page has a visible warning button ("the library key is stored in a private file on this device").

**Metadata URL:** the "Metadata service URL" setting (`metadata_url`, Advanced) overrides where picture lookups go. Empty means: the `METADATA_URL` environment variable, else `http://localhost:3002` when the API URL is a loopback address, else `https://metadata.spacefleet.io`.

## Setting up the Kodi library by hand

Normally "Add your library to Kodi" does this for you. Manually, once per device:

1. Videos -> Files -> Add videos -> path `special://profile/addon_data/plugin.video.spacebadger/library/movies/`, name e.g. "Badger Movies".
   Set content: **Movies**, scraper **Local information only**, tick **Scan recursively**.
2. Same for `.../library/tvshows/` with content **TV shows**, scraper **Local information only**, **Scan recursively**.
3. Answer "Yes" to the scan prompt. Later syncs re-export and trigger `VideoLibrary.Scan` automatically (setting "Keep the Kodi library export up to date after each sync"). The scan, after a sync or after "Export library" in the settings, runs only when the export wrote or removed a file.

The plugin menu (Video add-ons -> Badger) works without this step. Research notes on why no fully hands-off route exists: Kodi's JSON-RPC cannot add sources or set content, and editing `MyVideos.db`/`sources.xml` under a running Kodi is unsafe.

## Tests

```sh
cd apps/badger/kodi && python3 -m unittest discover -s tests
```

Crypto test vectors come from the desktop TS implementation (`tests/gen_vectors.ts` → `tests/vectors.json`).

Metadata ticket tests (`test_privacypass.py`, `test_tickets.py`, `test_metadata.py`, `test_ticket_pin.py`) run the RFC 9474 / RFC 9578 vectors and the shared dev-token vector from `packages/privacy-pass/vectors/`, a real local HTTP server standing in for the metadata service, and a multi-process race on the reserve file. `tests/_dev_signer.py` is a test-only blind signer built on the repo's dev key; `tests/_path.py` sets the dev opt-in `SB_DEV_TICKET_KEY=1` so the add-on trusts that key (dev first, then production, `privacypass.keys_for_run`) in tests. Without the opt-in the add-on trusts the production key alone (`ticket_pin.py`, generated with both keys by `tools/sync_ticket_pin.py`; META-ANON-06).

## Known limits

- Kodi's library screen can only start playback from a bookmark that it knows about, so a position stored on another device appears in Kodi after the next sync (the service pushes it within seconds).
- Up Next needs the `service.upnext` add-on installed from Kodi's official repository; without it the add-on simply plays one episode at a time.
- Test clips used while developing were 150-240 s although their HLS headers said ~3.3 h (a bogus last segment); on real media the progress bar behaves normally.
- Removing the add-on's folders by hand (instead of Kodi's Uninstall) leaves harmless orphan rows in Kodi's `Addons33.db`.
- Saturated silo (STOR-BW-07, STOR-BW-08, PLAY-QUAL-07): at each play the add-on asks the silo of the title for its report (`refresh_traffic`, not cached, so the cap lifts with the silo) and, while the silo is saturated, offers only the rungs at or under the plan's `qualityCap` (`apply_quality_cap` in `hls.py`: free `480p`, Starter and Standard `1080p`, Scale none); a free viewer with no rung at or under 480p gets `playback_stopped`. The cap is applied per play, not live. A 503 `free_playback_refused` / `playback_stopped` from the silo (`PlaybackRefusedError` / `PlaybackStoppedError` in `api.py`) shows a notice (English only) and a stopped stream is ended; there is no resume, press play again once traffic has eased.
- Anonymous metadata (META-ANON-02, META-ANON-03, META-RELAY-01, META-RELAY-02): pictures need a ticket from the reserve. With an empty reserve, an unpaid account (402 on refill) or an unreachable metadata service, pictures are skipped (lookups pause for two minutes, or the `Retry-After` value) until the service's next scheduled refill; nothing else is affected. The reserve refills only on the service's schedule, never from a plugin call.
- Anonymous metadata, spending: one failing answer (no ticket, 500/502/503, no answer, three refused tickets in a row) pauses every lookup of that process for two minutes (or the `Retry-After` value), so a sick service cannot drain the reserve in one sync. A 429 `rate_limited` or 503 `ticket_store_unavailable` answer means the service never spent the ticket, so the add-on puts it back into the reserve file (META-ANON-05); every other failed answer, 503 `upstream_capacity` included, keeps it spent. A picture the service has no answer for gets a `.none` marker in the art cache that is believed for 24 hours, never longer. The library export looks pictures up only while the reserve holds more than 150 tickets, so browsing keeps some; the rest follows at later syncs. A sign-out, a wipe or another account's sign-in empties the reserve, and a refill in flight at that moment stores nothing.
