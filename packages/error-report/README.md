# @space/error-report

Opt-in error reports to SpaceFleet's own Bugsink server (REL-LOG-06). Sentry-compatible SDKs, off until the user turns reporting on.

- `.` : `scrubErrorEvent` (allowlist scrubber used as `beforeSend`), `createReporterOptions`, `keepIntegrations`, `resolveDsn`, `createErrorReporting` (the opt-in gate).
- `./electron-main`, `./electron-renderer`, `./electron-preload`: Electron main process, renderer window and preload bridge. The renderer SDK is loaded only after opt-in and sends through the main process.
- `./react-native`: React Native (phone and TV), JavaScript errors only (the native SDK half stays off so nothing bypasses the scrubber).
- `./consent-file`: the user's answer (`on`, `off`, `undecided`) in a 0600 file the Electron main process can read before any window exists.
- `./desktop`, `./desktop-main`, `./desktop-renderer`: the desktop apps' opt-in (Badger, Parrot): the answer's state and IPC bridge, the main-process controller (consent file + SDK, `registerErrorReportsIpc`) and the window side that loads the renderer SDK only once the answer is "on".
- `./error-log`: the error log attached to feedback when the user ticks the box (UX-SUP-05): newest warning and error lines, scrubbed as they are recorded, and `clampLog` to the API's 200 KB.
- `./desktop-feedback`: the desktop apps' "Send feedback" sender for the main process (Badger, Parrot): the message, and the scrubbed error log only when the user ticked the box.
- `./build-config`: writes a phone app's gitignored `src/generated/errorReportConfig.ts` from its DSN environment variables at build time.

Badger and Parrot use the same modules (REL-FAM-03); the phone apps reach them through `@space/mobile-shell` (`./logger`, `./errorReporting`, `./feedback`).

A report carries the error, its stack trace, the app version and the operating system. Never a file name, title, path, URL, account detail or address. Native memory dumps (minidumps) are not collected: they can hold any of those.

DSNs are not in the source: each app bakes its own in at build time (`SF_BUGSINK_DSN_BADGER_DESKTOP`, `SF_BUGSINK_DSN_BADGER_MOBILE`, `SF_BUGSINK_DSN_BADGER_TV`, `SF_BUGSINK_DSN_PARROT_DESKTOP`, `SF_BUGSINK_DSN_PARROT_MOBILE`). A build without one cannot report.

Tests: `bunx vitest run` here; they include a real Sentry SDK reporting to a local stand-in for the ingest host.

## Licence

GPL-3.0-only (`LICENSE`) with the App Store additional permission of GPL-3.0 section 7 (`LICENSE-EXCEPTION.md`), which covers only code held by the SpaceBadger authors (REL-LIC-01).
