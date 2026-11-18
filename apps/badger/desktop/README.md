# Desktop Client

## Build
- `bun run --cwd apps/badger/desktop build`
- `bun run --cwd apps/badger/desktop package` (= `package:linux`: AppImage)
- `bun run --cwd apps/badger/desktop package:windows`: per-user NSIS installer (`Badger-Setup-<version>.exe` + `latest.yml`), signed with Azure Artifact Signing when the three signing secrets are set (see "Windows code signing" below), unsigned otherwise
  - one config for every target: `electron-builder.config.mjs` + the target table in `scripts/package-targets.mjs`; `node scripts/package.mjs --target linux-x64|windows-x64|macos-arm64|macos-x64` (Linux cross-builds Windows, needs `wine` for the exe icon/version edit; a Windows host builds the same output; the dmgs need a Mac for codesign/hdiutil)
  - Windows needs the bundled binaries first: `bun scripts/fetch-deps.ts --target windows-x64` (from the repo root); the build fails without `vendor/deps/windows-x64/bin`
  - `SF_UPDATE_FEED_URL` seeds the packaged `app-update.yml` feed (default `https://api.spacefleet.io/desktop/badger`); at runtime the app uses `<API base URL>/desktop/badger`
  - the runtime is compiled with `bun build --compile` and shipped as `<resources>/runtime/runtime[.exe]` with its slice manifests; OSC lua files ship in `<resources>/mpv/osc`
  - step timings and sha256 of every artifact land in `dist/package-report-<target>.json`
  - packaging fetches the shipped `media-deps` bundle (`bun scripts/fetch-deps.ts --target <id>`, cached by version + sha256; `--skip-fetch-deps` reuses `vendor/deps/<id>`) and `electron-builder` copies it to `<resources>/deps`; nothing is built from source while packaging
  - packaging no longer runs an in-place `npm install/prune` step inside the workspace package; it reuses the workspace install and materializes runtime deps directly, which keeps `workspace:*` dependencies compatible with packaging
  - Linux and Windows ship the same flat `deps/bin` (ffmpeg, ffprobe, mpv + libraries) built by `packages/media-deps`
  - runtime dependency materialization now prunes `better-sqlite3` source/build baggage so the packaged app only ships the native addon and runtime JS it actually needs
  - `app.asar` ships no source maps or `.d.cts`/`.d.mts` files and only the drizzle-orm directories the main process loads (`better-sqlite3`, `sqlite-core`, `sql`, `query-builders`, `cache`, and `pg-core` for one helper): `asarFileExcludes()` in `scripts/packaged-asar-lib.mjs` feeds `files`, `tests/packaged-asar.test.ts` proves with the installed drizzle-orm that no loaded file is excluded and every other dialect is, and the `verify` step fails the package if one slips back in. After a drizzle-orm upgrade that adds an import the test names the directory to add to `DRIZZLE_USED_DIRS`
  - only the Electron locales the UI supports ship (`en-US`, `fr`, `nl`, `de`, `es`, `es-419`; `ELECTRON_LANGUAGES` in `scripts/packaged-locales-lib.mjs`, guarded by `tests/packaged-locales.test.ts` against `CLIENT_UI_LANGUAGES`): 49 of Electron's 55 `locales/*.pak` are pruned on Linux and Windows, and the `verify` step fails the package if an unused locale slips back in or a UI one is missing (without its pak, Chromium reports en-US to `app.getLocale()` and the first start cannot pick the system language; Spanish also ships `es-419`, which Chromium picks for every Spanish system outside Spain); Chromium falls back to en-US for other OS languages. macOS keeps `en.lproj`, `fr.lproj`, `nl.lproj`, `de.lproj`, `es.lproj` and `es_419.lproj` (`MAC_ELECTRON_LANGUAGES`, checked by `verify`: "en-US" keeps the bare `en.lproj` and drops `en_GB.lproj`, and those folders are the app's localizations to macOS)
- `bun run --cwd apps/badger/desktop package:macos-arm64` / `package:macos-x64` (on a Mac): per arch a dmg (`Badger-<version>-<arch>.dmg`), the in-app update zip (`Badger-<version>-<arch>-mac.zip` + `.zip.blockmap`) and `latest-mac.yml` naming that zip (REL-MAC-03; CI merges the two arches' feeds with `bun scripts/installer-store.ts merge-mac-feeds`). Developer ID signed, notarized and stapled when the six `APPLE_*` variables are set (see "macOS code signing" below), ad-hoc signed otherwise
  - needs `vendor/deps/macos-<arch>` (`bin/{ffmpeg,ffprobe,sf-lifeline}`, `lib/`, `Badger Player.app`, `deps-manifest.json`, built by `packages/media-deps`)
  - `scripts/mac-after-pack.mjs` moves the mpv bundle to `Badger.app/Contents/Helpers/Badger Player.app` (checking its `CFBundleName` / `CFBundleDisplayName` read "Badger Player", REL-MAC-09), raises the app executable's minos from Electron's 13.0 to macOS 14.0 (`vtool`, Xcode command line tools; PLAT-DESK-02) and signs the app inside-out (Developer ID or ad-hoc). The unpacked app (`dist/mac-arm64/Badger.app` or `dist/mac/Badger.app`) is unregistered from Launch Services and deleted once the dmg and zip are built, so Spotlight never lists a build copy (REL-MAC-10); install the dmg to run it
  - the app is `Badger` on every OS; its data is in `~/Library/Application Support/Badger` on macOS and `<appData>/@sf/desktop` on Linux/Windows
- Windows release: the installer is built once, tested by sha256 and published from `badger-desktop-release-windows.yaml` only after a recorded manual full run on that exact installer (`bun scripts/installer-store.ts --target windows-x64`). macOS release: both dmgs are built once, tested by sha256 and published from `badger-desktop-release-macos.yaml` only after a recorded manual `macos-ultimate` run on both (`--target macos-arm64` / `macos-x64`)
- `bun run --cwd apps/badger/desktop package:report-size`
  - prints a deterministic packaged-size report for the current Linux build:
    - AppImage size
    - unpacked size
    - top-level resource payloads
    - largest packaged files
- `bun run --cwd apps/badger/desktop check:renderer-budgets`
  - validates the current built renderer against executable chunk budgets
    (`scripts/check-renderer-budgets-lib.mjs`, the single source for these
    numbers; the layer4 `test:layer4:perf:desktop` suite reuses it) for:
    - `index` (the renderer entry chunk that `index.html` loads)
    - `AuthenticatedApp`
    - `TopNav`
    - `TopNavJobsSidebarContent`
    - `FileIngestionDialog`
  - chunks are resolved exactly from the Vite manifest
    (`out/renderer/.vite/manifest.json`), never by filename prefix; a budgeted
    chunk that resolves to zero or several chunks fails the check
  - runs in `ci:desktop` after `build`, and in the PR CI `desktop-static` job
- `bun run --cwd apps/badger/desktop memory:report`
  - builds the app and captures a repeatable Electron memory baseline for:
    - idle login
    - active external `mpv` playback
    - authenticated onboarding key
    - authenticated empty home
    - authenticated home with ingest running
    - authenticated media library
    - backgrounded from media library (no renderer window)
    - this baseline now also reflects the production split where:
      - the dev-only `DebugSidebar` is not shipped at all
      - dashboard dialogs and edit-mode DnD load lazily
      - library dialogs and playlists now lazy-load instead of inflating the base media-library route
  - reports:
    - route
    - DOM node count
    - renderer JS heap
    - Electron per-process working-set totals
  - recent W1 dialog-splitting follow-up:
    - `FileIngestionDialog` secondary modals (video-choice resolution, dummy ingest, trailer picker/player) are now lazy secondary chunks instead of staying bundled into the main ingestion dialog chunk
    - current build emits dedicated chunks for:
      - `FileIngestionResolveVideoDialog`
      - `FileIngestionDummyDialog`
      - `FileIngestionTrailerDialogs`
    - `MediaDetailsDialog` secondary action flows (restore, trailer player, delete confirmation, playlist picker) are now split into a dedicated lazy secondary chunk:
      - `MediaDetailsActionDialogs`
    - `Settings` recovery/show-key/reset modal UI is now split into a dedicated lazy secondary chunk:
      - `SettingsRecoveryDialogs`
    - `Dashboard` add-section picker UI is now split into a dedicated lazy secondary chunk:
      - `DashboardAddSectionDialog`
    - `Account` two-factor management and delete-confirmation UI are now split into dedicated lazy secondary chunks:
      - `AccountTwoFactorSection`
      - `AccountDeleteDialog`

## Windows code signing

Official Windows builds are signed with Azure Artifact Signing (REL-INST-03), publisher `PENA Chris-Alexandre`.
Signed installers install on PCs with Smart App Control on (REL-WIN-03) and SmartScreen names the publisher.

How it works: electron-builder's `win.azureSignOptions` and `win.signExts` (`electron-builder.config.mjs`, values
from `scripts/windows-signing-lib.mjs`) sign `Badger.exe`, every `.exe`, `.dll` and `.node` in the app folder and
under `resources\` (runtime, ffmpeg, ffprobe, mpv and their FFmpeg DLLs), the uninstaller and the installer. It uses
the `TrustedSigning` PowerShell module (`Invoke-TrustedSigning`, needs the .NET 8 SDK). Then the `signatures` step of
`scripts/package.mjs` checks with `Get-AuthenticodeSignature` that the installer and every unpacked PE file are signed
and timestamped, and fails the package otherwise. Unsigned DLLs are what broke Badger 0.1.2 under Smart App Control:
Code Integrity refused to load the FFmpeg DLLs, so ffprobe exited 2 and mpv could not play.

Every signature is timestamped (RFC 3161) by `http://timestamp.acs.microsoft.com` with SHA256 digests
(`WINDOWS_TIMESTAMP_RFC3161`), so it keeps validating after the short-lived certificate expires.

The packaging reads these environment variables:

| Name | Kind |
|------|------|
| `AZURE_TENANT_ID` | required to sign |
| `AZURE_CLIENT_ID` | required to sign |
| `AZURE_CLIENT_SECRET` | required to sign |
| `AZURE_SIGNING_ENDPOINT` | optional, `https://<region>.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT` | optional |
| `AZURE_SIGNING_CERT_PROFILE` | optional |

What the build does with them:
- none set: it builds unsigned and prints `Windows signing not configured (...): building unsigned, REL-INST-03 pending`.
  This is the normal case for a local rebuild;
- anything set but a secret missing, or a malformed endpoint: the build fails;
- the three secrets set: it signs, and any signing failure fails the build. Signing only runs on a Windows host.

`WINDOWS_UPDATE_PUBLISHER_NAME` in `scripts/windows-signing-lib.mjs` sets the publisher the installed app requires on
Windows updates. While it is null the updater does not check the publisher.

## macOS code signing

Official macOS dmgs are signed with the Developer ID of team `8766H6KW4V` and notarized by Apple (REL-MAC-02).

How it works: `scripts/package.mjs` resolves the six `APPLE_*` variables (`resolveMacSigning` in
`scripts/mac-signing-lib.mjs`) and, on a Mac, opens a throwaway keychain in a temp dir with the `.p12` and Apple's
Developer ID G2 intermediate (`installer/DeveloperIDG2CA.cer`). electron-builder does not sign (`identity: null`): the
`afterPack` hook `scripts/mac-after-pack.mjs` signs every Mach-O file and nested bundle inside-out with
`--options runtime --timestamp --entitlements installer/entitlements.mac.plist`, then notarizes and staples the app.
The `notarize` step signs, notarizes and staples the dmg and checks it with `stapler validate` and
`spctl --assess --type open`. On exit the keychain, `.p12` and `.p8` are deleted.

The entitlements are `allow-jit` and `allow-unsigned-executable-memory` (V8 and the bun runtime JIT) and
`disable-library-validation` (mpv's dylibs and the `.node` addons are signed by us, not Apple).

The keychain only works in a GUI login session: over SSH, `find-identity` reports no valid identity.

| Name | Value |
|------|-------|
| `APPLE_DEVID_P12_BASE64` | the Developer ID Application certificate and key, `.p12`, base64 |
| `APPLE_DEVID_P12_PASSWORD` | the `.p12` password |
| `APPLE_NOTARY_KEY_P8_BASE64` | an App Store Connect API key, `.p8`, base64 |
| `APPLE_NOTARY_KEY_ID` | its key ID |
| `APPLE_NOTARY_ISSUER_ID` | the App Store Connect issuer ID |
| `APPLE_TEAM_ID` | the 10-character team ID |

What the build does with them: none set, it signs ad-hoc and does not notarize, which is enough for a local
rebuild; all six set, it signs with the Developer ID and notarizes; only some set, or a team ID that is not 10
characters, the build fails. Signing on a non-Mac host fails before building.

Sources: Apple [notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[hardened runtime](https://developer.apple.com/documentation/security/hardened-runtime); electron-builder
[Windows code signing](https://www.electron.build/code-signing-win).

## Platform layer
- All OS-dependent behavior (binary lookup, mpv IPC endpoint, process groups, suspend/throttle, hardware encoders, display/shell hooks) lives in `packages/desktop-platform-*`; desktop code calls `getDesktopPlatform()` from `@space/desktop-platform` and never checks the OS (`tests/tools/no_os_branching.test.ts` enforces it)
- run the conformance suite on the current OS: `bun packages/desktop-platform/src/conformance-cli.ts`

## Dev
- `bun run --cwd apps/badger/desktop dev`
- default Electron remote-debugging port for dev is `9222` so the Electron MCP can attach
- override with `SF_DEVTOOLS_PORT=<port>` when needed
- desktop metadata now uses a dedicated `spacebadger.desktop` identity so it does not group with other Electron apps in the OS taskbar

Shared logging env (desktop main process):
- `SF_LOG_LEVEL` (default `info`)
- `SF_LOG_PRETTY` (`1` to force pretty logs)

Dev flag examples:
- `bun run --cwd apps/badger/desktop dev -- --log-level=debug`
- `bun run --cwd apps/badger/desktop dev -- --log-level=warn --no-log-pretty`

## Tests
- `bun run --cwd apps/badger/desktop test`
- `bun run --cwd apps/badger/desktop test:integration`
- `bun run --cwd apps/badger/desktop test:e2e`
- `bun run --cwd apps/badger/desktop test:e2e:headed`

`test:e2e` forwards extra arguments to `playwright test` (a file, `--grep <re>`). CI: the
`desktop-e2e` CI workflow runs it nightly on staging, on dispatch, and on PRs labelled `e2e`
(never part of `ci-success`). Electron traces: Playwright's `use.trace` does
not cover `_electron.launch`, so `e2e/_helpers/electronTest.ts` (the `test`/`expect` every e2e file
imports) records one per launched app; `SF_E2E_TRACE=retain-on-failure` (CI default) keeps failed
tests' traces under `test-results/`, `on` keeps all, `off` (local default) disables it. New e2e files
must import `test`/`expect` from `./_helpers/electronTest`, not `@playwright/test`.

Every `electron.launch` in `tests/`, `e2e/` and `scripts/` passes `...TEST_KEYCHAIN_ARGS` from
`scripts/test-keychain-args.mjs` (`--use-mock-keychain`) before the entrypoint, so safeStorage never opens the login
keychain: on macOS a rebuilt, ad-hoc-signed Electron otherwise stops the run at a password prompt.
`tests/test-keychain-args.test.ts` fails on a launch without it. On macOS, `scripts/run-headless.sh` (which wraps
`test:integration:electron` and `test:e2e`) runs the suite under `caffeinate -d -i -u`, because with the display
asleep mpv cannot start DisplayLink and playback never advances.

A fresh checkout (e.g. a new Mac) must run `bun run fixtures:v2-ingest:generate` once at the repo root before
`test:e2e`: it builds the git-ignored v2 ingest media under
`packages/ingest-core/fixtures/ingest/v2-synthetic/.cache/` (`large.mkv` etc.), without which
`e2e/storage-hygiene.e2e.test.ts` fails with `fixture missing`.

Current tests cover deterministic helper logic plus main-process IPC integration (`libraryDbIpc` handler registration, call routing, and dataset-status event emission).
Relevant runtime-ingest bridge regression:
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-ipc.integration.test.ts`
  - proves runtime-backed `cancel`/`start` lab queue actions use `runtime.jobs` mutations without forcing a post-action `listRuntimeJobs` poll.
  - desktop now forwards the advanced `maxParallelTranscodes` setting into runtime queue config so bounded CPU concurrency follows user preference instead of a hardcoded slot count.
  - runtime now clamps that preference against the actual host concurrency budget, so weaker machines do not overcommit CPU just because the setting was raised.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-ipc.integration.test.ts tests/lab-queue-runtime-finalization.integration.test.ts`
  - proves runtime-backed queue mutations stay push-first and that both queue modes still finalize completed ingest jobs into the local library DB through the shared finalization path.
  - runtime-backed queue state is now split in desktop main between:
    - canonical runtime snapshots from `runtime.jobs`
    - a thin local finalization projection layer for explicit finalization patch fields only (`linked/fileId/formatsCreated/tracksAdded/status/error/completedAt`)
  - runtime auth, Badger command calls, shared job listing, and shared cancel/retry calls now live in `src/main/labQueueRuntimeClient.ts` instead of in the queue service class.
  - canonical `runtime.jobs` to Badger `LabJob` mapping now lives in `src/main/labQueueRuntimeMapping.ts` instead of in the queue service class.
  - runtime snapshot/local finalization merging now lives in `src/main/labQueueProjection.ts`, keeping that policy out of the queue transport/session class.
  - finalization policy itself now lives in `src/main/labQueueFinalization.ts`, so `labQueue.ts` no longer embeds the library-linking/format-track persistence stages directly.
  - desktop main no longer treats that local projection as the durable ingest source of truth.
  - queue `open/apply` now re-bootstrap from canonical `runtime.jobs`; `badger.ingest.open/apply` job arrays are compatibility fallback only.
  - desktop-main runtime queue types/tests now assume the slim runtime command acknowledgements by default; only dedicated fallback regressions still exercise command-body `jobs` arrays.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-finalization.test.ts`
  - proves the dedicated finalization adapter can link completed jobs, persist formats/tracks, emit the library snapshot, and clean up artifacts without depending on the queue service class.
  - queue-specific orchestration now delegates the raw local-library write contract to `src/main/labQueueLibraryCommit.ts`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-projection.test.ts`
  - proves canonical runtime snapshots and local finalization patches are merged/dropped by the dedicated projection helper instead of by `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-client.test.ts`
  - proves the dedicated runtime queue client re-logins once on stale runtime-session 401s instead of leaving that retry policy embedded only in the queue service integration path.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-mapping.test.ts`
  - proves canonical runtime-job stage/status payloads are projected into the Badger queue job model by a dedicated mapper instead of by `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-feed.test.ts`
  - proves runtime queue stream startup, polling fallback, and watchdog refresh now live in a dedicated feed helper instead of inside `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-session.test.ts`
  - proves runtime queue user/config state, library-key replay, and shared cancel/retry translation now live in a dedicated runtime session helper instead of inside `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-mirror.test.ts`
  - proves runtime snapshot projection, local finalization coordination, and watchdog refresh posture now live in a dedicated runtime mirror helper instead of inside `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-emitter.test.ts`
  - proves renderer queue-event delivery and dedupe/reset behavior now live in a dedicated runtime emitter helper instead of inside `RuntimeLabQueueService`.
- `bun run --cwd apps/badger/desktop test -- tests/file-ingestion-secondary-dialogs.test.tsx`
  - proves the extracted secondary `FileIngestionDialog` seams still route actions correctly after being split into dedicated lazy dialog components.
- `bun run --cwd apps/badger/desktop test -- tests/file-ingestion-tracks.test.ts`
  - proves the extracted `FileIngestionDialog` track/video grouping helper keeps language-review, codec-selection, and merge policy deterministic after moving that logic out of the main dialog component.
- `bun run --cwd apps/badger/desktop test -- tests/file-ingestion-decisions.test.ts`
  - proves the extracted `FileIngestionDialog` duplicate-quality decision planner keeps TV slot labeling and overlap counting deterministic after moving that logic out of the main dialog component.
- `bun run --cwd apps/badger/desktop test -- tests/file-ingestion-inputs.test.ts`
  - proves the extracted `FileIngestionDialog` undefined-track input planner keeps language-review row generation and candidate grouping deterministic after moving that logic out of the main dialog component.
- `bun run --cwd apps/badger/desktop test -- tests/media-details-action-dialogs.test.tsx`
  - proves the extracted secondary `MediaDetailsDialog` action dialogs still route restore, trailer, delete, and playlist actions correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/media-details-jobs.test.ts`
  - proves the extracted `MediaDetailsDialog` processing/job summary helper keeps media-scoped job filtering, terminal-state handling, and blended progress deterministic after moving that logic out of the dialog component.
- `bun run --cwd apps/badger/desktop test -- tests/library-remote-sync-stream.test.ts`
  - proves the extracted library remote-sync stream controller still enforces quick-failure stream disable, external-mpv pause/resume, and forced logout on fallback `401` without depending on the full `libraryContext` provider.
- `bun run --cwd apps/badger/desktop test -- tests/library-delete-media.test.ts`
  - proves deleting media retries `remove_media_jobs` by reopening the runtime-backed lab queue once before proceeding, so stale queue sessions do not leave ghost queued tiles behind after the library row is removed.
- `bun run --cwd apps/badger/desktop test -- tests/library-snapshot-cache.test.ts`
  - proves the extracted library snapshot cache helper keeps cached snapshot parsing, persistence, and invalid-cache handling deterministic after moving that logic out of `libraryContext`.
- `bun run --cwd apps/badger/desktop test -- tests/library-snapshot-persister.test.ts tests/renderer-flush-before-destroy.test.ts`
  - proves the snapshot cache write is coalesced, bounded under continuous playback churn (no starvation), idle-scheduled, flushed on pagehide and before close-to-tray's `win.destroy()`, and cancelled on logout. `node scripts/measure-snapshot-persist.mjs` measures the per-write cost and the before/after policies in a real Electron renderer.
- `bun run --cwd apps/badger/desktop test -- tests/session-store.test.ts tests/session-mirror.test.ts`
  - proves the signed-in session (auth token, cached user, library key + ack) survives an abrupt kill / crash (#25). After SIGKILL about 30% of relaunches rendered the Login page with an empty Chromium `localStorage`; the session now also lives in `<userData>/session.json`, written by the main process (`main/sessionStore.ts`: encrypted with the async `safeStorage` API (`encryptStringAsync` / `decryptStringAsync`; a file the async API cannot open is opened with the legacy sync `decryptString` while Electron 45 still has it and rewritten with `encryptStringAsync`, ACCT-AUTH-08) when the OS keyring is available, else an owner-only 0600 file; main awaits `sessionStore.load()` before creating the first window; tmp file -> fsync -> rename -> fsync dir, so durable before the IPC returns). The preload reads it synchronously (`window.sf.session.snapshot`); `renderer/lib/sessionMirror.ts` refills missing `localStorage` keys before the first render and mirrors every session write/clear back (a logout or 401 clears main's copy too, so a cleared session is never resurrected).
- `bun run --cwd apps/badger/desktop test -- tests/route-survives-kill.test.ts`
  - proves the last authenticated route (`sf_last_authenticated_route`) rides the same main-process session mirror (#25): after a SIGKILL / crash that hands the renderer an empty `localStorage`, the relaunch refills the route from `<userData>/session.json` and `resolveInitialAuthenticatedRoute` reopens it instead of staying on `/home`. The latest route wins across navigations, clearing it is durable (a cleared route is never resurrected), login/bootstrap routes are never mirrored, a route already in `localStorage` is never overwritten by main's copy, and a restored `/home?media=` route still resolves exactly as `tests/route-persistence.test.ts` pins (the ultimate harness drops that query before going Home, #203).
- `bun run --cwd apps/badger/desktop test -- tests/logout-clears-route.test.tsx`
  - proves logout leaves no last authenticated route behind (#25). RequireAuth unmounts the shell in the signed-out commit without re-rendering it, so the shell's flush-on-leave hook (`lib/useRouteFlushOnLeave.ts`) used to write the route straight back from its unmount cleanup, to `localStorage` and to main's `session.json`, and the next user to sign in was restored onto the previous user's page. The hook now flushes only while the auth token (`AUTH_TOKEN_KEY`, which logout removes before it clears the route) is still stored, including for a `pagehide` / `beforeunload` that lands mid-logout. While the session is alive, leaving a location, `pagehide` and unmounting still flush the current route.
- `bun run --cwd apps/badger/desktop test -- tests/library-shell-data.test.ts`
  - proves the extracted library shell-state helper keeps shell readiness/status focused on loading, sync state, write-blocking, and media count so shell UI does not subscribe to the full library payload.
- `bun run --cwd apps/badger/desktop test -- tests/app-backdrop.test.tsx`
  - proves the lighter authenticated-shell backdrop still renders the expected reduced node structure after replacing the old 140-star field.
- `bun run --cwd apps/badger/desktop test -- tests/settings-recovery-dialogs.test.tsx`
  - proves the extracted `Settings` recovery dialogs still route show-key, rotate-key, reset, and resend actions correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/dashboard-add-section-dialog.test.tsx`
  - proves the extracted `Dashboard` add-section picker still routes system, genre, and playlist picks correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/library-delete-dialog.test.tsx`
  - proves the extracted `Library` delete-confirmation dialog still routes cancel/confirm actions correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/account-two-factor-section.test.tsx`
  - proves the extracted `Account` two-factor management section still routes enable, disable, and secret-copy actions correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/account-delete-dialog.test.tsx`
  - proves the extracted `Account` delete-confirmation dialog still routes cancel/confirm actions correctly after being moved into a dedicated lazy component.
- `bun run --cwd apps/badger/desktop test -- tests/mpv-playback-selection.test.ts`
  - proves the extracted playback selection helper keeps format/audio/subtitle/chapter/skip-marker policy deterministic after moving that logic out of `useMpvPlaybackEngine`.
- `bun run --cwd apps/badger/desktop test -- tests/mpv-playback-state.test.ts`
  - proves the extracted playback state helper keeps fallback/effective format resolution, playable-audio fallback, and signature generation deterministic after moving that logic out of `useMpvPlaybackEngine`.
- `bun run --cwd apps/badger/desktop test -- tests/mpv-playback-resilience.test.ts tests/mpv-playback-maps.test.ts tests/mpv-playback-selection.test.ts tests/media-playback-controller.integration.test.tsx`
  - covers the split playback seam end to end:
    - pure format/chunk-map/selection helpers
    - paused-launch resilience for external `mpv`
    - controller integration against the playback hook contract
- `bun run --cwd apps/badger/desktop test -- tests/lab-queue-runtime-controller.test.ts`
  - proves the remaining runtime-backed queue open/apply/close orchestration now lives in `src/main/labQueueRuntimeController.ts` instead of staying embedded in `labQueue.ts`.
  - queue selection, active-queue state, and IPC registration now live in `src/main/labQueueRegistry.ts`, and the deprecated legacy main-process queue engine has been removed.

The end-to-end harnesses (Playwright `e2e/`, the ultimate stress suite, VM and perf runs) live in `e2e/` and `e2e-ultimate/`.

## Current measured Linux package result
- AppImage: `132.7 MiB`
- unpacked app: `361.1 MiB`
- largest packaged payloads:
  - `deps/bin`: `44.1 MiB` for ffmpeg + ffprobe + mpv + libraries (`media-deps-linux-x64`, FFmpeg 8.1.3, host glibc >= 2.35); before the cutover this was `mpv/linux-bundle` 45.8 MiB + `ffmpeg` 16.8 MiB
  - `app.asar`: `13.2 MiB`

## Current measured Electron memory baseline
- `bun run --cwd apps/badger/desktop memory:report`
- current production-build sample:
  - idle login:
    - Electron working set: `730.0 MiB`
    - renderer JS heap: `16.3 MiB`
  - external playback active:
    - Electron working set: `733.9 MiB`
    - renderer JS heap: `16.3 MiB`
  - authenticated onboarding key:
    - Electron working set: `760.4 MiB`
    - renderer JS heap: `16.3 MiB`
  - authenticated empty home:
    - Electron working set: `790.8 MiB`
    - renderer JS heap: `16.3 MiB`
  - authenticated home with ingest running:
    - Electron working set: `806.3 MiB`
    - renderer JS heap: `16.3 MiB`
  - authenticated media library:
    - Electron working set: `815.5 MiB`
    - renderer JS heap: `16.3 MiB`
  - backgrounded from media library:
    - Electron working set: `501.5 MiB`
    - renderer JS heap: `0.0 MiB`
- biggest process buckets today:
  - foreground `Browser`: `272-295 MiB`
  - foreground `Tab`: `218-269 MiB`
  - foreground `GPU`: `159-165 MiB`
  - backgrounded `Browser`: `290.5 MiB`
  - backgrounded `GPU`: `124.0 MiB`
- current production renderer chunk shape:
  - `Dashboard`: `48.4 kB`
    - add-section dialog chunk split out:
      - `DashboardAddSectionDialog`: `6.72 kB`
  - `DashboardEditLayout`: `119.8 kB`
  - `MediaPlaybackController`: `77.2 kB`
  - `Library`: `59.2 kB`
    - delete dialog chunk split out:
      - `LibraryDeleteDialog`: `1.98 kB`
  - `Account`: `36.1 kB`
    - two-factor section chunk split out:
      - `AccountTwoFactorSection`: `34.52 kB`
    - delete dialog chunk split out:
    - `AccountDeleteDialog`: `1.44 kB`
  - `useMpvPlaybackEngine` playback selection policy now lives in:
    - `src/renderer/src/lib/mpvPlaybackSelection.ts`
    - the hook is down to `1533` lines from `1600`
  - `useMpvPlaybackEngine` playback format/audio state derivation now also lives in:
    - `src/renderer/src/lib/mpvPlaybackState.ts`
    - the hook is down to `1472` lines from `1533`
  - `FileIngestionDialog` track/video grouping policy now lives in:
    - `src/renderer/src/components/fileIngestionTracks.ts`
    - the dialog is down to `4046` lines from `4185`
  - `FileIngestionDialog` TV/movie merge and season grouping policy now also lives in:
    - `src/renderer/src/components/fileIngestionGroups.ts`
    - the dialog is down to `3960` lines from `4046`
  - `FileIngestionDialog` duplicate-quality decision planning now also lives in:
    - `src/renderer/src/components/fileIngestionDecisions.ts`
  - `FileIngestionDialog` undefined-track input planning now also lives in:
    - `src/renderer/src/components/fileIngestionInputs.ts`
    - the dialog is down to `3831` lines from `3960`
  - `MediaDetailsDialog`: `148.8 kB`
    - secondary action chunk split out:
      - `MediaDetailsActionDialogs`: `7.60 kB`
    - processing/job summary policy now also lives in:
      - `src/renderer/src/lib/mediaDetailsJobs.ts`
    - the dialog is down to `2895` lines
  - `Settings`: `75.7 kB`
    - recovery modal chunk split out:
      - `SettingsRecoveryDialogs`: `15.06 kB`
  - `FileIngestionDialog`: `452.0 kB`
    - secondary dialog chunks now split out:
      - `FileIngestionResolveVideoDialog`: `3.15 kB`
      - `FileIngestionTrailerDialogs`: `3.61 kB`
      - `FileIngestionDummyDialog`: `4.46 kB`
  - `libraryContext` snapshot cache persistence now also lives in:
    - `src/renderer/src/lib/librarySnapshotCache.ts`
    - the provider is down to `1881` lines
  - `libraryContext` reset/teardown semantics now also live behind:
    - `src/renderer/src/lib/libraryStateReset.ts`
    - repeated logout/startup/local-cache-reset state clearing now reuses one tested helper instead of duplicating full library-state teardown blocks inline across the provider
  - shell-facing library status now also lives behind:
    - `src/renderer/src/lib/libraryShellData.ts`
    - `TopNav` and `RequireClientReady` now subscribe to shell-focused library state instead of the full library payload
    - the shell value is now rebuilt from primitive dataset readiness flags so equivalent dataset-status object churn does not force shell rerenders
  - authenticated shell backdrop now uses:
    - `src/renderer/src/components/AppBackdrop.tsx`
    - the original seeded starfield structure, generated once at module load and memoized so authenticated-shell rerenders do not touch the backdrop subtree
  - remote ingest-job projection now also lives behind:
    - `src/renderer/src/lib/labJobsRemote.ts`
    - `LabJobsProvider` no longer resolves library details for every media row on each ingest update; it now only resolves details for media ids referenced by non-local remote ingest jobs
    - remote committed ingest projection now also runs from deferred ingest state so background ingest churn is less eager in the renderer
  - lab-jobs merge and window-processing state now also lives behind:
    - `src/renderer/src/lib/labJobsState.ts`
    - `LabJobsProvider` now reuses pure helpers for merged queue ordering, active/completed splits, and window-processing detection instead of rebuilding that logic inline on every update
  - lab-jobs update scheduling now also lives behind:
    - `src/renderer/src/lib/labJobUpdateScheduler.ts`
    - `LabJobsProvider` no longer waits behind the old fixed `350ms` queue-update timer; updates now coalesce onto the next frame with a short max delay so queue actions feel more immediate under ingest churn
  - media-library identity dedupe now also lives behind:
    - `src/renderer/src/lib/libraryMediaDedupe.ts`
    - duplicate-row merging now runs as a one-pass aggregate helper instead of repeatedly scanning each identity group inside `libraryContext`
  - queue job-card derivation now also lives behind:
    - `src/renderer/src/components/labJobCardState.ts`
    - `LabJobCard` no longer derives manual match search, pending episode-selection state, and estimated output totals inline on every render
  - queue job presentation now also lives behind:
    - `src/renderer/src/components/labJobPresentation.ts`
    - `LabQueuePanel` now reuses pure helpers for active/completed job labels, chips, help text, start/upload state, and completion metadata instead of rebuilding that display policy inline across multiple queue sections on every render
  - queue view-state shaping now also lives behind:
    - `src/renderer/src/components/labQueueViewState.ts`
    - `LabQueuePanel` now reuses a pure helper for media-filtered queue slices and single-media TV-mode detection instead of scattering that filtering/grouping posture across the component
  - top-nav notification persistence now also lives behind:
    - `src/renderer/src/components/topNavNotifications.ts`
    - `TopNav` now reuses pure helpers for storage parsing, merge/update, unread counting, and no-op mark-read handling instead of rebuilding that logic inline
  - top-nav p2p notification policy now also lives behind:
    - `src/renderer/src/components/topNavP2p.ts`
    - `TopNav` now reuses pure helpers for notification routing/toast policy and demotes live p2p notification updates with `startTransition(...)` so background notification churn is less likely to compete with shell interactions
    - `TopNav` is also memoized, so parent page rerenders do not automatically rerender the authenticated shell frame when nav state itself is unchanged
  - notification tray state/effects now also live behind:
    - `src/renderer/src/components/TopNavNotificationsButton.tsx`
    - live p2p badge state, notification persistence, and sheet-open state are now isolated from the rest of `TopNav`, so opening the tray no longer routes that churn through the whole authenticated nav shell
  - external mpv metadata shaping now also lives behind:
    - `src/renderer/src/lib/mpvExternalMetadata.ts`
    - `useMpvPlaybackEngine` now reuses pure helpers for external subtitle/chapter/audio/playback payload shaping and mpv script-message command generation
  - the app-side seek clamp lives behind:
    - `src/renderer/src/lib/mediaPlaybackTimeline.ts`
    - `resolveSeekDuration` falls back to mpv's live `duration` when the engine poll has not landed one yet
  - lab media detail indexing now also lives behind:
    - `src/renderer/src/lib/labMedia.ts`
    - lab queue/storage views now reuse an indexed media-details lookup instead of repeatedly scanning full `mediaDetails` arrays
    - `LabQueuePanel` now stays on the lightweight `useLabMediaIndex()` path instead of subscribing to the eager `mediaDetails[]` array used by storage-specific screens
  - library list view-state shaping now also lives behind:
    - `src/renderer/src/pages/libraryViewState.ts` (active-job aggregation, ghost-tile merge)
    - `packages/shared/src/libraryView.ts` (`@space/shared/libraryView`: filter, sort and view-preference helpers shared with the mobile app)
    - the library page reuses these pure helpers instead of rebuilding that logic inline
  - library view options (Movies / TV tabs):
    - view mode (Posters / Compact list / Details list), sort field and sort direction are remembered per tab on this computer in `ClientConfig.libraryView`
    - search, genre and actor filters are component state and start empty each time the library is opened
    - `src/renderer/src/pages/LibraryListViews.tsx` renders the two list views
  - dashboard list view-state shaping now also lives behind:
    - `src/renderer/src/lib/dashboardState.ts`
    - the dashboard page now reuses pure helpers for section list filtering and recent-sort shaping instead of rebuilding that logic inline

Desktop now disables Electron hardware acceleration by default because media playback is handled by external `mpv`, not Chromium. Re-enable it only when needed:
- `SF_ELECTRON_ENABLE_HARDWARE_ACCELERATION=1`

Desktop also disables Electron spellcheck by default because the app does not need browser spellchecking and the memory baseline is better without it. Re-enable only when needed:
- `SF_ELECTRON_ENABLE_SPELLCHECK=1`

## Native SQLite binding
- `better-sqlite3` 13 is a Node-API addon. Its npm tarball carries one prebuilt binary per platform (`prebuilds/{linux,linuxmusl,darwin,win32}-{x64,arm64}.node`), and the same binary loads under Node, Electron and every future Electron major. There is no install script, no Electron rebuild and no per-ABI binding cache.
- Bun 1.3 still runs `node-gyp rebuild` for any trusted package that ships a `binding.gyp`, even when it sets `"gypfile": false`. The root `package.json` therefore lists `trustedDependencies` explicitly (`esbuild` only), which drops `better-sqlite3` from Bun's default trusted list. Do not add `better-sqlite3` back.
- If the binding still fails to load (a platform without a prebuild, a damaged install), opening the library DB in direct-SQLite mode returns "Native SQLite binding mismatch: …" guidance: reinstall the app, or run `bun install` in a dev checkout.
- Packaging keeps only the prebuilds for the platform being packaged (`scripts/materialize-runtime-deps-lib.mjs`), and `asarUnpack: **/*.node` keeps them loadable outside the asar.

## Electron binary
- From Electron 42 on, the `electron` package has no postinstall. The binary downloads on the first `require("electron")`, or explicitly with `bunx --no-install install-electron` run from `apps/badger/desktop`. Bun's isolated linker exposes electron's bin only inside the workspaces that depend on it, and `--no-install` keeps `bunx` from fetching the unrelated `install-electron` npm package if the bin is missing.
- electron-vite never calls `require("electron")`; it reads electron's `path.txt` itself and fails with `Error: Electron uninstall` when the binary is missing. The dev launcher (`scripts/dev.mjs`) therefore calls `scripts/ensure-electron-binary.mjs` first, so `turbo run dev --filter=@space/badger-desktop` works right after a fresh `bun install`.
- Run it once after `bun install`, before parallel Playwright workers start, so they do not race on the download. The ultimate-stress and release workflows do this already.
- SpaceBadger desktop pins Electron 45. In each app `electron` and `build.electronVersion` must match; `tests/native-deps.test.ts` checks it. Electron 44 no longer runs on macOS 12 (support was dropped upstream); SpaceBadger's minimum is macOS 14 Sonoma (Chris, 2026-10-16). Electron 44 and later ship 64-bit builds only (no win32-ia32, no linux-armv7l), and links ANGLE statically, so there is no `libEGL`/`libGLESv2` file to filter or unpack.

## Tunnel env
- Storage Tunnel v2 tunnel upload path is enabled by default.
- Default behavior: desktop asks API for storage placement policy and chooses gateway per object key.
- Playback/download path prefers WebSocket streaming first (`preferWsDownloadStream=true`) and only falls back to HTTP frame/binary routes on explicit stream failure.

## Runtime host overrides
- In development builds only (`electron-vite dev`, `build:test`; ACCT-AUTH-09), the settings icon on the login/signup screens sets a custom API host. Those builds trust the dev and production ticket keys (META-ANON-07).
- This value is persisted locally (`runtime-config.json`) and remains after logout. A release build has no settings icon there and ignores a stored value: it talks to the production API only.

## Tray behavior
- When tray support is available, closing the window now backgrounds the app by destroying the `BrowserWindow` while keeping Electron main, tray, and runtime-backed background work alive.
- Reopening from tray recreates the main window instead of restoring a hidden Chromium window.
- The renderer now restores the last meaningful authenticated route after window recreation, including media-library query state.
- Current measured result: backgrounding from the heaviest authenticated `media-library` state drops Electron working set from about `815.5 MiB` to about `501.5 MiB`.
- Real exit is explicit (`Quit` from tray menu, app quit shortcuts, or OS quit).
- If processing is active, quit shows a confirmation dialog.
- If tray support is unavailable, close falls back to normal app exit behavior.

## Skip markers
- Desktop playback now prefers provider-backed skip markers from TheIntroDB — asked through the SpaceBadger metadata service with an anonymous ticket (META-SKIP-01; the desktop never calls TheIntroDB itself) — and persists both marker rows and provider hit/miss state locally in SQLite.
- Internal skip detection remains the fallback path when provider markers are missing. That fallback now uses the POC-tuned season consensus/profile flow instead of the older single-episode sibling heuristic.
