# Parrot on iPhone

The iPhone build of Parrot's phone app (react-native-tvos 0.88, iPhone only, portrait). The JS is the same as Android's;
the three native pieces are Swift ports in their workspace packages, autolinked as pods:

- `@space/mobile-audio-playback` (`AudioPlayback`): the music player, background audio (`UIBackgroundModes` `audio`).
- `@space/mobile-media-proxy` (`MediaProxy`): `PlaybackBridge` (loopback proxy for the storage tunnel) and
  `DownloadsBridge` (kept albums and playlists, background `URLSession` `<bundle id>.downloads`, forwarded from
  `AppDelegate.handleEventsForBackgroundURLSession`).
- `@space/mobile-media-volume` (`MediaVolume`).

There is no libmpv in Parrot (that pod is Badger's only).

## Project

`ios/project.yml` (XcodeGen) is the source of `Parrot.xcodeproj`; after editing it run `xcodegen generate` in `ios/`.

| Configuration | Bundle id                    | Name         | Plain HTTP              |
| ------------- | ---------------------------- | ------------ | ----------------------- |
| Debug         | `io.spacefleet.parrot.debug` | "Parrot Dev" | allowed (dev stack)     |
| Release       | `io.spacefleet.parrot`       | "Parrot"     | loopback only (ATS)     |

The Debug id installs beside the TestFlight build. Team `8766H6KW4V`, automatic signing. Pass
`PARROT_ALLOW_CLEARTEXT=YES` to a Release build that talks to a dev stack on another machine.

The library database lives in `Library/LocalDatabase/parrot.library.sqlite` on the iPhone (react-native-sqlite-storage's
`default` location on iOS). On the Apple TV it lives in `Library/Caches/parrot.library.sqlite`: tvOS lets an app write
only to Caches on the device, and the patched plugin keeps a `Documents` database there
(`packages/mobile-shell/src/appData.ts`, shared with Badger).

## Build (simulator)

```
cd apps/parrot/mobile/ios && xcodegen generate && LANG=en_US.UTF-8 pod install
cd .. && PARROT_API_BASE_URL=http://127.0.0.1:3000 bun run start --reset-cache   # Metro on :8081
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -workspace ios/Parrot.xcworkspace -scheme Parrot -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ios/build build
```

The API URL is inlined into the bundle (`babel-plugin-api-base-url.js`): restart Metro with `--reset-cache` after
changing `PARROT_API_BASE_URL`. The dev stack runs on another machine, so forward 3000 (API), 3002 (metadata) and
3003 (storage gateway) from the Mac to it: the API hands out `127.0.0.1:3003` as the gateway, the simulator's own
loopback. Simulator builds carry `Parrot-Simulator.entitlements` (`keychain-access-groups`); without it every keychain
call fails with `-34018`.

## Tests

- `ParrotTests` (unit): the pure Swift of `packages/mobile-audio-playback/ios/AudioPlayback/Core` with the tests in
  `packages/mobile-audio-playback/ios/Tests`.
- `ParrotUITests` (XCUITest, `ios/ParrotUITests`): sign-in, a new account's key and empty library, playing a seeded
  song in the foreground and in the background, the language switch, and keeping an album. The app runs silent
  (`SF_SILENT=1`: the player keeps running at output volume 0, REL-ENV-36). Every step is logged as
  `[parrot.uitest] +<ms> ...` and a failed wait dumps the screen and attaches a screenshot.

The accounts come from the environment, never the repo:

```
# on the machine running the dev stack
bun apps/parrot/mobile/ios/scripts/uitest-account.ts --mailpit-url http://127.0.0.1:<mailpit port> --out /tmp/parrot-uitest.env
# copy the file to the Mac, then from apps/parrot/mobile/ios with Metro up
scripts/run-uitests.sh /tmp/parrot-uitest.env            # every test; or name some
```

`run-uitests.sh` builds once, runs `ParrotTests`, then each UI test on a fresh install (uninstall, simulator keychain
reset). It uses a booted simulator if there is one; one it boots is shut down again at the end.

## Device and TestFlight

Device builds sign from a logged-in GUI session on the Mac. Release builds embed the JS bundle.
TestFlight uploads run on the Mac with fastlane, never from CI
(PLAT-MOBILE-07).
