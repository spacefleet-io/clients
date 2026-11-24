# Mobile Client

## Licence

GPL-3.0-only (`LICENSE`) with the App Store additional permission of GPL-3.0 section 7 (`LICENSE-EXCEPTION.md`), which covers only code held by the SpaceBadger authors; third-party components keep their own licences (REL-LIC-01). `packages/mobile-shell`, `packages/mobile-mpv-playback`, `packages/library-db`, `packages/playback-abr` and `packages/error-report` carry the same files. `packages/shared`, `packages/pairing-crypto` and `packages/library-db-definition`, which the server apps also use, have no licence yet: an open decision, REL-LIC-03 (issue #689). The server apps are not covered.

## Testing

- `bun run --cwd apps/badger/mobile test`

This client uses Jest (React Native preset) instead of Vitest because RN-specific transforms and native-module mocking are supported directly in the Jest ecosystem.

## Phone e2e + performance harness (`e2e-phone/`)

Drives the debug app on a real, USB-attached Android phone over adb and measures latency against the same budgets as the desktop e2e (`apps/desktop/e2e-ultimate/lib/metrics.ts`). Bun + TypeScript, no Maestro.

```sh
bun run --cwd apps/badger/mobile test:phone --serial S --profile normal    # stock phone
bun run --cwd apps/badger/mobile test:phone --serial S --profile lowend    # throttled phone (see below)
bun run --cwd apps/badger/mobile test:phone --serial S --profile both
bun run --cwd apps/badger/mobile test:phone list                # functional scenarios (the default run)
bun run --cwd apps/badger/mobile test:phone list --perf         # performance benches (play-60s, abr-*, hevc-matrix)
bun run --cwd apps/badger/mobile test:phone run --serial S --profile both --perf   # run the benches on both profiles
bun run --cwd apps/badger/mobile test:phone grid                # join the latest normal + lowend `--perf` results
bun run --cwd apps/badger/mobile test:phone status --serial S   # throttle state of the phone
bun run --cwd apps/badger/mobile test:phone restore --serial S  # ALWAYS safe: puts cores/freq/RAM back
bun run --cwd apps/badger/mobile test:phone --help              # usage; touches no phone
```

Every command but `list`, `grid` and `--help` needs the phone named, `--serial S` or `ANDROID_SERIAL` (claim it with `sf-phone claim` first): the harness never picks an attached phone by itself (PERF-MOBILE-05).

Flags: `--scenario a,b`, `--stack-file <dev-stack.md>`, `--serial <adb serial>`, `--out <dir>`, and for lowend `--max-freq-khz`, `--online-cpus`, `--hold-free-mb`, `--ttl <min>`. Env: `ANDROID_SERIAL`, `E2E_PHONE_EMAIL`, `E2E_PHONE_PASSWORD`, `E2E_PHONE_API_HOST`, `E2E_PHONE_LIBRARY_KEY`, `E2E_PHONE_MOVIE`, `E2E_PHONE_SERIES`, `E2E_PHONE_STACK_FILE`, and for the HEVC scenarios `E2E_PHONE_HEVC_MOVIE`, `E2E_PHONE_HEVC_1080P8`, `E2E_PHONE_HEVC_1080P10`, `E2E_PHONE_HEVC_2160P10`; `E2E_ABR_THROTTLE_KBPS` (default 1500) sets the ABR scenarios' network cap. `abr-too-weak` plays the 2160p 10-bit HEVC fixture (`E2E_PHONE_HEVC_2160P10`, its only version) and forces software decoding: the phone cannot decode it in real time, so frames really drop (the mobile libmpv has no filter to slow decoding).

- Prerequisites: debug or profile build installed, `adb reverse` for 8081/3000/3002/3003, account logged in (the harness logs in itself when it finds the login screen and has credentials). Set credentials, key and fixture titles via env or `--stack-file`.
  - Debug (needs Metro running): `cd android && ./gradlew :app:installDebug -PreactNativeArchitectures=arm64-v8a`. Dev-mode JS, so latencies are pessimistic; use it for functional runs. The harness checks Metro only when the installed APK has no bundled JS (`assets/index.android.bundle`).
  - Profile (no Metro; use this for performance numbers): `cd android && ./gradlew :app:assembleProfile -PreactNativeArchitectures=arm64-v8a`, then `bun run --cwd apps/badger/mobile test:phone install [apk]` (defaults to the profile APK). Release-optimised bundled JS, debug-signed (upgrades a debug install in place, keeps app data), cleartext allowed for the dev stack, and includes the probe. It pins the production ticket key, so against a dev stack build it with `SF_DEV_TICKET_KEY=1 ./gradlew :app:assembleProfile -PreactNativeArchitectures=arm64-v8a` to pin the dev key and show pictures (META-ANON-06; never on a release build, Gradle refuses it).
  - Always install through `test:phone install`: Google Play Protect stops every sideload with a "send this app for a security check?" prompt and `adb install` waits on it. The command answers "Don't send" by itself (scrolls the sheet, finds the button by its text); Play Protect settings stay untouched. `test:phone dismiss-play-protect` clears a prompt left by a plain `adb install`.
- HEVC decode matrix (`hevc-matrix`, PERF-MOBILE-02, and `abr-decode-bound`, PLAY-CODEC-01): one title per case, because bit depth only shows in a format's `codecString` (`hvc1.1.*` Main 8-bit, `hvc1.2.*` Main10). Both are performance benches (`test:phone run --perf`, or `--scenario hevc-matrix,abr-decode-bound`), so the functional run that `test-all-clients` drives does not pick them; `scripts/test-all-clients/hevc-seed.ts` holds the same seeding steps as code (fixtures, encrypted storage cached per fixture hash under `~/.local/share/spacefleet-dev/hevc-matrix-storage/<hash>`, Inception 1080p 8-bit, Interstellar 1080p 10-bit, The Matrix 2160p 10-bit, The Dark Knight 1080p HEVC + H.264). By hand, from the repo root, against the dev stack:
  1. `SF_ULTIMATE_FIXTURES_DIR=~/.local/share/spacefleet-dev/ultimate-fixtures bun apps/badger/desktop/e2e-ultimate/fixtures/generate.ts --hevc-matrix` writes 240 s HEVC MP4s (1080p 8-bit and 10-bit at 8 Mbps, 2160p 10-bit at 20 Mbps, `hvc1` tag), a 1080p H.264 copy (8 Mbps, for `abr-decode-bound`), AAC audio and a `source_manifest.json` to `<dir>/hevc-matrix/`. Existing files are reused.
  2. `SF_DUMMY_STORAGE_DIR=<storage> SF_DUMMY_SOURCE_MANIFEST=<dir>/hevc-matrix/source_manifest.json SF_MEDIA_ENCRYPT=1 SF_LIBRARY_KEY_BASE64=<key> bun scripts/build_dummy_storage.ts --build-storage`, then `--upload --token <session token>` with the same `SF_DUMMY_STORAGE_DIR`.
  3. Once per case: `SF_DUMMY_STORAGE_DIR=<storage> bun scripts/dev-seed-mobile-library.ts --token <t> --library-key <key> <movie flag, see the script header> --video <1080p/hvc1.1 | 1080p/hvc1.2 | 2160p/hvc1.2> --no-tv`, and name the seeded titles in `E2E_PHONE_HEVC_1080P8` / `_1080P10` / `_2160P10` or as `hevc 1080p8: <title>` lines in the stack file. For `abr-decode-bound`, seed one title with both formats (`--video 1080p/hvc1.1,1080p/avc1`; each comma-separated filter must match exactly one video) and name it in `E2E_PHONE_HEVC_MOVIE`.
- Each `run` batch holds `flock /tmp/badger-phone.lock` for the whole batch (installs and `throttle` hold it per command), so it can share the phone with other agents. `E2E_PHONE_LOCK` names another lock file; test-all-clients uses one per device serial.
- `SF_ANDROID_USER=<id>` runs the test build on one Android user only: `install`, launch (`am start`), force-stop, `pm clear`, the notification grant and the installed-package checks all carry `--user <id>` (`packages/android-e2e/src/android-user.ts`, shared with Parrot's `e2e-android`). Unset or empty keeps adb's defaults (install for every user, launch on the foreground one); anything but a plain user id stops the harness. The Pixel 8 (`p8`) runs with `SF_ANDROID_USER=0`, since it opens on a secondary profile and its other profiles are not ours: set it by hand there, and test-all-clients sets it itself (`ANDROID_USERS` in `scripts/test-all-clients/inventory.ts`).
- Measurements: latency = device-clock event timestamp (from the debug-only `MpvProbe`, tag `SBProbe`) minus the device-clock timestamp of the injected finger-up (`sendevent`), so adb round trips and clock skew cancel. UI discovery uses the probe's `…probe.UI` broadcast (`uiautomator` does not work on this app). Debug and profile builds only; the release source set ships a no-op `MpvProbe`.
- Probe broadcasts: `adb shell am broadcast -a com.spacefleet.mpvplayback.probe.QUERY -p com.spacebadger.mobile` (JSON snapshot in `data=`), `.RESET`, `.UI`, `.MSGLEVEL --es level "all=warn,demux=v,ffmpeg=v"` (sets libmpv's `msg-level` at runtime so its trace lands in logcat tag `MpvCore`; `--es level ""` restores `all=warn`) and `.SETOPT --es name <option> --es value <value>` (sets an mpv option at runtime, for A/B experiments) and `.NETTHROTTLE --ei kbps N` (caps the playback proxy's upstream fetch rate; `0` removes it; used by the `abr-*` scenarios). Diagnostics only: the harness sets them solely from the `E2E_MPV_MSGLEVEL` and `E2E_MPV_OPTS="name=value,…"` env vars (once the player is up), never by default.
- `lowend` = cpu4-7 (big cores) offline, cpu0-3 (A55) capped at 1.2288 GHz, RAM held (tmpfs) until ~2 GB is free. Restored by the harness on exit/SIGINT, by `restore`, and by a 25 min device-side watchdog.
- A scenario whose app feature does not exist yet (or whose control cannot be found) reports `n/a`; it never fails the run. Results land in `e2e-phone/out/<run>/` (`run.json`, `report.md`, screenshots; `out/` is gitignored).

## Release build and signing (Play upload key)

A release build (`bundleRelease`, `assembleRelease`) is signed only with the Play upload key (alias `badger-upload`; Google holds the app signing key, Play App Signing) and fails when the key is not configured: `android/app/build.gradle` reads `BADGER_UPLOAD_STORE_FILE`, `BADGER_UPLOAD_STORE_PASSWORD`, `BADGER_UPLOAD_KEY_PASSWORD` (and optional `BADGER_UPLOAD_KEY_ALIAS`) from gradle properties or the environment. Debug and profile builds keep the debug key and need nothing. `-PbadgerVersionCode=N -PbadgerVersionName=x.y.z` set the store version (default 1 / 1.0).

- CI: the `badger-android-release` workflow, run by hand or by a `badger-android-v*` tag. It builds the AAB for Play and a universal APK for sideloading, checks both carry the upload key's certificate and the production ticket key, then builds the Google-free APK with `scripts/android-foss-build.sh badger` (the F-Droid recipe, no Google Play services), checks it the same way and that it holds no Play services or Firebase class, and keeps all three as the run's artifact. It uploads nothing to Play (REL-GATE-09, REL-MOB-01); the Google-free APK goes public only through `android-apk-publish` (PLAT-MOBILE-06, REL-OSS-04).
- By hand: the key and its passwords are backed up in `~/.local/share/spacefleet-keys/badger-upload.*` (README there):

```sh
set -a; . ~/.local/share/spacefleet-keys/badger-upload.passwords.env; set +a
export BADGER_UPLOAD_STORE_FILE=~/.local/share/spacefleet-keys/badger-upload.jks
cd apps/badger/mobile/android && ./gradlew :app:bundleRelease :app:assembleRelease
```

## Google-free build (`SF_FOSS=1`, F-Droid and the direct APK)

One build for F-Droid and the APK published for phones without Google Play services (PLAT-MOBILE-06), from the same source as the Play build. `SF_FOSS=1` in the environment of Gradle (and so of Metro) switches it on; unset, the build is the Play build. The switch is in `packages/mobile-shell/foss.cjs` and is shared with Parrot:

- autolinking leaves Firebase, Google Cast and `react-native-camera-kit` (ML Kit) out of the Android build, and Metro swaps their JS for stand-ins: no push messages (the app polls when it comes to the foreground), no Cast button or Cast device, and pairing asks for the typed code instead of scanning the QR code;
- `android/app/build.gradle` drops the google-services plugin, the Cast SDK and the committed `libc++_shared.so` (libmpv's bundle carries the same NDK r27b one), and compiles `src/foss` instead of `src/play` (`CastSupport`);
- the release build needs no upload key: it is signed with it when it is set, and left unsigned for F-Droid to sign otherwise.

`SF_VERSION_CODE=<n> SF_VERSION_NAME=<x.y.z> scripts/android-foss-build.sh badger` is the release recipe F-Droid and CI share; it bakes in the error report DSNs of the committed `scripts/android-foss-error-report.env` (whatever the calling environment holds) and prints the APK's path last. Debug and profile builds take the switch too, e.g. `SF_FOSS=1 ./gradlew :app:assembleProfile -PreactNativeArchitectures=arm64-v8a` for the phone harness (GrapheneOS phones have no Play Protect prompt to answer); a debug build loads its JS from Metro, so start Metro with `SF_FOSS=1` as well. Switching one checkout between the two builds needs no clean: `settings.gradle` regenerates the autolinking list when the switch changes (`packages/mobile-shell/foss-autolinking.gradle`) and the JS bundle task takes the switch as an input.

## Error reports (REL-LOG-06)

Opt-in, off until the user turns it on (setup question after the library key, then Settings → Privacy → "Send error reports"; the answer is in the local app settings only, never synced with the account). Phone and TV share this code. `src/lib/errorReporting.ts` applies the saved answer from `index.js` before React mounts and follows the switch live; the SDK (`@space/error-report/react-native`, JavaScript errors only, native half off) is not loaded or initialised while the answer is off or unknown.

**DSN at build time.** `bun run --cwd apps/badger/mobile error-report-config` writes the gitignored `src/generated/errorReportConfig.ts` from `SF_BUGSINK_DSN_BADGER_MOBILE` and `SF_BUGSINK_DSN_BADGER_TV` (empty when unset); the TV app (`Platform.isTV`) uses the TV DSN. Run it before bundling a release. The Play build takes them from CI secrets; the Google-free build (`scripts/android-foss-build.sh`) from the committed `scripts/android-foss-error-report.env`, because F-Droid builds from source with no secrets. A build without the file or without a DSN neither asks the setup question nor shows the switch. Ingest host is `https://reports.spacefleet.io`.

**Native side.** `io.sentry.auto-init=false` in `AndroidManifest.xml`; nothing on iOS starts the native SDK; the Sentry gradle plugin and Xcode upload scripts are deliberately not wired.

**Source maps (in the Android release workflow).** `badger-android-release.yaml` builds with `SF_ERROR_REPORT_SOURCEMAPS=1` and uploads the Hermes map to Bugsink (project `badger-mobile`; Bugsink stores maps by debug ID, so the TV's reports, same bundle, use it too) before keeping the artifacts, then does the same for the Google-free build's own bundle; a missing `SF_BUGSINK_AUTH_TOKEN` fails the run. By hand, after such a build:

```sh
SF_BUGSINK_URL=<Bugsink URL> SF_BUGSINK_AUTH_TOKEN=... \
  bun scripts/bugsink-sourcemaps.ts upload-hermes apps/badger/mobile --project badger-mobile
```

`SF_ERROR_REPORT_SOURCEMAPS=1` makes `metro.config.js` wrap the config with `@space/error-report/metro` (`@sentry/react-native`'s `withSentryConfig`, debug ID only; middleware, options file and web replay/feedback off). Ordinary and dev builds do not load it. `upload-hermes` copies the debug ID from the Metro map into the composed Hermes map and runs `sentry-cli sourcemaps upload --debug-id-reference` (private Bugsink, token in `SF_BUGSINK_AUTH_TOKEN`). `sentry-cli sourcemaps inject` is not used because the shipped file is Hermes bytecode.
