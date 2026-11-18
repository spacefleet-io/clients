# Mobile iOS

Status (ticket #304): the app builds, runs, signs in and plays video on a physical iPhone (Release build, LAN dev server) through embedded libmpv (see Playback): `storage-tunnel` playback through the local HLS proxy into libmpv, resume, seeking, audio-track switching, PGS subtitles, quality switching to 2160p HEVC 10-bit (VideoToolbox) and background/foreground are verified on an iPhone 11 (iOS 27.0.1, 2026-10-18). With the earlier AVPlayer player, sign-in with an existing library key, an episode download and airplane-mode playback of that downloaded episode (disk-first `OfflineChunkFetcher`, see Downloads) were verified; offline playback on libmpv is not re-run yet. The media-deps target is `ios-arm64` (device) only, so simulator builds have no libmpv slice. Device builds need a one-time keychain approval (below).

## Build (simulator)

```
cd apps/badger/mobile/ios && LANG=en_US.UTF-8 pod install
cd .. && bun run start                      # Metro on :8081
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -workspace ios/SpaceBadgerMobile.xcworkspace -scheme SpaceBadgerMobile \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ios/build build
```

## Build (device, free personal team)

- Bundle id `com.spacebadger.mobile`, team `8766H6KW4V`, automatic signing. Use `-destination id=<hardware UDID>` (not `generic/platform=iOS`, Xcode needs a device to create a profile) and `-allowProvisioningUpdates`.
- `SpaceBadgerMobile.entitlements` (`aps-environment`) is intentionally not referenced by the project: a free team cannot sign Push Notifications. Paid teams pass `CODE_SIGN_ENTITLEMENTS=SpaceBadgerMobile/SpaceBadgerMobile.entitlements`.
- Release embeds the JS bundle (no Metro). The API host is stored in-app (gear on the login screen).
- Plain-HTTP hosts (a dev stack on another machine) are blocked by App Transport Security unless the build has `SB_ALLOW_CLEARTEXT=YES` (Debug default; pass it on a Release build that talks to a dev stack). This mirrors Android's `usesCleartextTraffic`.
- Signing from a headless SSH session needs the login keychain: the first `codesign` of the Apple Development key prompts for "Always Allow" (login password) in the GUI session.

## Firebase / push

`ios/SpaceBadgerMobile/GoogleService-Info.plist` is gitignored; when present it is copied into the bundle and `FirebaseApp.configure()` runs, otherwise push is disabled.

## Simulator setup (what the dev stack needs)

- The dev backend runs elsewhere (a Linux host). The API hands out a gateway URL of `127.0.0.1:3003`, which is the *simulator's* loopback, so forward 3000 (api), 3002 (metadata) and 3003 (storage gateway) from the Mac to the backend host (a small TCP proxy is enough) and set the API host in the app (gear on the login screen) to `http://127.0.0.1:3000`. This mirrors Android's `adb reverse`.
- Ad-hoc signed simulator builds carry `SpaceBadgerMobile-Simulator.entitlements` (`keychain-access-groups`, only applied for `sdk=iphonesimulator*`). Without it every keychain call fails with `-34018` and onboarding reports "Could not validate your key".

## Playback (embedded libmpv)

The iPhone plays through the same embedded mpv as Android (MPV-MODEL-02, MPV-MODEL-04): our LGPL `ios-arm64` media-deps build (`packages/media-deps`, REL-DEPS-11). `packages/mobile-mpv-playback/ios` implements the same JS contract as the Kotlin module and is autolinked through `MpvPlayback.podspec` (`react-native.config.js` `ios: {}`).

- Dependencies: `Libmpv`, `Libavcodec` (dav1d inside), `Libavformat`, `Libavfilter`, `Libavutil`, `Libswresample`, `Libswscale` and `MoltenVK` as dynamic `.xcframework`s, each holding the device slice (media-deps `ios-arm64`) and the Apple Silicon simulator slice (`ios-arm64-simulator`, REL-MOB-02), vendored into `packages/mobile-mpv-playback/ios/vendor/media-deps/ios` (gitignored) by `packages/mobile-mpv-playback/scripts/fetch-ios-deps.ts`: it fetches both bundles and joins their slices with `xcodebuild -create-xcframework`, so Xcode picks the slice per destination. The Podfile runs that script on every `pod install`; it downloads the content-addressed packages (`fetchDeps`, version `fl1-<recipe hash>`). `SB_MEDIA_DEPS_IOS_LOCAL=1` / `SB_MEDIA_DEPS_IOS_SIMULATOR_LOCAL=1 pod install` (or `--local [dir]` / `--local-simulator [dir]`) use a local build in `packages/media-deps/out/<target>` instead. CocoaPods embeds and signs the frameworks. The same pod builds for tvOS (MPV-TV-01): `fetch-ios-deps.ts --target tvos-arm64` joins the `tvos-arm64` and `tvos-arm64-simulator` bundles into `ios/vendor/media-deps/tvos`, and its tvOS build rejects `setMediaVolume` and the brightness calls and resolves `setImmersiveLandscape` without doing anything.
- `PlaybackBridge` (Swift): loopback HLS proxy on `NWListener` (127.0.0.1, ephemeral port). It has the same routes, metadata parsing, error codes and fingerprinted reuse as the Kotlin `PlaybackBridge`. The tunnel client (`URLSession`), SFV1 decrypt (CryptoKit), LRU cache, in-flight dedup and segment prefetcher are ports of the Android classes. Release builds rely on `NSAllowsLocalNetworking` so mpv can reach the proxy over cleartext loopback. The master playlist matches Android: WebVTT is advertised as `TYPE=SUBTITLES`, and PGS/VobSub are loaded sidecar with `sub-add` from `/playback/object/<key>`.
- `MpvEngine`: one mpv core per player view.
  - Video: `vo=gpu-next`, `gpu-api=vulkan`, `gpu-context=moltenvk`. `wid` is the view's `CAMetalLayer` pointer (our mpv fork's `moltenvk` context); mpv sizes its swapchain from the layer bounds × `contentsScale`.
  - Audio: `ao=audiounit` with an `AVAudioSession` `.playback` / `.moviePlayback` session.
  - Decode: `hwdec=videotoolbox,videotoolbox-copy,no`.
  - Cache, seek, network and track-selection options are copied from Android's `MpvSurfaceView.initOptions`.
  - mpv's log is forwarded to the unified log, subsystem `com.spacefleet.mpvplayback`, category `mpv`. The app's own lines are in category `playback`: `first_frame ms=`, `playback.restart cause=seek ms=`, `audio.reconfig cause=aid ms=`, `playback.gpu hwdec-current=… current-vo=…`, `mpv.end_file reason=`.
  - Threads follow Android's `MpvGuard`. JS calls take a read lock. Events drain on a serial queue from mpv's wakeup callback. `mpv_terminate_destroy` runs on that queue under the write lock.
- `MpvPlayerView`: a `CAMetalLayer`-backed view with `source`, `startOptions` (any mpv per-file options, as on Android) and `onSurfaceTap` (in pixels).
- `MpvControl`: all 29 JS methods. It uses the same mpv commands and properties as `MpvControlModule.kt` and rejects with `mpv_error` when no core is live or a call fails. mpv calls run on the module's own serial queue (a sync `sub-add` may fetch a whole PGS file). UIKit calls hop to main: `setKeepScreenOn`, screen brightness, and `setImmersiveLandscape` (`requestGeometryUpdate`). The media volume lives in `@space/mobile-media-volume` (`MediaVolume.swift`: hidden `MPVolumeView` slider, output-volume change events), shared with Parrot's phone app.
- `getDecoderCaps` (answered in JS, `MpvControl.ts`): the native `getDeviceDecoderReport` (`DecoderCaps.swift`) returns only raw facts (`sdk`, the `utsname` machine id, `simulator`, `VTIsHardwareDecodeSupported` per mime). `packages/mobile-mpv-playback/src/iosDecoderCaps.ts` (unit-tested) turns them into the Android `DecoderCaps` shape:
  - `hardware` is Apple's published limits for the model, keyed by machine id (`iPhone12,1` = iPhone 11), one row per SoC generation A9 to A20 with the source of each figure in the file header: HEVC 4K at 30 fps up to the iPhone 7 and 60 fps from the iPhone 8, 120 fps (HEVC) on the Pro models Apple publishes it for (iPhone 16 Pro to 18 Pro Max), H.264 4K at 30 fps on every model (Apple publishes no H.264 4K60 decode), AV1 4K at 30 fps from the iPhone 15 Pro (Apple publishes no AV1 frame rate). An iPhone newer than the table gets the newest generation; the simulator and any non-iPhone get the conservative (A9) row. `VTIsHardwareDecodeSupported` can only remove a codec from the table, never add one.
  - `software` is FFmpeg (`ffmpeg-h264`, `ffmpeg-hevc`, `ffmpeg-vp9`, `ffmpeg-libdav1d`). It has no size limit below 8K and `maxFps` is null, because CPU speed is not reported by any API.
- The home indicator auto-hides on the Player screen (`autoHideHomeIndicator` on the native-stack screen, `AppNavigator.tsx`); it reappears on touch. On-device check still pending.
- Background: there is no background-audio mode, so the engine pauses on `didEnterBackground` (no Metal work in the background). There is no Now Playing / lock-screen integration; the AVPlayer version had none either.
- Fonts: libass uses its CoreText font provider (`--enable-coretext`, no fontconfig), so ASS/SSA and WebVTT render with system fonts.

Verify the deps on a build: `SpaceBadgerMobile.app/Frameworks` must hold the eight frameworks above, signed by the app team (`codesign -dv`). `nm -m Libmpv | grep "dynamically looked up"` must be empty: flat-namespace lookups link fine and only fail in dyld at launch.

Device logs without root: start the app with `xcrun devicectl device process launch --console --terminate-existing --device <id> --environment-variables '{"OS_ACTIVITY_DT_MODE":"YES"}' com.spacebadger.mobile`, which mirrors the unified log to stdout. Then drive it with a test that only `activate()`s the app (`DeviceHarness` `ProbeTests.testMpvScenarios`).

The HTTP proxy must send the response head and body on one `NWConnection` context: a partial `.defaultMessage` blocks a later `.finalMessage` send and the player times out (fixed in `PlaybackHttpServer.respond`).

## Downloads

`DownloadsBridge` (`packages/mobile-media-proxy/ios/Downloads/DownloadsBridge.{swift,m}`, engine in `DownloadEngine.swift`, store in `OfflineStore.swift`, all in the iOS-only part of the `MediaProxy` pod shared with Parrot) mirrors the Android module: same 7 methods, same `SpaceDownloadsChanged` payload and error codes. AppDelegate imports `MediaProxy` to forward background-session events to `DownloadEngine.shared`.

- Transport: one `URLSessionUploadTask` per storage object in the background session `<bundle id>.downloads` (`com.spacebadger.mobile.downloads` for Badger; `POST /storage/tunnel/download` with a small JSON body file; background sessions drop `httpBody` on data tasks). The response is streamed to `<hash>.part`, verified (length + `x-storage-tunnel-sha256`) and atomically renamed.
- Tunnel session TTL is 10 min and only `session.start` frames extend it, so 15 keep-alive frames are scheduled as background tasks (`earliestBeginDate`, every 240 s). A 404 negotiates a new session.
- Store: `Application Support/offline/` (excluded from backup): `queue.json`, `items/<hash>.objects.json`, `objects/<sha256hex(objectKey)>` (still-encrypted SFV1 envelopes, same layout as Android), `bodies/`.
- On relaunch the engine reattaches surviving tasks (`getAllTasks`) and AppDelegate forwards `handleEventsForBackgroundURLSession`.
- Notifications: local completion/failure notifications (strings in `Localizable.strings` for de/en/es/fr/nl, shipped in the pod's `MediaProxyDownloads.bundle`, falling back to the main bundle; permission asked at first enqueue). There is no ongoing progress notification and no foreground service, unlike Android.
- Verified on the simulator (iPhone 17 Pro, dev stack over the Mac loopback forwarders): a 3181-object / 5 GB movie downloads with live progress; backgrounded, nsurlsessiond keeps transferring and the app catches up when it wakes or returns to the foreground (the simulator suspends the app ~30 s after backgrounding; on device wake-ups are throttled by the system too); after `simctl terminate` + relaunch `reattach` adopted 96 of 111 surviving tasks and the download completed; deleting removes every object and the `queue.json` entry.

- Offline playback: `PlaybackBridge` builds an `OfflineChunkFetcher` for both kinds, as Android does. `clientKind: "offline"` reads only from the store (a missing object is a 502); `storage-tunnel` reads downloaded objects from disk first and falls back to the tunnel. The proxy reads `Application Support/offline/objects/<sha256hex(objectKey)>` itself (`OfflineObjectReader`) because it also builds for tvOS, where `OfflineStore` is not compiled; the layout is the contract.

## Known gaps

- `LibrarySync` (AES-GCM snapshot crypto) is ported in Swift (`LibrarySync.swift`); upload-frame path untested at runtime.
