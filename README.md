# SpaceFleet clients

The source code of the SpaceFleet client apps: the apps you install to play, organise and
back up the media you own, and the local runtime they share. SpaceFleet stores your data
encrypted and keeps it private; these apps are how you reach it.

| App | Version |
| --- | --- |
| badger-desktop | 0.1.58 |
| badger-mobile | 0.0.1 |
| badger-kodi | 0.2.0 |
| badger-jellyfin | 0.2.0.0 |
| parrot-desktop | 0.1.49 |
| parrot-mobile | 0.0.1 |

| Path | What it is |
| --- | --- |
| `apps/badger/desktop` | Badger for Windows, macOS and Linux (Electron) |
| `apps/badger/mobile` | Badger for iOS, Android, Apple TV and Android TV (React Native) |
| `apps/badger/kodi` | Badger add-on for Kodi |
| `apps/badger/jellyfin` | Badger plugin for Jellyfin, with its sidecar |
| `apps/parrot/desktop` | Parrot, the music app, for Windows, macOS and Linux (Electron) |
| `apps/parrot/mobile` | Parrot for iOS and Android (React Native) |
| `apps/runtime` | The local runtime the apps share (library, transfers, playback helpers) |
| `packages/*` | Shared code: library database, crypto, playback, ingest, UI |
| `packages/media-deps` | Recipes that build the bundled media binaries (FFmpeg, mpv) |

This repository is published from SpaceFleet's private monorepo: every update of the apps
there is synced here as one commit. The server side of SpaceFleet is not part of it.

## Build

You need [Bun](https://bun.sh) 1.4.5.

```sh
bun install --frozen-lockfile
bun run test                                # unit tests of every workspace
bun run --cwd apps/badger/desktop build     # Badger desktop
bun run --cwd apps/parrot/desktop build     # Parrot desktop
```

Playing media and packaging the desktop apps need the media binaries. They are built from
`packages/media-deps/recipes` and published, with their corresponding source, as release
assets of [spacefleet-io/media-deps](https://github.com/spacefleet-io/media-deps). Fetch the
ones for your machine with:

```sh
bun run setup:binaries                      # or: bun scripts/fetch-deps.ts --target linux-x64
```

Set `MEDIA_DEPS_BASE_URL` to fetch them from a mirror instead.

The mobile apps build with the usual React Native toolchains (Xcode, Android Studio with
JDK 21); the Kodi add-on with Python 3; the Jellyfin plugin with the .NET SDK. Each app's
own README has the details.

A Metro dev build of either mobile app names no metadata service of its own: title and
music lookups fail until you set `EXPO_PUBLIC_METADATA_URL` to a metadata service URL when
you start Metro, or turn tickets on (`SF_METADATA_TICKETS=on` for Badger,
`PARROT_METADATA_TICKETS=on` for Parrot) to send them to the metadata service beside the API
the app uses. Metro prints this when neither is set. Release builds need neither.

## Licence

GPL-3.0-only (see `LICENSE` and `NOTICE`). Directories with a `LICENSE-EXCEPTION.md` add a
permission to distribute through Apple's App Store. `packages/sdk` and
`packages/tool-access` are MIT.

## Contact

Help with the apps: support@spacefleet.io. Security issues: security@spacefleet.io (see
`CONTRIBUTING.md`).
