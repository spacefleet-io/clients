import CryptoKit
import Foundation
import React

/// React Native module that owns the native playback proxy (iOS twin of the Kotlin `PlaybackBridge`).
/// - `startProxy` (Badger video) parses metadata.json, builds the HLS session on the running (or a fresh) loopback
///   `PlaybackHttpServer` and resolves with the master.m3u8 URL. JS is then out of the segment hot path.
/// - `start` (Parrot audio) only makes sure the server runs and resolves with its base URL; JS then registers each track
///   file with `registerChunkedFile` (served at `/playback/chunked/{id}`, PAR-FMT-01), `swapChunkedFile` and
///   `unregisterChunkedFile`.
@objc(PlaybackBridge)
final class PlaybackBridge: RCTEventEmitter {
  /// Device event JS (`PlaybackBridge.onTraffic`) listens to: the gateway's traffic answers, see `StorageTunnelClient`.
  private static let trafficEvent = "SpacePlaybackTraffic"
  /// Device event JS (`MediaProxy.onDownload`) listens to: `{ bytes, ms }` of each object the player's fetches downloaded.
  private static let downloadEvent = "SpacePlaybackDownload"

  /// The live module's emitter. The proxy outlives a JS reload (it is reused for the same backend), so its tunnel client
  /// emits through whichever module is current rather than the one that built it.
  private static let ownerLock = NSLock()
  private static weak var trafficOwnerRef: PlaybackBridge?
  private static var trafficOwner: PlaybackBridge? {
    get { ownerLock.lock(); defer { ownerLock.unlock() }; return trafficOwnerRef }
    set { ownerLock.lock(); trafficOwnerRef = newValue; ownerLock.unlock() }
  }

  /// The server and its state are process-wide, touched only on `queue`: a JS reload builds a new module, which finds
  /// and reuses the running server (same backend + keys) instead of leaving the old one bound to its port.
  private static let queue = DispatchQueue(label: "PlaybackBridge.work")
  private static var server: PlaybackHttpServer?
  private static var serverFingerprint: String?
  /// Last high-traffic playback buffer JS set (`setBufferCap`); a rebuilt server starts with it.
  private static var bufferCapSeconds = TrafficBuffer.noCap

  /// Observation disabled: JS listens through `DeviceEventEmitter`, so events are always forwarded.
  override init() {
    super.init(disabledObservation: ())
    Self.trafficOwner = self
  }

  override func invalidate() {
    // A JS reload creates the next module before or after this one is torn down: only clear our own hook.
    Self.ownerLock.lock()
    if Self.trafficOwnerRef === self { Self.trafficOwnerRef = nil }
    Self.ownerLock.unlock()
    super.invalidate()
  }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { [Self.trafficEvent, Self.downloadEvent] }

  @objc(startProxy:libraryKeyBase64:config:resolve:reject:)
  func startProxy(
    _ metadataJson: String, libraryKeyBase64: String, config: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      do {
        guard let s = try Self.ensureServer(libraryKeyBase64, config, reject: reject) else { return }
        let session = try Self.parseSession(metadataJson)
        let url = s.createSession(session)
        PlaybackLog.info("startProxy.session url=\(url) videos=\(session.videos.count) audio=\(session.audio.count) subs=\(session.subtitles.count)")
        resolve(url)
      } catch {
        PlaybackLog.error("startProxy.error \(error.localizedDescription)")
        reject("playback_bridge_error", error.localizedDescription, error)
      }
    }
  }

  /// Starts (or reuses) the proxy for this backend and keys without a session and resolves with its base URL
  /// (`http://127.0.0.1:<port>`): Parrot then registers chunked files on it.
  @objc(start:config:resolve:reject:)
  func start(
    _ libraryKeyBase64: String, config: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      do {
        guard let s = try Self.ensureServer(libraryKeyBase64, config, reject: reject) else { return }
        PlaybackLog.info("start.ready base=\(s.baseUrl)")
        resolve(s.baseUrl)
      } catch {
        PlaybackLog.error("start.error \(error.localizedDescription)")
        reject("playback_bridge_error", error.localizedDescription, error)
      }
    }
  }

  /// Serves the `ChunkedFile` described by `fileJson` (see `ChunkedFile.fromJson`) and resolves with its URL.
  @objc(registerChunkedFile:resolve:reject:)
  func registerChunkedFile(
    _ fileJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      guard let s = Self.server else {
        PlaybackLog.warn("chunked.register.rejected reason=proxy_not_started")
        reject("proxy_not_started", "proxy_not_started", nil)
        return
      }
      do {
        let file = try ChunkedFile.fromJson(fileJson)
        let url = s.registerChunkedFile(file)
        PlaybackLog.info("chunked.registered id=\(file.id) mime=\(file.mime) size=\(file.sizeBytes) chunks=\(file.chunks.count) url=\(url)")
        resolve(url)
      } catch {
        PlaybackLog.error("chunked.register.error \(error.localizedDescription)")
        reject("playback_bridge_error", error.localizedDescription, error)
      }
    }
  }

  /// Serves another copy of an already registered file at the same id, unless the player already asked for it
  /// (PAR-PLAY-04). Resolves true when swapped.
  @objc(swapChunkedFile:resolve:reject:)
  func swapChunkedFile(
    _ fileJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      guard let s = Self.server else {
        PlaybackLog.warn("chunked.swap.rejected reason=proxy_not_started")
        reject("proxy_not_started", "proxy_not_started", nil)
        return
      }
      do {
        let file = try ChunkedFile.fromJson(fileJson)
        let swapped = s.swapChunkedFile(file)
        PlaybackLog.info("chunked.swap id=\(file.id) mime=\(file.mime) size=\(file.sizeBytes) swapped=\(swapped)")
        resolve(swapped)
      } catch {
        PlaybackLog.error("chunked.swap.error \(error.localizedDescription)")
        reject("playback_bridge_error", error.localizedDescription, error)
      }
    }
  }

  /// Stops serving `id`; resolves false when it was not registered (or no proxy runs).
  @objc(unregisterChunkedFile:resolve:reject:)
  func unregisterChunkedFile(
    _ id: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      let removed = Self.server?.unregisterChunkedFile(id) ?? false
      PlaybackLog.debug("chunked.unregistered id=\(id) removed=\(removed)")
      resolve(removed)
    }
  }

  /// The running server for this backend and keys, rebuilt when either changed; nil once `reject` was called.
  /// Runs on `queue`.
  private static func ensureServer(
    _ libraryKeyBase64: String, _ config: NSDictionary, reject: RCTPromiseRejectBlock
  ) throws -> PlaybackHttpServer? {
    let kind = configKind(config)
    // STOR-BW-11: a streaming session must name its profile; refuse here rather than open a session without one.
    if kind == "storage-tunnel", ((config["profileId"] as? String) ?? "").isEmpty {
      PlaybackLog.error("startProxy.profile_required kind=storage-tunnel")
      reject("playback_profile_required", "profile_required", nil)
      return nil
    }
    guard let libraryKey = Data(base64Encoded: libraryKeyBase64) else {
      PlaybackLog.error("startProxy.key_invalid reason=base64")
      reject("playback_bridge_error", "library_key_base64_invalid", nil)
      return nil
    }
    guard libraryKey.count == 32 else {
      PlaybackLog.error("startProxy.key_invalid size=\(libraryKey.count)")
      reject("playback_bridge_error", "library_key_size_invalid: \(libraryKey.count)", nil)
      return nil
    }
    // Reuse the running server only for the SAME backend + keys (React remount, JS reload); otherwise rebuild.
    let fingerprint = "\(libraryKeyBase64)|\(canonical(config))"
    if let existing = server, fingerprint == serverFingerprint {
      PlaybackLog.info("startProxy.reuse base=\(existing.baseUrl)")
      return existing
    }
    if let existing = server {
      PlaybackLog.info("startProxy.rebuild kind=\(kind) reason=config_changed")
      existing.stop()
      server = nil
      serverFingerprint = nil
    }
    let masterKey = try MediaCrypto.deriveMasterKey(libraryKey: libraryKey)
    // The server is built after its fetcher: the tunnel's traffic reports reach it through this box.
    weak var built: PlaybackHttpServer?
    let fetcher = try buildChunkFetcher(
      config, masterKey: masterKey,
      onTraffic: { event in
        // STOR-BW-01: a silo at high traffic loads no next-song opening (PAR-PLAY-07); old gateways send no state.
        switch (event["traffic"] as? [String: Any])?["state"] as? String {
        case "high": built?.setTrafficHigh(true)
        case "normal": built?.setTrafficHigh(false)
        default: break
        }
        trafficOwner?.sendEvent(withName: trafficEvent, body: event)
      },
      onDownloaded: { bytes, ms in trafficOwner?.sendEvent(withName: downloadEvent, body: ["bytes": bytes, "ms": ms]) })
    let s = PlaybackHttpServer(fetcher: fetcher)
    built = s
    try s.start()
    s.setBufferCap(bufferCapSeconds)
    server = s
    serverFingerprint = fingerprint
    PlaybackLog.info("startProxy.fresh kind=\(kind) base=\(s.baseUrl)")
    return s
  }

  private static func configKind(_ config: NSDictionary) -> String { (config["clientKind"] as? String) ?? "storage-tunnel" }

  /// High-traffic playback buffer (STOR-BW-01), called by JS with the silo's `playbackBufferSeconds` while it is high and 0
  /// when traffic is normal again: the proxy's look-ahead shrinks to it, and the player's own buffer through
  /// `MediaProxyHooks.onBufferCap` (mpv's `cache-secs` / `demuxer-readahead-secs` when the mpv pod is linked).
  @objc(setBufferCap:resolve:reject:)
  func setBufferCap(_ seconds: Double, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Self.queue.async {
      Self.bufferCapSeconds = seconds
      Self.server?.setBufferCap(seconds)
      let hook = MediaProxyHooks.onBufferCap
      hook?(seconds)
      PlaybackLog.info(
        "bufferCap seconds=\(seconds) cacheSecs=\(TrafficBuffer.cacheSecs(seconds)) readaheadSecs=\(TrafficBuffer.readaheadSecs(seconds)) playerHook=\(hook != nil)")
      resolve(true)
    }
  }

  /// The registered ids of the song playing and the songs Next and Previous go to (PAR-PLAY-07): the proxy loads their
  /// openings while the player reads nothing. Resolves false when no proxy runs.
  @objc(setNeighbours:next:previous:resolve:reject:)
  func setNeighbours(
    _ current: String?, next: String?, previous: String?, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.queue.async {
      guard let s = Self.server else {
        resolve(false)
        return
      }
      s.setNeighbours(current: current, next: next, previous: previous)
      resolve(true)
    }
  }

  @objc(stopProxy:reject:)
  func stopProxy(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Self.queue.async {
      PlaybackLog.info("stopProxy running=\(Self.server != nil)")
      Self.server?.stop()
      Self.server = nil
      Self.serverFingerprint = nil
      resolve(true)
    }
  }

  // MARK: config

  static func canonical(_ config: NSDictionary) -> String {
    guard JSONSerialization.isValidJSONObject(config),
      let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys])
    else { return String(describing: config) }
    return String(decoding: data, as: UTF8.self)
  }

  static func buildChunkFetcher(
    _ config: NSDictionary, masterKey: SymmetricKey, spoolDir: String = "playback-spool", onTraffic: TrafficSink? = nil,
    onDownloaded: ((Int, Int) -> Void)? = nil
  ) throws -> ChunkFetcher {
    let kind = (config["clientKind"] as? String) ?? "storage-tunnel"
    // One spool per proxy, shared by the tunnel and the offline store: large objects (subtitle sidecars) are
    // decrypted to disk there instead of into memory.
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let spool = PlaintextSpool(dir: caches.appendingPathComponent(spoolDir, isDirectory: true))
    switch kind {
    case "storage-tunnel":
      let candidates: [String]
      if let arr = config["gatewayBaseUrls"] {
        guard let list = arr as? [Any] else { throw TunnelError(message: "playback_config_invalid: gatewayBaseUrls") }
        candidates = list.compactMap { $0 as? String }
          .map { $0.trimmingCharacters(in: .whitespaces) }
          .filter { !$0.isEmpty }
          .map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 }
      } else {
        guard let single = config["gatewayBaseUrl"] as? String else {
          throw TunnelError(message: "playback_config_missing: gatewayBaseUrl(s)")
        }
        candidates = [single.hasSuffix("/") ? String(single.dropLast()) : single]
      }
      if candidates.isEmpty { throw TunnelError(message: "playback_config_invalid: empty gateway candidate list") }
      guard let authToken = config["authToken"] as? String else { throw TunnelError(message: "playback_config_missing: authToken") }
      // STOR-BW-11: a streaming session must name its profile; refuse here rather than open a session without one.
      guard let profileId = config["profileId"] as? String, !profileId.isEmpty else {
        PlaybackLog.error("startProxy.profile_required kind=storage-tunnel")
        throw TunnelError(message: "profile_required")
      }
      PlaybackLog.info("startProxy.profile profileId=\(profileId)")
      let tunnel = StorageTunnelClient(
        gatewayCandidates: candidates, authToken: authToken, appId: (config["appId"] as? String) ?? "badger",
        profileId: profileId,
        masterKey: masterKey, spool: spool, clientType: (config["clientType"] as? String) ?? "client-mobile-playback",
        clientVersion: (config["clientVersion"] as? String) ?? "spacebadger-mobile", onTraffic: onTraffic,
        onDownloaded: onDownloaded)
      // Downloaded objects are served from disk first; everything else (not downloaded, or a partially
      // downloaded title) goes through the tunnel.
      return OfflineChunkFetcher(masterKey: masterKey, spool: spool, fallback: tunnel)
    case "offline":
      // Offline playback (downloaded media): chunks come from the encrypted on-disk store, no network involved.
      return OfflineChunkFetcher(masterKey: masterKey, spool: spool)
    default:
      throw TunnelError(message: "playback_config_unknown_kind: \(kind)")
    }
  }

  // MARK: metadata.json -> HlsSession

  private static func double(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
  private static func int(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }
  private static func str(_ v: Any?) -> String? { v is NSNull ? nil : v as? String }

  static func parseSession(_ metadataJson: String) throws -> HlsSession {
    guard let root = try JSONSerialization.jsonObject(with: Data(metadataJson.utf8)) as? [String: Any] else {
      throw TunnelError(message: "playback_metadata_invalid")
    }
    var videosArr: [[String: Any]]
    if let v = root["videos"] as? [[String: Any]] {
      videosArr = v
    } else if let legacy = root["video"] as? [String: Any] {
      PlaybackLog.warn("parseSession.legacy_single_video")
      videosArr = [legacy]
    } else {
      throw TunnelError(message: "playback_metadata_missing_videos")
    }

    var videos: [HlsVideoVariant] = []
    for (i, vo) in videosArr.enumerated() {
      let track = parseTrack(
        initKey: (vo["initKey"] as? String) ?? "", codecString: str(vo["codecString"]),
        durationSeconds: double(vo["durationSeconds"]) ?? 0, chunks: (vo["chunks"] as? [[String: Any]]) ?? [])
      videos.append(
        HlsVideoVariant(
          id: (vo["id"] as? String) ?? "video-\(i)", quality: (vo["quality"] as? String) ?? "",
          bitrateKbps: int(vo["bitrateKbps"]), width: int(vo["width"]), height: int(vo["height"]), track: track))
    }

    var audio: [HlsAudioVariant] = []
    for (i, ao) in ((root["audioTracks"] as? [[String: Any]]) ?? []).enumerated() {
      let track = parseTrack(
        initKey: (ao["initKey"] as? String) ?? "", codecString: str(ao["codecString"]),
        durationSeconds: double(ao["durationSeconds"]) ?? 0, chunks: (ao["chunks"] as? [[String: Any]]) ?? [])
      let lang = (ao["language"] as? String) ?? "und"
      audio.append(
        HlsAudioVariant(
          id: (ao["id"] as? String) ?? "audio-\(i)", language: lang, label: (ao["label"] as? String) ?? lang,
          isDefault: (ao["isDefault"] as? Bool) ?? false, track: track))
    }

    let canonicalDuration = videos.first?.track.segments.reduce(0.0) { $0 + $1.durationSeconds } ?? 0
    var subtitles: [HlsSubtitleVariant] = []
    for (i, so) in ((root["subtitleTracks"] as? [[String: Any]]) ?? []).enumerated() {
      let format = (so["format"] as? String) ?? ""
      guard format == "vtt" || format == "pgs" || format == "vobsub" else {
        PlaybackLog.warn("parseSession.skip_unknown_subtitle_format format=\(format)")
        continue
      }
      let lang = (so["language"] as? String) ?? "und"
      subtitles.append(
        HlsSubtitleVariant(
          id: (so["id"] as? String) ?? "subs-\(i)", language: lang, label: (so["label"] as? String) ?? lang,
          isDefault: (so["isDefault"] as? Bool) ?? (i == 0), format: format, objectKey: (so["url"] as? String) ?? "",
          durationSeconds: canonicalDuration))
    }

    guard let first = videos.first, !first.track.initKey.isEmpty, !first.track.segments.isEmpty else {
      throw TunnelError(message: "playback_hls_missing_tracks")
    }
    return HlsSession(id: UUID().uuidString, mode: "vod", videos: videos, audio: audio, subtitles: subtitles)
  }

  private static func parseTrack(initKey: String, codecString: String?, durationSeconds: Double, chunks: [[String: Any]]) -> HlsTrack {
    let n = chunks.count
    let fallback = n > 0 && durationSeconds > 0 ? durationSeconds / Double(n) : 0
    var segments: [HlsSegment] = []
    for (i, c) in chunks.enumerated() {
      let start = double(c["startSeconds"])
      let explicit = double(c["durationSeconds"])
      let nextStart = i + 1 < n ? double(chunks[i + 1]["startSeconds"]) : nil
      let duration: Double
      if let explicit {
        duration = max(0.001, explicit)
      } else if let start, let nextStart {
        duration = max(0.001, nextStart - start)
      } else if let start, durationSeconds > 0 {
        duration = max(0.001, durationSeconds - start)
      } else {
        duration = max(0.001, fallback)
      }
      segments.append(HlsSegment(key: (c["key"] as? String) ?? "", durationSeconds: duration, startSeconds: start))
    }
    return HlsTrack(initKey: initKey, codecString: codecString, segments: segments)
  }
}
