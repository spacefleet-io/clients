# @space/mobile-mpv-playback

Shared React Native player for SpaceBadger mobile clients (Android-only today; iOS deferred).

Packages a libmpv-driven HLS player. Its source is the loopback decrypt proxy (native HTTP server, AES-256-GCM/HKDF crypto, native HLS playlist generation, storage-tunnel client), which lives in `@space/mobile-media-proxy` (Kotlin on Android, re-exported here; Swift in the `MediaProxy` pod on iOS, which `MpvPlayback.podspec` depends on). The mpv pod keeps the player (`ios/Player/`, `MpvProxyHooks.swift` installs the buffer-cap hook into `MediaProxyHooks`) and AirPlay (`ios/Playback/AirPlay*`). JS consumers see one bridge call (`PlaybackBridge.startProxy`) and a `<MpvPlayer />` view component; the playback hot path runs entirely in native code.

Consumers:
- `apps/badger/mobile`

## Bridge surface (planned)

```ts
import {
  PlaybackBridge,
  MpvPlayer,
  MpvControl,
  PlayerControls,
} from "@space/mobile-mpv-playback";

const url = await PlaybackBridge.startProxy({
  metadataJson: "<JSON>",
  libraryKeyBase64: "<base64-32-bytes>",
  gatewayBaseUrl: "https://gateway.example.com",
  authToken: "<bearer>",
  appId: "badger",
});

return <MpvPlayer source={url} />;
```

## Android-only

The package's `react-native.config.js` declares Android only. iOS is a future milestone (Swift HTTP server + URLSession + CryptoKit, same wire format). Do not consume from an iOS-only build.

## libmpv

The native libraries are our own LGPL, playback-only build from `packages/media-deps` (targets `android-arm64`, `android-arm`, `android-x64`, `android-ia32`, one per Android ABI; REL-DEPS-11, PLAT-TV-05): libmpv, the ffmpeg libraries, `libplayer.so` (the JNI bridge, built from `packages/media-deps/recipes/_android/jni`, vendored from mpv-android, MIT) and the NDK's `libc++_shared.so`. Gradle packages them from `<repo>/vendor/deps/android-<arch>/lib/<abi>/` and fails when the bundle of an ABI the app builds (`reactNativeArchitectures`, all four by default) is missing; fetch the published bundles first:

```bash
bun scripts/fetch-deps.ts --target android-arm64   # 64-bit ARM phones / TVs
bun scripts/fetch-deps.ts --target android-arm     # 32-bit ARM (many Android TV boxes)
bun scripts/fetch-deps.ts --target android-x64     # emulator / x86_64 devices
bun scripts/fetch-deps.ts --target android-ia32    # 32-bit x86 devices
```

A build for one ABI only (`-PreactNativeArchitectures=x86_64` for the emulator) needs only that bundle.

The Kotlin half, `is.xyz.mpv.MPVLib`, is source in `android/src/main/java/is/xyz/mpv/` (mpv-android, MIT, `LICENSE.mpv-android`).

## Casting (UX-TV-03)

The phone can hand a title to a Google Cast device (Android and iPhone, `react-native-google-cast`, default media receiver) or, on iPhone, to AirPlay. mpv is not involved: the phone does not play.

- `NativeModules.CastServer` (`CastServer.ts`; Kotlin `CastServerModule.kt`, Swift `CastServer.swift`) starts a second instance of the playback proxy bound to the Wi-Fi address (not loopback) behind `/cast/<token>/`. The token is 192-bit, issued per cast in JS (`src/lib/cast/castToken.ts` in the app), compared in constant time and dead once `stop` is called. Same decrypt + HLS templates as the loopback proxy, so the stored fMP4 is served as HLS (repackaged, not re-encoded). Rejects `cast_no_wifi` when there is no Wi-Fi address. On Android the module itself (`CastServerModule.kt`, `LanAllowList.kt`, `PlaybackSetup.kt`) lives in `@space/mobile-media-proxy` next to the loopback proxy and is registered by its `MediaProxyPackage`; `CastServer.ts` stays here.
- The cast server answers `/playback/object/<key>` only for the objects of the session it was started with (init and media segments of each listed video and audio version, the subtitle objects, and texts pushed with `putText`) and 404s anything else: behind the token it still holds the user's tunnel credentials and the library key. Kotlin `LanAllowList.kt` (JVM-tested in `LanAllowListTest.kt`), Swift `HlsSession.objectKeys`.
- It has its own spool (`cast-spool`; the player's `playback-spool` is wiped whenever a spool is created or cleared) and its own traffic sink: the gateway's traffic answers reach JS as the `SpaceCastTraffic` device event (`CastServer.onTraffic`), the cast screen ends the cast on a refusal or a stop (STOR-BW-07, STOR-BW-08), and the tunnel only re-sends `session.start`, which also renews the gateway session, while a sink is set. A tunnel client forgets a session the gateway answered `invalid_session` for, so the next fetch opens a new one.
- Subtitles: the app converts the chosen text subtitle to WebVTT (`strictWebVtt` in `@space/shared/subtitleVtt`, the converter the web player uses too) and pushes it with `putText`; the server serves it in place of the stored file, and the Google Cast load carries it as a text track (`mediaTracks`, `activeTrackIds`). react-native-google-cast drops `activeTrackIds` from the load on Android, so `loadGoogleMedia` (`googleSession.ts`) also switches the track on with `setActiveTrackIds` once the load is done. Image subtitles (PGS, VobSub), picked or the file's default, refuse the cast.
- Sound: the phone has no transcoder of its own. `audioVerdict` (`castProfiles.ts`) hands the device only stored audio tracks in a codec it lists (`omittedAudio` for the rest) and the cast is refused (`no-playable-audio`) if none is left. Today every stored track is AAC, which both targets play: the source copy is video only and `encodeDashAudio` encodes every non-AAC track (DTS and TrueHD included) to AAC (`packages/ingest-core/src/mediaProcessor.ts:720-722,921-922`), so the conversion UX-TV-03 describes happens at ingest. Keeping the original Dolby / DTS tracks stored as well, which MPV-TV-03 needs for the TV app, is issue #755; casting then still picks the AAC version or another listed track, and the originals stay stored for the TV app.
- Which video a device plays is decided in TypeScript (`castProfiles.ts`, `castPlan.ts`, unit-tested); unknown Cast models get the oldest profile (H.264 up to 4.1, no HEVC, 1080p).
- `AirPlayPlayer` (iPhone): AVPlayer only hands the HLS URL to an already-active AirPlay route (`airplay_no_route` otherwise), stays muted, has no layer, and fails the cast with `airplay_route_lost` / `airplay_not_external` instead of ever playing on the phone (MPV-MODEL-02). `AirPlayRoutePickerView` wraps `AVRoutePickerView`. The Swift compiles (Mac: `pod install` brings in the Google Cast SDK pods and the `AVKit` framework; signed Debug and Release builds of the app on 2026-10-22); no cast has been run from an iPhone yet.

## Licence

GPL-3.0-only (`LICENSE`) with the App Store additional permission of GPL-3.0 section 7 (`LICENSE-EXCEPTION.md`), which covers only code held by the SpaceBadger authors (REL-LIC-01). Third-party components keep their own licences: the Kotlin `is.xyz.mpv` sources stay MIT (`android/src/main/java/is/xyz/mpv/LICENSE.mpv-android`) and the libmpv build is LGPL-only.
