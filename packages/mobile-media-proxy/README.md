# @space/mobile-media-proxy

The native loopback decrypt proxy (Android, Kotlin, no libmpv): `PlaybackHttpServer` on 127.0.0.1, `StorageTunnelClient`, `MediaCrypto` (SFV1), the offline store.

- Badger's mpv player: `PlaybackBridge.startProxy({ metadataJson, libraryKeyBase64, config })` returns an HLS master URL; objects are served decrypted at `/playback/object/{key}`.
- Parrot's ExoPlayer: `MediaProxy.start({ libraryKeyBase64, config })`, then `MediaProxy.registerChunkedFile({ id, mime, sizeBytes, chunks })` returns `/playback/chunked/{id}`, a plain file that answers `Range:` requests by fetching and decrypting only the 1 MiB chunks the range covers (PAR-FMT-01).

The player-specific knobs (decoder operating rate, mpv cache on a buffer cap) reach the proxy through `MediaProxyHooks`, installed by the player package.

## iOS: the `MediaProxy` pod

`MediaProxy.podspec` (iOS and tvOS 15.1, module `MediaProxy`, `react-native.config.js` `ios: {}`) ships the Swift port of the same proxy under the same `NativeModules.PlaybackBridge` name, so the JS above runs unchanged on iPhone and Apple TV.

- `ios/Proxy/` (iOS + tvOS): `PlaybackHttpServer` (Network.framework, 127.0.0.1), `StorageTunnelClient`, `MediaCrypto`, HLS templates, `CastServer`, `OfflineChunkFetcher`, `ChunkedFile` (the range-over-chunks math, ported from the JVM-tested `ChunkedFile.kt`). `PlaybackBridge` holds the server process-wide, so a JS reload reuses it as the Android proxy does. Chunked files: `start`, `registerChunkedFile` / `swapChunkedFile` (reject `proxy_not_started` before `start`), `unregisterChunkedFile`; `/playback/chunked/{id}` answers `Range:` (206, 416 with `Content-Range: bytes */size`, 404 unknown id, HEAD) and prefetches the next chunk. Events: `SpacePlaybackTraffic`, `SpacePlaybackDownload`. Logs: `os_log` subsystem `com.spacefleet.mpvplayback` (historical name, kept so `log stream` filters stay valid), greppable `chunked.request` / `chunked.served` / `startProxy.*` lines.
- `MediaProxyHooks.onBufferCap`: set by `@space/mobile-mpv-playback` (`MpvProxyHooks`) to lower mpv's cache on a buffer cap; the pod never links libmpv.
- `ios/Downloads/` (iOS only): `DownloadsBridge`, `DownloadEngine`, `OfflineStore`. Apps forward `application(_:handleEventsForBackgroundURLSession:completionHandler:)` to `DownloadEngine.shared.handleBackgroundEvents(identifier:completion:)` (`import MediaProxy`). The background session is `<bundle id>.downloads`. Notification strings live in the pod's `MediaProxyDownloads.bundle` (`ios/Downloads/Resources/<lang>.lproj/Localizable.strings`); apps do not copy them.

Tests: `bunx vitest run` (JS bridge, gateway candidates); `./gradlew :space_mobile-media-proxy:testDebugUnitTest` from an app's `android/` (crypto, range-over-chunks math).
